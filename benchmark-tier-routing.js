#!/usr/bin/env node
/**
 * Full-Stack Benchmark: Lynkr vs LiteLLM vs Portkey
 *
 * Tests 6 scenarios that cover Lynkr's full optimization stack:
 *   1. Simple Q&A          → tier routing only
 *   2. Tool-heavy request  → smart tool selection (50-70% token reduction)
 *   3. Long history        → history compression
 *   4. Large payload       → TOON compression
 *   5. Repeated prompts    → semantic cache (2nd call should be ~0 tokens billed)
 *   6. Reasoning request   → tier routing to top model
 *
 * LiteLLM and Portkey send tokens as-is. Lynkr compresses before the model sees them.
 * The delta in input_tokens IS the compression saving.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-...  \
 *   LITELLM_MASTER_KEY=sk-1234    \
 *   PORTKEY_API_KEY=your-key      \
 *   node benchmark-tier-routing.js
 *
 * Modes (absorbed from the former benchmark-autorouter-v2.js):
 *   MODE=routing  — routing scenarios only (skips compression/cache); every
 *                   scenario with an `acceptable` set is judged on ALL proxies,
 *                   not just Lynkr. Use against LiteLLM Auto Router v2
 *                   (litellm-autorouter-v2*.yaml) for the head-to-head.
 *   RUNS=3        — repeat each scenario N times (stateful scenarios get a
 *                   fresh nonce per run; a scenario passes only if every run
 *                   passes — catches non-deterministic classifiers).
 *   ONLY=Lynkr | ONLY=LiteLLM | ONLY=Portkey — restrict to one proxy.
 */

// Per-run nonce: pins and semantic-cache entries persist server-side
// between runs (pins: 6h TTL). Stateful scenarios embed this nonce so each
// run gets fresh fingerprints and cache keys — without it, run #2 collides
// with run #1's state (P1 inherited the COMPLEX pin P2 wrote; SC3 hit its
// own previous answer).
const BASE_NONCE = Date.now().toString(36);
let RUN_NONCE = BASE_NONCE; // reassigned per run when RUNS > 1

const RUNS = Math.max(1, parseInt(process.env.RUNS ?? '1', 10));
const MODE = process.env.MODE ?? 'full';   // 'routing' = routing scenarios only
const ONLY = process.env.ONLY;             // proxy-name filter

// ─── Proxy config ─────────────────────────────────────────────────────────────

// Tier detection for LiteLLM Auto Router v2 (explicit model_info.id per tier
// deployment in litellm-autorouter-v2*.yaml).
const LITELLM_ID_TO_TIER = {
  'tier-simple': 'SIMPLE',
  'tier-medium': 'MEDIUM',
  'tier-complex': 'COMPLEX',
  'tier-reasoning': 'REASONING',
};
const LITELLM_ID_TO_MODEL = {
  'tier-simple': 'ollama/minimax-m2.5:cloud',
  'tier-medium': 'ollama/minimax-m2.5:cloud',
  'tier-complex': 'azure/gpt-5.2-chat',
  'tier-reasoning': 'zai/GLM-5.2',
};

const PROXIES = [
  {
    name: 'Lynkr',
    url: process.env.LYNKR_URL ?? 'http://localhost:8081',
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultModel: 'claude-sonnet-4-5',
    headers: {},
    // Decision (what the router chose) comes from headers; SERVED model
    // (who actually answered) comes from the response body — they differ
    // whenever tier-fallback rescued a failed upstream, and reporting the
    // decision as if it served is how this benchmark previously showed
    // "COMPLEX sonnet" rows that minimax actually answered.
    getTier:  (_b, h) => h['x-lynkr-tier']     ?? 'unknown',
    getModel: (b, h)  => b?.model ?? h['x-lynkr-model'] ?? h['x-lynkr-provider'] ?? 'unknown',
  },
  {
    name: 'LiteLLM',
    url: process.env.LITELLM_URL ?? 'http://localhost:8082',
    apiKey: process.env.LITELLM_MASTER_KEY ?? 'sk-1234',
    defaultModel: 'smart-router',
    headers: {},
    // Auto Router v2 configs (litellm-autorouter-v2*.yaml) set an explicit
    // model_info.id per tier deployment, surfaced as x-litellm-model-id.
    // Legacy configs (litellm-config.yaml) expose only a hash id — fall back
    // to the cost heuristic for those.
    getTier: (_b, h) => {
      const tier = LITELLM_ID_TO_TIER[h['x-litellm-model-id']];
      if (tier) return tier;
      const cost = parseFloat(h['x-litellm-response-cost-original'] ?? '0');
      if (cost === 0)    return 'SIMPLE/MEDIUM (Ollama)';
      if (cost < 0.01)   return 'MEDIUM (Moonshot)';
      return 'COMPLEX/REASONING (Azure)';
    },
    getModel: (_b, h) => {
      const model = LITELLM_ID_TO_MODEL[h['x-litellm-model-id']];
      if (model) return model;
      const cost = parseFloat(h['x-litellm-response-cost-original'] ?? '0');
      if (cost === 0)   return 'ollama (local/free)';
      if (cost < 0.01)  return 'moonshot/kimi-k2.6';
      return 'azure/gpt-5.2-chat';
    },
  },
  {
    name: 'Portkey',
    url: process.env.PORTKEY_URL ?? 'http://localhost:8083',
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultModel: 'claude-sonnet-4-5',
    headers: {
      'x-portkey-provider': 'anthropic',
      ...(process.env.PORTKEY_API_KEY ? { 'x-portkey-api-key': process.env.PORTKEY_API_KEY } : {}),
    },
    getTier:  () => 'N/A',
    getModel: (b) => b?.model ?? 'claude-sonnet-4-5',
  },
];

