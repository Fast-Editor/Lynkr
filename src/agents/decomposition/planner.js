/**
 * Decomposition planner (Phase 2).
 *
 * Turns a complex task into a small subtask DAG using a single model call
 * (plan-and-solve style — plan generated in one shot). Output is validated:
 * ids unique, dependencies reference real ids, no cycles, subtask count capped.
 * If anything fails to parse/validate the planner returns null and the caller
 * falls back to a monolithic solve.
 */

const { callModel, extractText } = require("./model-call");
const logger = require("../../logger");

// Agent types the dispatcher knows how to spawn. Planner is steered toward
// these; unknown types are coerced to general-purpose at dispatch time.
const KNOWN_AGENT_TYPES = [
  "Explore",
  "Plan",
  "general-purpose",
  "Test",
  "Debug",
  "Fix",
  "Refactor",
  "Documentation",
];

function buildPlannerPrompt(task, maxSubtasks) {
  return `You are a task-decomposition planner. Break the task below into the SMALLEST set of focused subtasks that can be solved with isolated context. Fewer is better — do NOT over-split. If the task is not genuinely divisible, return a single subtask.

Rules:
- At most ${maxSubtasks} subtasks.
- Each subtask must be independently solvable given only its prompt plus the results of the subtasks it depends on.
- Mark dependencies via "dependsOn" (array of subtask ids). Independent subtasks (empty dependsOn) will run in parallel.
- Prefer assigning each subtask an agent type from: ${KNOWN_AGENT_TYPES.join(", ")}.
- Keep each subtask prompt self-contained and specific.

Respond with ONLY a JSON object, no prose, in exactly this shape:
{
  "strategy": "one short sentence on how you split it",
  "subtasks": [
    { "id": "s1", "agentType": "Explore", "prompt": "...", "dependsOn": [] }
  ]
}

TASK:
${task}`;
}

/**
 * Extract the first balanced JSON object from a string (handles models that
 * wrap JSON in prose or ```json fences).
 */
function extractJsonObject(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Validate and normalise a parsed plan. Returns a clean plan or null.
 */
function validatePlan(parsed, maxSubtasks) {
  if (!parsed || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
    return null;
  }

  const subtasks = [];
  const seenIds = new Set();

  for (let i = 0; i < parsed.subtasks.length && subtasks.length < maxSubtasks; i++) {
    const st = parsed.subtasks[i];
    if (!st || typeof st.prompt !== "string" || st.prompt.trim().length === 0) {
      return null; // malformed subtask → reject whole plan, fall back
    }
    const id = typeof st.id === "string" && st.id.trim() ? st.id.trim() : `s${i + 1}`;
    if (seenIds.has(id)) return null; // duplicate ids
    seenIds.add(id);

    const agentType = KNOWN_AGENT_TYPES.includes(st.agentType)
      ? st.agentType
      : "general-purpose";

    const dependsOn = Array.isArray(st.dependsOn)
      ? st.dependsOn.filter((d) => typeof d === "string")
      : [];

    subtasks.push({ id, agentType, prompt: st.prompt.trim(), dependsOn });
  }

  // Dependencies must reference real ids and contain no cycles.
  for (const st of subtasks) {
    for (const dep of st.dependsOn) {
      if (!seenIds.has(dep)) return null; // dangling dependency
    }
  }
  if (hasCycle(subtasks)) return null;

  return {
    strategy: typeof parsed.strategy === "string" ? parsed.strategy : "",
    subtasks,
  };
}

/**
 * Cycle detection via DFS colouring.
 */
function hasCycle(subtasks) {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const state = new Map(); // id → 0 unvisited, 1 visiting, 2 done

  function visit(id) {
    const cur = state.get(id) || 0;
    if (cur === 1) return true; // back-edge → cycle
    if (cur === 2) return false;
    state.set(id, 1);
    const node = byId.get(id);
    for (const dep of node?.dependsOn || []) {
      if (visit(dep)) return true;
    }
    state.set(id, 2);
    return false;
  }

  for (const s of subtasks) {
    if (visit(s.id)) return true;
  }
  return false;
}

/**
 * Generate a validated plan for a task.
 * @param {Object} params
 * @param {string} params.task
 * @param {string} [params.model="sonnet"] - planning needs reasoning; use a capable model
 * @param {number} [params.maxSubtasks=6]
 * @param {Function} [params.invoke] - injectable model invoker (for tests)
 * @returns {Promise<{strategy:string, subtasks:Array, usage:Object}|null>}
 */
async function generatePlan({ task, model = "sonnet", maxSubtasks = 6, invoke } = {}) {
  if (!task || typeof task !== "string") return null;

  let responseJson;
  try {
    responseJson = await callModel({
      messages: [{ role: "user", content: buildPlannerPrompt(task, maxSubtasks) }],
      model,
      maxTokens: 1500,
      temperature: 0.1,
      invoke,
    });
  } catch (err) {
    logger.warn({ err: err.message }, "[Decomposition] Planner model call failed");
    return null;
  }

  const text = extractText(responseJson);
  const parsed = extractJsonObject(text);
  const plan = validatePlan(parsed, maxSubtasks);

  if (!plan) {
    logger.warn(
      { preview: text.slice(0, 200) },
      "[Decomposition] Plan failed validation — will fall back to monolithic"
    );
    return null;
  }

  plan.usage = {
    inputTokens: responseJson?.usage?.input_tokens || 0,
    outputTokens: responseJson?.usage?.output_tokens || 0,
  };

  logger.info(
    { subtasks: plan.subtasks.length, strategy: plan.strategy },
    "[Decomposition] Plan generated"
  );
  return plan;
}

module.exports = {
  generatePlan,
  validatePlan,
  extractJsonObject,
  hasCycle,
  buildPlannerPrompt,
  KNOWN_AGENT_TYPES,
};
