#!/usr/bin/env node
/**
 * RouterArena evaluation harness (Phase 6.4 — STUB).
 *
 * This is intentionally not wired to CI yet. The plan defers RouterArena
 * integration until after Phases 1-4 have produced 2-4 weeks of telemetry
 * to baseline against.
 *
 * To wire it up:
 *   1. Clone https://github.com/RouteWorks/RouterArena into ./routerarena/
 *   2. Install RouterArena's Python dependencies (transformers, datasets,
 *      anthropic, openai)
 *   3. Decide on a subset size for PR-blocking CI (recommend 100-200 queries
 *      sampled stratified by difficulty); leave the full benchmark for nightly
 *   4. Wire to GitHub Actions with `paths: [src/routing/**]` trigger
 *   5. Compare PR's router decisions vs main's router on the same query set,
 *      report cost/quality delta as a PR comment
 *
 * The intent is to use RouterArena to *catch regressions*, not to gate
 * routing changes on absolute benchmark scores.
 */

console.log('RouterArena integration is a stub.');
console.log('See scripts/run-routerarena.js for setup steps.');
console.log('Phase 6.4 of docs/routing-improvement-plan.md.');
process.exit(0);
