/**
 * Model Tier Selector
 * Maps complexity scores to appropriate models per provider
 * Uses config/model-tiers.json for tier preferences
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const config = require('../config');

// Load tier config
const TIER_CONFIG_PATH = path.join(__dirname, '../../config/model-tiers.json');

// Tier definitions with complexity ranges
const TIER_DEFINITIONS = {
  SIMPLE: {
    description: 'Greetings, simple Q&A, confirmations',
    range: [0, 25],
    priority: 1,
  },
  MEDIUM: {
    description: 'Code reading, simple edits, research',
    range: [26, 50],
    priority: 2,
  },
  COMPLEX: {
    description: 'Multi-file changes, debugging, architecture',
    range: [51, 75],
    priority: 3,
  },
  REASONING: {
    description: 'Complex analysis, security audits, novel problems',
    range: [76, 100],
    priority: 4,
  },
};

class ModelTierSelector {
  constructor() {
    this.tierConfig = null;
    this.localProviders = {};
    this.providerAliases = {};
    this._loadConfig();
  }

  /**
   * Load tier configuration from JSON file
   */
  _loadConfig() {
    try {
      if (fs.existsSync(TIER_CONFIG_PATH)) {
        const data = JSON.parse(fs.readFileSync(TIER_CONFIG_PATH, 'utf8'));
        this.tierConfig = data.tiers || {};
        this.localProviders = data.localProviders || {};
        this.providerAliases = data.providerAliases || {};
        logger.debug({ tiers: Object.keys(this.tierConfig) }, '[ModelTiers] Config loaded');
      } else {
        logger.warn('[ModelTiers] Config file not found, using defaults');
        this._loadDefaults();
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[ModelTiers] Config load failed, using defaults');
      this._loadDefaults();
    }
  }

  /**
   * Load default tier config
   */
  _loadDefaults() {
    this.tierConfig = {
      SIMPLE: { preferred: { ollama: ['llama3.2'], openai: ['gpt-4o-mini'] } },
      MEDIUM: { preferred: { openai: ['gpt-4o'], anthropic: ['claude-sonnet-4-20250514'] } },
      COMPLEX: { preferred: { openai: ['o1-mini'], anthropic: ['claude-sonnet-4-20250514'] } },
      REASONING: { preferred: { openai: ['o1'], anthropic: ['claude-opus-4-20250514'] } },
    };
    this.localProviders = {
      ollama: { free: true, defaultTier: 'SIMPLE' },
      llamacpp: { free: true, defaultTier: 'SIMPLE' },
      lmstudio: { free: true, defaultTier: 'SIMPLE' },
    };
  }

  /**
   * Normalize provider name using aliases
   */
  _normalizeProvider(provider) {
    if (!provider) return 'openai';
    const lower = provider.toLowerCase();
    return this.providerAliases[lower] || lower;
  }

  /**
   * Get tier from complexity score
   * @param {number} complexityScore - Score from 0-100
   * @returns {string} Tier name (SIMPLE, MEDIUM, COMPLEX, REASONING)
   */
  getTier(complexityScore) {
    const score = Math.max(0, Math.min(100, complexityScore || 0));

    for (const [tier, def] of Object.entries(TIER_DEFINITIONS)) {
      if (score >= def.range[0] && score <= def.range[1]) {
        return tier;
      }
    }

    return score > 75 ? 'REASONING' : 'SIMPLE';
  }

  /**
   * Get tier definition
   */
  getTierDefinition(tier) {
    return TIER_DEFINITIONS[tier] || TIER_DEFINITIONS.MEDIUM;
  }

  /**
   * Get tier priority (1-4)
   */
  getTierPriority(tier) {
    return TIER_DEFINITIONS[tier]?.priority || 2;
  }

  /**
   * Compare two tiers, returns positive if tier1 > tier2
   */
  compareTiers(tier1, tier2) {
    return this.getTierPriority(tier1) - this.getTierPriority(tier2);
  }

  /**
   * Get preferred models for a tier and provider
   * @param {string} tier - Tier name
   * @param {string} provider - Provider name
   * @returns {string[]} Array of model names
   */
  getPreferredModels(tier, provider) {
    const normalizedProvider = this._normalizeProvider(provider);
    return this.tierConfig[tier]?.preferred?.[normalizedProvider] || [];
  }

  /**
   * Select model for tier from TIER_* env var (mandatory)
   * @param {string} tier - Tier name (SIMPLE, MEDIUM, COMPLEX, REASONING)
   * @param {string} _unused - Deprecated parameter
   * @returns {Object} { model, provider, source, tier }
   */
  selectModel(tier, _unused = null) {
    const tierConfig = config.modelTiers?.[tier];
    if (!tierConfig) {
      throw new Error(`TIER_${tier} not configured. Set TIER_${tier}=provider:model in .env`);
    }

    const parsed = this._parseTierConfig(tierConfig);
    if (!parsed) {
      throw new Error(`Invalid TIER_${tier} format. Expected provider:model, got: ${tierConfig}`);
    }

    return {
      model: parsed.model,
      provider: parsed.provider,
      source: 'env_tier',
      tier,
    };
  }

  /**
   * Parse tier config string (format: provider:model)
   * Examples: "ollama:llama3.2", "azure-openai:gpt-5.2-chat", "openai:gpt-4o"
   */
  _parseTierConfig(configStr) {
    if (!configStr || typeof configStr !== 'string') return null;

    const colonIndex = configStr.indexOf(':');
    if (colonIndex === -1) {
      // No colon - treat as model name, use default provider
      return {
        provider: config.modelProvider?.type || 'openai',
        model: configStr.trim(),
      };
    }

    const provider = configStr.substring(0, colonIndex).trim().toLowerCase();
    const model = configStr.substring(colonIndex + 1).trim();

    if (!provider || !model) return null;

    return { provider, model };
  }

  /**
   * Get the model configured for a provider from .env
   */
  _getProviderModel(provider) {
    switch (provider) {
      case 'azure-openai':
      case 'azureopenai':
        return config.azureOpenAI?.deployment || null;
      case 'openai':
        return config.openai?.model || null;
      case 'ollama':
        return config.ollama?.model || null;
      case 'openrouter':
        return config.openrouter?.model || null;
      case 'llamacpp':
        return config.llamacpp?.model || null;
      case 'lmstudio':
        return config.lmstudio?.model || null;
      case 'bedrock':
        return config.bedrock?.modelId || null;
      case 'zai':
        return config.zai?.model || null;
      case 'vertex':
        return config.vertex?.model || null;
      case 'databricks':
        return config.modelProvider?.defaultModel || null;
      default:
        return null;
    }
  }

  /**
   * Get provider for a specific tier (from env or fallback)
   */
  getProviderForTier(tier) {
    const tierConfig = config.modelTiers?.[tier];
    if (tierConfig) {
      const parsed = this._parseTierConfig(tierConfig);
      if (parsed) return parsed.provider;
    }
    return config.modelProvider?.type || 'openai';
  }

  /**
   * Get fallback model if provider can't handle requested tier
   */
  _getFallbackModel(requestedTier, provider) {
    const tierOrder = ['REASONING', 'COMPLEX', 'MEDIUM', 'SIMPLE'];
    const startIndex = tierOrder.indexOf(requestedTier);

    // Try lower tiers
    for (let i = startIndex + 1; i < tierOrder.length; i++) {
      const fallbackTier = tierOrder[i];
      const models = this.getPreferredModels(fallbackTier, provider);

      if (models.length > 0) {
        logger.debug({
          from: requestedTier,
          to: fallbackTier,
          provider,
          model: models[0],
        }, '[ModelTiers] Downgrading tier');

        return { model: models[0], tier: fallbackTier };
      }
    }

    return null;
  }

  /**
   * Check if provider can handle a specific tier
   */
  canHandleTier(provider, tier) {
    const normalizedProvider = this._normalizeProvider(provider);
    const models = this.getPreferredModels(tier, normalizedProvider);
    return models.length > 0;
  }

  /**
   * Check if provider is local/free
   */
  isLocalProvider(provider) {
    const normalizedProvider = this._normalizeProvider(provider);
    return this.localProviders[normalizedProvider]?.free === true;
  }

  /**
   * Get all providers that can handle a tier
   */
  getProvidersForTier(tier) {
    const tierConfig = this.tierConfig[tier];
    if (!tierConfig?.preferred) return [];
    return Object.keys(tierConfig.preferred);
  }

  /**
   * Get all tiers a provider can handle
   */
  getTiersForProvider(provider) {
    const normalizedProvider = this._normalizeProvider(provider);
    const tiers = [];

    for (const tier of Object.keys(TIER_DEFINITIONS)) {
      if (this.canHandleTier(normalizedProvider, tier)) {
        tiers.push(tier);
      }
    }

    return tiers;
  }

  /**
   * Get tier stats for metrics endpoint
   */
  getTierStats() {
    const stats = {
      tiers: {},
      providers: {},
    };

    for (const [tier, def] of Object.entries(TIER_DEFINITIONS)) {
      const providers = this.getProvidersForTier(tier);
      stats.tiers[tier] = {
        ...def,
        providerCount: providers.length,
        providers: providers,
      };
    }

    // Count models per provider
    const allProviders = new Set();
    for (const tierConfig of Object.values(this.tierConfig)) {
      if (tierConfig.preferred) {
        Object.keys(tierConfig.preferred).forEach(p => allProviders.add(p));
      }
    }

    for (const provider of allProviders) {
      stats.providers[provider] = {
        tiers: this.getTiersForProvider(provider),
        isLocal: this.isLocalProvider(provider),
      };
    }

    return stats;
  }

  /**
   * Reload configuration (for hot reload)
   */
  reload() {
    this._loadConfig();
    logger.info('[ModelTiers] Configuration reloaded');
  }
}

// Singleton instance
let instance = null;

function getModelTierSelector() {
  if (!instance) {
    instance = new ModelTierSelector();
  }
  return instance;
}

module.exports = {
  ModelTierSelector,
  getModelTierSelector,
  TIER_DEFINITIONS,
};
