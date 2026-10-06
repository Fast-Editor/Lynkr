/**
 * Harness-envelope hygiene for trigger/risk/dimension text.
 *
 * GUI harnesses (Cursor at minimum) deliver the user's ask embedded in a
 * context envelope INSIDE the user message: <user_info>, <git_status>,
 * <rules> (workspace rules — routinely contain phrases like "never expose
 * API keys" or "do not deploy to production"), <agent_transcripts>, attached
 * file contents. Trigger-style scanners (force patterns, risk keywords) and
 * text dimensions must evaluate the ASK, not the harness's boilerplate — a
 * workspace rule about keys must not make "Hi" high-risk (live incident
 * 2026-09-26: routing_method=risk REASONING serve on a bare greeting).
 *
 * Claude Code payloads never carry these tags (its wrapper text rides in
 * system-reminders, stripped elsewhere) — this is a no-op for them.
 *
 * Pure functions, no I/O. Never throws.
 */

const ENVELOPE_TAGS = [
  'user_info',
  'git_status',
  'agent_transcripts',
  'rules',
  'always_applied_workspace_rules',
  'uuid',
  'project_layout',
  'attached_files',
  'file_contents',
  'additional_data',
  'custom_instructions',
  'linter_errors',
  'recently_viewed_files',
  'open_files',
  'user_rules',
  'memories',
  'workspace_rules',
];

const PAIRED_RES = ENVELOPE_TAGS.map(
  (t) => new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${t}>`, 'gi')
);
// Unclosed blocks that OPEN at line start swallow to end-of-string (telemetry
// and upstream truncation cut envelopes mid-block). Mid-line opens are
// preserved — a user QUOTING a tag is content, not envelope (same rationale
// as the jev-router cleaner's line-start rule).
const UNCLOSED_RES = ENVELOPE_TAGS.map(
  (t) => new RegExp(`(?:^|\\n)<${t}(?:\\s[^>]*)?>[\\s\\S]*$`, 'i')
);
const USER_QUERY_RE = /<user_query(?:\s[^>]*)?>([\s\S]*?)<\/user_query>/gi;

const HARNESS_PREAMBLE_RES = [
  /You are an AI assistant tasked with solving command-line tasks/i,
  /"title":\s*"CommandBatchResponse"/,
];
const HARNESS_INSTRUCTION_RE = /(?:^|\n)Instruction:\s*\n([\s\S]*?)\n\s*\n(?:Your response must be|Your response|Respond)/i;

function _patterns() {
  try {
    const pats = require('./routing-config').harnessPatterns();
    if (pats.length) return pats;
  } catch { /* fall back to built-ins */ }
  return [{ name: 'harness', preamble: HARNESS_PREAMBLE_RES[0], instruction: HARNESS_INSTRUCTION_RE }];
}

function matchHarness(text) {
  if (typeof text !== 'string') return null;
  for (const p of _patterns()) if (p.preamble.test(text)) return p;
  return HARNESS_PREAMBLE_RES.some((re) => re.test(text)) ? { name: 'harness', preamble: null, instruction: HARNESS_INSTRUCTION_RE } : null;
}

function isHarnessPrompt(text) {
  return matchHarness(text) !== null;
}

/**
 * @param {string} text - one user message's text
 * @returns {string|null} the task instruction when `text` is a recognised
 *   instruction-schema harness prompt; null otherwise (not a harness prompt,
 *   or the instruction block could not be isolated).
 */
function extractHarnessInstruction(text) {
  const p = matchHarness(text);
  if (!p) return null;
  const re = p.instruction || HARNESS_INSTRUCTION_RE;
  const m = re.exec(text);
  const instr = m ? m[1].trim() : '';
  return instr.length > 0 ? instr : null;
}

function _msgText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
  }
  return '';
}

/**
 * Harness-aware ask for a whole payload: when the FIRST user message is a
 * recognised instruction-schema harness prompt, the task instruction is the
 * ask for every turn of the session (later user turns are terminal output).
 * @param {object} payload - { messages }
 * @returns {{ text: string, index: number }|null}
 */
function harnessAskFromPayload(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return null;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role !== 'user') continue;
    const txt = _msgText(msgs[i]);
    const instr = extractHarnessInstruction(txt);
    return instr ? { text: instr, index: i, name: (matchHarness(txt) || {}).name || 'harness' } : null;
  }
  return null;
}

/**
 * @param {string} text - one user message's text content
 * @returns {string} the user's ask with harness envelope blocks removed;
 *   when the harness marks the ask explicitly (<user_query>), that wins.
 */
function stripHarnessEnvelope(text) {
  if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
  // Instruction-schema harness prompt → the ask IS the instruction block.
  const harnessInstr = extractHarnessInstruction(text);
  if (harnessInstr) return harnessInstr;
  try {
    if (!text.includes('<')) return text;
    const queries = [...text.matchAll(USER_QUERY_RE)].map((m) => m[1].trim()).filter(Boolean);
    if (queries.length > 0) return queries.join(' ');
    let out = text;
    for (const re of PAIRED_RES) out = out.replace(re, ' ');
    for (const re of UNCLOSED_RES) out = out.replace(re, ' ');
    return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return text;
  }
}

module.exports = { stripHarnessEnvelope, ENVELOPE_TAGS, isHarnessPrompt, matchHarness, extractHarnessInstruction, harnessAskFromPayload };
