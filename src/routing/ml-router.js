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
const config = require('../config');
const logger = require('../logger');

let ort = null;
let session = null;
let tokenizer = null;
let initAttempted = false;
let initError = null;

// BERT tokenizer constants
const PAD_TOKEN_ID = 0;
const CLS_TOKEN_ID = 101;
const SEP_TOKEN_ID = 102;
const UNK_TOKEN_ID = 100;
const MAX_LENGTH = 512;

/**
 * Simple WordPiece tokenizer that uses the vocab from tokenizer.json.
 * Not a full HuggingFace tokenizer — just enough for BERT classification.
 */
class SimpleWordPieceTokenizer {
  constructor(vocabMap) {
    this.vocab = vocabMap; // token string → id
    this.unkId = UNK_TOKEN_ID;
  }

  /**
   * Load from HuggingFace tokenizer.json format
   */
  static fromFile(tokenizerPath) {
    const raw = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'));
    const vocabMap = new Map();

    // tokenizer.json has model.vocab as array of [token, id] pairs
    if (raw.model?.vocab) {
      if (Array.isArray(raw.model.vocab)) {
        for (const [token, id] of raw.model.vocab) {
          vocabMap.set(token, id);
        }
      } else if (typeof raw.model.vocab === 'object') {
        for (const [token, id] of Object.entries(raw.model.vocab)) {
          vocabMap.set(token, id);
        }
      }
    }

    if (vocabMap.size === 0) {
      // Try vocab.txt fallback
      const vocabTxtPath = path.join(path.dirname(tokenizerPath), 'vocab.txt');
      if (fs.existsSync(vocabTxtPath)) {
        const lines = fs.readFileSync(vocabTxtPath, 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const token = lines[i].trim();
          if (token) vocabMap.set(token, i);
        }
      }
    }

    if (vocabMap.size === 0) {
      throw new Error('Could not load vocabulary from tokenizer.json or vocab.txt');
    }

    logger.info({ vocabSize: vocabMap.size }, '[MLRouter] Tokenizer loaded');
    return new SimpleWordPieceTokenizer(vocabMap);
  }

  /**
   * Tokenize text using WordPiece algorithm.
   * Returns { input_ids, attention_mask } padded/truncated to MAX_LENGTH.
   */
  encode(text) {
    // Basic pre-tokenization: lowercase, split on whitespace and punctuation
    const normalized = text.toLowerCase().trim();
    const words = normalized.match(/[\w]+|[^\s\w]/g) || [];

    const tokenIds = [CLS_TOKEN_ID];

    for (const word of words) {
      if (tokenIds.length >= MAX_LENGTH - 1) break;

      // Try WordPiece: greedily match longest subword from left
      let start = 0;
      const subTokens = [];
      while (start < word.length) {
        let end = word.length;
        let matched = false;
        while (start < end) {
          let sub = word.slice(start, end);
          if (start > 0) sub = '##' + sub;
          if (this.vocab.has(sub)) {
            subTokens.push(this.vocab.get(sub));
            matched = true;
            break;
          }
          end--;
        }
        if (!matched) {
          subTokens.push(this.unkId);
          break;
        }
        start = end;
      }

      for (const id of subTokens) {
        if (tokenIds.length >= MAX_LENGTH - 1) break;
        tokenIds.push(id);
      }
    }

    tokenIds.push(SEP_TOKEN_ID);

    // Pad to MAX_LENGTH
    const inputIds = new Array(MAX_LENGTH).fill(PAD_TOKEN_ID);
    const attentionMask = new Array(MAX_LENGTH).fill(0);

    for (let i = 0; i < tokenIds.length && i < MAX_LENGTH; i++) {
      inputIds[i] = tokenIds[i];
      attentionMask[i] = 1;
    }

    return { inputIds, attentionMask };
  }
}

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
  if (initAttempted) return session !== null;
  initAttempted = true;

  const modelPath = config.routing?.mlRouter?.modelPath;
  if (!modelPath) {
    logger.debug('[MLRouter] No ML_ROUTER_MODEL configured — ML routing disabled');
    return false;
  }

  const resolvedModel = path.resolve(modelPath);
  if (!fs.existsSync(resolvedModel)) {
    logger.warn({ path: resolvedModel }, '[MLRouter] Model file not found — ML routing disabled');
    return false;
  }

  // Try to load onnxruntime-node (optional dependency)
  try {
    ort = require('onnxruntime-node');
  } catch {
    logger.warn('[MLRouter] onnxruntime-node not installed — ML routing disabled. Run: npm install onnxruntime-node');
    return false;
  }

  // Load tokenizer
  const modelDir = path.dirname(resolvedModel);
  const tokenizerPath = path.join(modelDir, 'tokenizer.json');
  const vocabPath = path.join(modelDir, 'vocab.txt');

  try {
    if (fs.existsSync(tokenizerPath)) {
      tokenizer = SimpleWordPieceTokenizer.fromFile(tokenizerPath);
    } else if (fs.existsSync(vocabPath)) {
      tokenizer = SimpleWordPieceTokenizer.fromFile(vocabPath);
    } else {
      logger.warn({ modelDir }, '[MLRouter] No tokenizer.json or vocab.txt found — ML routing disabled');
      return false;
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[MLRouter] Failed to load tokenizer');
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
    const { inputIds, attentionMask } = tokenizer.encode(prompt);

    const inputIdsTensor = new ort.Tensor('int64', BigInt64Array.from(inputIds.map(BigInt)), [1, MAX_LENGTH]);
    const attentionMaskTensor = new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)), [1, MAX_LENGTH]);

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
  const thresholds = config.routing?.mlRouter?.thresholds || {
    reasoning: 0.75,
    complex: 0.50,
    medium: 0.25,
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
  initAttempted = false;
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
