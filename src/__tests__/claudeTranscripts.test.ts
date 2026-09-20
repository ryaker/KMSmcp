import fs from "fs";
import os from "os";
import path from "path";
import {
  classifyTurn,
  contentTypeFor,
  curate,
  extractFromFile,
  harvestId,
  toStoreArgs,
  userTypedText,
} from "../harvest/claudeTranscripts";

describe("classifyTurn", () => {
  it("flags standing rules, corrections, dont-touch", () => {
    expect(
      classifyTurn("From now on always run prettier before commit")?.kind,
    ).toBe("standing_rule");
    expect(
      classifyTurn("No I meant the worktree, I said that twice")?.kind,
    ).toBe("correction");
    expect(classifyTurn("Don't touch the marketing copy")?.kind).toBe(
      "dont_touch",
    );
  });
  it("ignores neutral, too-short, and over-long turns", () => {
    expect(classifyTurn("yes proceed with the plan")).toBeNull();
    expect(classifyTurn("no")).toBeNull();
    expect(classifyTurn("always " + "x".repeat(700))).toBeNull();
  });
  it("weak single hit stays below the curation floor", () => {
    expect(
      classifyTurn("that looks wrong to me maybe")?.score ?? 0,
    ).toBeLessThan(0.6);
  });
});

describe("userTypedText", () => {
  it("rejects tool results, harness injections, and pastes", () => {
    expect(
      userTypedText({ content: [{ type: "tool_result", content: "x" }] }),
    ).toBeNull();
    expect(
      userTypedText({ content: "<system-reminder>always</system-reminder>" }),
    ).toBeNull();
    expect(userTypedText({ content: "Stop hook feedback: always" })).toBeNull();
    expect(userTypedText({ content: "always\n```\ncode\n```" })).toBeNull();
    expect(userTypedText({ content: "never push to main" })).toBe(
      "never push to main",
    );
  });
});

describe("curate", () => {
  const mk = (content: string, score: number) => ({
    harvest_id: harvestId("correction", content),
    kind: "correction" as const,
    content,
    score,
    signals: [],
    provenance: {} as any,
  });
  it("drops low score, exact dups, near dups, and enforces the cap", () => {
    const r = curate(
      [
        mk("you missed the tests in the PR again", 0.9),
        mk("You missed the tests in the PR again", 0.8),
        mk("you missed the tests in the PR again!", 0.7),
        mk("totally different wording about branches", 0.7),
        mk("weak one", 0.3),
      ],
      { cap: 2 },
    );
    expect(r.kept.map((k) => k.content)).toEqual([
      "you missed the tests in the PR again",
      "totally different wording about branches",
    ]);
    expect(r.droppedLowScore).toBe(1);
    expect(r.droppedExactDup).toBe(1);
    expect(r.droppedNearDup).toBe(1);
  });
});

describe("extractFromFile", () => {
  it("extracts typed corrections and pairs ExitPlanMode outcomes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
    const dir = path.join(root, "-proj");
    fs.mkdirSync(dir);
    const f = path.join(dir, "sess1.jsonl");
    const rows = [
      {
        type: "user",
        uuid: "u1",
        message: { content: "I told you already, never touch the quiz code" },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "ExitPlanMode",
              input: { plan: "# Ship X\nsteps" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "User has approved your plan. You can now start coding.",
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "ExitPlanMode",
              input: { plan: "# Ship Y" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t2",
              is_error: true,
              content:
                "The user doesn't want to proceed. the user said: too big, split it",
            },
          ],
        },
      },
    ];
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const items = extractFromFile(f, root);
    expect(items.map((i) => i.kind)).toEqual([
      "correction",
      "plan_accept",
      "plan_reject",
    ]);
    expect(items.find((i) => i.kind === "plan_reject")!.content).toContain(
      "too big, split it",
    );
    expect(items[0].provenance).toMatchObject({
      provenance: "claude-transcript",
      project: "-proj",
      session_id: "sess1",
      line: 1,
    });
  });
});

describe("toStoreArgs", () => {
  it("maps kinds to pattern/insight and carries eng_kms lane + provenance", () => {
    expect(contentTypeFor("standing_rule")).toBe("pattern");
    expect(contentTypeFor("plan_reject")).toBe("insight");
    const a = toStoreArgs({
      harvest_id: "h",
      kind: "correction",
      content: "c",
      score: 0.9,
      signals: ["i_said"],
      provenance: {
        provenance: "claude-transcript",
        project: "p",
        session_id: "s",
        file: "p/s.jsonl",
        line: 3,
        uuid: null,
        timestamp: null,
      },
    });
    expect(a).toMatchObject({
      userId: "eng_kms",
      contentType: "insight",
      metadata: {
        lane: "learning",
        provenance: "claude-transcript",
        subject: "ClaudeLabels.correction",
      },
    });
  });
});
