const store = require("./store");
const surprise = require("./surprise");
const config = require("../config");
const logger = require("../logger");

// Extraction patterns for different memory types
const EXTRACTION_PATTERNS = {
  preference: [
    /(?:I|user|they|you)\s+(?:prefer|like|want|need|always|never|usually|typically)\s+([^.!?\n]{10,100})/gi,
    /(?:my|your|their|the user's)\s+(?:preference|choice|favorite)\s+(?:is|for|would be)\s+([^.!?\n]{10,100})/gi,
    /(?:should|must|need to)\s+(?:use|implement|do|follow)\s+([^.!?\n]{10,100})/gi,
  ],

  decision: [
    /(?:decided|choosing|going with|selected|picked|opted for)\s+([^.!?\n]{10,100})/gi,
    /(?:the|our|my)\s+(?:approach|strategy|plan|solution)\s+(?:is|will be|should be)\s+([^.!?\n]{10,100})/gi,
    /(?:let's|we'll|I'll)\s+(?:use|implement|go with|choose)\s+([^.!?\n]{10,100})/gi,
    /(?:agreed|confirmed)\s+(?:to|that|on)\s+([^.!?\n]{10,100})/gi,
  ],

  fact: [
    /(?:this|the)\s+(?:project|codebase|application|system)\s+(?:uses|is|has|implements|requires)\s+([^.!?\n]{10,150})/gi,
    /(?:important|note|remember|keep in mind):\s*([^.!?\n]{10,150})/gi,
    /(?:the|this)\s+(?:file|function|class|module|component)\s+(?:is|handles|manages|does)\s+([^.!?\n]{10,150})/gi,
    /(?:currently|now|at the moment)\s+(?:using|implementing|running)\s+([^.!?\n]{10,100})/gi,
  ],

  entity: [
    /(?:file|function|class|module|component|package|library)\s+['"`]?([A-Za-z0-9_./\-]+)['"`]?/gi,
    /in\s+['"`]([A-Za-z0-9_./\-]+\.(?:js|ts|py|java|go|rs|cpp|c|h))['"`]/gi,
    /`([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)`/g, // Code references
  ],

  relationship: [
    /([A-Za-z0-9_]+)\s+(?:depends on|imports|uses|extends|implements|inherits from)\s+([A-Za-z0-9_]+)/gi,
    /([A-Za-z0-9_./\-]+)\s+(?:calls|invokes|references)\s+([A-Za-z0-9_./\-]+)/gi,
  ],
};

/**
 * Extract memories from assistant response and conversation context
 */
async function extractMemories(assistantResponse, conversationMessages, context = {}) {
  if (!config.memory?.extraction?.enabled) {
    return [];
  }

  const { sessionId = null } = context;
  const memories = [];

  try {
    // Extract assistant message content
    const assistantContent = extractContent(assistantResponse);
    if (!assistantContent) return [];

    // Get last user message for context
    const lastUserMessage = conversationMessages
      ?.filter(m => m.role === 'user')
      ?.pop();
    const userContent = lastUserMessage ? extractContent(lastUserMessage) : '';

    // Extract different types of memories
    const preferences = extractByType(assistantContent, 'preference');
    const decisions = extractByType(assistantContent, 'decision');
    const facts = extractByType(assistantContent, 'fact');
    const entities = extractEntities(assistantContent);
    const relationships = extractRelationships(assistantContent);

    // Create memory objects with surprise scores
    for (const content of preferences) {
      const memory = await createMemoryWithSurprise({
        content,
        type: 'preference',
        category: 'user',
        sessionId,
        userContent,
      });
      if (memory) memories.push(memory);
    }

    for (const content of decisions) {
      const memory = await createMemoryWithSurprise({
        content,
        type: 'decision',
        category: 'project',
        sessionId,
        userContent,
      });
      if (memory) memories.push(memory);
    }

    for (const content of facts) {
      const memory = await createMemoryWithSurprise({
        content,
        type: 'fact',
        category: classifyCategory(content),
        sessionId,
        userContent,
      });
      if (memory) memories.push(memory);
    }

    for (const entityName of entities) {
      // Track entity
      store.trackEntity({
        type: 'code',
        name: entityName,
        context: { source: 'extraction' }
      });

      const memory = await createMemoryWithSurprise({
        content: `Entity: ${entityName}`,
        type: 'entity',
        category: 'code',
        sessionId,
        userContent,
        metadata: { entityName },
      });
      if (memory) memories.push(memory);
    }

    for (const { from, to, relationship } of relationships) {
      const memory = await createMemoryWithSurprise({
        content: `${from} ${relationship} ${to}`,
        type: 'relationship',
        category: 'code',
        sessionId,
        userContent,
        metadata: { from, to, relationship },
      });
      if (memory) memories.push(memory);
    }

    logger.debug({
      sessionId,
      memoriesExtracted: memories.length,
      types: {
        preference: preferences.length,
        decision: decisions.length,
        fact: facts.length,
        entity: entities.length,
        relationship: relationships.length,
      },
    }, 'Memory extraction completed');

    return memories;
  } catch (err) {
    logger.error({ err, sessionId }, 'Memory extraction failed');
    return [];
  }
}

/**
 * Extract content from message (handle different formats)
 */
function extractContent(message) {
  if (!message) return '';

  // Handle different message formats
  if (typeof message === 'string') return message;

  if (message.content) {
    if (typeof message.content === 'string') return message.content;

    // Handle array of content blocks
    if (Array.isArray(message.content)) {
      return message.content
        .filter(block => block?.type === 'text' || typeof block === 'string')
        .map(block => typeof block === 'string' ? block : block.text)
        .join('\n');
    }
  }

  // Handle choices array (from model responses)
  if (message.choices && Array.isArray(message.choices)) {
    const choice = message.choices[0];
    if (choice?.message?.content) {
      return extractContent(choice.message);
    }
  }

  return '';
}

/**
 * Extract memories by type using patterns
 */
function extractByType(text, type) {
  const patterns = EXTRACTION_PATTERNS[type] || [];
  const matches = new Set();

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const captured = match[1]?.trim();
      if (captured && captured.length >= 10 && captured.length <= 200) {
        matches.add(captured);
      }
    }
  }

  return Array.from(matches);
}

/**
 * Extract entity references
 */
function extractEntities(text) {
  const entities = new Set();
  const patterns = EXTRACTION_PATTERNS.entity;

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const entityName = match[1]?.trim();
      if (entityName && entityName.length >= 3 && entityName.length <= 100) {
        entities.add(entityName);
      }
    }
  }

  return Array.from(entities);
}

