#!/usr/bin/env node
/**
 * Lynkr Wrap - Launch CLI tools through Lynkr proxy
 *
 * Usage:
 *   lynkr wrap claude              # launch Claude Code with defaults
 *   lynkr wrap claude --port 9000  # custom port
 *   lynkr wrap claude -- --help    # pass args to claude
 *
 * This wraps the official Claude Code binary and routes traffic through Lynkr,
 * giving Pro/Max subscription users access to tier routing, compression, and
 * caching without separate API billing.
 *
 * @module bin/wrap
 */

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Parse arguments
const args = process.argv.slice(2);
const target = args[0]; // 'claude', 'codex', etc.

if (!target) {
  console.error('Usage: lynkr wrap <target> [options]');
  console.error('');
  console.error('Targets:');
  console.error('  claude    Wrap Claude Code CLI');
  console.error('');
  console.error('Options:');
  console.error('  --port N  Use port N for Lynkr proxy (default: 8081)');
  console.error('');
  console.error('Examples:');
  console.error('  lynkr wrap claude');
  console.error('  lynkr wrap claude --port 9000');
  console.error('  lynkr wrap claude -- --help');
  process.exit(1);
}

if (target === 'claude') {
  wrapClaude();
} else {
  console.error(`Error: 'lynkr wrap ${target}' is not supported yet.`);
  console.error('');
  console.error('Supported targets: claude');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// Claude Code wrapper
// ──────────────────────────────────────────────────────────────────────────────

async function wrapClaude() {
  console.log('╭─ Lynkr Wrap ─────────────────────────────────────────');
  console.log('│  Starting Claude Code through Lynkr proxy...');
  console.log('╰──────────────────────────────────────────────────────');
  console.log('');

  // 1. Check for Claude Code binary
  const claudePath = findClaudeBinary();
  if (!claudePath) {
    console.error('✗ Claude Code CLI not found in PATH');
    console.error('');
    console.error('Install it first:');
    console.error('  • macOS:  brew install --cask claude-code');
    console.error('  • Or download from: https://claude.ai/code');
    console.error('');
    console.error('Then verify: claude --version');
    process.exit(2);
  }

  console.log(`✓ Found Claude Code at: ${claudePath}`);

  // 2. Parse wrap-specific options
  const wrapOpts = parseWrapOptions(args.slice(1));
  const port = wrapOpts.port;
  const claudeArgs = wrapOpts.passthrough;

  // 3. Start Lynkr server
  console.log(`✓ Starting Lynkr on port ${port}...`);

  let server;
  try {
    const { start } = require('../src/server');

    // Override port if specified
    if (port !== 8081) {
      process.env.PORT = String(port);
    }

    server = await start();

    // Wait for server to be ready
    await waitForReady(port, 30000);
    console.log(`✓ Lynkr ready on http://localhost:${port}`);
  } catch (err) {
    console.error('✗ Failed to start Lynkr:', err.message);
    console.error('');
    if (err.code === 'EADDRINUSE') {
      console.error('Port already in use. Try:');
      console.error(`  lynkr wrap claude --port ${port + 1}`);
      console.error('');
      console.error('Or stop existing Lynkr:');
      console.error('  lynkr stop');
    } else {
      console.error('Check your .env configuration:');
      console.error('  DATABRICKS_API_KEY, OLLAMA_ENDPOINT, etc.');
      console.error('');
      console.error('Debug logs: tail -f data/logs/lynkr.log');
    }
    process.exit(1);
  }

  console.log('');
  console.log('╭─ Claude Code ────────────────────────────────────────');
  console.log('│  Launching with Lynkr routing enabled...');
  console.log('│  • Tier routing: active');
  console.log('│  • Compression: active');
  console.log('│  • Caching: active');
  console.log('╰──────────────────────────────────────────────────────');
  console.log('');

  // 4. Launch Claude Code with Lynkr as base URL
  const child = spawn(claudePath, claudeArgs, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${port}`,
    },
    stdio: 'inherit',
  });

  // Track start time for stats
  const startTime = Date.now();

  // 5. Handle signals - forward to child
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  signals.forEach((signal) => {
    process.on(signal, () => forwardSignal(signal));
  });

  // 6. Wait for child to exit
  child.on('exit', async (code, signal) => {
    const duration = Date.now() - startTime;

    console.log('');
    console.log('╭─ Claude Code Exited ─────────────────────────────────');

    if (signal) {
      console.log(`│  Signal: ${signal}`);
    } else {
      console.log(`│  Exit code: ${code}`);
    }

    console.log(`│  Duration: ${formatDuration(duration)}`);
    console.log('╰──────────────────────────────────────────────────────');

    // Show stats if enabled and clean exit
    if (process.env.LYNKR_WRAP_SHOW_STATS !== 'false' && code === 0) {
      try {
        await showSessionStats();
      } catch (err) {
        // Stats are nice-to-have, don't fail on error
      }
    }

    // Shutdown Lynkr
    console.log('');
    console.log('Shutting down Lynkr...');

    try {
      const { getShutdownManager } = require('../src/server/shutdown');
      const shutdownMgr = getShutdownManager();
      await shutdownMgr.gracefulShutdown();
    } catch (err) {
      // Force exit if graceful shutdown fails
      console.error('Warning: Graceful shutdown failed:', err.message);
    }

    process.exit(code || 0);
  });

  // Handle child spawn errors
  child.on('error', (err) => {
    console.error('✗ Failed to launch Claude Code:', err.message);
    process.exit(1);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper functions
// ──────────────────────────────────────────────────────────────────────────────

function findClaudeBinary() {
  try {
    // Try 'which claude'
    const result = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const claudePath = result.trim();
    if (claudePath && existsSync(claudePath)) {
      return claudePath;
    }
  } catch {
    // Fall through to common paths
  }

  // Try common installation paths
  const commonPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
  ];

  for (const p of commonPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

function parseWrapOptions(args) {
  let port = 8081;
  const passthrough = [];
  let foundSeparator = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      foundSeparator = true;
      continue;
    }

    if (foundSeparator) {
      // Everything after -- goes to Claude Code
      passthrough.push(arg);
    } else if (arg === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++; // skip next arg
    } else {
      // Unknown lynkr flag or starts passthrough
      passthrough.push(arg);
    }
  }

  return { port, passthrough };
}

async function waitForReady(port, timeoutMs) {
  const startTime = Date.now();
  const http = require('http');

  while (Date.now() - startTime < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/health/ready`, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Health check returned ${res.statusCode}`));
          }
          res.resume(); // consume response
        });
        req.on('error', reject);
        req.setTimeout(1000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      return; // Success
    } catch {
      // Not ready yet, wait and retry
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  throw new Error(`Lynkr did not become ready within ${timeoutMs}ms`);
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

async function showSessionStats() {
  try {
    const { getMetricsCollector } = require('../src/observability/metrics');
    const metrics = getMetricsCollector().getMetrics();

    if (!metrics || metrics.totalRequests === 0) {
      return; // No requests, skip stats
    }

    console.log('');
    console.log('╭─ Lynkr Session Stats ────────────────────────────────');
    console.log(`│  Requests      ${metrics.totalRequests}`);

    if (metrics.tokensSaved > 0) {
      const originalTokens = metrics.tokensUsed + metrics.tokensSaved;
      const savingsPercent = Math.round((metrics.tokensSaved / originalTokens) * 100);
      console.log(`│  Tokens        Original: ${originalTokens.toLocaleString()}  →  Routed: ${metrics.tokensUsed.toLocaleString()}  (${savingsPercent}% saved)`);
    }

    if (metrics.tierBreakdown) {
      const tiers = Object.entries(metrics.tierBreakdown)
        .map(([tier, count]) => `${tier}: ${count}`)
        .join('  ');
      console.log(`│  Tier Mix      ${tiers}`);
    }

    if (metrics.cacheHits > 0) {
      console.log(`│  Cache Hits    ${metrics.cacheHits}`);
    }

    console.log('╰──────────────────────────────────────────────────────');
  } catch (err) {
    // Stats are nice-to-have, silently ignore errors
  }
}
