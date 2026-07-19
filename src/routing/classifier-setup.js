/**
 * Classifier bootstrap — verifies ollama is installed and the classifier
 * model is pulled + warm. Called from:
 *  - `lynkr init` (interactive, prompts user for install, blocks on completion)
 *  - server boot (non-blocking, logs warnings, never errors out)
 *
 * Ollama install is intentionally NOT auto-executed. Silent `curl | sh`
 * during npm install is a supply-chain footgun; we detect and instruct
 * instead.
 *
 * "Later" work per user directive:
 *  - Fine-tune qwen2.5:3b on labeled classification data (needs LoRA infra)
 *  - Canary verification against known-good prompts on every startup
 */

const { spawn } = require('child_process');
const os = require('os');

// Reads the classifier model constant from difficulty-classifier.js so this
// module and the classifier stay in lock-step.
const { CLASSIFIER_MODEL_INFO } = require('./difficulty-classifier');

/**
 * Check whether the `ollama` CLI is on PATH.
 * @returns {Promise<{installed: boolean, version?: string}>}
 */
function detectOllama() {
  return new Promise((resolve) => {
    const proc = spawn('ollama', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve({ installed: false }));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ installed: true, version: out.trim() });
      } else {
        resolve({ installed: false });
      }
    });
  });
}

/**
 * Check whether a specific ollama model is present locally.
 * @param {string} model
 * @returns {Promise<boolean>}
 */
function isModelPulled(model) {
  return new Promise((resolve) => {
    const proc = spawn('ollama', ['list'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('close', () => {
      // ollama list prints "NAME ID SIZE MODIFIED" — grep by exact model name
      const rows = out.split('\n').slice(1);
      resolve(rows.some((line) => line.startsWith(model + ' ') || line.split(/\s+/)[0] === model));
    });
  });
}

/**
 * Pull a model, streaming progress to stdout.
 * @param {string} model
 * @returns {Promise<void>}
 */
function pullModel(model) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ollama', ['pull', model], { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ollama pull exited with code ${code}`));
    });
  });
}

/**
 * Warm the model — one dummy inference so first real call isn't cold.
 * Best-effort; failure doesn't block.
 * @param {string} model
 */
async function warmModel(model, endpoint = 'http://localhost:11434') {
  try {
    const url = `${endpoint.replace(/\/$/, '')}/api/chat`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ok' }],
        stream: false,
        options: { num_predict: 3 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Instructions to print when ollama is missing. */
function installInstructions() {
  const plat = os.platform();
  const lines = ['Ollama is required for the difficulty classifier and SIMPLE-tier serving.'];
  if (plat === 'darwin') {
    lines.push('Install on macOS:');
    lines.push('  brew install ollama');
    lines.push('  # or download: https://ollama.com/download');
  } else if (plat === 'linux') {
    lines.push('Install on Linux:');
    lines.push('  curl -fsSL https://ollama.com/install.sh | sh');
  } else if (plat === 'win32') {
    lines.push('Install on Windows:');
    lines.push('  Download the installer from https://ollama.com/download/windows');
  } else {
    lines.push('Install from https://ollama.com/download');
  }
  lines.push('After installing, re-run `lynkr init` (or restart the server).');
  return lines.join('\n');
}

/**
 * Full bootstrap flow with prompts.
 * @param {object} opts
 * @param {'interactive'|'boot'} opts.mode — interactive blocks on failure, boot warns and continues
 * @param {function} [opts.log] — logger function (defaults to console)
 * @param {function} [opts.warn] — warn function
 * @param {function} [opts.prompt] — async prompt(text)→string for interactive install/pull confirmations
 * @returns {Promise<{ready: boolean, ollama: boolean, model: boolean, reason?: string}>}
 */
async function ensureClassifierReady(opts = {}) {
  const mode = opts.mode || 'boot';
  const log = opts.log || ((msg) => console.log(msg));
  const warn = opts.warn || ((msg) => console.warn(msg));
  const { provider, model, endpoint } = CLASSIFIER_MODEL_INFO;

  if (provider !== 'ollama') {
    // Non-ollama providers not supported today — bail cleanly.
    warn(`Classifier provider "${provider}" is not yet auto-provisioned. Ensure ${model} is reachable manually.`);
    return { ready: false, ollama: false, model: false, reason: 'non_ollama_provider' };
  }

  // 1. Ollama detection
  const ollama = await detectOllama();
  if (!ollama.installed) {
    const msg = installInstructions();
    if (mode === 'interactive') {
      log('');
      log('⚠ Ollama not found on PATH.');
      log('');
      log(msg);
      log('');
    } else {
      warn(`[classifier-setup] Ollama not installed — classifier disabled. ${installInstructions().split('\n')[0]}`);
    }
    return { ready: false, ollama: false, model: false, reason: 'ollama_missing' };
  }
  if (mode === 'interactive') log(`✓ Ollama detected (${ollama.version || 'unknown version'}).`);

  // 2. Model pull
  const hasModel = await isModelPulled(model);
  if (!hasModel) {
    if (mode === 'interactive') {
      log('');
      log(`Classifier model "${model}" not present locally.`);
      const yes = opts.prompt ? await opts.prompt(`Pull ${model} now? [Y/n] `) : 'y';
      if (yes.trim().toLowerCase().startsWith('n')) {
        warn(`Skipped pull — classifier will be disabled until you run: ollama pull ${model}`);
        return { ready: false, ollama: true, model: false, reason: 'pull_declined' };
      }
      log(`Pulling ${model} (this can take a few minutes on first run)...`);
      try {
        await pullModel(model);
        log(`✓ Model ${model} pulled.`);
      } catch (err) {
        warn(`✗ Pull failed: ${err.message}`);
        return { ready: false, ollama: true, model: false, reason: 'pull_failed' };
      }
    } else {
      // Boot mode — don't auto-pull. Log a clear instruction and continue.
      warn(`[classifier-setup] Classifier model ${model} not pulled. Run: ollama pull ${model}. Classifier will fall back to anchor-only scoring until then.`);
      return { ready: false, ollama: true, model: false, reason: 'model_missing' };
    }
  }

  // 3. Warm-up
  const warmed = await warmModel(model, endpoint);
  if (mode === 'interactive') {
    log(warmed ? `✓ Model warmed (first classification will be fast).` : `⚠ Warm-up call failed — the first classification may be slow.`);
  }

  return { ready: true, ollama: true, model: true, warmed };
}

module.exports = {
  detectOllama,
  isModelPulled,
  pullModel,
  warmModel,
  installInstructions,
  ensureClassifierReady,
};