// ─── Pricing per 1M tokens [input, output] USD ───────────────────────────────

const PRICING = {
  // Free / local — must match before 'default': pricing minimax at
  // sonnet rates previously fabricated ~$0.01/request numbers.
  'minimax':            [0.00,   0.00],
  'ollama':             [0.00,   0.00],
  'llama':              [0.00,   0.00],
  'qwen':               [0.00,   0.00],
  'kimi':               [0.60,   2.50],
  'claude-haiku-4-5':   [0.80,   4.00],
  'claude-haiku-3':     [0.25,   1.25],
  'claude-sonnet':      [3.00,  15.00],
  'claude-opus':        [15.00, 75.00],
  'gpt-4o-mini':        [0.15,   0.60],
  'gpt-4o':             [2.50,  10.00],
  'o3-mini':            [1.10,   4.40],
  'default':            [3.00,  15.00],
};

function costUsd(model, inputTok, outputTok) {
  const key = Object.keys(PRICING).find(k => model.toLowerCase().includes(k)) ?? 'default';
  const [i, o] = PRICING[key];
  return (inputTok / 1e6) * i + (outputTok / 1e6) * o;
}

// Rough token estimator: 1 token ≈ 4 chars (GPT/Claude rule of thumb)
function estimateTokens(payload) {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

// ─── Reusable tool definitions (simulate a real Claude Code session) ──────────
// 14 tools ≈ 2,500 tokens of tool schema sent on every request without smart selection

const TOOL_DEFINITIONS = [
  { name: 'Read',      description: 'Read a file from disk',         input_schema: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] } },
  { name: 'Write',     description: 'Write content to a file',       input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Edit',      description: 'Make targeted edits to a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Bash',      description: 'Execute a shell command',       input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } },
  { name: 'Glob',      description: 'Find files matching a pattern', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep',      description: 'Search for patterns in files',  input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] } },
  { name: 'WebSearch', description: 'Search the web',                input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'WebFetch',  description: 'Fetch a URL',                   input_schema: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string' } }, required: ['url'] } },
  { name: 'TodoWrite', description: 'Write a todo list',             input_schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } }, required: ['todos'] } },
  { name: 'TodoRead',  description: 'Read the current todo list',    input_schema: { type: 'object', properties: {} } },
  { name: 'Task',      description: 'Spawn a subagent',              input_schema: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' } }, required: ['description', 'prompt'] } },
  { name: 'NotebookRead',  description: 'Read a Jupyter notebook',   input_schema: { type: 'object', properties: { notebook_path: { type: 'string' } }, required: ['notebook_path'] } },
  { name: 'NotebookEdit',  description: 'Edit a Jupyter notebook',   input_schema: { type: 'object', properties: { notebook_path: { type: 'string' }, cell_index: { type: 'number' }, new_source: { type: 'string' } }, required: ['notebook_path', 'cell_index', 'new_source'] } },
  { name: 'mcp__github__create_pull_request', description: 'Create a GitHub pull request via MCP', input_schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' } }, required: ['title', 'body'] } },
];


// expectTier may be a string or an array (boundary asks assert the rung that
// matters — e.g. cheap-start — instead of pretending one exact band is real).
function tierMatches(expect, got) {
  return Array.isArray(expect) ? expect.includes(got) : got === expect;
}
function fmtExpect(expect) {
  return Array.isArray(expect) ? expect.join('|') : expect;
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

const SCENARIOS = [
  // ── 1. Simple Q&A ─────────────────────────────────────────────────────────
  {
    id: 'S1', label: 'Simple Q&A',
    acceptable: ['SIMPLE', 'MEDIUM'],
    feature: 'Tier routing → cheap model',
    // Boundary ask: the anchor classifier legitimately reads a short
    // explain-a-command question as trivial-or-substantive depending on
    // phrasing jitter. What this scenario guards is CHEAP-START (never
    // kimi/opus) — asserting one exact band there is fake granularity.
    expectTier: ['SIMPLE', 'MEDIUM'],
    buildPayload: (model) => ({
      model, max_tokens: 256,
      // Nonced: an un-nonced opener fingerprints to the same session every
      // run, and a stale pin (6h TTL, survives gateway restarts) then serves
      // whatever tier a PREVIOUS run pinned — observed live 2026-07-09.
      messages: [{ role: 'user', content: `[run ${RUN_NONCE}] What does git stash do?` }],
    }),
  },

  // ── 2. Tool-heavy (smart tool selection) ──────────────────────────────────
  // All 14 tools sent — Lynkr strips irrelevant ones before forwarding
  {
    id: 'T1', label: 'Tool-heavy (14 tools)',
    feature: 'Smart tool selection → strips unused tools',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      tools: TOOL_DEFINITIONS,
      messages: [{ role: 'user', content: 'What does the README say about installation?' }],
    }),
  },
  {
    id: 'T2', label: 'Tool-heavy (14 tools) – write task',
    feature: 'Smart tool selection → keeps only write tools',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      tools: TOOL_DEFINITIONS,
      messages: [{ role: 'user', content: 'Edit the config file to set DEBUG=true' }],
    }),
  },

  // ── 3. Long history (history compression) ─────────────────────────────────
  // 8-turn conversation — Lynkr compresses older turns before forwarding
  {
    id: 'H1', label: 'Long history (8 turns)',
    feature: 'History compression → dedups older turns',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      messages: [
        { role: 'user',      content: 'Can you help me refactor my Express app?' },
        { role: 'assistant', content: 'Sure! Let\'s start by reviewing your current structure. What does your folder layout look like?' },
        { role: 'user',      content: 'I have routes/, controllers/, models/, middleware/ folders.' },
        { role: 'assistant', content: 'Good structure. Are you using any ORM, and do you have error handling middleware in place?' },
        { role: 'user',      content: 'I use Sequelize. Error handling is scattered across controllers right now.' },
        { role: 'assistant', content: 'Let\'s centralise error handling first. Create middleware/errorHandler.js and export an express error middleware with four params (err, req, res, next).' },
        { role: 'user',      content: 'Done. Now I need to add input validation — should I use Joi or express-validator?' },
        { role: 'assistant', content: 'For Sequelize projects, Joi pairs well. Install it and create a validate() middleware wrapper.' },
        { role: 'user',      content: 'Great, now how do I add rate limiting to specific routes only?' },
      ],
    }),
  },

  // ── 4a. TOON – large JSON tool result (file read) ─────────────────────────
  // Simulates a tool_result block returning a large JSON config file.
  // TOON specifically compresses JSON structures — this is its primary trigger.
  {
    id: 'L1', label: 'TOON – large JSON tool result',
    feature: 'TOON compression → compresses JSON tool_result before forwarding',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      tools: [TOOL_DEFINITIONS[0]], // Read tool only
      messages: [
        { role: 'user',      content: 'Read package.json and tell me the dependencies.' },
        { role: 'assistant', content: null,
          tool_calls: [{ id: 'tr_001', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'package.json' }) } }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tr_001', content: JSON.stringify(generateFakeLargeJsonResult()) },
        ]},
        { role: 'user', content: 'What are the top-level dependencies?' },
      ],
    }),
  },

  // ── 4b. TOON – large grep/glob JSON result ────────────────────────────────
  // Simulates a Bash tool returning a large JSON array of search results.
  {
    id: 'L2', label: 'TOON – large JSON grep result (~2k tokens)',
    feature: 'TOON compression → compresses JSON array tool_result',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      tools: [TOOL_DEFINITIONS[3]], // Bash tool only
      messages: [
        { role: 'user',      content: 'Find all TODO comments in the codebase.' },
        { role: 'assistant', content: null,
          tool_calls: [{ id: 'tr_002', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'grep -rn "TODO" src/' }) } }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tr_002', content: JSON.stringify(generateFakeGrepResult()) },
        ]},
        { role: 'user', content: 'Summarise the most important TODOs.' },
      ],
    }),
  },

  // ── 5. Semantic cache (send same prompt twice) ─────────────────────────────
  // First call: billed normally. Second call: Lynkr returns cached response (0 LLM tokens).
  {
    id: 'SC1', label: 'Cache – first call',
    feature: 'Semantic cache – populates cache',
    allowCache: true,
    buildPayload: (model) => ({
      model, max_tokens: 256,
      messages: [{ role: 'user', content: `[run ${RUN_NONCE}] Explain the difference between TCP and UDP in two sentences.` }],
    }),
  },
  {
    id: 'SC2', label: 'Cache – second call (near-identical)',
    feature: 'Semantic cache – should hit cache → 0 tokens billed',
    allowCache: true,
    buildPayload: (model) => ({
      model, max_tokens: 256,
      // Slightly paraphrased — same run nonce, so it matches SC1's entry
      // but never a previous run's.
      messages: [{ role: 'user', content: `[run ${RUN_NONCE}] What is the difference between TCP and UDP? Keep it brief.` }],
    }),
  },

  // ── 6. Reasoning ──────────────────────────────────────────────────────────
  {
    id: 'R1', label: 'Reasoning – security analysis',
    acceptable: ['COMPLEX', 'REASONING'],
    feature: 'Tier routing → top model + risk classifier',
    expectTier: 'COMPLEX', // risk keywords force COMPLEX
    buildPayload: (model) => ({
      model, max_tokens: 1024,
      messages: [{ role: 'user', content: 'Analyse the security trade-offs of storing JWT tokens in localStorage vs httpOnly cookies for a banking application. Step by step.' }],
    }),
  },

  // ── 7. Routing-correctness regressions (live incidents, 2026-07) ─────────
  // Each of these encodes a bug found in production Claude Code sessions.
  // route ✓/✗ flags apply to Lynkr only.
  {
    id: 'F1', label: 'Force-cloud trigger phrase',
    acceptable: ['COMPLEX', 'REASONING'],
    feature: 'FORCE_CLOUD_PATTERNS → instant COMPLEX regardless of score',
    expectTier: 'COMPLEX',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      messages: [{ role: 'user', content: 'Refactor the entire ingestion pipeline and give me the plan.' }],
    }),
  },
  {
    id: 'F2', label: 'Risk via protected path',
    acceptable: ['COMPLEX', 'REASONING'],
    feature: 'Path-keyword risk → write-intent on auth file forces COMPLEX',
    expectTier: 'COMPLEX',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      messages: [{ role: 'user', content: 'Fix the null check bug in src/auth/middleware.ts and update the tests.' }],
    }),
  },
  {
    id: 'RS1', label: 'Reminder-injection immunity',
    acceptable: ['SIMPLE', 'MEDIUM'],
    feature: 'Risk scan must ignore harness-injected <system-reminder> text',
    // The property under test is reminder IMMUNITY: injected credential/
    // security words must not risk-escalate to COMPLEX/REASONING. SIMPLE vs
    // MEDIUM is boundary jitter, not a leak — "17+25" blends near the top of
    // the trivial band, and the 2026-07-16 boundary move (25→20, RouterArena-
    // diagnosed) legitimately places top-of-band trivial asks in MEDIUM.
    expectTier: ['SIMPLE', 'MEDIUM'],
    buildPayload: (model) => ({
      model, max_tokens: 64,
      messages: [{ role: 'user', content: '17+25\n<system-reminder>7 MCP servers need authentication. Provide credentials via /mcp. Security policy applies to production deploys.</system-reminder>' }],
    }),
  },
  {
    id: 'SR1', label: 'Suggestion-mode side request',
    acceptable: ['SIMPLE', 'MEDIUM'],
    feature: 'Harness autocomplete wrapper → static SIMPLE, never scored/pinned',
    expectTier: 'SIMPLE',
    buildPayload: (model) => ({
      model, max_tokens: 128,
      tools: TOOL_DEFINITIONS.slice(0, 6),
      messages: [
        { role: 'user', content: 'How do I revoke a leaked credential in production?' },
        { role: 'assistant', content: 'First, rotate the secret…' },
        { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.] Look at the conversation about production credentials and security incidents, then predict their next message.' },
      ],
    }),
  },
  {
    id: 'A1', label: 'Autonomous agentic ask',
    acceptable: ['COMPLEX', 'REASONING'],
    feature: 'AUTONOMOUS detection → minTier REASONING via tier config',
    expectTier: 'REASONING',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      tools: TOOL_DEFINITIONS,
      messages: [{ role: 'user', content: 'Work autonomously: first run the test suite, then fix each failure one by one, rerun after every fix, and keep iterating until everything is green. Finally clean up and summarise.' }],
    }),
  },

  // ── 8. Sticky-session pair: pin then drift-escape ─────────────────────────
  // P1 and P2 share the SAME first user message, so Lynkr's content
  // fingerprint maps them to one session: P1 pins SIMPLE, P2 must escape
  // via the force-cloud phrase (deterministic, unlike raw drift scores).
  {
    id: 'P1', label: 'Pin – trivial opener',
    acceptable: ['SIMPLE', 'MEDIUM'],
    feature: 'Fingerprint session opens → pins SIMPLE',
    expectTier: 'SIMPLE',
    buildPayload: (model) => ({
      model, max_tokens: 64,
      messages: [{ role: 'user', content: `hi, you there? (run ${RUN_NONCE})` }],
    }),
  },
  {
    id: 'P2', label: 'Pin – escape on real task (same session)',
    acceptable: ['COMPLEX', 'REASONING'],
    feature: 'WS1.5 pin escape: force phrase breaks a SIMPLE pin mid-session',
    expectTier: 'COMPLEX',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      messages: [
        { role: 'user', content: `hi, you there? (run ${RUN_NONCE})` },
        { role: 'assistant', content: 'Hi! What do you need?' },
        { role: 'user', content: 'Now do an architecture review of the routing module.' },
      ],
    }),
  },

  // ── 8.5 WS7 envelope invariance pair ──────────────────────────────────────
  // Same semantic ask, bare (IV1) vs wrapped in the full payload envelope
  // (IV2: 15 tool schemas + a fat system-reminder + prior turns). Pre-WS7
  // the lexical scorer measured these 31 vs 56 — a whole band apart. The
  // anchor classifier scores CLEANED USER TEXT only, so both must land the
  // same tier. Both assert MEDIUM: a substantive-but-not-heavy ask.
  {
    id: 'IV1', label: 'Invariance – bare ask',
    acceptable: ['MEDIUM', 'COMPLEX'],
    feature: 'WS7 anchor score, no envelope',
    expectTier: 'MEDIUM',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      messages: [{ role: 'user', content: `Review this retry helper for bugs and edge cases and suggest concrete improvements. [run ${RUN_NONCE}-iv]` }],
    }),
  },
  {
    id: 'IV2', label: 'Invariance – same ask + envelope',
    acceptable: ['MEDIUM', 'COMPLEX'], invariantWith: 'IV1',
    feature: 'WS7 payload-invariant scoring: schemas/reminders/history must not move the SCORE',
    // NOTE: deliberately ≤3 tools — the agentic detector is an envelope
    // TRIGGER that is allowed to escalate; this pair isolates the score.
    expectTier: 'MEDIUM',
    buildPayload: (model) => ({
      model, max_tokens: 512,
      tools: TOOL_DEFINITIONS.slice(0, 3),
      messages: [
        { role: 'user', content: `earlier context for the invariance pair ${RUN_NONCE}` },
        { role: 'assistant', content: 'Understood — send the code when ready.' },
        { role: 'user', content: `<system-reminder>Contents of project notes: ${'lorem ipsum dolor sit amet '.repeat(120)}</system-reminder>\nReview this retry helper for bugs and edge cases and suggest concrete improvements. [run ${RUN_NONCE}-iv]\n<system-reminder>The user opened file retry.js in the IDE.</system-reminder>` },
      ],
    }),
  },

  // ── 9. Cache miss control ─────────────────────────────────────────────────
  // SC2 proves the cache hits; this proves it does NOT over-match: a
  // semantically different question must be a miss (live footgun: 0.87
  // similarity matched different prompts during testing).
  {
    id: 'SC3', label: 'Cache – different question (must MISS)',
    feature: 'Semantic cache false-positive guard',
    expectNoCache: true,
    allowCache: true, // cache ENABLED — the assertion is that it must miss
    buildPayload: (model) => ({
      model, max_tokens: 256,
      messages: [{ role: 'user', content: `[run ${RUN_NONCE}] What are the four layers of the TCP/IP model and what does each do?` }],
    }),
  },
];

