/**
 * Confidence scoring for cascade responses (Phase 3.3).
 *
 * Given a response from a smaller model, estimate whether it's confident
 * enough to return as-is or whether we should escalate to a bigger model.
 *
 * Three strategies, picked by task type:
 *   - Factoid: detect refusal/uncertainty markers
 *   - Code: parse-validity check, completeness markers
 *   - Reasoning: optional judge-LLM (heuristic fallback when judge unavailable)
 *
 * Returns a [0, 1] confidence score. Caller compares against a threshold
 * (default 0.85).
 */

const logger = require('../logger');

const UNCERTAINTY_MARKERS = [
  /\bi don't know\b/i,
  /\bi'm not sure\b/i,
  /\bi cannot\b/i,
  /\bi am unable\b/i,
  /\bunable to\b/i,
  /\bnot certain\b/i,
  /\bunclear\b/i,
  /\bambiguous\b/i,
  /\b(?:no|insufficient) (?:information|context|details)\b/i,
];

const REFUSAL_MARKERS = [
  /\bi can't help\b/i,
  /\bi won't\b/i,
  /\bagainst (?:my )?(?:guidelines|policy)\b/i,
];

const CODE_INCOMPLETE_MARKERS = [
  /\/\/\s*TODO\b/,
  /\/\*\s*TODO\b/,
  /#\s*TODO\b/i,
  /\.\.\.\s*$/m,
  /\bimplement (?:this|here|me)\b/i,
  /<replace[_ -]?this>/i,
  /<your[_ -]?code>/i,
];

function _extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b?.type === 'text')
      .map(b => b.text || '')
      .join(' ');
  }
  return '';
}

function _hasMarkers(text, patterns) {
  for (const re of patterns) {
    if (re.test(text)) return true;
  }
  return false;
}

function scoreFactoid(response) {
  const text = _extractText(response?.content);
  if (!text) return 0;
  if (_hasMarkers(text, REFUSAL_MARKERS)) return 0.2;
  if (_hasMarkers(text, UNCERTAINTY_MARKERS)) return 0.5;
  // Short answers to factoid questions are usually fine; long hedged answers less so.
  if (text.length < 200) return 0.9;
  if (text.length < 500) return 0.85;
  return 0.8;
}

function scoreCode(response) {
  const text = _extractText(response?.content);
  if (!text) return 0;
  if (_hasMarkers(text, CODE_INCOMPLETE_MARKERS)) return 0.4;
  if (_hasMarkers(text, UNCERTAINTY_MARKERS)) return 0.55;
  // Look for code blocks
  const fenced = (text.match(/```[\s\S]*?```/g) || []).join('\n');
  if (!fenced) return 0.6; // Code-gen request without code is suspicious
  // Very basic balance check
  const opens = (fenced.match(/[\{\[\(]/g) || []).length;
  const closes = (fenced.match(/[\}\]\)]/g) || []).length;
  if (Math.abs(opens - closes) > 2) return 0.5;
  return 0.9;
}

async function scoreReasoning(response, opts = {}) {
  const text = _extractText(response?.content);
  if (!text) return 0;
  if (_hasMarkers(text, REFUSAL_MARKERS)) return 0.2;
  if (_hasMarkers(text, UNCERTAINTY_MARKERS)) return 0.5;
  // Optional judge LLM via opts.judge({ question, answer }) → [0, 1]
  if (typeof opts.judge === 'function') {
    try {
      const judged = await opts.judge({ question: opts.question, answer: text });
      if (typeof judged === 'number') return Math.max(0, Math.min(1, judged));
    } catch (err) {
      logger.debug({ err: err.message }, '[ConfidenceScorer] Judge LLM failed, using heuristic');
    }
  }
  // Heuristic: well-structured responses (paragraphs + concrete claims) score higher
  const sentenceCount = (text.match(/[.!?]+\s/g) || []).length;
  if (sentenceCount < 2) return 0.6;
  if (sentenceCount > 30) return 0.7; // very long answers are often padding
  return 0.85;
}

async function score(response, opts = {}) {
  const taskType = (opts.taskType || 'reasoning').toLowerCase();
  if (taskType.includes('code')) return scoreCode(response);
  if (taskType.includes('factoid') || taskType.includes('qa') || taskType.includes('simple_qa')) {
    return scoreFactoid(response);
  }
  return scoreReasoning(response, opts);
}

module.exports = { score, scoreFactoid, scoreCode, scoreReasoning };
