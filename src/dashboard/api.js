const config = require('../config');
const telemetry = require('../routing/telemetry');
const { getUsage } = require('../usage/aggregator');
const metrics = require('../metrics');
const { getMetricsCollector } = require('../observability/metrics');
const { TIER_DEFINITIONS } = require('../routing/model-tiers');

function getConfiguredProviders() {
  const c = config;
  const providers = [];
  const add = (name, type, ok) => ok && providers.push({ name, type });

  add('databricks',     'cloud', c.databricks?.url && c.databricks?.apiKey);
  add('azure-anthropic','cloud', c.azureAnthropic?.endpoint && c.azureAnthropic?.apiKey);
  add('bedrock',        'cloud', c.bedrock?.apiKey);
  add('openrouter',     'cloud', c.openrouter?.apiKey);
  add('openai',         'cloud', c.openai?.apiKey);
  add('azure-openai',   'cloud', c.azureOpenAI?.endpoint && c.azureOpenAI?.apiKey);
  add('vertex',         'cloud', c.vertex?.projectId);
  add('moonshot',       'cloud', c.moonshot?.apiKey);
  add('ollama',         'local', c.ollama?.endpoint);
  add('llamacpp',       'local', c.llamacpp?.endpoint);
  add('lmstudio',       'local', c.lmstudio?.endpoint);

  return providers;
}

// Noise provider names injected by unit tests — filter them out of UI
const TEST_PROVIDER_RE = /^(accuracy-|stats-|provider-stats-|roundtrip-|latency-)/;

// Find the widest window that has at least one row, so the UI never shows
// empty panels just because there were no requests in the last 24 hours.
function findActiveWindow() {
  const newest = telemetry.query({ limit: 1 });
  if (!newest.length) return { since: Date.now() - 86400000, label: '24h' };

  const ageMs = Date.now() - newest[0].timestamp;
  if (ageMs <= 86400000)    return { since: Date.now() - 86400000,        label: '24h'      };
  if (ageMs <= 7*86400000)  return { since: Date.now() - 7*86400000,      label: '7d'       };
  if (ageMs <= 30*86400000) return { since: Date.now() - 30*86400000,     label: '30d'      };
  return                           { since: 0,                             label: 'all time' };
}

function getCircuitBreakerStates() {
  try {
    const { getCircuitBreakerRegistry } = require('../clients/circuit-breaker');
    const reg = getCircuitBreakerRegistry();
    return reg.getAll();
  } catch {
    return {};
  }
}

// Group telemetry rows by calendar day (UTC), returning last `days` buckets
function dailyBreakdown(rows, days = 7) {
  const now = Date.now();
  const DAY = 86400000;
  const result = [];

  for (let i = days - 1; i >= 0; i--) {
    const start = now - (i + 1) * DAY;
    const end   = now - i * DAY;
    const bucket = rows.filter(r => r.timestamp >= start && r.timestamp < end);

    const byTier = {};
    let cost = 0;
    for (const r of bucket) {
      const t = r.tier || 'UNKNOWN';
      byTier[t] = (byTier[t] || 0) + 1;
      cost += Number(r.cost_usd) || 0;
    }

    result.push({
      label: new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      total: bucket.length,
      byTier,
      cost: Math.round(cost * 10000) / 10000,
    });
  }
  return result;
}

function overview(req, res) {
  const win         = findActiveWindow();
  const todayUsage  = getUsage({ window: win.label === '24h' ? '1d' : win.label === 'all time' ? 'all' : win.label });
  const recentRows  = telemetry.query({ limit: 10 });
  const todayStats  = telemetry.getStats({ since: win.since });
  const snap        = metrics.snapshot();

  res.json({
    uptime:        Math.floor(process.uptime()),
    port:          config.port,
    version:       process.env.npm_package_version || '9.0.2',
    modelProvider: config.modelProvider?.type || 'unknown',
    providers:     getConfiguredProviders(),
    statsWindow:   win.label,
    metrics: {
      requestsTotal:    snap.requestsTotal,
      responsesSuccess: snap.responses?.success || 0,
      responsesError:   snap.responses?.error   || 0,
    },
    today: {
      requests:      todayUsage.totals?.requests      || 0,
      totalTokens:   todayUsage.totals?.totalTokens   || 0,
      cost:          todayUsage.totals?.actualCost     || 0,
      saved:         todayUsage.totals?.saved          || 0,
      savedPercent:  todayUsage.totals?.savedPercent   || 0,
    },
    stats:          todayStats,
    recentRequests: recentRows,
  });
}

function usage(req, res) {
  try {
    const window   = req.query.window   || '7d';
    const provider = req.query.provider || undefined;
    const model    = req.query.model    || undefined;

    const data = getUsage({ window, provider, model });

    const days = window === '1d' ? 1 : window === '30d' ? 30 : 7;
    const since = window === 'all' ? 0 : Date.now() - days * 86400000;
    const rawRows = since > 0
      ? telemetry.query({ since, limit: 50000 })
      : telemetry.query({ limit: 50000 });

    data.daily = dailyBreakdown(rawRows, Math.min(days, 30));

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'usage_api_error', detail: e.message });
  }
}

function routing(req, res) {
  try {
    const win      = findActiveWindow();
    const { since } = win;

    const accuracy  = telemetry.getRoutingAccuracy({ since });
    const stats     = telemetry.getStats({ since });
    const cbStates  = getCircuitBreakerStates();

    const dbRows = telemetry.query({ limit: 100000, since });
    const dbProviders = [...new Set(
      dbRows.map(r => r.provider).filter(p => p && !TEST_PROVIDER_RE.test(p))
    )];

    const providerStats = {};
    for (const p of dbProviders) {
      const s = telemetry.getProviderStats(p, { since });
      if (s) providerStats[p] = s;
    }

    res.json({ tierDefinitions: TIER_DEFINITIONS, accuracy, stats, providerStats, circuitBreakers: cbStates, window: win.label });
  } catch (e) {
    res.status(500).json({ error: 'routing_api_error', detail: e.message });
  }
}

function logs(req, res) {
  try {
    const limit   = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const filters = { limit };

    if (req.query.provider) filters.provider = req.query.provider;
    if (req.query.tier)     filters.tier     = req.query.tier;
    if (req.query.since)    filters.since    = parseInt(req.query.since, 10);

    let rows = telemetry.query(filters);
    if (req.query.error === 'true') rows = rows.filter(r => r.error_type);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'logs_api_error', detail: e.message });
  }
}

module.exports = { overview, usage, routing, logs };
