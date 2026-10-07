#!/usr/bin/env python3
"""Offline embedder comparison on KMS's own labelled recall pools. Reads ~/.kms/eval/label-pool.jsonl
(built by src/scripts/label-recall-pool.ts). Results and caveats: docs/eval/embedder-comparison-2026-10.md

  python3 scripts/eval/embedder-compare.py plan|embed|score
  N_JEV=583 EMBED_SLEEP=0.25 ...   # widen the Jev-labelled sample; throttle on a busy CI host
  CANDIDATE_MODEL=embeddinggemma-2:440m ...   # try another tag (variant names stay gemma2_*)

Stage `plan`  : build the sample, count unique texts (no network).
Stage `embed` : embed every needed text on rym1 (never on this Mac) into a disk cache; resumable.
Stage `score` : rank each query's candidate pool by cosine and compare against the grades.

The pool is the post-retrieval top-N of PRODUCTION (hybrid RRF + lexical + nomic vector), so this
measures RE-RANKING power inside nomic-biased pools, not first-stage recall. Said plainly in the report.
"""
import base64, hashlib, json, os, random, re, sys, time, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.expanduser(os.environ.get("KMS_EMBED_CACHE_DIR", "~/.kms/eval-cache"))
os.makedirs(CACHE_DIR, exist_ok=True)
CAND = os.environ.get("CANDIDATE_MODEL", "embeddinggemma-2:270m")
POOL = os.path.expanduser("~/.kms/eval/label-pool.jsonl")
BASE = os.environ.get("OLLAMA_BASE_URL", "http://100.127.128.76:11434")   # rym1; CLAUDE.md forbids inference on this Mac
CACHE = os.path.join(CACHE_DIR, "embedder-compare-vectors.jsonl")
N_JEV = int(os.environ.get("N_JEV", "60"))
BATCH = 16                                    # small batches: rym1 is a CI host with load ~16

# variant -> (model, query formatter, doc formatter, truncate dims)
V = {
    "nomic_raw":      ("nomic-embed-text",       lambda q: q,                                  lambda d: d, None),
    "nomic_prefixed": ("nomic-embed-text",       lambda q: "search_query: " + q,               lambda d: "search_document: " + d, None),
    "gemma2_raw":     (CAND,  lambda q: q,                                  lambda d: d, None),
    "gemma2_prefix":  (CAND,  lambda q: "task: search result | query: " + q, lambda d: "title: none | text: " + d, None),
    "gemma2_pre256":  (CAND,  lambda q: "task: search result | query: " + q, lambda d: "title: none | text: " + d, 256),
    "gemma2_raw256":  (CAND,  lambda q: q,                                  lambda d: d, 256),
}
EMBED_VARIANTS = ["nomic_raw", "nomic_prefixed", "gemma2_raw"]   # gemma2_prefix vectors for the first 89 queries stay cached; not re-embedded at scale   # pre256 is a free truncation of gemma2_prefix


def load_sample():
    rows = [json.loads(l) for l in open(POOL)]
    gem = [r for r in rows if r.get("label_source") in (None, "gemma") and r.get("candidates")]
    jev = [r for r in rows if r.get("label_source") == "jev" and r.get("topk") == 50]
    seen = {r["query"] for r in gem}
    jev = [r for r in jev if r["query"] not in seen]
    rng = random.Random(1)
    # one row per distinct query, seeded sample
    uniq = {}
    for r in jev:
        uniq.setdefault(r["query"], r)
    jev = rng.sample(sorted(uniq.values(), key=lambda r: r["query"]), min(N_JEV, len(uniq)))
    return [("gemma", r) for r in gem], [("jev", r) for r in jev]


def key(model, text):
    return hashlib.sha1((model + "\x00" + text).encode()).hexdigest()


def load_cache():
    c = {}
    if os.path.exists(CACHE):
        for l in open(CACHE):
            try:
                k, b = json.loads(l)
                c[k] = np.frombuffer(base64.b64decode(b), dtype=np.float32)
            except Exception:
                pass
    return c


def embed_batch(model, texts):
    req = urllib.request.Request(BASE + "/api/embed", json.dumps({"model": model, "input": texts}).encode(),
                                 {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=300))["embeddings"]


def needed(sets):
    need = {}      # (variant) -> set of formatted texts
    for name in EMBED_VARIANTS:
        model, fq, fd, _ = V[name]
        s = set()
        for _, r in sets:
            s.add(fq(r["query"]))
            for c in r["candidates"]:
                s.add(fd(c["content"]))
        need[name] = s
    return need


