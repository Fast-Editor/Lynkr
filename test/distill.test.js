/**
 * Tests for Distill — Core Compression Algorithms
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  stripAnsi,
  normalizeText,
  extractSignature,
  jaccardSimilarity,
  structuralSimilarity,
  deltaRender,
  detectBursts,
  detectBadDistillation,
  deduplicateBlocks,
  compressToolResult,
  deduplicateHistory,
} = require('../src/context/distill');

// ── Text Normalization ──────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    assert.equal(stripAnsi('\x1B[31mred\x1B[0m'), 'red');
  });

  it('removes cursor movement codes', () => {
    assert.equal(stripAnsi('\x1B[2Jhello\x1B[H'), 'hello');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(stripAnsi(null), '');
    assert.equal(stripAnsi(undefined), '');
  });

  it('passes through clean text', () => {
    assert.equal(stripAnsi('hello world'), 'hello world');
  });
});

describe('normalizeText', () => {
  it('normalizes CRLF to LF', () => {
    assert.equal(normalizeText('a\r\nb\r\nc'), 'a\nb\nc');
  });

  it('collapses whitespace runs', () => {
    assert.equal(normalizeText('a    b\t\tc'), 'a b c');
  });

  it('collapses excessive blank lines', () => {
    assert.equal(normalizeText('a\n\n\n\n\nb'), 'a\n\nb');
  });

  it('trims result', () => {
    assert.equal(normalizeText('  hello  '), 'hello');
  });

  it('handles empty/null', () => {
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText(null), '');
  });
});

describe('extractSignature', () => {
  it('returns Set of normalized lines', () => {
    const sig = extractSignature('line one\nline two\nline three');
    assert.equal(sig.size, 3);
    assert.ok(sig.has('line one'));
  });

  it('deduplicates identical lines', () => {
    const sig = extractSignature('a\na\nb');
    assert.equal(sig.size, 2);
  });

  it('filters empty lines', () => {
    const sig = extractSignature('a\n\n\nb');
    assert.equal(sig.size, 2);
  });
});

// ── Structural Similarity ───────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    assert.equal(jaccardSimilarity(s, s), 1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    assert.equal(jaccardSimilarity(a, b), 0);
  });

  it('returns 1 for two empty sets', () => {
    assert.equal(jaccardSimilarity(new Set(), new Set()), 1);
  });

  it('returns 0 when one set is empty', () => {
    assert.equal(jaccardSimilarity(new Set(['a']), new Set()), 0);
  });

  it('computes correct ratio for partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection=2, union=4
    assert.equal(jaccardSimilarity(a, b), 0.5);
  });
});

describe('structuralSimilarity', () => {
  it('returns 1 for identical text', () => {
    assert.equal(structuralSimilarity('hello\nworld', 'hello\nworld'), 1);
  });

  it('returns 1 for both null', () => {
    assert.equal(structuralSimilarity(null, null), 1);
  });

  it('returns 0 when one is null', () => {
    assert.equal(structuralSimilarity('hello', null), 0);
  });

  it('detects high similarity for minor changes', () => {
    const a = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const b = 'line 1\nline 2\nline 3 modified\nline 4\nline 5';
    const sim = structuralSimilarity(a, b);
    assert.ok(sim > 0.5, `Expected >0.5, got ${sim}`);
  });

  it('detects low similarity for unrelated text', () => {
    const a = 'function foo() { return 1; }';
    const b = 'The quick brown fox jumps over the lazy dog';
    const sim = structuralSimilarity(a, b);
    assert.ok(sim < 0.3, `Expected <0.3, got ${sim}`);
  });
});

// ── Delta Rendering ─────────────────────────────────────────────────

describe('deltaRender', () => {
  it('returns full text when no previous result', () => {
    const result = deltaRender(null, 'new content');
    assert.equal(result.isDelta, false);
    assert.equal(result.result, 'new content');
  });

  it('returns [No changes] for identical text', () => {
    const result = deltaRender('same\ncontent', 'same\ncontent');
    assert.equal(result.isDelta, true);
    assert.equal(result.result, '[No changes]');
    assert.equal(result.similarity, 1);
  });

  it('produces delta for similar texts', () => {
    const prev = 'line 1\nline 2\nline 3\nline 4';
    const curr = 'line 1\nline 2\nline 3\nline 4\nline 5 added';
    const result = deltaRender(prev, curr);
    assert.equal(result.isDelta, true);
    assert.ok(result.result.includes('line 5 added'));
    assert.equal(result.addedCount, 1);
  });

  it('returns full text for dissimilar content', () => {
    const prev = 'completely different content here';
    const curr = 'nothing in common at all whatsoever';
    const result = deltaRender(prev, curr);
    assert.equal(result.isDelta, false);
    assert.equal(result.result, curr);
  });
});

// ── Burst Detection ─────────────────────────────────────────────────

describe('detectBursts', () => {
  it('returns batch mode for empty array', () => {
    const result = detectBursts([]);
    assert.equal(result.burstCount, 0);
    assert.equal(result.mode, 'batch');
  });

  it('returns batch mode for single chunk', () => {
    const result = detectBursts([{ timestamp: 100, size: 500 }]);
    assert.equal(result.burstCount, 1);
    assert.equal(result.mode, 'batch');
  });

  it('detects streaming mode for many rapid chunks', () => {
    const chunks = [];
    for (let i = 0; i < 20; i++) {
      // 20 chunks with 3s gaps = many bursts
      chunks.push({ timestamp: i * 3000, size: 50 });
    }
    const result = detectBursts(chunks);
    assert.ok(result.burstCount > 5, `Expected >5 bursts, got ${result.burstCount}`);
    assert.equal(result.mode, 'streaming');
  });

  it('detects batch mode for few large chunks', () => {
    const chunks = [
      { timestamp: 0, size: 1000 },
      { timestamp: 100, size: 1000 },  // same burst (100ms gap)
      { timestamp: 5000, size: 1000 }, // new burst (5s gap)
      { timestamp: 5100, size: 1000 }, // same burst
    ];
    const result = detectBursts(chunks);
    assert.equal(result.burstCount, 2);
    assert.equal(result.mode, 'batch');
  });
});

// ── Bad Distillation Detection ──────────────────────────────────────

describe('detectBadDistillation', () => {
  it('returns not bad for null inputs', () => {
    assert.equal(detectBadDistillation(null, null).isBad, false);
  });

  it('detects expansion (summary longer than original)', () => {
    const original = 'short text';
    const summary = 'this is a much much much longer summary that expands beyond the original content significantly';
    const result = detectBadDistillation(original, summary);
    assert.equal(result.isBad, true);
    assert.ok(result.reasons.some(r => r.includes('expanded')));
  });

  it('detects truncation', () => {
    const original = 'The quick brown fox jumps over the lazy dog and runs away fast';
    const summary = 'The quick brown fox';
    const result = detectBadDistillation(original, summary);
    assert.equal(result.isBad, true);
    assert.ok(result.reasons.some(r => r.includes('truncation')));
  });

  it('passes for good compression', () => {
    const original = 'error: file not found\nerror: file not found\nerror: file not found\nstack trace here';
    const summary = 'error: file not found (×3)\nstack trace here';
    const result = detectBadDistillation(original, summary);
    // Good summary — shorter and retains key info
    assert.equal(result.expansionRatio < 1.1, true);
  });

  it('includes similarity score in result', () => {
    const result = detectBadDistillation('hello world', 'hello world');
    assert.equal(typeof result.similarity, 'number');
  });
});

// ── Repetition Detection ────────────────────────────────────────────

describe('deduplicateBlocks', () => {
  it('returns same array for single block', () => {
    const result = deduplicateBlocks(['only one']);
    assert.deepEqual(result.compressed, ['only one']);
    assert.equal(result.stats.duplicatesRemoved, 0);
  });

  it('returns same for null/empty', () => {
    assert.deepEqual(deduplicateBlocks(null).compressed, []);
    assert.deepEqual(deduplicateBlocks([]).compressed, []);
  });

  it('collapses identical consecutive blocks', () => {
    const blocks = ['same content', 'same content', 'same content', 'different'];
    const result = deduplicateBlocks(blocks);
    assert.equal(result.compressed.length, 3); // original + repeat note + different
    assert.ok(result.compressed[1].includes('repeated 2 more times'));
    assert.equal(result.compressed[2], 'different');
  });

  it('preserves non-consecutive duplicates', () => {
    const blocks = ['aaa', 'bbb', 'aaa'];
    const result = deduplicateBlocks(blocks);
    assert.equal(result.compressed.length, 3); // no consecutive dups
  });

  it('uses similarity threshold', () => {
    const blocks = [
      'line 1\nline 2\nline 3\nline 4\nline 5',
      'line 1\nline 2\nline 3\nline 4\nline 5 modified',
    ];
    const result = deduplicateBlocks(blocks, { similarityThreshold: 0.7 });
    // These are ~80% similar, should be collapsed
    assert.ok(result.compressed.length <= 2);
  });
});

// ── Smart Tool Result Compression ───────────────────────────────────

describe('compressToolResult', () => {
  it('returns empty for null input', () => {
    const result = compressToolResult(null);
    assert.equal(result.text, '');
    assert.equal(result.method, 'empty');
  });

  it('passes through short text', () => {
    const result = compressToolResult('short', { maxLength: 1000 });
    assert.equal(result.text, 'short');
  });

  it('truncates long text', () => {
    const long = 'x'.repeat(2000);
    const result = compressToolResult(long, { maxLength: 500 });
    assert.ok(result.text.length <= 600); // some overhead for markers
    assert.ok(result.text.includes('chars compressed'));
  });

  it('applies delta rendering when previous result provided', () => {
    const prev = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const curr = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6';
    const result = compressToolResult(curr, { previousResult: prev, maxLength: 5000 });
    assert.equal(result.method, 'delta');
    assert.ok(result.stats.similarity > 0.5);
  });

  it('normalizes ANSI codes', () => {
    const result = compressToolResult('\x1B[31mhello\x1B[0m world', { maxLength: 1000 });
    assert.ok(!result.text.includes('\x1B'));
  });
});

// ── History Dedup ───────────────────────────────────────────────────

describe('deduplicateHistory', () => {
  it('handles empty messages', () => {
    const result = deduplicateHistory([]);
    assert.deepEqual(result.messages, []);
    assert.equal(result.stats.deduplicated, 0);
  });

  it('passes through non-tool-result messages', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const result = deduplicateHistory(msgs);
    assert.deepEqual(result.messages, msgs);
  });

  it('deduplicates similar tool results', () => {
    const longContent = 'line 1\nline 2\nline 3\nline 4\nline 5\n'.repeat(30);
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: longContent },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'b', content: longContent },
        ],
      },
    ];
    const result = deduplicateHistory(msgs);
    assert.equal(result.stats.deduplicated, 1);
    // Second result should be replaced with a reference
    const secondBlock = result.messages[1].content[0];
    assert.ok(secondBlock.content.includes('Similar to earlier'));
  });

  it('preserves short tool results', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'short' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'b', content: 'short' },
        ],
      },
    ];
    const result = deduplicateHistory(msgs);
    assert.equal(result.stats.deduplicated, 0); // Too short to check
  });

  it('handles mixed content arrays', () => {
    const longContent = 'data point\n'.repeat(100);
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'user said something' },
          { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: longContent }] },
        ],
      },
    ];
    const result = deduplicateHistory(msgs);
    assert.equal(result.stats.checked, 1);
  });
});

// ── Integration with compression.js ─────────────────────────────────

describe('compression.js integration', () => {
  const compression = require('../src/context/compression');

  it('exports distill module', () => {
    assert.ok(compression.distill);
    assert.equal(typeof compression.distill.structuralSimilarity, 'function');
  });

  it('exports compressToolResultBlock', () => {
    assert.equal(typeof compression.compressToolResultBlock, 'function');
  });

  it('compressToolResultBlock uses Distill for large content', () => {
    const longContent = 'x'.repeat(1000);
    const block = {
      type: 'tool_result',
      tool_use_id: 'test-1',
      content: longContent,
    };
    const result = compression.compressToolResultBlock(block);
    assert.ok(result.content.length < longContent.length);
  });

  it('compressToolResultBlock passes through short content', () => {
    const block = {
      type: 'tool_result',
      tool_use_id: 'test-2',
      content: 'short',
    };
    const result = compression.compressToolResultBlock(block);
    assert.equal(result.content, 'short');
  });

  it('compressHistory applies dedup to old messages', () => {
    const longContent = 'repeated line\n'.repeat(100);
    const messages = [];
    // Create enough messages to trigger compression (>10)
    for (let i = 0; i < 15; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [
          { type: 'tool_result', tool_use_id: `t-${i}`, content: longContent },
        ],
      });
    }
    // Should not throw
    const result = compression.compressHistory(messages, { keepRecentTurns: 5 });
    assert.ok(result.length <= messages.length);
  });
});
