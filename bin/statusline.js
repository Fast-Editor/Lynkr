#!/usr/bin/env node
/**
 * lynkr statusline — zero-token Claude Code status line.
 *
 * Wire into ~/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "lynkr-statusline" }
 *
 * Claude Code pipes session JSON on stdin after each turn. This command:
 *  - never enters model context (out-of-band — an in-loop MCP integration
 *    was measured at +36% model-weighted tokens by TokenJam; don't do that)
 *  - makes ONE local HTTP call to the Lynkr dashboard API with a hard
 *    250ms timeout
 *  - always exits 0 and always prints exactly one line, no matter what
 *    fails — a broken status line must never break the harness.
 *
 * Output: ◆ <model> · <tier> → <served model> (<provider>)[ · pin] · today $X · cache NN%
 */

'use strict';

const PORT = Number(process.env.LYNKR_PORT) || Number(process.env.PORT) || 8081;
const TIMEOUT_MS = 250;

function readStdin(maxMs) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), maxMs);
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

async function fetchStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/dashboard/api/statusline`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const [stdinRaw, status] = await Promise.all([readStdin(150), fetchStatus()]);

  let clientModel = null;
  try {
    const parsed = JSON.parse(stdinRaw);
    clientModel = parsed?.model?.display_name || parsed?.model?.id || null;
  } catch { /* stdin absent or non-JSON — fine */ }

  const parts = [];
  if (clientModel) parts.push(clientModel);

  if (status?.last) {
    const served = `${status.last.tier || '?'} → ${status.last.model || '?'} (${status.last.provider || '?'})`;
    parts.push(served + (status.last.pinned ? ' · pin' : ''));
  } else {
    parts.push('lynkr: no traffic yet');
  }
  if (status && typeof status.todaySpendUsd === 'number') {
    parts.push(`today $${status.todaySpendUsd.toFixed(2)}`);
  }
  if (status && typeof status.cacheReadPct === 'number') {
    parts.push(`cache ${status.cacheReadPct}%`);
  }

  process.stdout.write('◆ ' + parts.join(' · ') + '\n');
}

main()
  .catch(() => { process.stdout.write('◆ lynkr statusline unavailable\n'); })
  .finally(() => process.exit(0));
