/**
 * Which `userId`s a write may use.
 *
 * Mem0 and Mongo are shared, and every distinct `userId` becomes its own
 * entity there. A typo, a client-supplied alias ("ryaker", "user") or a
 * missing KMS_DEFAULT_USER_ID quietly minted new ones until Mem0 listed 79.
 * Writes are therefore checked against an allowlist; reads are not.
 *
 * Allowed: KMS_DEFAULT_USER_ID, `dolphin/*` (the DolphinBench harness
 * namespaces `dolphin/<persona>/<run-id>`), and anything in
 * KMS_ALLOWED_USER_IDS (comma-separated; a trailing `*` is a prefix match;
 * a lone `*` disables the check).
 */

export interface UserIdDecision {
  ok: boolean;
  /** The id to write under; empty when `ok` is false. */
  userId: string;
  /** Why the write was refused; set only when `ok` is false. */
  error?: string;
}

const ALWAYS_ALLOWED_PREFIXES = ["dolphin/"];

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function matches(pattern: string, userId: string): boolean {
  return pattern.endsWith("*")
    ? userId.startsWith(pattern.slice(0, -1))
    : pattern === userId;
}

export function resolveWriteUserId(
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): UserIdDecision {
  const defaultId = env.KMS_DEFAULT_USER_ID?.trim();
  const userId = requested?.trim() || defaultId;

  if (!userId) {
    return {
      ok: false,
      userId: "",
      error:
        "No userId given and KMS_DEFAULT_USER_ID is not set. Refusing to invent one: set KMS_DEFAULT_USER_ID for this server.",
    };
  }

  const extra = parseList(env.KMS_ALLOWED_USER_IDS);
  if (extra.includes("*")) return { ok: true, userId };

  if (defaultId && userId === defaultId) return { ok: true, userId };
  if (ALWAYS_ALLOWED_PREFIXES.some((p) => userId.startsWith(p)))
    return { ok: true, userId };
  if (extra.some((p) => matches(p, userId))) return { ok: true, userId };

  return {
    ok: false,
    userId,
    error:
      `userId "${userId}" is not allowed on this server (default: "${defaultId ?? "unset"}"). ` +
      `Omit userId to use the default, or add it to KMS_ALLOWED_USER_IDS if it is a real new identity.`,
  };
}
