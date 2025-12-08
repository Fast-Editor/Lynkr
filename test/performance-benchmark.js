/**
 * Comprehensive Performance Benchmark
 *
 * Measures performance impact of all production hardening features:
 * - Option 1: Retries, budgets, rate limits, path allowlisting, sandboxing, safe commands
 * - Option 2 & 3: Metrics, health checks, logging, error handling, validation, load shedding, circuit breakers
 *
 * Key Metrics:
 * - Request throughput (req/s)
 * - Latency (p50, p95, p99)
 * - Memory usage
 * - CPU usage
 * - Overhead per middleware
 */

const { performance } = require("perf_hooks");
const { MetricsCollector } = require("../src/observability/metrics");
const { LoadShedder } = require("../src/api/middleware/load-shedding");
const { CircuitBreaker } = require("../src/clients/circuit-breaker");
const { validateObject } = require("../src/api/middleware/validation");

// Color utilities
function colorize(text, color) {
  const colors = {
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    reset: "\x1b[0m",
  };
  return `${colors[color] || ""}${text}${colors.reset}`;
}

// =============================================================================
// Benchmark Utilities
// =============================================================================

async function benchmark(name, iterations, fn) {
  console.log(colorize(`\n📊 ${name}`, "cyan"));
  console.log(`   Iterations: ${iterations.toLocaleString()}`);

  // Warmup
  for (let i = 0; i < Math.min(iterations / 10, 1000); i++) {
    await fn();
  }

  // Force GC if available
  if (global.gc) {
    global.gc();
  }

  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const startTime = performance.now();

  // Run benchmark
  for (let i = 0; i < iterations; i++) {
    await fn();
  }

  const endTime = performance.now();
  const cpuAfter = process.cpuUsage();
  const memAfter = process.memoryUsage();

  // Calculate metrics
  const totalTime = endTime - startTime;
  const avgTime = totalTime / iterations;
  const throughput = (iterations / totalTime) * 1000; // ops/sec

  const cpuUser = (cpuAfter.user - cpuBefore.user) / 1000; // ms
  const cpuSystem = (cpuAfter.system - cpuBefore.system) / 1000; // ms
  const cpuTotal = cpuUser + cpuSystem;

  const memUsed = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024; // MB

  // Results
  console.log(`   ${colorize("Duration:", "blue")} ${totalTime.toFixed(2)}ms`);
  console.log(`   ${colorize("Avg/op:", "blue")} ${avgTime.toFixed(4)}ms`);
  console.log(`   ${colorize("Throughput:", "green")} ${throughput.toLocaleString("en-US", { maximumFractionDigits: 0 })} ops/sec`);
  console.log(`   ${colorize("CPU:", "yellow")} ${cpuTotal.toFixed(2)}ms (user: ${cpuUser.toFixed(2)}ms, system: ${cpuSystem.toFixed(2)}ms)`);
  console.log(`   ${colorize("Memory:", "yellow")} ${memUsed >= 0 ? "+" : ""}${memUsed.toFixed(2)}MB`);

  return {
    name,
    iterations,
    totalTime,
    avgTime,
    throughput,
    cpu: {
      user: cpuUser,
      system: cpuSystem,
      total: cpuTotal,
    },
    memory: memUsed,
  };
}

// =============================================================================
// Benchmarks
// =============================================================================

