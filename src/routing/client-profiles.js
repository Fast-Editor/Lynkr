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
 * This module fixes the root cause. Given a request's `user-agent` header
 * and its tools list, `detectClient` returns the matching profile (or null),
 * and `effectiveTools` subtracts the baseline so the agentic detector scores
 * only tools the user actually added beyond the harness default.
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
  'openai-codex': {
    name: 'openai-codex',
    baselineTools: new Set([
      // Codex CLI's default shell/apply tools
      'shell', 'apply_patch', 'read_file', 'write_file',
    ]),
    detect: {
      headerPatterns: [/codex/i, /openai-cli/i],
      minToolFingerprintMatch: 0.8,
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
// at first use. Shape: { profileName: { baselineTools: [...], detect: {...} } }
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
      const baseline = Array.isArray(def.baselineTools)
        ? new Set(def.baselineTools)
        : PROFILES[name]?.baselineTools ?? new Set();
      const patterns = Array.isArray(def.headerPatterns)
        ? def.headerPatterns.map((p) => new RegExp(p, 'i'))
        : PROFILES[name]?.detect?.headerPatterns ?? [];
      PROFILES[name] = {
        name,
        baselineTools: baseline,
        detect: {
          headerPatterns: patterns,
          minToolFingerprintMatch: Number.isFinite(def.minToolFingerprintMatch)
            ? def.minToolFingerprintMatch
            : 0.8,
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
 *   2. Tool-set fingerprint — ≥ minToolFingerprintMatch (default 80%) of the
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
  if (ua) {
    for (const profile of Object.values(PROFILES)) {
      for (const pattern of profile.detect.headerPatterns) {
        if (pattern.test(ua)) return profile;
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
  _resetForTests,
};
