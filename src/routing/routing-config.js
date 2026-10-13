/**
 * Declarative routing config (signals → decisions).
 *
 * Loads config/routing.json (override path: LYNKR_ROUTING_CONFIG). Hot-reloads
 * on mtime change. Validation is strict about shape and lenient about intent:
 * an invalid file is logged and the previous good config (or the built-in
 * default) stays in force — routing must never fail because of a config typo.
 *
 * Shape:
 *   {
 *     version: 1,
 *     mode: "observe" | "enforce",         // observe: log what the engine would do
 *     harness: { patterns: [{ name, preamble, instruction }] },
 *     signals: { <name>: { type, ...options } },
 *     decisions: [{ name, priority, rules, tier, effort, hosts, plugins }],
 *     anchor_bands: { SIMPLE: [0,20], MEDIUM: [20,51], COMPLEX: [51,76], REASONING: [76,101] }
 *   }
 * Rule: { operator: "AND"|"OR"|"NOT", conditions: [ cond | rule ] }
 * Cond: { signal, matched?, equals?, in?, band_in?, tier_in?, min?, max?, min_confidence? }
 * Tier: "SIMPLE"|"MEDIUM"|"COMPLEX"|"REASONING"|"from:legacy"|"from:anchor"|"from:judge"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const TIERS = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
const DEFAULT_PATH = path.join(__dirname, '..', '..', 'config', 'routing.json');

const DEFAULT_CONFIG = {
  version: 1,
  mode: 'observe',
  anchor_bands: { SIMPLE: [0, 20], MEDIUM: [20, 51], COMPLEX: [51, 76], REASONING: [76, 101] },
  harness: {
    patterns: [
      {
        name: 'terminus',
        preamble: 'You are an AI assistant tasked with solving command-line tasks',
        instruction: '(?:^|\\n)Instruction:\\s*\\n([\\s\\S]*?)\\n\\s*\\n(?:Your response must be|Your response|Respond)',
      },
    ],
  },
  signals: {
    anchor: { type: 'anchor_score' },
    judge: { type: 'jev' },
    harness: { type: 'harness' },
    structured: { type: 'request_field', any_of: ['output_format', 'response_format'] },
    tool_count: { type: 'tool_count' },
    turn: { type: 'session_turn' },
    phase: { type: 'session_phase' },
    risk: { type: 'risk' },
  },
  decisions: [
    { name: 'legacy', priority: 0, rules: { operator: 'AND', conditions: [] }, tier: 'from:legacy' },
  ],
};

let _cache = { path: null, mtime: 0, config: DEFAULT_CONFIG, source: 'default' };

function configPath() {
  return process.env.LYNKR_ROUTING_CONFIG ? path.resolve(process.env.LYNKR_ROUTING_CONFIG) : DEFAULT_PATH;
}

function _isRule(x) { return x && typeof x === 'object' && typeof x.operator === 'string'; }

function validate(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['config is not an object'];
  if (cfg.mode && !['observe', 'enforce'].includes(cfg.mode)) errors.push(`mode must be observe|enforce (got ${cfg.mode})`);
  const signals = cfg.signals || {};
  for (const [name, s] of Object.entries(signals)) {
    if (!s || typeof s.type !== 'string') errors.push(`signal ${name}: missing type`);
  }
  const decisions = Array.isArray(cfg.decisions) ? cfg.decisions : [];
  if (decisions.length === 0) errors.push('decisions: at least one decision is required');
  const seenNames = new Set(), seenPri = new Map();
  const checkRule = (rule, where) => {
    if (!_isRule(rule)) { errors.push(`${where}: rules must have operator`); return; }
    const op = rule.operator.toUpperCase();
    if (!['AND', 'OR', 'NOT'].includes(op)) errors.push(`${where}: operator must be AND|OR|NOT`);
    const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
    if (op === 'NOT' && conds.length !== 1) errors.push(`${where}: NOT takes exactly one condition`);
    conds.forEach((c, i) => {
      if (_isRule(c)) return checkRule(c, `${where}.conditions[${i}]`);
      if (!c || typeof c.signal !== 'string') errors.push(`${where}.conditions[${i}]: missing signal`);
      else if (!signals[c.signal]) errors.push(`${where}.conditions[${i}]: unknown signal "${c.signal}"`);
    });
  };
  decisions.forEach((d, i) => {
    const where = `decisions[${i}]${d?.name ? ` (${d.name})` : ''}`;
    if (!d || typeof d.name !== 'string') errors.push(`${where}: missing name`);
    else if (seenNames.has(d.name)) errors.push(`${where}: duplicate name`); else seenNames.add(d.name);
    if (!Number.isFinite(d?.priority)) errors.push(`${where}: priority must be a number`);
    else if (seenPri.has(d.priority)) errors.push(`${where}: priority ${d.priority} also used by ${seenPri.get(d.priority)}`); else seenPri.set(d.priority, d.name);
    checkRule(d?.rules, `${where}.rules`);
    const t = d?.tier;
    if (t !== undefined && !(TIERS.includes(t) || /^from:(legacy|anchor|judge)$/.test(String(t)))) errors.push(`${where}: tier must be a tier name or from:legacy|anchor|judge`);
    if (d?.effort !== undefined && !['none', 'low', 'medium', 'high'].includes(d.effort)) errors.push(`${where}: effort must be none|low|medium|high`);
    if (d?.hosts !== undefined && !Array.isArray(d.hosts)) errors.push(`${where}: hosts must be an array`);
  });
  for (const p of (cfg.harness?.patterns || [])) {
    try { new RegExp(p.preamble, 'i'); if (p.instruction) new RegExp(p.instruction, 'i'); } catch (e) { errors.push(`harness pattern ${p.name}: ${e.message}`); }
  }
  return errors;
}

function load() {
  if (_cache.source === 'test') return _cache.config;
  const p = configPath();
  try {
    if (!fs.existsSync(p)) {
      if (_cache.source !== 'default') logger.info({ path: p }, '[RoutingConfig] file missing — using built-in default');
      _cache = { path: p, mtime: 0, config: DEFAULT_CONFIG, source: 'default' };
      return _cache.config;
    }
    const st = fs.statSync(p);
    if (_cache.path === p && _cache.mtime === st.mtimeMs) return _cache.config;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const merged = { ...DEFAULT_CONFIG, ...raw, signals: { ...DEFAULT_CONFIG.signals, ...(raw.signals || {}) } };
    const errors = validate(merged);
    if (errors.length) {
      logger.error({ path: p, errors }, '[RoutingConfig] invalid — keeping previous config');
      _cache.mtime = st.mtimeMs; // don't re-log every request
      return _cache.config;
    }
    merged.decisions = [...merged.decisions].sort((a, b) => b.priority - a.priority);
    _cache = { path: p, mtime: st.mtimeMs, config: merged, source: 'file' };
    logger.info({ path: p, mode: merged.mode, decisions: merged.decisions.map((d) => d.name) }, '[RoutingConfig] loaded');
    return merged;
  } catch (err) {
    logger.error({ path: p, err: err.message }, '[RoutingConfig] load failed — keeping previous config');
    return _cache.config;
  }
}

function mode() { return load().mode === 'enforce' ? 'enforce' : 'observe'; }
function anchorBandFor(score) {
  const bands = load().anchor_bands || DEFAULT_CONFIG.anchor_bands;
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  for (const t of TIERS) { const [lo, hi] = bands[t] || []; if (s >= lo && s < hi) return t; }
  return s >= 100 ? 'REASONING' : null;
}
function harnessPatterns() {
  return (load().harness?.patterns || []).map((p) => ({
    name: p.name,
    preamble: new RegExp(p.preamble, 'i'),
    instruction: p.instruction ? new RegExp(p.instruction, 'i') : null,
  }));
}
function _resetForTests(cfg) { _cache = { path: null, mtime: 0, config: cfg || DEFAULT_CONFIG, source: cfg ? 'test' : 'default' }; }

module.exports = { TIERS, DEFAULT_CONFIG, load, validate, mode, anchorBandFor, harnessPatterns, configPath, _resetForTests };
