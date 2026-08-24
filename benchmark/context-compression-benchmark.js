/**
 * Benchmark: Context Compression Impact on Tier Routing
 *
 * Measures how compression affects tier routing decisions across the
 * 11 LiteLLM scenarios used in the head-to-head benchmark.
 */

const { analyzeComplexity } = require('../src/routing/complexity-analyzer');

// Same 11 scenarios from LiteLLM benchmark
const scenarios = [
  {
    name: 'greeting',
    payload: {
      messages: [
        { role: 'user', content: 'hi' },
      ],
    },
    expected: 'SIMPLE',
  },
  {
    name: 'simple_question',
    payload: {
      messages: [
        { role: 'user', content: 'what is a variable in programming?' },
      ],
    },
    expected: 'SIMPLE',
  },
  {
    name: 'code_generation',
    payload: {
      messages: [
        { role: 'user', content: 'write a function to reverse a string in Python' },
      ],
    },
    expected: 'MEDIUM',
  },
  {
    name: 'refactoring',
    payload: {
      messages: [
        { role: 'user', content: 'refactor this code to use async/await instead of promises' },
      ],
    },
    expected: 'MEDIUM',
  },
  {
    name: 'code_review',
    payload: {
      messages: [
        { role: 'user', content: 'review this pull request for security issues' },
      ],
    },
    expected: 'COMPLEX',
  },
  {
    name: 'architecture',
    payload: {
      messages: [
        { role: 'user', content: 'design a microservices architecture for an e-commerce platform' },
      ],
    },
    expected: 'COMPLEX',
  },
  {
    name: 'security_audit',
    payload: {
      messages: [
        { role: 'user', content: 'perform a security audit on this authentication system' },
      ],
    },
    expected: 'REASONING',
  },
  {
    name: 'autonomous_loop',
    payload: {
      messages: [
        { role: 'user', content: 'autonomously debug and fix all failing tests in this repository' },
      ],
    },
    expected: 'REASONING',
  },
  {
    name: 'long_conversation_simple_followup',
    payload: {
      messages: [
        { role: 'system', content: 'You are a helpful coding assistant' },
        ...Array(15).fill(null).map((_, i) => ({
          role: 'user',
          content: `Question ${i}: Can you explain this concept?`,
        })),
        ...Array(15).fill(null).map((_, i) => ({
          role: 'assistant',
          content: [
            { type: 'text', text: `Answer ${i}: Here's the explanation...` },
            { type: 'tool_result', tool_use_id: `tool_${i}`, content: 'X'.repeat(5000) },
          ],
        })),
        { role: 'user', content: 'thanks' }, // Simple request after long conversation
      ],
    },
    expected: 'SIMPLE',  // Should route to SIMPLE despite long history
  },
  {
    name: 'long_conversation_complex_followup',
    payload: {
      messages: [
        { role: 'system', content: 'You are a helpful coding assistant' },
        ...Array(10).fill(null).map((_, i) => ({
          role: 'user',
          content: `Simple question ${i}`,
        })),
        { role: 'user', content: 'now analyze the security implications of all the changes we discussed' },
      ],
    },
    expected: 'COMPLEX',  // Complex request regardless of history length
  },
  {
    name: 'tool_heavy_simple_request',
    payload: {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_result', tool_use_id: '1', content: 'A'.repeat(10000) },
            { type: 'tool_result', tool_use_id: '2', content: 'B'.repeat(10000) },
            { type: 'tool_result', tool_use_id: '3', content: 'C'.repeat(10000) },
            { type: 'tool_result', tool_use_id: '4', content: 'D'.repeat(10000) },
          ],
        },
        { role: 'user', content: 'what was the error message?' }, // Simple extraction
      ],
    },
    expected: 'SIMPLE',  // Should route to SIMPLE despite verbose tool outputs
  },
];

// Tier score thresholds (Lynkr's current config)
const TIER_THRESHOLDS = {
  SIMPLE: [0, 40],
  MEDIUM: [40, 60],
  COMPLEX: [60, 85],
  REASONING: [85, 100],
};

function scoreTier(score) {
  if (score >= TIER_THRESHOLDS.REASONING[0]) return 'REASONING';
  if (score >= TIER_THRESHOLDS.COMPLEX[0]) return 'COMPLEX';
  if (score >= TIER_THRESHOLDS.MEDIUM[0]) return 'MEDIUM';
  return 'SIMPLE';
}

