const logger = require("../logger");
const { countTokens } = require("../routing/tokenizer");

// GCF (Graph Compact Format) context compression. Drop-in alternative to the
// TOON adapter (src/context/toon.js): same encode-only, fail-open,
// read-only-context contract; only the encoder differs. Round-trips losslessly.
//
// @blackwell-systems/gcf ships a CommonJS build, so the encoder is resolved with
// a synchronous require and cached.

let cachedEncode;
let cachedDecode;
let cachedLoadError;
let warnedMissingDependency = false;

// A clear byte reduction reliably implies a token reduction, so blobs that shrink by
// at least this margin convert without paying to tokenize both strings. Blobs in the
// ambiguous zone (or larger) fall through to the exact token comparison.
const BYTE_FASTPATH_RATIO = 0.9;

function normaliseSettings(settings = {}) {
  const minBytesRaw =
    typeof settings.minBytes === "number" ? settings.minBytes : Number.parseInt(settings.minBytes ?? "4096", 10);
  return {
    enabled: settings.enabled === true,
    minBytes: Number.isFinite(minBytesRaw) && minBytesRaw > 0 ? minBytesRaw : 4096,
    failOpen: settings.failOpen !== false,
    logStats: settings.logStats !== false,
    verify: settings.verify !== false,
  };
}

// Order-insensitive for object keys, order-sensitive for arrays: the round-trip
// check treats two JSON values as equal when they carry the same data.
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function resolveEncodeFn(overrideEncode) {
  if (typeof overrideEncode === "function") return overrideEncode;
  if (cachedEncode !== undefined) return cachedEncode;
  try {
    const mod = require("@blackwell-systems/gcf");
    const fn = mod?.encodeGeneric ?? mod?.default?.encodeGeneric ?? null;
    cachedEncode = typeof fn === "function" ? fn : null;
    cachedLoadError = cachedEncode
      ? null
      : new Error("Missing encodeGeneric() export from @blackwell-systems/gcf");
  } catch (err) {
    cachedEncode = null;
    cachedLoadError = err;
  }
  return cachedEncode;
}

function resolveDecodeFn(overrideDecode) {
  if (typeof overrideDecode === "function") return overrideDecode;
  if (cachedDecode !== undefined) return cachedDecode;
  try {
    const mod = require("@blackwell-systems/gcf");
    const fn = mod?.decodeGeneric ?? mod?.default?.decodeGeneric ?? null;
    cachedDecode = typeof fn === "function" ? fn : null;
  } catch {
    cachedDecode = null;
  }
  return cachedDecode;
}

function looksLikeJsonObjectOrArray(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toGcfString(encodeFn, value) {
  const encoded = encodeFn(value);
  if (typeof encoded === "string") return encoded;
  if (encoded && typeof encoded[Symbol.iterator] === "function") {
    return Array.from(encoded).join("\n");
  }
  return "";
}

function compressStringContent(content, cfg, encodeFn, decodeFn, stats, model) {
  if (typeof content !== "string") return content;

  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes < cfg.minBytes) {
    stats.skippedBySize += 1;
    return content;
  }

  stats.candidateCount += 1;
  if (!looksLikeJsonObjectOrArray(content)) {
    stats.skippedByShape += 1;
    return content;
  }

  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    stats.skippedByParse += 1;
    return content;
  }

  const gcfText = toGcfString(encodeFn, parsed);
  if (typeof gcfText !== "string" || gcfText.trim().length === 0) {
    return content;
  }

  const gcfBytes = Buffer.byteLength(gcfText, "utf8");

  // Fast path: a clear byte reduction reliably means a token reduction too, so skip
  // the (per-blob, hot-path) token comparison.
  if (gcfBytes <= originalBytes * BYTE_FASTPATH_RATIO) {
    if (!verifiesLossless(parsed, gcfText, cfg, decodeFn, stats)) return content;
    stats.convertedCount += 1;
    stats.originalBytes += originalBytes;
    stats.compressedBytes += gcfBytes;
    return gcfText;
  }

  // Ambiguous zone (or larger in bytes): compare token counts with the target model's
  // encoding, and keep the original JSON if GCF does not reduce the token count.
  const originalTokens = countTokens(content, model);
  const gcfTokens = countTokens(gcfText, model);
  if (gcfTokens >= originalTokens) {
    stats.skippedByGrowth += 1;
    return content;
  }

  if (!verifiesLossless(parsed, gcfText, cfg, decodeFn, stats)) return content;
  stats.convertedCount += 1;
  stats.originalBytes += originalBytes;
  stats.compressedBytes += gcfBytes;
  stats.originalTokens += originalTokens;
  stats.compressedTokens += gcfTokens;
  return gcfText;
}

