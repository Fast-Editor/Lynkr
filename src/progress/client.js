/**
 * Progress Client - Sends progress updates to an external listener
 *
 * This module provides a simple way to send progress updates from Lynkr
 * to an external server (e.g., Python progress listener) during agent execution.
 *
 * Usage:
 *   const progress = require('../progress/client');
 *   progress.startStep({ step: 1, message: "Thinking..." });
 *   progress.update({ percent: 50, message: "Executing tools..." });
 *   progress.complete();
 */

const http = require('http');
const https = require('https');
const logger = require('../logger');

// Configuration from environment
const PROGRESS_ENABLED = process.env.PROGRESS_ENABLED === 'true';
const PROGRESS_URL = process.env.PROGRESS_URL || 'http://localhost:7337';
const PROGRESS_TIMEOUT_MS = parseInt(process.env.PROGRESS_TIMEOUT_MS || '5000', 10);

// Session tracking
let currentSessionId = null;
let currentStep = 0;
let startTime = null;

/**
 * Parse the progress URL to extract protocol, host, port, and path
 */
function parseProgressUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname || '/progress'
    };
  } catch (err) {
    logger.warn({ url, error: err.message }, 'Failed to parse PROGRESS_URL');
    return null;
  }
}

/**
 * Send a progress update to the external server
 */
function sendProgressUpdate(type, data = {}) {
  if (!PROGRESS_ENABLED) {
    return; // Progress reporting disabled
  }

  const urlInfo = parseProgressUrl(PROGRESS_URL);
  if (!urlInfo) {
    return;
  }

  const payload = {
    type,
    sessionId: currentSessionId,
    timestamp: Date.now(),
    step: currentStep,
    elapsedMs: startTime ? Date.now() - startTime : null,
    ...data
  };

  const postData = JSON.stringify(payload);

  const options = {
    hostname: urlInfo.host,
    port: urlInfo.port,
    path: urlInfo.path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
    timeout: PROGRESS_TIMEOUT_MS,
  };

  const client = urlInfo.protocol === 'https:' ? https : http;

  const req = client.request(options, (res) => {
    // Silently consume response
    res.on('data', () => {});
    res.on('end', () => {});
  });

  req.on('error', (err) => {
    // Silently ignore errors - progress updates are fire-and-forget
    // Only log at debug level to avoid spamming logs
    logger.debug({
      error: err.message,
      progressUrl: PROGRESS_URL
    }, 'Progress update failed (non-critical)');
  });

  req.on('timeout', () => {
    req.destroy();
    logger.debug({
      progressUrl: PROGRESS_URL
    }, 'Progress update timed out (non-critical)');
  });

  req.write(postData);
  req.end();
}

/**
 * Start a new session
 */
function startSession(sessionId) {
  currentSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  currentStep = 0;
  startTime = Date.now();

  logger.debug({ sessionId: currentSessionId }, 'Progress session started');
  sendProgressUpdate('session_start', { sessionId: currentSessionId });
}

/**
 * Start a new step in the agent loop
 */
function startStep(stepInfo) {
  currentStep = stepInfo.step || (currentStep + 1);
  const info = {
    step: currentStep,
    message: stepInfo.message || `Step ${currentStep}`,
    maxSteps: stepInfo.maxSteps,
    toolCallsCount: stepInfo.toolCallsCount,
  };

  logger.debug(info, 'Progress step started');
  sendProgressUpdate('step_start', info);
}

/**
 * Update progress within the current step
 */
function update(updateInfo) {
  const info = {
    step: currentStep,
    message: updateInfo.message || '',
    percent: updateInfo.percent,
    detail: updateInfo.detail,
  };

  logger.debug(info, 'Progress updated');
  sendProgressUpdate('progress', info);
}

/**
 * Report that the LLM is being called
 */
function callingModel(modelInfo) {
  const info = {
    step: currentStep,
    provider: modelInfo.provider,
    model: modelInfo.model,
    message: `Calling ${modelInfo.provider} model: ${modelInfo.model}`,
  };

  logger.debug(info, 'Progress: calling model');
  sendProgressUpdate('model_call', info);
}

/**
 * Report that tools are being executed
 */
function executingTools(toolInfo) {
  const info = {
    step: currentStep,
    toolCount: toolInfo.toolCount,
    toolNames: toolInfo.toolNames,
    message: toolInfo.message || `Executing ${toolInfo.toolCount} tool(s)`,
  };

  logger.debug(info, 'Progress: executing tools');
  sendProgressUpdate('tools_execute', info);
}

/**
 * Report a tool result
 */
function toolResult(toolInfo) {
  const info = {
    step: currentStep,
    toolName: toolInfo.toolName,
    ok: toolInfo.ok,
    message: toolInfo.message || `Tool ${toolInfo.toolName} ${toolInfo.ok ? 'completed' : 'failed'}`,
  };

  logger.debug(info, 'Progress: tool result');
  sendProgressUpdate('tool_result', info);
}

/**
 * Report an error
 */
function error(errorInfo) {
  const info = {
    step: currentStep,
    error: errorInfo.error,
    message: errorInfo.message || 'An error occurred',
  };

  logger.debug(info, 'Progress: error');
  sendProgressUpdate('error', info);
}

/**
 * Complete the session successfully
 */
function complete(completionInfo = {}) {
  const info = {
    step: currentStep,
    totalSteps: currentStep,
    durationMs: startTime ? Date.now() - startTime : null,
    message: completionInfo.message || 'Completed successfully',
    terminationReason: completionInfo.terminationReason,
  };

  logger.debug(info, 'Progress: session completed');
  sendProgressUpdate('session_complete', info);

  // Reset session state
  currentSessionId = null;
  currentStep = 0;
  startTime = null;
}

/**
 * End the session with an error
 */
function abort(errorInfo = {}) {
  const info = {
    step: currentStep,
    totalSteps: currentStep,
    durationMs: startTime ? Date.now() - startTime : null,
    error: errorInfo.error,
    message: errorInfo.message || 'Session aborted',
  };

  logger.debug(info, 'Progress: session aborted');
  sendProgressUpdate('session_abort', info);

  // Reset session state
  currentSessionId = null;
  currentStep = 0;
  startTime = null;
}

/**
 * Get current progress state
 */
function getState() {
  return {
    enabled: PROGRESS_ENABLED,
    progressUrl: PROGRESS_URL,
    sessionId: currentSessionId,
    step: currentStep,
    startTime,
    elapsedMs: startTime ? Date.now() - startTime : null,
  };
}

module.exports = {
  startSession,
  startStep,
  update,
  callingModel,
  executingTools,
  toolResult,
  error,
  complete,
  abort,
  getState,
  // Configuration constants
  PROGRESS_ENABLED,
  PROGRESS_URL,
  PROGRESS_TIMEOUT_MS,
};