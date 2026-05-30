/**
 * Output-token ratio lookup (Phase 2.3).
 *
 * Reads data/output-ratios.json (built by scripts/learn-output-ratios.js).
 * Falls back to hardcoded defaults when the file is absent.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const FILE_PATH = path.join(__dirname, '../../data/output-ratios.json');

const DEFAULT_RATIOS = {
  simple_qa: 0.30,
  code_gen: 2.10,
  code_edit: 1.40,
  summarization: 0.15,
  reasoning: 1.50,
  tool_use: 0.80,
  default: 0.50,
};

let _cached = null;
let _cacheLoadedAt = 0;
const RELOAD_INTERVAL_MS = 60_000;

function _load() {
  if (_cached && Date.now() - _cacheLoadedAt < RELOAD_INTERVAL_MS) return _cached;
  try {
    if (fs.existsSync(FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
      if (data?.ratios && typeof data.ratios === 'object') {
        _cached = { ...DEFAULT_RATIOS, ...data.ratios };
        _cacheLoadedAt = Date.now();
        return _cached;
      }
    }
  } catch (err) {
    logger.debug({ err: err.message }, '[OutputRatios] Load failed, using defaults');
  }
  _cached = DEFAULT_RATIOS;
  _cacheLoadedAt = Date.now();
  return _cached;
}

function ratioFor(taskType) {
  const ratios = _load();
  const key = (taskType || 'default').toLowerCase();
  return ratios[key] ?? ratios.default ?? 0.5;
}

function reload() {
  _cached = null;
}

module.exports = { ratioFor, reload, DEFAULT_RATIOS };
