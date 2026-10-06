/**
 * Switch gate: should a pinned session stay on its model or move?
 *
 * Evaluates the session's recent turn outcomes (outcomes.js ring) with
 * hysteresis: escalation needs N consecutive MODEL-ATTRIBUTABLE regressions /
 * no-progress turns (environment noise is skipped, never counted), downgrade
 * needs M consecutive progress turns on a tier above the floor. Observe mode
 * records the decision it would have made; enforce mode drops the pin and
 * raises a per-session floor so the fresh route that follows lands higher.
 *
 * Config (config/routing.json → switch_gate):
 *   { mode: "observe"|"enforce", escalate_after_regressions: 2,
 *     downgrade_after_recoveries: 3, min_turns_before_switch: 2,
 *     max_switches_per_session: 2, cooldown_turns: 2 }
 *
 * Pure except for the per-session floor/switch bookkeeping (in-memory, TTL).
 */
'use strict';

const logger = require('../logger');
const rc = require('./routing-config');

const TIERS = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
const PRI = Object.fromEntries(TIERS.map((t, i) => [t, i + 1]));
const TTL_MS = 6 * 60 * 60 * 1000;
const _state = new Map(); // sessionId -> { ts, floor, switches, lastSwitchTurn }

const DEFAULTS = { mode: 'observe', escalate_after_regressions: 2, downgrade_after_recoveries: 3, min_turns_before_switch: 2, max_switches_per_session: 2, cooldown_turns: 2 };

function config() { return { ...DEFAULTS, ...((rc.load() || {}).switch_gate || {}) }; }
function _st(sessionId) {
  if (!sessionId) return { floor: null, switches: 0, lastSwitchTurn: -1 };
  const now = Date.now();
  let s = _state.get(sessionId);
  if (s && now - s.ts > TTL_MS) { _state.delete(sessionId); s = null; }
  if (!s) { s = { ts: now, floor: null, switches: 0, lastSwitchTurn: -1 }; _state.set(sessionId, s); }
  s.ts = now; return s;
}
function nextUp(tier) { const i = TIERS.indexOf(tier); return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null; }
function nextDown(tier) { const i = TIERS.indexOf(tier); return i > 0 ? TIERS[i - 1] : null; }

/**
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.currentTier      tier the pin would serve
 * @param {Array}  args.ring             outcomes.ring(sessionId), oldest → newest
 * @param {number} [args.turn]           assistant turns so far
 * @param {string} [args.baseTier]       tier the session was first routed to (downgrade floor)
 * @returns {{ action:'stay'|'escalate'|'downgrade', reason:string, target:string|null, enforced:boolean, streak:number, mode:string }}
 */
function evaluate({ sessionId, currentTier, ring = [], turn = null, baseTier = null }) {
  const cfg = config();
  const st = _st(sessionId);
  const attributable = ring.filter((t) => t && t.attributable);
  const newest = [...attributable].reverse();
  let regress = 0; for (const t of newest) { if (t.outcome === 'progress') break; regress++; }
  let recover = 0; for (const t of newest) { if (t.outcome !== 'progress') break; recover++; }
  const turns = Number.isFinite(turn) ? turn : ring.length;
  const base = { streak: regress, mode: cfg.mode, target: null, enforced: false };

  if (!currentTier || !PRI[currentTier]) return { ...base, action: 'stay', reason: 'no_tier' };
  if (turns < cfg.min_turns_before_switch) return { ...base, action: 'stay', reason: 'too_early' };
  if (st.switches >= cfg.max_switches_per_session) return { ...base, action: 'stay', reason: 'switch_budget_exhausted' };
  if (st.lastSwitchTurn >= 0 && turns - st.lastSwitchTurn < cfg.cooldown_turns) return { ...base, action: 'stay', reason: 'cooldown' };

  if (regress >= cfg.escalate_after_regressions) {
    const target = nextUp(currentTier);
    if (!target) return { ...base, action: 'stay', reason: 'already_top_tier' };
    return { ...base, action: 'escalate', reason: `${regress}_consecutive_attributable_regressions`, target, enforced: cfg.mode === 'enforce' };
  }
  const floorTier = baseTier && PRI[baseTier] ? baseTier : null;
  if (recover >= cfg.downgrade_after_recoveries && floorTier && PRI[currentTier] > PRI[floorTier]) {
    const target = nextDown(currentTier);
    return { ...base, action: 'downgrade', reason: `${recover}_consecutive_recoveries_above_base`, target, enforced: cfg.mode === 'enforce' };
  }
  return { ...base, action: 'stay', reason: regress ? `regressions_below_threshold(${regress}/${cfg.escalate_after_regressions})` : 'healthy' };
}

/** Record that a switch was enforced; sets the floor so fresh routing lands on target. */
function commit(sessionId, decision, turn) {
  if (!sessionId || !decision || decision.action === 'stay') return;
  const st = _st(sessionId);
  st.switches += 1; st.lastSwitchTurn = Number.isFinite(turn) ? turn : st.lastSwitchTurn;
  st.floor = decision.action === 'escalate' ? decision.target : (decision.action === 'downgrade' ? decision.target : st.floor);
  logger.warn({ sessionId, action: decision.action, target: decision.target, reason: decision.reason, switches: st.switches }, '[SwitchGate] switch committed');
}
function floor(sessionId) { return sessionId && _state.has(sessionId) ? _st(sessionId).floor : null; }
function _clear() { _state.clear(); }

module.exports = { evaluate, commit, floor, config, PRI, _clear };
