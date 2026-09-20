/**
 * CLI: harvest high-signal user turns from Claude Code transcripts into eng-kms.
 *
 *   npx tsx src/scripts/harvest-claude-transcripts.ts --projects -Users-ryaker-Dev-KMSmcp,... \
 *       [--cap 50] [--out harvest.jsonl] [--store --kms-url http://localhost:8181/mcp]
 *
 * Default is a dry run: extract → curate → write the JSONL for review. `--store` sends each
 * kept item through `unified_store` (dedup gate live); `dedup_required` is counted, never forced.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { MinimalMcpClient } from "./import-slack-huddles.js";
import {
  curate,
  contentTypeFor,
  extractFromFile,
  listTranscripts,
  toStoreArgs,
  type ExtractStats,
  type HarvestItem,
} from "../harvest/claudeTranscripts.js";

function arg(argv: string[], name: string, def?: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const root = arg(
    argv,
    "--root",
    path.join(os.homedir(), ".claude", "projects"),
  )!;
  const projects = (arg(argv, "--projects") ?? "").split(",").filter(Boolean);
  if (projects.length === 0) {
    console.error(
      "--projects <dir,dir> required (names under ~/.claude/projects)",
    );
    process.exit(2);
  }
  const cap = Number(arg(argv, "--cap", "50"));
  const out = arg(argv, "--out", "claude-labels-harvest.jsonl")!;
  const userId = arg(argv, "--user-id", "eng_kms")!;
  const store = argv.includes("--store");

  const stats: ExtractStats = {
    files: 0,
    lines: 0,
    userTurns: 0,
    candidates: 0,
    planDecisions: 0,
  };
  const all: HarvestItem[] = [];
  for (const f of listTranscripts(root, projects))
    all.push(...extractFromFile(f, root, stats));
  const cur = curate(all, { cap });
  fs.writeFileSync(out, cur.kept.map((i) => JSON.stringify(i) + "\n").join(""));
  console.log("extract:", stats);
  console.log(
    "curate: kept=%d lowScore=%d exactDup=%d nearDup=%d overCap=%d",
    cur.kept.length,
    cur.droppedLowScore,
    cur.droppedExactDup,
    cur.droppedNearDup,
    cur.droppedOverCap,
  );
  console.log("wrote", out);
  if (!store) return;

  const kmsUrl = arg(
    argv,
    "--kms-url",
    process.env.KMS_URL ?? "http://localhost:8181/mcp",
  )!;
  const kms = new MinimalMcpClient(
    kmsUrl,
    process.env.KMS_BEARER_TOKEN ?? null,
  );
  await kms.initialize();
  const counts = { pattern: 0, insight: 0, dedup_required: 0, failed: 0 };
  const stored: { id: string; kind: string; harvest_id: string }[] = [];
  for (const it of cur.kept) {
    try {
      const r: any = await kms.callTool(
        "unified_store",
        toStoreArgs(it, userId),
      );
      if (r?.status === "dedup_required") counts.dedup_required++;
      else if (r?.success && typeof r.id === "string") {
        counts[contentTypeFor(it.kind)]++;
        stored.push({ id: r.id, kind: it.kind, harvest_id: it.harvest_id });
      } else counts.failed++;
    } catch (e) {
      counts.failed++;
      console.warn("store failed:", e instanceof Error ? e.message : e);
    }
  }
  await kms.close();
  console.log("store:", counts);
  fs.writeFileSync(
    out.replace(/\.jsonl$/, "") + ".stored.json",
    JSON.stringify(stored, null, 2),
  );
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
