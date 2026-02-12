/**
 * Complexity Analyzer Module
 *
 * Analyzes request complexity to determine optimal model routing.
 * Implements all 4 phases of auto model selection:
 * - Phase 1: Basic Scoring (token count, tool count, task classification)
 * - Phase 2: Advanced Classification (code complexity, reasoning detection)
 * - Phase 3: Learning & Tracking (metrics, feedback storage)
 * - Phase 4: ML-Based (embeddings similarity)
 *
 * @module routing/complexity-analyzer
 */

const logger = require('../logger');
const config = require('../config');

// ============================================================================
// PHASE 1: Basic Scoring Patterns
// ============================================================================

// Pre-compiled regex patterns for performance
const PATTERNS = {
  // Greetings - always local
  greeting: /^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|greetings|sup|yo|thanks?|thank\s*you)[\s\.\!\?,]*$/i,

  // Simple questions - likely local
  simpleQuestion: /^(what\s+is|what's|define|who\s+is|when\s+was|where\s+is)\s+\w/i,

  // Yes/No questions - local
  yesNo: /^(is\s+it|are\s+there|can\s+i|do\s+you|does\s+it|will\s+it|should\s+i)\s+/i,

  // Technical keywords
  technical: /\b(code|function|class|method|variable|api|database|server|client|module|import|export|async|await|promise|component|interface|type|struct|enum)\b/i,

  // File/path references
  fileReference: /\b(\w+\.(js|ts|py|rb|go|rs|java|cpp|c|h|jsx|tsx|vue|svelte|md|json|yaml|yml|toml|sql|sh|bash))\b|[\.\/]\w+\//i,
};

// ============================================================================
// PHASE 2: Advanced Classification Patterns
// ============================================================================

