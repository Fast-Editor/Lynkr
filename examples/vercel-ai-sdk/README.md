# Lynkr + Vercel AI SDK Example

Use [Lynkr](https://github.com/vishalveerareddy123/Lynkr) as the backend for any Vercel AI SDK app.

## Setup

```bash
# 1. Start Lynkr
cd /path/to/Lynkr
npm start

# 2. Install example dependencies
cd examples/vercel-ai-sdk
npm install

# 3. Run examples
npm run chat     # Basic text generation
npm run stream   # Streaming response
npm run tools    # Tool calling
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `LYNKR_BASE_URL` | `http://localhost:8081/v1` | Lynkr endpoint |
| `LYNKR_API_KEY` | `sk-lynkr` | Any non-empty string |

## How It Works

The `@ai-sdk/openai-compatible` package connects to Lynkr's OpenAI-compatible `/v1/chat/completions` endpoint. Lynkr then routes requests to whichever provider you have configured (Ollama, Bedrock, OpenRouter, etc.).

```
Vercel AI SDK  -->  Lynkr (:8081)  -->  Ollama / Bedrock / OpenRouter / ...
```

## Using in Next.js

```ts
// app/api/chat/route.ts
import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const lynkr = createOpenAICompatible({
  baseURL: "http://localhost:8081/v1",
  name: "lynkr",
  apiKey: "sk-lynkr",
});

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: lynkr.chatModel("auto"),
    messages,
  });

  return result.toDataStreamResponse();
}
```
