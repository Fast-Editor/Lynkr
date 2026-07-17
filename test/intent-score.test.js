/**
 * WS7 — payload-invariant intent scoring + anchor classifier.
 *
 * These are the DEFINING tests for WS7 (written before the implementation,
 * per HANDOFF-routing-next.md §7.4):
 *
 *  1. Envelope invariance — score(text) == score(text + tool schemas +
 *     system-reminders + history). The lexical scorer can never pass this;
 *     it is the whole point of the workstream (offline 31 vs live 56 on the
 *     same semantic ask).
 *  2. Paraphrase stability — embeddings that are close in cosine space must
 *     produce scores within a small band. The blend must be smooth in the
 *     embedding, not a cliff.
 *  3. Rung containment — no text-only score may reach the REASONING band
 *     (76+). REASONING is trigger-only (risk/force/agentic/kNN/fallback).
 *
 * Embeddings are injected as deterministic fixtures — these tests exercise
 * the scoring pipeline's contracts, not nomic-embed-text's semantics (the
 * telemetry replay script and live wrap verification cover that half).
 */
const assert = require("assert");
const { describe, it } = require("node:test");

const {
  extractCleanUserText,
  buildCentroids,
  classify,
  blendScore,
  scoreIntent,
  CLASS_VALUES,
} = require("../src/routing/intent-score");

// --- deterministic embedding fixtures --------------------------------------
// 4-dim unit-ish vectors: axis 0 ~ trivial, axis 1 ~ substantive,
// axis 2 ~ heavyweight. Paraphrases share direction with small jitter.
const FIXTURES = {
  "hi": [1, 0.05, 0.02, 0],
  "hello there": [0.98, 0.08, 0.03, 0.05],
  "review this retry helper for bugs": [0.06, 1, 0.2, 0],
  "give me a plan to refactor this code": [0.05, 0.95, 0.28, 0.03],
  "can you put together a refactoring plan for this code": [0.07, 0.93, 0.3, 0.06],
  "design a horizontally scalable architecture": [0.02, 0.25, 1, 0],
  "analyze every module in src/ for circular dependencies": [0.01, 0.3, 0.97, 0.04],
};
const fakeEmbed = async (text) => {
  const key = (text || "").toLowerCase().trim();
  return FIXTURES[key] || null; // unknown text — forces the lexical fallback path
};

const ANCHORS = {
  trivial: ["hi"],
  substantive: ["review this retry helper for bugs"],
  heavyweight: ["design a horizontally scalable architecture"],
};

async function centroids() {
  return buildCentroids(ANCHORS, fakeEmbed);
}

// --- envelope fixtures ------------------------------------------------------
const FAT_TOOL_SCHEMAS = Array.from({ length: 13 }, (_, i) => ({
  name: `tool_${i}`,
  description: "x".repeat(2000),
  input_schema: { type: "object", properties: { a: { type: "string", description: "y".repeat(500) } } },
}));
const REMINDER = "<system-reminder>" + "z".repeat(3000) + " credential security architecture refactor entire codebase </system-reminder>";
const HISTORY = Array.from({ length: 20 }, (_, i) => [
  { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "w".repeat(4000) }] },
  { role: "assistant", content: `step ${i} done` },
]).flat();

function bare(text) {
  return { messages: [{ role: "user", content: text }] };
}
function enveloped(text) {
  return {
    tools: FAT_TOOL_SCHEMAS,
    messages: [
      ...HISTORY,
      { role: "user", content: [{ type: "text", text: REMINDER + "\n" + text + "\n" + REMINDER }] },
    ],
  };
}

