const config = require("../config");
const logger = require("../logger");

const POLL_INTERVAL_MS = 5000;  // 5 seconds
const MAX_WAIT_MS = 60000;      // 60 seconds

/**
 * Wait for Ollama server to be ready and model to be loaded.
 * Only runs when Ollama is the configured provider.
 *
 * @returns {Promise<boolean>} true if Ollama is ready, false if timeout
 */
async function waitForOllama() {
  const endpoint = config.ollama?.endpoint;
  const model = config.ollama?.model;

  if (!endpoint) {
    return true;
  }

  console.log(`[Ollama] Waiting for server at ${endpoint}...`);
  console.log(`[Ollama] Model: ${model}`);

  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    attempt++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    try {
      // Check if server is reachable
      const tagsResponse = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000)
      });

      if (!tagsResponse.ok) {
        console.log(`[Ollama] Server not ready (${elapsed}s elapsed)...`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const tagsData = await tagsResponse.json();
      const models = tagsData.models || [];
      const modelNames = models.map(m => m.name);

      // Check if our model is available
      const modelReady = modelNames.some(name =>
        name === model || name.startsWith(`${model}:`)
      );

      if (modelReady) {
        console.log(`[Ollama] Server ready, model "${model}" available (${elapsed}s)`);
        logger.info({
          endpoint,
          model,
          elapsedSeconds: elapsed,
          attempts: attempt
        }, "Ollama startup check passed");
        return true;
      }

      // Model not yet available - try to preload it
      console.log(`[Ollama] Server up, loading model "${model}" (${elapsed}s elapsed)...`);
      logger.info({
        endpoint,
        model,
        availableModels: modelNames
      }, "Ollama server up, preloading model");

      // Preload model with empty generate request
      try {
        const preloadBody = { model, prompt: "", stream: false };

        // Use keep_alive setting if configured
        if (config.ollama.keepAlive !== undefined) {
          const keepAlive = config.ollama.keepAlive;
          preloadBody.keep_alive = /^-?\d+$/.test(keepAlive)
            ? parseInt(keepAlive, 10)
            : keepAlive;
        }

        await fetch(`${endpoint}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(preloadBody),
          signal: AbortSignal.timeout(30000)
        });
      } catch (preloadErr) {
        // Ignore preload errors, we'll check again on next iteration
        logger.debug({ error: preloadErr.message }, "Ollama model preload request failed (will retry)");
      }

    } catch (err) {
      console.log(`[Ollama] Waiting for server (${elapsed}s elapsed)...`);
      logger.debug({
        error: err.message,
        attempt,
        elapsed
      }, "Ollama server not yet reachable");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.error(`[Ollama] Timeout after 60s - server or model not ready`);
  console.error(`[Ollama] Continuing startup, but requests may fail`);
  logger.warn({
    endpoint,
    model,
    maxWaitMs: MAX_WAIT_MS
  }, "Ollama startup check timed out - continuing anyway");
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { waitForOllama };
