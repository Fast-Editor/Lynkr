/**
 * Client Profiles (WS3.1).
 *
 * Client harnesses like Claude Code, Cursor, and Codex attach a large
 * baseline tool loadout to EVERY request (Claude Code sends ~11 tools
 * unconditionally). The old agentic detector inflated `tool_count` and
 * `agentic_tool` signals from those baselines, mis-classifying a trivial
 * "hi" as an agentic COMPLEX-tier workload.
 *
 * The `slice(0, 3)` hack in `src/api/router.js` worked around that in one
 * specific spot for one specific client — but it also discarded real MCP
 * tools the user had configured, and did nothing for Cursor / Codex.
 *
 * This module fixes the root cause. Given a request's `user-agent` (or
 * `x-client`) header and its tools list, `detectClient` returns the matching
 * profile (or null), and `effectiveTools` subtracts the baseline so the
 * agentic detector scores only tools the user actually added beyond the
 * harness default.
 *
 * A profile may also carry behaviour flags the ingress routers read:
 *   - `toolless: true`     — the client never sends tools; src/api/router.js
 *                            uses it to tell harness side-traffic from plain
 *                            API clients.
 *   - `injectTools: false` — the OpenAI-compat routers must NOT inject
 *                            IDE_SAFE_TOOLS for this client. App harnesses
 *                            such as OpenMausBot execute only the tools they
 *                            sent; an injected tool_call comes back to them
 *                            as a failed turn. See `vetoesToolInjection`.
 *   - `compressToolResults: false` — the orchestrator must NOT run the
 *                            RTK-style tool-result compressor on this
 *                            client's history. It was built for shell output
 *                            a coding agent can re-run; an app harness's tool
 *                            results are the data itself, and the harness may
 *                            append its own paging notice that the compressor
 *                            would delete. See `vetoesToolResultCompression`.
 *
 * @module routing/client-profiles
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

/**
 * Seed profiles. Baseline tool lists must exactly match the tool NAMES the
 * client sends (case-sensitive) — the agentic detector reads
 * `t.name || t.function?.name`, so these are the tools that ship in the
 * harness's default `tools` array.
 *
 * Claude Code's default loadout was verified against the live proxy request
 * shape at time of writing (2026-07). If a future release adds/renames a
 * tool, add it here (or override via data/client-profiles.json).
 */
