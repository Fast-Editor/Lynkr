/**
 * OTel GenAI metrics export (ROUTING-NOTES §1 gap audit).
 *
 * Zero-dependency OTLP/HTTP push + gen_ai.* semconv naming on the
 * Prometheus surface. Tests: payload shape, live POST to a fake collector,
 * disabled-by-default behavior, and the Prometheus aliases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { buildOtlpPayload, getOtelExporter } = require('../src/observability/otel');
const { getMetricsCollector } = require('../src/observability/metrics');

const SAMPLE_METRICS = {
  tokens_input_total: 1000,
  tokens_output_total: 250,
  cost_usd_total: 1.25,
  requests_total: 40,
  requests_errors_total: 2,
  latency_ms: { median: 120, p95: 800, p99: 2000 },
};

test('OTLP payload follows the ExportMetricsServiceRequest shape with gen_ai semconv names', () => {
  const payload = buildOtlpPayload(SAMPLE_METRICS, { startTimeMs: 1000, nowMs: 61_000 });
  const scope = payload.resourceMetrics[0].scopeMetrics[0];
  const names = scope.metrics.map((m) => m.name);
  assert.ok(names.includes('gen_ai.client.token.usage'));
  assert.ok(names.includes('gen_ai.client.operation.duration'));

  const tokenUsage = scope.metrics.find((m) => m.name === 'gen_ai.client.token.usage');
  assert.equal(tokenUsage.sum.isMonotonic, true);
  assert.equal(tokenUsage.sum.aggregationTemporality, 2, 'CUMULATIVE');
  const byType = Object.fromEntries(
    tokenUsage.sum.dataPoints.map((p) => [p.attributes[0].value.stringValue, p.asDouble])
  );
  assert.equal(byType.input, 1000);
  assert.equal(byType.output, 250);

  const resourceAttrs = Object.fromEntries(
    payload.resourceMetrics[0].resource.attributes.map((a) => [a.key, a.value.stringValue])
  );
  assert.equal(resourceAttrs['service.name'], 'lynkr');
});

test('exporter POSTs to <endpoint>/v1/metrics and reports success', async (t) => {
  let received = null;
  const collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = { url: req.url, body: JSON.parse(body) };
      res.statusCode = 200;
      res.end('{}');
    });
  });
  await new Promise((r) => collector.listen(0, '127.0.0.1', r));
  t.after(() => collector.close());

  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${collector.address().port}`;
  t.after(() => delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

  const ok = await getOtelExporter().exportOnce();
  assert.equal(ok, true);
  assert.equal(received.url, '/v1/metrics');
  assert.ok(received.body.resourceMetrics, 'OTLP body delivered');
});

test('export is a no-op when no endpoint is configured', async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.LYNKR_OTEL_ENDPOINT;
  const ok = await getOtelExporter().exportOnce();
  assert.equal(ok, false);
  assert.equal(getOtelExporter().getStatus().enabled, false);
});

test('Prometheus surface carries the gen_ai_* semconv aliases', () => {
  const text = getMetricsCollector().toPrometheus();
  assert.match(text, /gen_ai_client_token_usage_total\{gen_ai_token_type="input"\}/);
  assert.match(text, /gen_ai_client_token_usage_total\{gen_ai_token_type="output"\}/);
  assert.match(text, /gen_ai_client_operation_duration_ms\{quantile="0.95"\}/);
});