describe("WS7.1a — extractCleanUserText", () => {
  it("strips system-reminder blocks", () => {
    const t = extractCleanUserText(bare(REMINDER + "hi" + REMINDER));
    assert.strictEqual(t, "hi");
  });

  it("ignores tool_result blocks and picks the latest real user text", () => {
    const t = extractCleanUserText(enveloped("give me a plan to refactor this code"));
    assert.strictEqual(t, "give me a plan to refactor this code");
  });

  it("strips goose turn-context blocks (harness content, not user-authored)", () => {
    // Live incident 2026-07-13: goose wraps every typed message in a
    // <turn-context> block whose todo/tasks vocabulary scored "Hi" as
    // substantive/MEDIUM instead of trivial/SIMPLE.
    const t = extractCleanUserText(bare(
      "<turn-context>\n<current-time>2026-07-13 15:21:00</current-time>\n"
      + "<working-directory>/Users/x/claude-code</working-directory>\n\n"
      + "Current tasks and notes:\nOnce given a task, immediately update your todo with all explicit and implicit requirements\n"
      + "</turn-context>\nHi"
    ));
    assert.strictEqual(t, "Hi");
  });

  it("strips task-notification blocks (harness content, not user-authored)", () => {
    const t = extractCleanUserText(bare(
      "<task-notification> <task-id>abc</task-id> agent finished with 3 findings </task-notification>"
    ));
    assert.strictEqual(t, null);
    const t2 = extractCleanUserText(bare(
      "<task-notification>agent done</task-notification>\nhi"
    ));
    assert.strictEqual(t2, "hi");
  });

  it("treats whole-message harness content as non-user-authored", () => {
    for (const harness of [
      "[SYSTEM NOTIFICATION - NOT USER INPUT] This is an automated check-in.",
      "<conversation>\nsummary of prior turns…\n</conversation>",
      "<session>compacted history</session>",
      "[Request interrupted by user]",
      "This session is being continued from a previous conversation that ran out of context. Summary: the user asked for an architecture review of the orchestrator…",
    ]) {
      assert.strictEqual(extractCleanUserText(bare(harness)), null, `should be null: ${harness.slice(0, 40)}`);
    }
  });

  it("walks back past harness messages to the real typed ask", () => {
    const t = extractCleanUserText({
      messages: [
        { role: "user", content: "Work autonomously: run the test suite and fix failures" },
        { role: "assistant", content: "running" },
        { role: "user", content: "[SYSTEM NOTIFICATION - NOT USER INPUT] background task update" },
      ],
    });
    assert.strictEqual(t, "Work autonomously: run the test suite and fix failures");
  });

  it("returns null for tool-result-only turns", () => {
    const t = extractCleanUserText({
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }],
    });
    assert.strictEqual(t, null);
  });
});

describe("WS7.1a — envelope invariance (the defining test)", () => {
  const TEXTS = [
    "hi",
    "give me a plan to refactor this code",
    "design a horizontally scalable architecture",
  ];

  it("anchor mode: score(text) === score(text + 13 fat schemas + reminders + 40-msg history)", async () => {
    const c = await centroids();
    for (const text of TEXTS) {
      const a = await scoreIntent(bare(text), { embedFn: fakeEmbed, centroids: c });
      const b = await scoreIntent(enveloped(text), { embedFn: fakeEmbed, centroids: c });
      assert.ok(a && b, `scoreIntent returned null for "${text}"`);
      assert.strictEqual(a.score, b.score, `envelope changed score for "${text}": ${a.score} vs ${b.score}`);
    }
  });

  it("lexical fallback mode is envelope-invariant too", async () => {
    const c = await centroids();
    const text = "please summarize the key exports of this file for me quickly";
    const a = await scoreIntent(bare(text), { embedFn: fakeEmbed, centroids: c });
    const b = await scoreIntent(enveloped(text), { embedFn: fakeEmbed, centroids: c });
    assert.ok(a && b);
    assert.strictEqual(a.mode, "lexical");
    assert.strictEqual(b.mode, "lexical");
    assert.strictEqual(a.score, b.score);
  });
});

describe("WS7.4 — paraphrase stability", () => {
  it("paraphrase pairs score within 12 points", async () => {
    const c = await centroids();
    const pairs = [
      ["give me a plan to refactor this code", "can you put together a refactoring plan for this code"],
      ["hi", "hello there"],
      ["design a horizontally scalable architecture", "analyze every module in src/ for circular dependencies"],
    ];
    for (const [x, y] of pairs) {
      const a = await scoreIntent(bare(x), { embedFn: fakeEmbed, centroids: c });
      const b = await scoreIntent(bare(y), { embedFn: fakeEmbed, centroids: c });
      assert.ok(Math.abs(a.score - b.score) <= 12,
        `paraphrases diverged: "${x}"=${a.score} vs "${y}"=${b.score}`);
    }
  });
});

