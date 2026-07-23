import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
  type OpenAICompatibleProviderSettings,
} from '@ai-sdk/openai-compatible';

export type LynkrProvider = OpenAICompatibleProvider;

export interface LynkrProviderSettings
  extends Omit<OpenAICompatibleProviderSettings, 'name' | 'baseURL'> {
  /**
   * URL of the Lynkr server's OpenAI-compatible endpoint.
   * Defaults to `http://localhost:8081/v1`, where a locally
   * running Lynkr instance listens out of the box.
   */
  baseURL?: string;
}

/**
 * Create a Lynkr provider for the Vercel AI SDK.
 *
 * Lynkr routes each request to an upstream provider (Ollama, AWS Bedrock,
 * OpenRouter, Databricks, Azure OpenAI, llama.cpp, LM Studio, ...) based on
 * its own routing configuration, so the model id you pass selects a routing
 * hint rather than a fixed upstream model.
 */
export function createLynkr(
  options: LynkrProviderSettings = {},
): LynkrProvider {
  const { baseURL = 'http://localhost:8081/v1', ...settings } = options;
  return createOpenAICompatible({
    ...settings,
    name: 'lynkr',
    baseURL,
  });
}

/**
 * Default Lynkr provider instance, pointed at `http://localhost:8081/v1`.
 */
export const lynkr = createLynkr();
