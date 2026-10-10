import { resolveWriteUserId } from "../security/userIdPolicy.js";

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("resolveWriteUserId", () => {
  const base = env({ KMS_DEFAULT_USER_ID: "richard_yaker" });

  it("uses the default when no userId is given", () => {
    expect(resolveWriteUserId(undefined, base)).toEqual({
      ok: true,
      userId: "richard_yaker",
    });
  });

  it("refuses to invent an id when no default is configured", () => {
    const r = resolveWriteUserId(undefined, env({}));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/KMS_DEFAULT_USER_ID/);
  });

  it("allows the default and dolphin/ namespaces", () => {
    expect(resolveWriteUserId("richard_yaker", base).ok).toBe(true);
    expect(resolveWriteUserId("dolphin/alex/p2-0923", base).ok).toBe(true);
  });

  it("refuses aliases and placeholders", () => {
    for (const id of [
      "ryaker",
      "Richard Yaker",
      "user",
      "personal",
      "default",
      "your-user-id",
    ]) {
      expect(resolveWriteUserId(id, base).ok).toBe(false);
    }
  });

  it("honours KMS_ALLOWED_USER_IDS exact and prefix entries", () => {
    const e = env({
      KMS_DEFAULT_USER_ID: "eng_kms",
      KMS_ALLOWED_USER_IDS: "khizer, abundancecoach-*",
    });
    expect(resolveWriteUserId("khizer", e).ok).toBe(true);
    expect(resolveWriteUserId("abundancecoach-admin", e).ok).toBe(true);
    expect(resolveWriteUserId("khizer2", e).ok).toBe(false);
  });

  it("a lone * disables the check", () => {
    expect(
      resolveWriteUserId("anything", env({ KMS_ALLOWED_USER_IDS: "*" })).ok,
    ).toBe(true);
  });
});
