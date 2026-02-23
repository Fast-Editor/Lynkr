/**
 * Smart Selection Classification Tests
 *
 * Verifies that classifyRequestType() correctly categorizes user messages.
 * Add new entries to TESTS[] when classification regressions are found.
 *
 * Usage:
 *   NODE_ENV=test DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com \
 *     node --test test/smart-selection-classification.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { classifyRequestType } = require('../src/tools/smart-selection');

function classify(msg) {
  return classifyRequestType({ messages: [{ role: 'user', content: msg }] });
}

const TESTS = [
  // Shell commands — must NOT be conversational
  { msg: 'run npm test',           expect: 'code_execution' },
  { msg: 'check git status',       expect: 'code_execution' },
  { msg: 'ls -la',                 expect: 'code_execution' },
  { msg: 'git log --oneline',      expect: 'code_execution' },
  { msg: 'bd ready',               expect: 'code_execution' },
  { msg: 'pwd',                    expect: 'code_execution' },
  { msg: 'npm install lodash',     expect: 'code_execution' },
  { msg: 'test the auth module',   expect: 'code_execution' },

  // File reading
  { msg: 'cat package.json',       expect: 'file_reading' },
  { msg: 'list all files',         expect: 'file_reading' },
  { msg: 'read the config',        expect: 'file_reading' },
  { msg: 'show me the README',     expect: 'file_reading' },

  // File modification — word boundaries must not match "readme"/"ready"
  { msg: 'edit the README',        expect: 'file_modification' },
  { msg: 'create a new file',      expect: 'file_modification' },

  // Research / explanation
  { msg: 'explain closures',       expect: 'research' },
  { msg: 'describe the architecture', expect: 'research' },
  { msg: 'summarize this',         expect: 'research' },
  { msg: 'search for auth bugs',   expect: 'research' },

  // Simple Q&A
  { msg: 'what is a closure?',     expect: 'simple_qa' },

  // Conversational — no tools needed
  { msg: 'hello',                  expect: 'conversational' },
  { msg: 'hi',                     expect: 'conversational' },
  { msg: 'good morning',           expect: 'conversational' },
  { msg: 'thanks',                 expect: 'conversational' },
  { msg: 'should I use TS?',       expect: 'conversational' },

  // Complex task
  { msg: 'implement dark mode',    expect: 'complex_task' },

  // Word boundary regressions — "sh" must not match inside "should"/"show"
  { msg: 'show the logs',          expect: 'file_reading' },
];

describe('Smart Selection - classifyRequestType', () => {
  for (const t of TESTS) {
    it(`"${t.msg}" → ${t.expect}`, () => {
      const result = classify(t.msg);
      assert.strictEqual(result.type, t.expect,
        `"${t.msg}" classified as ${result.type}, expected ${t.expect}`);
    });
  }
});