// ─── JSON payload generators (TOON compresses these, plain text it ignores) ──

function generateFakeLargeJsonResult() {
  // Simulates a package.json with many dependencies — ~1,800 tokens of JSON
  const deps = {};
  const devDeps = {};
  const packages = [
    'express','lodash','axios','react','typescript','webpack','babel','eslint',
    'jest','mocha','chai','sinon','supertest','dotenv','cors','helmet','morgan',
    'winston','pino','joi','yup','zod','mongoose','sequelize','prisma','knex',
    'redis','ioredis','bull','agenda','node-cron','socket.io','ws','graphql',
    'apollo-server','type-graphql','class-transformer','class-validator','reflect-metadata',
  ];
  packages.forEach((p, i) => {
    const ver = `^${Math.floor(i/10)+1}.${i%10}.${Math.floor(Math.random()*20)}`;
    if (i % 3 === 0) devDeps[p] = ver; else deps[p] = ver;
  });
  return {
    name: 'my-app', version: '1.0.0',
    scripts: { start: 'node index.js', test: 'jest', build: 'webpack', lint: 'eslint src/' },
    dependencies: deps,
    devDependencies: devDeps,
    engines: { node: '>=18.0.0' },
    keywords: ['api','backend','nodejs'],
    files: Array.from({ length: 30 }, (_, i) => `src/module${i}.js`),
    exports: Object.fromEntries(packages.map(p => [`./${p}`, `./dist/${p}/index.js`])),
  };
}

