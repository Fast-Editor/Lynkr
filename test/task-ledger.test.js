const assert = require('assert');
const crypto = require('crypto');
const { describe, it, beforeEach } = require('node:test');

const ledgerMod = require('../src/routing/task-ledger');
const {
  deriveTaskLedger,
  detectContinuation,
  buildTaskContext,
  buildJevSignals,
  CONSTANTS,
  _clearMemo,
} = ledgerMod;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content });

describe('constants', () => {
  it('exports the hardcoded knob set (no env vars)', () => {
    assert.strictEqual(CONSTANTS.COSINE_CUT, 0.70);
    assert.strictEqual(CONSTANTS.EMBED_BUDGET_MS, 100);
    assert.strictEqual(CONSTANTS.VETO_MAX_CHARS, 400);
    assert.strictEqual(CONSTANTS.DEICTIC_MAX_CHARS, 200);
    assert.strictEqual(CONSTANTS.DECAY_TURNS, 2);
    assert.strictEqual(CONSTANTS.AUTO_CLOSE_LOW_TURNS, 3);
    assert.strictEqual(CONSTANTS.MAX_CONTEXT, 360);
    assert.strictEqual(CONSTANTS.ANCHOR_MAX, 160);
    assert.strictEqual(CONSTANTS.LAST_MAX, 120);
    assert.strictEqual(CONSTANTS.FLOOR_ENABLED, true);
    assert.strictEqual(CONSTANTS.HOLDOUT_PCT, 0.10);
    // Router destructures these off the module directly.
    assert.strictEqual(ledgerMod.FLOOR_ENABLED, true);
    assert.strictEqual(ledgerMod.DECAY_TURNS, 2);
    assert.strictEqual(ledgerMod.HOLDOUT_PCT, 0.10);
  });
});

