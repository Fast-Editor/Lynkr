const assert = require("assert");
const { describe, it, beforeEach } = require("node:test");

const {
  CockatielCircuitBreaker,
  CircuitBreakerError,
  CockatielRegistry,
  getCockatielRegistry,
  STATE,
  withCockatielRetry,
  createBulkhead,
  createProviderPolicy,
  BulkheadRejectedError,
  TaskCancelledError,
} = require("../src/clients/resilience");

// Also verify re-exports work
const cb = require("../src/clients/circuit-breaker");
const retryMod = require("../src/clients/retry");

describe("Resilience — Cockatiel Adapters", () => {
  // =========================================================================
  // Re-exports
  // =========================================================================
  describe("Re-exports", () => {
    it("circuit-breaker.js re-exports correct names", () => {
      assert.ok(cb.CircuitBreaker);
      assert.ok(cb.CircuitBreakerError);
      assert.ok(cb.CircuitBreakerRegistry);
      assert.ok(cb.getCircuitBreakerRegistry);
      assert.ok(cb.STATE);
      assert.deepStrictEqual(cb.STATE, STATE);
    });

    it("retry.js re-exports correct names", () => {
      assert.ok(retryMod.withRetry);
      assert.ok(retryMod.createRetryWrapper);
      assert.ok(retryMod.calculateDelay);
      assert.ok(retryMod.isRetryable);
      assert.ok(retryMod.detectColdStart);
      assert.ok(retryMod.DEFAULT_CONFIG);
    });

    it("retry.js withRetry is the same as withCockatielRetry", () => {
      assert.strictEqual(retryMod.withRetry, withCockatielRetry);
    });

    it("circuit-breaker.js CircuitBreaker is CockatielCircuitBreaker", () => {
      assert.strictEqual(cb.CircuitBreaker, CockatielCircuitBreaker);
    });

    it("circuit-breaker.js CircuitBreakerRegistry is CockatielRegistry", () => {
      assert.strictEqual(cb.CircuitBreakerRegistry, CockatielRegistry);
    });

    it("DEFAULT_CONFIG values match DEFAULT_RETRY_CONFIG", () => {
      const cfg = retryMod.DEFAULT_CONFIG;
      assert.strictEqual(cfg.maxRetries, 3);
      assert.strictEqual(cfg.initialDelay, 1000);
      assert.strictEqual(cfg.maxDelay, 30000);
      assert.strictEqual(cfg.backoffMultiplier, 2);
      assert.strictEqual(cfg.jitterFactor, 0.1);
      assert.deepStrictEqual(cfg.retryableStatuses, [429, 500, 502, 503, 504]);
      assert.deepStrictEqual(cfg.retryableErrors, [
        "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ENETUNREACH", "ECONNREFUSED",
      ]);
    });
  });

  // =========================================================================
  // CircuitBreakerError
  // =========================================================================
  describe("CircuitBreakerError", () => {
    it("is an instance of Error", () => {
      const err = new CircuitBreakerError("test msg", 5000);
      assert.ok(err instanceof Error);
    });

    it("sets name, code, message, and retryAfter", () => {
      const err = new CircuitBreakerError("breaker open", 12345);
      assert.strictEqual(err.name, "CircuitBreakerError");
      assert.strictEqual(err.code, "circuit_breaker_open");
      assert.strictEqual(err.message, "breaker open");
      assert.strictEqual(err.retryAfter, 12345);
    });

    it("has a stack trace", () => {
      const err = new CircuitBreakerError("msg", 0);
      assert.ok(err.stack);
      assert.ok(err.stack.includes("CircuitBreakerError"));
    });
  });

  // =========================================================================
  // CockatielCircuitBreaker
  // =========================================================================
  describe("CockatielCircuitBreaker", () => {
    let breaker;

    beforeEach(() => {
      breaker = new CockatielCircuitBreaker("test-provider", {
        failureThreshold: 3,
        timeout: 100, // short for tests
      });
    });

    it("starts in CLOSED state", () => {
      assert.strictEqual(breaker.state, STATE.CLOSED);
    });

    it("getState() returns correct shape", () => {
      const state = breaker.getState();
      assert.strictEqual(state.name, "test-provider");
      assert.strictEqual(state.state, STATE.CLOSED);
      assert.strictEqual(typeof state.failureCount, "number");
      assert.strictEqual(typeof state.successCount, "number");
      assert.strictEqual(typeof state.nextAttempt, "number");
      assert.strictEqual(typeof state.lastStateChange, "number");
      assert.ok(state.stats);
      assert.strictEqual(state.stats.totalRequests, 0);
    });

    it("getState().stats is a copy, not a reference", () => {
      const state1 = breaker.getState();
      state1.stats.totalRequests = 999;
      const state2 = breaker.getState();
      assert.strictEqual(state2.stats.totalRequests, 0);
    });

    it("executes successfully and tracks stats", async () => {
      const result = await breaker.execute(() => Promise.resolve("ok"));
      assert.strictEqual(result, "ok");
      assert.strictEqual(breaker.stats.totalRequests, 1);
      assert.strictEqual(breaker.stats.totalSuccesses, 1);
      assert.strictEqual(breaker.stats.totalFailures, 0);
      assert.strictEqual(breaker.stats.totalRejected, 0);
    });

    it("passes through the return value of fn", async () => {
      const obj = { data: [1, 2, 3], nested: { ok: true } };
      const result = await breaker.execute(() => Promise.resolve(obj));
      assert.deepStrictEqual(result, obj);
    });

    it("transitions CLOSED → OPEN after consecutive failures", async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error("fail")));
        } catch {}
      }

      assert.strictEqual(breaker.state, STATE.OPEN);
      assert.strictEqual(breaker.stats.totalFailures, 3);
    });

    it("does not open on non-consecutive failures (success resets count)", async () => {
      // fail, fail, success, fail, fail — should stay CLOSED (never 3 consecutive)
      const sequence = [false, false, true, false, false];
      for (const shouldSucceed of sequence) {
        try {
          await breaker.execute(() =>
            shouldSucceed ? Promise.resolve("ok") : Promise.reject(new Error("fail"))
          );
        } catch {}
      }
      assert.strictEqual(breaker.state, STATE.CLOSED);
    });

    it("re-throws the original error from fn (not CircuitBreakerError) when CLOSED", async () => {
      const originalErr = new TypeError("custom type error");
      try {
        await breaker.execute(() => Promise.reject(originalErr));
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(err instanceof TypeError);
        assert.strictEqual(err.message, "custom type error");
        assert.ok(!(err instanceof CircuitBreakerError));
      }
    });

    it("throws CircuitBreakerError when OPEN", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error("fail")));
        } catch {}
      }

      try {
        await breaker.execute(() => Promise.resolve("should not run"));
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(err instanceof CircuitBreakerError);
        assert.strictEqual(err.name, "CircuitBreakerError");
        assert.strictEqual(err.code, "circuit_breaker_open");
        assert.strictEqual(typeof err.retryAfter, "number");
      }
    });

    it("CircuitBreakerError message includes breaker name", async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error("fail")));
        } catch {}
      }

      try {
        await breaker.execute(() => Promise.resolve());
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(err.message.includes("test-provider"));
      }
    });

    it("increments totalRejected for each call while OPEN", async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error("fail"))); } catch {}
      }

      // Three rejected calls
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.resolve()); } catch {}
      }

      assert.strictEqual(breaker.stats.totalRejected, 3);
    });

    it("totalRequests increments on every call including rejected", async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error("fail"))); } catch {}
      }
      // 3 failures
      try { await breaker.execute(() => Promise.resolve()); } catch {}
      // 1 rejected
      assert.strictEqual(breaker.stats.totalRequests, 4);
    });

    it("failureCount and successCount getters work", async () => {
      assert.strictEqual(breaker.failureCount, 0);
      assert.strictEqual(breaker.successCount, 0);

      try { await breaker.execute(() => Promise.reject(new Error("fail"))); } catch {}
      assert.strictEqual(breaker.failureCount, 1);

      await breaker.execute(() => Promise.resolve("ok"));
      assert.strictEqual(breaker.failureCount, 0); // reset on success
    });

    it("transitions OPEN → HALF_OPEN → CLOSED on recovery", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error("fail")));
        } catch {}
      }
      assert.strictEqual(breaker.state, STATE.OPEN);

      // Wait for halfOpenAfter
      await new Promise((r) => setTimeout(r, 150));

      // Next call should go through (half-open)
      const result = await breaker.execute(() => Promise.resolve("recovered"));
      assert.strictEqual(result, "recovered");
      // After success in half-open, should close
      assert.strictEqual(breaker.state, STATE.CLOSED);
    });

    it("failure in HALF_OPEN re-opens the circuit", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error("fail"))); } catch {}
      }
      assert.strictEqual(breaker.state, STATE.OPEN);

      // Wait for halfOpenAfter
      await new Promise((r) => setTimeout(r, 150));

      // Fail in half-open
      try {
        await breaker.execute(() => Promise.reject(new Error("still failing")));
      } catch {}

      assert.strictEqual(breaker.state, STATE.OPEN);
    });

    it("reset() returns to CLOSED state", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error("fail")));
        } catch {}
      }
      assert.strictEqual(breaker.state, STATE.OPEN);

      breaker.reset();
      assert.strictEqual(breaker.state, STATE.CLOSED);

      // Should be usable again
      const result = await breaker.execute(() => Promise.resolve("after-reset"));
      assert.strictEqual(result, "after-reset");
    });

    it("reset() clears failure and success counts", async () => {
      try { await breaker.execute(() => Promise.reject(new Error("fail"))); } catch {}
      assert.strictEqual(breaker.failureCount, 1);

      breaker.reset();
      assert.strictEqual(breaker.failureCount, 0);
      assert.strictEqual(breaker.successCount, 0);
    });

    it("breaker works correctly after reset (can re-open)", async () => {
      // Open
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error("fail"))); } catch {}
      }
      assert.strictEqual(breaker.state, STATE.OPEN);

      breaker.reset();
      assert.strictEqual(breaker.state, STATE.CLOSED);

      // Open again
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error("fail again"))); } catch {}
      }
      assert.strictEqual(breaker.state, STATE.OPEN);
    });

    it("uses default options when none provided", () => {
      const defaultBreaker = new CockatielCircuitBreaker("default-test");
      assert.strictEqual(defaultBreaker.failureThreshold, 5);
      assert.strictEqual(defaultBreaker.successThreshold, 2);
      assert.strictEqual(defaultBreaker.halfOpenAfter, 60000);
      assert.strictEqual(defaultBreaker.state, STATE.CLOSED);
    });

    it("handles synchronous fn that returns value", async () => {
      const result = await breaker.execute(() => "sync-value");
      assert.strictEqual(result, "sync-value");
    });

    it("handles fn that returns null", async () => {
      const result = await breaker.execute(() => null);
      assert.strictEqual(result, null);
    });

    it("handles fn that returns undefined", async () => {
      const result = await breaker.execute(() => undefined);
      assert.strictEqual(result, undefined);
    });
  });

  // =========================================================================
  // CockatielRegistry
  // =========================================================================
  describe("CockatielRegistry", () => {
    it("creates and caches breakers by name", () => {
      const registry = new CockatielRegistry();
      const b1 = registry.get("provider-a", { failureThreshold: 3 });
      const b2 = registry.get("provider-a");
      assert.strictEqual(b1, b2);
    });

    it("creates different instances for different names", () => {
      const registry = new CockatielRegistry();
      const b1 = registry.get("provider-a", { failureThreshold: 3 });
      const b2 = registry.get("provider-b", { failureThreshold: 3 });
      assert.notStrictEqual(b1, b2);
    });

    it("getAll() returns array of state objects", () => {
      const registry = new CockatielRegistry();
      registry.get("p1", { failureThreshold: 3 });
      registry.get("p2", { failureThreshold: 5 });

      const all = registry.getAll();
      assert.strictEqual(all.length, 2);
      assert.strictEqual(all[0].name, "p1");
      assert.strictEqual(all[1].name, "p2");
      assert.strictEqual(all[0].state, STATE.CLOSED);
    });

    it("getAll() returns empty array for empty registry", () => {
      const registry = new CockatielRegistry();
      const all = registry.getAll();
      assert.ok(Array.isArray(all));
      assert.strictEqual(all.length, 0);
    });

    it("getAll() returns breakers with mixed states", async () => {
      const registry = new CockatielRegistry();
      registry.get("healthy", { failureThreshold: 5 });
      const failing = registry.get("failing", { failureThreshold: 1, timeout: 60000 });

      // Open the failing one
      try { await failing.execute(() => Promise.reject(new Error("fail"))); } catch {}

      const all = registry.getAll();
      const healthyState = all.find((b) => b.name === "healthy");
      const failingState = all.find((b) => b.name === "failing");

      assert.strictEqual(healthyState.state, STATE.CLOSED);
      assert.strictEqual(failingState.state, STATE.OPEN);
    });

    it("getAll() state objects have stats", () => {
      const registry = new CockatielRegistry();
      registry.get("p1", { failureThreshold: 3 });
      const all = registry.getAll();
      assert.ok(all[0].stats);
      assert.strictEqual(typeof all[0].stats.totalRequests, "number");
      assert.strictEqual(typeof all[0].stats.totalFailures, "number");
      assert.strictEqual(typeof all[0].stats.totalSuccesses, "number");
      assert.strictEqual(typeof all[0].stats.totalRejected, "number");
    });

    it("resetAll() resets all breakers", async () => {
      const registry = new CockatielRegistry();
      const b = registry.get("p1", { failureThreshold: 1, timeout: 60000 });

      // Open it
      try {
        await b.execute(() => Promise.reject(new Error("fail")));
      } catch {}
      assert.strictEqual(b.state, STATE.OPEN);

      registry.resetAll();
      assert.strictEqual(b.state, STATE.CLOSED);
    });

    it("resetAll() resets multiple breakers", async () => {
      const registry = new CockatielRegistry();
      const b1 = registry.get("p1", { failureThreshold: 1, timeout: 60000 });
      const b2 = registry.get("p2", { failureThreshold: 1, timeout: 60000 });

      try { await b1.execute(() => Promise.reject(new Error("fail"))); } catch {}
      try { await b2.execute(() => Promise.reject(new Error("fail"))); } catch {}

      assert.strictEqual(b1.state, STATE.OPEN);
      assert.strictEqual(b2.state, STATE.OPEN);

      registry.resetAll();

      assert.strictEqual(b1.state, STATE.CLOSED);
      assert.strictEqual(b2.state, STATE.CLOSED);
    });
  });

  // =========================================================================
  // getCockatielRegistry singleton
  // =========================================================================
  describe("getCockatielRegistry", () => {
    it("returns the same instance on repeated calls", () => {
      const r1 = getCockatielRegistry();
      const r2 = getCockatielRegistry();
      assert.strictEqual(r1, r2);
    });

    it("returns an instance of CockatielRegistry", () => {
      const r = getCockatielRegistry();
      assert.ok(r instanceof CockatielRegistry);
    });
  });

  // =========================================================================
  // withCockatielRetry
  // =========================================================================
  describe("withCockatielRetry", () => {
    it("succeeds on first try with no retries needed", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => { callCount++; return Promise.resolve({ status: 200 }); },
        { maxRetries: 3, initialDelay: 10 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 1);
    });

    it("passes attempt number to fn (0-indexed)", async () => {
      const attempts = [];
      let callCount = 0;

      await withCockatielRetry(
        (attempt) => {
          attempts.push(attempt);
          callCount++;
          if (callCount < 3) {
            return Promise.resolve({ status: 500, headers: new Map() });
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );

      assert.deepStrictEqual(attempts, [0, 1, 2]);
    });

    it("returns last response when all retries exhausted (response errors)", async () => {
      const result = await withCockatielRetry(
        () => Promise.resolve({ status: 503, headers: new Map() }),
        { maxRetries: 2, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );

      assert.strictEqual(result.status, 503);
    });

    it("throws non-retryable errors immediately without retrying", async () => {
      let callCount = 0;
      try {
        await withCockatielRetry(
          () => { callCount++; throw new Error("non-retryable"); },
          { maxRetries: 3, initialDelay: 10 }
        );
        assert.fail("Should have thrown");
      } catch (err) {
        assert.strictEqual(err.message, "non-retryable");
        assert.strictEqual(callCount, 1);
      }
    });

    it("retries on ECONNRESET error code", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("connection reset");
            err.code = "ECONNRESET";
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );

      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on ETIMEDOUT error code", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("timed out");
            err.code = "ETIMEDOUT";
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on ENOTFOUND error code", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("not found");
            err.code = "ENOTFOUND";
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on ENETUNREACH error code", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("net unreachable");
            err.code = "ENETUNREACH";
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on ECONNREFUSED error code", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("conn refused");
            err.code = "ECONNREFUSED";
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on nested cause error code (undici TypeError wrapping)", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const cause = new Error("inner");
            cause.code = "ECONNRESET";
            const err = new TypeError("fetch failed");
            err.cause = cause;
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on FetchError", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("fetch error");
            err.name = "FetchError";
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on AbortError", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on 502 status", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) return Promise.resolve({ status: 502, headers: new Map() });
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("retries on 504 status", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) return Promise.resolve({ status: 504, headers: new Map() });
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("does NOT retry on 400 status", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          return Promise.resolve({ status: 400 });
        },
        { maxRetries: 3, initialDelay: 10 }
      );
      assert.strictEqual(result.status, 400);
      assert.strictEqual(callCount, 1);
    });

    it("does NOT retry on 401 status", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          return Promise.resolve({ status: 401 });
        },
        { maxRetries: 3, initialDelay: 10 }
      );
      assert.strictEqual(result.status, 401);
      assert.strictEqual(callCount, 1);
    });

    it("does NOT retry on 403 status", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          return Promise.resolve({ status: 403 });
        },
        { maxRetries: 3, initialDelay: 10 }
      );
      assert.strictEqual(result.status, 403);
      assert.strictEqual(callCount, 1);
    });

    it("does NOT retry on 404 status", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          return Promise.resolve({ status: 404 });
        },
        { maxRetries: 3, initialDelay: 10 }
      );
      assert.strictEqual(result.status, 404);
      assert.strictEqual(callCount, 1);
    });

    it("handles 429 with Retry-After header (numeric seconds)", async () => {
      let callCount = 0;
      const start = Date.now();

      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              status: 429,
              headers: { get: (name) => name === "retry-after" ? "1" : null },
            });
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );

      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
      // Should have waited ~1000ms for Retry-After: 1
      assert.ok(Date.now() - start >= 900, "Should have waited ~1s for Retry-After");
    });

    it("handles 429 without Retry-After header (uses exponential backoff)", async () => {
      let callCount = 0;

      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              status: 429,
              headers: { get: () => null },
            });
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 100, jitterFactor: 0 }
      );

      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("handles 429 with Retry-After as HTTP date", async () => {
      let callCount = 0;

      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount === 1) {
            // Set retry-after to a date ~100ms in the future
            const futureDate = new Date(Date.now() + 100).toUTCString();
            return Promise.resolve({
              status: 429,
              headers: { get: (name) => name === "retry-after" ? futureDate : null },
            });
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
      );

      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("maxRetries: 0 does not retry", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          return Promise.resolve({ status: 500 });
        },
        { maxRetries: 0, initialDelay: 10 }
      );
      assert.strictEqual(result.status, 500);
      assert.strictEqual(callCount, 1);
    });

    it("throws on retryable error after all retries exhausted", async () => {
      try {
        await withCockatielRetry(
          () => {
            const err = new Error("always fails");
            err.code = "ECONNREFUSED";
            throw err;
          },
          { maxRetries: 2, initialDelay: 10, maxDelay: 20, jitterFactor: 0 }
        );
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(err.message.includes("always fails"));
      }
    });

    it("respects custom retryableStatuses", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) return Promise.resolve({ status: 418, headers: new Map() });
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0, retryableStatuses: [418] }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("respects custom retryableErrors", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("custom");
            err.code = "ECUSTOM";
            throw err;
          }
          return Promise.resolve({ status: 200 });
        },
        { maxRetries: 3, initialDelay: 10, maxDelay: 20, jitterFactor: 0, retryableErrors: ["ECUSTOM"] }
      );
      assert.strictEqual(result.status, 200);
      assert.strictEqual(callCount, 2);
    });

    it("returns non-retryable successful response immediately", async () => {
      let callCount = 0;
      const result = await withCockatielRetry(
        () => {
          callCount++;
          return Promise.resolve({ status: 201, data: "created" });
        },
        { maxRetries: 3, initialDelay: 10 }
      );
      assert.strictEqual(result.status, 201);
      assert.strictEqual(result.data, "created");
      assert.strictEqual(callCount, 1);
    });
  });

  // =========================================================================
  // retry.js utility functions
  // =========================================================================
  describe("retry.js utility functions", () => {
    describe("calculateDelay", () => {
      it("returns initialDelay for attempt 0", () => {
        const delay = retryMod.calculateDelay(0, {
          initialDelay: 1000,
          backoffMultiplier: 2,
          maxDelay: 30000,
          jitterFactor: 0,
        });
        assert.strictEqual(delay, 1000);
      });

      it("doubles for attempt 1 with multiplier 2", () => {
        const delay = retryMod.calculateDelay(1, {
          initialDelay: 1000,
          backoffMultiplier: 2,
          maxDelay: 30000,
          jitterFactor: 0,
        });
        assert.strictEqual(delay, 2000);
      });

      it("caps at maxDelay", () => {
        const delay = retryMod.calculateDelay(10, {
          initialDelay: 1000,
          backoffMultiplier: 2,
          maxDelay: 5000,
          jitterFactor: 0,
        });
        assert.strictEqual(delay, 5000);
      });

      it("adds jitter within bounds", () => {
        const delays = [];
        for (let i = 0; i < 20; i++) {
          delays.push(
            retryMod.calculateDelay(0, {
              initialDelay: 1000,
              backoffMultiplier: 2,
              maxDelay: 30000,
              jitterFactor: 0.1,
            })
          );
        }
        // All delays should be >= 0
        assert.ok(delays.every((d) => d >= 0));
        // With 10% jitter on 1000ms, range is [900, 1100]
        assert.ok(delays.every((d) => d >= 900 && d <= 1100));
      });

      it("returns 0 or positive with jitter", () => {
        const delay = retryMod.calculateDelay(0, {
          initialDelay: 1,
          backoffMultiplier: 2,
          maxDelay: 30000,
          jitterFactor: 0.5,
        });
        assert.ok(delay >= 0);
      });
    });

    describe("isRetryable", () => {
      const config = retryMod.DEFAULT_CONFIG;

      it("returns true for 429 status", () => {
        assert.strictEqual(retryMod.isRetryable(null, { status: 429 }, config), true);
      });

      it("returns true for 500 status", () => {
        assert.strictEqual(retryMod.isRetryable(null, { status: 500 }, config), true);
      });

      it("returns true for 502 status", () => {
        assert.strictEqual(retryMod.isRetryable(null, { status: 502 }, config), true);
      });

      it("returns true for 503 status", () => {
        assert.strictEqual(retryMod.isRetryable(null, { status: 503 }, config), true);
      });

      it("returns true for 504 status", () => {
        assert.strictEqual(retryMod.isRetryable(null, { status: 504 }, config), true);
      });

      it("returns false for 400 status", () => {
        assert.strictEqual(retryMod.isRetryable(null, { status: 400 }, config), false);
      });

      it("returns false for 401 status", () => {
        assert.strictEqual(retryMod.isRetryable(null, { status: 401 }, config), false);
      });

      it("returns false for 200 status", () => {
        assert.strictEqual(retryMod.isRetryable(null, { status: 200 }, config), false);
      });

      it("returns true for ECONNRESET error", () => {
        const err = new Error("x"); err.code = "ECONNRESET";
        assert.strictEqual(retryMod.isRetryable(err, null, config), true);
      });

      it("returns true for ETIMEDOUT error", () => {
        const err = new Error("x"); err.code = "ETIMEDOUT";
        assert.strictEqual(retryMod.isRetryable(err, null, config), true);
      });

      it("returns true for ENOTFOUND error", () => {
        const err = new Error("x"); err.code = "ENOTFOUND";
        assert.strictEqual(retryMod.isRetryable(err, null, config), true);
      });

      it("returns true for ENETUNREACH error", () => {
        const err = new Error("x"); err.code = "ENETUNREACH";
        assert.strictEqual(retryMod.isRetryable(err, null, config), true);
      });

      it("returns true for ECONNREFUSED error", () => {
        const err = new Error("x"); err.code = "ECONNREFUSED";
        assert.strictEqual(retryMod.isRetryable(err, null, config), true);
      });

      it("returns true for nested cause with retryable code", () => {
        const cause = new Error("inner"); cause.code = "ECONNRESET";
        const err = new TypeError("fetch failed"); err.cause = cause;
        assert.strictEqual(retryMod.isRetryable(err, null, config), true);
      });

      it("returns true for FetchError", () => {
        const err = new Error("x"); err.name = "FetchError";
        assert.strictEqual(retryMod.isRetryable(err, null, config), true);
      });

      it("returns true for AbortError", () => {
        const err = new Error("x"); err.name = "AbortError";
        assert.strictEqual(retryMod.isRetryable(err, null, config), true);
      });

      it("returns false for generic error without retryable code", () => {
        const err = new Error("generic");
        assert.strictEqual(retryMod.isRetryable(err, null, config), false);
      });

      it("returns false for null error and null response", () => {
        assert.strictEqual(retryMod.isRetryable(null, null, config), false);
      });
    });

    describe("detectColdStart", () => {
      it("returns true when duration exceeds threshold", () => {
        assert.strictEqual(retryMod.detectColdStart(0, 6000), true);
      });

      it("returns false when duration is under threshold", () => {
        assert.strictEqual(retryMod.detectColdStart(0, 3000), false);
      });

      it("returns false when duration exactly equals threshold", () => {
        assert.strictEqual(retryMod.detectColdStart(0, 5000), false);
      });

      it("uses custom threshold", () => {
        assert.strictEqual(retryMod.detectColdStart(0, 2000, 1000), true);
        assert.strictEqual(retryMod.detectColdStart(0, 500, 1000), false);
      });
    });

    describe("createRetryWrapper", () => {
      it("wraps a function with retry logic", async () => {
        let callCount = 0;
        const fn = async (x) => {
          callCount++;
          return x * 2;
        };
        const wrapped = retryMod.createRetryWrapper(fn, { maxRetries: 3, initialDelay: 10 });
        const result = await wrapped(5);
        assert.strictEqual(result, 10);
        assert.strictEqual(callCount, 1);
      });

      it("passes all arguments to the wrapped function", async () => {
        const fn = async (a, b, c) => `${a}-${b}-${c}`;
        const wrapped = retryMod.createRetryWrapper(fn, { maxRetries: 1, initialDelay: 10 });
        const result = await wrapped("x", "y", "z");
        assert.strictEqual(result, "x-y-z");
      });
    });
  });

  // =========================================================================
  // createBulkhead
  // =========================================================================
  describe("createBulkhead", () => {
    it("limits concurrent execution", async () => {
      const bh = createBulkhead({ maxConcurrent: 2, maxQueue: 2 });
      let concurrent = 0;
      let maxConcurrent = 0;

      const task = () =>
        bh.execute(async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 50));
          concurrent--;
          return "done";
        });

      const results = await Promise.all([task(), task(), task(), task()]);

      assert.strictEqual(results.every((r) => r === "done"), true);
      assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <= 2`);
    });

    it("rejects when queue is full", async () => {
      const bh = createBulkhead({ maxConcurrent: 1, maxQueue: 1 });

      const slowTask = () =>
        bh.execute(() => new Promise((r) => setTimeout(r, 200)));

      // 1 executing + 1 queued = full → 3rd should reject
      const p1 = slowTask();
      const p2 = slowTask();

      // Small delay to let tasks settle into execute+queue
      await new Promise((r) => setTimeout(r, 10));

      try {
        await slowTask();
        assert.fail("Should have rejected");
      } catch (err) {
        assert.ok(
          err instanceof BulkheadRejectedError || err.message.includes("bulkhead"),
          `Expected BulkheadRejectedError, got: ${err.constructor.name}: ${err.message}`
        );
      }

      // Cleanup
      await Promise.allSettled([p1, p2]);
    });

    it("uses default options (maxConcurrent: 2, maxQueue: 50)", () => {
      // Should not throw
      const bh = createBulkhead();
      assert.ok(bh);
      assert.ok(typeof bh.execute === "function");
    });

    it("queued tasks execute after prior tasks complete", async () => {
      const bh = createBulkhead({ maxConcurrent: 1, maxQueue: 10 });
      const order = [];

      const task = (id, delay) =>
        bh.execute(async () => {
          order.push(`start-${id}`);
          await new Promise((r) => setTimeout(r, delay));
          order.push(`end-${id}`);
          return id;
        });

      const results = await Promise.all([task("a", 30), task("b", 20), task("c", 10)]);

      assert.deepStrictEqual(results, ["a", "b", "c"]);
      // With maxConcurrent: 1, tasks run sequentially
      assert.strictEqual(order[0], "start-a");
      assert.strictEqual(order[1], "end-a");
      assert.strictEqual(order[2], "start-b");
      assert.strictEqual(order[3], "end-b");
      assert.strictEqual(order[4], "start-c");
      assert.strictEqual(order[5], "end-c");
    });

    it("propagates errors from executed functions", async () => {
      const bh = createBulkhead({ maxConcurrent: 2, maxQueue: 5 });

      try {
        await bh.execute(() => { throw new Error("task-error"); });
        assert.fail("Should have thrown");
      } catch (err) {
        assert.strictEqual(err.message, "task-error");
      }
    });
  });

  // =========================================================================
  // createProviderPolicy (composed: retry + circuit breaker + timeout)
  // =========================================================================
  describe("createProviderPolicy", () => {
    it("executes successfully", async () => {
      const policy = createProviderPolicy("test-provider", {
        failureThreshold: 3,
        halfOpenAfter: 100,
        retryMaxAttempts: 2,
        timeout: 5000,
      });

      const result = await policy.execute(() => Promise.resolve("success"));
      assert.strictEqual(result, "success");
    });

    it("retries transient failures and succeeds", async () => {
      const policy = createProviderPolicy("test-provider", {
        failureThreshold: 5,
        halfOpenAfter: 100,
        retryMaxAttempts: 3,
        timeout: 5000,
      });

      let callCount = 0;
      const result = await policy.execute(() => {
        callCount++;
        if (callCount < 3) throw new Error("transient");
        return "recovered";
      });

      assert.strictEqual(result, "recovered");
      assert.ok(callCount >= 3);
    });

    it("times out long-running tasks", async () => {
      const policy = createProviderPolicy("test-provider", {
        failureThreshold: 5,
        halfOpenAfter: 100,
        retryMaxAttempts: 1,
        timeout: 50, // 50ms timeout
      });

      try {
        await policy.execute(
          () => new Promise((resolve) => setTimeout(() => resolve("too late"), 500))
        );
        assert.fail("Should have thrown a timeout error");
      } catch (err) {
        assert.ok(
          err instanceof TaskCancelledError || err.message.includes("cancel") || err.message.includes("timeout") || err.name === "TaskCancelledError",
          `Expected timeout-related error, got: ${err.constructor.name}: ${err.message}`
        );
      }
    });

    it("uses default options when none provided", () => {
      const policy = createProviderPolicy("default-test");
      assert.ok(policy);
      assert.ok(typeof policy.execute === "function");
    });
  });

  // =========================================================================
  // STATE constant
  // =========================================================================
  describe("STATE constant", () => {
    it("has CLOSED, OPEN, HALF_OPEN", () => {
      assert.strictEqual(STATE.CLOSED, "CLOSED");
      assert.strictEqual(STATE.OPEN, "OPEN");
      assert.strictEqual(STATE.HALF_OPEN, "HALF_OPEN");
    });

    it("has exactly 3 keys", () => {
      assert.strictEqual(Object.keys(STATE).length, 3);
    });
  });
});
