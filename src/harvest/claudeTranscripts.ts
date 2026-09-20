/**
 * Claude Code transcript → "labels" harvest.
 *
 * Rich has no separate classifier; his labels are what he told Claude Code over ~2 years.
 * This module turns `~/.claude/projects/**\/*.jsonl` into a small set of high-signal
 * HarvestItems that can referee Jev shadow proposals (corrections, standing rules,
 * preferences, don't-touch, plan accept/reject).
 *
 * Pure and deterministic: no network, no LLM. Extraction, scoring, and local dedup live
 * here; storing lives in `src/scripts/harvest-claude-transcripts.ts`. Quality over
 * quantity — a turn must clear MIN_SCORE, be a bounded length, and not be a paste.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

export type HarvestKind =
  | "correction"
  | "standing_rule"
  | "preference"
  | "dont_touch"
  | "plan_accept"
  | "plan_reject";

export interface HarvestProvenance {
  /** Always 'claude-transcript'. */
  provenance: "claude-transcript";
  /** Project dir name under ~/.claude/projects, e.g. -Users-ryaker-Dev-KMSmcp. */
  project: string;
  session_id: string;
  /** Path relative to the projects root (no home-dir prefix). */
  file: string;
  /** 1-based line in the jsonl. */
  line: number;
  uuid: string | null;
  timestamp: string | null;
}

export interface HarvestItem {
  /** sha256(kind + normalized content) — stable across re-runs, project-independent. */
  harvest_id: string;
  kind: HarvestKind;
  /** The user's words (trimmed, bounded). For plan_* the plan title/first line + feedback. */
  content: string;
  /** Heuristic score 0..1; only items >= MIN_SCORE survive. */
  score: number;
  /** Names of the rules that fired. */
  signals: string[];
  provenance: HarvestProvenance;
}

export const MIN_SCORE = 0.6;
export const MAX_CONTENT_CHARS = 600;
const MIN_CONTENT_CHARS = 12;

interface Rule {
  kind: HarvestKind;
  name: string;
  re: RegExp;
  weight: number;
}

const RULES: Rule[] = [
  {
    kind: "standing_rule",
    name: "from_now_on",
    re: /\bfrom now on\b/i,
    weight: 0.9,
  },
  {
    kind: "standing_rule",
    name: "standing",
    re: /\bstanding (rule|directive|instruction|order)s?\b/i,
    weight: 0.9,
  },
  {
    kind: "standing_rule",
    name: "always_never",
    re: /\b(always|never)\b(?! mind)/i,
    weight: 0.55,
  },
  {
    kind: "standing_rule",
    name: "every_time",
    re: /\b(every time|each time|going forward)\b/i,
    weight: 0.7,
  },
  {
    kind: "dont_touch",
    name: "dont_touch",
    re: /\b(don'?t|do not|never) (touch|modify|change|edit|delete|remove|push|merge|commit)\b/i,
    weight: 0.8,
  },
  {
    kind: "dont_touch",
    name: "leave_alone",
    re: /\b(leave|keep) (it|that|this|those|them) (alone|as is)\b/i,
    weight: 0.75,
  },
  {
    kind: "dont_touch",
    name: "out_of_scope",
    re: /\b(out of scope|not in scope|stay in scope)\b/i,
    weight: 0.65,
  },
  {
    kind: "correction",
    name: "you_missed",
    re: /\byou (missed|forgot|skipped|ignored)\b/i,
    weight: 0.8,
  },
  {
    kind: "correction",
    name: "i_said",
    re: /\bI (said|told you|asked for|meant|already said)\b/i,
    weight: 0.85,
  },
  {
    kind: "correction",
    name: "no_i_meant",
    re: /\b(no,? I meant|that'?s (not|wrong)|that is (not|wrong)|this is wrong|you'?re wrong|not what I)\b/i,
    weight: 0.85,
  },
  {
    kind: "correction",
    name: "wrong",
    re: /\b(wrong|incorrect|not right|nope)\b/i,
    weight: 0.5,
  },
  {
    kind: "correction",
    name: "stop_doing",
    re: /^\s*(stop|wait|no)[,.! ]/i,
    weight: 0.55,
  },
  {
    kind: "correction",
    name: "why_did_you",
    re: /\bwhy (did|would) you\b/i,
    weight: 0.6,
  },
  {
    kind: "preference",
    name: "i_prefer",
    re: /\bI (prefer|like it when|want you to|expect)\b/i,
    weight: 0.75,
  },
  {
    kind: "preference",
    name: "rather",
    re: /\b(I'?d rather|instead of .{1,40}, (use|do))\b/i,
    weight: 0.65,
  },
  {
    kind: "preference",
    name: "should_not_ask",
    re: /\b(don'?t ask|no need to ask|just do it|just fix)\b/i,
    weight: 0.7,
  },
];

/** Kinds ordered by how much a hit should win when several fire on one turn. */
const KIND_PRIORITY: HarvestKind[] = [
  "standing_rule",
  "dont_touch",
  "correction",
  "preference",
];

/** Harness-injected or machine-generated user turns — never Rich's words. */
const NOISE_PREFIXES = [
  "<system-reminder",
  "<command-",
  "<local-command",
  "<task-notification",
  "<user-prompt-submit-hook",
  "<ide_",
  "<bash-",
  "[Request interrupted",
  "Caveat:",
  "<pasted_content",
  "<channel",
  "[Artifact comment",
  "Stop hook feedback",
  "This session is being continued",
  "# Chief of Staff",
  "Base directory for this skill",
];

export function normalizeContent(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function harvestId(kind: HarvestKind, content: string): string {
  return crypto
    .createHash("sha256")
    .update(`${kind}\n${normalizeContent(content)}`)
    .digest("hex");
}

/** Text of a user-typed turn, or null if the turn is a tool result / injected / paste. */
export function userTypedText(message: any): string | null {
  const c = message?.content;
  let text: string;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: any) => b?.type === "tool_result")) return null;
    text = c
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("\n");
  } else return null;
  text = text.trim();
  if (!text) return null;
  if (NOISE_PREFIXES.some((p) => text.startsWith(p))) return null;
  // Pastes (logs, diffs, code blocks) carry words that are not Rich's.
  if (text.includes("```") || text.split("\n").length > 12) return null;
  return text;
}

