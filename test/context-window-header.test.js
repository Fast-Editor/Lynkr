/**
 * X-Lynkr-Context-Window — served-model context window contract.
 *
 * Behind a virtual model name ("lynkr-auto"), tier routing serves models
 * with different real context windows per request. This header is the
 * client's authoritative per-turn answer (intended as its compaction
 * budget). Contract being pinned:
 *
 *   1. known served model → header carries its real window
 *   2. unknown model → header is OMITTED, never guessed — a client
 *      compacting against a fabricated number either wastes context or
 *      overruns the real window
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { contextWindowFor } = require('../src/routing/model-registry');
const { getRoutingHeaders } = require('../src/routing');

test('contextWindowFor: known model returns its real window', () => {
  const window = contextWindowFor('databricks-claude-sonnet-4-5');
  assert.equal(window, 200000);
});

test('contextWindowFor: unknown or empty model returns null, never a guess', () => {
  assert.equal(contextWindowFor('totally-made-up-model-xyz'), null);
  assert.equal(contextWindowFor(''), null);
  assert.equal(contextWindowFor(null), null);
  assert.equal(contextWindowFor(undefined), null);
});

test('getRoutingHeaders: known served model carries X-Lynkr-Context-Window', () => {
  const headers = getRoutingHeaders({
    method: 'tier_config',
    provider: 'databricks',
    model: 'databricks-claude-sonnet-4-5',
    tier: 'COMPLEX',
  });
  assert.equal(headers['X-Lynkr-Model'], 'databricks-claude-sonnet-4-5');
  assert.equal(headers['X-Lynkr-Context-Window'], '200000');
});

test('getRoutingHeaders: unknown model omits the context-window header', () => {
  const headers = getRoutingHeaders({
    method: 'tier_config',
    provider: 'custom',
    model: 'totally-made-up-model-xyz',
    tier: 'SIMPLE',
  });
  assert.equal(headers['X-Lynkr-Model'], 'totally-made-up-model-xyz');
  assert.ok(!('X-Lynkr-Context-Window' in headers), 'must omit, never fabricate');
});

test('getRoutingHeaders: no model at all → no model or window headers', () => {
  const headers = getRoutingHeaders({ method: 'static', provider: 'ollama' });
  assert.ok(!('X-Lynkr-Model' in headers));
  assert.ok(!('X-Lynkr-Context-Window' in headers));
});
