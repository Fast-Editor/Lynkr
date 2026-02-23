const { URL } = require("url");
const { Agent } = require("undici");
const config = require("../config");
const logger = require("../logger");
const { registerTool } = require(".");

/**
 * Dedicated HTTP agent for TinyFish SSE streams.
 * The default webAgent in web-client.js has a 30s bodyTimeout which is too
 * short for browser-automation tasks that can take up to 120s.
 */
const sseAgent = new Agent({
  connections: 10,
  pipelining: 1,
  keepAliveTimeout: 60000,
  connectTimeout: 15000,
  bodyTimeout: 0, // no body timeout — we manage timeout via AbortController
  headersTimeout: 15000,
  maxRedirections: 3,
  strictContentLength: false,
});

// ---------------------------------------------------------------------------
// Argument normalisers
// ---------------------------------------------------------------------------

function normalizeUrl(args) {
  const raw = args.url ?? args.uri ?? args.href ?? args.target_url;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("web_agent requires a non-empty url string.");
  }
  // Validate URL
  try {
    new URL(raw.trim());
  } catch {
    throw new Error(`web_agent received an invalid URL: ${raw}`);
  }
  return raw.trim();
}

function normalizeGoal(args) {
  const goal = args.goal ?? args.task ?? args.prompt ?? args.instruction;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new Error("web_agent requires a non-empty goal string.");
  }
  return goal.trim();
}

function resolveBrowserProfile(args) {
  const profile = args.browser_profile ?? args.browserProfile ?? config.tinyfish.browserProfile;
  if (profile === "stealth") return "stealth";
  return "lite";
}

// ---------------------------------------------------------------------------
// SSE stream consumer
// ---------------------------------------------------------------------------

async function consumeSSEStream(response, timeoutMs) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const startTime = Date.now();

  try {
    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        const err = new Error(`TinyFish SSE stream timed out after ${timeoutMs}ms`);
        err.code = "ETIMEDOUT";
        err.status = 504;
        throw err;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split("\n\n");
      // Keep the last (possibly incomplete) chunk in the buffer
      buffer = parts.pop() || "";

      for (const part of parts) {
        // Extract the data: line(s)
        const lines = part.split("\n");
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataStr += line.slice(6);
          } else if (line.startsWith("data:")) {
            dataStr += line.slice(5);
          }
        }

        if (!dataStr) continue;

        let event;
        try {
          event = JSON.parse(dataStr);
        } catch {
          // Not valid JSON — skip this SSE frame
          logger.debug({ raw: dataStr.slice(0, 200) }, "TinyFish: non-JSON SSE frame, skipping");
          continue;
        }

        logger.debug(
          { type: event.type, status: event.status },
          "TinyFish SSE event"
        );

        if (event.type === "COMPLETE" || event.type === "complete") {
          const status = (event.status ?? "").toUpperCase();
          if (status === "COMPLETED" || status === "SUCCESS") {
            return event.resultJson ?? event.result ?? event.data ?? event;
          }
          // Task failed
          const errMsg = event.error ?? event.message ?? "TinyFish task failed";
          const err = new Error(typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg));
          err.code = "TINYFISH_TASK_FAILED";
          err.status = 502;
          throw err;
        }
      }
    }

    // Stream ended without a COMPLETE event
    const err = new Error("TinyFish SSE stream ended without a COMPLETE event");
    err.code = "TINYFISH_INCOMPLETE";
    err.status = 502;
    throw err;
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Core API call
// ---------------------------------------------------------------------------

async function callTinyFishAPI({ url, goal, browserProfile, proxyConfig, timeoutMs }) {
  const endpoint = config.tinyfish.endpoint;
  const apiKey = config.tinyfish.apiKey;

  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      content: JSON.stringify({
        error: "tinyfish_not_configured",
        message:
          "TinyFish API key is not configured. Set TINYFISH_API_KEY in your .env file. Get a key from https://tinyfish.ai",
      }, null, 2),
    };
  }

  const body = {
    url,
    goal,
    browserProfile,
  };

  if (proxyConfig) {
    body.proxy = proxyConfig;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher: sseAgent,
    });

    // Handle non-2xx responses before attempting SSE parse
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const shouldRetry = response.status === 429 || response.status >= 500;

      if (shouldRetry) {
        // Retry once with 2s backoff
        logger.warn(
          { status: response.status, body: text.slice(0, 200) },
          "TinyFish API error, retrying once"
        );
        await new Promise((r) => setTimeout(r, 2000));

        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), timeoutMs);
        try {
          const retryResponse = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
              Accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: retryController.signal,
            dispatcher: sseAgent,
          });

          if (!retryResponse.ok) {
            const retryText = await retryResponse.text().catch(() => "");
            const err = new Error(
              `TinyFish API error (${retryResponse.status}): ${retryResponse.statusText}`
            );
            err.status = retryResponse.status;
            err.body = retryText;
            throw err;
          }

          const result = await consumeSSEStream(retryResponse, timeoutMs);
          return {
            ok: true,
            status: 200,
            result,
          };
        } finally {
          clearTimeout(retryTimeout);
        }
      }

      const err = new Error(
        `TinyFish API error (${response.status}): ${response.statusText}`
      );
      err.status = response.status;
      err.body = text;
      throw err;
    }

    const result = await consumeSSEStream(response, timeoutMs);
    return {
      ok: true,
      status: 200,
      result,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const err = new Error(`TinyFish request timed out after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      err.status = 504;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTinyFishTool() {
  registerTool(
    "web_agent",
    async ({ args = {} }) => {
      const url = normalizeUrl(args);
      const goal = normalizeGoal(args);
      const browserProfile = resolveBrowserProfile(args);
      const timeoutMs = config.tinyfish.timeoutMs;

      // Build proxy config if enabled
      let proxyConfig = null;
      if (config.tinyfish.proxyEnabled) {
        proxyConfig = {
          enabled: true,
          country: config.tinyfish.proxyCountry,
        };
      }

      try {
        const response = await callTinyFishAPI({
          url,
          goal,
          browserProfile,
          proxyConfig,
          timeoutMs,
        });

        // Guard clause: not configured
        if (!response.ok && response.status === 503) {
          return response;
        }

        const resultStr =
          typeof response.result === "string"
            ? response.result
            : JSON.stringify(response.result, null, 2);

        logger.debug(
          {
            url,
            goal: goal.slice(0, 100),
            browserProfile,
            resultLength: resultStr.length,
          },
          "TinyFish web_agent completed"
        );

        return {
          ok: true,
          status: 200,
          content: resultStr,
          metadata: {
            url,
            goal,
            browserProfile,
            resultLength: resultStr.length,
          },
        };
      } catch (err) {
        logger.error(
          { err, url, goal: goal.slice(0, 100) },
          "web_agent request failed"
        );
        return {
          ok: false,
          status: err.status ?? 500,
          content: JSON.stringify(
            {
              error: err.code ?? "web_agent_failed",
              message: err.message,
              url,
              ...(err.status ? { http_status: err.status } : {}),
            },
            null,
            2
          ),
          metadata: {
            url,
            goal,
            error_code: err.code,
            ...(err.status ? { http_status: err.status } : {}),
          },
        };
      }
    },
    { category: "tinyfish" }
  );
}

function registerTinyFishTools() {
  registerTinyFishTool();
}

module.exports = {
  registerTinyFishTools,
};