async function runBenchmark() {
  console.log('🔬 Context Compression Benchmark');
  console.log('=' .repeat(80));
  console.log('');

  const results = [];

  for (const scenario of scenarios) {
    console.log(`📊 ${scenario.name}`);

    // Run without compression
    const withoutCompression = await analyzeComplexity(scenario.payload, {
      compression: false,
      weighted: true,
    });

    // Run with compression
    const withCompression = await analyzeComplexity(scenario.payload, {
      compression: true,
      weighted: true,
    });

    const tierWithout = scoreTier(withoutCompression.score);
    const tierWith = scoreTier(withCompression.score);
    const correct = tierWith === scenario.expected;

    const tokensWithout = withoutCompression.meta?.tokens || 0;
    const tokensWith = withCompression.meta?.tokens || 0;
    const tokenReduction = tokensWithout > 0
      ? Math.round((1 - tokensWith / tokensWithout) * 100)
      : 0;

    const result = {
      scenario: scenario.name,
      expected: scenario.expected,
      withoutCompression: {
        tier: tierWithout,
        score: withoutCompression.score,
        tokens: tokensWithout,
      },
      withCompression: {
        tier: tierWith,
        score: withCompression.score,
        tokens: tokensWith,
        reduction: withCompression.compression?.reduction || 0,
      },
      tokenReduction,
      correct,
      improved: tierWith === scenario.expected && tierWithout !== scenario.expected,
    };

    results.push(result);

    const checkmark = correct ? '✅' : '❌';
    const arrow = result.improved ? '🎯' : (tierWithout === tierWith ? '→' : '⚠️');

    console.log(`  ${checkmark} ${tierWithout} ${arrow} ${tierWith} (expected: ${scenario.expected})`);
    console.log(`  Tokens: ${tokensWithout} → ${tokensWith} (-${tokenReduction}%)`);
    if (withCompression.compression) {
      console.log(`  Tool results offloaded: ${withCompression.compression.toolResultsOffloaded}`);
    }
    console.log('');
  }

  // Summary
  console.log('=' .repeat(80));
  console.log('📈 SUMMARY');
  console.log('=' .repeat(80));

  const correctWithout = results.filter(r => r.withoutCompression.tier === r.expected).length;
  const correctWith = results.filter(r => r.correct).length;
  const improved = results.filter(r => r.improved).length;

  const avgTokenReduction = Math.round(
    results.reduce((sum, r) => sum + r.tokenReduction, 0) / results.length
  );

  console.log(`Routing accuracy WITHOUT compression: ${correctWithout}/${results.length} (${Math.round(correctWithout / results.length * 100)}%)`);
  console.log(`Routing accuracy WITH compression:    ${correctWith}/${results.length} (${Math.round(correctWith / results.length * 100)}%)`);
  console.log(`Scenarios improved by compression:    ${improved}/${results.length}`);
  console.log(`Average token reduction:              ${avgTokenReduction}%`);
  console.log('');

  // Cost impact
  console.log('💰 COST IMPACT');
  console.log('=' .repeat(80));

  const totalTokensWithout = results.reduce((sum, r) => sum + r.withoutCompression.tokens, 0);
  const totalTokensWith = results.reduce((sum, r) => sum + r.withCompression.tokens, 0);
  const overallReduction = Math.round((1 - totalTokensWith / totalTokensWithout) * 100);

  console.log(`Total tokens WITHOUT compression: ${totalTokensWithout.toLocaleString()}`);
  console.log(`Total tokens WITH compression:    ${totalTokensWith.toLocaleString()}`);
  console.log(`Overall reduction:                ${overallReduction}%`);
  console.log('');

  // Tier distribution
  console.log('🎯 TIER DISTRIBUTION');
  console.log('=' .repeat(80));

  const tierCounts = {
    WITHOUT: { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0, REASONING: 0 },
    WITH: { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0, REASONING: 0 },
  };

  results.forEach(r => {
    tierCounts.WITHOUT[r.withoutCompression.tier]++;
    tierCounts.WITH[r.withCompression.tier]++;
  });

  console.log('WITHOUT compression:', tierCounts.WITHOUT);
  console.log('WITH compression:   ', tierCounts.WITH);
  console.log('');

  // Detailed results table
  console.log('📋 DETAILED RESULTS');
  console.log('=' .repeat(80));
  console.log('Scenario'.padEnd(35), 'Without'.padEnd(12), 'With'.padEnd(12), 'Expected'.padEnd(12), 'Token -∆');
  console.log('-'.repeat(80));

  results.forEach(r => {
    const status = r.correct ? '✅' : '❌';
    console.log(
      `${status} ${r.scenario}`.padEnd(35),
      r.withoutCompression.tier.padEnd(12),
      r.withCompression.tier.padEnd(12),
      r.expected.padEnd(12),
      `-${r.tokenReduction}%`
    );
  });

  return results;
}

// Run benchmark
runBenchmark().catch(console.error);
