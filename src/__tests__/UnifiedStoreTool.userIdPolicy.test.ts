/**
 * unified_store refuses unknown userIds before anything is routed or written
 * (src/security/userIdPolicy.ts). The shared jest setup opens the allowlist;
 * this file closes it again.
 */
import { UnifiedStoreTool } from "../tools/UnifiedStoreTool.js";
import type { IntelligentStorageRouter } from "../routing/IntelligentStorageRouter.js";

describe("UnifiedStoreTool — userId allowlist", () => {
  const saved = { ...process.env };
  let graph: any, mongodb: any, mem0: any, tool: UnifiedStoreTool;

  beforeEach(() => {
    process.env.KMS_DEFAULT_USER_ID = "richard_yaker";
    delete process.env.KMS_ALLOWED_USER_IDS;
    const router = {
      determineStorage: jest
        .fn()
        .mockReturnValue({
          primary: "graph",
          secondary: [],
          cacheStrategy: "L3",
          reasoning: "test",
        }),
      getRoutingStats: jest.fn().mockReturnValue({}),
    } as unknown as IntelligentStorageRouter;
    graph = {
      name: "sparrowdb",
      store: jest.fn().mockResolvedValue(undefined),
      findSimilar: jest.fn().mockResolvedValue([]),
    };
    mongodb = { store: jest.fn() };
    mem0 = { store: jest.fn() };
    tool = new UnifiedStoreTool(
      router,
      { mongodb, graph, mem0 } as any,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn(),
        invalidate: jest.fn(),
      } as any,
      null,
      null,
      null,
    );
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it.each(["ryaker", "user", "personal"])(
    'refuses userId "%s" and writes nothing',
    async (userId) => {
      const r: any = await tool.store({
        content: "A fact",
        contentType: "fact",
        source: "personal",
        userId,
      });
      expect(r).toMatchObject({ status: "invalid_user", success: false });
      expect(r.error).toContain(userId);
      for (const b of [graph, mongodb, mem0])
        expect(b.store).not.toHaveBeenCalled();
    },
  );

  it("refuses a write with no userId when no default is configured", async () => {
    delete process.env.KMS_DEFAULT_USER_ID;
    const r: any = await tool.store({
      content: "A fact",
      contentType: "fact",
      source: "personal",
    });
    expect(r).toMatchObject({ status: "invalid_user", success: false });
    expect(graph.store).not.toHaveBeenCalled();
  });

  it("stores under the default when userId is omitted", async () => {
    await tool.store({
      content: "A fact about the default user",
      contentType: "fact",
      source: "personal",
    });
    expect(graph.store.mock.calls[0][0].userId).toBe("richard_yaker");
  });

  it("allows dolphin/ benchmark namespaces", async () => {
    await tool.store({
      content: "Bench fact",
      contentType: "fact",
      source: "personal",
      userId: "dolphin/alex/run-1",
    });
    expect(graph.store.mock.calls[0][0].userId).toBe("dolphin/alex/run-1");
  });
});
