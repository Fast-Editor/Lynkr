/**
 * Loop guard — runaway-agent circuit breaker tests.
 *
 * The guard is the proxy-side answer to the classic AutoGen failure mode:
 * an uncapped agent loop resends the whole growing conversation every turn
 * and blows the budget. It must be stateless (payload-derived), off by
 * default, and reject with a machine-readable 429 when tripped.
 */

const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

const { loopGuard, _countToolResults } = require("../src/api/middleware/loop-guard");

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function run(body) {
  const res = mockRes();
  let nexted = false;
  loopGuard({ body, path: "/v1/chat/completions" }, res, () => { nexted = true; });
  return { res, nexted };
}

function convo(turns, toolResultsPerTurn = 0) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `turn ${i}` });
    if (toolResultsPerTurn > 0) {
      messages.push({
        role: "user",
        content: Array.from({ length: toolResultsPerTurn }, (_, j) => ({
          type: "tool_result", tool_use_id: `t${i}-${j}`, content: "ok",
        })),
      });
    }
  }
  return { messages };
}

describe("loop guard", () => {
  beforeEach(() => {
    delete process.env.LYNKR_MAX_SESSION_TURNS;
    delete process.env.LYNKR_MAX_TOOL_TURNS;
  });
  afterEach(() => {
    delete process.env.LYNKR_MAX_SESSION_TURNS;
    delete process.env.LYNKR_MAX_TOOL_TURNS;
  });

  it("is a no-op when no caps are configured", () => {
    const { nexted } = run(convo(500, 5));
    assert.equal(nexted, true);
  });

  it("passes conversations under the turn cap", () => {
    process.env.LYNKR_MAX_SESSION_TURNS = "80";
    const { nexted } = run(convo(40));
    assert.equal(nexted, true);
  });

  it("rejects with 429 loop_cap_exceeded when messages exceed the turn cap", () => {
    process.env.LYNKR_MAX_SESSION_TURNS = "30";
    const { res, nexted } = run(convo(31));
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error.type, "loop_cap_exceeded");
    assert.ok(res.body.error.message.includes("LYNKR_MAX_SESSION_TURNS"));
  });

  it("rejects when tool_result blocks exceed the tool-turn cap", () => {
    process.env.LYNKR_MAX_TOOL_TURNS = "10";
    const { res, nexted } = run(convo(6, 2)); // 12 tool results across 6 turns
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error.type, "loop_cap_exceeded");
    assert.ok(res.body.error.message.includes("LYNKR_MAX_TOOL_TURNS"));
  });

  it("tool cap ignores plain text turns; turn cap ignores tool density", () => {
    process.env.LYNKR_MAX_TOOL_TURNS = "10";
    const { nexted } = run(convo(50)); // long but tool-free
    assert.equal(nexted, true);
  });

  it("zero/garbage cap values disable the guard instead of rejecting everything", () => {
    process.env.LYNKR_MAX_SESSION_TURNS = "0";
    process.env.LYNKR_MAX_TOOL_TURNS = "not-a-number";
    const { nexted } = run(convo(300, 5));
    assert.equal(nexted, true);
  });

  it("_countToolResults counts blocks across mixed message shapes", () => {
    const { messages } = convo(3, 2);
    messages.push({ role: "assistant", content: "plain string content" });
    assert.equal(_countToolResults(messages), 6);
  });
});
