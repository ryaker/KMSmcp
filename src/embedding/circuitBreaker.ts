/**
 * Generic consecutive-failure circuit breaker.
 *
 * Written for the Ollama embedder (rym1, LAN/Tailscale): when the remote host is
 * slow or overloaded, every `unified_store` used to wait the full per-attempt
 * timeout before degrading, one write at a time. The breaker turns a string of
 * consecutive failures into a fast, synchronous "don't even try" signal so the
 * caller can degrade immediately instead of re-discovering the outage on every
 * request.
 *
 *   closed -----(N consecutive failures)-----> open
 *   open -------(cooldown elapses)------------> half-open (exactly one probe admitted)
 *   half-open --(probe succeeds)---------------> closed
 *   half-open --(probe fails)------------------> open (fresh cooldown)
 *
 * This is a small, independent primitive — no dependency on fetch, Ollama, or
 * any particular error taxonomy. The caller decides what counts as success or
 * failure and reports it via `onSuccess()` / `onFailure()`.
 */
import { logger } from "../logger.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Consecutive failures (in the closed state) before the breaker opens. */
  failureThreshold?: number;
  /** How long the breaker stays open before admitting a half-open probe, in ms. */
  cooldownMs?: number;
  /** Clock injection point for tests. Defaults to Date.now. */
  clock?: () => number;
  /** Label included in transition log lines (e.g. the embedder id). */
  name?: string;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Parses a positive integer from an env var, falling back to `fallback` for
 * anything missing, non-numeric, zero, negative, or NaN (e.g. "abc", "-1", "0").
 */
function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readCircuitThresholdFromEnv(
  fallback = DEFAULT_FAILURE_THRESHOLD,
): number {
  return parsePositiveIntEnv(process.env.KMS_EMBED_CIRCUIT_THRESHOLD, fallback);
}

export function readCircuitCooldownMsFromEnv(
  fallback = DEFAULT_COOLDOWN_MS,
): number {
  return parsePositiveIntEnv(
    process.env.KMS_EMBED_CIRCUIT_COOLDOWN_MS,
    fallback,
  );
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly name: string;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  /** True while a half-open probe has been admitted and hasn't reported back yet. */
  private halfOpenProbeInFlight = false;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold =
      config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.clock = config.clock ?? Date.now;
    this.name = config.name ?? "circuit-breaker";
  }

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Cheap, side-effect-free check: would the breaker currently refuse work
   * outright? True only in the `open` state before the cooldown has elapsed.
   * Does NOT perform the open -> half-open transition and does NOT consume
   * the half-open probe slot — use this for a liveness check that must never
   * itself gate a real attempt (e.g. `isAvailable()`).
   */
  isBlocking(): boolean {
    if (this.state !== "open") return false;
    return this.clock() < this.cooldownUntil;
  }

  /**
   * Ask whether an attempt may proceed right now. This DOES have side
   * effects: in `open`, once the cooldown has elapsed, the first caller to
   * ask flips the breaker to `half-open` and is admitted as the probe; every
   * other concurrent caller is refused until that probe reports back via
   * `onSuccess()`/`onFailure()`.
   *
   * Every call that returns `true` MUST be followed by exactly one
   * `onSuccess()` or `onFailure()` call, or the breaker can get stuck
   * half-open.
   */
  canProceed(): boolean {
    const now = this.clock();

    if (this.state === "open") {
      if (now < this.cooldownUntil) return false;
      this.transition("half-open");
      this.halfOpenProbeInFlight = true;
      return true;
    }

    if (this.state === "half-open") {
      if (this.halfOpenProbeInFlight) return false;
      this.halfOpenProbeInFlight = true;
      return true;
    }

    // closed
    return true;
  }

  /** Report that the attempt admitted by canProceed() succeeded. */
  onSuccess(): void {
    if (this.state === "half-open") {
      this.halfOpenProbeInFlight = false;
      this.consecutiveFailures = 0;
      this.transition("closed");
      return;
    }
    this.consecutiveFailures = 0;
  }

  /** Report that the attempt admitted by canProceed() failed. */
  onFailure(): void {
    const now = this.clock();

    if (this.state === "half-open") {
      this.halfOpenProbeInFlight = false;
      this.cooldownUntil = now + this.cooldownMs;
      this.transition("open");
      return;
    }

    if (this.state === "open") {
      // Stray report while already open (shouldn't happen if canProceed()
      // is honoured) — cooldown is already running, nothing to extend.
      return;
    }

    // closed
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.cooldownUntil = now + this.cooldownMs;
      this.transition("open");
    }
  }

  private transition(next: CircuitState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    if (next === "open") {
      logger.warn(
        `[${this.name}] circuit breaker OPEN (was ${prev}) — cooling down ${this.cooldownMs}ms`,
      );
    } else if (next === "closed") {
      logger.info(`[${this.name}] circuit breaker CLOSED (was ${prev})`);
    } else {
      logger.info(
        `[${this.name}] circuit breaker HALF-OPEN (was ${prev}) — admitting one probe`,
      );
    }
  }
}