const PROFILES = {
  'terminus': {
    name: 'terminus',
    toolless: true,
    baselineTools: new Set(),
    detect: {
      headerPatterns: [],
      promptPatterns: [/You are an AI assistant tasked with solving command-line tasks/i],
      minToolFingerprintMatch: 1,
    },
  },
  'claude-code': {
    name: 'claude-code',
    baselineTools: new Set([
      'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
      'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
      'BashOutput', 'KillShell', 'SlashCommand',
    ]),
    detect: {
      // Claude Code CLI actually sends `user-agent: claude-cli/x.y.z` (not
      // claude-code/x.y.z as the tests assumed). Match every Anthropic-side
      // subscription client — same set as auth-mode.js's
      // SUBSCRIPTION_UA_PREFIXES, kept in sync manually since the two files
      // want slightly different match rules.
      headerPatterns: [
        /claude[-_](cli|code|vscode)/i,
        /anthropic-cli/i,
      ],
      minToolFingerprintMatch: 0.8,
    },
  },
  'cursor': {
    name: 'cursor',
    baselineTools: new Set([
      // Cursor's default agent loadout
      'read_file', 'write_file', 'edit_file', 'delete_file',
      'run_terminal_command', 'grep_search', 'file_search', 'codebase_search',
      'web_search', 'list_dir',
    ]),
    detect: {
      headerPatterns: [/cursor/i],
      minToolFingerprintMatch: 0.8,
    },
  },
  'lynkr-injected': {
    name: 'lynkr-injected',
    baselineTools: new Set([
      // Lynkr's own IDE_SAFE_TOOLS loadout (src/clients/standard-tools.js).
      // Until 2026-10 the OpenAI-compat routers injected it into every
      // tool-less request from an unrecognized client; they now inject only
      // for clients with a CLIENT_TOOL_MAPPINGS entry (codex, cline, kilo,
      // continue), filtered to the mapped names. The profile stays so a
      // request that does carry this loadout — a mapped client, or a caller
      // replaying one — is still read as Lynkr plumbing, not user intent:
      // otherwise the agentic detector floors it at ITERATIVE/COMPLEX.
      // Matches claude-code's names plus the four (MultiEdit, LS,
      // NotebookRead, WebAgent) that keep it from fingerprinting as claude-code.
      'Write', 'Read', 'Edit', 'Bash', 'Glob', 'Grep', 'MultiEdit', 'LS',
      'NotebookRead', 'TodoWrite', 'Task', 'WebSearch', 'WebFetch',
      'WebAgent', 'NotebookEdit',
    ]),
    detect: {
      headerPatterns: [],
      minToolFingerprintMatch: 0.8,
    },
  },
  'goose': {
    name: 'goose',
    baselineTools: new Set([
      // Goose CLI 1.41 default loadout — captured live 2026-07-13 against
      // the OpenAI-compatible endpoint. Goose sends NO user-agent header,
      // so detection relies entirely on this tool fingerprint. The apps__*,
      // extensionmanager__* and todo__* names come from goose's default
      // extensions; the rest are core tools that attach to every request.
      'analyze', 'delegate', 'edit', 'load', 'load_skill', 'read_image',
      'shell', 'tree', 'write',
      'apps__create_app', 'apps__delete_app', 'apps__iterate_app',
      'apps__list_apps',
      'extensionmanager__list_resources', 'extensionmanager__manage_extensions',
      'extensionmanager__read_resource',
      'extensionmanager__search_available_extensions',
      'todo__todo_write',
    ]),
    detect: {
      headerPatterns: [/goose/i],
      // 0.5 rather than the usual 0.8: users can disable goose's default
      // extensions (apps, extensionmanager, todo), which removes up to 9 of
      // the 18 baseline names while the 9 core tools still identify goose.
      // A false-positive match on another harness with this many identical
      // tool names would subtract only those shared names — harmless.
      minToolFingerprintMatch: 0.5,
    },
  },
  'opencode': {
    name: 'opencode',
    baselineTools: new Set([
      // OpenCode 1.18.x default loadout — captured live 2026-08-22 from
      // Lynkr logs (user-agent `opencode/1.18.21 ai-sdk/provider-utils/…`).
      // All of these attach to every request; counting them as intent
      // scored every OpenCode turn ~80 → REASONING band → session pin
      // locked the whole session there (2026-08-22: 1163/1203 REASONING
      // routings were pin-inherited from a floored first turn).
      'bash', 'edit', 'glob', 'grep', 'question', 'read', 'skill', 'task',
      'todowrite', 'webfetch', 'write',
      // Per opencode.ai/docs/tools — enabled-by-default or common-config
      // names not seen in our capture; harmless if absent (subtraction
      // only removes names actually present).
      'list', 'todoread', 'websearch',
    ]),
    detect: {
      headerPatterns: [/opencode/i],
      // 0.5 (like goose): `question`/`skill`/`todo*` vary with user config,
      // so a minimal loadout matches ~8 of 14 baseline names. The lowercase
      // set is disjoint from claude-code's capitalized and cursor's
      // snake_case names, and opencode always sends its user-agent, so the
      // header pattern is the primary detector anyway.
      minToolFingerprintMatch: 0.5,
    },
  },
  'openai-codex': {
    name: 'openai-codex',
    baselineTools: new Set([
      // Legacy Codex CLI (and Lynkr's injected fallback names)
      'shell', 'apply_patch', 'read_file', 'write_file',
      // Codex v0.142+ (Rust CLI) default loadout — captured live 2026-07-11.
      // All of these attach to EVERY request, including "Hi": counting them
      // as agentic intent floored every Codex turn at MEDIUM.
      'exec_command', 'write_stdin', 'update_plan', 'request_user_input',
      'view_image', 'get_goal', 'create_goal', 'update_goal',
      'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
      'list_available_plugins_to_install', 'request_plugin_install',
    ]),
    detect: {
      headerPatterns: [/codex/i, /openai-cli/i],
      minToolFingerprintMatch: 0.8,
    },
  },
  'open-code-review': {
    name: 'open-code-review',
    baselineTools: new Set([
      // Alibaba open-code-review focused review toolset —
      // internal/tool/definitions.go: task_done, code_comment, file_read,
      // file_read_diff (+ search variants). These attach to every review
      // bundle by design; counting them as agentic intent would floor every
      // bundle at ITERATIVE/COMPLEX even for a 10-line typo fix. Real
      // complexity still comes through diff size + file_read chains.
      'task_done', 'code_comment', 'file_read', 'file_read_diff',
    ]),
    detect: {
      // UA shape: `open-code-review/<ver> | <provider>` (internal/llm/client.go
      // userAgent). Fingerprint fallback at 0.5: minimal bundles may carry
      // only code_comment + task_done.
      headerPatterns: [/open-code-review/i],
      minToolFingerprintMatch: 0.5,
    },
  },
  'openmausbot': {
    name: 'openmausbot',
    // OpenMausBot (github.com/milind-soni/OpenMausBot) is a messaging app
    // whose bots run as `openai-compat` engines against /v1/chat/completions
    // (server/drivers/openai-chat.ts). It executes ONLY the tools it sent —
    // its own harness (ask_user + whichever MCP servers the bot mounted) —
    // and omits the `tools` key entirely when a bot has none. Without this
    // profile a tool-less bot got the full IDE_SAFE_TOOLS loadout injected
    // (the router only treats an *array* as an opt-out), fingerprinted as
    // lynkr-injected, and the first Read/Bash call came back as "provider
    // returned tool calls, but no tools are available for this turn".
    injectTools: false,
    // OpenMausBot truncates oversized tool results itself and appends a
    // notice carrying a saved result id + offset for agents_tool_result_read.
    // Lynkr's compressJSON rewrote a 15 KB Composio result to a 111-char key
    // skeleton (2026-10-14), deleting that notice; the model then paged with
    // a bad id and OpenMausBot failed the turn. Its tool results are data,
    // not re-runnable command output — leave them intact.
    compressToolResults: false,
    baselineTools: new Set([
      // Attached whenever the bot may ask the user a question
      // (shared/ask-question.ts, pushed in openai-chat.ts).
      'ask_user',
      // The built-in "agents" MCP server (server/drivers/agents-catalog.ts),
      // mounted by chat-mcp-tools.ts as `agents_<tool>`. Bot-scoped core
      // loadout as of OpenMausBot 0.1.110; the feature-gated names (skills_*,
      // shared computers, send_voice_note, chief-only, vm_exec on cloud
      // homes) are left out — subtraction only removes names present.
      'agents_tool_result_read', 'agents_list_room_targets',
      'agents_coordinate_bots', 'agents_assignment_status',
      'agents_list_bots', 'agents_list_rooms', 'agents_select_computer',
      'agents_list_threads', 'agents_close_thread', 'agents_start_thread',
      'agents_attach_file', 'agents_post_to_room',
      'agents_request_credential', 'agents_request_sign_in',
      'agents_fill_login', 'agents_memory_update', 'agents_memory_log',
      'agents_session_search', 'agents_session_read',
      'agents_list_routines', 'agents_propose_routine',
      'agents_propose_routine_action', 'agents_propose_profile',
      'agents_propose_model', 'agents_propose_team_memory',
      'agents_add_mcp_server',
    ]),
    detect: {
      // OpenMausBot 0.1.x sends NO user-agent and no x-client header (its
      // fetch sets only authorization + content-type), so today detection
      // rests on the tool fingerprint and the prompt marker below. The
      // header pattern is for a release that identifies itself, or an
      // operator fronting the app with an `x-client: openmausbot` header.
      headerPatterns: [/openmausbot/i],
      // The app prepends a context note to the user turn whenever its
      // volatile prompt sections changed (server/drivers/prompt-split.ts).
      // Not on every turn, but the only stable "OpenMausBot" text a
      // tool-less bot ever sends — best-effort, never a false positive.
      promptPatterns: [
        /Context from OpenMausBot updated since this conversation started/i,
        /OpenMausBot context notes from earlier in this conversation/i,
      ],
      // 0.5: memory can be off (-2 names), a non-chief bot sees the same
      // propose_* names, and a bot whose agents server is unmounted sends
      // just ask_user and will not match — correct: with tools present there
      // is no injection to veto and nothing of ours to subtract.
      minToolFingerprintMatch: 0.5,
    },
  },
};

