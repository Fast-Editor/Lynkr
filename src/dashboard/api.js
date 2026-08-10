const config = require('../config');
const telemetry = require('../routing/telemetry');
const { getUsage } = require('../usage/aggregator');
const metrics = require('../metrics');
const { getMetricsCollector } = require('../observability/metrics');
const { TIER_DEFINITIONS } = require('../routing/model-tiers');

// Per-provider type + whether its credentials/endpoint are actually present.
function providerMeta() {
  const c = config;
  return {
    databricks:        { type: 'cloud', configured: !!(c.databricks?.url && c.databricks?.apiKey) },
    'azure-anthropic': { type: 'cloud', configured: !!(c.azureAnthropic?.endpoint && c.azureAnthropic?.apiKey) },
    bedrock:           { type: 'cloud', configured: !!c.bedrock?.apiKey },
    openrouter:        { type: 'cloud', configured: !!c.openrouter?.apiKey },
    edenai:            { type: 'cloud', configured: !!c.edenai?.apiKey },
    openai:            { type: 'cloud', configured: !!c.openai?.apiKey },
    'azure-openai':    { type: 'cloud', configured: !!(c.azureOpenAI?.endpoint && c.azureOpenAI?.apiKey) },
    vertex:            { type: 'cloud', configured: !!c.vertex?.projectId },
    moonshot:          { type: 'cloud', configured: !!c.moonshot?.apiKey },
    ollama:            { type: 'local', configured: !!c.ollama?.endpoint },
    llamacpp:          { type: 'local', configured: !!c.llamacpp?.endpoint },
    lmstudio:          { type: 'local', configured: !!c.lmstudio?.endpoint },
  };
}

// Providers the active routing config actually points at: the provider prefix
// of each TIER_* value (format `provider:model[:variant]`) plus the base
// MODEL_PROVIDER. Returns Map<providerName, tierLabels[]>.
function getReferencedProviders() {
  const refs = new Map();
  const note = (provider, label) => {
    const key = String(provider || '').trim().toLowerCase();
    if (!key) return;
    if (!refs.has(key)) refs.set(key, []);
    if (label && !refs.get(key).includes(label)) refs.get(key).push(label);
  };

  const tiers = config.modelTiers || {};
  for (const [tier, val] of Object.entries(tiers)) {
    if (typeof val === 'string' && val.trim()) {
      note(val.split(':')[0], tier);
    }
  }
  note(config.modelProvider?.type, 'default');

  return refs;
}

// Providers used by the routing config that have credentials/endpoints set.
// Unknown providers (no metadata) are included optimistically since we can't
// verify their credentials.
function getConfiguredProviders() {
  const meta = providerMeta();
  const out = [];
  for (const [name, tiers] of getReferencedProviders()) {
    const m = meta[name];
    if (!m || m.configured) {
      out.push({ name, type: m?.type || 'cloud', tiers });
    }
  }
  return out;
}

// Tiers pointing at a known provider whose credentials/endpoint are missing —
// surfaced as a warning so a misconfigured tier is visible.
function getProviderWarnings() {
  const meta = providerMeta();
  const out = [];
  for (const [name, tiers] of getReferencedProviders()) {
    const m = meta[name];
    if (m && !m.configured) {
      out.push({ name, type: m.type, tiers });
    }
  }
  return out;
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
    providers:        getConfiguredProviders(),
    providerWarnings: getProviderWarnings(),
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

    // Cache-aware routing (Phase 6): per-decision switch/hold economics,
    // aggregated into "cache dollars saved by routing".
    const cacheEconomics = telemetry.getCacheEconomics({ since });
    // Lens money-framing: the MEASURED companion — cache reads actually
    // served this window, auditable against the bill (vs the projected
    // figures above). null until cache counters have accrued.
    const cacheMeasured = telemetry.getMeasuredCacheSavings({ since });

    res.json({ tierDefinitions: TIER_DEFINITIONS, accuracy, stats, providerStats, circuitBreakers: cbStates, cacheEconomics, cacheMeasured, window: win.label });
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

/* ── Lens endpoints (feature/lens-dashboard) ─────────────────────────── */

// Recommendations — analyzer findings ranked by past overspend.
function recommendations(req, res) {
  try {
    const engine = require('./recommendations');
    const windowMs = req.query.window === '30d' ? 30 * 86400000
      : req.query.window === '24h' ? 86400000
      : 7 * 86400000;
    res.json(engine.run({ windowMs, force: req.query.force === 'true' }));
  } catch (e) {
    res.status(500).json({ error: 'recommendations_api_error', detail: e.message });
  }
}

// Session drill-down: per-model mix + context-growth series + raw rows.
function sessionDetail(req, res) {
  try {
    const detail = telemetry.getSessionDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'session_not_found' });
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: 'session_api_error', detail: e.message });
  }
}

// Pivot explorer: metric × dimension (× stack), whitelisted server-side.
function analytics(req, res) {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days || '7', 10) || 7));
    const data = telemetry.getAnalytics({
      metric: req.query.metric,
      by: req.query.by,
      stack: req.query.stack || null,
      since: Date.now() - days * 86400000,
    });
    if (!data) return res.status(503).json({ error: 'telemetry_unavailable' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'analytics_api_error', detail: e.message });
  }
}

// Statusline: one cheap snapshot for the zero-token status line — last
// routed request, today's spend, measured cache re-read share.
function statusline(req, res) {
  try {
    const last = telemetry.query({ limit: 1 })[0] ?? null;
    const since = Date.now() - 86400000;
    const db = telemetry.getDb();
    let today = null;
    if (db) {
      today = db.prepare(
        `SELECT SUM(COALESCE(cost_usd,0)) spend,
                SUM(COALESCE(cache_read_tokens,0)) rd,
                SUM(COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0)+COALESCE(input_tokens,0)) total
         FROM routing_telemetry WHERE timestamp > ?`
      ).get(since);
    }
    res.json({
      last: last && {
        tier: last.tier, provider: last.provider, model: last.model,
        pinned: !!last.pinned, at: last.timestamp,
      },
      todaySpendUsd: today?.spend ?? null,
      cacheReadPct: today && today.total > 0 ? Math.round((today.rd / today.total) * 100) : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'statusline_api_error', detail: e.message });
  }
}

module.exports = { overview, usage, routing, logs, recommendations, sessionDetail, analytics, statusline };
