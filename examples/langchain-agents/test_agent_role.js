/**
 * Quick integration test: verifies X-Agent-Role flows through routing.
 * Run: node examples/langchain-agents/test_agent_role.js
 */

// Patch env before loading config
process.env.ROUTING_PREFERENCES = 'security:moonshot,code:moonshot,frontend:moonshot';
process.env.TIER_SIMPLE = 'moonshot:kimi-k2-thinking';
process.env.TIER_MEDIUM = 'moonshot:kimi-k2-thinking';
process.env.TIER_COMPLEX = 'moonshot:kimi-k2-thinking';
process.env.TIER_REASONING = 'moonshot:kimi-k2-thinking';

const { getPreferenceRouter } = require('../../src/routing/preference-router');

const router = getPreferenceRouter();

// Test 1: Agent role hint takes priority
const result1 = router.resolve(
  { messages: [{ role: 'user', content: 'hello world' }] },  // no domain keywords
  'SIMPLE',
  { agentRole: 'security' }
);
console.log('Test 1 - Agent role "security" on generic message:');
console.log('  Domain:', result1?.domain || 'null');
console.log('  Source:', result1?.source || 'null');
console.log('  Pass:', result1?.domain === 'security' ? 'YES' : 'NO');

// Test 2: Agent role overrides text detection
const result2 = router.resolve(
  { messages: [{ role: 'user', content: 'write a React component with CSS' }] },  // frontend keywords
  'SIMPLE',
  { agentRole: 'security' }
);
console.log('\nTest 2 - Agent role "security" overrides frontend text:');
console.log('  Domain:', result2?.domain || 'null');
console.log('  Pass:', result2?.domain === 'security' ? 'YES' : 'NO');

// Test 3: No agent role falls back to text detection
const result3 = router.resolve(
  { messages: [{ role: 'user', content: 'fix the SQL injection vulnerability' }] },
  'SIMPLE'
);
console.log('\nTest 3 - No agent role, text has security keywords:');
console.log('  Domain:', result3?.domain || 'null');
console.log('  Pass:', result3?.domain === 'security' ? 'YES' : 'NO');

// Test 4: No agent role, no matching text
const result4 = router.resolve(
  { messages: [{ role: 'user', content: 'hello world' }] },
  'SIMPLE'
);
console.log('\nTest 4 - No agent role, generic text (no domain match):');
console.log('  Result:', result4);
console.log('  Pass:', result4 === null ? 'YES' : 'NO');

// Test 5: Empty agent role is ignored
const result5 = router.resolve(
  { messages: [{ role: 'user', content: 'hello world' }] },
  'SIMPLE',
  { agentRole: '' }
);
console.log('\nTest 5 - Empty agent role ignored:');
console.log('  Result:', result5);
console.log('  Pass:', result5 === null ? 'YES' : 'NO');

console.log('\nAll tests completed.');