export interface Classification {
  kind: HarvestKind;
  score: number;
  signals: string[];
}

/** Score a user-typed turn. Returns null when nothing fires or the turn is out of bounds. */
export function classifyTurn(text: string): Classification | null {
  if (text.length < MIN_CONTENT_CHARS || text.length > MAX_CONTENT_CHARS)
    return null;
  const hits = RULES.filter((r) => r.re.test(text));
  if (hits.length === 0) return null;
  const byKind = new Map<HarvestKind, number>();
  for (const h of hits)
    byKind.set(h.kind, Math.max(byKind.get(h.kind) ?? 0, h.weight));
  const kind = KIND_PRIORITY.filter((k) => byKind.has(k)).sort(
    (a, b) => byKind.get(b)! - byKind.get(a)!,
  )[0];
  // Extra independent signals nudge the score; capped so weak rules cannot stack past 0.95.
  const score = Math.min(0.95, byKind.get(kind)! + 0.05 * (hits.length - 1));
  return { kind, score, signals: hits.map((h) => h.name) };
}

const PLAN_APPROVED_RE = /^User has approved your plan/;
const PLAN_REJECTED_RE = /doesn'?t want to proceed|tool use was rejected/i;

function toolResultText(block: any): string {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x: any) => x?.text ?? "").join("\n");
  return "";
}

function firstLine(s: string, max = 160): string {
  const l =
    s
      .split("\n")
      .map((x) => x.replace(/^#+\s*/, "").trim())
      .find((x) => x.length > 0) ?? "";
  return l.slice(0, max);
}

export interface ExtractStats {
  files: number;
  lines: number;
  userTurns: number;
  candidates: number;
  planDecisions: number;
}

/**
 * Extract candidate items from one transcript file. Plan outcomes are paired by
 * tool_use_id: an ExitPlanMode tool_use in an assistant turn, resolved by a later
 * tool_result whose text says approved / rejected.
 */
export function extractFromFile(
  absFile: string,
  projectsRoot: string,
  stats?: ExtractStats,
): HarvestItem[] {
  const rel = path.relative(projectsRoot, absFile);
  const project = rel.split(path.sep)[0];
  const sessionId = path.basename(absFile, ".jsonl");
  const out: HarvestItem[] = [];
  const plans = new Map<string, string>(); // tool_use_id → plan title
  if (stats) stats.files++;

  const lines = fs.readFileSync(absFile, "utf8").split("\n");
  lines.forEach((raw, i) => {
    if (!raw) return;
    if (stats) stats.lines++;
    let d: any;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    const prov = (): HarvestProvenance => ({
      provenance: "claude-transcript",
      project,
      session_id: sessionId,
      file: rel,
      line: i + 1,
      uuid: d.uuid ?? null,
      timestamp: d.timestamp ?? null,
    });
    const push = (
      kind: HarvestKind,
      content: string,
      score: number,
      signals: string[],
    ) => {
      out.push({
        harvest_id: harvestId(kind, content),
        kind,
        content,
        score,
        signals,
        provenance: prov(),
      });
    };

    if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b?.type === "tool_use" && b.name === "ExitPlanMode") {
          plans.set(b.id, firstLine(String(b.input?.plan ?? "")) || "plan");
        }
      }
      return;
    }
    if (d.type !== "user" || d.isSidechain) return;

    // Plan outcome: tool_result for a remembered ExitPlanMode call.
    if (Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b?.type !== "tool_result" || !plans.has(b.tool_use_id)) continue;
        const title = plans.get(b.tool_use_id)!;
        const res = toolResultText(b);
        if (stats) stats.planDecisions++;
        if (PLAN_APPROVED_RE.test(res)) {
          push("plan_accept", `Rich approved agent plan: "${title}"`, 0.7, [
            "exit_plan_mode_approved",
          ]);
        } else if (PLAN_REJECTED_RE.test(res)) {
          // Feedback, if any, follows "the user said:" — that is the label worth keeping.
          const said = res.split(/the user said:?/i)[1]?.trim();
          const fb = said ? ` — feedback: ${said.slice(0, 300)}` : "";
          push(
            "plan_reject",
            `Rich rejected agent plan: "${title}"${fb}`,
            said ? 0.85 : 0.65,
            ["exit_plan_mode_rejected"],
          );
        }
      }
    }

    const text = userTypedText(d.message);
    if (text === null) return;
    if (stats) stats.userTurns++;
    const cls = classifyTurn(text);
    if (!cls) return;
    if (stats) stats.candidates++;
    push(cls.kind, text, cls.score, cls.signals);
  });
  return out;
}