def plan():
    g, j = load_sample()
    sets = g + j
    need = needed(sets)
    ncand = sum(len(r["candidates"]) for _, r in sets)
    print(f"queries: {len(g)} gemma-labelled + {len(j)} jev-labelled = {len(sets)}; candidate rows: {ncand}")
    for k, s in need.items():
        print(f"  {k:<16} unique texts to embed: {len(s)}")
    print("total embeds:", sum(len(s) for s in need.values()))


def embed():
    g, j = load_sample()
    sets = g + j
    need = needed(sets)
    cache = load_cache()
    out = open(CACHE, "a")
    t_all = time.time()
    stats = {}
    for name in EMBED_VARIANTS:
        model = V[name][0]
        todo = [t for t in sorted(need[name]) if key(model + "|" + name, t) not in cache]
        t0 = time.time()
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            vecs = embed_batch(model, chunk)
            for t, v in zip(chunk, vecs):
                a = np.asarray(v, dtype=np.float32)
                cache[key(model + "|" + name, t)] = a
                out.write(json.dumps([key(model + "|" + name, t), base64.b64encode(a.tobytes()).decode()]) + "\n")
            out.flush()
            if (i // BATCH) % 20 == 0:
                print(f"  {name}: {i + len(chunk)}/{len(todo)}  {time.time() - t0:.0f}s", flush=True)
            time.sleep(float(os.environ.get("EMBED_SLEEP", "0.05")))
        dt = time.time() - t0
        stats[name] = (len(todo), dt)
        print(f"{name}: embedded {len(todo)} new in {dt:.0f}s ({1000 * dt / max(len(todo), 1):.0f} ms/text)", flush=True)
    print("done in %.0fs" % (time.time() - t_all))
    json.dump(stats, open(os.path.join(CACHE_DIR, "embedder-compare-stats.json"), "w"))


def unit(a):
    return a / (np.linalg.norm(a) + 1e-12)


def dcg(gains):
    return sum(g / np.log2(i + 2) for i, g in enumerate(gains))


def metrics(order_grades):
    """order_grades: grades of candidates in the ranked order."""
    gs = list(order_grades)
    ideal = sorted(gs, reverse=True)
    out = {}
    for k in (5, 10):
        d = dcg(gs[:k]); i = dcg(ideal[:k])
        out[f"ndcg@{k}"] = d / i if i > 0 else np.nan
    has2 = 2 in gs
    out["top1_g2"] = (1.0 if gs[0] == 2 else 0.0) if has2 else np.nan
    out["mrr_g2"] = (1.0 / (gs.index(2) + 1)) if has2 else np.nan
    out["p@5_rel"] = np.mean([g >= 1 for g in gs[:5]])
    return out


def boot_ci(x, n=3000, seed=7):
    x = np.asarray([v for v in x if not np.isnan(v)])
    if len(x) == 0:
        return (np.nan, np.nan, np.nan, 0)
    rng = np.random.default_rng(seed)
    m = rng.choice(x, (n, len(x))).mean(1)
    return (x.mean(), np.percentile(m, 2.5), np.percentile(m, 97.5), len(x))


def score():
    g, j = load_sample()
    cache = load_cache()
    res = {}      # setname -> variant -> metric -> list
    pairs = {"near": {}, "rand": {}}   # variant -> cosines for dedup-style pairs
    rng = random.Random(3)

    def vec(name, text, model):
        return cache.get(key(model + "|" + base_name(name), text))

    def base_name(n):
        return {"gemma2_pre256": "gemma2_prefix", "gemma2_raw256": "gemma2_raw"}.get(n, n)

    names = ["production", "random"] + list(V.keys())
    for setname, sets in (("gemma-labelled (independent)", g), ("jev-labelled sample", j)):
        res[setname] = {n: {m: [] for m in ("ndcg@5", "ndcg@10", "top1_g2", "mrr_g2", "p@5_rel")} for n in names}
        for _, r in sets:
            cands = r["candidates"]
            grades = [c["grade"] for c in cands]
            prod = [c["grade"] for c in sorted(cands, key=lambda c: c["prod_rank"])]
            for m, v in metrics(prod).items():
                res[setname]["production"][m].append(v)
            rs = []
            for _ in range(25):
                p = grades[:]; rng.shuffle(p); rs.append(metrics(p))
            for m in rs[0]:
                res[setname]["random"][m].append(np.nanmean([x[m] for x in rs]) if not all(np.isnan(x[m]) for x in rs) else np.nan)
            for name, (model, fq, fd, trunc) in V.items():
                if name in ("gemma2_prefix", "gemma2_pre256") and N_JEV > 60:
                    continue
                qv = vec(name, fq(r["query"]), model)
                if qv is None:
                    continue
                if trunc:
                    qv = qv[:trunc]
                qv = unit(qv)
                sims = []
                for c in cands:
                    dv = vec(name, fd(c["content"]), model)
                    if dv is None:
                        sims.append(-9); continue
                    dv = unit(dv[:trunc] if trunc else dv)
                    sims.append(float(qv @ dv))
                order = [cands[i]["grade"] for i in np.argsort(sims)[::-1]]
                for m, v in metrics(order).items():
                    res[setname][name][m].append(v)
            # dedup-style doc-doc pairs (same pool): near-duplicates by token Jaccard vs random pairs
            toks = [set(re.findall(r"\w+", c["content"].lower())) for c in cands]
            idx = list(range(len(cands)))
            for a in range(len(idx)):
                for b in range(a + 1, len(idx)):
                    ja = len(toks[a] & toks[b]) / max(len(toks[a] | toks[b]), 1)
                    kind = "near" if ja >= 0.7 else ("rand" if ja <= 0.15 and rng.random() < 0.05 else None)
                    if not kind:
                        continue
                    for name in ("nomic_raw", "gemma2_raw"):
                        model, _, fd, _ = V[name]
                        da = vec(name, fd(cands[a]["content"]), model); db = vec(name, fd(cands[b]["content"]), model)
                        if da is not None and db is not None:
                            pairs[kind].setdefault(name, []).append(float(unit(da) @ unit(db)))

    print("=" * 100)
    for setname, byv in res.items():
        nq = len(byv["production"]["ndcg@5"])
        print(f"\n## {setname}  ({nq} queries)   mean [95% bootstrap CI]")
        print(f"{'ranker':<16} {'nDCG@5':>22} {'nDCG@10':>22} {'top-1 is g2':>22} {'MRR(g2)':>22}")
        for n in names:
            row = []
            for m in ("ndcg@5", "ndcg@10", "top1_g2", "mrr_g2"):
                mu, lo, hi, k = boot_ci(byv[n][m])
                row.append(f"{mu:.3f} [{lo:.3f},{hi:.3f}]" if k else "n/a")
            print(f"{n:<16} " + " ".join(f"{x:>22}" for x in row))
        base = byv["nomic_raw"]
        print(f"\n   paired vs nomic_raw (production embedder), per-query diff in nDCG@5 / top-1:")
        for n in names:
            if n in ("production", "random", "nomic_raw") or not byv[n]["ndcg@5"]:
                continue
            for m in ("ndcg@5", "top1_g2"):
                d = np.array(byv[n][m]) - np.array(base[m]); d = d[~np.isnan(d)]
                if len(d) == 0:
                    continue
                mu, lo, hi, k = boot_ci(d)
                w, l = int((d > 0).sum()), int((d < 0).sum())
                print(f"   {n:<16} {m:<8} diff {mu:+.3f} [{lo:+.3f},{hi:+.3f}]  better on {w}, worse on {l}, tied {len(d) - w - l}")

    print("\n## dedup-style cosine scale (doc-doc pairs inside the same pools)")
    for name in ("nomic_raw", "gemma2_raw"):
        n, r = np.array(pairs["near"].get(name, [])), np.array(pairs["rand"].get(name, []))
        if len(n) == 0 or len(r) == 0:
            continue
        print(f"  {name:<14} near-dups (Jaccard>=0.7, n={len(n)}): p5={np.percentile(n, 5):.3f} median={np.median(n):.3f} | "
              f"unrelated (Jaccard<=0.15, n={len(r)}): median={np.median(r):.3f} p95={np.percentile(r, 95):.3f} p99={np.percentile(r, 99):.3f}")
    nn, nr = np.array(pairs["near"].get("nomic_raw", [])), np.array(pairs["rand"].get("nomic_raw", []))
    if len(nn) and len(nr):
        print("  threshold mapping: gemma cutoff giving the SAME false-positive rate on unrelated pairs as nomic's cutoffs")
        for tau in (0.78, 0.88):
            fpr = float((nr >= tau).mean()); tpr = float((nn >= tau).mean())
            line = f"    nomic tau={tau}: unrelated flagged {100 * fpr:.2f}%, near-dups caught {100 * tpr:.1f}%"
            for name in ("gemma2_raw",):
                gr, gn = np.array(pairs["rand"].get(name, [])), np.array(pairs["near"].get(name, []))
                if len(gr) and len(gn):
                    t = float(np.quantile(gr, 1 - fpr)) if fpr > 0 else float(gr.max() + 1e-6)
                    line += f" | {name}: tau={t:.3f} -> near-dups caught {100 * float((gn >= t).mean()):.1f}%"
            print(line)


if __name__ == "__main__":
    {"plan": plan, "embed": embed, "score": score}[sys.argv[1]]()