/**
 * Extract relationships between entities
 */
function extractRelationships(text) {
  const relationships = [];
  const patterns = EXTRACTION_PATTERNS.relationship;

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const from = match[1]?.trim();
      const to = match[2]?.trim();
      if (from && to) {
        relationships.push({
          from,
          to,
          relationship: 'depends_on', // Generalized relationship type
        });
      }
    }
  }

  return relationships;
}

/**
 * Classify content category
 */
function classifyCategory(content) {
  const lower = content.toLowerCase();

  if (lower.includes('code') || lower.includes('function') || lower.includes('file') ||
      lower.includes('class') || lower.includes('module')) {
    return 'code';
  }

  if (lower.includes('project') || lower.includes('application') || lower.includes('system')) {
    return 'project';
  }

  if (lower.includes('user') || lower.includes('prefer') || lower.includes('like')) {
    return 'user';
  }

  return 'general';
}

/**
 * Create memory with surprise score calculation
 */
async function createMemoryWithSurprise(options) {
  const { content, type, category, sessionId, userContent, metadata = {} } = options;

  // Get existing memories for surprise calculation
  const existingMemories = store.getRecentMemories({ limit: 100, sessionId });

  // Calculate surprise score
  const surpriseScore = surprise.calculateSurprise({
    content,
    type,
    category,
  }, existingMemories, { userContent });

  // Only store if surprise score exceeds threshold
  const threshold = config.memory?.surpriseThreshold ?? 0.3;
  if (surpriseScore < threshold) {
    logger.debug({ content, surpriseScore, threshold }, 'Memory filtered by surprise threshold');
    return null;
  }

  // Calculate initial importance based on surprise and type
  const importance = calculateInitialImportance(type, surpriseScore);

  // Store memory
  try {
    const memory = store.createMemory({
      sessionId,
      content,
      type,
      category,
      importance,
      surpriseScore,
      metadata: {
        ...metadata,
        extractedAt: Date.now(),
      },
    });

    return memory;
  } catch (err) {
    logger.warn({ err, content }, 'Failed to store memory');
    return null;
  }
}

/**
 * Calculate initial importance score
 */
function calculateInitialImportance(type, surpriseScore) {
  // Base importance by type
  const baseImportance = {
    preference: 0.7,  // User preferences are important
    decision: 0.8,    // Decisions are very important
    fact: 0.6,        // Facts are moderately important
    entity: 0.4,      // Entities are less important individually
    relationship: 0.5,
  };

  const base = baseImportance[type] ?? 0.5;

  // Boost by surprise score (0-1 scale)
  return Math.min(1.0, base + (surpriseScore * 0.3));
}

/**
 * Parse entities from content
 */
function parseEntities(content) {
  return extractEntities(content);
}

module.exports = {
  extractMemories,
  extractContent,
  extractByType,
  extractEntities,
  extractRelationships,
  parseEntities,
  classifyCategory,
};
