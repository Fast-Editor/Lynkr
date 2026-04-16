/**
 * Streaming chat with Lynkr + Vercel AI SDK
 *
 * Prerequisites:
 *   1. Lynkr running on localhost:8081
 *   2. npm install
 *
 * Usage:
 *   node stream.mjs
 */

import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const lynkr = createOpenAICompatible({
  baseURL: process.env.LYNKR_BASE_URL || "http://localhost:8081/v1",
  name: "lynkr",
  apiKey: process.env.LYNKR_API_KEY || "sk-lynkr",
});

const result = streamText({
  model: lynkr.chatModel("auto"),
  messages: [
    { role: "system", content: "You are a helpful coding assistant." },
    { role: "user", content: "Write a fizzbuzz function in Python." },
  ],
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

console.log("\n\nDone.");
