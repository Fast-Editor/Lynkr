#!/usr/bin/env node
/**
 * Lynkr Wrap - Launch CLI tools through Lynkr proxy
 *
 * Usage:
 *   lynkr wrap claude              # launch Claude Code with defaults
 *   lynkr wrap copilot             # wrap GitHub Copilot CLI
 *   lynkr wrap aider               # wrap Aider AI assistant
 *   lynkr wrap cursor              # wrap Cursor editor
 *   lynkr wrap codex               # wrap OpenAI Codex CLI
 *   lynkr wrap claude --port 9000  # custom port
 *   lynkr wrap aider -- --help     # pass args to aider
 *
 * This wraps official AI coding tool binaries and routes traffic through Lynkr,
 * giving users access to tier routing, compression, and caching. For Claude Code,
 * Pro/Max subscription users can leverage their OAuth tokens without separate API billing.
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
  console.error('  copilot   Wrap GitHub Copilot CLI');
  console.error('  aider     Wrap Aider AI coding assistant');
  console.error('  cursor    Wrap Cursor editor');
  console.error('  codex     Wrap OpenAI Codex CLI');
  console.error('');
  console.error('Options:');
  console.error('  --port N  Use port N for Lynkr proxy (default: 8081)');
  console.error('');
  console.error('Examples:');
  console.error('  lynkr wrap claude');
  console.error('  lynkr wrap copilot --port 9000');
  console.error('  lynkr wrap aider -- --help');
  console.error('  lynkr wrap cursor');
  console.error('  lynkr wrap codex');
  process.exit(1);
}

if (target === 'claude') {
  wrapClaude();
} else if (target === 'copilot') {
  wrapCopilot();
} else if (target === 'aider') {
  wrapAider();
} else if (target === 'cursor') {
  wrapCursor();
} else if (target === 'codex') {
  wrapCodex();
} else {
  console.error(`Error: 'lynkr wrap ${target}' is not supported yet.`);
  console.error('');
  console.error('Supported targets: claude, copilot, aider, cursor, codex');
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

  // Silence Lynkr logs in wrap mode so they don't bleed into Claude Code's
  // TUI (the child inherits our stdio). Users who need Lynkr logs can set
  // LOG_LEVEL=info|debug explicitly, or tail data/logs/lynkr.log.
  if (!process.env.LOG_LEVEL || process.env.LOG_LEVEL === 'info' || process.env.LOG_LEVEL === 'error' || process.env.LOG_LEVEL === 'warn') {
    process.env.LOG_LEVEL = 'silent';
  }

  // Enable OAuth passthrough by default for wrap claude. Server reads this
  // env before /v1/messages handlers are wired up, so set it before start().
  if (process.env.LYNKR_OAUTH_PASSTHROUGH == null) {
    process.env.LYNKR_OAUTH_PASSTHROUGH = 'true';
  }

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
  if (claudeArgs.length > 0) {
    console.log(`│  • Args: ${claudeArgs.join(' ')}`);
  }
  console.log('╰──────────────────────────────────────────────────────');
  console.log('');

  // 4. Launch Claude Code with Lynkr as base URL
  // Force interactive mode if no args provided
  const finalArgs = claudeArgs.length === 0 && !process.stdin.isTTY
    ? [] // Let Claude detect TTY and start interactive
    : claudeArgs;

  // NOTE: We deliberately do NOT set ENABLE_TOOL_SEARCH=true here.
  //
  // When ENABLE_TOOL_SEARCH=true, Claude Code defers MCP/system tool schemas
  // behind a single `tool_search_tool` meta-tool that requires Anthropic's
  // server-side dispatch to resolve. That worked when we sent everything to
  // Anthropic, but it breaks tier routing: when "Can you read this repo" gets
  // routed to Ollama (or any non-Anthropic provider), the model only sees the
  // search meta-tool and has no way to discover Read/Write/Bash — it responds
  // "no file system tools available."
  //
  // Without this env var, Claude Code materializes the full real tool list in
  // every request. That's more tokens on the Anthropic side (passthrough
  // forwards them verbatim, Anthropic accepts them because the UA matches),
  // but Ollama/Moonshot/etc. now see the actual tools and can use them.
  //
  // The original 400 "Input tag does not match expected tags" error this
  // workaround was fighting is no longer reachable — subscription requests
  // now passthrough byte-for-byte, so Anthropic accepts whatever shape
  // Claude Code sends.
  const child = spawn(claudePath, finalArgs, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${port}`,
    },
    stdio: 'inherit',
    shell: false,
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
      if (server && typeof server.close === 'function') {
        await new Promise((resolve) => {
          server.close(() => {
            console.log('✓ Lynkr stopped');
            resolve();
          });
          // Force close after 2s
          setTimeout(() => {
            console.log('✓ Lynkr stopped (forced)');
            resolve();
          }, 2000);
        });
      }
    } catch (err) {
      // Ignore shutdown errors
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
// GitHub Copilot CLI wrapper
// ──────────────────────────────────────────────────────────────────────────────

async function wrapCopilot() {
  await wrapGeneric({
    name: 'GitHub Copilot CLI',
    binaryName: 'github-copilot-cli',
    findBinary: findCopilotBinary,
    envVar: 'OPENAI_API_BASE',
    installInstructions: [
      '  • npm install -g @githubnext/github-copilot-cli',
      '  • Or: https://www.npmjs.com/package/@githubnext/github-copilot-cli',
    ],
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Aider wrapper
// ──────────────────────────────────────────────────────────────────────────────

async function wrapAider() {
  await wrapGeneric({
    name: 'Aider',
    binaryName: 'aider',
    findBinary: findAiderBinary,
    envVar: 'OPENAI_API_BASE',
    installInstructions: [
      '  • pip install aider-chat',
      '  • Or: https://aider.chat/docs/install.html',
    ],
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Cursor wrapper
// ──────────────────────────────────────────────────────────────────────────────

async function wrapCursor() {
  await wrapGeneric({
    name: 'Cursor',
    binaryName: 'cursor',
    findBinary: findCursorBinary,
    envVar: 'ANTHROPIC_BASE_URL',
    installInstructions: [
      '  • Download from: https://cursor.sh',
      '  • macOS: brew install --cask cursor',
    ],
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// OpenAI Codex CLI wrapper
// ──────────────────────────────────────────────────────────────────────────────

async function wrapCodex() {
  await wrapGeneric({
    name: 'OpenAI Codex CLI',
    binaryName: 'codex',
    findBinary: findCodexBinary,
    envVar: 'OPENAI_API_BASE',
    installInstructions: [
      '  • Install OpenAI CLI: pip install openai',
      '  • Or: npm install -g openai',
    ],
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Generic wrapper (used by copilot, aider, cursor, codex)
// ──────────────────────────────────────────────────────────────────────────────

async function wrapGeneric(opts) {
  console.log('╭─ Lynkr Wrap ─────────────────────────────────────────');
  console.log(`│  Starting ${opts.name} through Lynkr proxy...`);
  console.log('╰──────────────────────────────────────────────────────');
  console.log('');

  // Suppress verbose Lynkr logs in wrap mode
  if (!process.env.LOG_LEVEL || process.env.LOG_LEVEL === 'info') {
    process.env.LOG_LEVEL = 'error';
  }

  // 1. Check for binary
  const binaryPath = opts.findBinary();
  if (!binaryPath) {
    console.error(`✗ ${opts.name} not found in PATH`);
    console.error('');
    console.error('Install it first:');
    opts.installInstructions.forEach((line) => console.error(line));
    console.error('');
    console.error(`Then verify: ${opts.binaryName} --version`);
    process.exit(2);
  }

  console.log(`✓ Found ${opts.name} at: ${binaryPath}`);

  // 2. Parse wrap-specific options
  const wrapOpts = parseWrapOptions(args.slice(1));
  const port = wrapOpts.port;
  const targetArgs = wrapOpts.passthrough;

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
      console.error(`  lynkr wrap ${opts.binaryName} --port ${port + 1}`);
      console.error('');
      console.error('Or stop existing Lynkr:');
      console.error('  lynkr stop');
    } else {
      console.error('Check your .env configuration:');
      console.error('  TIER_SIMPLE, TIER_COMPLEX, etc.');
      console.error('');
      console.error('Debug logs: tail -f data/logs/lynkr.log');
    }
    process.exit(1);
  }

  console.log('');
  console.log(`╭─ ${opts.name} ────────────────────────────────────────`);
  console.log('│  Launching with Lynkr routing enabled...');
  console.log('│  • Tier routing: active');
  console.log('│  • Compression: active');
  console.log('│  • Caching: active');
  console.log('╰──────────────────────────────────────────────────────');
  console.log('');

  // 4. Launch binary with Lynkr as base URL
  const child = spawn(binaryPath, targetArgs, {
    env: {
      ...process.env,
      [opts.envVar]: `http://localhost:${port}`,
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
    console.log(`╭─ ${opts.name} Exited ─────────────────────────────────`);

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
      if (server && typeof server.close === 'function') {
        await new Promise((resolve) => {
          server.close(() => {
            console.log('✓ Lynkr stopped');
            resolve();
          });
          // Force close after 2s
          setTimeout(() => {
            console.log('✓ Lynkr stopped (forced)');
            resolve();
          }, 2000);
        });
      }
    } catch (err) {
      // Ignore shutdown errors
    }

    process.exit(code || 0);
  });

  // Handle child spawn errors
  child.on('error', (err) => {
    console.error(`✗ Failed to launch ${opts.name}:`, err.message);
    process.exit(1);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper functions
// ──────────────────────────────────────────────────────────────────────────────

function findClaudeBinary() {
  return findBinaryHelper('claude', [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
  ]);
}

function findCopilotBinary() {
  return findBinaryHelper('github-copilot-cli', [
    '/usr/local/bin/github-copilot-cli',
    '/opt/homebrew/bin/github-copilot-cli',
    path.join(process.env.HOME || '', '.npm-global', 'bin', 'github-copilot-cli'),
    path.join(process.env.HOME || '', '.local', 'bin', 'github-copilot-cli'),
  ]);
}

function findAiderBinary() {
  return findBinaryHelper('aider', [
    '/usr/local/bin/aider',
    '/opt/homebrew/bin/aider',
    path.join(process.env.HOME || '', '.local', 'bin', 'aider'),
    path.join(process.env.HOME || '', 'Library', 'Python', '3.12', 'bin', 'aider'),
  ]);
}

function findCursorBinary() {
  return findBinaryHelper('cursor', [
    '/usr/local/bin/cursor',
    '/opt/homebrew/bin/cursor',
    '/Applications/Cursor.app/Contents/MacOS/Cursor',
    path.join(process.env.HOME || '', '.local', 'bin', 'cursor'),
  ]);
}

function findCodexBinary() {
  return findBinaryHelper('codex', [
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(process.env.HOME || '', '.local', 'bin', 'codex'),
  ]);
}

function findBinaryHelper(binaryName, commonPaths) {
  try {
    // Try 'which <binary>'
    const result = execSync(`which ${binaryName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const binaryPath = result.trim();
    if (binaryPath && existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // Fall through to common paths
  }

  // Try common installation paths
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
    const metricsCollector = getMetricsCollector();
    const metrics = metricsCollector.getMetrics();

    // Check if we have any data
    const hasRequests = metrics && (
      (typeof metrics.totalRequests === 'number' && metrics.totalRequests > 0) ||
      (typeof metrics.requestCount === 'number' && metrics.requestCount > 0)
    );

    if (!hasRequests) {
      console.log('');
      console.log('╭─ Lynkr Session Stats ────────────────────────────────');
      console.log('│  No requests tracked (check dashboard for details)');
      console.log('╰──────────────────────────────────────────────────────');
      return;
    }

    console.log('');
    console.log('╭─ Lynkr Session Stats ────────────────────────────────');

    const requestCount = metrics.totalRequests || metrics.requestCount || 0;
    console.log(`│  Requests      ${requestCount}`);

    if (metrics.tokensUsed || metrics.tokensSaved) {
      const tokensUsed = metrics.tokensUsed || 0;
      const tokensSaved = metrics.tokensSaved || 0;
      const originalTokens = tokensUsed + tokensSaved;
      if (originalTokens > 0) {
        const savingsPercent = Math.round((tokensSaved / originalTokens) * 100);
        console.log(`│  Tokens        Original: ${originalTokens.toLocaleString()}  →  Routed: ${tokensUsed.toLocaleString()}  (${savingsPercent}% saved)`);
      }
    }

    if (metrics.tierBreakdown && Object.keys(metrics.tierBreakdown).length > 0) {
      const tiers = Object.entries(metrics.tierBreakdown)
        .map(([tier, count]) => `${tier}: ${count}`)
        .join('  ');
      console.log(`│  Tier Mix      ${tiers}`);
    }

    if (metrics.cacheHits && metrics.cacheHits > 0) {
      console.log(`│  Cache Hits    ${metrics.cacheHits}`);
    }

    console.log('╰──────────────────────────────────────────────────────');
  } catch (err) {
    // Stats are nice-to-have, silently ignore errors
    console.log('');
    console.log('╭─ Lynkr Session Stats ────────────────────────────────');
    console.log('│  Stats unavailable (session data not found)');
    console.log('╰──────────────────────────────────────────────────────');
  }
}
