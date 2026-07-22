#!/usr/bin/env node
/**
 * `lynkr init` — interactive setup wizard that produces a working .env.
 *
 * Walks the user through:
 *   1. Usage mode (Claude Pro/Max subscription via wrap, or API-key direct).
 *   2. Per-tier model selection across all supported providers.
 *   3. Routing-intelligence knobs (visible badge, intent window, decay).
 *   4. Credential collection (re-uses values across tiers, never asks twice).
 *
 * Usage:
 *   lynkr init                        # interactive
 *   lynkr init --force                # overwrite existing .env
 *   lynkr init --output=<path>        # write to <path> instead of .env
 *   lynkr init --dry-run              # print to stdout, don't write
 *   lynkr init --help
 *
 * @module bin/lynkr-init
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ──────────────────────────────────────────────────────────────────────────────
// Provider schema
// ──────────────────────────────────────────────────────────────────────────────
//
// Canonical list pulled from src/config/index.js SUPPORTED_MODEL_PROVIDERS.
// Each entry lists the credential env vars the user needs to supply and any
// model/endpoint extras with sensible defaults. Local providers (no creds) are
// flagged so the wizard skips the credential prompt.

const PROVIDERS = {
  ollama: {
    label: 'Ollama (local, free)',
    local: true,
    creds: [],
    extras: [
      { key: 'OLLAMA_ENDPOINT', label: 'endpoint', default: 'http://localhost:11434' },
    ],
    defaultModel: 'qwen2.5-coder:latest',
  },
  llamacpp: {
    label: 'llama.cpp (local)',
    local: true,
    creds: [],
    extras: [
      { key: 'LLAMACPP_ENDPOINT', label: 'endpoint', default: 'http://localhost:8080' },
    ],
    defaultModel: 'qwen2.5-coder',
  },
  lmstudio: {
    label: 'LM Studio (local)',
    local: true,
    creds: [],
    extras: [
      { key: 'LMSTUDIO_ENDPOINT', label: 'endpoint', default: 'http://localhost:1234' },
    ],
    defaultModel: 'qwen2.5-coder',
  },
  'azure-anthropic': {
    label: 'Azure Anthropic (Claude via Azure)',
    local: false,
    creds: [
      { key: 'AZURE_ANTHROPIC_ENDPOINT', label: 'Azure Anthropic endpoint URL' },
      { key: 'AZURE_ANTHROPIC_API_KEY', label: 'Azure Anthropic API key', secret: true },
    ],
    extras: [],
    defaultModel: 'claude-sonnet-4-6',
  },
  'azure-openai': {
    label: 'Azure OpenAI (GPT family via Azure)',
    local: false,
    creds: [
      { key: 'AZURE_OPENAI_ENDPOINT', label: 'Azure OpenAI endpoint URL' },
      { key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI API key', secret: true },
      { key: 'AZURE_OPENAI_DEPLOYMENT', label: 'Deployment name', default: 'gpt-5.2-chat' },
    ],
    extras: [],
    defaultModel: 'gpt-5.2-chat',
  },
  openai: {
    label: 'OpenAI (direct)',
    local: false,
    creds: [
      { key: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true },
    ],
    extras: [],
    defaultModel: 'gpt-4o',
  },
  openrouter: {
    label: 'OpenRouter (100+ models, one key)',
    local: false,
    creds: [
      { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true },
    ],
    extras: [],
    defaultModel: 'anthropic/claude-sonnet-4',
  },
  edenai: {
    label: 'Eden AI (600+ models, one key, EU/GDPR)',
    local: false,
    creds: [
      { key: 'EDENAI_API_KEY', label: 'Eden AI API key', secret: true },
    ],
    extras: [],
    defaultModel: 'anthropic/claude-sonnet-4-5',
  },
  databricks: {
    label: 'Databricks Foundation Models',
    local: false,
    creds: [
      { key: 'DATABRICKS_API_BASE', label: 'Databricks workspace URL' },
      { key: 'DATABRICKS_API_KEY', label: 'Databricks API token', secret: true },
    ],
    extras: [],
    defaultModel: 'databricks-claude-sonnet-4',
  },
  bedrock: {
    label: 'AWS Bedrock',
    local: false,
    creds: [
      // Bearer token from AWS Console → Bedrock → API Keys. The Bedrock client
      // (src/clients/databricks.js:1450) requires this key and does NOT fall
      // back to IAM/SigV4 — common misconception worth being explicit about.
      { key: 'AWS_BEDROCK_API_KEY', label: 'AWS Bedrock API key (Bearer token from Bedrock console)', secret: true },
    ],
    extras: [
      { key: 'AWS_BEDROCK_REGION', label: 'AWS region', default: 'us-east-1' },
      { key: 'AWS_BEDROCK_MODEL_ID', label: 'Default model ID', default: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
    ],
    defaultModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
  vertex: {
    label: 'Google Vertex AI',
    local: false,
    creds: [
      { key: 'VERTEX_API_KEY', label: 'Vertex API key (or use ADC)', secret: true },
    ],
    extras: [],
    defaultModel: 'gemini-2.0-flash',
  },
  zai: {
    label: 'Z.ai (GLM family)',
    local: false,
    creds: [
      { key: 'ZAI_API_KEY', label: 'Z.ai API key', secret: true },
    ],
    extras: [],
    defaultModel: 'GLM-4.7',
  },
  moonshot: {
    label: 'Moonshot (Kimi family)',
    local: false,
    creds: [
      { key: 'MOONSHOT_API_KEY', label: 'Moonshot API key', secret: true },
    ],
    extras: [],
    defaultModel: 'kimi-k2-turbo-preview',
  },
};

const PROVIDER_ORDER = [
  'ollama', 'llamacpp', 'lmstudio',
  'azure-anthropic', 'azure-openai', 'openai', 'openrouter', 'edenai',
  'databricks', 'bedrock', 'vertex', 'zai', 'moonshot',
];
const TIERS = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

// Always-emitted baseline. Mirrors the production-grade config the maintainer
// runs locally: caching/compression on, generous policy budgets, sandboxed
// agents, MCP/web defaults, etc. Users can edit any of these post-generation;
// the wizard prompts only for tier picks, credentials, and a handful of
// intelligence knobs. Everything else is opinionated default.
//
// Categorised inline so future contributors know which group a key lives in.
const BASELINE_ENV = {
  // ── Databricks placeholders (satisfy startup validator) ───────────────
  DATABRICKS_API_BASE: 'http://localhost:8081',
  DATABRICKS_API_KEY: 'tier-routing-active',
  DATABRICKS_ENDPOINT_PATH: '/unused',

  // ── Server ────────────────────────────────────────────────────────────
  PORT: '8081',
  NODE_ENV: 'production',
  REQUEST_JSON_LIMIT: '1gb',
  SESSION_DB_PATH: './data/sessions.db',
  ENABLE_TOOL_SEARCH: 'true',
  LOG_LEVEL: 'silent',

  // ── Routing intelligence (tuned defaults) ─────────────────────────────
  LYNKR_PREFLIGHT_ENABLED: 'false',
  LYNKR_PREFLIGHT_TIMEOUT_MS: '120000',
  LYNKR_CASCADE_ENABLED: 'true',
  LYNKR_KNN_MIN_INDEX_SIZE: '200',
  LYNKR_KNN_CONFIDENCE_HIGH: '0.55',
  LYNKR_KNN_CONFIDENCE_LOW: '0.30',

  // ── Tool selection (routing signals) ──────────────────────────────────
  SMART_TOOL_SELECTION_MODE: 'disabled',
  SMART_TOOL_SELECTION_TOKEN_BUDGET: '2500',

  // ── Caching ───────────────────────────────────────────────────────────
  PROMPT_CACHE_ENABLED: 'true',
  PROMPT_CACHE_MAX_ENTRIES: '1000',
  PROMPT_CACHE_TTL_MS: '300000',
  SEMANTIC_CACHE_ENABLED: 'true',
  SEMANTIC_CACHE_THRESHOLD: '0.85',
  SEMANTIC_CACHE_MAX_ENTRIES: '50',
  SEMANTIC_CACHE_TTL_MS: '300000',

  // ── Compression: TOON + Headroom sidecar ──────────────────────────────
  TOON_ENABLED: 'true',
  TOON_MIN_BYTES: '4096',
  TOON_FAIL_OPEN: 'true',
  TOON_LOG_STATS: 'true',
  HEADROOM_ENABLED: 'true',
  HEADROOM_ENDPOINT: 'http://localhost:8787',
  HEADROOM_TIMEOUT_MS: '5000',
  HEADROOM_MIN_TOKENS: '100',
  HEADROOM_MODE: 'optimize',
  HEADROOM_PROVIDER: 'anthropic',
  HEADROOM_DOCKER_ENABLED: 'true',
  HEADROOM_DOCKER_IMAGE: 'lynkr/headroom-sidecar:latest',
  HEADROOM_DOCKER_CONTAINER_NAME: 'lynkr-headroom',
  HEADROOM_DOCKER_PORT: '8787',
  HEADROOM_DOCKER_AUTO_BUILD: 'true',
  HEADROOM_SMART_CRUSHER: 'true',
  HEADROOM_SMART_CRUSHER_MIN_TOKENS: '200',
  HEADROOM_SMART_CRUSHER_MAX_ITEMS: '15',
  HEADROOM_TOOL_CRUSHER: 'true',
  HEADROOM_CACHE_ALIGNER: 'true',
  HEADROOM_ROLLING_WINDOW: 'true',
  HEADROOM_KEEP_TURNS: '10',
  HEADROOM_CCR: 'true',
  HEADROOM_CCR_TTL: '300',

  // ── Memory + token tracking ───────────────────────────────────────────
  MEMORY_ENABLED: 'true',
  MEMORY_RETRIEVAL_LIMIT: '5',
  MEMORY_SURPRISE_THRESHOLD: '0.3',
  MEMORY_MAX_AGE_DAYS: '90',
  MEMORY_MAX_COUNT: '10000',
  MEMORY_EXTRACTION_ENABLED: 'true',
  MEMORY_DECAY_ENABLED: 'true',
  MEMORY_DECAY_HALF_LIFE: '30',
  MEMORY_FORMAT: 'compact',
  MEMORY_DEDUP_ENABLED: 'true',
  MEMORY_DEDUP_LOOKBACK: '5',
  MEMORY_TTL: '3600000',
  TOKEN_TRACKING_ENABLED: 'true',

  // ── Prompt/output shaping ─────────────────────────────────────────────
  SYSTEM_PROMPT_MODE: 'dynamic',
  TOOL_DESCRIPTIONS: 'minimal',
  HISTORY_COMPRESSION_ENABLED: 'true',
  HISTORY_KEEP_RECENT_TURNS: '10',
  HISTORY_SUMMARIZE_OLDER: 'true',
  TOKEN_BUDGET_WARNING: '100000',
  TOKEN_BUDGET_MAX: '180000',
  TOKEN_BUDGET_ENFORCEMENT: 'true',
  CAVEMAN_ENABLED: 'false',
  CAVEMAN_LEVEL: 'full',
  MARKDOWN_RENDER_ANSI: 'false',

  // ── Policy & budgets ──────────────────────────────────────────────────
  POLICY_MAX_STEPS: '2000',
  POLICY_MAX_TOOL_CALLS: '2000',
  POLICY_TOOL_LOOP_THRESHOLD: '100',
  POLICY_GIT_ALLOW_PUSH: 'false',
  POLICY_GIT_ALLOW_PULL: 'true',
  POLICY_GIT_ALLOW_COMMIT: 'true',
  POLICY_GIT_REQUIRE_TESTS: 'false',
  POLICY_GIT_AUTOSTASH: 'false',
  POLICY_FILE_BLOCKED_PATHS: '/.env,.env,/etc/passwd,/etc/shadow',
  POLICY_SAFE_COMMANDS_ENABLED: 'true',

  // ── Agents (delegation prompt injection; execution is client-side) ────
  AGENTS_ENABLED: 'true',

  // ── Rate limiting ─────────────────────────────────────────────────────
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX: '100',
  RATE_LIMIT_KEY_BY: 'session',

  // ── Hot reload + load shedding ────────────────────────────────────────
  HOT_RELOAD_ENABLED: 'true',
  HOT_RELOAD_DEBOUNCE_MS: '1000',
  LOAD_SHEDDING_ENABLED: 'true',
  LOAD_SHEDDING_HEAP_THRESHOLD: '0.85',
  LOAD_SHEDDING_MEMORY_THRESHOLD: '0.95',

  // ── Per-provider extras (secrets stay empty; wizard or user fills in) ─
  AZURE_ANTHROPIC_ENDPOINT: 'https://api.anthropic.com/v1/messages',
  AZURE_ANTHROPIC_VERSION: '2023-06-01',
  AZURE_OPENAI_API_VERSION: '2024-08-01-preview',
  OLLAMA_MODEL: 'minimax-m2.5:cloud',
  OLLAMA_TIMEOUT_MS: '120000',
  OLLAMA_EMBEDDINGS_MODEL: 'nomic-embed-text',
  OLLAMA_EMBEDDINGS_ENDPOINT: 'http://localhost:11434/api/embeddings',
  OPENROUTER_API_KEY: '',
  OPENROUTER_MODEL: 'openai/gpt-4o-mini',
  OPENROUTER_EMBEDDINGS_MODEL: 'openai/text-embedding-ada-002',
  OPENROUTER_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
  OPENROUTER_MAX_TOOLS_FOR_ROUTING: '15',
  EDENAI_API_KEY: '',
  EDENAI_MODEL: 'openai/gpt-4o-mini',
  EDENAI_EMBEDDINGS_MODEL: 'openai/text-embedding-ada-002',
  EDENAI_ENDPOINT: 'https://api.edenai.run/v3/chat/completions',
  MOONSHOT_API_KEY: '',
  MOONSHOT_ENDPOINT: 'https://api.moonshot.ai/v1/chat/completions',
  MOONSHOT_MODEL: 'kimi-k2.6',
  LLAMACPP_ENDPOINT: 'http://localhost:8080',
  LLAMACPP_MODEL: 'default',
  LLAMACPP_TIMEOUT_MS: '120000',
  LLAMACPP_EMBEDDINGS_ENDPOINT: 'http://localhost:8080/embeddings',
  LMSTUDIO_ENDPOINT: 'http://localhost:1234',
  LMSTUDIO_MODEL: 'default',
  LMSTUDIO_TIMEOUT_MS: '120000',

  // ── MCP sandbox (Docker-isolated MCP tool execution) ──────────────────
  MCP_SANDBOX_ENABLED: 'true',
  MCP_SANDBOX_RUNTIME: 'docker',
  MCP_SANDBOX_CONTAINER_WORKSPACE: '/workspace',
  MCP_SANDBOX_MOUNT_WORKSPACE: 'true',
  MCP_SANDBOX_ALLOW_NETWORKING: 'false',
  MCP_SANDBOX_NETWORK_MODE: 'none',
  MCP_SANDBOX_PASSTHROUGH_ENV: 'PATH,LANG,LC_ALL,TERM,HOME',
  MCP_SANDBOX_TIMEOUT_MS: '20000',
  MCP_SANDBOX_REUSE_SESSION: 'true',
  MCP_SANDBOX_READ_ONLY_ROOT: 'false',
  MCP_SANDBOX_NO_NEW_PRIVILEGES: 'true',
  MCP_SANDBOX_DROP_CAPABILITIES: 'ALL',
  MCP_SANDBOX_MEMORY_LIMIT: '512m',
  MCP_SANDBOX_CPU_LIMIT: '1.0',
  MCP_SANDBOX_PIDS_LIMIT: '100',
  MCP_SANDBOX_PERMISSION_MODE: 'auto',
  MCP_MANIFEST_DIRS: '~/.claude/mcp',

  // ── Web tools (search + fetch) ────────────────────────────────────────
  WEB_SEARCH_ENDPOINT: 'http://localhost:8888/search',
  WEB_SEARCH_ALLOW_ALL: 'true',
  WEB_SEARCH_TIMEOUT_MS: '10000',
  WEB_FETCH_BODY_PREVIEW_MAX: '10000',
  WEB_SEARCH_RETRY_ENABLED: 'true',
  WEB_SEARCH_MAX_RETRIES: '2',

  // ── TinyFish (web automation) ─────────────────────────────────────────
  TINYFISH_API_KEY: '',
  TINYFISH_ENDPOINT: 'https://agent.tinyfish.ai/v1/automation/run-sse',
  TINYFISH_BROWSER_PROFILE: 'lite',
  TINYFISH_TIMEOUT_MS: '120000',
  TINYFISH_PROXY_ENABLED: 'false',
  TINYFISH_PROXY_COUNTRY: 'US',

  // ── Workspace test runner ─────────────────────────────────────────────
  WORKSPACE_TEST_TIMEOUT_MS: '600000',
  WORKSPACE_TEST_SANDBOX: 'auto',
  WORKSPACE_TEST_COVERAGE_FILES: 'coverage/coverage-summary.json',
};

// ──────────────────────────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { force: false, dryRun: false, output: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--output=')) opts.output = a.slice('--output='.length);
    else if (a === '--output' || a === '-o') opts.output = argv[++i];
  }
  return opts;
}

function showHelp() {
  console.log(`lynkr init — interactive setup wizard

Usage:
  lynkr init                        Interactive wizard
  lynkr init --force                Overwrite existing .env
  lynkr init --output=<path>        Write to <path> instead of .env
  lynkr init --dry-run              Print to stdout, don't write
  lynkr init --help

The wizard asks for:
  1. Usage mode (Claude Pro/Max via wrap, or direct API keys)
  2. Provider + model for each tier (SIMPLE / MEDIUM / COMPLEX / REASONING)
  3. Credentials for each picked provider (re-used across tiers)
  4. Routing intelligence (visible badge, intent window, decay)

Providers covered: ${PROVIDER_ORDER.join(', ')}.
`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeAsker() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
  const close = () => rl.close();
  return { ask, close };
}

async function pickFromList(ask, label, choices, defaultIdx = 0) {
  console.log(`\n${label}`);
  choices.forEach((c, i) => {
    const marker = i === defaultIdx ? '>' : ' ';
    console.log(`  ${marker} ${i + 1}) ${c}`);
  });
  const raw = await ask(`Choice [1-${choices.length}] (default ${defaultIdx + 1}): `);
  if (!raw) return defaultIdx;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > choices.length) {
    console.log(`  → invalid, using default (${choices[defaultIdx]})`);
    return defaultIdx;
  }
  return n - 1;
}

async function askWithDefault(ask, label, defaultValue) {
  const v = await ask(`${label}${defaultValue ? ` [${defaultValue}]` : ''}: `);
  return v || defaultValue || '';
}

async function askYesNo(ask, label, defaultYes = true) {
  const v = await ask(`${label} [${defaultYes ? 'Y/n' : 'y/N'}]: `);
  if (!v) return defaultYes;
  return /^y(es)?$/i.test(v);
}

// ──────────────────────────────────────────────────────────────────────────────
// Wizard
// ──────────────────────────────────────────────────────────────────────────────

async function runInteractive(opts) {
  console.log('lynkr init — interactive setup\n');
  const { ask, close } = makeAsker();
  const env = {};
  const credsCollected = {}; // dedupe per env key

  try {
    // ── 1. Usage mode ──
    const modeIdx = await pickFromList(ask,
      'Usage mode:',
      [
        'Claude Pro/Max subscription (via `lynkr wrap claude`, OAuth passthrough)',
        'Direct API usage (pay-as-you-go with API keys)',
      ],
      0,
    );
    const isWrap = modeIdx === 0;

    if (isWrap) {
      env.LYNKR_OAUTH_PASSTHROUGH = 'true';
      console.log('\n  → OAuth passthrough enabled. COMPLEX/REASONING tiers will be sent');
      console.log('    byte-for-byte to api.anthropic.com against your subscription.');
      console.log('    You only need to configure a local model for SIMPLE/MEDIUM.\n');
    }

    // ── 2. Per-tier provider + model ──
    const tierConfig = {};
    const collectCreds = async (providerKey) => {
      const p = PROVIDERS[providerKey];
      for (const c of p.creds) {
        if (credsCollected[c.key]) continue;
        const existing = process.env[c.key];
        const def = existing || c.default || '';
        const prompt = `  ${c.label}${c.secret ? ' (hidden output not supported; paste anyway)' : ''}`;
        const v = await askWithDefault(ask, prompt, def);
        if (v) {
          env[c.key] = v;
          credsCollected[c.key] = true;
        }
      }
      for (const ex of p.extras) {
        if (env[ex.key]) continue;
        const v = await askWithDefault(ask, `  ${ex.label}`, ex.default);
        if (v) env[ex.key] = v;
      }
    };

    const providerChoices = PROVIDER_ORDER.map((k) => PROVIDERS[k].label);

    for (const tier of TIERS) {
      const headline = isWrap && (tier === 'COMPLEX' || tier === 'REASONING')
        ? `Tier ${tier} — covered by Pro/Max subscription, but you can override:`
        : `Tier ${tier} — pick a provider:`;
      const defaultIdx = isWrap && (tier === 'COMPLEX' || tier === 'REASONING')
        ? PROVIDER_ORDER.indexOf('azure-anthropic')
        : 0;

      const skipOpt = isWrap && (tier === 'COMPLEX' || tier === 'REASONING')
        ? [...providerChoices, 'Skip — let subscription passthrough handle it']
        : providerChoices;

      const idx = await pickFromList(ask, headline, skipOpt, defaultIdx);

      if (idx === providerChoices.length) {
        // Skip selected — leave TIER_<tier> unset
        continue;
      }

      const providerKey = PROVIDER_ORDER[idx];
      const p = PROVIDERS[providerKey];
      const model = await askWithDefault(ask, `  Model for ${tier}`, p.defaultModel);
      tierConfig[tier] = { provider: providerKey, model };
      await collectCreds(providerKey);
    }

    for (const tier of TIERS) {
      if (tierConfig[tier]) {
        env[`TIER_${tier}`] = `${tierConfig[tier].provider}:${tierConfig[tier].model}`;
      }
    }

    // Primary provider hint for legacy code paths
    const firstTier = TIERS.map((t) => tierConfig[t]).find(Boolean);
    if (firstTier) env.MODEL_PROVIDER = firstTier.provider;

    // ── 3. Routing intelligence ──
    console.log('\nRouting intelligence:');
    if (await askYesNo(ask, 'Show the routing badge in your TUI (`*[Lynkr] …*`)?', isWrap)) {
      env.LYNKR_VISIBLE_ROUTING = 'true';
    }

    const windowRaw = await askWithDefault(ask, 'Intent-scoring window size (1 = latest message only)', '5');
    const windowN = parseInt(windowRaw, 10);
    if (!Number.isNaN(windowN) && windowN >= 1) env.LYNKR_INTENT_WINDOW_N = String(windowN);

    const decayRaw = await askWithDefault(ask, 'Intent-scoring per-turn decay (0.1-1.0)', '0.7');
    const decay = parseFloat(decayRaw);
    if (!Number.isNaN(decay) && decay > 0 && decay <= 1) env.LYNKR_INTENT_DECAY = String(decay);

    close();
    console.log('');
    writeEnvFile(buildEnvContent(env, isWrap, tierConfig), opts);

    // ── Classifier bootstrap: detect ollama, pull model, warm-up ──
    // Runs AFTER .env is written so the classifier can read tier config
    // (currently uses hardcoded qwen2.5:3b, but leaves room for the future
    // fine-tuned model to plug in via SIMPLE tier or an env override).
    if (!opts.dryRun) {
      console.log('');
      console.log('Setting up the difficulty classifier…');
      try {
        const { ensureClassifierReady } = require('../src/routing/classifier-setup');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const prompt = (q) => new Promise((res) => rl.question(q, (a) => res(a)));
        const result = await ensureClassifierReady({
          mode: 'interactive',
          log: (m) => console.log(m),
          warn: (m) => console.warn(m),
          prompt,
        });
        rl.close();
        if (result.ready) {
          console.log('✓ Classifier ready.');
        } else if (result.reason === 'ollama_missing') {
          console.log('(Install Ollama and re-run `lynkr init` to enable the classifier — Lynkr will still start without it, using anchor-only scoring.)');
        } else {
          console.log(`(Classifier disabled: ${result.reason}. Lynkr will fall back to anchor-only scoring.)`);
        }
      } catch (err) {
        console.warn(`⚠ Classifier setup skipped: ${err.message}`);
      }
    }
  } catch (err) {
    close();
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Output
// ──────────────────────────────────────────────────────────────────────────────

function buildEnvContent(env, isWrap, tierConfig) {
  // Baseline first, user choices on top — so user input always wins for keys
  // they explicitly answered (e.g. LOG_LEVEL if the wizard ever asks for it).
  const merged = { ...BASELINE_ENV, ...env };

  const lines = [
    '# Lynkr configuration',
    `# Generated by 'lynkr init' at ${new Date().toISOString()}`,
    `# Mode: ${isWrap ? 'wrap (Claude Pro/Max subscription)' : 'direct API'}`,
    '# Edit directly to tweak; full reference in .env.example',
    '',
  ];

  // Group output by section in the order it appears in the generated file.
  // Mirrors the layout of the .env.example reference doc.
  const SERVER_KEYS = new Set(['PORT', 'NODE_ENV', 'REQUEST_JSON_LIMIT', 'SESSION_DB_PATH', 'WORKSPACE_ROOT', 'ENABLE_TOOL_SEARCH']);
  const TOOL_EXEC_KEYS = new Set(['SMART_TOOL_SELECTION_MODE', 'SMART_TOOL_SELECTION_TOKEN_BUDGET']);
  const CACHE_KEYS = new Set([
    'PROMPT_CACHE_ENABLED', 'PROMPT_CACHE_MAX_ENTRIES', 'PROMPT_CACHE_TTL_MS',
    'SEMANTIC_CACHE_ENABLED', 'SEMANTIC_CACHE_THRESHOLD', 'SEMANTIC_CACHE_MAX_ENTRIES', 'SEMANTIC_CACHE_TTL_MS',
  ]);
  const MEMORY_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('MEMORY_') || k === 'TOKEN_TRACKING_ENABLED'));
  const SHAPING_KEYS = new Set([
    'SYSTEM_PROMPT_MODE', 'TOOL_DESCRIPTIONS',
    'HISTORY_COMPRESSION_ENABLED', 'HISTORY_KEEP_RECENT_TURNS', 'HISTORY_SUMMARIZE_OLDER',
    'TOKEN_BUDGET_WARNING', 'TOKEN_BUDGET_MAX', 'TOKEN_BUDGET_ENFORCEMENT',
    'CAVEMAN_ENABLED', 'CAVEMAN_LEVEL', 'MARKDOWN_RENDER_ANSI',
  ]);
  const POLICY_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('POLICY_')));
  const AGENT_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('AGENTS_')));
  const RATE_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('RATE_LIMIT_')));
  const OPS_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('HOT_RELOAD_') || k.startsWith('LOAD_SHEDDING_')));
  const COMPRESSION_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('TOON_') || k.startsWith('HEADROOM_')));
  const MCP_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('MCP_')));
  const WEB_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('WEB_SEARCH_') || k.startsWith('WEB_FETCH_')));
  const TINYFISH_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('TINYFISH_')));
  const WORKSPACE_TEST_KEYS = new Set(Object.keys(merged).filter((k) => k.startsWith('WORKSPACE_TEST_')));

  const groups = [
    { heading: '# Tier routing',           keys: Object.keys(merged).filter((k) => k.startsWith('TIER_') || k === 'MODEL_PROVIDER') },
    { heading: '# Server',                 keys: Object.keys(merged).filter((k) => SERVER_KEYS.has(k)) },
    { heading: '# Provider credentials',   keys: Object.keys(merged).filter((k) =>
      /(_API_KEY|_ENDPOINT|_API_BASE|_DEPLOYMENT|_MODEL|_ENDPOINT_PATH|_API_VERSION|_VERSION|_TIMEOUT_MS|_EMBEDDINGS_MODEL|_EMBEDDINGS_ENDPOINT|_MAX_TOOLS_FOR_ROUTING)$/.test(k) &&
      !k.startsWith('LYNKR_') && !k.startsWith('HEADROOM_') && !k.startsWith('RATE_LIMIT_') &&
      !k.startsWith('HOT_RELOAD_') && !k.startsWith('LOAD_SHEDDING_') && !k.startsWith('AGENTS_') &&
      !k.startsWith('MCP_') && !k.startsWith('WEB_') && !k.startsWith('TINYFISH_') && !k.startsWith('WORKSPACE_TEST_') &&
      !k.startsWith('NODE_') && !k.startsWith('TOON_')
    ) },
    { heading: '# Routing intelligence',   keys: Object.keys(merged).filter((k) => k.startsWith('LYNKR_')) },
    { heading: '# Tool execution',         keys: Object.keys(merged).filter((k) => TOOL_EXEC_KEYS.has(k)) },
    { heading: '# Caching',                keys: Object.keys(merged).filter((k) => CACHE_KEYS.has(k)) },
    { heading: '# Compression & context',  keys: Object.keys(merged).filter((k) => COMPRESSION_KEYS.has(k)) },
    { heading: '# Memory & tracking',      keys: Object.keys(merged).filter((k) => MEMORY_KEYS.has(k)) },
    { heading: '# Prompt & output shaping', keys: Object.keys(merged).filter((k) => SHAPING_KEYS.has(k)) },
    { heading: '# Policy & budgets',       keys: Object.keys(merged).filter((k) => POLICY_KEYS.has(k)) },
    { heading: '# Agents',                 keys: Object.keys(merged).filter((k) => AGENT_KEYS.has(k)) },
    { heading: '# Rate limiting',          keys: Object.keys(merged).filter((k) => RATE_KEYS.has(k)) },
    { heading: '# MCP sandbox',            keys: Object.keys(merged).filter((k) => MCP_KEYS.has(k)) },
    { heading: '# Web tools',              keys: Object.keys(merged).filter((k) => WEB_KEYS.has(k)) },
    { heading: '# TinyFish (web automation)', keys: Object.keys(merged).filter((k) => TINYFISH_KEYS.has(k)) },
    { heading: '# Workspace test runner',  keys: Object.keys(merged).filter((k) => WORKSPACE_TEST_KEYS.has(k)) },
    { heading: '# Ops (hot reload, load shedding)', keys: Object.keys(merged).filter((k) => OPS_KEYS.has(k)) },
    { heading: '# Logging',                keys: ['LOG_LEVEL'].filter((k) => k in merged) },
  ];

  const seen = new Set();
  for (const g of groups) {
    if (!g.keys.length) continue;
    lines.push(g.heading);
    for (const k of g.keys) {
      if (seen.has(k)) continue;
      lines.push(`${k}=${merged[k]}`);
      seen.add(k);
    }
    lines.push('');
  }

  // Catch-all for any other keys (e.g. _DEPLOYMENT defaults) we missed.
  const remaining = Object.keys(merged).filter((k) => !seen.has(k));
  if (remaining.length) {
    lines.push('# Other');
    for (const k of remaining) lines.push(`${k}=${merged[k]}`);
    lines.push('');
  }

  return lines.join('\n');
}

function writeEnvFile(content, opts) {
  if (opts.dryRun) {
    process.stdout.write(content);
    return;
  }
  const target = opts.output || path.join(process.cwd(), '.env');
  if (fs.existsSync(target) && !opts.force) {
    console.error(`✗ ${target} already exists. Use --force to overwrite, or --output=<path>.`);
    process.exit(1);
  }
  fs.writeFileSync(target, content);
  console.log(`✓ Wrote ${target}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return showHelp();

  if (!process.stdin.isTTY) {
    console.error('✗ lynkr init needs an interactive TTY.');
    console.error('  If you need a non-interactive setup, copy .env.example to .env manually,');
    console.error('  or run `lynkr init --dry-run` to preview the wizard prompts.');
    process.exit(1);
  }

  return runInteractive(opts);
}

// Run when invoked directly (`node bin/lynkr-init.js`) or dispatched from
// cli.js (which sets _LYNKR_SUBCMD). Stay quiet when require()'d by tests.
if (require.main === module || process.env._LYNKR_SUBCMD === 'init') {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  PROVIDERS,
  PROVIDER_ORDER,
  TIERS,
  parseArgs,
  buildEnvContent,
};
