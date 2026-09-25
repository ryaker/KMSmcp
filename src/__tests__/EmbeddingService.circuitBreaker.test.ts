/**
 * Circuit-breaker wiring tests for OllamaEmbeddingService.
 *
 * EmbeddingService.test.ts covers the embedder's own request/response
 * behaviour; this file covers the breaker integration specifically:
 *   - embed() fast-fails with EmbedderCircuitOpenError and makes NO fetch
 *     call once the breaker is open.
 *   - isAvailable() returns false with NO fetch call once the breaker is
 *     open (fast-fail path takes priority over the availability cache).
 *   - half-open admits exactly one concurrent probe; success closes and
 *     resumes normal operation, failure re-opens.
 *   - a bad KMS_EMBED_CIRCUIT_THRESHOLD env value falls back to the
 *     documented default (3) rather than disabling the breaker.
 */
import {
  EmbedderCircuitOpenError,
  OllamaEmbeddingService,
} from "../embedding/EmbeddingService.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

function fakeEmbedding(dim = 768): number[] {
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) out[i] = Math.sin(i);
  return out;
}

describe("OllamaEmbeddingService circuit breaker wiring", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("opens after `circuitThreshold` consecutive network-error embed() failures", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const svc = new OllamaEmbeddingService({
      circuitThreshold: 2,
      circuitCooldownMs: 60_000,
    });

    // Each embed() call retries once internally (2 fetch calls), so after
    // 2 failed embed() calls the breaker (threshold 2) should be open.
    await expect(svc.embed("a")).rejects.toThrow("ECONNREFUSED");
    await expect(svc.embed("b")).rejects.toThrow("ECONNREFUSED");
    expect(svc.getCircuitBreakerState()).toBe("open");

    fetchMock.mockClear();

    // Fast-fail: distinguishable error, and NO fetch call at all.
    await expect(svc.embed("c")).rejects.toThrow(EmbedderCircuitOpenError);
    await expect(svc.embed("c")).rejects.toThrow(/circuit open/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isAvailable() returns false with no network call while the breaker is open", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const svc = new OllamaEmbeddingService({
      circuitThreshold: 1,
      circuitCooldownMs: 60_000,
    });

    await expect(svc.embed("x")).rejects.toThrow("ECONNREFUSED");
    expect(svc.getCircuitBreakerState()).toBe("open");

    fetchMock.mockClear();
    expect(await svc.isAvailable()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an HTTP 5xx counts as a circuit failure even though it is not retried", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "down" }, false, 503));
    const svc = new OllamaEmbeddingService({
      circuitThreshold: 2,
      circuitCooldownMs: 60_000,
    });

    await expect(svc.embed("a")).rejects.toThrow(/HTTP 503/);
    expect(svc.getCircuitBreakerState()).toBe("closed"); // 1 of 2
    await expect(svc.embed("b")).rejects.toThrow(/HTTP 503/);
    expect(svc.getCircuitBreakerState()).toBe("open"); // 2 of 2
  });

  it("a dimension mismatch does NOT count as a circuit failure (reachable, just wrong shape)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ embedding: fakeEmbedding(384) }),
    );
    const svc = new OllamaEmbeddingService({
      circuitThreshold: 1,
      circuitCooldownMs: 60_000,
    });

    await expect(svc.embed("a")).rejects.toThrow(/dim mismatch/i);
    await expect(svc.embed("b")).rejects.toThrow(/dim mismatch/i);
    // Threshold is 1 but the breaker never saw a qualifying failure.
    expect(svc.getCircuitBreakerState()).toBe("closed");
  });

  describe("half-open probe concurrency", () => {
    it("admits exactly one concurrent embed() call as the probe; the rest fast-fail", async () => {
      let now = 0;
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
      const svc = new OllamaEmbeddingService({
        circuitThreshold: 1,
        circuitCooldownMs: 1000,
        clock: () => now,
      });

      await expect(svc.embed("x")).rejects.toThrow("ECONNREFUSED"); // opens
      expect(svc.getCircuitBreakerState()).toBe("open");

      now = 1000; // cooldown elapsed
      fetchMock.mockClear();

      // A probe that never resolves until we say so, so we can fire
      // concurrent callers while it's in flight.
      let resolveProbe!: (v: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveProbe = resolve;
          }),
      );

      const probe = svc.embed("probe");
      // Give the probe's canProceed() a tick to run before the concurrent calls.
      await Promise.resolve();

      const concurrent1 = svc.embed("concurrent-1");
      const concurrent2 = svc.embed("concurrent-2");

      await expect(concurrent1).rejects.toThrow(EmbedderCircuitOpenError);
      await expect(concurrent2).rejects.toThrow(EmbedderCircuitOpenError);
      // Only the probe touched the network — concurrent callers fast-failed.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      resolveProbe(jsonResponse({ embedding: fakeEmbedding(768) }));
      const vec = await probe;
      expect(vec.length).toBe(768);
      expect(svc.getCircuitBreakerState()).toBe("closed");
    });

    it("a failed half-open probe re-opens the breaker with a fresh cooldown", async () => {
      let now = 0;
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
      const svc = new OllamaEmbeddingService({
        circuitThreshold: 1,
        circuitCooldownMs: 1000,
        clock: () => now,
      });

      await expect(svc.embed("x")).rejects.toThrow("ECONNREFUSED"); // opens at t=0
      now = 1000;
      await expect(svc.embed("probe")).rejects.toThrow("ECONNREFUSED"); // half-open probe fails
      expect(svc.getCircuitBreakerState()).toBe("open");

      fetchMock.mockClear();
      // Fresh cooldown: immediately after, still fast-fails.
      await expect(svc.embed("y")).rejects.toThrow(EmbedderCircuitOpenError);
      expect(fetchMock).not.toHaveBeenCalled();

      now = 1999;
      await expect(svc.embed("z")).rejects.toThrow(EmbedderCircuitOpenError);
      expect(fetchMock).not.toHaveBeenCalled();

      now = 2000;
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(svc.embed("probe-2")).rejects.toThrow("ECONNREFUSED");
      expect(fetchMock).toHaveBeenCalled(); // the new cooldown's probe reached the network
    });
  });

  describe("env var fallback", () => {
    const saved = process.env.KMS_EMBED_CIRCUIT_THRESHOLD;

    afterEach(() => {
      if (saved === undefined) delete process.env.KMS_EMBED_CIRCUIT_THRESHOLD;
      else process.env.KMS_EMBED_CIRCUIT_THRESHOLD = saved;
    });

    it("falls back to the default threshold (3) when KMS_EMBED_CIRCUIT_THRESHOLD is malformed", async () => {
      process.env.KMS_EMBED_CIRCUIT_THRESHOLD = "not-a-number";
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
      const svc = new OllamaEmbeddingService({ circuitCooldownMs: 60_000 }); // no override — reads env

      await expect(svc.embed("a")).rejects.toThrow("ECONNREFUSED");
      await expect(svc.embed("b")).rejects.toThrow("ECONNREFUSED");
      expect(svc.getCircuitBreakerState()).toBe("closed"); // still below default threshold 3
      await expect(svc.embed("c")).rejects.toThrow("ECONNREFUSED");
      expect(svc.getCircuitBreakerState()).toBe("open"); // 3rd consecutive failure
    });
  });
});