async function runBenchmarks() {
  console.log(colorize("\n╔═══════════════════════════════════════════════════╗", "blue"));
  console.log(colorize("║         Performance Benchmark Suite              ║", "blue"));
  console.log(colorize("╚═══════════════════════════════════════════════════╝", "blue"));

  const results = [];

  // Baseline: No-op function
  results.push(
    await benchmark("Baseline (no-op)", 1000000, async () => {
      return true;
    })
  );

  // Metrics Collection
  results.push(
    await benchmark("Metrics Collection", 100000, async () => {
      const metrics = new MetricsCollector();
      metrics.recordRequest("GET", "/test", 200, 100);
      metrics.recordTokens(100, 50);
      metrics.recordCost(0.01);
    })
  );

  // Metrics Snapshot (lazy calculation)
  results.push(
    await benchmark("Metrics Snapshot", 10000, async () => {
      const metrics = new MetricsCollector();
      for (let i = 0; i < 100; i++) {
        metrics.recordRequest("GET", "/test", 200, Math.random() * 200);
      }
      metrics.getMetrics();
    })
  );

  // Prometheus Export
  results.push(
    await benchmark("Prometheus Export", 10000, async () => {
      const metrics = new MetricsCollector();
      for (let i = 0; i < 100; i++) {
        metrics.recordRequest("GET", "/test", 200, Math.random() * 200);
      }
      metrics.toPrometheus();
    })
  );

  // Load Shedding Check (not overloaded)
  results.push(
    await benchmark("Load Shedding Check", 100000, async () => {
      const shedder = new LoadShedder();
      shedder.isOverloaded();
    })
  );

  // Circuit Breaker (closed state)
  results.push(
    await benchmark("Circuit Breaker (closed)", 100000, async () => {
      const breaker = new CircuitBreaker("test");
      await breaker.execute(async () => "success");
    })
  );

  // Input Validation (simple)
  results.push(
    await benchmark("Input Validation (simple)", 100000, async () => {
      const schema = {
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
        },
      };
      validateObject({ name: "test" }, schema);
    })
  );

  // Input Validation (complex)
  results.push(
    await benchmark("Input Validation (complex)", 10000, async () => {
      const schema = {
        required: ["model", "messages"],
        properties: {
          model: { type: "string", minLength: 1 },
          messages: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["role", "content"],
              properties: {
                role: { type: "string", enum: ["user", "assistant", "system"] },
                content: { type: "string", minLength: 1 },
              },
            },
          },
          temperature: { type: "number", minimum: 0, maximum: 2 },
        },
      };

      validateObject(
        {
          model: "test-model",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there" },
          ],
          temperature: 0.7,
        },
        schema
      );
    })
  );

  // Request ID Generation
  results.push(
    await benchmark("Request ID Generation", 100000, async () => {
      const crypto = require("crypto");
      crypto.randomBytes(16).toString("hex");
    })
  );

  // Combined middleware stack simulation
  results.push(
    await benchmark("Combined Middleware Stack", 10000, async () => {
      // Simulate request flowing through all middleware
      const requestId = require("crypto").randomBytes(16).toString("hex");

      const metrics = new MetricsCollector();
      const shedder = new LoadShedder();

      // Load shedding check
      if (!shedder.isOverloaded()) {
        // Metrics collection
        const start = performance.now();
        metrics.recordRequest("POST", "/v1/messages", 200, 0);

        // Validation
        const schema = {
          required: ["model"],
          properties: {
            model: { type: "string" },
          },
        };
        validateObject({ model: "test" }, schema);

        // Record latency
        const latency = performance.now() - start;
        metrics.recordRequest("POST", "/v1/messages", 200, latency);
      }
    })
  );

  // =============================================================================
  // Summary
  // =============================================================================

  console.log(colorize("\n╔═══════════════════════════════════════════════════╗", "blue"));
  console.log(colorize("║              Performance Summary                  ║", "blue"));
  console.log(colorize("╚═══════════════════════════════════════════════════╝", "blue"));

  const baseline = results[0];

  console.log(colorize("\n📈 Throughput Comparison", "cyan"));
  console.log(colorize("─".repeat(80), "blue"));
  console.log(
    `${"Benchmark".padEnd(40)} ${"Throughput".padEnd(20)} ${"Overhead".padEnd(20)}`
  );
  console.log(colorize("─".repeat(80), "blue"));

  for (const result of results) {
    const overhead =
      result.name === baseline.name
        ? "-"
        : `${((baseline.throughput / result.throughput - 1) * 100).toFixed(1)}%`;

    const throughputStr = `${result.throughput.toLocaleString("en-US", { maximumFractionDigits: 0 })} ops/s`;

    console.log(`${result.name.padEnd(40)} ${throughputStr.padEnd(20)} ${overhead.padEnd(20)}`);
  }

  console.log(colorize("\n⏱️  Latency Comparison", "cyan"));
  console.log(colorize("─".repeat(80), "blue"));
  console.log(
    `${"Benchmark".padEnd(40)} ${"Avg Latency".padEnd(20)} ${"vs Baseline".padEnd(20)}`
  );
  console.log(colorize("─".repeat(80), "blue"));

  for (const result of results) {
    const vsBaseline =
      result.name === baseline.name
        ? "-"
        : `+${(result.avgTime - baseline.avgTime).toFixed(4)}ms`;

    console.log(
      `${result.name.padEnd(40)} ${result.avgTime.toFixed(4)}ms${"".padEnd(12)} ${vsBaseline.padEnd(20)}`
    );
  }

  console.log(colorize("\n💾 Memory Impact", "cyan"));
  console.log(colorize("─".repeat(60), "blue"));
  for (const result of results) {
    const memStr = result.memory >= 0 ? `+${result.memory.toFixed(2)}MB` : `${result.memory.toFixed(2)}MB`;
    console.log(`${result.name.padEnd(40)} ${memStr}`);
  }

  console.log(colorize("\n🔥 Key Insights", "yellow"));
  console.log(colorize("─".repeat(60), "blue"));

  const metricsResult = results.find((r) => r.name === "Metrics Collection");
  const stackResult = results.find((r) => r.name === "Combined Middleware Stack");

  console.log(
    `✓ Metrics collection: ${colorize(metricsResult.throughput.toLocaleString() + " ops/sec", "green")} (${((baseline.throughput / metricsResult.throughput - 1) * 100).toFixed(1)}% overhead)`
  );
  console.log(
    `✓ Full middleware stack: ${colorize(stackResult.throughput.toLocaleString() + " ops/sec", "green")} (${((baseline.throughput / stackResult.throughput - 1) * 100).toFixed(1)}% overhead)`
  );
  console.log(
    `✓ Average latency added: ${colorize((stackResult.avgTime - baseline.avgTime).toFixed(4) + "ms", "cyan")}`
  );

  // Performance rating
  const totalOverhead = ((baseline.throughput / stackResult.throughput - 1) * 100);
  let rating, color;
  if (totalOverhead < 5) {
    rating = "EXCELLENT";
    color = "green";
  } else if (totalOverhead < 15) {
    rating = "GOOD";
    color = "green";
  } else if (totalOverhead < 30) {
    rating = "ACCEPTABLE";
    color = "yellow";
  } else {
    rating = "NEEDS OPTIMIZATION";
    color = "red";
  }

  console.log(
    `\n🏆 Overall Performance Rating: ${colorize(rating, color)} (${totalOverhead.toFixed(1)}% total overhead)`
  );

  console.log(colorize("\n" + "=".repeat(60), "blue"));
}

// Run benchmarks
runBenchmarks().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
