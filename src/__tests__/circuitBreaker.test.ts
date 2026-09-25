/**
 * Unit tests for the generic CircuitBreaker (src/embedding/circuitBreaker.ts).
 *
 * Covers: closed -> open -> half-open -> closed/open transitions, the
 * half-open single-probe-at-a-time invariant, isBlocking() as a
 * non-mutating peek, and the env-var parsing helpers' fallback behaviour
 * on missing/malformed values.
 */
import {
  CircuitBreaker,
  readCircuitCooldownMsFromEnv,
  readCircuitThresholdFromEnv,
} from "../embedding/circuitBreaker.js";
import { logger } from "../logger.js";

describe("CircuitBreaker", () => {
  describe("closed state", () => {
    it("starts closed and allows calls", () => {
      const cb = new CircuitBreaker();
      expect(cb.getState()).toBe("closed");
      expect(cb.canProceed()).toBe(true);
    });

    it("stays closed while failures are below threshold", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      cb.canProceed();
      cb.onFailure();
      cb.canProceed();
      cb.onFailure();
      expect(cb.getState()).toBe("closed");
      expect(cb.canProceed()).toBe(true);
    });

    it("a success resets the consecutive-failure streak", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      cb.canProceed();
      cb.onFailure();
      cb.canProceed();
      cb.onFailure();
      cb.canProceed();
      cb.onSuccess(); // streak reset
      cb.canProceed();
      cb.onFailure();
      cb.canProceed();
      cb.onFailure();
      // Only 2 consecutive failures since the reset — still closed.
      expect(cb.getState()).toBe("closed");
    });

    it("opens after N consecutive failures (default threshold 3)", () => {
      const cb = new CircuitBreaker();
      cb.canProceed();
      cb.onFailure();
      cb.canProceed();
      cb.onFailure();
      expect(cb.getState()).toBe("closed");
      cb.canProceed();
      cb.onFailure(); // 3rd consecutive failure
      expect(cb.getState()).toBe("open");
    });

    it("respects a custom failureThreshold", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      cb.canProceed();
      cb.onFailure();
      expect(cb.getState()).toBe("open");
    });
  });

  describe("open state", () => {
    it("refuses calls immediately (no side effects) before the cooldown elapses", () => {
      let now = 0;
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        clock: () => now,
      });
      cb.canProceed();
      cb.onFailure(); // opens
      expect(cb.getState()).toBe("open");

      now = 500; // still within cooldown
      expect(cb.canProceed()).toBe(false);
      expect(cb.getState()).toBe("open");
    });

    it("isBlocking() is true while open and within cooldown, without mutating state", () => {
      const now = 0;
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        clock: () => now,
      });
      cb.canProceed();
      cb.onFailure();
      expect(cb.isBlocking()).toBe(true);
      // Peeking must not consume the half-open slot or change state.
      expect(cb.getState()).toBe("open");
      expect(cb.isBlocking()).toBe(true);
    });

    it("isBlocking() flips to false once the cooldown elapses, without a canProceed() call", () => {
      let now = 0;
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        clock: () => now,
      });
      cb.canProceed();
      cb.onFailure();
      now = 1000;
      expect(cb.isBlocking()).toBe(false);
      // Still reports 'open' internally — only canProceed() performs the
      // open -> half-open transition.
      expect(cb.getState()).toBe("open");
    });

    it("transitions to half-open and admits exactly one probe once the cooldown elapses", () => {
      let now = 0;
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        clock: () => now,
      });
      cb.canProceed();
      cb.onFailure(); // open
      now = 1000;
      expect(cb.canProceed()).toBe(true);
      expect(cb.getState()).toBe("half-open");
    });
  });

  describe("half-open state", () => {
    function openThenAdvanceToHalfOpen(cooldownMs = 1000) {
      let now = 0;
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs,
        clock: () => now,
      });
      cb.canProceed();
      cb.onFailure();
      now = cooldownMs;
      return {
        cb,
        advance: (ms: number) => {
          now += ms;
        },
      };
    }

    it("refuses a second concurrent caller while a probe is in flight", () => {
      const { cb } = openThenAdvanceToHalfOpen();
      expect(cb.canProceed()).toBe(true); // admitted as the probe
      expect(cb.canProceed()).toBe(false); // concurrent caller refused
      expect(cb.canProceed()).toBe(false); // and again
      expect(cb.getState()).toBe("half-open");
    });

    it("a successful probe closes the breaker and resets the failure streak", () => {
      const { cb } = openThenAdvanceToHalfOpen();
      expect(cb.canProceed()).toBe(true);
      cb.onSuccess();
      expect(cb.getState()).toBe("closed");
      expect(cb.canProceed()).toBe(true);
    });

    it("a failed probe re-opens the breaker with a fresh cooldown", () => {
      const { cb, advance } = openThenAdvanceToHalfOpen(1000);
      expect(cb.canProceed()).toBe(true);
      cb.onFailure();
      expect(cb.getState()).toBe("open");

      // Fresh cooldown: immediately after re-opening, still blocked.
      expect(cb.canProceed()).toBe(false);

      // And it takes a FULL new cooldown window, not the remainder of the
      // original one, before a probe is admitted again.
      advance(999);
      expect(cb.canProceed()).toBe(false);
      advance(1);
      expect(cb.canProceed()).toBe(true);
      expect(cb.getState()).toBe("half-open");
    });

    it("after closing, a fresh run of failures can re-open it (full cycle)", () => {
      const { cb } = openThenAdvanceToHalfOpen();
      cb.canProceed();
      cb.onSuccess(); // closes
      expect(cb.getState()).toBe("closed");

      cb.canProceed();
      cb.onFailure(); // 1 consecutive failure -> re-opens (threshold 1)
      expect(cb.getState()).toBe("open");
    });
  });

  describe("env var parsing", () => {
    const savedThreshold = process.env.KMS_EMBED_CIRCUIT_THRESHOLD;
    const savedCooldown = process.env.KMS_EMBED_CIRCUIT_COOLDOWN_MS;

    afterEach(() => {
      if (savedThreshold === undefined)
        delete process.env.KMS_EMBED_CIRCUIT_THRESHOLD;
      else process.env.KMS_EMBED_CIRCUIT_THRESHOLD = savedThreshold;
      if (savedCooldown === undefined)
        delete process.env.KMS_EMBED_CIRCUIT_COOLDOWN_MS;
      else process.env.KMS_EMBED_CIRCUIT_COOLDOWN_MS = savedCooldown;
    });

    it("readCircuitThresholdFromEnv: falls back to default (3) when unset", () => {
      delete process.env.KMS_EMBED_CIRCUIT_THRESHOLD;
      expect(readCircuitThresholdFromEnv()).toBe(3);
    });

    it("readCircuitThresholdFromEnv: parses a valid positive integer", () => {
      process.env.KMS_EMBED_CIRCUIT_THRESHOLD = "5";
      expect(readCircuitThresholdFromEnv()).toBe(5);
    });

    it.each(["abc", "-1", "0", "", "  ", "NaN"])(
      "readCircuitThresholdFromEnv: falls back to default on bad value %p",
      (raw) => {
        process.env.KMS_EMBED_CIRCUIT_THRESHOLD = raw;
        expect(readCircuitThresholdFromEnv()).toBe(3);
      },
    );

    it("readCircuitThresholdFromEnv: Number.parseInt leading-digit semantics apply (matches existing env parsing elsewhere in this codebase)", () => {
      process.env.KMS_EMBED_CIRCUIT_THRESHOLD = "1.5abc";
      expect(readCircuitThresholdFromEnv()).toBe(1);
    });

    it("readCircuitCooldownMsFromEnv: falls back to default (60000) when unset", () => {
      delete process.env.KMS_EMBED_CIRCUIT_COOLDOWN_MS;
      expect(readCircuitCooldownMsFromEnv()).toBe(60_000);
    });

    it("readCircuitCooldownMsFromEnv: parses a valid positive integer", () => {
      process.env.KMS_EMBED_CIRCUIT_COOLDOWN_MS = "15000";
      expect(readCircuitCooldownMsFromEnv()).toBe(15_000);
    });

    it.each(["abc", "-1000", "0", "", "null"])(
      "readCircuitCooldownMsFromEnv: falls back to default on bad value %p",
      (raw) => {
        process.env.KMS_EMBED_CIRCUIT_COOLDOWN_MS = raw;
        expect(readCircuitCooldownMsFromEnv()).toBe(60_000);
      },
    );
  });

  describe("transition logging", () => {
    it("logs a state transition once per transition, not per call", () => {
      const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
      const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});

      let now = 0;
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        clock: () => now,
      });
      cb.canProceed();
      cb.onFailure(); // closed -> open (1 warn)
      cb.canProceed(); // still open, refused — no additional transition
      cb.canProceed(); // again refused — no additional transition
      expect(warnSpy).toHaveBeenCalledTimes(1);

      now = 1000;
      cb.canProceed(); // open -> half-open (1 info)
      cb.onSuccess(); // half-open -> closed (1 info)
      expect(infoSpy).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });
});
