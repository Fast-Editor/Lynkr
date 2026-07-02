const logger = require("../logger");
const config = require("../config");
const AgentDefinitionLoader = require("./definitions/loader");
const ParallelCoordinator = require("./parallel-coordinator");
const agentStore = require("./store");

const definitionLoader = new AgentDefinitionLoader();
const coordinator = new ParallelCoordinator(config.agents?.maxConcurrent || 10, {
  definitionLoader,
});

// Periodically drop learned skills that have proven unhelpful. Only when the
// agents subsystem is active; the timer is unref'd so it never blocks exit.
if (config.agents?.enabled) {
  definitionLoader.startSkillPruning();
}

/**
 * Spawn and execute subagent(s)
 * @param {string|Array} agentType - Agent type(s) to spawn
 * @param {string|Array} prompt - Task prompt(s)
 * @param {Object} options - sessionId, mainContext, etc.
 * @returns {Promise<Object>} - Execution result(s)
 */
async function spawnAgent(agentType, prompt, options = {}) {
  if (!config.agents?.enabled) {
    throw new Error("Agents disabled. Set AGENTS_ENABLED=true");
  }

  // Handle parallel execution
  if (Array.isArray(agentType)) {
    return await spawnParallel(agentType, prompt, options);
  }

  // Single agent execution
  logger.info({
    agentType,
    prompt: prompt.slice(0, 100),
    sessionId: options.sessionId
  }, "Spawning subagent");

  // Get agent definition
  const agentDef = definitionLoader.getAgent(agentType);

  if (!agentDef) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }

  // Record in store
  const executionId = agentStore.createExecution({
    sessionId: options.sessionId,
    agentType,
    prompt,
    model: agentDef.model
  });

  // Execute
  const result = await coordinator.executeSingle(agentDef, prompt, options);

  // Update store
  if (result.success) {
    agentStore.completeExecution(executionId, result.result, result.stats);
  } else {
    agentStore.failExecution(executionId, { message: result.error }, result.stats);
  }

  return result;
}

/**
 * Spawn multiple agents in parallel
 */
async function spawnParallel(agentTypes, prompts, options = {}) {
  if (!Array.isArray(prompts) || agentTypes.length !== prompts.length) {
    throw new Error("agentTypes and prompts must be arrays of same length");
  }

  logger.info({
    count: agentTypes.length,
    sessionId: options.sessionId
  }, "Spawning parallel subagents");

  // Build tasks
  const tasks = agentTypes.map((type, i) => {
    const agentDef = definitionLoader.getAgent(type);

    if (!agentDef) {
      throw new Error(`Unknown agent type: ${type}`);
    }

    const executionId = agentStore.createExecution({
      sessionId: options.sessionId,
      agentType: type,
      prompt: prompts[i],
      model: agentDef.model
    });

    return {
      agentDef,
      taskPrompt: prompts[i],
      options: { ...options, executionId }
    };
  });

  // Execute in parallel with batching
  const results = await coordinator.executeBatched(tasks);

  // Update store for each result
  results.forEach((result, i) => {
    const executionId = tasks[i].options.executionId;

    if (result.success) {
      agentStore.completeExecution(executionId, result.result, result.stats);
    } else {
      agentStore.failExecution(executionId, { message: result.error }, result.stats);
    }
  });

  return results;
}

/**
 * Auto-select agent based on task description
 */
function autoSelectAgent(taskDescription) {
  return definitionLoader.findAgentForTask(taskDescription);
}

/**
 * Register custom agent programmatically
 */
function registerAgent(name, definition) {
  definitionLoader.registerAgent(name, definition);
}

/**
 * Get all available agents
 */
function listAgents() {
  return definitionLoader.getAllAgents();
}

/**
 * Get agent execution stats
 */
function getAgentStats() {
  return agentStore.getStats();
}

/**
 * Get specific execution details
 */
function getAgentExecution(executionId) {
  return agentStore.getExecution(executionId);
}

module.exports = {
  spawnAgent,
  spawnParallel,
  autoSelectAgent,
  registerAgent,
  listAgents,
  getAgentStats,
  getAgentExecution
};
