/**
 * Preference-Aligned Domain Router
 *
 * Routes requests to preferred providers based on detected task domain.
 * Runs after tier selection — overrides provider choice while keeping the same tier.
 *
 * Config:
 *   ROUTING_PREFERENCES=security:anthropic|openai,code:openai|ollama
 *   ROUTING_DOMAINS=security:audit,vulnerability,CVE;frontend:css,react,tailwind
 */

const config = require('../config');
const logger = require('../logger');
const { DOMAIN_KEYWORDS, extractContent } = require('./complexity-analyzer');
const { getModelTierSelector } = require('./model-tiers');

class PreferenceRouter {
  constructor() {
    this._domainRegexCache = null;
    this._lastCustomDomains = null;
  }

  /**
   * Build combined domain regex map (built-in + custom keywords).
   * Caches result and rebuilds only when custom domains change.
   */
  _getDomainRegexes() {
    const customDomains = config.routing?.customDomains || {};
    // Rebuild cache if custom domains changed
    if (this._domainRegexCache && this._lastCustomDomains === JSON.stringify(customDomains)) {
      return this._domainRegexCache;
    }

    const regexes = {};

    // Start with built-in domain keywords
    for (const [domain, regex] of Object.entries(DOMAIN_KEYWORDS)) {
      regexes[domain] = [regex];
    }

    // Merge custom domain keywords
    for (const [domain, keywords] of Object.entries(customDomains)) {
      if (!Array.isArray(keywords) || keywords.length === 0) continue;
      // Build a regex from the keyword list: \b(word1|word2|word3)\b
      const pattern = new RegExp(
        `\\b(${keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
        'i'
      );
      if (!regexes[domain]) {
        regexes[domain] = [];
      }
      regexes[domain].push(pattern);
    }

    this._domainRegexCache = regexes;
    this._lastCustomDomains = JSON.stringify(customDomains);
    return regexes;
  }

  /**
   * Detect which domains match the user's message.
   * @param {string} text - User message content
   * @returns {string[]} Matched domain names, sorted by number of regex hits (descending)
   */
  detectDomains(text) {
    if (!text) return [];
    const regexes = this._getDomainRegexes();
    const hits = [];

    for (const [domain, patterns] of Object.entries(regexes)) {
      let matchCount = 0;
      for (const regex of patterns) {
        const matches = text.match(new RegExp(regex.source, 'gi'));
        if (matches) matchCount += matches.length;
      }
      if (matchCount > 0) {
        hits.push({ domain, matchCount });
      }
    }

    // Sort by match count descending — strongest domain signal first
    hits.sort((a, b) => b.matchCount - a.matchCount);
    return hits.map(h => h.domain);
  }

  /**
   * Resolve a provider for the given domains and tier.
   * Iterates matched domains in priority order, then ranked providers per domain.
   * Returns the first viable provider that has a valid tier config.
   *
   * @param {string[]} domains - Matched domains (priority order)
   * @param {string} tier - Current tier (SIMPLE, MEDIUM, COMPLEX, REASONING)
   * @returns {Object|null} { provider, model, domain, source } or null
   */
  resolveProvider(domains, tier) {
    const preferences = config.routing?.preferences || {};
    if (Object.keys(preferences).length === 0) return null;
    if (!domains || domains.length === 0) return null;

    const selector = getModelTierSelector();

    for (const domain of domains) {
      const rankedProviders = preferences[domain];
      if (!rankedProviders || rankedProviders.length === 0) continue;

      for (const preferredProvider of rankedProviders) {
        // Check if this provider has a valid TIER_* config for the current tier
        const tierConfig = config.modelTiers?.[tier];
        if (!tierConfig) continue;

        const parsed = selector._parseTierConfig(tierConfig);
        if (!parsed) continue;

        // If the tier's configured provider matches the preference, use it directly
        if (parsed.provider === preferredProvider) {
          logger.debug({
            domain,
            provider: preferredProvider,
            model: parsed.model,
            tier,
          }, '[PreferenceRouter] Domain preference matches tier config');
          return {
            provider: parsed.provider,
            model: parsed.model,
            domain,
            source: 'preference_match',
          };
        }

        // Otherwise, check if we can find a TIER_* that uses this provider
        // Look across all tier configs for one at the same level using this provider
        const tierKeys = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
        const currentTierIdx = tierKeys.indexOf(tier);

        // First try same tier, then adjacent tiers (prefer same or higher)
        const searchOrder = [tier];
        for (let i = currentTierIdx + 1; i < tierKeys.length; i++) searchOrder.push(tierKeys[i]);
        for (let i = currentTierIdx - 1; i >= 0; i--) searchOrder.push(tierKeys[i]);

        for (const searchTier of searchOrder) {
          const searchConfig = config.modelTiers?.[searchTier];
          if (!searchConfig) continue;
          const searchParsed = selector._parseTierConfig(searchConfig);
          if (searchParsed && searchParsed.provider === preferredProvider) {
            // Found a tier config that uses the preferred provider
            // Use its model but note we're cross-tier routing
            logger.debug({
              domain,
              provider: preferredProvider,
              model: searchParsed.model,
              originalTier: tier,
              resolvedTier: searchTier,
            }, '[PreferenceRouter] Domain preference resolved via cross-tier lookup');
            return {
              provider: searchParsed.provider,
              model: searchParsed.model,
              domain,
              source: searchTier === tier ? 'preference_match' : 'preference_cross_tier',
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Main entry point: detect domains from payload and resolve provider preference.
   * Supports explicit agent role hint via X-Agent-Role header (passed as options.agentRole).
   * When an agent role is provided, it takes priority over text-based domain detection.
   *
   * @param {Object} payload - Request payload with messages
   * @param {string} tier - Selected tier
   * @param {Object} [options] - Additional options
   * @param {string} [options.agentRole] - Explicit domain hint from X-Agent-Role header
   * @returns {Object|null} { provider, model, domain, source } or null
   */
  resolve(payload, tier, options = {}) {
    if (!tier) return null;
    const preferences = config.routing?.preferences || {};
    if (Object.keys(preferences).length === 0) return null;

    let domains;
    const agentRole = options.agentRole?.toLowerCase()?.trim();

    if (agentRole) {
      // Explicit agent role takes priority — use it as the top domain
      // Also detect from content and append as fallback domains
      const content = extractContent(payload);
      const detectedDomains = content ? this.detectDomains(content) : [];
      // Put agent role first, then any detected domains (deduplicated)
      domains = [agentRole, ...detectedDomains.filter(d => d !== agentRole)];
      logger.debug({ agentRole, detectedDomains, domains }, '[PreferenceRouter] Agent role hint applied');
    } else {
      const content = extractContent(payload);
      if (!content) return null;
      domains = this.detectDomains(content);
    }

    if (domains.length === 0) return null;

    const result = this.resolveProvider(domains, tier);
    if (result) {
      logger.info({
        domain: result.domain,
        provider: result.provider,
        model: result.model,
        allDomains: domains,
        tier,
        agentRole: agentRole || null,
      }, '[PreferenceRouter] Domain preference applied');
    }

    return result;
  }

  /**
   * Invalidate cached regexes (for hot reload)
   */
  reload() {
    this._domainRegexCache = null;
    this._lastCustomDomains = null;
    logger.info('[PreferenceRouter] Cache invalidated');
  }
}

// Singleton
let instance = null;

function getPreferenceRouter() {
  if (!instance) {
    instance = new PreferenceRouter();
  }
  return instance;
}

module.exports = {
  PreferenceRouter,
  getPreferenceRouter,
};
