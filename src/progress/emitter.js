/**
 * Progress Event Emitter
 *
 * Emits progress events during agent execution for real-time monitoring.
 * Events can be subscribed to by WebSocket clients or other listeners.
 */

const EventEmitter = require('events');
const logger = require('../logger');

class ProgressEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // Allow many concurrent listeners
  }

  /**
   * Emit an agent loop started event
   */
  agentLoopStarted({ sessionId, agentId, parentAgentId, parentCallId, model, maxSteps, maxDurationMs, providerType }) {
    const event = {
      type: 'agent_loop_started',
      sessionId,
      agentId,
      parentAgentId,
      parentCallId,
      model,
      maxSteps,
      maxDurationMs,
      providerType,
      timestamp: Date.now(),
    };
    this.emit('progress', event);
    logger.debug(event, '[Progress] Agent loop started');
  }

  /**
   * Emit an agent loop step started event
   */
  agentLoopStepStarted({ sessionId, agentId, step, maxSteps }) {
    const event = {
      type: 'agent_loop_step_started',
      sessionId,
      agentId,
      step,
      maxSteps,
      progress: Math.round((step / maxSteps) * 100),
      timestamp: Date.now(),
    };
    this.emit('progress', event);
    logger.debug(event, '[Progress] Agent loop step started');
  }

  /**
   * Emit a model invocation started event
   */
  modelInvocationStarted({ sessionId, agentId, step, model, providerType, estimatedTokens }) {
    const event = {
      type: 'model_invocation_started',
      sessionId,
      agentId,
      step,
      model,
      providerType,
      estimatedTokens,
      timestamp: Date.now(),
    };
    this.emit('progress', event);
    logger.debug(event, '[Progress] Model invocation started');
  }

  /**
   * Emit a model invocation completed event
   */
  modelInvocationCompleted({ sessionId, agentId, step, model, providerType, inputTokens, outputTokens, durationMs }) {
    const event = {
      type: 'model_invocation_completed',
      sessionId,
      agentId,
      step,
      model,
      providerType,
      inputTokens,
      outputTokens,
      durationMs,
      timestamp: Date.now(),
    };
    this.emit('progress', event);
    logger.debug(event, '[Progress] Model invocation completed');
  }

  /**
   * Emit a tool execution started event
   * requestPreview: First 200 characters of tool arguments
   */
  toolExecutionStarted({ sessionId, agentId, step, toolName, toolId, requestPreview }) {
    const event = {
      type: 'tool_execution_started',
      sessionId,
      agentId,
      step,
      toolName,
      toolId,
      requestPreview,
      timestamp: Date.now(),
    };
    this.emit('progress', event);
    logger.debug(event, '[Progress] Tool execution started');
  }

  /**
   * Emit a tool execution completed event
   * responsePreview: First 200 characters of tool result
   */
  toolExecutionCompleted({ sessionId, agentId, step, toolName, toolId, ok, durationMs, responsePreview }) {
    const event = {
      type: 'tool_execution_completed',
      sessionId,
      agentId,
      step,
      toolName,
      toolId,
      ok,
      durationMs,
      responsePreview,
      timestamp: Date.now(),
    };
    this.emit('progress', event);
    logger.debug(event, '[Progress] Tool execution completed');
  }

  /**
   * Emit an agent loop completed event
   */
  agentLoopCompleted({ sessionId, agentId, steps, toolCallsExecuted, durationMs, terminationReason }) {
    const event = {
      type: 'agent_loop_completed',
      sessionId,
      agentId,
      steps,
      toolCallsExecuted,
      durationMs,
      terminationReason,
      timestamp: Date.now(),
    };
    this.emit('progress', event);
    logger.debug(event, '[Progress] Agent loop completed');
  }

  /**
   * Emit an error event
   */
  error({ sessionId, errorType, errorMessage }) {
    const event = {
      type: 'error',
      sessionId,
      errorType,
      errorMessage,
      timestamp: Date.now(),
    };
    this.emit('progress', event);
    logger.debug(event, '[Progress] Error');
  }

  /**
   * Emit a custom progress event
   */
  custom(event) {
    event.timestamp = Date.now();
    this.emit('progress', event);
    logger.debug(event, '[Progress] Custom event');
  }
}

// Singleton instance
let instance = null;

/**
 * Get the ProgressEmitter singleton instance
 */
function getProgressEmitter() {
  if (!instance) {
    instance = new ProgressEmitter();
  }
  return instance;
}

/**
 * Reset the singleton (mainly for testing)
 */
function resetProgressEmitter() {
  if (instance) {
    instance.removeAllListeners();
    instance = null;
  }
}

module.exports = {
  ProgressEmitter,
  getProgressEmitter,
  resetProgressEmitter,
};