/**
 * Model Registry
 * Multi-source pricing: LiteLLM -> models.dev -> Databricks fallback
 * Caches data locally with 24h TTL
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

// API URLs
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELS_DEV_URL = 'https://models.dev/api.json';

// Cache settings
const CACHE_FILE = path.join(__dirname, '../../data/model-prices-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Databricks fallback pricing (based on Anthropic direct API prices)
const DATABRICKS_FALLBACK = {
  // Claude models
  'databricks-claude-opus-4-6': { input: 5.0, output: 25.0, context: 1000000 },
  'databricks-claude-opus-4-5': { input: 5.0, output: 25.0, context: 200000 },
  'databricks-claude-opus-4-1': { input: 15.0, output: 75.0, context: 200000 },
  'databricks-claude-sonnet-4-5': { input: 3.0, output: 15.0, context: 200000 },
  'databricks-claude-sonnet-4': { input: 3.0, output: 15.0, context: 200000 },
  'databricks-claude-3-7-sonnet': { input: 3.0, output: 15.0, context: 200000 },
  'databricks-claude-haiku-4-5': { input: 1.0, output: 5.0, context: 200000 },

  // Llama models
  'databricks-llama-4-maverick': { input: 1.0, output: 1.0, context: 128000 },
  'databricks-meta-llama-3-3-70b-instruct': { input: 0.9, output: 0.9, context: 128000 },
  'databricks-meta-llama-3-1-405b-instruct': { input: 2.0, output: 2.0, context: 128000 },
  'databricks-meta-llama-3-1-8b-instruct': { input: 0.2, output: 0.2, context: 128000 },

  // GPT models via Databricks
  'databricks-gpt-5-2': { input: 5.0, output: 15.0, context: 200000 },
  'databricks-gpt-5-1': { input: 3.0, output: 12.0, context: 200000 },
  'databricks-gpt-5': { input: 2.5, output: 10.0, context: 128000 },
  'databricks-gpt-5-mini': { input: 0.5, output: 1.5, context: 128000 },
  'databricks-gpt-5-nano': { input: 0.15, output: 0.6, context: 128000 },

  // Gemini models via Databricks
  'databricks-gemini-3-flash': { input: 0.075, output: 0.3, context: 1000000 },
  'databricks-gemini-3-pro': { input: 1.25, output: 5.0, context: 2000000 },
  'databricks-gemini-2-5-pro': { input: 1.25, output: 5.0, context: 1000000 },
  'databricks-gemini-2-5-flash': { input: 0.075, output: 0.3, context: 1000000 },

  // DBRX
  'databricks-dbrx-instruct': { input: 0.75, output: 2.25, context: 32000 },

  // Embedding models (price per 1M tokens)
  'databricks-gte-large-en': { input: 0.02, output: 0, context: 8192 },
  'databricks-bge-large-en': { input: 0.02, output: 0, context: 512 },
};

// Default cost for unknown models
const DEFAULT_COST = { input: 1.0, output: 3.0, context: 128000 };

class ModelRegistry {
  constructor() {
    this.litellmPrices = {};
    this.modelsDevPrices = {};
    this.loaded = false;
    this.lastFetch = 0;
    this.modelIndex = new Map();
  }

  /**
   * Initialize registry - load from cache or fetch fresh data
   */
  async initialize() {
    if (this.loaded) return;

    // Try cache first
    if (this._loadFromCache()) {
      this.loaded = true;
      // Background refresh if stale
      if (Date.now() - this.lastFetch > CACHE_TTL_MS) {
        this._fetchAll().catch(err =>
          logger.warn({ err: err.message }, '[ModelRegistry] Background refresh failed')
        );
      }
      return;
    }

    // Fetch fresh data
    await this._fetchAll();
    this.loaded = true;
  }

  /**
   * Fetch from both sources
   */
  async _fetchAll() {
    const results = await Promise.allSettled([
      this._fetchLiteLLM(),
      this._fetchModelsDev(),
    ]);

    const litellmOk = results[0].status === 'fulfilled';
    const modelsDevOk = results[1].status === 'fulfilled';

    if (litellmOk || modelsDevOk) {
      this._buildIndex();
      this._saveToCache();
      this.lastFetch = Date.now();

      logger.info({
        litellm: litellmOk ? Object.keys(this.litellmPrices).length : 0,
        modelsDev: modelsDevOk ? Object.keys(this.modelsDevPrices).length : 0,
        total: this.modelIndex.size,
      }, '[ModelRegistry] Loaded pricing data');
    } else {
      logger.warn('[ModelRegistry] All sources failed, using Databricks fallback only');
    }
  }

  /**
   * Fetch LiteLLM pricing
   */
  async _fetchLiteLLM() {
    try {
      const response = await fetch(LITELLM_URL, {
        signal: AbortSignal.timeout(15000),
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      this.litellmPrices = this._processLiteLLM(data);

      logger.debug({ count: Object.keys(this.litellmPrices).length }, '[ModelRegistry] LiteLLM loaded');
    } catch (err) {
      logger.warn({ err: err.message }, '[ModelRegistry] LiteLLM fetch failed');
      throw err;
    }
  }

  /**
   * Process LiteLLM format into our format
   * LiteLLM uses cost per token, we use cost per 1M tokens
   */
  _processLiteLLM(data) {
    const prices = {};

    for (const [modelId, info] of Object.entries(data)) {
      if (!info || typeof info !== 'object') continue;

      // Convert per-token to per-million-tokens
      const inputCost = (info.input_cost_per_token || 0) * 1_000_000;
      const outputCost = (info.output_cost_per_token || 0) * 1_000_000;

      prices[modelId.toLowerCase()] = {
        input: inputCost,
        output: outputCost,
        context: info.max_input_tokens || info.max_tokens || 128000,
        maxOutput: info.max_output_tokens || 4096,
        toolCall: info.supports_function_calling ?? true,
        vision: info.supports_vision ?? false,
        source: 'litellm',
      };

      // Also index without provider prefix for flexible lookup
      const shortName = modelId.split('/').pop().toLowerCase();
      if (shortName !== modelId.toLowerCase()) {
        prices[shortName] = prices[modelId.toLowerCase()];
      }
    }

    return prices;
  }

  /**
   * Fetch models.dev pricing
   */
  async _fetchModelsDev() {
    try {
      const response = await fetch(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(15000),
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      this.modelsDevPrices = this._processModelsDev(data);

      logger.debug({ count: Object.keys(this.modelsDevPrices).length }, '[ModelRegistry] models.dev loaded');
    } catch (err) {
      logger.warn({ err: err.message }, '[ModelRegistry] models.dev fetch failed');
      throw err;
    }
  }

  /**
   * Process models.dev format into our format
   */
  _processModelsDev(data) {
    const prices = {};

    for (const [providerId, providerData] of Object.entries(data)) {
      if (!providerData?.models) continue;

      for (const [modelId, info] of Object.entries(providerData.models)) {
        const fullId = `${providerId}/${modelId}`.toLowerCase();

        prices[fullId] = {
          input: info.cost?.input || 0,
          output: info.cost?.output || 0,
          cacheRead: info.cost?.cache_read,
          cacheWrite: info.cost?.cache_write,
          context: info.context || 128000,
          maxOutput: info.output || 4096,
          toolCall: info.tool_call ?? false,
          reasoning: info.reasoning ?? false,
          vision: Array.isArray(info.input) && info.input.includes('image'),
          source: 'models.dev',
        };

        // Also index by short name
        prices[modelId.toLowerCase()] = prices[fullId];
      }
    }

    return prices;
  }

  /**
   * Build unified index from all sources
   */
  _buildIndex() {
    this.modelIndex.clear();

    // Add Databricks fallback first (lowest priority)
    for (const [modelId, info] of Object.entries(DATABRICKS_FALLBACK)) {
      this.modelIndex.set(modelId.toLowerCase(), { ...info, source: 'databricks-fallback' });
    }

    // Add models.dev (medium priority)
    for (const [modelId, info] of Object.entries(this.modelsDevPrices)) {
      this.modelIndex.set(modelId, info);
    }

    // Add LiteLLM (highest priority)
    for (const [modelId, info] of Object.entries(this.litellmPrices)) {
      this.modelIndex.set(modelId, info);
    }
  }

  /**
   * Get cost for a model
   * @param {string} modelName - Model name/ID
   * @returns {Object} Cost info { input, output, context, ... }
   */
  getCost(modelName) {
    if (!modelName) return { ...DEFAULT_COST, source: 'default' };

    const normalizedName = modelName.toLowerCase();

    // Direct lookup
    if (this.modelIndex.has(normalizedName)) {
      return this.modelIndex.get(normalizedName);
    }

    // Try common variations
    const variations = [
      normalizedName,
      normalizedName.replace('databricks-', ''),
      normalizedName.replace('azure/', ''),
      normalizedName.replace('bedrock/', ''),
      normalizedName.replace('anthropic.', ''),
      normalizedName.split('/').pop(),
    ];

    for (const variant of variations) {
      if (this.modelIndex.has(variant)) {
        return this.modelIndex.get(variant);
      }
    }

    // Fuzzy match for partial names
    for (const [key, value] of this.modelIndex.entries()) {
      if (key.includes(normalizedName) || normalizedName.includes(key)) {
        return value;
      }
    }

    logger.debug({ model: modelName }, '[ModelRegistry] Model not found, using default');
    return { ...DEFAULT_COST, source: 'default' };
  }

  /**
   * Get model info by name
   */
  getModel(modelName) {
    return this.getCost(modelName);
  }

  /**
   * Check if model is free (local)
   */
  isFree(modelName) {
    const cost = this.getCost(modelName);
    return cost.input === 0 && cost.output === 0;
  }

  /**
   * Check if model supports tool calling
   */
  supportsTools(modelName) {
    const model = this.getCost(modelName);
    return model.toolCall === true;
  }

  /**
   * Find models matching criteria
   */
  findModels(criteria = {}) {
    const results = [];

    for (const [modelId, info] of this.modelIndex.entries()) {
      if (criteria.maxInputCost && info.input > criteria.maxInputCost) continue;
      if (criteria.minContext && info.context < criteria.minContext) continue;
      if (criteria.toolCall && !info.toolCall) continue;
      if (criteria.reasoning && !info.reasoning) continue;
      if (criteria.vision && !info.vision) continue;

      results.push({ modelId, ...info });
    }

    // Sort by input cost ascending
    return results.sort((a, b) => a.input - b.input);
  }

  /**
   * Get stats for metrics endpoint
   */
  getStats() {
    const sources = { litellm: 0, 'models.dev': 0, 'databricks-fallback': 0, default: 0 };

    for (const info of this.modelIndex.values()) {
      const source = info.source || 'default';
      sources[source] = (sources[source] || 0) + 1;
    }

    return {
      totalModels: this.modelIndex.size,
      bySource: sources,
      lastFetch: this.lastFetch,
      cacheAge: this.lastFetch ? Date.now() - this.lastFetch : null,
      cacheTTL: CACHE_TTL_MS,
    };
  }

  /**
   * Force refresh from APIs
   */
  async refresh() {
    await this._fetchAll();
  }

  // Cache management
  _loadFromCache() {
    try {
      if (!fs.existsSync(CACHE_FILE)) return false;

      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      this.litellmPrices = cache.litellm || {};
      this.modelsDevPrices = cache.modelsDev || {};
      this.lastFetch = cache.timestamp || 0;

      this._buildIndex();

      logger.debug({
        age: Math.round((Date.now() - this.lastFetch) / 60000) + 'min',
        models: this.modelIndex.size,
      }, '[ModelRegistry] Loaded from cache');

      return true;
    } catch (err) {
      logger.debug({ err: err.message }, '[ModelRegistry] Cache load failed');
      return false;
    }
  }

  _saveToCache() {
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const cache = {
        litellm: this.litellmPrices,
        modelsDev: this.modelsDevPrices,
        timestamp: Date.now(),
      };

      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      logger.debug('[ModelRegistry] Cache saved');
    } catch (err) {
      logger.warn({ err: err.message }, '[ModelRegistry] Cache save failed');
    }
  }
}

// Singleton with lazy initialization
let instance = null;

async function getModelRegistry() {
  if (!instance) {
    instance = new ModelRegistry();
    await instance.initialize();
  }
  return instance;
}

// Sync getter (uses cache only, no network)
function getModelRegistrySync() {
  if (!instance) {
    instance = new ModelRegistry();
    instance._loadFromCache();
    instance._buildIndex();
    instance.loaded = true;
  }
  return instance;
}

module.exports = {
  ModelRegistry,
  getModelRegistry,
  getModelRegistrySync,
  DATABRICKS_FALLBACK,
  DEFAULT_COST,
};
