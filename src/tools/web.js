const { URL } = require("url");
const config = require("../config");
const logger = require("../logger");
const { registerTool } = require(".");
const { withRetry } = require("../clients/retry");
const { fetchWithAgent } = require("./web-client");

const DEFAULT_MAX_RESULTS = 5;

/**
 * Extract readable text from HTML
 * Removes scripts, styles, and extracts meaningful content
 */
function extractTextFromHtml(html) {
  if (typeof html !== "string") return "";

  let text = html;

  // Remove script and style tags with their content
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Convert common block elements to newlines
  text = text.replace(/<\/(div|p|br|h[1-6]|li|tr|section|article|header|footer|nav)>/gi, "\n");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

  // Normalize whitespace
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/\r/g, "\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n\s+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

function normaliseQuery(args = {}) {
  const query = args.query ?? args.q ?? args.prompt ?? args.search ?? args.input;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("web_search requires a non-empty query string.");
  }
  return query.trim();
}

function resolveLimit(args = {}) {
  const raw = args.limit ?? args.top_k ?? args.max_results;
  if (raw === undefined) return DEFAULT_MAX_RESULTS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(parsed, 20);
}

function buildAllowedHosts() {
  if (config.webSearch.allowAllHosts) {
    return null;
  }
  const configured = config.webSearch.allowedHosts ?? [];
  const hosts = new Set();
  if (config.webSearch.endpoint) {
    try {
      const endpointHost = new URL(config.webSearch.endpoint).hostname.toLowerCase();
      hosts.add(endpointHost);
    } catch {
      // ignore parse errors; config already validated
    }
  }
  configured.forEach((host) => hosts.add(host));
  return hosts;
}

function buildSearchUrl({ query, limit }) {
  const endpoint = new URL(config.webSearch.endpoint);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("per_page", String(limit));
  return endpoint;
}

async function performSearch({ query, limit, timeoutMs }) {
  const url = buildSearchUrl({ query, limit });

  // Wrap fetch in retry logic if enabled
  const fetchFn = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchWithAgent(url, {
        method: "GET",
        signal: controller.signal,
      });

      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      if (!response.ok) {
        const error = new Error(`Web search provider error (${response.status}): ${response.statusText}`);
        error.status = response.status;
        error.body = text;
        error.code = response.status === 429 ? "RATE_LIMITED" :
                     response.status >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR";
        throw error;
      }

      return json ?? { results: [], raw: text };
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error(`Web search timeout after ${timeoutMs}ms`);
        timeoutError.code = "ETIMEDOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  // Apply retry logic if enabled
  if (config.webSearch.retryEnabled) {
    return withRetry(fetchFn, {
      maxRetries: config.webSearch.maxRetries,
      initialDelay: 500,
      maxDelay: 5000,
    });
  }

  return fetchFn();
}

function summariseResult(item) {
  if (!item) return null;
  return {
    title: item.title ?? item.name ?? null,
    url: item.url ?? item.link ?? null,
    snippet: item.snippet ?? item.content ?? item.summary ?? item.excerpt ?? null,
    score: item.score ?? item.rank ?? null,
    source: item.source ?? null,
    metadata: item.metadata ?? null,
  };
}

function formatSearchResponse(payload, { query, limit }) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const payloadCount =
    typeof payload?.number_of_results === "number" && payload.number_of_results > 0
      ? payload.number_of_results
      : null;
  const effectiveCount = payloadCount ?? results.length;
  const numberOfResults = effectiveCount > 0 ? effectiveCount : undefined;
  const metadata = {
    ...(payload?.metadata ?? {}),
    raw_number_of_results: payloadCount,
    engines: payload?.engines ?? null,
    categories: payload?.categories ?? null,
  };
  if (numberOfResults !== undefined) {
    metadata.number_of_results = numberOfResults;
  }
  return {
    query,
    limit,
    number_of_results: numberOfResults,
    results: results.map(summariseResult).filter(Boolean),
    metadata,
  };
}

function buildAllowedFetchHosts() {
  return config.webSearch.allowAllHosts ? null : buildAllowedHosts();
}

function parseUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch (err) {
    err.code = "invalid_url";
    throw err;
  }
}

function ensureHostAllowed(url, allowedHosts) {
  if (allowedHosts === null) {
    return;
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    const error = new Error(`Host ${host} is not in the allowlist.`);
    error.code = "host_not_allowed";
    throw error;
  }
}