function generateFakeGrepResult() {
  // Simulates grep -rn "TODO" returning a large JSON array — ~1,200 tokens
  return Array.from({ length: 60 }, (_, i) => ({
    file: `src/${['routes','controllers','models','middleware','utils'][i % 5]}/module${i % 15}.js`,
    line: Math.floor(Math.random() * 500) + 1,
    match: `TODO: ${['fix error handling','add validation','refactor this','add tests','update docs','remove hardcoded value','add rate limiting','handle edge case'][i % 8]} — assigned to ${['alice','bob','carol','dave'][i % 4]}`,
    context: `  // TODO: ${['fix error handling','add validation','refactor this','add tests'][i % 4]}\n  function handler${i}(req, res) { return res.json({ status: 'ok' }); }`,
  }));
}

// ─── HTTP request ─────────────────────────────────────────────────────────────

async function sendRequest(proxy, scenario) {
  const payload = scenario.buildPayload(proxy.defaultModel);
  const estimatedInputTokens = estimateTokens(payload.messages) + estimateTokens(payload.tools ?? []);
  const start = Date.now();

  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': proxy.apiKey,
        'anthropic-version': '2023-06-01',
        // The semantic cache would otherwise serve run #2 entirely from
        // run #1's answers, zeroing every feature measurement. Cache
        // scenarios opt in via allowCache.
        ...(scenario.allowCache ? {} : { 'x-lynkr-no-cache': 'true' }),
        ...proxy.headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });

    const latencyMs = Date.now() - start;
    const headers = Object.fromEntries(res.headers.entries());

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${err.slice(0, 100)}`, latencyMs, estimatedInputTokens };
    }

    const body = await res.json();
    const cacheHit = body?.lynkr_semantic_cache?.hit === true;
    const cacheSimilarity = body?.lynkr_semantic_cache?.similarity ?? null;
    // On a cache hit the body echoes the CACHED usage — nothing was billed.
    const billedInput  = cacheHit ? 0 : (body?.usage?.input_tokens  ?? 0);
    const billedOutput = cacheHit ? 0 : (body?.usage?.output_tokens ?? 0);
    const model        = proxy.getModel(body, headers);
    const decidedTier  = proxy.getTier(body, headers);
    const wasFallback  = headers['x-lynkr-fallback'] === 'true';
    const cost         = costUsd(model, billedInput, billedOutput);
    // Signed delta: positive = compression saved tokens; negative = the
    // proxy ADDED tokens (system-prompt injection etc). The old clamp to 0
    // hid overhead and made "saved 0" ambiguous.
    const tokenDelta   = estimatedInputTokens - billedInput;
    const tokensSaved  = Math.max(0, tokenDelta);
    const compressionPct = estimatedInputTokens > 0
      ? ((tokenDelta / estimatedInputTokens) * 100).toFixed(1)
      : '0.0';

    return { ok: true, tier: decidedTier, model, billedInput, billedOutput, estimatedInputTokens, tokenDelta, tokensSaved, compressionPct, cost, latencyMs, cacheHit, cacheSimilarity, wasFallback };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start, estimatedInputTokens };
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

const col = (s, w) => String(s ?? '').slice(0, w).padEnd(w);
const $ = (n) => `$${n.toFixed(6)}`;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runBenchmark() {
  const ACTIVE = ONLY ? PROXIES.filter(p => p.name === ONLY) : PROXIES;
  const RUN_SCENARIOS = MODE === 'routing' ? SCENARIOS.filter(s => s.acceptable) : SCENARIOS;
  if (ACTIVE.length === 0) { console.error(`Unknown proxy in ONLY=${ONLY} (use ${PROXIES.map(p => p.name).join('|')})`); process.exit(1); }

  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║   Full-Stack Benchmark: Lynkr vs LiteLLM vs Portkey               ║');
  console.log('║   Tests: tier routing · tool selection · history · TOON · cache    ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log(`\nmode=${MODE} · scenarios=${RUN_SCENARIOS.length} · runs=${RUNS} · proxies=${ACTIVE.map(p => p.name).join(', ')}\n`);

  // results[proxyName][scenarioId] = array of per-run results
  const results = {};
  for (const p of ACTIVE) results[p.name] = {};

  for (let run = 0; run < RUNS; run++) {
    // Stateful scenarios (pins, semantic cache) key off the nonce — each run
    // gets a fresh one so run #2 never collides with run #1's server-side state.
    RUN_NONCE = RUNS > 1 ? `${BASE_NONCE}-r${run}` : BASE_NONCE;
    for (const scenario of RUN_SCENARIOS) {
      process.stdout.write(`\n[${scenario.id}] ${scenario.label.padEnd(35)} `);
      for (const proxy of ACTIVE) {
        process.stdout.write(`${proxy.name}… `);
        (results[proxy.name][scenario.id] ??= []).push(await sendRequest(proxy, scenario));
        await new Promise(r => setTimeout(r, 400));
      }
      process.stdout.write('✓');
    }
    if (RUNS > 1) process.stdout.write(`\n— run ${run + 1}/${RUNS} done`);
  }

  // ─── Per-Scenario Detail ────────────────────────────────────────────────────

  console.log('\n\n\n━━━  PER-SCENARIO DETAIL  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (const scenario of RUN_SCENARIOS) {
    console.log(`\n▸ [${scenario.id}] ${scenario.label}`);
    console.log(`  Feature under test: ${scenario.feature}`);
    console.log(`  ${'Proxy'.padEnd(10)} ${'Tier'.padEnd(14)} ${'Model'.padEnd(26)} ${'Est.Tok'.padEnd(9)} ${'Billed'.padEnd(9)} ${'Saved'.padEnd(8)} ${'Compress%'.padEnd(11)} ${'Cost'.padEnd(12)} Latency`);
    console.log('  ' + '─'.repeat(110));

    for (const proxy of ACTIVE) {
      for (const [runIdx, r] of (results[proxy.name][scenario.id] ?? []).entries()) {
        const label = RUNS > 1 ? `${proxy.name}#${runIdx}` : proxy.name;
        if (!r.ok) {
          const skipped = /fetch failed|ECONNREFUSED|timeout/i.test(r.error || '');
          console.log(`  ${col(label,10)} ${skipped ? 'SKIPPED (proxy not reachable — is it running?)' : 'ERROR: ' + r.error?.slice(0,80)}`);
          continue;
        }
        const isLynkr = proxy.name === 'Lynkr';
        const flags = [
          r.cacheHit ? 'CACHE-HIT' : null,
          r.wasFallback ? 'SERVED-VIA-FALLBACK' : null,
          // expectTier is Lynkr's regression assertion; `acceptable` (below,
          // scoreboard) is the cross-proxy judgment.
          isLynkr && scenario.expectTier
            ? (tierMatches(scenario.expectTier, r.tier) ? `route ✓ ${r.tier}` : `route ✗ expected ${fmtExpect(scenario.expectTier)}, got ${r.tier}`)
            : null,
          isLynkr && scenario.expectNoCache
            ? (!r.cacheHit ? 'cache-miss ✓'
               : (r.cacheSimilarity != null && r.cacheSimilarity >= 0.97)
                 ? `cache self-match ✓ (sim ${r.cacheSimilarity.toFixed(3)} — prior run's identical question)`
                 : `cache ✗ FALSE-POSITIVE (sim ${r.cacheSimilarity?.toFixed(3) ?? '?'} — matched a DIFFERENT question)`)
            : null,
        ].filter(Boolean).join(' · ');
        console.log(
          '  ' +
          col(label, 10) +
          col(r.tier, 14) +
          col(r.model, 26) +
          col(r.estimatedInputTokens, 9) +
          col(r.billedInput, 9) +
          col(r.tokenDelta, 8) +
          col(r.compressionPct + '%', 11) +
          col($(r.cost), 12) +
          `${r.latencyMs}ms` +
          (flags ? `   [${flags}]` : '')
        );
      }
    }
  }

  // ─── Routing correctness scoreboard (Lynkr regression assertions) ──────────
  // A scenario passes only if EVERY ok run passes — catches nondeterminism.

  if (results.Lynkr) {
    console.log('\n\n━━━  ROUTING CORRECTNESS (Lynkr)  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    let routePass = 0, routeFail = 0;
    for (const scenario of RUN_SCENARIOS) {
      const okRs = (results.Lynkr[scenario.id] ?? []).filter(r => r.ok);
      if (okRs.length === 0) continue;
      if (scenario.expectTier) {
        const tiers = [...new Set(okRs.map(r => r.tier))];
        const pass = tiers.every(t => tierMatches(scenario.expectTier, t));
        pass ? routePass++ : routeFail++;
        console.log(`  [${scenario.id}] ${pass ? '✓' : '✗'} expected ${fmtExpect(scenario.expectTier)}, got ${tiers.join('/')}${pass ? '' : '   ← REGRESSION'}`);
      }
      if (scenario.expectNoCache) {
        // Fail only on a LOW-similarity hit — that means the cache served an
        // answer to a different question. High-similarity hits are prior
        // runs' identical question: correct behavior.
        const bad = okRs.find(r => r.cacheHit && !(r.cacheSimilarity != null && r.cacheSimilarity >= 0.97));
        const pass = !bad;
        pass ? routePass++ : routeFail++;
        console.log(`  [${scenario.id}] ${pass ? '✓' : '✗'} no wrong-question cache match${pass ? '' : `   ← FALSE POSITIVE at sim ${bad.cacheSimilarity?.toFixed(3)}`}`);
      }
    }
    console.log(`\n  ${routePass} passed, ${routeFail} failed${routeFail ? '  ⚠ routing regressions detected' : ''}`);
  }

  // ─── Cross-proxy routing scoreboard (`acceptable` sets, all proxies) ───────
  // Unlike expectTier (Lynkr's strict regression targets), `acceptable` lists
  // every defensible tier for the ask and is judged on ALL proxies that
  // expose a real tier decision. IV2 additionally requires the same tier as
  // IV1 (payload envelope must not move the classification).

  const judged = ACTIVE.filter(p => RUN_SCENARIOS.some(s => s.acceptable &&
    (results[p.name][s.id] ?? []).some(r => r.ok && !String(r.tier).includes('N/A'))));
  if (judged.length > 0) {
    console.log('\n\n━━━  ROUTING SCOREBOARD (all proxies, acceptable-tier sets)  ━━━━━\n');
    const routingScenarios = RUN_SCENARIOS.filter(s => s.acceptable);
    console.log(`  ${col('ID', 5)}${col('Acceptable', 19)}` + judged.map(p => col(p.name, 24)).join(''));
    console.log('  ' + '─'.repeat(5 + 19 + 24 * judged.length));
    const score = Object.fromEntries(judged.map(p => [p.name, { pass: 0, fail: 0 }]));
    for (const sc of routingScenarios) {
      const cells = judged.map(proxy => {
        const okRs = (results[proxy.name][sc.id] ?? []).filter(r => r.ok);
        if (okRs.length === 0) return col('– no data', 24);
        const tiers = [...new Set(okRs.map(r => r.tier))];
        let pass = tiers.every(t => sc.acceptable.includes(t));
        if (pass && sc.invariantWith) {
          const partner = (results[proxy.name][sc.invariantWith] ?? []).filter(r => r.ok).map(r => r.tier);
          pass = partner.length > 0 && [...new Set([...tiers, ...partner])].length === 1;
        }
        pass ? score[proxy.name].pass++ : score[proxy.name].fail++;
        return col(`${pass ? '✓' : '✗'} ${tiers.join('/')}`, 24);
      });
      console.log(`  ${col(sc.id, 5)}${col(sc.acceptable.join('|'), 19)}${cells.join('')}`);
    }
    console.log();
    for (const p of judged) {
      const s = score[p.name];
      console.log(`  ${col(p.name, 12)} ${s.pass}/${s.pass + s.fail} routing-correct`);
    }
  }

  console.log('\n\n━━━  FEATURE SUMMARY  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const featureGroups = [
    { label: 'Tier Routing (S1, R1)',          ids: ['S1', 'R1']  },
    { label: 'Smart Tool Selection (T1, T2)',   ids: ['T1', 'T2']  },
    { label: 'History Compression (H1)',        ids: ['H1']        },
    { label: 'TOON / JSON Tool Results (L1+L2)', ids: ['L1', 'L2']  },
    { label: 'Semantic Cache (SC1 + SC2)',      ids: ['SC1','SC2'] },
  ];

  for (const group of featureGroups) {
    if (!group.ids.some(id => RUN_SCENARIOS.some(s => s.id === id))) continue;
    console.log(`  ${group.label}`);
    for (const proxy of ACTIVE) {
      const rs = group.ids.flatMap(id => results[proxy.name][id] ?? []).filter(r => r?.ok);
      if (rs.length === 0) { console.log(`    ${proxy.name.padEnd(10)} – no data`); continue; }
      const totalCost    = rs.reduce((s, r) => s + r.cost, 0);
      const totalSaved   = rs.reduce((s, r) => s + r.tokensSaved, 0);
      const totalEst     = rs.reduce((s, r) => s + r.estimatedInputTokens, 0);
      const avgCompress  = totalEst > 0 ? ((totalSaved / totalEst) * 100).toFixed(1) : '0.0';
      console.log(`    ${proxy.name.padEnd(10)} cost: ${$(totalCost).padEnd(14)} tokens saved: ${String(totalSaved).padEnd(8)} compression: ${avgCompress}%`);
    }
    console.log();
  }

  // ─── Overall Cost Summary ───────────────────────────────────────────────────

  console.log('\n━━━  OVERALL COST (all scenarios)  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const totals = ACTIVE.map(proxy => {
    const rs = Object.values(results[proxy.name]).flat().filter(r => r?.ok);
    return {
      name: proxy.name,
      n: rs.length,
      cost: rs.reduce((s, r) => s + r.cost, 0),
      tokensSaved: rs.reduce((s, r) => s + r.tokensSaved, 0),
      avgLatency: rs.length ? rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length : 0,
    };
  }).filter(t => t.n > 0)  // proxies with zero data have no business in cost tables
    .sort((a, b) => a.cost - b.cost);

  if (totals.length < 2) {
    console.log('  ⚠ Only ' + (totals.map(t=>t.name).join(', ') || 'no proxies') + ' returned data — comparative claims and extrapolation are meaningless with a single proxy.');
    console.log('    To compare: start LiteLLM on :8082 and/or Portkey gateway on :8083 (see header comment).');
  }
  const maxCost = Math.max(...totals.map(t => t.cost), 0.000001);
  const baselineProxy = [...totals].sort((a, b) => b.cost - a.cost)[0];
  const baseline = baselineProxy?.cost ?? maxCost;
  const baselineName = baselineProxy?.name ?? 'baseline';

  for (const t of totals) {
    const pct = baseline > 0 ? ((baseline - t.cost) / baseline * 100).toFixed(1) : '0.0';
    const barLen = maxCost > 0 ? Math.max(1, Math.round((t.cost / maxCost) * 30)) : 1;
    const bar = '█'.repeat(barLen);
    console.log(`  ${t.name.padEnd(10)} ${$(t.cost).padEnd(14)} ${pct.padStart(5)}% cheaper vs ${baselineName}   avg ${Math.round(t.avgLatency)}ms   ${bar}`);
  }

  // ─── Extrapolated: 100k requests/month ─────────────────────────────────────

  console.log('\n\n━━━  EXTRAPOLATED: 100,000 requests/month  ──────────────────────────\n');
  console.log('  (same scenario mix × scale factor)\n');

  const factor = 100_000 / (RUN_SCENARIOS.length * RUNS);
  for (const t of totals) {
    const monthly = t.cost * factor;
    const annualSaving = baseline > 0 ? (baseline - t.cost) * factor * 12 : 0;
    console.log(`  ${t.name.padEnd(10)} ~$${monthly.toFixed(2).padStart(10)}/month   ~$${(annualSaving).toFixed(0).padStart(10)}/year saved vs ${baselineName}`);
  }

  console.log('\nDone.\n');
}

runBenchmark().catch(e => { console.error(e); process.exit(1); });