describe('deriveTaskLedger', () => {
  beforeEach(() => _clearMemo());

  it('null on empty, non-array, or ask-free input', () => {
    assert.strictEqual(deriveTaskLedger([]), null);
    assert.strictEqual(deriveTaskLedger(null), null);
    assert.strictEqual(deriveTaskLedger([assistant('hello'), user([{ type: 'tool_result', tool_use_id: '1', content: 'x' }])]), null);
  });

  it('single ask anchors the task', () => {
    const l = deriveTaskLedger([user('refactor the parser in src/parser.js')]);
    assert.strictEqual(l.anchorText, 'refactor the parser in src/parser.js');
    assert.strictEqual(l.anchorHash, sha256(l.anchorText));
    assert.strictEqual(l.lastAsk, l.anchorText);
    assert.strictEqual(l.open, true);
    assert.strictEqual(l.turnsSinceClose, 0);
    assert.strictEqual(l.askCount, 1);
    assert.ok(l.tokenSet.has('refactor'));
    assert.ok(l.fileSet.has('src/parser.js'));
    assert.strictEqual(typeof l.prefixHash, 'string');
  });

  it('accumulates asks into the open task (tokens + files, askCount)', () => {
    const l = deriveTaskLedger([
      user('refactor the parser in src/parser.js'),
      assistant('done'),
      user('add coverage for lexer.ts edge cases'),
    ]);
    assert.strictEqual(l.askCount, 2);
    assert.strictEqual(l.anchorText, 'refactor the parser in src/parser.js');
    assert.strictEqual(l.lastAsk, 'add coverage for lexer.ts edge cases');
    assert.ok(l.tokenSet.has('coverage'));
    assert.ok(l.fileSet.has('src/parser.js'));
    assert.ok(l.fileSet.has('lexer.ts'));
  });

  it('never mines tool_use inputs for files', () => {
    const l = deriveTaskLedger([
      user('refactor the parser'),
      assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'secrets/vault.sql' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'stuff about hidden.py' }]),
    ]);
    assert.strictEqual(l.fileSet.size, 0);
  });

  it('marker-only turn closes the task, keeps the anchor', () => {
    const l = deriveTaskLedger([
      user('refactor the parser in src/parser.js'),
      assistant('done'),
      user('thanks'),
    ]);
    assert.strictEqual(l.open, false);
    assert.strictEqual(l.turnsSinceClose, 0);
    assert.strictEqual(l.anchorText, 'refactor the parser in src/parser.js');
    assert.ok(l.fileSet.has('src/parser.js'));
  });

  it('asks after a close increment turnsSinceClose (marker-only turns)', () => {
    const l = deriveTaskLedger([
      user('refactor the parser'),
      user('thanks'),
      user('perfect'),
    ]);
    assert.strictEqual(l.open, false);
    assert.strictEqual(l.turnsSinceClose, 1);
  });

  it('a gratitude marker with a contrast token does NOT close', () => {
    const l = deriveTaskLedger([
      user('refactor the parser'),
      user('thanks but it still fails'),
    ]);
    assert.strictEqual(l.open, true);
    assert.strictEqual(l.askCount, 2);
  });

  it('marker + substantive content closes AND opens in one fold step', () => {
    const msg = 'thanks — now migrate the config loader to yaml in loader.py';
    const l = deriveTaskLedger([
      user('refactor the parser in src/parser.js'),
      user(msg),
    ]);
    assert.strictEqual(l.open, true);
    assert.strictEqual(l.anchorText, msg);
    assert.strictEqual(l.anchorHash, sha256(msg));
    assert.strictEqual(l.askCount, 1);
    assert.ok(l.fileSet.has('loader.py'));
    assert.ok(!l.fileSet.has('src/parser.js'));
  });

  it('marker + substantive content under 30 chars still closes AND opens', () => {
    const msg = 'thanks, now fix router.js'; // 25 chars — short redirect
    const l = deriveTaskLedger([
      user('refactor the auth middleware in auth.js'),
      assistant('done'),
      user(msg),
      assistant('ok'),
    ]);
    assert.strictEqual(l.open, true);
    assert.strictEqual(l.anchorText, msg);
    assert.strictEqual(l.anchorHash, sha256(msg));
    assert.ok(l.fileSet.has('router.js'));
    assert.ok(!l.fileSet.has('auth.js'));
  });

  it('pure gratitude with trailing punctuation stays close-only', () => {
    const l = deriveTaskLedger([
      user('refactor the parser in src/parser.js'),
      assistant('done'),
      user('thanks!!'),
    ]);
    assert.strictEqual(l.open, false);
    assert.strictEqual(l.anchorText, 'refactor the parser in src/parser.js');
  });

  it('after a close, the next substantive ask opens a new task', () => {
    const l = deriveTaskLedger([
      user('refactor the parser in src/parser.js'),
      user('thanks'),
      user('write a benchmark harness for the tokenizer'),
    ]);
    assert.strictEqual(l.open, true);
    assert.strictEqual(l.anchorText, 'write a benchmark harness for the tokenizer');
    assert.strictEqual(l.askCount, 1);
    assert.ok(!l.fileSet.has('src/parser.js'));
  });

  it('lastTurnStats counts tool_use and is_error after the last ask', () => {
    const l = deriveTaskLedger([
      user('refactor the parser'),
      assistant([
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
      ]),
      user([
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
      ]),
      assistant('fixed'),
    ]);
    assert.deepStrictEqual(l.lastTurnStats, { toolCalls: 2, errors: 1 });
  });

  it('prefix memo reuse matches a cold fold, and returned sets are copies', () => {
    const msgs = [
      user('refactor the parser in src/parser.js'),
      assistant('done'),
      user('add coverage for lexer.ts edge cases'),
      user('thanks'),
      user('now design the plugin registry'),
    ];
    // Warm the memo the way the orchestrator does: growing prefixes.
    for (let i = 1; i <= msgs.length; i++) deriveTaskLedger(msgs.slice(0, i));
    const warm = deriveTaskLedger(msgs);
    warm.tokenSet.add('poison');
    warm.fileSet.add('poison.js');
    _clearMemo();
    const cold = deriveTaskLedger(msgs);
    assert.strictEqual(cold.anchorText, warm.anchorText);
    assert.strictEqual(cold.anchorHash, warm.anchorHash);
    assert.strictEqual(cold.open, warm.open);
    assert.strictEqual(cold.askCount, warm.askCount);
    assert.strictEqual(cold.prefixHash, warm.prefixHash);
    assert.ok(!cold.tokenSet.has('poison'));
    assert.ok(!cold.fileSet.has('poison.js'));
  });
});

