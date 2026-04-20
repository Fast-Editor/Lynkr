/**
 * Universal Tool Call Extractor
 *
 * Extracts tool calls embedded as raw text (XML, JSON, custom tokens)
 * from LLM output.  Covers Minimax, Hermes/Qwen, Qwen3-Coder, GLM,
 * Llama, Mistral, DeepSeek, GPT-OSS, and generic formats.
 *
 * @module clients/xml-tool-extractor
 */

const logger = require("../logger");

let callCounter = 0;
function nextId() {
  return `call_extracted_${Date.now()}_${callCounter++}`;
}

function tryParseJSON(str) {
  try { return JSON.parse(str.trim()); } catch { return null; }
}

// ── Individual extractors ────────────────────────────────────────────

/** 1. Minimax: <invoke name="X"><parameter name="K">V</parameter></invoke> */
function extractMinimax(text) {
  const calls = [];
  const re = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const body = m[2];
    const args = {};
    let pm;
    while ((pm = paramRe.exec(body)) !== null) {
      let val = pm[2].trim();
      const parsed = tryParseJSON(val);
      args[pm[1]] = parsed !== null ? parsed : val;
    }
    paramRe.lastIndex = 0;
    calls.push({ name, arguments: args, _match: m[0] });
  }
  // Also strip wrapper tags
  let cleaned = text;
  if (calls.length > 0) {
    for (const c of calls) cleaned = cleaned.replace(c._match, "");
    cleaned = cleaned.replace(/<\/?minimax:tool_call>/g, "");
  }
  return { calls, cleaned };
}

/** 2. GLM: <tool_call>func_name <arg_key>k</arg_key> <arg_value>v</arg_value></tool_call> */
function extractGLM(text) {
  const calls = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    // Check if it's GLM style (has <arg_key> tags)
    if (!body.includes("<arg_key>")) continue;
    const nameMatch = body.match(/^(\S+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const args = {};
    const kvRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
    let kv;
    while ((kv = kvRe.exec(body)) !== null) {
      let val = kv[2].trim();
      const parsed = tryParseJSON(val);
      args[kv[1].trim()] = parsed !== null ? parsed : val;
    }
    calls.push({ name, arguments: args, _match: m[0] });
  }
  let cleaned = text;
  for (const c of calls) cleaned = cleaned.replace(c._match, "");
  return { calls, cleaned };
}

/** 3. Hermes/Qwen JSON: <tool_call>{"name":"X","arguments":{...}}</tool_call> */
function extractHermesQwen(text) {
  const calls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    // Skip GLM format (handled above)
    if (body.includes("<arg_key>")) continue;
    // Skip Qwen3-Coder XML format
    if (body.includes("<tool_name>")) continue;
    const json = tryParseJSON(body);
    if (json && (json.name || json.function)) {
      const name = json.name || json.function?.name || json.function || "unknown";
      const args = json.arguments || json.parameters || json.params || {};
      calls.push({ name, arguments: typeof args === "string" ? tryParseJSON(args) || {} : args, _match: m[0] });
    }
  }
  let cleaned = text;
  for (const c of calls) cleaned = cleaned.replace(c._match, "");
  return { calls, cleaned };
}

/** 4. Qwen3-Coder: <tool_call><tool_name>X</tool_name><parameter name="K">V</parameter></tool_call> */
function extractQwenCoder(text) {
  const calls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (!body.includes("<tool_name>")) continue;
    const nameMatch = body.match(/<tool_name>([\s\S]*?)<\/tool_name>/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const args = {};
    const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = paramRe.exec(body)) !== null) {
      let val = pm[2].trim();
      const parsed = tryParseJSON(val);
      args[pm[1]] = parsed !== null ? parsed : val;
    }
    calls.push({ name, arguments: args, _match: m[0] });
  }
  let cleaned = text;
  for (const c of calls) cleaned = cleaned.replace(c._match, "");
  return { calls, cleaned };
}

/** 5. DeepSeek: <｜tool▁call▁begin｜>function<｜tool▁sep｜>name\n```json\n{...}\n```\n<｜tool▁call▁end｜> */
function extractDeepSeek(text) {
  const calls = [];
  // Match both Unicode and ASCII approximations
  const re = /(?:<｜tool▁call▁begin｜>|<\|tool_call_begin\|>|<\|tool_call_start\|>)\s*(?:function)?\s*(?:<｜tool▁sep｜>|<\|tool_sep\|>)?\s*(\S+)\s*```(?:json)?\s*([\s\S]*?)```\s*(?:<｜tool▁call▁end｜>|<\|tool_call_end\|>)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    const json = tryParseJSON(m[2]);
    if (name) {
      calls.push({ name, arguments: json || {}, _match: m[0] });
    }
  }
  let cleaned = text;
  for (const c of calls) cleaned = cleaned.replace(c._match, "");
  return { calls, cleaned };
}

