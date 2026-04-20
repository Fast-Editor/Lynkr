#!/usr/bin/env node

/**
 * Native Rust vs JavaScript Performance Benchmark
 *
 * Compares the Rust Napi-RS implementations against the JavaScript
 * equivalents for the 5 hot-path functions.
 *
 * Run: node test/native-benchmark.js
 */

const { performance } = require('perf_hooks');

// ── Load both implementations ───────────────────────────────────────

const native = require('../native');
const { structuralSimilarity: jsSimilarity, normalizeText: jsNormalize } = require('../src/context/distill');
const { estimateContentSize: jsEstimateSize } = require('../src/utils/payload');

if (!native.available) {
  console.error('Native module not available. Build it first: cd native && cargo build --release');
  process.exit(1);
}

// ── Benchmark utility ───────────────────────────────────────────────

function bench(name, iterations, fn) {
  // Warmup
  for (let i = 0; i < Math.min(iterations / 10, 1000); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  return {
    name,
    iterations,
    totalMs: elapsed,
    avgUs: (elapsed / iterations) * 1000, // microseconds
    opsPerSec: Math.round((iterations / elapsed) * 1000),
  };
}

function compare(label, jsResult, rustResult) {
  const speedup = jsResult.avgUs / rustResult.avgUs;
  const faster = speedup > 1 ? 'Rust' : 'JS';
  const ratio = speedup > 1 ? speedup : 1 / speedup;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  JS:   ${jsResult.avgUs.toFixed(2)} us/op  (${jsResult.opsPerSec.toLocaleString()} ops/sec)`);
  console.log(`  Rust: ${rustResult.avgUs.toFixed(2)} us/op  (${rustResult.opsPerSec.toLocaleString()} ops/sec)`);
  console.log(`  Winner: ${faster} is ${ratio.toFixed(1)}x faster`);
  return { label, jsUs: jsResult.avgUs, rustUs: rustResult.avgUs, speedup, faster };
}

// ── Test data ───────────────────────────────────────────────────────

const SIMPLE_CONTENT = 'hello world';
const COMPLEX_CONTENT = 'refactor the entire authentication module to use OAuth 2.0 with PKCE flow, implement rate limiting, add database migrations for the new user sessions table, and write comprehensive security tests with step-by-step analysis of edge cases';
const LONG_CONTENT = 'x'.repeat(10000) + ' security audit of the distributed microservices architecture with concurrent processing';

const SMALL_PAYLOAD = JSON.stringify({
  model: 'claude-3',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [{ name: 'Read' }],
});

const LARGE_PAYLOAD = JSON.stringify({
  model: 'claude-3',
  messages: Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}: ${'lorem ipsum '.repeat(100)}`,
  })),
  tools: Array.from({ length: 30 }, (_, i) => ({
    name: `Tool_${i}`,
    description: `Description for tool ${i}`,
    input_schema: { type: 'object', properties: { arg: { type: 'string' } } },
  })),
});

const TEXT_A = Array.from({ length: 100 }, (_, i) => `line ${i}: some content here`).join('\n');
const TEXT_B = Array.from({ length: 100 }, (_, i) => `line ${i}: ${i < 80 ? 'some content here' : 'different content'}`).join('\n');

const ANSI_TEXT = '\x1B[31mError:\x1B[0m something went wrong\r\n\r\n\r\n   multiple   spaces   \t\ttabs\r\nend';

// ── Run benchmarks ──────────────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('  LYNKR NATIVE BENCHMARK — Rust (Napi-RS) vs JavaScript');
console.log('='.repeat(70));

const results = [];
const N = 50000;

// 1. Complexity Analysis — Simple
results.push(compare(
  '1a. Complexity Analysis (simple: "hello world")',
  bench('JS', N, () => {
    // Simulate JS regex matching
    const content = SIMPLE_CONTENT;
    /^(hi|hello|hey|thanks?|bye)\s*[.!?]*$/i.test(content);
    /^(yes|no|ok)\s*[.!?]*$/i.test(content);
    /\b(function|class|module|import)\b/i.test(content);
  }),
  bench('Rust', N, () => {
    native.analyzeComplexityNative(SIMPLE_CONTENT, 50, 0);
  })
));