const ADVANCED_PATTERNS = {
  // Code complexity indicators
  codeComplexity: {
    multiFile: /\b(\d+\s*\+?\s*files?|multiple\s+files?|across\s+files?|all\s+files?|every\s+file)\b/i,
    architecture: /\b(architect(ure)?|microservice|distributed|system\s+design|scalab|infrastructure)\b/i,
    concurrent: /\b(async|concurrent|parallel|thread|worker|queue|mutex|lock|race\s+condition)\b/i,
    security: /\b(security|auth(entication)?|authori[sz]ation|encrypt|decrypt|vulnerab|injection|xss|csrf|sanitiz)\b/i,
    testing: /\b(test\s+coverage|integration\s+test|e2e|end.to.end|unit\s+test|regression|benchmark)\b/i,
    performance: /\b(optimi[sz]e|performance|memory\s+leak|profil|bottleneck|cach(e|ing))\b/i,
    database: /\b(migration|schema|index|query\s+optimi|transaction|rollback|backup)\b/i,
  },

  // Reasoning indicators - needs cloud
  reasoning: {
    stepByStep: /\b(step\s+by\s+step|think\s+through|let'?s\s+reason|reasoning|chain\s+of\s+thought)\b/i,
    tradeoffs: /\b(trade.?off|pros?\s+and\s+cons?|compare\s+options?|weigh\s+(the\s+)?options?|advantages?\s+and\s+disadvantages?)\b/i,
    analysis: /\b(analy[sz]e|evaluat|assess|review\s+(the|this|my)|audit|investigate|diagnos)\b/i,
    planning: /\b(plan(ning)?|strategy|approach|roadmap|design\s+doc|rfc|proposal)\b/i,
    edgeCases: /\b(edge\s+case|corner\s+case|what\s+if|exception|error\s+handling|fallback)\b/i,
  },

  // Task scope indicators
  taskScope: {
    entire: /\b(entire|whole|complete|full|all\s+of)\s+(codebase|project|app|application|system|repo)/i,
    refactor: /\b(refactor|restructure|reorgani[sz]e|rewrite|overhaul|migrate)\b/i,
    implement: /\b(implement|build|create|develop)\s+(a\s+)?(new\s+)?(feature|system|module|service|api)/i,
    fromScratch: /\b(from\s+scratch|ground\s+up|greenfield|bootstrap|scaffold)\b/i,
  },
};

// Force cloud patterns - always route to cloud regardless of score
const FORCE_CLOUD_PATTERNS = [
  /\b(security\s+(audit|review|assessment)|penetration\s+test|vulnerability\s+scan)\b/i,
  /\b(architect(ure)?\s+(review|design|diagram)|system\s+design)\b/i,
  /\b(refactor\s+(entire|whole|all|the\s+entire)|complete\s+rewrite)\b/i,
  /\b(code\s+review|pr\s+review|pull\s+request\s+review)\b/i,
  /\b(debug(ging)?\s+(complex|difficult|hard|tricky))\b/i,
  /\b(production\s+(issue|bug|incident|outage))\b/i,
];

// Force local patterns - always route to local regardless of score
const FORCE_LOCAL_PATTERNS = [
  /^(hi|hello|hey|thanks?|thank\s*you|bye|goodbye)[\s\.\!\?]*$/i,
  /^what\s+(time|day|date)\s+is\s+it/i,
  /^(yes|no|ok|okay|sure|got\s+it|understood)[\s\.\!\?]*$/i,
  /^(help|menu|commands?|options?)[\s\.\!\?]*$/i,
];

// Weighted Scoring (15 Dimensions)
const DIMENSION_WEIGHTS = {
  // Content Analysis (35%)
  tokenCount: 0.08,
  promptComplexity: 0.10,
  technicalDepth: 0.10,
  domainSpecificity: 0.07,
  // Tool Analysis (25%)
  toolCount: 0.08,
  toolComplexity: 0.10,
  toolChainPotential: 0.07,
  // Reasoning Requirements (25%)
  multiStepReasoning: 0.10,
  codeGeneration: 0.08,
  analysisDepth: 0.07,
  // Context Factors (15%)
  conversationDepth: 0.05,
  priorToolUsage: 0.05,
  ambiguity: 0.05,
};

// Tool complexity weights (higher = more complex)
const TOOL_COMPLEXITY_WEIGHTS = {
  Bash: 0.9,
  bash: 0.9,
  shell: 0.9,
  Write: 0.8,
  write_file: 0.8,
  Edit: 0.7,
  edit_file: 0.7,
  NotebookEdit: 0.7,
  Task: 0.9,
  agent_task: 0.9,
  WebSearch: 0.5,
  WebFetch: 0.4,
  Read: 0.3,
  read_file: 0.3,
  Glob: 0.2,
  Grep: 0.2,
  default: 0.5,
};

// Domain-specific keywords for complexity
const DOMAIN_KEYWORDS = {
  security: /\b(auth|encrypt|vulnerability|injection|xss|csrf|jwt|oauth|password|credential|secret)\b/i,
  ml: /\b(model|train|inference|tensor|embedding|neural|llm|gpt|transformer|pytorch|tensorflow)\b/i,
  distributed: /\b(microservice|kafka|redis|queue|scale|cluster|replicate|kubernetes|docker|container)\b/i,
  database: /\b(sql|nosql|migration|index|query|transaction|orm|postgres|mongodb|mysql)\b/i,
  frontend: /\b(react|vue|angular|svelte|css|html|component|state|redux|hooks)\b/i,
  devops: /\b(ci\/cd|pipeline|deploy|terraform|ansible|github\s*actions|jenkins)\b/i,
};

// ============================================================================
// PHASE 3: Metrics Tracking
// ============================================================================

// In-memory metrics (persisted via memory system if enabled)
const routingMetrics = {
  decisions: [],
  maxDecisions: 1000,  // Keep last 1000 decisions

  record(decision) {
    this.decisions.push({
      ...decision,
      timestamp: Date.now(),
    });

    // Trim old decisions
    if (this.decisions.length > this.maxDecisions) {
      this.decisions = this.decisions.slice(-this.maxDecisions);
    }
  },

  getStats() {
    if (this.decisions.length === 0) return null;

    const localCount = this.decisions.filter(d => d.provider === 'ollama' || d.provider === 'llamacpp' || d.provider === 'lmstudio').length;
    const cloudCount = this.decisions.length - localCount;
    const avgScore = this.decisions.reduce((sum, d) => sum + d.score, 0) / this.decisions.length;

    return {
      total: this.decisions.length,
      local: localCount,
      cloud: cloudCount,
      localPercent: Math.round((localCount / this.decisions.length) * 100),
      avgComplexityScore: Math.round(avgScore),
    };
  },
};

// ============================================================================
// CORE ANALYSIS FUNCTIONS
// ============================================================================

/**
 * Extract text content from request payload
 */
function extractContent(payload) {
  if (!payload?.messages || !Array.isArray(payload.messages)) {
    return '';
  }

  // Get last user message
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages[i];
    if (msg?.role === 'user') {
      if (typeof msg.content === 'string') {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter(block => block?.type === 'text')
          .map(block => block.text || '')
          .join(' ');
      }
    }
  }

  return '';
}