// Round-trip check on a payload we have otherwise decided to convert: decode the
// encoding and require that it reproduces the input exactly. GCF is lossless by
// design, so this is insurance rather than an expected path; it makes the
// compression provably lossless per payload. Returns true (safe to convert) when
// verification is off or the decoder is unavailable.
function verifiesLossless(parsed, gcfText, cfg, decodeFn, stats) {
  if (!cfg.verify || typeof decodeFn !== "function") return true;
  let decoded;
  try {
    decoded = decodeFn(gcfText);
  } catch {
    decoded = undefined;
  }
  if (deepEqual(parsed, decoded)) return true;
  stats.skippedByVerify += 1;
  return false;
}

function applyGcfCompression(payload, settings = {}, options = {}) {
  const cfg = normaliseSettings(settings);
  const stats = {
    enabled: cfg.enabled,
    available: true,
    convertedCount: 0,
    candidateCount: 0,
    skippedBySize: 0,
    skippedByShape: 0,
    skippedByParse: 0,
    skippedByGrowth: 0,
    skippedByVerify: 0,
    failureCount: 0,
    originalBytes: 0,
    compressedBytes: 0,
    originalTokens: 0,
    compressedTokens: 0,
  };

  if (!cfg.enabled) return { payload, stats };
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return { payload, stats };
  }

  // Token counts for the never-grow guard use the target model's encoding when known.
  const model = typeof payload.model === "string" ? payload.model : null;

  const encodeFn = resolveEncodeFn(options.encode);
  if (typeof encodeFn !== "function") {
    stats.available = false;
    const err = cachedLoadError ?? new Error("GCF encoder unavailable");
    if (!cfg.failOpen) throw err;
    if (!warnedMissingDependency) {
      logger.warn(
        { error: err.message },
        "GCF enabled but encoder dependency is unavailable; falling back to JSON",
      );
      warnedMissingDependency = true;
    }
    return { payload, stats };
  }

  const decodeFn = cfg.verify ? resolveDecodeFn(options.decode) : null;

  for (const message of payload.messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "tool") continue; // Never mutate machine-executed protocol payloads
    try {
      if (typeof message.content === "string") {
        message.content = compressStringContent(message.content, cfg, encodeFn, decodeFn, stats, model);
        continue;
      }

      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;

        // Keep protocol blocks untouched. Only compress user-language text fields.
        if (block.type === "text" && typeof block.text === "string") {
          block.text = compressStringContent(block.text, cfg, encodeFn, decodeFn, stats, model);
          continue;
        }

        if (block.type === "input_text" && typeof block.input_text === "string") {
          block.input_text = compressStringContent(block.input_text, cfg, encodeFn, decodeFn, stats, model);
        }
      }
    } catch (err) {
      stats.failureCount += 1;
      if (!cfg.failOpen) throw err;
    }
  }

  if (cfg.logStats && (stats.convertedCount > 0 || stats.skippedByVerify > 0)) {
    logger.info(
      {
        convertedCount: stats.convertedCount,
        candidateCount: stats.candidateCount,
        skippedByVerify: stats.skippedByVerify,
        originalBytes: stats.originalBytes,
        compressedBytes: stats.compressedBytes,
        originalTokens: stats.originalTokens,
        compressedTokens: stats.compressedTokens,
      },
      "GCF compression applied to message context",
    );
  }

  return { payload, stats };
}

module.exports = {
  applyGcfCompression,
};
