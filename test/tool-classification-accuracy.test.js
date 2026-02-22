/**
 * Tool Classification Accuracy Test
 *
 * Tests whether the LLM-based tool classification (via TOOL_NEEDS_CLASSIFICATION_MODEL)
 * correctly distinguishes tool-needing vs conversational messages.
 *
 * Usage:
 *   OLLAMA_ENDPOINT=http://192.168.100.201:11434 \
 *   TOOL_NEEDS_CLASSIFICATION_MODEL=qwen3:1.7b \
 *   node test/tool-classification-accuracy.test.js
 */

const { classifyToolNeeds } = require('../src/tools/tool-classification.js');

// --- Test cases: 25 tool-needing, 25 conversational ---

const TEST_CASES = [
  // ========== TOOL-NEEDING (expected: needsTools = true) ==========
  { message: "list all files in the current directory", expected: true },
  { message: "show me the contents of package.json", expected: true },
  { message: "create a new file called utils.js with a helper function", expected: true },
  { message: "run npm test", expected: true },
  { message: "search for all TODO comments in the codebase", expected: true },
  { message: "delete the temp folder", expected: true },
  { message: "what's in the src directory?", expected: true },
  { message: "rename server.js to app.js", expected: true },
  { message: "find all files that import lodash", expected: true },
  { message: "check git status", expected: true },
  { message: "add a login route to the express server", expected: true },
  { message: "fix the syntax error on line 42 of index.js", expected: true },
  { message: "install the axios package", expected: true },
  { message: "write a unit test for the auth middleware", expected: true },
  { message: "show me the last 5 git commits", expected: true },
  { message: "refactor the database module to use async/await", expected: true },
  { message: "what port is the server listening on? check the config", expected: true },
  { message: "grep for 'password' across all source files", expected: true },
  { message: "make a backup copy of the .env file", expected: true },
  { message: "count how many test files we have", expected: true },
  { message: "edit the README to add installation instructions", expected: true },
  { message: "check if Docker is running", expected: true },
  { message: "compile the typescript files", expected: true },
  { message: "move all log files to an archive folder", expected: true },
  { message: "check disk usage of the project directory", expected: true },

  // ========== CONVERSATIONAL (expected: needsTools = false) ==========
  { message: "hello, how are you?", expected: false },
  { message: "what is a closure in JavaScript?", expected: false },
  { message: "explain the difference between let and const", expected: false },
  { message: "how does async/await work under the hood?", expected: false },
  { message: "what are the SOLID principles?", expected: false },
  { message: "can you summarize what we discussed earlier?", expected: false },
  { message: "thanks for the help!", expected: false },
  { message: "what's the best practice for error handling in Node.js?", expected: false },
  { message: "why is my code slow? any general tips?", expected: false },
  { message: "explain REST vs GraphQL", expected: false },
  { message: "what does the spread operator do?", expected: false },
  { message: "how should I structure a monorepo?", expected: false },
  { message: "what is event-driven architecture?", expected: false },
  { message: "tell me about design patterns in JavaScript", expected: false },
  { message: "what's the difference between SQL and NoSQL?", expected: false },
  { message: "good morning!", expected: false },
  { message: "how do promises work?", expected: false },
  { message: "what is dependency injection?", expected: false },
  { message: "explain the observer pattern", expected: false },
  { message: "what are websockets used for?", expected: false },
  { message: "should I use TypeScript for my next project?", expected: false },
  { message: "what's new in ES2024?", expected: false },
  { message: "bye, talk to you later", expected: false },
  { message: "what is the CAP theorem?", expected: false },
  { message: "how do I become a better programmer?", expected: false },
];

// --- Mock invokeModel that calls Ollama directly ---

async function invokeModel({ model, messages, temperature, max_tokens }) {
  const endpoint = process.env.OLLAMA_ENDPOINT || 'http://192.168.100.201:11434';

  const response = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      messages: messages,
      stream: false,
      options: {
        temperature: temperature ?? 0,
        num_predict: max_tokens ?? 150,
      },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();

  // Return in the format classifyToolNeeds expects
  return {
    ok: true,
    json: {
      choices: [{
        message: {
          content: data.message?.content || '',
        },
      }],
    },
  };
}

// --- Run tests ---

async function runTests() {
  const model = process.env.TOOL_NEEDS_CLASSIFICATION_MODEL || 'qwen3:1.7b';
  console.log(`\n🧪 Tool Classification Accuracy Test`);
  console.log(`   Model: ${model}`);
  console.log(`   Test cases: ${TEST_CASES.length} (${TEST_CASES.filter(t => t.expected).length} tool, ${TEST_CASES.filter(t => !t.expected).length} conversational)\n`);

  const config = {
    whitelist: './config/tool-whitelist.json',
    model: model,
    cacheEnabled: false,  // Disable cache so every message hits the LLM
    llmEnabled: true,
  };

  let correct = 0;
  let wrong = 0;
  const failures = [];
  const results = { tool: { correct: 0, total: 0 }, conv: { correct: 0, total: 0 } };

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    const payload = {
      messages: [{ role: 'user', content: tc.message }],
    };

    try {
      const result = await classifyToolNeeds(payload, config, invokeModel);
      const got = result.needsTools;
      const pass = got === tc.expected;

      if (tc.expected) results.tool.total++;
      else results.conv.total++;

      if (pass) {
        correct++;
        if (tc.expected) results.tool.correct++;
        else results.conv.correct++;
        console.log(`  ✓ [${i + 1}/${TEST_CASES.length}] "${tc.message.substring(0, 50)}..." → ${got ? 'TOOL' : 'CONV'} (${result.source})`);
      } else {
        wrong++;
        failures.push({ ...tc, got, source: result.source, reason: result.reason });
        console.log(`  ✗ [${i + 1}/${TEST_CASES.length}] "${tc.message.substring(0, 50)}..." → ${got ? 'TOOL' : 'CONV'} expected ${tc.expected ? 'TOOL' : 'CONV'} (${result.source}: ${result.reason})`);
      }
    } catch (err) {
      wrong++;
      failures.push({ ...tc, got: 'ERROR', source: 'error', reason: err.message });
      console.log(`  ✗ [${i + 1}/${TEST_CASES.length}] "${tc.message.substring(0, 50)}..." → ERROR: ${err.message}`);
    }
  }

  // --- Summary ---
  const total = correct + wrong;
  const pct = ((correct / total) * 100).toFixed(1);
  const toolPct = results.tool.total ? ((results.tool.correct / results.tool.total) * 100).toFixed(1) : 'N/A';
  const convPct = results.conv.total ? ((results.conv.correct / results.conv.total) * 100).toFixed(1) : 'N/A';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESULTS: ${correct}/${total} correct (${pct}%)`);
  console.log(`    Tool detection:  ${results.tool.correct}/${results.tool.total} (${toolPct}%)`);
  console.log(`    Conv detection:  ${results.conv.correct}/${results.conv.total} (${convPct}%)`);
  console.log(`${'='.repeat(60)}`);

  if (failures.length > 0) {
    console.log(`\n  FAILURES:`);
    for (const f of failures) {
      console.log(`    - "${f.message}" → got ${f.got}, expected ${f.expected ? 'TOOL' : 'CONV'} (${f.source}: ${f.reason})`);
    }
  }

  console.log('');
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