describe("WS7.1b — anchor classification + blend", () => {
  it("classifies fixtures into their classes with sensible scores", async () => {
    const c = await centroids();
    const trivial = await scoreIntent(bare("hi"), { embedFn: fakeEmbed, centroids: c });
    const substantive = await scoreIntent(bare("review this retry helper for bugs"), { embedFn: fakeEmbed, centroids: c });
    const heavy = await scoreIntent(bare("design a horizontally scalable architecture"), { embedFn: fakeEmbed, centroids: c });

    assert.strictEqual(trivial.class, "trivial");
    assert.strictEqual(substantive.class, "substantive");
    assert.strictEqual(heavy.class, "heavyweight");
    assert.ok(trivial.score < substantive.score && substantive.score < heavy.score);
    assert.ok(trivial.score <= 25, `trivial should land in SIMPLE band, got ${trivial.score}`);
    assert.ok(heavy.score >= 51, `heavyweight should land in COMPLEX band, got ${heavy.score}`);
  });

  it("borderline embeddings interpolate between class values (no cliff)", async () => {
    const c = await centroids();
    // halfway between substantive and heavyweight directions
    const mid = [0.04, 0.62, 0.62, 0.02];
    const { sims } = classify(mid, c);
    const s = blendScore(sims);
    assert.ok(s > CLASS_VALUES.substantive && s < CLASS_VALUES.heavyweight,
      `expected interpolation between ${CLASS_VALUES.substantive} and ${CLASS_VALUES.heavyweight}, got ${s}`);
  });
});

describe("WS7.3 — rung containment (REASONING is trigger-only)", () => {
  it("blendScore can never reach the REASONING band", () => {
    // Adversarial grid: every corner and midpoint of sim space.
    const vals = [-1, 0, 0.5, 0.9, 1];
    for (const t of vals) for (const s of vals) for (const h of vals) {
      const score = blendScore({ trivial: t, substantive: s, heavyweight: h });
      assert.ok(score <= 75, `blend escaped COMPLEX: sims=(${t},${s},${h}) → ${score}`);
      assert.ok(score >= 0, `blend went negative: ${score}`);
    }
  });

  it("lexical fallback is clamped below the REASONING band", async () => {
    const c = await centroids();
    // A text engineered to max every lexical dimension.
    const adversarial = (
      "refactor the entire codebase from scratch: implement a new distributed " +
      "microservice architecture with concurrency, security auth encryption, " +
      "database migrations, performance benchmarks and testing. First analyze " +
      "step by step the trade-offs, then plan edge cases, then implement. "
    ).repeat(50);
    const r = await scoreIntent(bare(adversarial), { embedFn: fakeEmbed, centroids: c });
    assert.strictEqual(r.mode, "lexical");
    assert.ok(r.score <= 75, `lexical fallback escaped COMPLEX: ${r.score}`);
  });

  it("class decides the band: a trivial-class ask can never score into MEDIUM", async () => {
    // Runner-up sim close to the winner used to leak the blend across the
    // band edge (live: "what does git stash do?" → trivial class, score 31).
    const c = await centroids();
    const nearBoundary = [0.8, 0.75, 0.1, 0]; // trivial wins, substantive close behind
    const { cls, sims } = classify(nearBoundary, c);
    assert.strictEqual(cls, "trivial");
    const r = await scoreIntent(bare("hi"), {
      embedFn: async () => nearBoundary,
      centroids: c,
    });
    assert.ok(r.score <= 25, `trivial-class score leaked out of SIMPLE band: ${r.score} (sims ${JSON.stringify(sims)})`);
  });

  it("maximal text-only score still maps to the COMPLEX tier, never REASONING", () => {
    const { getModelTierSelector } = require("../src/routing/model-tiers");
    const maxBlend = blendScore({ trivial: -1, substantive: -1, heavyweight: 1 });
    const tier = getModelTierSelector().getTier(maxBlend);
    assert.strictEqual(tier, "COMPLEX",
      `text-only ceiling must be COMPLEX (rung 3); got ${tier} at score ${maxBlend}. ` +
      "REASONING is reachable only via triggers (risk/force/agentic) or correction (cascade/fallback) or memory (kNN).");
  });

  it("legacy mode opts out entirely", async () => {
    const r = await scoreIntent(bare("hi"), { mode: "legacy" });
    assert.strictEqual(r, null);
  });

  it("no clean text → null (caller keeps its own score)", async () => {
    const c = await centroids();
    const r = await scoreIntent({ messages: [] }, { embedFn: fakeEmbed, centroids: c });
    assert.strictEqual(r, null);
  });
});
