/**
 * Tool calling with Lynkr + Vercel AI SDK
 *
 * Prerequisites:
 *   1. Lynkr running on localhost:8081
 *   2. npm install
 *
 * Usage:
 *   node tools.mjs
 */

import { generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

const lynkr = createOpenAICompatible({
  baseURL: process.env.LYNKR_BASE_URL || "http://localhost:8081/v1",
  name: "lynkr",
  apiKey: process.env.LYNKR_API_KEY || "sk-lynkr",
});

const { text, toolCalls } = await generateText({
  model: lynkr.chatModel("auto"),
  prompt: "What is the weather in San Francisco?",
  tools: {
    getWeather: tool({
      description: "Get the current weather for a location",
      parameters: z.object({
        city: z.string().describe("The city name"),
      }),
      execute: async ({ city }) => {
        // Simulated weather API
        return { city, temperature: 62, condition: "Foggy" };
      },
    }),
  },
});

console.log("Response:", text);
console.log("Tool calls:", JSON.stringify(toolCalls, null, 2));