/** 6. Mistral: [TOOL_CALLS] [{"name":"X","arguments":{...}}] */
function extractMistral(text) {
  const calls = [];
  const re = /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const arr = tryParseJSON(m[1]);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item.name || item.function) {
          const name = item.name || item.function?.name || "unknown";
          const args = item.arguments || item.parameters || {};
          calls.push({ name, arguments: typeof args === "string" ? tryParseJSON(args) || {} : args, _match: m[0] });
        }
      }
    }
  }
  let cleaned = text;
  for (const c of calls) cleaned = cleaned.replace(c._match, "");
  return { calls, cleaned };
}

/** 7. Llama python_tag: <|python_tag|>{"name":"X","arguments":{...}} */
function extractLlamaPythonTag(text) {
  const calls = [];
  const re = /<\|python_tag\|>\s*(\{[\s\S]*?\})(?:<\|eom_id\|>|<\|eot_id\|>|\s*$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const json = tryParseJSON(m[1]);
    if (json && (json.name || json.function)) {
      const name = json.name || json.function || "unknown";
      const args = json.arguments || json.parameters || {};
      calls.push({ name, arguments: typeof args === "string" ? tryParseJSON(args) || {} : args, _match: m[0] });
    }
  }
  let cleaned = text;
  for (const c of calls) cleaned = cleaned.replace(c._match, "");
  return { calls, cleaned };
}

/** 8. GPT-OSS Harmony: <|call|>name(key=value, ...) */
function extractGptOss(text) {
  const calls = [];
  const re = /<\|call\|>\s*(\w+)\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const argsStr = m[2].trim();
    const args = {};
    if (argsStr) {
      // Parse key=value pairs
      const kvRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      let kv;
      while ((kv = kvRe.exec(argsStr)) !== null) {
        args[kv[1]] = kv[2] ?? kv[3] ?? kv[4];
      }
    }
    calls.push({ name, arguments: args, _match: m[0] });
  }
  let cleaned = text;
  for (const c of calls) cleaned = cleaned.replace(c._match, "");
  return { calls, cleaned };
}

/** 9. Generic <function_call>{...}</function_call> */
function extractGenericFunctionCall(text) {
  const calls = [];
  const re = /<function_call>\s*([\s\S]*?)\s*<\/function_call>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const json = tryParseJSON(m[1]);
    if (json && (json.name || json.function)) {
      const name = json.name || json.function?.name || json.function || "unknown";
      const args = json.arguments || json.parameters || {};
      calls.push({ name, arguments: typeof args === "string" ? tryParseJSON(args) || {} : args, _match: m[0] });
    }
  }
  let cleaned = text;
  for (const c of calls) cleaned = cleaned.replace(c._match, "");
  return { calls, cleaned };
}

/** 10. Raw JSON fallback: text starts with {"name":"...","arguments":{...}} */
function extractRawJSON(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return { calls: [], cleaned: text };
  const json = tryParseJSON(trimmed);
  if (!json || typeof json !== "object") return { calls: [], cleaned: text };
  if (!json.name && !json.function) return { calls: [], cleaned: text };
  const name = json.name || json.function?.name || json.function || "unknown";
  const args = json.arguments || json.parameters || {};
  return {
    calls: [{ name, arguments: typeof args === "string" ? tryParseJSON(args) || {} : args, _match: trimmed }],
    cleaned: "",
  };
}

// ── Main entry point ─────────────────────────────────────────────────

const EXTRACTORS = [
  { name: "minimax", fn: extractMinimax },
  { name: "glm", fn: extractGLM },
  { name: "hermes_qwen", fn: extractHermesQwen },
  { name: "qwen_coder", fn: extractQwenCoder },
  { name: "deepseek", fn: extractDeepSeek },
  { name: "mistral", fn: extractMistral },
  { name: "llama_python", fn: extractLlamaPythonTag },
  { name: "gpt_oss", fn: extractGptOss },
  { name: "generic_function_call", fn: extractGenericFunctionCall },
  { name: "raw_json", fn: extractRawJSON },
];

/**
 * Extract tool calls from model text output.
 * Tries all known patterns (most specific → most generic).
 * Returns on first extractor that finds tool calls.
 *
 * @param {string} text - Raw model text content
 * @returns {{ toolCalls: Array, cleanedText: string|null }}
 */
function extractToolCallsFromText(text) {
  if (!text || typeof text !== "string") {
    return { toolCalls: [], cleanedText: text };
  }

  for (const { name: extractorName, fn } of EXTRACTORS) {
    try {
      const { calls, cleaned } = fn(text);
      if (calls.length > 0) {
        const toolCalls = calls.map((c) => ({
          id: nextId(),
          type: "function",
          function: {
            name: c.name,
            arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
          },
        }));

        // Clean up stray tokens
        let cleanedText = (cleaned || "")
          .replace(/<\|eom_id\|>/g, "")
          .replace(/<\|eot_id\|>/g, "")
          .replace(/<\|end\|>/g, "")
          .trim() || null;

        logger.info({
          extractor: extractorName,
          toolCount: toolCalls.length,
          tools: toolCalls.map((t) => t.function.name),
        }, "Extracted tool calls from model text output");

        return { toolCalls, cleanedText };
      }
    } catch (err) {
      logger.debug({ extractor: extractorName, error: err.message }, "Tool call extractor failed, trying next");
    }
  }

  return { toolCalls: [], cleanedText: text };
}

module.exports = { extractToolCallsFromText };
