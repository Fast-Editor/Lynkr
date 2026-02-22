const config = require("../config");
const logger = require("../logger");
const { getOllamaHeaders, isCloudModel, getOllamaEndpointForModel } = require("./ollama-utils");

const POLL_INTERVAL_MS = 5000;  // 5 seconds
const MAX_WAIT_MS = parseInt(process.env.OLLAMA_STARTUP_TIMEOUT_MS || "300000", 10); // 5 minutes default

/**
 * Check if Ollama server is reachable
 * @returns {Promise<boolean>}
 */
async function checkServerReachable(endpoint) {
  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      headers: getOllamaHeaders(),
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch (err) {
    return false;
  }
}

/**
 * Check if model exists locally (downloaded)
 * @returns {Promise<{exists: boolean, models: string[]}>}
 */
async function checkModelExists(endpoint, model) {
  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      headers: getOllamaHeaders(),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return { exists: false, models: [] };
    }

    const data = await response.json();
    const models = data.models || [];
    const modelNames = models.map(m => m.name);

    const exists = modelNames.some(name =>
      name === model || name.startsWith(`${model}:`)
    );

    return { exists, models: modelNames };
  } catch (err) {
    logger.debug({ error: err.message }, "Failed to check model existence");
    return { exists: false, models: [] };
  }
}

/**
 * Check if model is currently loaded in memory
 * @returns {Promise<boolean>}
 */
