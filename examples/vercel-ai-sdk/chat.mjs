/**
 * Basic chat completion with Lynkr + Vercel AI SDK
 *
 * Prerequisites:
 *   1. Lynkr running on localhost:8081
 *   2. npm install
 *
 * Usage:
 *   node chat.mjs
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const lynkr = createOpenAICompatible({
  baseURL: process.env.LYNKR_BASE_URL || "http://localhost:8081/v1",
  name: "lynkr",
  apiKey: process.env.LYNKR_API_KEY || "sk-lynkr",
});

const { text, usage } = await generateText({
  model: lynkr.chatModel("auto"),
  prompt: "Explain what a proxy server is in one paragraph.",
});

console.log("Response:", text);
console.log("Tokens:", usage);