async function fetchDocument(url, timeoutMs) {
  // Wrap fetch in retry logic
  const fetchFn = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchWithAgent(url.toString(), { signal: controller.signal });
      const text = await response.text();

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        error.code = response.status === 429 ? "RATE_LIMITED" :
                     response.status >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR";
        throw error;
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
        contentType: response.headers.get("content-type") || "",
      };
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error(`Web fetch timeout after ${timeoutMs}ms`);
        timeoutError.code = "ETIMEDOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  // Apply retry logic if enabled
  if (config.webSearch.retryEnabled) {
    return withRetry(fetchFn, {
      maxRetries: config.webSearch.maxRetries,
      initialDelay: 500,
      maxDelay: 5000,
    });
  }

  return fetchFn();
}

function registerWebSearchTool() {
  registerTool(
    "web_search",
    async ({ args = {} }) => {
      const query = normaliseQuery(args);
      const limit = resolveLimit(args);
      const timeoutMs = config.webSearch.timeoutMs;

      try {
        const payload = await performSearch({ query, limit, timeoutMs });
        const formatted = formatSearchResponse(payload, { query, limit });
        const resultCount = formatted.results.length;
        logger.debug(
          {
            query,
            limit,
            result_count: resultCount,
            number_of_results: formatted.number_of_results,
            engines: payload?.engines ?? null,
            categories: payload?.categories ?? null,
            sample_result: formatted.results[0] ?? null,
          },
          "Web search results summarised",
        );
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(formatted, null, 2),
          metadata: {
            query,
            limit,
            result_count: resultCount,
            ...(formatted.number_of_results !== undefined
              ? { number_of_results: formatted.number_of_results }
              : {}),
          },
        };
      } catch (err) {
        logger.error({ err }, "Web search request failed");
        return {
          ok: false,
          status: err.status ?? 500,
          content: JSON.stringify(
            {
              error: err.code ?? "web_search_failed",
              message: err.message,
              status: err.status ?? 500,
            },
            null,
            2,
          ),
          metadata: {
            query,
            limit,
          },
        };
      }
    },
    { category: "web" },
  );
}

function registerWebFetchTool() {
  registerTool(
    "web_fetch",
    async ({ args = {} }) => {
      const rawUrl = args.url ?? args.uri ?? args.href;
      if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
        throw new Error("web_fetch requires a url string.");
      }
      const url = parseUrl(rawUrl.trim());
      const allowedHosts = buildAllowedFetchHosts();
      ensureHostAllowed(url, allowedHosts);

      const timeoutMs = config.webSearch.timeoutMs;
      try {
        const document = await fetchDocument(url, timeoutMs);

        // Extract text content from HTML if content type indicates HTML
        const isHtml = document.contentType.toLowerCase().includes("text/html");
        const rawBody = document.body;
        const bodyPreview = rawBody.slice(0, config.webSearch.bodyPreviewMax);

        // For HTML, provide both raw preview and extracted text
        const result = {
          url: url.toString(),
          status: document.status,
          content_type: document.contentType,
          headers: document.headers,
          body_preview: bodyPreview,
        };

        if (isHtml) {
          const extractedText = extractTextFromHtml(rawBody);
          result.text_content = extractedText.slice(0, config.webSearch.bodyPreviewMax);
          result.text_length = extractedText.length;
          logger.debug({
            url: url.toString(),
            originalLength: rawBody.length,
            extractedLength: extractedText.length,
          }, "Extracted text from HTML");
        }

        return {
          ok: document.status >= 200 && document.status < 400,
          status: document.status,
          content: JSON.stringify(result, null, 2),
          metadata: {
            url: url.toString(),
            status: document.status,
            content_type: document.contentType,
            is_html: isHtml,
          },
        };
      } catch (err) {
        logger.error({
          err,
          url: url.toString(),
          code: err.code,
          status: err.status
        }, "web_fetch failed");

        return {
          ok: false,
          status: err.status ?? 500,
          content: JSON.stringify(
            {
              error: err.code ?? "web_fetch_failed",
              message: err.message,
              url: url.toString(),
              ...(err.status ? { http_status: err.status } : {}),
            },
            null,
            2,
          ),
          metadata: {
            url: url.toString(),
            error_code: err.code,
            ...(err.status ? { http_status: err.status } : {}),
          },
        };
      }
    },
    { category: "web" },
  );
}

function registerWebTools() {
  registerWebSearchTool();
  registerWebFetchTool();
}

module.exports = {
  registerWebTools,
};
