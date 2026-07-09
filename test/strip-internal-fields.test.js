/**
 * Defense-in-depth: performJsonRequest strips underscore-prefixed fields
 * from every outbound body. Anthropic and Ollama Cloud both use Pydantic
 * and reject unknown top-level keys, so any leak of _sessionId / _tierModel
 * / _forceProvider / etc. hard-fails the request with
 * "Extra inputs are not permitted".
 *
 * Individual invoke functions already whitelist their outbound bodies, but
 * regressions have happened. This suite pins the invariant at the chokepoint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _stripInternalFields } = require('../src/clients/databricks');

test('strips top-level underscore-prefixed fields', () => {
  const body = {
    model: 'claude',
    messages: [{ role: 'user', content: 'hi' }],
    _sessionId: 'abc',
    _forceProvider: 'ollama',
    _tierModel: 'minimax-m2.5:cloud',
  };
  const out = _stripInternalFields(body);
  assert.equal(out._sessionId, undefined);
  assert.equal(out._forceProvider, undefined);
  assert.equal(out._tierModel, undefined);
  assert.equal(out.model, 'claude');
  assert.equal(out.messages.length, 1);
});

test('returns the same reference when there are no _* fields (no clone)', () => {
  const body = { model: 'claude', messages: [] };
  const out = _stripInternalFields(body);
  assert.equal(out, body); // identity — avoids alloc in the hot path
});

test('does not mutate the caller', () => {
  const body = { model: 'claude', _sessionId: 'abc' };
  const out = _stripInternalFields(body);
  assert.equal(body._sessionId, 'abc'); // original untouched
  assert.equal(out._sessionId, undefined);
});

test('leaves nested underscore-prefixed fields alone (only top-level stripped)', () => {
  const body = {
    model: 'claude',
    messages: [{ role: 'user', content: 'x', _internal: 'kept because nested' }],
  };
  const out = _stripInternalFields(body);
  assert.equal(out.messages[0]._internal, 'kept because nested');
});

test('null/undefined/non-object bodies pass through', () => {
  assert.equal(_stripInternalFields(null), null);
  assert.equal(_stripInternalFields(undefined), undefined);
  assert.equal(_stripInternalFields('not-an-object'), 'not-an-object');
});
