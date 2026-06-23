/**
 * Subtask dispatcher (Phase 3).
 *
 * Executes a validated plan respecting its dependency DAG:
 *   - subtasks are grouped into topological "levels" (Kahn's algorithm)
 *   - subtasks in the same level have no dependency on each other → run in
 *     parallel via the existing ParallelCoordinator (spawnParallel)
 *   - a subtask receives ONLY its own prompt plus the compressed results of the
 *     subtasks it depends on (context isolation — the token win)
 *
 * The spawn functions are injectable for testing.
 */

const logger = require("../../logger");

// Cap how much of a dependency's result we forward, to preserve the
// context-isolation savings (subagents already return summaries; this bounds
// pathological cases).
const MAX_CONTEXT_CHARS = 2000;

/**
 * Group subtasks into dependency levels. Returns array of arrays of ids.
 * Throws if the graph is unresolvable (should not happen — planner validated).
 */
function topologicalLevels(subtasks) {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const indegree = new Map(subtasks.map((s) => [s.id, 0]));
  const dependents = new Map(subtasks.map((s) => [s.id, []]));

  for (const s of subtasks) {
    for (const dep of s.dependsOn) {
      if (!byId.has(dep)) continue;
      indegree.set(s.id, indegree.get(s.id) + 1);
      dependents.get(dep).push(s.id);
    }
  }

  const levels = [];
  let frontier = subtasks.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
  const resolved = new Set();

  while (frontier.length > 0) {
    levels.push(frontier);
    const next = [];
    for (const id of frontier) {
      resolved.add(id);
      for (const child of dependents.get(id)) {
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) next.push(child);
      }
    }
    frontier = next;
  }

  if (resolved.size !== subtasks.length) {
    throw new Error("Unresolvable subtask graph (cycle or dangling dependency)");
  }
  return levels;
}

function compressResult(text) {
  if (typeof text !== "string") return String(text ?? "");
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return text.slice(0, MAX_CONTEXT_CHARS) + "\n…[truncated]";
}

function buildContextForSubtask(subtask, resultsById) {
  if (!subtask.dependsOn || subtask.dependsOn.length === 0) return null;
  const parts = [];
  for (const dep of subtask.dependsOn) {
    const r = resultsById.get(dep);
    if (r && r.success && r.result) {
      parts.push(`Result of subtask ${dep}:\n${compressResult(r.result)}`);
    } else if (r) {
      parts.push(`Subtask ${dep} did not complete successfully.`);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Dispatch a validated plan.
 * @param {Object} plan - { subtasks: [...] }
 * @param {Object} [options]
 * @param {string} [options.sessionId]
 * @param {string} [options.cwd]
 * @param {Function} [options.spawnParallel] - (agentTypes[], prompts[], opts) => results[]
 * @returns {Promise<{results: Array, levels: Array, stats: Object}>}
 */
async function dispatchPlan(plan, options = {}) {
  const spawnParallel = options.spawnParallel || require("../index").spawnParallel;
  const subtasks = plan.subtasks;
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const levels = topologicalLevels(subtasks);
  const resultsById = new Map();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalSubagents = 0;

  for (let li = 0; li < levels.length; li++) {
    const levelIds = levels[li];
    const levelSubtasks = levelIds.map((id) => byId.get(id));

    const agentTypes = levelSubtasks.map((s) => s.agentType);
    const prompts = levelSubtasks.map((s) => s.prompt);
    const perTaskContext = levelSubtasks.map((s) => buildContextForSubtask(s, resultsById));

    logger.info(
      { level: li, count: levelIds.length, ids: levelIds },
      "[Decomposition] Dispatching subtask level"
    );

    // spawnParallel shares one options object; pass per-task context by spawning
    // the level as individual parallel calls when contexts differ.
    const levelResults = await runLevel(
      spawnParallel,
      agentTypes,
      prompts,
      perTaskContext,
      options
    );

    levelResults.forEach((res, idx) => {
      const st = levelSubtasks[idx];
      totalSubagents += 1;
      totalInputTokens += res?.stats?.inputTokens || 0;
      totalOutputTokens += res?.stats?.outputTokens || 0;
      resultsById.set(st.id, {
        id: st.id,
        agentType: st.agentType,
        success: !!res?.success,
        result: res?.success ? res.result : null,
        error: res?.success ? null : res?.error || "unknown error",
        stats: res?.stats || {},
      });
    });
  }

  const results = subtasks.map((s) => resultsById.get(s.id));
  return {
    results,
    levels,
    stats: {
      subagents: totalSubagents,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
  };
}

/**
 * Run one level. When subtasks in the level have differing injected contexts we
 * spawn them as separate parallel calls (each with its own mainContext), then
 * await all. When none need context, a single spawnParallel batch is used.
 */
async function runLevel(spawnParallel, agentTypes, prompts, perTaskContext, options) {
  const anyContext = perTaskContext.some((c) => c);

  if (!anyContext) {
    return spawnParallel(agentTypes, prompts, {
      sessionId: options.sessionId,
      cwd: options.cwd,
    });
  }

  // Mixed/with-context: one spawnParallel call per subtask so each gets its own
  // mainContext, executed concurrently.
  const calls = agentTypes.map((type, i) =>
    spawnParallel([type], [prompts[i]], {
      sessionId: options.sessionId,
      cwd: options.cwd,
      mainContext: perTaskContext[i] ? { relevant_context: perTaskContext[i] } : undefined,
    }).then((arr) => arr[0])
  );
  return Promise.all(calls);
}

module.exports = {
  dispatchPlan,
  topologicalLevels,
  buildContextForSubtask,
  compressResult,
  MAX_CONTEXT_CHARS,
};