describe('detectContinuation', () => {
  const baseLedger = () => deriveTaskLedger([
    user('refactor the parser in src/parser.js to support unicode escapes'),
  ]);
  const neverEmbed = async () => { throw new Error('embed must not run'); };

  it('vetoes: falsy ledger/text', async () => {
    assert.deepStrictEqual(
      await detectContinuation('do the same', null, neverEmbed),
      { isContinuation: false, evidence: [], abstained: false }
    );
    assert.deepStrictEqual(
      await detectContinuation('', baseLedger(), neverEmbed),
      { isContinuation: false, evidence: [], abstained: false }
    );
  });

  it('vetoes: over-length text and explicit new-task openers', async () => {
    const l = baseLedger();
    const long = await detectContinuation('same '.repeat(101), l, neverEmbed);
    assert.strictEqual(long.isContinuation, false);
    const opener = await detectContinuation('unrelated: do the same thing again', l, neverEmbed);
    assert.strictEqual(opener.isContinuation, false);
    assert.deepStrictEqual(opener.evidence, []);
  });

  it('vetoes: closed task past the decay window', async () => {
    const l = baseLedger();
    const stale = { ...l, open: false, turnsSinceClose: 3 };
    const r = await detectContinuation('do the same here', stale, neverEmbed);
    assert.strictEqual(r.isContinuation, false);
    // Within the window the free branches still run.
    const fresh = { ...l, open: false, turnsSinceClose: 2 };
    const r2 = await detectContinuation('do the same here', fresh, neverEmbed);
    assert.strictEqual(r2.isContinuation, true);
  });

  it('branch A: deictic + low novelty fires without embedding', async () => {
    const r = await detectContinuation('do the same here', baseLedger(), neverEmbed);
    assert.strictEqual(r.isContinuation, true);
    assert.deepStrictEqual(r.evidence, ['deictic']);
    assert.strictEqual(r.abstained, false);
  });

  it('branch A blocked by >2 novel tokens', async () => {
    const embedNull = async () => null;
    const r = await detectContinuation(
      'again wire kubernetes prometheus grafana exporters',
      baseLedger(),
      embedNull
    );
    assert.strictEqual(r.isContinuation, false);
    assert.strictEqual(r.abstained, true);
  });

  it('branch B: cosine ≥ 0.70 fires; below the cut it does not', async () => {
    const l = baseLedger();
    const identical = async () => [0.3, 0.4, 0.5];
    const hit = await detectContinuation('extend unicode escape handling to surrogate pairs', l, identical);
    assert.strictEqual(hit.isContinuation, true);
    assert.deepStrictEqual(hit.evidence, ['cosine']);
    assert.strictEqual(hit.abstained, false);

    let flip = false;
    const orthogonal = async () => {
      flip = !flip;
      return flip ? [1, 0] : [0, 1];
    };
    const miss = await detectContinuation('bake a chocolate cake recipe', l, orthogonal);
    assert.strictEqual(miss.isContinuation, false);
    assert.strictEqual(miss.abstained, false);
  });

  it('branch B: timeout/null abstains instead of blocking', async () => {
    const l = baseLedger();
    const hang = () => new Promise(() => {});
    const started = Date.now();
    const r = await detectContinuation('bake a chocolate cake recipe', l, hang);
    assert.ok(Date.now() - started < 1000);
    assert.strictEqual(r.isContinuation, false);
    assert.strictEqual(r.abstained, true);
    const noFn = await detectContinuation('bake a chocolate cake recipe', l, null);
    assert.strictEqual(noFn.abstained, true);
  });

  it('branch C: a file from the task fileSet fires', async () => {
    const r = await detectContinuation('apply that pattern in src/parser.js too', baseLedger(), neverEmbed);
    assert.strictEqual(r.isContinuation, true);
    assert.ok(r.evidence.includes('files'));
  });

  it('multiple branches can fire together', async () => {
    const r = await detectContinuation('same for src/parser.js', baseLedger(), neverEmbed);
    assert.deepStrictEqual(r.evidence, ['deictic', 'files']);
  });
});

