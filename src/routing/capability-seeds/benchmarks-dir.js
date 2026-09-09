/**
 * Drop-in benchmark directory loader: data/capability-benchmarks/*.json.
 *
 * For leaderboards with no stable raw endpoint (TerminalBench, LiveCodeBench
 * snapshots, Artificial Analysis exports): download the export once, drop it
 * here, and the seed script picks it up. Format per file:
 *
 *   { "source": "terminalbench-2.1", "scale": "percent",
 *     "results": { "Kimi K2.5": 42.1, "GPT 5.2": 38.0 } }
 *
 * scale "percent" (0-100) or "fraction" (0-1). Model names are cleaned with
 * the SWE-bench cleaner and family-mapped in normalize.js; unmapped names
 * surface for review instead of being silently seeded. Directory absent or
 * empty → { files: [] } (not an error).
 */

const fs = require('fs');
const path = require('path');
const { cleanName } = require('./swebench');

const BENCHMARKS_DIR = path.join(__dirname, '../../../data/capability-benchmarks');

function loadBenchmarksDir(dir = BENCHMARKS_DIR) {
  try {
    if (!fs.existsSync(dir)) return { files: [] };
    const files = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!raw || typeof raw !== 'object' || !raw.results || typeof raw.results !== 'object') {
          files.push({ file: name, status: 'skipped', reason: 'missing results object' });
          continue;
        }
        const entries = [];
        for (const [modelName, score] of Object.entries(raw.results)) {
          const cleaned = cleanName(modelName);
          const s = Number(score);
          if (cleaned && Number.isFinite(s)) entries.push({ name: cleaned, score: s });
        }
        files.push({
          file: name,
          status: 'ok',
          source: String(raw.source || name.replace(/\.json$/, '')),
          scale: raw.scale === 'fraction' ? 'fraction' : 'percent',
          entries,
        });
      } catch (err) {
        files.push({ file: name, status: 'skipped', reason: err.message });
      }
    }
    return { files };
  } catch (err) {
    return { files: [], error: err.message };
  }
}

module.exports = { loadBenchmarksDir, BENCHMARKS_DIR };