/**
 * Estimate token count (rough approximation)
 */
function estimateTokens(payload) {
  if (!payload?.messages) return 0;

  let totalChars = 0;
  for (const msg of payload.messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.text) totalChars += block.text.length;
      }
    }
  }

  // Rough approximation: 4 chars per token
  return Math.ceil(totalChars / 4);
}

/**
 * Score based on token count (0-20 points)
 */
function scoreTokens(payload) {
  const tokens = estimateTokens(payload);

  if (tokens < 500) return 0;       // Very simple
  if (tokens < 1000) return 4;      // Simple
  if (tokens < 2000) return 8;      // Medium
  if (tokens < 4000) return 12;     // Complex
  if (tokens < 8000) return 16;     // Very complex
  return 20;                         // Extremely complex
}

/**
 * Score based on tool count (0-20 points)
 */
function scoreTools(payload) {
  const toolCount = Array.isArray(payload?.tools) ? payload.tools.length : 0;

  if (toolCount === 0) return 0;    // No tools
  if (toolCount <= 3) return 4;     // Few tools - local can handle
  if (toolCount <= 6) return 8;     // Moderate tools
  if (toolCount <= 10) return 12;   // Many tools
  if (toolCount <= 15) return 16;   // Heavy tools
  return 20;                         // Very heavy tools
}

/**
 * Score based on task type (0-25 points)
 */
function scoreTaskType(content) {
  const contentLower = content.toLowerCase();

  // Check force patterns first
  for (const pattern of FORCE_LOCAL_PATTERNS) {
    if (pattern.test(content)) {
      return { score: 0, reason: 'force_local', pattern: 'greeting_or_simple' };
    }
  }

  for (const pattern of FORCE_CLOUD_PATTERNS) {
    if (pattern.test(content)) {
      return { score: 25, reason: 'force_cloud', pattern: pattern.source.slice(0, 30) };
    }
  }

  // Greetings
  if (PATTERNS.greeting.test(content)) {
    return { score: 0, reason: 'greeting' };
  }

  // Simple questions without technical content
  if (PATTERNS.simpleQuestion.test(content) && !PATTERNS.technical.test(content)) {
    return { score: 3, reason: 'simple_question' };
  }

  // Yes/No questions
  if (PATTERNS.yesNo.test(content)) {
    return { score: 2, reason: 'yes_no_question' };
  }

  // Task scope analysis
  if (ADVANCED_PATTERNS.taskScope.entire.test(content)) {
    return { score: 22, reason: 'entire_codebase' };
  }

  if (ADVANCED_PATTERNS.taskScope.fromScratch.test(content)) {
    return { score: 20, reason: 'from_scratch' };
  }

  if (ADVANCED_PATTERNS.taskScope.implement.test(content)) {
    return { score: 18, reason: 'new_implementation' };
  }

  if (ADVANCED_PATTERNS.taskScope.refactor.test(content)) {
    return { score: 16, reason: 'refactoring' };
  }

  // Technical content
  if (PATTERNS.technical.test(content)) {
    return { score: 10, reason: 'technical_content' };
  }

  // Default for non-technical
  return { score: 5, reason: 'general' };
}

/**
 * Score code complexity (0-20 points)
 * Phase 2: Advanced classification
 */
function scoreCodeComplexity(content) {
  let score = 0;
  const reasons = [];

  // Multi-file operations
  if (ADVANCED_PATTERNS.codeComplexity.multiFile.test(content)) {
    score += 5;
    reasons.push('multi_file');
  }

  // Architecture concerns
  if (ADVANCED_PATTERNS.codeComplexity.architecture.test(content)) {
    score += 5;
    reasons.push('architecture');
  }

  // Concurrency
  if (ADVANCED_PATTERNS.codeComplexity.concurrent.test(content)) {
    score += 3;
    reasons.push('concurrency');
  }

  // Security
  if (ADVANCED_PATTERNS.codeComplexity.security.test(content)) {
    score += 4;
    reasons.push('security');
  }

  // Testing
  if (ADVANCED_PATTERNS.codeComplexity.testing.test(content)) {
    score += 2;
    reasons.push('testing');
  }

  // Performance
  if (ADVANCED_PATTERNS.codeComplexity.performance.test(content)) {
    score += 3;
    reasons.push('performance');
  }

  // Database
  if (ADVANCED_PATTERNS.codeComplexity.database.test(content)) {
    score += 3;
    reasons.push('database');
  }

  return { score: Math.min(score, 20), reasons };
}

