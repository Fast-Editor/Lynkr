/**
 * Markdown → ANSI escape code renderer.
 *
 * Activated by MARKDOWN_RENDER_ANSI=true in the environment.
 * Applied to text blocks in the SSE emission path so clients like claw
 * receive pre-formatted output without needing their own markdown renderer.
 *
 * Deliberately avoids external dependencies — pure regex + string ops.
 */

// ---------------------------------------------------------------------------
// ANSI primitives
// ---------------------------------------------------------------------------
const R  = '\x1b[0m';          // reset all
const B  = '\x1b[1m';          // bold on
const B_ = '\x1b[22m';         // bold off
const I  = '\x1b[3m';          // italic on
const I_ = '\x1b[23m';         // italic off
const S  = '\x1b[9m';          // strikethrough on
const S_ = '\x1b[29m';         // strikethrough off
const DIM = '\x1b[2m';         // dim

const CYAN    = '\x1b[1;96m';  // bold bright-cyan  — H1
const BLUE    = '\x1b[1;94m';  // bold bright-blue  — H2
const MAGENTA = '\x1b[1;95m';  // bold bright-magenta — H3
const WHITE_B = '\x1b[1;97m';  // bold white         — H4-H6
const YELLOW  = '\x1b[33m';    // yellow             — inline code
const GREEN   = '\x1b[92m';    // bright green       — code block body
const GRAY    = '\x1b[90m';    // dark gray          — HR / code fence border
const ORANGE  = '\x1b[38;5;214m'; // orange          — code fence lang tag

// ---------------------------------------------------------------------------
// Inline formatting (applied to single lines outside code fences)
// ---------------------------------------------------------------------------
function inlineFmt(line) {
  // Bold + italic: ***text***
  line = line.replace(/\*\*\*(.+?)\*\*\*/g, `${B}${I}$1${I_}${B_}`);
  // Bold: **text** or __text__
  line = line.replace(/\*\*(.+?)\*\*/g,  `${B}$1${B_}`);
  line = line.replace(/__(.+?)__/g,       `${B}$1${B_}`);
  // Italic: *text* or _text_ (single, not preceded/followed by same char)
  line = line.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${I}$1${I_}`);
  line = line.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,       `${I}$1${I_}`);
  // Strikethrough: ~~text~~
  line = line.replace(/~~(.+?)~~/g, `${S}$1${S_}`);
  // Inline code: `code`  (done last so ANSI inside code isn't re-processed)
  line = line.replace(/`([^`]+)`/g, `${YELLOW}$1${R}`);
  return line;
}

// ---------------------------------------------------------------------------
// Block-level rendering (processes the whole text at once)
// ---------------------------------------------------------------------------
function markdownToAnsi(text) {
  if (!text) return text;

  const lines  = text.split('\n');
  const out    = [];
  let inCode   = false;
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // ── Code fence open/close ──────────────────────────────────────────────
    const fenceMatch = raw.match(/^(`{3,})(.*)/);
    if (fenceMatch) {
      if (!inCode) {
        inCode   = true;
        codeLang = fenceMatch[2].trim();
        const tag = codeLang ? ` ${codeLang} ` : '';
        out.push(`${GRAY}┌─${ORANGE}${tag}${GRAY}${'─'.repeat(Math.max(0, 46 - tag.length))}${R}`);
      } else {
        inCode = false;
        out.push(`${GRAY}└${'─'.repeat(48)}${R}`);
      }
      continue;
    }

    // ── Inside a code block ───────────────────────────────────────────────
    if (inCode) {
      out.push(`${GRAY}│ ${GREEN}${raw}${R}`);
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────
    if (/^[-*_]{3,}\s*$/.test(raw.trim())) {
      out.push(`${GRAY}${'─'.repeat(50)}${R}`);
      continue;
    }

    // ── Headings ──────────────────────────────────────────────────────────
    const h6 = raw.match(/^(#{1,6})\s+(.*)/);
    if (h6) {
      const level = h6[1].length;
      const title = inlineFmt(h6[2]);
      const colors = [CYAN, BLUE, MAGENTA, WHITE_B, WHITE_B, WHITE_B];
      const prefix = ['━━ ', '── ', '   ', '   ', '   ', '   '][level - 1];
      out.push(`${colors[level - 1]}${prefix}${title}${R}`);
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────
    if (raw.startsWith('> ')) {
      out.push(`${DIM}│ ${inlineFmt(raw.slice(2))}${R}`);
      continue;
    }

    // ── Unordered list ────────────────────────────────────────────────────
    const ulMatch = raw.match(/^(\s*)[*\-+] (.*)/);
    if (ulMatch) {
      const indent = ulMatch[1];
      const depth  = Math.floor(indent.length / 2);
      const bullet = ['•', '◦', '▸'][Math.min(depth, 2)];
      out.push(`${indent}${YELLOW}${bullet}${R} ${inlineFmt(ulMatch[2])}`);
      continue;
    }

    // ── Ordered list ──────────────────────────────────────────────────────
    const olMatch = raw.match(/^(\s*)(\d+)\. (.*)/);
    if (olMatch) {
      out.push(`${olMatch[1]}${YELLOW}${olMatch[2]}.${R} ${inlineFmt(olMatch[3])}`);
      continue;
    }

    // ── Normal line (apply inline formatting) ─────────────────────────────
    out.push(inlineFmt(raw));
  }

  // Close an unclosed code fence gracefully
  if (inCode) out.push(`${GRAY}└${'─'.repeat(48)}${R}`);

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const enabled = process.env.MARKDOWN_RENDER_ANSI === 'true';

function renderText(text) {
  if (!enabled || !text) return text;
  return markdownToAnsi(text);
}

module.exports = { renderText, markdownToAnsi, enabled };
