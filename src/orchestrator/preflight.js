/**
 * Preflight Checks
 *
 * Runs user-supplied commands before invoking the model. If they all
 * exit 0, the work is already done — we skip the LLM call entirely
 * and return a synthetic "preflight_satisfied" response at zero cost.
 *
 * Typical use case: a fix-the-failing-test request that arrives after
 * the test already passes (CI lag, retry-after-fix, idempotent agent
 * retries). CodexSaver's WorkPacketRuntime.preflight_checks pioneered
 * this pattern:
 * https://github.com/fendouai/CodexSaver/blob/main/codexsaver/work_packet.py
 *
 * The request opts in by including a top-level `preflight_commands`
 * array on the Anthropic-format payload, e.g.:
 *
 *   {
 *     "model": "...",
 *     "messages": [...],
 *     "preflight_commands": ["pnpm test -- user-service"]
 *   }
 *
 * Disabled by default — gated on LYNKR_PREFLIGHT_ENABLED=true. The
 * commands run with the same permissions as the Lynkr server, so
 * operators should only enable this on workspaces where that is OK.
 *
 * @module orchestrator/preflight
 */

const { spawnSync } = require('child_process');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

const MAX_COMMANDS = 10;
const MAX_OUTPUT_BYTES = 4000;

/**
 * Extract the preflight command list from a request payload.
 * Accepts either `preflight_commands` (Lynkr-specific) or
 * `metadata.lynkr_preflight_commands` (for clients that strip unknown
 * top-level fields).
 *
 * @param {object} payload
 * @returns {string[]}
 */
function extractCommands(payload) {
  if (!payload) return [];
  const raw =
    payload.preflight_commands ||
    payload.metadata?.lynkr_preflight_commands ||
    [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(cmd => typeof cmd === 'string' && cmd.trim().length > 0)
    .slice(0, MAX_COMMANDS);
}

/**
 * Resolve the workspace path for command execution. Falls back to
 * process.cwd() if no workspace is supplied (the caller should usually
 * pass one explicitly).
 *
 * @param {string|null|undefined} cwd
 * @returns {string|null} absolute path, or null if invalid
 */
function resolveCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  if (!path.isAbsolute(cwd)) return null;
  return cwd;
}

/**
 * Run a single command, returning a structured result.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {{ command: string, exit_code: number|null, stdout: string, stderr: string, timed_out: boolean }}
 */
function runCommand(command, cwd, timeoutMs) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command,
    exit_code: result.status,
    stdout: (result.stdout || '').slice(-MAX_OUTPUT_BYTES),
    stderr: (result.stderr || '').slice(-MAX_OUTPUT_BYTES),
    timed_out: result.signal === 'SIGTERM',
  };
}

/**
 * Try the preflight pass. Returns null when preflight should be
 * skipped (disabled, no commands, missing cwd). Returns a result
 * object otherwise.
 *
 * @param {object} args
 * @param {object} args.payload - Anthropic-format request payload
 * @param {string} [args.cwd] - Workspace cwd (absolute path)
 * @returns {null | {
 *   satisfied: boolean,
 *   results: object[],
 *   failedCommand: string|null,
 *   reason: string,
 * }}
 */
function tryPreflight({ payload, cwd }) {
  if (!config.routing?.preflightEnabled) return null;
  const commands = extractCommands(payload);
  if (commands.length === 0) return null;
  const workspaceCwd = resolveCwd(cwd);
  if (!workspaceCwd) {
    logger.debug({ cwd }, '[Preflight] No valid cwd, skipping');
    return null;
  }

  const timeoutMs = config.routing?.preflightTimeoutMs || 120000;
  const results = [];
  for (const command of commands) {
    const r = runCommand(command, workspaceCwd, timeoutMs);
    results.push(r);
    if (r.exit_code !== 0) {
      return {
        satisfied: false,
        results,
        failedCommand: command,
        reason: r.timed_out
          ? `Preflight command timed out: ${command}`
          : `Preflight command exited ${r.exit_code}: ${command}`,
      };
    }
  }
  return {
    satisfied: true,
    results,
    failedCommand: null,
    reason: 'All preflight commands passed.',
  };
}

/**
 * Build a synthetic "preflight satisfied" Anthropic Message response
 * that processMessage can return without hitting the model.
 *
 * @param {object} args
 * @param {string} args.model
 * @param {object} args.preflightResult
 * @returns {object} The full processMessage return value.
 */
function buildSatisfiedResponse({ model, preflightResult }) {
  const summary = `Preflight satisfied — work appears already complete (${preflightResult.results.length} command${preflightResult.results.length === 1 ? '' : 's'} passed).`;
  return {
    response: {
      json: {
        id: `msg_preflight_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: summary }],
        model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        lynkr_preflight: {
          satisfied: true,
          reason: preflightResult.reason,
          results: preflightResult.results,
        },
      },
      ok: true,
      status: 200,
    },
    steps: 0,
    durationMs: 0,
    terminationReason: 'preflight_satisfied',
  };
}

module.exports = {
  tryPreflight,
  buildSatisfiedResponse,
  extractCommands,
  // Exposed for tests
  resolveCwd,
};