/**
 * Score reasoning requirements (0-15 points)
 * Phase 2: Advanced classification
 */
function scoreReasoning(content) {
  let score = 0;
  const reasons = [];

  // Step-by-step reasoning
  if (ADVANCED_PATTERNS.reasoning.stepByStep.test(content)) {
    score += 4;
    reasons.push('step_by_step');
  }

  // Trade-off analysis
  if (ADVANCED_PATTERNS.reasoning.tradeoffs.test(content)) {
    score += 4;
    reasons.push('tradeoffs');
  }

  // General analysis
  if (ADVANCED_PATTERNS.reasoning.analysis.test(content)) {
    score += 3;
    reasons.push('analysis');
  }

  // Planning
  if (ADVANCED_PATTERNS.reasoning.planning.test(content)) {
    score += 3;
    reasons.push('planning');
  }

  // Edge cases
  if (ADVANCED_PATTERNS.reasoning.edgeCases.test(content)) {
    score += 2;
    reasons.push('edge_cases');
  }

  return { score: Math.min(score, 15), reasons };
}

// ============================================================================
// WEIGHTED SCORING FUNCTION (15 Dimensions)
// ============================================================================

/**
 * Calculate weighted complexity score (0-100)
 * Uses 15 dimensions with configurable weights
 * @param {Object} payload - Request payload
 * @param {string} content - Extracted content
 * @returns {Object} Weighted score result
 */
