#!/usr/bin/env node
/**
 * Refresh model pricing data.
 *
 * Phase 2.2 of the routing overhaul. Cron-friendly entrypoint that forces a
 * fresh pull of LiteLLM + models.dev pricing, compares to the last cached
 * snapshot, and logs anything that moved more than 5%.
 *
 * Usage: node scripts/refresh-pricing.js [--diff-only] [--threshold 0.05]
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../data/model-prices-cache.json');
const PREV_FILE = path.join(__dirname, '../data/model-prices-cache.prev.json');
const DEFAULT_THRESHOLD = 0.05;

function _parseArgs(argv) {
  const out = { diffOnly: false, threshold: DEFAULT_THRESHOLD };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--diff-only') out.diffOnly = true;
    else if (argv[i] === '--threshold') out.threshold = Number(argv[++i]) || DEFAULT_THRESHOLD;
  }
  return out;
}

function _readJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function _diff(prev, next, threshold) {
  if (!prev || !next) return [];
  const prevModels = prev.modelIndex || prev;
  const nextModels = next.modelIndex || next;
  const moves = [];
  for (const [modelId, oldCost] of Object.entries(prevModels)) {
    const newCost = nextModels[modelId];
    if (!newCost) {
      moves.push({ model: modelId, type: 'removed', oldCost });
      continue;
    }
    const oldTotal = (oldCost.input || 0) + (oldCost.output || 0);
    const newTotal = (newCost.input || 0) + (newCost.output || 0);
    if (oldTotal === 0) continue;
    const delta = (newTotal - oldTotal) / oldTotal;
    if (Math.abs(delta) >= threshold) {
      moves.push({
        model: modelId,
        type: delta > 0 ? 'increased' : 'decreased',
        oldInput: oldCost.input,
        newInput: newCost.input,
        oldOutput: oldCost.output,
        newOutput: newCost.output,
        deltaPct: (delta * 100).toFixed(2) + '%',
      });
    }
  }
  for (const modelId of Object.keys(nextModels)) {
    if (!prevModels[modelId]) {
      moves.push({ model: modelId, type: 'added', newCost: nextModels[modelId] });
    }
  }
  return moves;
}

async function refresh({ diffOnly = false, threshold = DEFAULT_THRESHOLD } = {}) {
  if (!diffOnly) {
    // Snapshot current cache as "previous" before fetching
    if (fs.existsSync(CACHE_FILE)) {
      try {
        fs.copyFileSync(CACHE_FILE, PREV_FILE);
      } catch (err) {
        console.error(`Failed to snapshot previous cache: ${err.message}`);
      }
    }

    const { getModelRegistry } = require('../src/routing/model-registry');
    const registry = await getModelRegistry();
    // Force a refresh
    if (typeof registry._fetchAll === 'function') {
      await registry._fetchAll();
    }
    console.log(`Refreshed pricing data (cache: ${CACHE_FILE})`);
  }

  const prev = _readJson(PREV_FILE);
  const next = _readJson(CACHE_FILE);
  const moves = _diff(prev, next, threshold);

  if (moves.length === 0) {
    console.log(`No pricing changes ≥${(threshold * 100).toFixed(1)}%.`);
    return { moves: [] };
  }

  console.log(`${moves.length} pricing change(s) ≥${(threshold * 100).toFixed(1)}%:`);
  for (const move of moves) {
    if (move.type === 'added') {
      console.log(`  + ${move.model}: input=${move.newCost.input}, output=${move.newCost.output}`);
    } else if (move.type === 'removed') {
      console.log(`  - ${move.model}: was input=${move.oldCost.input}, output=${move.oldCost.output}`);
    } else {
      console.log(`  ${move.type === 'increased' ? '↑' : '↓'} ${move.model}: ${move.oldInput}/${move.oldOutput} → ${move.newInput}/${move.newOutput} (${move.deltaPct})`);
    }
  }
  return { moves };
}

if (require.main === module) {
  const opts = _parseArgs(process.argv.slice(2));
  refresh(opts).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { refresh };
