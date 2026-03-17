/**
 * ML-Based Router (RouteLLM BERT via ONNX)
 *
 * Classifies prompt complexity using a BERT model trained on 1M+ human
 * preference votes from LMSB Chatbot Arena. Runs locally via ONNX Runtime
 * with no external API calls.
 *
 * The model outputs 3 classes: [strong_win, tie, weak_win]
 * We use the strong_win probability as the complexity score.
 *
 * Config:
 *   ROUTING_STRATEGY=ml|heuristic|hybrid
 *   ML_ROUTER_MODEL=./models/router/routellm-bert.onnx
 *   ML_ROUTER_WEIGHT=0.6   (weight of ML score in hybrid mode)
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const config = require('../config');
const logger = require('../logger');

const HF_REPO = 'routellm/bert';
const REQUIRED_FILES = ['tokenizer.json', 'tokenizer_config.json'];

let ort = null;
let session = null;
let tokenizer = null;
let initPromise = null;
let initError = null;

const MAX_LENGTH = 512;
const PAD_TOKEN_ID = 1; // <pad> for XLM-RoBERTa

/**
 * Softmax over an array of logits.
 */
function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(x => x / sum);
}

/**
 * Initialize the ONNX session and tokenizer. Called lazily on first classify() call.
 * Returns true if successful, false if ML routing is unavailable.
 */
async function initialize() {
  if (initPromise) return initPromise;
  initPromise = _doInitialize();
  return initPromise;
}

/**
 * Auto-export the RouteLLM BERT model to ONNX format.
 * Runs the Python export script if Python + dependencies are available.
 * Falls back to downloading pre-exported files if a release URL is configured.
 */
async function autoExportModel(resolvedModel) {
  const modelDir = path.dirname(resolvedModel);
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'export-routellm-bert.py');

  // Ensure output directory exists
  fs.mkdirSync(modelDir, { recursive: true });

  // Try running the Python export script
  if (fs.existsSync(scriptPath)) {
    try {
      // Check if Python is available
      const pythonCmd = findPython();
      if (!pythonCmd) {
        logger.warn('[MLRouter] Python not found — cannot auto-export model. Run manually: python scripts/export-routellm-bert.py');
        return false;
      }

      // Check if required Python packages are installed
      try {
        execFileSync(pythonCmd, ['-c', 'import transformers, torch, onnx'], {
          timeout: 10000,
          stdio: 'pipe',
        });
      } catch {
        logger.warn('[MLRouter] Missing Python dependencies. Run: pip install routellm transformers torch onnx onnxruntime onnxscript');
        return false;
      }

      logger.info('[MLRouter] Running ONNX export (one-time setup, may take 30-60s)...');
      execFileSync(pythonCmd, [scriptPath], {
        timeout: 300000, // 5 minutes
        stdio: 'pipe',
        cwd: path.join(__dirname, '..', '..'),
      });

      if (fs.existsSync(resolvedModel)) {
        logger.info('[MLRouter] Model exported successfully');
        return true;
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[MLRouter] Auto-export failed');
    }
  }

  logger.warn(
    '[MLRouter] Model file not found. To set up ML routing:\n' +
    '  pip install routellm transformers torch onnx onnxruntime onnxscript\n' +
    '  python scripts/export-routellm-bert.py'
  );
  return false;
}

/**
 * Find a working Python 3 command.
 */
