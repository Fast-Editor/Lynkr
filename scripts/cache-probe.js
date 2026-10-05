#!/usr/bin/env node
/**
 * Prompt-cache probe: does each configured OpenRouter host actually serve
 * cache hits, and what does warm vs cold cost in time?
 *
 * Sends the same ~3k-token prefix twice to every (model, host) pair from
 * OPENROUTER_PROVIDER_ORDER_MAP (or --model/--host), reports cached_tokens,
 * cache price, TTFT-ish latency for both calls, and the provider-billed cost.
 *
 * Usage: node scripts/cache-probe.js [--model <id> --host <name>]... [--prefix-tokens 3000]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

async function main() {
  const envPath = fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : path.join(os.homedir(), '.env');
  require('dotenv').config({ path: envPath });
  const KEY = process.env.OPENROUTER_API_KEY;
  if (!KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(2); }
  const argv = process.argv.slice(2);
  const pairs = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--model') pairs.push({ model: argv[++i], host: argv[i + 1] === '--host' ? argv[(i += 2)] : null });
  if (!pairs.length) {
    const map = (process.env.OPENROUTER_PROVIDER_ORDER_MAP || '').replace(/^"|"$/g, '');
    for (const entry of map.split(';')) {
      const eq = entry.indexOf('='); if (eq < 0) continue;
      const k = entry.slice(0, eq).trim(); const hosts = entry.slice(eq + 1).split(',').map((x) => x.trim()).filter(Boolean);
      // Resolve the short model key to a configured TIER_* model id.
      const tiers = ['TIER_SIMPLE', 'TIER_MEDIUM', 'TIER_COMPLEX', 'TIER_REASONING'].map((t) => process.env[t] || '').filter((v) => v.startsWith('openrouter:') && v.includes(k));
      const model = tiers.length ? tiers[0].slice('openrouter:'.length).split(/\s+#/)[0].trim() : k;
      for (const h of hosts) pairs.push({ model, host: h });
    }
  }
  const pi = argv.indexOf('--prefix-tokens'); const prefixTokens = pi >= 0 ? Number(argv[pi + 1]) || 3000 : 3000;
  const filler = Array.from({ length: Math.round(prefixTokens / 12) }, (_, i) => `-rw-r--r-- 1 root root ${100000 + i * 37} Oct  2 05:00 file_${i}.log`).join('\n');
  const nonce = Date.now();
  const prefix = `[cache-probe ${nonce}]\nYou are an AI assistant tasked with solving command-line tasks in a Linux environment.\n\nInstruction:\nSummarise the directory listing below in one sentence.\n\n${filler}\n\n`;

  const call = async (model, host, suffix) => {
    const body = { model, messages: [{ role: 'user', content: prefix + suffix }], max_tokens: 64, temperature: 0, usage: { include: true } };
    if (host) body.provider = { order: [host], allow_fallbacks: false };
    const t0 = Date.now();
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ms = Date.now() - t0; const j = await res.json();
    if (j.error) return { error: j.error.message?.slice(0, 80), ms };
    const u = j.usage || {};
    return { ms, provider: j.provider, prompt: u.prompt_tokens, cached: u.prompt_tokens_details?.cached_tokens ?? 0, cost: u.cost ?? null };
  };

  console.log(`prefix ≈ ${prefixTokens} tokens, two calls per host\n`);
  console.log(`${'model'.padEnd(34)} ${'host'.padEnd(12)} ${'cold ms'.padStart(8)} ${'warm ms'.padStart(8)} ${'cached'.padStart(7)} ${'hit%'.padStart(5)} ${'cold $'.padStart(9)} ${'warm $'.padStart(9)}  note`);
  for (const { model, host } of pairs) {
    const a = await call(model, host, 'Reply with one word: ready.');
    await new Promise((r) => setTimeout(r, 1500));
    const b = await call(model, host, 'Reply with one word: again.');
    if (a.error || b.error) { console.log(`${model.padEnd(34)} ${String(host).padEnd(12)} ERROR ${a.error || b.error}`); continue; }
    const hit = b.prompt ? Math.round(100 * b.cached / b.prompt) : 0;
    const note = b.cached === 0 ? 'NO CACHE HITS REPORTED' : (b.ms < a.ms * 0.8 ? 'warm faster' : 'no latency gain');
    console.log(`${model.padEnd(34)} ${String(host).padEnd(12)} ${String(a.ms).padStart(8)} ${String(b.ms).padStart(8)} ${String(b.cached).padStart(7)} ${String(hit).padStart(5)} ${a.cost != null ? a.cost.toFixed(6).padStart(9) : '        -'} ${b.cost != null ? b.cost.toFixed(6).padStart(9) : '        -'}  ${note}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
