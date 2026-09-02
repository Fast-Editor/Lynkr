/**
 * OpenTelemetry GenAI metrics export (ROUTING-NOTES §1 gap audit).
 *
 * Lynkr already tracks every number the OTel GenAI semantic conventions
 * care about — this module gives them semconv-aligned names and an export
 * path, WITHOUT adding the @opentelemetry/* dependency tree: OTLP/HTTP is
 * just JSON over POST, and the payload below follows the OTLP 1.x
 * ExportMetricsServiceRequest shape that any collector accepts.
 *
 * Enabled when OTEL_EXPORTER_OTLP_ENDPOINT (the standard env var) or
 * LYNKR_OTEL_ENDPOINT is set. Pushes every LYNKR_OTEL_EXPORT_INTERVAL_MS
 * (default 60s) to `<endpoint>/v1/metrics`. Optional headers via the
 * standard OTEL_EXPORTER_OTLP_HEADERS ("key=value,key2=value2").
 *
 * Emitted metrics (GenAI semconv where one exists, lynkr.* where not):
 *   gen_ai.client.token.usage      sum, attr gen_ai.token.type=input|output
 *   gen_ai.client.operation.duration  gauge (p50/p95/p99, unit ms)
 *   lynkr.cost.usd                 sum
 *   lynkr.requests                 sum (+ lynkr.request.errors)
 *
 * @module observability/otel
 */

const logger = require('../logger');
const { getMetricsCollector } = require('./metrics');

const EXPORT_INTERVAL_MS = Number.parseInt(process.env.LYNKR_OTEL_EXPORT_INTERVAL_MS, 10) || 60_000;

function _endpoint() {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.LYNKR_OTEL_ENDPOINT || null;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function _headers() {
  const headers = { 'Content-Type': 'application/json' };
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (raw) {
    for (const pair of raw.split(',')) {
      const idx = pair.indexOf('=');
      if (idx > 0) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return headers;
}

function _sumPoint(value, attributes, startNanos, nowNanos) {
  return {
    attributes,
    startTimeUnixNano: startNanos,
    timeUnixNano: nowNanos,
    asDouble: value,
  };
}

/**
 * Build an OTLP/HTTP ExportMetricsServiceRequest from the collector's
 * current snapshot. Exposed for tests.
 */
function buildOtlpPayload(metrics, { startTimeMs, nowMs }) {
  const startNanos = String(startTimeMs * 1e6);
  const nowNanos = String(nowMs * 1e6);
  const attr = (key, value) => ({ key, value: { stringValue: value } });

  const sums = (name, unit, points) => ({
    name,
    unit,
    sum: {
      aggregationTemporality: 2, // CUMULATIVE
      isMonotonic: true,
      dataPoints: points,
    },
  });

  const gauge = (name, unit, points) => ({ name, unit, gauge: { dataPoints: points } });

  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          attr('service.name', 'lynkr'),
          attr('service.version', process.env.npm_package_version || 'unknown'),
        ],
      },
      scopeMetrics: [{
        scope: { name: 'lynkr.observability', version: '1' },
        metrics: [
          sums('gen_ai.client.token.usage', '{token}', [
            _sumPoint(metrics.tokens_input_total, [attr('gen_ai.token.type', 'input')], startNanos, nowNanos),
            _sumPoint(metrics.tokens_output_total, [attr('gen_ai.token.type', 'output')], startNanos, nowNanos),
          ]),
          gauge('gen_ai.client.operation.duration', 'ms', [
            { attributes: [attr('quantile', '0.5')], timeUnixNano: nowNanos, asDouble: metrics.latency_ms.median },
            { attributes: [attr('quantile', '0.95')], timeUnixNano: nowNanos, asDouble: metrics.latency_ms.p95 },
            { attributes: [attr('quantile', '0.99')], timeUnixNano: nowNanos, asDouble: metrics.latency_ms.p99 },
          ]),
          sums('lynkr.cost.usd', 'usd', [
            _sumPoint(metrics.cost_usd_total, [], startNanos, nowNanos),
          ]),
          sums('lynkr.requests', '{request}', [
            _sumPoint(metrics.requests_total, [], startNanos, nowNanos),
          ]),
          sums('lynkr.request.errors', '{request}', [
            _sumPoint(metrics.requests_errors_total, [], startNanos, nowNanos),
          ]),
        ],
      }],
    }],
  };
}

class OtelExporter {
  constructor() {
    this.timer = null;
    this.startTimeMs = Date.now();
    this.stats = { exports: 0, failures: 0, lastExportAt: null };
    this._warnedOnce = false;
  }

  start() {
    const endpoint = _endpoint();
    if (!endpoint || this.timer) return;
    this.timer = setInterval(() => {
      this.exportOnce().catch(() => {});
    }, EXPORT_INTERVAL_MS);
    this.timer.unref?.();
    logger.info({ endpoint, intervalMs: EXPORT_INTERVAL_MS }, '[Otel] GenAI metrics export started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async exportOnce() {
    const endpoint = _endpoint();
    if (!endpoint) return false;
    const metrics = getMetricsCollector().getMetrics();
    const payload = buildOtlpPayload(metrics, { startTimeMs: this.startTimeMs, nowMs: Date.now() });
    try {
      const response = await fetch(`${endpoint}/v1/metrics`, {
        method: 'POST',
        headers: _headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`OTLP export → ${response.status}`);
      await response.arrayBuffer().catch(() => {});
      this.stats.exports += 1;
      this.stats.lastExportAt = Date.now();
      this._warnedOnce = false;
      return true;
    } catch (err) {
      this.stats.failures += 1;
      // Warn once per failure streak, then stay quiet — a down collector
      // must not spam logs at every interval.
      if (!this._warnedOnce) {
        this._warnedOnce = true;
        logger.warn({ endpoint, error: err.message }, '[Otel] metrics export failing (will keep retrying quietly)');
      }
      return false;
    }
  }

  getStatus() {
    return { enabled: !!_endpoint(), running: !!this.timer, intervalMs: EXPORT_INTERVAL_MS, ...this.stats };
  }
}

let exporter = null;

/** @returns {OtelExporter} singleton */
function getOtelExporter() {
  if (!exporter) exporter = new OtelExporter();
  return exporter;
}

module.exports = { getOtelExporter, buildOtlpPayload };