async function checkModelLoaded(endpoint, model) {
  try {
    const response = await fetch(`${endpoint}/api/ps`, {
      headers: getOllamaHeaders(),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    const loadedModels = data.models || [];

    return loadedModels.some(m =>
      m.name === model || m.name.startsWith(`${model}:`)
    );
  } catch (err) {
    logger.debug({ error: err.message }, "Failed to check if model is loaded");
    return false;
  }
}

/**
 * Pull (download) a model from Ollama registry
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function pullModel(endpoint, model) {
  console.log(`[Ollama] Model "${model}" not found locally, pulling from registry...`);
  logger.info({ model }, "Pulling Ollama model");

  try {
    const response = await fetch(`${endpoint}/api/pull`, {
      method: "POST",
      headers: getOllamaHeaders(),
      body: JSON.stringify({ name: model, stream: false }),
      signal: AbortSignal.timeout(300000) // 5 minutes for model download
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = "Unknown error";

      try {
        const errorData = JSON.parse(errorText);
        errorMsg = errorData.error || errorText;
      } catch {
        errorMsg = errorText;
      }

      // Parse specific error cases
      if (errorMsg.includes("not found") || errorMsg.includes("does not exist")) {
        return {
          success: false,
          error: `Model "${model}" not found in Ollama registry. Check available models at: https://ollama.com/library`
        };
      } else if (errorMsg.includes("connect") || errorMsg.includes("ECONNREFUSED")) {
        return {
          success: false,
          error: "Cannot pull model: Ollama service unreachable"
        };
      } else if (errorMsg.includes("disk") || errorMsg.includes("space")) {
        return {
          success: false,
          error: "Model pull failed: insufficient disk space"
        };
      } else if (errorMsg.includes("permission")) {
        return {
          success: false,
          error: `Model pull failed: permission denied. Try: sudo ollama pull ${model}`
        };
      } else if (errorMsg.includes("network") || errorMsg.includes("timeout")) {
        return {
          success: false,
          error: "Model pull failed: network error. Check internet connection"
        };
      }

      return {
        success: false,
        error: `Model pull failed: ${errorMsg}`
      };
    }

    console.log(`[Ollama] Model "${model}" pulled successfully`);
    logger.info({ model }, "Ollama model pulled successfully");
    return { success: true };

  } catch (err) {
    if (err.name === "AbortError") {
      return {
        success: false,
        error: "Model pull timeout (5 minutes). Model may be too large or connection too slow."
      };
    }
    return {
      success: false,
      error: `Model pull failed: ${err.message}`
    };
  }
}

/**
 * Load a model into memory by sending a simple message
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function loadModel(endpoint, model, keepAlive) {
  console.log(`[Ollama] Loading model "${model}" into memory...`);
  logger.info({ model }, "Loading Ollama model");

  try {
    const body = {
      model,
      messages: [{ role: "user", content: "hi" }],
      stream: false
    };

    // Use keep_alive setting if configured
    if (keepAlive !== undefined) {
      body.keep_alive = /^-?\d+$/.test(keepAlive)
        ? parseInt(keepAlive, 10)
        : keepAlive;
    }

    const response = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: getOllamaHeaders(model),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000) // 2 minutes for model load
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Model load failed: ${errorText}`
      };
    }

    console.log(`[Ollama] Model "${model}" loaded successfully`);
    logger.info({ model }, "Ollama model loaded into memory");
    return { success: true };

  } catch (err) {
    if (err.name === "AbortError") {
      return {
        success: false,
        error: "Model load timeout (2 minutes). Model may be very large."
      };
    }
    return {
      success: false,
      error: `Model load failed: ${err.message}`
    };
  }
}

/**
 * Ensure Ollama model is ready (exists, pulled if needed, loaded)
 * Can be called at startup or on-demand
 *
 * @param {boolean} isStartup - true if called during server startup, false for on-demand
 * @returns {Promise<{ready: boolean, error?: string}>}
 */
async function ensureModelReady(endpoint, model, keepAlive, isStartup = true) {
  const startTime = Date.now();
  const maxWaitMs = isStartup ? MAX_WAIT_MS : 180000; // 3 minutes for on-demand
  let attempt = 0;

  const cloud = isCloudModel(model);

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Cloud models skip local-only checks (server reachable, model exists/loaded, pull).
    // Just send a test chat request to verify the cloud endpoint responds.
    if (cloud) {
      logger.info({ model, endpoint, attempt }, "Cloud model detected, skipping local checks");
      const loadResult = await loadModel(endpoint, model, keepAlive);
      if (loadResult.success) {
        console.log(`[Ollama] Cloud model "${model}" ready (${elapsed}s)`);
        return { ready: true };
      }
      if (!isStartup) {
        return { ready: false, error: loadResult.error };
      }
      logger.debug({ error: loadResult.error }, "Cloud model load failed, will retry");
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Step 1: Check if server is reachable
    const serverReachable = await checkServerReachable(endpoint);
    if (!serverReachable) {
      if (isStartup) {
        console.log(`[Ollama] Waiting for server (${elapsed}s elapsed)...`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      } else {
        return {
          ready: false,
          error: `Ollama service unreachable at ${endpoint}. Is it running?`
        };
      }
    }

    // Step 2: Check if model is loaded in memory
    const loaded = await checkModelLoaded(endpoint, model);
    if (loaded) {
      if (isStartup) {
        console.log(`[Ollama] Model "${model}" ready (${elapsed}s)`);
      }
      logger.info({
        endpoint,
        model,
        elapsedSeconds: elapsed,
        attempts: attempt
      }, "Ollama model ready");
      return { ready: true };
    }

    // Step 3: Check if model exists locally
    const { exists, models } = await checkModelExists(endpoint, model);

    if (!exists) {
      // Model not downloaded - try to pull it
      console.log(`[Ollama] Model "${model}" not found locally (${elapsed}s elapsed)`);
      logger.info({
        model,
        availableModels: models
      }, "Ollama model not found locally, attempting pull");

      const pullResult = await pullModel(endpoint, model);
      if (!pullResult.success) {
        // Pull failed - return error immediately, don't keep retrying
        return {
          ready: false,
          error: pullResult.error
        };
      }

      // Pull succeeded - continue to load it
      console.log(`[Ollama] Model pulled, now loading...`);
    }

    // Step 4: Model exists but not loaded - load it
    console.log(`[Ollama] Loading model "${model}" (${elapsed}s elapsed)...`);
    const loadResult = await loadModel(endpoint, model, keepAlive);

    if (!loadResult.success) {
      if (isStartup) {
        logger.debug({ error: loadResult.error }, "Model load failed, will retry");
        await sleep(POLL_INTERVAL_MS);
        continue;
      } else {
        return {
          ready: false,
          error: loadResult.error
        };
      }
    }

    // Load succeeded — the model responded to a chat request, so it's ready.
    // Skip the /api/ps re-check: cloud models (e.g. ollama.com) may not
    // appear in /api/ps, which would cause an infinite retry loop.
    console.log(`[Ollama] Model "${model}" ready (${elapsed}s)`);
    return { ready: true };
  }

  // Timeout
  if (isStartup) {
    console.error(`[Ollama] Timeout after ${Math.round(maxWaitMs/1000)}s - model not ready`);
    console.error(`[Ollama] Continuing startup, but requests may fail`);
    logger.warn({
      endpoint,
      model,
      maxWaitMs
    }, "Ollama startup check timed out - continuing anyway");
    return { ready: false };
  } else {
    return {
      ready: false,
      error: `Timeout after ${Math.round(maxWaitMs/1000)}s waiting for model "${model}" to load`
    };
  }
}

/**
 * Wait for Ollama server to be ready and model to be loaded.
 * Only runs when Ollama is the configured provider.
 *
 * @returns {Promise<boolean>} true if Ollama is ready, false if timeout
 */
async function waitForOllama() {
  const model = config.ollama?.model;
  const keepAlive = config.ollama?.keepAlive;
  const endpoint = getOllamaEndpointForModel(model);

  if (!config.ollama?.endpoint && !config.ollama?.cloudEndpoint) {
    return true;
  }

  console.log(`[Ollama] Waiting for server at ${endpoint}...`);
  console.log(`[Ollama] Model: ${model}${isCloudModel(model) ? ' (cloud)' : ''}`);
  console.log(`[Ollama] Timeout: ${Math.round(MAX_WAIT_MS/1000)}s`);

  const result = await ensureModelReady(endpoint, model, keepAlive, true);

  // Also pre-load the tool execution model if it uses Ollama and is a different model
  const toolProvider = config.toolExecutionProvider;
  const toolModel = config.toolExecutionModel;
  if (result.ready && toolProvider === 'ollama' && toolModel && toolModel !== model) {
    const toolEndpoint = getOllamaEndpointForModel(toolModel);
    console.log(`[Ollama] Also loading tool execution model: ${toolModel}${isCloudModel(toolModel) ? ' (cloud)' : ''}`);
    const toolResult = await ensureModelReady(toolEndpoint, toolModel, keepAlive, true);
    if (!toolResult.ready) {
      console.warn(`[Ollama] Tool execution model "${toolModel}" failed to load - tool routing may fall back`);
    }
  }

  return result.ready;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  waitForOllama,
  ensureModelReady,
  checkModelLoaded,
  checkModelExists,
  pullModel,
  loadModel
};