function findPython() {
  for (const cmd of ['python3', 'python']) {
    try {
      const version = execFileSync(cmd, ['--version'], { timeout: 5000, stdio: 'pipe' }).toString();
      if (version.includes('Python 3')) return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

async function _doInitialize() {

  const modelPath = config.routing?.mlRouter?.modelPath;
  if (!modelPath) {
    logger.debug('[MLRouter] No ML_ROUTER_MODEL configured — ML routing disabled');
    return false;
  }

  const resolvedModel = path.resolve(modelPath);
  if (!fs.existsSync(resolvedModel)) {
    logger.info('[MLRouter] Model not found — attempting auto-export...');
    const exported = await autoExportModel(resolvedModel);
    if (!exported) return false;
  }

  // Try to load onnxruntime-node (optional dependency)
  try {
    ort = require('onnxruntime-node');
  } catch {
    logger.warn('[MLRouter] onnxruntime-node not installed — ML routing disabled. Run: npm install onnxruntime-node');
    return false;
  }

  // Load tokenizer via @huggingface/transformers (pure JS, ESM)
  const modelDir = path.dirname(resolvedModel);

  try {
    const { AutoTokenizer } = await import('@huggingface/transformers');
    tokenizer = await AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
    logger.info({ modelDir }, '[MLRouter] Tokenizer loaded');
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
      logger.warn('[MLRouter] @huggingface/transformers not installed — ML routing disabled. Run: npm install @huggingface/transformers');
    } else {
      logger.warn({ err: err.message }, '[MLRouter] Failed to load tokenizer');
    }
    initError = err;
    return false;
  }

  // Load ONNX model
  try {
    session = await ort.InferenceSession.create(resolvedModel, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    logger.info({ model: resolvedModel }, '[MLRouter] ONNX model loaded successfully');
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, '[MLRouter] Failed to load ONNX model');
    initError = err;
    session = null;
    return false;
  }
}

/**
 * Classify a prompt's complexity using the BERT model.
 *
 * @param {string} prompt - User message text
 * @returns {Promise<{score: number, tier: string, probs: number[]}|null>}
 *   score: 0-1 (higher = needs stronger model)
 *   tier: SIMPLE|MEDIUM|COMPLEX|REASONING
 *   probs: [strong_win, tie, weak_win] probabilities
 *   Returns null if ML routing is unavailable.
 */
async function classify(prompt) {
  if (!session && !await initialize()) return null;
  if (!session || !tokenizer) return null;

  try {
    const encoded = tokenizer(prompt, {
      padding: 'max_length',
      truncation: true,
      max_length: MAX_LENGTH,
    });

    // @huggingface/transformers returns Tensor objects with .ort_tensor inside
    const inputIdsTensor = encoded.input_ids.ort_tensor;
    const attentionMaskTensor = encoded.attention_mask.ort_tensor;

    const results = await session.run({
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
    });

    const logits = Array.from(results.logits.data);
    const probs = softmax(logits);

    // probs[0] = strong model wins, probs[1] = tie, probs[2] = weak model wins
    // Higher strong_win probability = more complex prompt
    const score = probs[0] + probs[1] * 0.5; // strong_win + half of tie

    const tier = mapScoreToTier(score);

    logger.debug({
      score: Math.round(score * 100) / 100,
      tier,
      probs: probs.map(p => Math.round(p * 1000) / 1000),
    }, '[MLRouter] Classification result');

    return { score, tier, probs };
  } catch (err) {
    logger.debug({ err: err.message }, '[MLRouter] Classification failed');
    return null;
  }
}

/**
 * Map a 0-1 ML score to a routing tier.
 * Thresholds are configurable via ML_ROUTER_THRESHOLDS.
 */
function mapScoreToTier(score) {
  // Default thresholds calibrated for RouteLLM BERT output range (~0.55-0.70)
  const thresholds = config.routing?.mlRouter?.thresholds || {
    reasoning: 0.65,
    complex: 0.62,
    medium: 0.59,
  };

  if (score >= thresholds.reasoning) return 'REASONING';
  if (score >= thresholds.complex) return 'COMPLEX';
  if (score >= thresholds.medium) return 'MEDIUM';
  return 'SIMPLE';
}

/**
 * Compute a hybrid score blending heuristic and ML scores.
 *
 * @param {number} heuristicScore - 0-100 from complexity analyzer
 * @param {number} mlScore - 0-1 from ML classifier
 * @param {number} mlWeight - Weight for ML score (0-1, default 0.6)
 * @returns {number} Blended score 0-100
 */
function hybridScore(heuristicScore, mlScore, mlWeight) {
  const weight = mlWeight ?? config.routing?.mlRouter?.weight ?? 0.6;
  const normalizedHeuristic = heuristicScore / 100;
  const blended = (1 - weight) * normalizedHeuristic + weight * mlScore;
  return Math.round(blended * 100);
}

/**
 * Check if ML routing is available (model loaded and configured).
 */
function isAvailable() {
  return session !== null;
}

/**
 * Get the current routing strategy from config.
 */
function getStrategy() {
  return config.routing?.strategy || 'heuristic';
}

/**
 * Reset the ML router (for testing or hot reload).
 */
function reset() {
  session = null;
  tokenizer = null;
  ort = null;
  initPromise = null;
  initError = null;
}

module.exports = {
  classify,
  hybridScore,
  mapScoreToTier,
  isAvailable,
  getStrategy,
  initialize,
  reset,
};