function calculateWeightedScore(payload, content) {
  const dimensions = {};

  // 1. Token count (0-100)
  const tokens = estimateTokens(payload);
  dimensions.tokenCount = tokens < 500 ? 10 : tokens < 2000 ? 30 : tokens < 5000 ? 50 : tokens < 10000 ? 70 : 90;

  // 2. Prompt complexity (sentence structure, avg length)
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const avgLength = content.length / Math.max(sentences.length, 1);
  dimensions.promptComplexity = Math.min(avgLength / 2, 100);

  // 3. Technical depth (keyword density)
  const techMatches = (content.match(PATTERNS.technical) || []).length;
  dimensions.technicalDepth = Math.min(techMatches * 15, 100);

  // 4. Domain specificity (how many domains are touched)
  let domainScore = 0;
  const domainsMatched = [];
  for (const [domain, regex] of Object.entries(DOMAIN_KEYWORDS)) {
    if (regex.test(content)) {
      domainScore += 20;
      domainsMatched.push(domain);
    }
  }
  dimensions.domainSpecificity = Math.min(domainScore, 100);

  // 5. Tool count
  const toolCount = payload?.tools?.length ?? 0;
  dimensions.toolCount = toolCount === 0 ? 0 :
    toolCount <= 3 ? 20 :
    toolCount <= 6 ? 40 :
    toolCount <= 10 ? 60 :
    toolCount <= 15 ? 80 : 100;

  // 6. Tool complexity (weighted by tool types)
  if (payload?.tools?.length > 0) {
    const totalWeight = payload.tools.reduce((sum, t) => {
      const name = t.name || t.function?.name || '';
      return sum + (TOOL_COMPLEXITY_WEIGHTS[name] || TOOL_COMPLEXITY_WEIGHTS.default);
    }, 0);
    const avgWeight = totalWeight / payload.tools.length;
    dimensions.toolComplexity = avgWeight * 100;
  } else {
    dimensions.toolComplexity = 0;
  }

  // 7. Tool chain potential (sequential operations)
  dimensions.toolChainPotential = /\b(then|after|next|finally|first.*then|step\s*\d+)\b/i.test(content) ? 70 : 20;

  // 8. Multi-step reasoning
  dimensions.multiStepReasoning = ADVANCED_PATTERNS.reasoning.stepByStep.test(content) ? 80 :
    ADVANCED_PATTERNS.reasoning.planning.test(content) ? 60 : 20;

  // 9. Code generation requirement
  dimensions.codeGeneration = /\b(write|create|implement|build|generate)\s+(a\s+)?(new\s+)?(function|class|module|api|endpoint|service|component)/i.test(content) ? 80 : 20;

  // 10. Analysis depth
  dimensions.analysisDepth = ADVANCED_PATTERNS.reasoning.tradeoffs.test(content) ? 80 :
    ADVANCED_PATTERNS.reasoning.analysis.test(content) ? 60 : 20;

  // 11. Conversation depth
  const messageCount = payload?.messages?.length ?? 0;
  dimensions.conversationDepth = messageCount < 3 ? 10 :
    messageCount < 6 ? 30 :
    messageCount < 10 ? 50 : 70;

  // 12. Prior tool usage (tool results in conversation)
  const toolResults = (payload?.messages || []).filter(m =>
    m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')
  ).length;
  dimensions.priorToolUsage = toolResults === 0 ? 10 :
    toolResults < 3 ? 40 :
    toolResults < 6 ? 60 : 80;

  // 13. Ambiguity (inverse of specificity)
  const hasSpecifics = /\b(file|function|line\s*\d+|error|bug|at\s+[\w.]+:\d+|\/[\w/]+\.\w+)\b/i.test(content);
  dimensions.ambiguity = hasSpecifics ? 20 : content.length < 50 ? 70 : 40;

  // Calculate weighted total
  let weightedTotal = 0;
  for (const [dimension, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    weightedTotal += (dimensions[dimension] || 0) * weight;
  }

  return {
    score: Math.round(weightedTotal),
    dimensions,
    weights: DIMENSION_WEIGHTS,
    meta: {
      tokens,
      toolCount,
      messageCount,
      toolResults,
      domainsMatched,
    },
  };
}

/**
 * Get threshold based on SMART_TOOL_SELECTION_MODE
 */
function getThreshold() {
  const mode = config.smartToolSelection?.mode ?? 'heuristic';

  switch (mode) {
    case 'aggressive':
      return 60;  // More requests go to local
    case 'conservative':
      return 25;  // More requests go to cloud
    case 'heuristic':
    default:
      return 40;  // Balanced
  }
}

/**
 * Analyze request complexity and return full analysis
 *
 * @param {Object} payload - Request payload
 * @param {Object} options - Analysis options
 * @returns {Object} Complexity analysis result
 */
function analyzeComplexity(payload, options = {}) {
  const content = extractContent(payload);
  const messageCount = payload?.messages?.length ?? 0;
  const useWeighted = options.weighted ?? config.routing?.weightedScoring ?? false;

  // Use weighted scoring if enabled
  if (useWeighted) {
    const weighted = calculateWeightedScore(payload, content);
    const threshold = getThreshold();
    const mode = config.smartToolSelection?.mode ?? 'heuristic';

    // Check force patterns
    const taskTypeResult = scoreTaskType(content);
    let recommendation;
    if (taskTypeResult.reason === 'force_local') {
      recommendation = 'local';
    } else if (taskTypeResult.reason === 'force_cloud') {
      recommendation = 'cloud';
    } else {
      recommendation = weighted.score >= threshold ? 'cloud' : 'local';
    }

    return {
      score: weighted.score,
      threshold,
      mode: 'weighted',
      recommendation,
      breakdown: weighted.dimensions,
      weights: weighted.weights,
      meta: weighted.meta,
      forceReason: taskTypeResult.reason?.startsWith('force_') ? taskTypeResult.reason : null,
      content: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
    };
  }

  // Standard scoring (original logic)
  const tokenScore = scoreTokens(payload);
  const toolScore = scoreTools(payload);
  const taskTypeResult = scoreTaskType(content);
  const codeComplexityResult = scoreCodeComplexity(content);
  const reasoningResult = scoreReasoning(content);

  // Calculate total score (0-100)
  const totalScore = Math.min(
    tokenScore +
    toolScore +
    taskTypeResult.score +
    codeComplexityResult.score +
    reasoningResult.score,
    100
  );

  // Conversation length bonus (long conversations tend to be complex)
  const conversationBonus = messageCount > 10 ? 5 : (messageCount > 5 ? 2 : 0);
  const adjustedScore = Math.min(totalScore + conversationBonus, 100);

  // Determine recommendation
  const threshold = getThreshold();
  const mode = config.smartToolSelection?.mode ?? 'heuristic';

  let recommendation;
  if (taskTypeResult.reason === 'force_local') {
    recommendation = 'local';
  } else if (taskTypeResult.reason === 'force_cloud') {
    recommendation = 'cloud';
  } else {
    recommendation = adjustedScore >= threshold ? 'cloud' : 'local';
  }

  return {
    score: adjustedScore,
    threshold,
    mode,
    recommendation,
    breakdown: {
      tokens: { score: tokenScore, estimated: estimateTokens(payload) },
      tools: { score: toolScore, count: payload?.tools?.length ?? 0 },
      taskType: taskTypeResult,
      codeComplexity: codeComplexityResult,
      reasoning: reasoningResult,
      conversationBonus,
    },
    content: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
  };
}

/**
 * Quick check if request should be forced to local
 */
function shouldForceLocal(payload) {
  const content = extractContent(payload);
  return FORCE_LOCAL_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Quick check if request should be forced to cloud
 */
function shouldForceCloud(payload) {
  const content = extractContent(payload);
  return FORCE_CLOUD_PATTERNS.some(pattern => pattern.test(content));
}

// ============================================================================
// PHASE 4: Embeddings-Based Similarity (Optional Enhancement)
// ============================================================================

/**
 * Get embeddings for content (if embeddings are configured)
 * This is a placeholder for future ML-based routing
 */
async function getContentEmbedding(content) {
  // Check if embeddings are configured
  if (!config.ollama?.embeddingsModel && !config.llamacpp?.embeddingsEndpoint) {
    return null;
  }

  try {
    const endpoint = config.ollama?.embeddingsEndpoint ||
                     config.llamacpp?.embeddingsEndpoint;

    if (!endpoint) return null;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama?.embeddingsModel || 'nomic-embed-text',
        prompt: content.slice(0, 512),  // Limit for performance
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data.embedding;
  } catch (err) {
    logger.debug({ err: err.message }, 'Failed to get embedding for routing');
    return null;
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Reference embeddings for complex vs simple tasks (computed lazily)
let referenceEmbeddings = null;

/**
 * Analyze complexity using embeddings (Phase 4)
 * Compares request to known complex/simple reference prompts
 */
async function analyzeWithEmbeddings(payload) {
  const content = extractContent(payload);
  if (content.length < 20) return null;  // Too short for meaningful embedding

  const embedding = await getContentEmbedding(content);
  if (!embedding) return null;

  // Lazy initialize reference embeddings
  if (!referenceEmbeddings) {
    const complexRef = await getContentEmbedding(
      "Refactor the entire codebase to use microservices architecture with proper error handling and comprehensive test coverage"
    );
    const simpleRef = await getContentEmbedding(
      "What is a variable in programming"
    );

    if (complexRef && simpleRef) {
      referenceEmbeddings = { complex: complexRef, simple: simpleRef };
    }
  }

  if (!referenceEmbeddings) return null;

  const complexSimilarity = cosineSimilarity(embedding, referenceEmbeddings.complex);
  const simpleSimilarity = cosineSimilarity(embedding, referenceEmbeddings.simple);

  // Convert to score adjustment (-10 to +10)
  const embeddingAdjustment = Math.round((complexSimilarity - simpleSimilarity) * 20);

  return {
    complexSimilarity,
    simpleSimilarity,
    adjustment: embeddingAdjustment,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core analysis
  analyzeComplexity,
  extractContent,
  estimateTokens,

  // Quick checks
  shouldForceLocal,
  shouldForceCloud,

  // Individual scoring (for testing/debugging)
  scoreTokens,
  scoreTools,
  scoreTaskType,
  scoreCodeComplexity,
  scoreReasoning,

  // Weighted scoring
  calculateWeightedScore,

  // Configuration
  getThreshold,

  // Phase 3: Metrics
  routingMetrics,

  // Phase 4: Embeddings
  analyzeWithEmbeddings,
  getContentEmbedding,

  // Constants (for testing)
  PATTERNS,
  ADVANCED_PATTERNS,
  FORCE_CLOUD_PATTERNS,
  FORCE_LOCAL_PATTERNS,
  DIMENSION_WEIGHTS,
  TOOL_COMPLEXITY_WEIGHTS,
  DOMAIN_KEYWORDS,
};
