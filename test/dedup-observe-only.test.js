/**
 * Observe-only loop counter — design tripwire.
 *
 * Deliberate decision (2026-09): the proxy meters and reports; it never
 * judges behavior into the conversation. The dedup counter must never
 * regain its two former enforcement mechanisms:
 *
 *   1. injecting a "[Lynkr loop guard]" message into payload.messages
 *   2. force-terminating a turn with a synthetic assistant response
 *
 * Both were removed after a live incident (884k-token opencode session)
 * where similarity false-positives repeatedly killed legitimate work.
 * Runaway-spend protection lives at the protocol layer instead: TPM limits,
 * budgets, and the loop-guard middleware's turn caps — all honest 429/402s.
 *
 * These are source-level assertions by design: the behavior being pinned is
 * the ABSENCE of an intervention, which no black-box fixture can prove
 * cheaply. If enforcement is ever deliberately reintroduced, this test is
 * the checkpoint forcing that to be a conscious, reviewed decision.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const orchestratorSource = fs.readFileSync(
  path.join(__dirname, '../src/orchestrator/index.js'),
  'utf8'
);

test('dedup counter never injects messages into the conversation', () => {
  assert.ok(
    !orchestratorSource.includes('[Lynkr loop guard]'),
    'found the injected loop-guard message marker — the dedup counter must stay observe-only'
  );
  // The old injection pushed a synthetic user message inside the dedup
  // block. No push into payload.messages may reference the dedup tracker.
  const dedupBlock = orchestratorSource.slice(
    orchestratorSource.indexOf('recordCrossRequestToolCall(session, toolUseBlock)'),
    orchestratorSource.indexOf('const { createTimer } = require("../utils/perf-timer")')
  );
  assert.ok(
    !/payload\.messages\.push/.test(dedupBlock),
    'dedup block mutates payload.messages — the counter must not ghostwrite into the conversation'
  );
});

test('dedup counter never force-terminates a turn', () => {
  assert.ok(
    !orchestratorSource.includes('FORCE TERMINATING'),
    'found dedup force-termination — removed by design; protocol-level caps own hard stops'
  );
  const dedupBlock = orchestratorSource.slice(
    orchestratorSource.indexOf('recordCrossRequestToolCall(session, toolUseBlock)'),
    orchestratorSource.indexOf('const { createTimer } = require("../utils/perf-timer")')
  );
  assert.ok(
    !/terminationReason/.test(dedupBlock),
    'dedup block returns a termination — the counter must stay observe-only'
  );
});

test('the observe signal itself is still present (removal of enforcement must not remove observability)', () => {
  assert.ok(
    orchestratorSource.includes('observe-only'),
    'observe-only design note missing from the dedup block'
  );
  assert.ok(
    /recordLoopGuard\('observed'\)/.test(orchestratorSource),
    'metrics signal for observed loops missing — count must survive even though enforcement is gone'
  );
});