export function listTranscripts(
  projectsRoot: string,
  projects: string[],
): string[] {
  const files: string[] = [];
  for (const p of projects) {
    const dir = path.join(projectsRoot, p);
    if (!fs.existsSync(dir)) continue;
    // Top-level session files only; subagent transcripts are agent-authored prompts, not Rich.
    for (const f of fs.readdirSync(dir))
      if (f.endsWith(".jsonl")) files.push(path.join(dir, f));
  }
  return files.sort();
}

/** Token-set Jaccard, used as a cheap local near-dup pass before the KMS gate sees anything. */
export function jaccard(a: string, b: string): number {
  const ta = new Set(normalizeContent(a).split(/\W+/).filter(Boolean));
  const tb = new Set(normalizeContent(b).split(/\W+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export interface CurateResult {
  kept: HarvestItem[];
  droppedLowScore: number;
  droppedExactDup: number;
  droppedNearDup: number;
  droppedOverCap: number;
}

/**
 * Quality gate: score floor, exact + near-duplicate removal (keeping the higher score),
 * and a hard cap on the number of items so a run can never become a transcript dump.
 */
export function curate(
  items: HarvestItem[],
  opts: { minScore?: number; nearDup?: number; cap?: number } = {},
): CurateResult {
  const minScore = opts.minScore ?? MIN_SCORE;
  const nearDup = opts.nearDup ?? 0.8;
  const cap = opts.cap ?? 50;
  const r: CurateResult = {
    kept: [],
    droppedLowScore: 0,
    droppedExactDup: 0,
    droppedNearDup: 0,
    droppedOverCap: 0,
  };
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  for (const it of sorted) {
    if (it.score < minScore) {
      r.droppedLowScore++;
      continue;
    }
    if (seen.has(it.harvest_id)) {
      r.droppedExactDup++;
      continue;
    }
    if (
      r.kept.some(
        (k) => k.kind === it.kind && jaccard(k.content, it.content) >= nearDup,
      )
    ) {
      r.droppedNearDup++;
      continue;
    }
    seen.add(it.harvest_id);
    if (r.kept.length >= cap) {
      r.droppedOverCap++;
      continue;
    }
    r.kept.push(it);
  }
  return r;
}

/** KMS contentType per kind: durable rules are patterns; one-off judgments are insights. */
export function contentTypeFor(kind: HarvestKind): "pattern" | "insight" {
  return kind === "standing_rule" ||
    kind === "preference" ||
    kind === "dont_touch"
    ? "pattern"
    : "insight";
}

/** Args for `unified_store`. Subject is per-kind so the dedup gate scopes within a label class. */
export function toStoreArgs(
  item: HarvestItem,
  userId = "eng_kms",
): Record<string, any> {
  const p = item.provenance;
  return {
    content: `[Rich label: ${item.kind}] ${item.content}`,
    contentType: contentTypeFor(item.kind),
    source: "technical",
    userId,
    metadata: {
      subject: `ClaudeLabels.${item.kind}`,
      lane: "learning",
      provenance: p.provenance,
      harvest_id: item.harvest_id,
      label_kind: item.kind,
      label_score: item.score,
      label_signals: item.signals,
      claude_project: p.project,
      claude_session_id: p.session_id,
      claude_file: p.file,
      claude_line: p.line,
      claude_uuid: p.uuid,
      claude_timestamp: p.timestamp,
    },
  };
}
