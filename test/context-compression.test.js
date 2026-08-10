/**
 * Tests for context compression integration with complexity scoring
 */

const { compressMessages, shouldCompress } = require('../src/routing/context-compressor');
const { analyzeComplexity } = require('../src/routing/complexity-analyzer');

describe('Context Compression', () => {
  describe('shouldCompress', () => {
    it('should compress long conversations (>10 messages)', () => {
      const payload = {
        messages: Array(15).fill({ role: 'user', content: 'test' }),
      };
      expect(shouldCompress(payload)).toBe(true);
    });

    it('should compress conversations with many tool results (>3)', () => {
      const payload = {
        messages: [
          { role: 'user', content: 'test' },
          { role: 'assistant', content: [{ type: 'tool_result', content: 'output1' }] },
          { role: 'assistant', content: [{ type: 'tool_result', content: 'output2' }] },
          { role: 'assistant', content: [{ type: 'tool_result', content: 'output3' }] },
          { role: 'assistant', content: [{ type: 'tool_result', content: 'output4' }] },
        ],
      };
      expect(shouldCompress(payload)).toBe(true);
    });

    it('should not compress short conversations', () => {
      const payload = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      };
      expect(shouldCompress(payload)).toBe(false);
    });
  });

  describe('compressMessages', () => {
    it('should offload tool_result content', () => {
      const messages = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_result', tool_use_id: '1', content: 'A'.repeat(1000) },
          ],
        },
      ];

      const { compressed, stats } = compressMessages(messages);

      expect(compressed[0].content[0].content).toBe('[offloaded]');
      expect(stats.toolResultsOffloaded).toBe(1);
      expect(stats.reduction).toBeGreaterThan(50); // Should save >50%
    });

    it('should keep sliding window of recent messages', () => {
      const messages = Array(20).fill(null).map((_, i) => ({
        role: 'user',
        content: `message ${i}`,
      }));

      const { compressed } = compressMessages(messages);

      // Should keep only last 5 messages (window size = 5)
      expect(compressed.length).toBe(5);
      expect(compressed[compressed.length - 1].content).toBe('message 19');
    });

    it('should always keep system message', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        ...Array(20).fill(null).map((_, i) => ({
          role: 'user',
          content: `message ${i}`,
        })),
      ];

      const { compressed } = compressMessages(messages);

      expect(compressed[0].role).toBe('system');
      expect(compressed[0].content).toBe('You are a helpful assistant');
    });
  });

  describe('Integration with analyzeComplexity', () => {
    it('should use compressed context for scoring when enabled', async () => {
      const payload = {
        messages: [
          { role: 'user', content: 'test' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_result', tool_use_id: '1', content: 'A'.repeat(5000) },
              { type: 'tool_result', tool_use_id: '2', content: 'B'.repeat(5000) },
              { type: 'tool_result', tool_use_id: '3', content: 'C'.repeat(5000) },
              { type: 'tool_result', tool_use_id: '4', content: 'D'.repeat(5000) },
            ],
          },
          { role: 'user', content: 'What did you find?' },
        ],
      };

      const result = await analyzeComplexity(payload, { compression: true, weighted: true });

      expect(result.compression).toBeDefined();
      expect(result.compression.reduction).toBeGreaterThan(50);
      expect(result.compression.toolResultsOffloaded).toBe(4);
    });

    it('should skip compression when disabled', async () => {
      const payload = {
        messages: Array(15).fill(null).map((_, i) => ({
          role: 'user',
          content: `message ${i}`,
        })),
      };

      const result = await analyzeComplexity(payload, { compression: false });

      expect(result.compression).toBeNull();
    });

    it('should route to cheaper tier with compression vs without', async () => {
      const payload = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          ...Array(15).fill(null).map((_, i) => ({
            role: 'user',
            content: `Simple question ${i}`,
          })),
          {
            role: 'assistant',
            content: [
              { type: 'tool_result', tool_use_id: '1', content: 'A'.repeat(10000) },
            ],
          },
          { role: 'user', content: 'hello' }, // Simple request
        ],
      };

      const withCompression = await analyzeComplexity(payload, { compression: true, weighted: true });
      const withoutCompression = await analyzeComplexity(payload, { compression: false, weighted: true });

      // With compression, token count should be lower
      expect(withCompression.meta.tokens).toBeLessThan(
        withoutCompression.meta.tokens
      );

      // Lower token count may lead to cheaper routing
      console.log('With compression:', {
        score: withCompression.score,
        tokens: withCompression.meta.tokens,
        recommendation: withCompression.recommendation,
        reduction: withCompression.compression?.reduction,
      });

      console.log('Without compression:', {
        score: withoutCompression.score,
        tokens: withoutCompression.meta.tokens,
        recommendation: withoutCompression.recommendation,
      });
    });
  });
});