// 1b. Complexity Analysis — Complex
results.push(compare(
  '1b. Complexity Analysis (complex: 250 chars, 8 tools)',
  bench('JS', N, () => {
    const content = COMPLEX_CONTENT;
    /^(hi|hello|hey)\s*$/i.test(content);
    /\b(refactor|restructure)\b/i.test(content);
    /\b(security|audit)\b/i.test(content);
    /\b(architect|design)\b/i.test(content);
    /\b(concurrent|parallel)\b/i.test(content);
    /\b(database|sql|migration)\b/i.test(content);
    /\b(step.?by.?step|analyz)\b/i.test(content);
    /\b(all files|entire|codebase)\b/i.test(content);
  }),
  bench('Rust', N, () => {
    native.analyzeComplexityNative(COMPLEX_CONTENT, 5000, 8);
  })
));

// 1c. Complexity Analysis — Long content
results.push(compare(
  '1c. Complexity Analysis (long: 10K chars)',
  bench('JS', N / 5, () => {
    const content = LONG_CONTENT;
    /^(hi|hello|hey)\s*$/i.test(content);
    /\b(refactor|restructure)\b/i.test(content);
    /\b(security|audit)\b/i.test(content);
    /\b(architect|design)\b/i.test(content);
    /\b(concurrent|parallel)\b/i.test(content);
    /\b(database|sql|migration)\b/i.test(content);
    /\b(step.?by.?step|analyz)\b/i.test(content);
    /\b(all files|entire|codebase)\b/i.test(content);
  }),
  bench('Rust', N / 5, () => {
    native.analyzeComplexityNative(LONG_CONTENT, 10000, 15);
  })
));

// 2. Cache Key Computation
results.push(compare(
  '2a. Cache Key (small payload)',
  bench('JS', N, () => {
    const obj = JSON.parse(SMALL_PAYLOAD);
    const sorted = JSON.stringify(obj, Object.keys(obj).sort());
    const crypto = require('crypto');
    crypto.createHash('sha256').update(sorted).digest('hex');
  }),
  bench('Rust', N, () => {
    native.computeCacheKey(SMALL_PAYLOAD);
  })
));

results.push(compare(
  '2b. Cache Key (large payload: 50 messages, 30 tools)',
  bench('JS', N / 10, () => {
    const obj = JSON.parse(LARGE_PAYLOAD);
    const sorted = JSON.stringify(obj, Object.keys(obj).sort());
    const crypto = require('crypto');
    crypto.createHash('sha256').update(sorted).digest('hex');
  }),
  bench('Rust', N / 10, () => {
    native.computeCacheKey(LARGE_PAYLOAD);
  })
));

// 3. Structural Similarity
results.push(compare(
  '3. Structural Similarity (100 lines, 80% overlap)',
  bench('JS', N, () => {
    jsSimilarity(TEXT_A, TEXT_B);
  }),
  bench('Rust', N, () => {
    native.structuralSimilarity(TEXT_A, TEXT_B);
  })
));

// 4. Text Normalization
results.push(compare(
  '4. Text Normalization (ANSI + whitespace)',
  bench('JS', N, () => {
    jsNormalize(ANSI_TEXT);
  }),
  bench('Rust', N, () => {
    native.normalizeText(ANSI_TEXT);
  })
));

// 5. Payload Size Estimation
results.push(compare(
  '5. Payload Size Estimation (large payload)',
  bench('JS', N, () => {
    jsEstimateSize(JSON.parse(LARGE_PAYLOAD));
  }),
  bench('Rust', N / 5, () => {
    native.estimatePayloadSize(LARGE_PAYLOAD);
  })
));

// ── Summary ─────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('  SUMMARY');
console.log('='.repeat(70));
console.log(`${'Benchmark'.padEnd(55)} ${'Speedup'.padStart(10)}`);
console.log('-'.repeat(70));

let totalJsUs = 0;
let totalRustUs = 0;

for (const r of results) {
  totalJsUs += r.jsUs;
  totalRustUs += r.rustUs;
  const speedStr = r.faster === 'Rust'
    ? `${r.speedup.toFixed(1)}x faster`
    : `${(1/r.speedup).toFixed(1)}x slower`;
  console.log(`${r.label.padEnd(55)} ${speedStr.padStart(15)}`);
}

console.log('-'.repeat(70));
const overallSpeedup = totalJsUs / totalRustUs;
console.log(`${'OVERALL'.padEnd(55)} ${overallSpeedup.toFixed(1)}x faster`.padStart(15));
console.log(`\nJS total:   ${totalJsUs.toFixed(1)} us per iteration`);
console.log(`Rust total: ${totalRustUs.toFixed(1)} us per iteration`);
console.log(`Saved:      ${(totalJsUs - totalRustUs).toFixed(1)} us per request`);
console.log('');
