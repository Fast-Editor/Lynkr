const logger = require("../logger");
const SubagentExecutor = require("./executor");

class ParallelCoordinator {
  constructor(maxConcurrent = 10, { definitionLoader = null } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.executor = new SubagentExecutor({ definitionLoader });
  }

  /**
   * Execute multiple subagents in parallel with batching
   * @param {Array} tasks - Array of { agentDef, taskPrompt, options }
   * @returns {Promise<Array>} - Array of results
   */
  async executeBatched(tasks) {
    if (tasks.length === 0) {
      return [];
    }

    logger.info({
      totalTasks: tasks.length,
      maxConcurrent: this.maxConcurrent
    }, "Starting batched subagent execution");

    const results = [];
    let processed = 0;

    // Process in batches
    while (processed < tasks.length) {
      const batch = tasks.slice(processed, processed + this.maxConcurrent);

      logger.debug({
        batchSize: batch.length,
        processed,
        remaining: tasks.length - processed - batch.length
      }, "Processing subagent batch");

      // Execute batch in parallel
      const batchResults = await Promise.all(
        batch.map(task => this.executor.execute(
          task.agentDef,
          task.taskPrompt,
          task.options
        ))
      );

      results.push(...batchResults);
      processed += batch.length;

      logger.info({
        completedInBatch: batch.length,
        totalCompleted: processed,
        totalTasks: tasks.length
      }, "Completed subagent batch");
    }

    return results;
  }

  /**
   * Execute single subagent (convenience method)
   */
  async executeSingle(agentDef, taskPrompt, options = {}) {
    return this.executor.execute(agentDef, taskPrompt, options);
  }
}

module.exports = ParallelCoordinator;