describe('buildTaskContext', () => {
  it('exact format with Task and Last segments', () => {
    const l = deriveTaskLedger([
      user('fix the parser'),
      user('add tests'),
    ]);
    assert.strictEqual(
      buildTaskContext(l),
      '[REFERENCE ONLY — background thread, NOT the current ask. Latest user message wins.] Task: "fix the parser" Last: "add tests"'
    );
  });

  it('omits Last when it equals the anchor, null without a ledger', () => {
    const l = deriveTaskLedger([user('fix the parser')]);
    assert.strictEqual(
      buildTaskContext(l),
      '[REFERENCE ONLY — background thread, NOT the current ask. Latest user message wins.] Task: "fix the parser"'
    );
    assert.strictEqual(buildTaskContext(null), null);
  });

  it('sanitizes brackets, angle tags and newlines; caps at 360', () => {
    const ctx = buildTaskContext({
      anchorText: `a [directive] <tag>\nwith   newlines ${'x'.repeat(300)}`,
      lastAsk: 'y'.repeat(300),
      open: true,
    });
    assert.ok(!/[\n<>[\]]/.test(ctx.replace(/^\[REFERENCE ONLY[^\]]*\]/, '')));
    assert.ok(ctx.startsWith('[REFERENCE ONLY — background thread, NOT the current ask. Latest user message wins.] Task: "a directive tag with newlines'));
    assert.ok(ctx.length <= 360);
  });
});

describe('buildJevSignals', () => {
  it('buckets 0→0 and snaps to the fib ladder capped at 21', () => {
    const mk = (n) => buildJevSignals({
      payload: { messages: Array.from({ length: n }, () => user('x')) },
    });
    assert.strictEqual(mk(0).message_count_bucket, 0);
    assert.strictEqual(mk(1).message_count_bucket, 1);
    assert.strictEqual(mk(4).message_count_bucket, 5);
    assert.strictEqual(mk(13).message_count_bucket, 13);
    assert.strictEqual(mk(100).message_count_bucket, 21);
  });

  it('mirrors the legacy inline block for tools + history + turns', () => {
    const payload = {
      messages: [
        user('do the thing'),
        assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
        user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      ],
      tools: [{ name: 'Read' }, { name: 'Edit' }],
    };
    const s = buildJevSignals({ payload });
    assert.strictEqual(s.tools_attached, 2);
    assert.strictEqual(s.effective_tools, 2);
    assert.strictEqual(s.has_tool_history, 1);
    assert.strictEqual(s.session_turn_bucket, 2); // ceil(3/2)=2
  });

  it('encodes continuation, floor (tierIndex+1) and ledger stats', () => {
    const ledger = {
      open: true,
      lastTurnStats: { toolCalls: 4, errors: 1 },
    };
    const s = buildJevSignals({ payload: {}, ledger, isContinuation: true, inheritedFloorIdx: 2 });
    assert.strictEqual(s.is_continuation, 1);
    assert.strictEqual(s.inherited_floor, 3);
    assert.strictEqual(s.task_open, 1);
    assert.strictEqual(s.last_turn_tools_bucket, 5);
    assert.strictEqual(s.last_turn_errors_bucket, 1);
  });

  it('derives the floor from payload._inheritedFloorTier when no idx given', () => {
    const s = buildJevSignals({ payload: { _inheritedFloorTier: 'MEDIUM' } });
    assert.strictEqual(s.inherited_floor, 2);
    const none = buildJevSignals({ payload: {} });
    assert.strictEqual(none.inherited_floor, 0);
    assert.strictEqual(none.is_continuation, 0);
    assert.strictEqual(none.task_open, 0);
  });
});
