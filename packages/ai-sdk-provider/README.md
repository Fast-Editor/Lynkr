# @lynkr/ai-sdk-provider

[Vercel AI SDK](https://ai-sdk.dev) provider for [Lynkr](https://github.com/Fast-Editor/Lynkr), a self-hosted LLM gateway and tier-routing proxy.

Lynkr sits between your app and your model providers — Ollama, AWS Bedrock, OpenRouter, Databricks, Azure OpenAI, llama.cpp, LM Studio, and more — and routes each request to the right tier based on difficulty, cost, and your routing configuration. This package lets any AI SDK app use Lynkr as its provider.

## Setup

```bash
npm install @lynkr/ai-sdk-provider ai
```

You'll also need a running Lynkr instance:

```bash
npm install -g lynkr
lynkr init
lynkr start
```

## Provider Instance

```ts
import { createLynkr } from '@lynkr/ai-sdk-provider';

const lynkr = createLynkr({
  baseURL: 'http://localhost:8081/v1', // default — omit if running Lynkr locally
});
```

Or use the ready-made default instance, which points at `http://localhost:8081/v1`:

```ts
import { lynkr } from '@lynkr/ai-sdk-provider';
```

### Settings

| Option | Type | Description |
| --- | --- | --- |
| `baseURL` | `string` | Lynkr's OpenAI-compatible endpoint. Defaults to `http://localhost:8081/v1`. |
| `apiKey` | `string` | Optional. Sent as a `Bearer` token if your Lynkr deployment requires auth. |
| `headers` | `Record<string, string>` | Optional extra headers for every request. |
| `queryParams` | `Record<string, string>` | Optional extra URL query parameters. |
| `fetch` | `FetchFunction` | Optional custom fetch implementation (middleware, testing). |

## Language Models

Lynkr routes requests to an upstream provider based on its own configuration, so the model id acts as a routing hint rather than a fixed upstream model. Pass `'auto'` to let Lynkr's tier router pick, or a concrete model id to request a specific tier:

```ts
const model = lynkr('auto');
```

### `generateText`

```ts
import { lynkr } from '@lynkr/ai-sdk-provider';
import { generateText } from 'ai';

const { text } = await generateText({
  model: lynkr('auto'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

### `streamText`

```ts
import { lynkr } from '@lynkr/ai-sdk-provider';
import { streamText } from 'ai';

const result = streamText({
  model: lynkr('auto'),
  prompt: 'Explain tier routing in two paragraphs.',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

## Additional Resources

- [Lynkr on GitHub](https://github.com/Fast-Editor/Lynkr)
- [Lynkr on npm](https://www.npmjs.com/package/lynkr)
- [Vercel AI SDK docs](https://ai-sdk.dev/docs)

## License

Apache-2.0
