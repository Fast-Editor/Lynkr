/**
 * Cursor CLI provider — unit tests.
 *
 * Covers prompt flattening, CLI output parsing, Anthropic conversion,
 * one-shot spawn arg shape (via injected execFn — never spawns a real
 * `cursor-agent`), availability detection, and dispatch registration.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";
process.env.LOG_FILE_ENABLED = "false";

const cursorUtils = require("../src/clients/cursor-utils");

test("convertAnthropicToCursorPrompt passes a single user message through", () => {
  const { prompt } = cursorUtils.convertAnthropicToCursorPrompt({
    messages: [{ role: "user", content: "Fix this bug" }],
  });
  assert.equal(prompt, "Fix this bug");
});

test("convertAnthropicToCursorPrompt flattens history with last user message first", () => {
  const { prompt } = cursorUtils.convertAnthropicToCursorPrompt({
    messages: [
      { role: "user", content: "Here is my file" },
      { role: "assistant", content: [{ type: "text", text: "Got it" }] },
      { role: "user", content: "Now refactor it" },
    ],
  });
  assert.match(prompt, /Previous conversation:/);
  assert.match(prompt, /Now refactor it/);
});

test("extractCursorText handles json / text / stream-json shapes", () => {
  assert.equal(cursorUtils.extractCursorText(JSON.stringify({ text: "hello" })), "hello");
  assert.equal(cursorUtils.extractCursorText(JSON.stringify({ result: "done" })), "done");
  assert.equal(cursorUtils.extractCursorText("plain output"), "plain output");
  assert.equal(cursorUtils.extractCursorText(""), "");
  const stream = [
    JSON.stringify({ type: "assistant", message: { content: [{ text: "he" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ text: "llo" }] } }),
  ].join("\n");
  assert.equal(cursorUtils.extractCursorText(stream), "hello");
});

test("convertCursorResponseToAnthropic returns a message block", () => {
  const msg = cursorUtils.convertCursorResponseToAnthropic("hi there", "composer-2.5");
  assert.equal(msg.type, "message");
  assert.equal(msg.model, "composer-2.5");
  assert.deepEqual(msg.content, [{ type: "text", text: "hi there" }]);
  assert.ok(msg.usage.output_tokens > 0);
});

test("runCursorAgent builds the expected CLI argv, prompt over STDIN (no --force)", async () => {
  let seen = null;
  const execFn = async ({ binaryPath, args, stdin, timeoutMs }) => {
    seen = { binaryPath, args, stdin, timeoutMs };
    return JSON.stringify({ type: "result", result: "agent answer", session_id: "chat-1" });
  };
  const out = await cursorUtils.runCursorAgent({
    prompt: "do the thing",
    model: "composer-2.5",
    baseTimeoutMs: 5000,
    binaryPath: "cursor-agent",
    workspace: "/repo",
    execFn,
  });
  assert.equal(out.text, "agent answer");
  assert.equal(out.sessionId, "chat-1");
  assert.equal(out.resumed, false);
  assert.equal(seen.binaryPath, "cursor-agent");
  assert.ok(seen.args.includes("-p"), "must run in print mode");
  assert.ok(seen.args.includes("--output-format"), "must request structured output");
  assert.ok(seen.args.includes("composer-2.5"), "must pin the tier model");
  assert.ok(seen.args.includes("--trust"), "headless runs need --trust");
  assert.ok(seen.args.includes("--approve-mcps"), "headless runs need pre-approved MCPs or they stall");
  assert.equal(seen.args.includes("--force"), cursorUtils.CURSOR_AUTO_APPROVE, "--force must track the CURSOR_AUTO_APPROVE operator policy");
  assert.ok(seen.args.includes("/repo"), "workspace must be threaded through");
  assert.equal(seen.stdin, "do the thing", "prompt must travel over stdin, not argv");
  assert.ok(!seen.args.includes("do the thing"), "argv must not carry the prompt (OS size ceiling)");
  assert.ok(seen.timeoutMs >= 5000, "timeout scales up from base, never below it");
});

test("session resume: second turn sends --resume with only the new turn; stale resume falls back fresh", async () => {
  const calls = [];
  let failNextResume = false;
  const execFn = async ({ args, stdin }) => {
    calls.push({ args: [...args], stdin });
    if (args.includes("--resume") && failNextResume) {
      const err = new Error("session not found");
      throw err;
    }
    return JSON.stringify({ result: "ok", session_id: "chat-abc" });
  };
  const common = { model: "composer-2.5", binaryPath: "cursor-agent", execFn, sessionKey: "sid:test-resume" };

  const first = await cursorUtils.runCursorAgent({ ...common, prompt: "full conversation flatten", resumePrompt: "turn 1" });
  assert.equal(first.resumed, false, "no cached chat yet → fresh");
  assert.ok(!calls[0].args.includes("--resume"));

  const second = await cursorUtils.runCursorAgent({ ...common, prompt: "full conversation flatten v2", resumePrompt: "just the new turn" });
  assert.equal(second.resumed, true);
  assert.ok(calls[1].args.includes("--resume"), "second turn must resume");
  assert.equal(calls[1].args[calls[1].args.indexOf("--resume") + 1], "chat-abc");
  assert.equal(calls[1].stdin, "just the new turn", "resumed sessions send only the newest turn");

  failNextResume = true;
  const third = await cursorUtils.runCursorAgent({ ...common, prompt: "full flatten v3", resumePrompt: "newest" });
  assert.equal(third.resumed, false, "failed resume must fall back to a fresh full-prompt attempt");
  const last = calls[calls.length - 1];
  assert.ok(!last.args.includes("--resume"));
  assert.equal(last.stdin, "full flatten v3");
});

test("timeout scales with payload and is hard-capped", () => {
  const base = cursorUtils.scaleTimeoutMs(0, 120_000);
  assert.equal(base, 120_000);
  const big = cursorUtils.scaleTimeoutMs(1024 * 1024, 120_000); // 1MB
  assert.ok(big > 120_000, "large payloads earn more time");
  const huge = cursorUtils.scaleTimeoutMs(100 * 1024 * 1024, 120_000);
  assert.equal(huge, cursorUtils.MAX_TIMEOUT_MS, "hard cap holds");
});

test("at most MAX_CONCURRENT_PROCS CLI spawns run at once; extras queue", async () => {
  let inFlight = 0;
  let peak = 0;
  const execFn = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    return JSON.stringify({ result: "ok" });
  };
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      cursorUtils.runCursorAgent({ prompt: `p${i}`, model: "m", binaryPath: "b", execFn })
    )
  );
  assert.ok(peak <= cursorUtils.MAX_CONCURRENT_PROCS, `peak ${peak} must respect the gate`);
});

test("classifyCursorError reports timeouts as timeouts and auth as auth", () => {
  const t = new Error("spawnSync cursor-agent ETIMEDOUT");
  t.killed = true;
  const classified = cursorUtils.classifyCursorError(t, { payloadBytes: 250 * 1024, timeoutMs: 120_000 });
  assert.match(classified.message, /timed out after 120s/);
  assert.match(classified.message, /250KB/);
  assert.ok(!/subscription/.test(classified.message), "a timeout must not be blamed on the subscription");

  const a = new Error("exit 1");
  a.stderr = "Error: not logged in. Please sign in.";
  const auth = cursorUtils.classifyCursorError(a, {});
  assert.match(auth.message, /cursor-agent login/);
});

test("parseCursorResult surfaces session id and real token usage", () => {
  const out = JSON.stringify({
    type: "result", result: "OK", session_id: "s-1",
    usage: { inputTokens: 8408, outputTokens: 32, cacheReadTokens: 3904, cacheWriteTokens: 0 },
  });
  const parsed = cursorUtils.parseCursorResult(out);
  assert.equal(parsed.sessionId, "s-1");
  assert.equal(parsed.usage.inputTokens, 8408);
  const msg = cursorUtils.convertCursorResponseToAnthropic(parsed.text, "composer-2.5", parsed.usage);
  assert.equal(msg.usage.input_tokens, 8408);
  assert.equal(msg.usage.cache_read_input_tokens, 3904);
});

test("deriveSessionKey: _sessionId wins, first-message hash is the fallback, empty body → null", () => {
  assert.equal(cursorUtils.deriveSessionKey({ _sessionId: "abc" }), "sid:abc");
  const k1 = cursorUtils.deriveSessionKey({ messages: [{ role: "user", content: "hello world" }] });
  const k2 = cursorUtils.deriveSessionKey({ messages: [{ role: "user", content: "hello world" }, { role: "assistant", content: "hi" }] });
  assert.equal(k1, k2, "key must be stable as the conversation grows");
  assert.equal(cursorUtils.deriveSessionKey({ messages: [] }), null);
});

test("isAvailable honors the injected which implementation", () => {
  assert.equal(cursorUtils.isAvailable(() => {}), true);
  assert.equal(
    cursorUtils.isAvailable(() => {
      throw new Error("not found");
    }),
    false
  );
});

test("getBinaryPath prefers explicit config, then env, then default", () => {
  assert.equal(cursorUtils.getBinaryPath({ binaryPath: "/opt/cursor-agent" }), "/opt/cursor-agent");
  const prev = process.env.CURSOR_BINARY_PATH;
  process.env.CURSOR_BINARY_PATH = "my-agent";
  assert.equal(cursorUtils.getBinaryPath({}), "my-agent");
  if (prev === undefined) delete process.env.CURSOR_BINARY_PATH;
  else process.env.CURSOR_BINARY_PATH = prev;
  assert.equal(cursorUtils.getBinaryPath({}), "cursor-agent");
});

test("cursor invoker is registered and refuses empty prompts", async () => {
  const { PROVIDER_INVOKERS, invokeCursor } = require("../src/clients/databricks");
  assert.equal(typeof PROVIDER_INVOKERS.cursor, "function");
  assert.equal(PROVIDER_INVOKERS.cursor, invokeCursor);
  const config = require("../src/config");
  const prev = config.cursor?.enabled;
  if (config.cursor) config.cursor.enabled = true;
  try {
    await assert.rejects(() => invokeCursor({ messages: [] }), /no prompt content/);
  } finally {
    if (config.cursor) config.cursor.enabled = prev;
  }
});

test("cursor is a transportless (text-only) provider like codex", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(`${__dirname}/../src/routing/vision.js`, "utf8");
  assert.match(src, /'cursor'/);
});

test("agent spawns in an empty sandbox cwd unless a workspace is explicit (server-repo leak fix)", async () => {
  const seen = [];
  const execFn = async ({ cwd }) => { seen.push(cwd); return JSON.stringify({ result: "ok" }); };
  await cursorUtils.runCursorAgent({ prompt: "review this project", model: "m", binaryPath: "b", execFn });
  await cursorUtils.runCursorAgent({ prompt: "p", model: "m", binaryPath: "b", workspace: "/client/repo", execFn });
  assert.equal(seen[0], cursorUtils.getSandboxDir(), "no workspace → sandbox dir, never the server cwd");
  assert.ok(!seen[0].includes("claude-code"), "sandbox must not be the Lynkr repo");
  assert.equal(seen[1], "/client/repo", "explicit workspace is honored");
});