// Union of every baseline tool across all known profiles — used for the
// "no-profile-but-looks-like-a-harness" heuristic guard.
let _knownBaselineToolsCache = null;
function _knownBaselineTools() {
  if (_knownBaselineToolsCache) return _knownBaselineToolsCache;
  const s = new Set();
  for (const p of Object.values(PROFILES)) {
    for (const t of p.baselineTools) s.add(t);
  }
  _knownBaselineToolsCache = s;
  return s;
}

// User overrides / additions from data/client-profiles.json — loaded once
// at first use. Shape:
//   { profileName: { baselineTools: [...], headerPatterns: [...],
//                    promptPatterns: [...], minToolFingerprintMatch: 0.8,
//                    toolless: false, injectTools: true,
//                    compressToolResults: true } }
// Every key is optional. An omitted key keeps the seed profile's value (or
// the default for a brand-new name), so overriding one field — say, a newer
// baseline for openmausbot — never silently drops its injectTools veto.
let _userProfilesLoaded = false;
function _loadUserProfiles() {
  if (_userProfilesLoaded) return;
  _userProfilesLoaded = true;
  const overridePath = path.join(process.cwd(), 'data', 'client-profiles.json');
  if (!fs.existsSync(overridePath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    for (const [name, def] of Object.entries(raw || {})) {
      if (!def || typeof def !== 'object') continue;
      const seed = PROFILES[name];
      const baseline = Array.isArray(def.baselineTools)
        ? new Set(def.baselineTools)
        : seed?.baselineTools ?? new Set();
      const patterns = Array.isArray(def.headerPatterns)
        ? def.headerPatterns.map((p) => new RegExp(p, 'i'))
        : seed?.detect?.headerPatterns ?? [];
      const promptPatterns = Array.isArray(def.promptPatterns)
        ? def.promptPatterns.map((p) => new RegExp(p, 'i'))
        : seed?.detect?.promptPatterns ?? [];
      const flag = (key) => (typeof def[key] === 'boolean' ? def[key] : seed?.[key]);
      const toolless = flag('toolless');
      const injectTools = flag('injectTools');
      const compressToolResults = flag('compressToolResults');
      PROFILES[name] = {
        name,
        ...(toolless === undefined ? {} : { toolless }),
        ...(injectTools === undefined ? {} : { injectTools }),
        ...(compressToolResults === undefined ? {} : { compressToolResults }),
        baselineTools: baseline,
        detect: {
          headerPatterns: patterns,
          promptPatterns,
          minToolFingerprintMatch: Number.isFinite(def.minToolFingerprintMatch)
            ? def.minToolFingerprintMatch
            : seed?.detect?.minToolFingerprintMatch ?? 0.8,
        },
      };
    }
    _knownBaselineToolsCache = null; // recompute after overrides
    logger.debug({ count: Object.keys(raw).length }, '[ClientProfiles] Loaded user overrides');
  } catch (err) {
    logger.debug({ err: err.message }, '[ClientProfiles] Failed to load user overrides');
  }
}

function _toolName(t) {
  return (t && (t.name || t.function?.name)) || null;
}

/**
 * Detect the client harness that issued this request.
 *
 * Match order:
 *   1. user-agent header regex — strongest signal, cheap.
 *   2. x-client / x-client-name header regex — same patterns; lets a client
 *      (or an operator fronting one) name itself when it cannot set a UA.
 *   3. First user message vs. the profile's promptPatterns.
 *   4. Tool-set fingerprint — ≥ minToolFingerprintMatch (default 80%) of the
 *      profile's baseline tool names must be present in payload.tools.
 *
 * @param {Object} args
 * @param {Object} [args.headers]
 * @param {Object} [args.payload]
 * @returns {Object|null} The matched profile or null.
 */
function detectClient({ headers = {}, payload = {} } = {}) {
  _loadUserProfiles();

  const ua = String(headers['user-agent'] || headers['User-Agent'] || '');
  const xClient = String(
    headers['x-client'] || headers['X-Client']
    || headers['x-client-name'] || headers['X-Client-Name'] || ''
  );
  for (const header of [ua, xClient]) {
    if (!header) continue;
    for (const profile of Object.values(PROFILES)) {
      for (const pattern of (profile.detect?.headerPatterns || [])) {
        try {
          if (pattern.test(header)) return profile;
        } catch (err) {
          logger.warn({ profile: profile.name, pattern: String(pattern), err: err.message }, 'Client profile header pattern failed');
        }
      }
    }
  }

  const firstUser = Array.isArray(payload.messages) ? payload.messages.find((m) => m?.role === 'user') : null;
  if (firstUser) {
    const txt = typeof firstUser.content === 'string' ? firstUser.content
      : Array.isArray(firstUser.content) ? firstUser.content.filter((b) => b?.type === 'text').map((b) => b.text || '').join(' ') : '';
    if (txt) {
      for (const profile of Object.values(PROFILES)) {
        for (const pattern of (profile.detect.promptPatterns || [])) {
          if (pattern.test(txt)) return profile;
        }
      }
    }
  }
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.length === 0) return null;

  const presentNames = new Set(tools.map(_toolName).filter(Boolean));
  let best = null;
  let bestRatio = 0;
  for (const profile of Object.values(PROFILES)) {
    const baseline = profile.baselineTools;
    if (baseline.size === 0) continue;
    let hits = 0;
    for (const name of baseline) {
      if (presentNames.has(name)) hits++;
    }
    const ratio = hits / baseline.size;
    if (ratio >= profile.detect.minToolFingerprintMatch && ratio > bestRatio) {
      best = profile;
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * Return the tools in `payload.tools` that are NOT part of `profile`'s
 * baseline loadout — i.e., the tools the user actually configured beyond
 * the harness default. If profile is null, returns the raw list.
 *
 * The array preserves the original tool objects (not just names) so the
 * agentic detector can still inspect `t.name || t.function?.name`.
 *
 * @param {Object} payload
 * @param {Object|null} profile
 * @returns {Array}
 */
function effectiveTools(payload, profile) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  if (!profile) return tools.slice();
  const baseline = profile.baselineTools;
  return tools.filter((t) => {
    const name = _toolName(t);
    return name && !baseline.has(name);
  });
}

/**
 * True when every tool name in the payload is present in some known profile's
 * baseline. Used by the agentic detector's "unknown harness" guard so a
 * Claude-Code-alike client that omits its user-agent doesn't inflate the
 * agentic score.
 *
 * @param {Object} payload
 * @returns {boolean}
 */
function allToolsAreBaseline(payload) {
  _loadUserProfiles();
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  if (tools.length === 0) return false;
  const known = _knownBaselineTools();
  for (const t of tools) {
    const name = _toolName(t);
    if (!name || !known.has(name)) return false;
  }
  return true;
}

/**
 * True when the detected profile says the client executes only the tools it
 * sent, so the OpenAI-compat routers must not inject IDE_SAFE_TOOLS for it.
 * A null / unrecognized profile never vetoes — injection for unrecognized
 * tool-less clients is unchanged.
 *
 * @param {Object|null} profile
 * @returns {boolean}
 */
function vetoesToolInjection(profile) {
  return !!profile && profile.injectTools === false;
}

/**
 * True when the detected profile says this client's tool results must reach
 * the model unmodified, so the orchestrator skips the tool-result compressor
 * for the request. A null / unrecognized profile never vetoes.
 *
 * @param {Object|null} profile
 * @returns {boolean}
 */
function vetoesToolResultCompression(profile) {
  return !!profile && profile.compressToolResults === false;
}

/** Test helper — clear cached override state (unit tests reload from disk). */
function _resetForTests() {
  _userProfilesLoaded = false;
  _knownBaselineToolsCache = null;
}

module.exports = {
  PROFILES,
  detectClient,
  effectiveTools,
  allToolsAreBaseline,
  vetoesToolInjection,
  vetoesToolResultCompression,
  _resetForTests,
};
