# Long-Term Memory System

Complete guide to Lynkr's Titans-inspired long-term memory system with surprise-based filtering.

---

## Overview

Lynkr includes a comprehensive long-term memory system that remembers important context across conversations, inspired by Google's Titans architecture.

**Key Benefits:**
- 🧠 **Persistent Context** - Remembers across sessions
- 🎯 **Intelligent Filtering** - Only stores novel information
- 🔍 **Semantic Search** - FTS5 with Porter stemmer
- ⚡ **Zero Latency** - <50ms retrieval, async extraction
- 📊 **Multi-Signal Ranking** - Recency, importance, relevance

---

## How It Works

### 1. Automatic Extraction

**After each assistant response:**
1. Parse response content
2. Calculate surprise score (0.0-1.0)
3. If score > threshold → Store memory
4. If score < threshold → Discard (redundant)

**Surprise Score Factors (5):**
1. **Novelty** (40%) - Is this new information?
2. **Contradiction** (25%) - Does this contradict existing knowledge?
3. **Specificity** (20%) - Is this specific vs general?
4. **Emphasis** (10%) - Was this emphasized by user?
5. **Context Switch** (5%) - Did conversation topic change?

**Example:**
```
"I prefer Python" (first time) → Score: 0.9 (novel) → STORE
"I prefer Python" (repeated) → Score: 0.1 (redundant) → DISCARD
"Actually, I prefer Go" → Score: 0.95 (contradiction) → STORE
```

### 2. Storage

**Memory Schema:**
```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  session_id TEXT,           -- Conversation ID (NULL = global)
  memory_type TEXT,          -- preference, decision, fact, entity, relationship
  content TEXT NOT NULL,     -- Memory text
  context TEXT,              -- Surrounding context
  importance REAL,           -- 0.0-1.0 (from surprise score)
  created_at INTEGER,        -- Unix timestamp
  last_accessed INTEGER,     -- For recency scoring
  access_count INTEGER       -- For frequency tracking
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, context,
  tokenize='porter'          -- Stemming for better search
);
```

### 3. Retrieval

**When processing request:**
1. Extract query keywords
2. FTS5 search: `MATCH query`
3. Rank by 3 signals:
   - **Recency** (30%) - Recently accessed memories
   - **Importance** (40%) - High surprise score
   - **Relevance** (30%) - FTS5 match score
4. Return top N memories (default: 5)

**Multi-Signal Formula:**
```javascript
score = (
  0.30 * recency_score +      // exp(-days_since_access / 30)
  0.40 * importance_score +    // stored surprise score
  0.30 * relevance_score       // FTS5 bm25 score
)
```

### 4. Injection

**Inject into system prompt:**
```
## Relevant Context from Previous Conversations

- [User preference] I prefer Python for data processing
- [Decision] Decided to use React for frontend
- [Fact] This app uses PostgreSQL database
- [Entity] File: src/api/auth.js handles authentication
```

**Format Options:**
- `system` - Inject into system prompt (recommended)
- `assistant_preamble` - Inject as assistant message

---

## Memory Types

### 1. Preferences
**What:** User preferences and likes
**Example:** "I prefer TypeScript over JavaScript"
**When:** User states preference explicitly

### 2. Decisions
**What:** Important decisions made
**Example:** "Decided to use Redux for state management"
**When:** Decision is finalized

### 3. Facts
**What:** Project-specific facts
**Example:** "This API uses JWT authentication"
**When:** New fact is established

### 4. Entities
**What:** Important files, functions, modules
**Example:** "File: utils/validation.js contains input validators"
**When:** First mention of entity

### 5. Relationships
**What:** Connections between entities
**Example:** "auth.js depends on jwt.js"
**When:** Relationship is established

---

## Configuration

### Core Settings

```bash
# Enable/disable memory system
MEMORY_ENABLED=true  # default: true

# Memories to inject per request
MEMORY_RETRIEVAL_LIMIT=5  # default: 5, range: 1-20

# Surprise threshold (0.0-1.0)
MEMORY_SURPRISE_THRESHOLD=0.3  # default: 0.3
# Lower (0.1-0.2) = store more
# Higher (0.4-0.5) = only novel info
```

### Database Management

```bash
# Auto-delete memories older than X days
MEMORY_MAX_AGE_DAYS=90  # default: 90

# Maximum total memories
MEMORY_MAX_COUNT=10000  # default: 10000

# Enable memory decay (importance decreases over time)
MEMORY_DECAY_ENABLED=true  # default: true

# Decay half-life (days)
MEMORY_DECAY_HALF_LIFE=30  # default: 30
```

### Advanced Settings

```bash
# Include global memories (session_id=NULL) in all sessions
MEMORY_INCLUDE_GLOBAL=true  # default: true

# Memory injection format
MEMORY_INJECTION_FORMAT=system  # options: system, assistant_preamble

# Enable automatic extraction
MEMORY_EXTRACTION_ENABLED=true  # default: true

# Memory format
MEMORY_FORMAT=compact  # options: compact, detailed

# Enable deduplication
MEMORY_DEDUP_ENABLED=true  # default: true

# Dedup lookback window
MEMORY_DEDUP_LOOKBACK=5  # default: 5
```

---

## Management Tools

### memory_search

Search stored memories:

```bash
claude "Search memories for authentication"

# Returns:
# Found 3 relevant memories:
# 1. [Preference] I prefer JWT over sessions
# 2. [Fact] auth.js handles user authentication
# 3. [Entity] File: utils/jwt.js creates tokens
```

### memory_add

Manually add memory:

```bash
claude "Remember that we're using PostgreSQL for this project"

# Uses memory_add tool internally
# Stores as fact with importance 1.0
```

### memory_forget

Delete specific memory:

```bash
claude "Forget the memory about using MongoDB"

# Searches and deletes matching memories
```

### memory_stats

View memory statistics:

```bash
claude "Show memory statistics"

# Returns:
# Total memories: 127
# Session memories: 45
# Global memories: 82
# Avg importance: 0.67
# Oldest memory: 23 days ago
```

---

## What Gets Remembered

### ✅ Stored (High Surprise Score)

- **Preferences**: "I prefer X"
- **Decisions**: "Decided to use Y"
- **Project facts**: "This app uses Z"
- **New entities**: First mention of files/functions
- **Contradictions**: "Actually, A not B"
- **Specific details**: "Database on port 5432"

### ❌ Discarded (Low Surprise Score)

- **Greetings**: "Hello", "Thanks"
- **Confirmations**: "OK", "Got it"
- **Repeated info**: Already said before
- **Generic statements**: "That's good"
- **Questions**: "What should I do?"

---

## Performance

### Metrics

**Retrieval:**
- Average: 20-50ms
- 95th percentile: 80ms
- 99th percentile: 150ms

**Extraction:**
- Async (non-blocking)
- Average: 50-100ms
- Happens after response sent

**Storage:**
- SQLite with WAL mode
- FTS5 indexing
- Automatic vacuum

### Database Size

**Typical sizes:**
- 100 memories: ~50KB
- 1,000 memories: ~500KB
- 10,000 memories: ~5MB

**Prune regularly:**
```bash
# Manual cleanup
rm data/memories.db

# Or configure auto-prune
MEMORY_MAX_AGE_DAYS=30
MEMORY_MAX_COUNT=5000
```

---

## Memory Decay

### Exponential Decay

Importance decreases over time:

```javascript
decayed_importance = original_importance * exp(-days / half_life)
```

**Example with 30-day half-life:**
- Day 0: 1.0 importance
- Day 30: 0.5 importance (half)
- Day 60: 0.25 importance
- Day 90: 0.125 importance

**Configure:**
```bash
MEMORY_DECAY_ENABLED=true
MEMORY_DECAY_HALF_LIFE=30  # Days for 50% decay
```

---

## Privacy

### Session-Specific Memories

```bash
# Memories tied to session_id
# Only visible in that conversation
```

### Global Memories

```bash
# Memories with session_id=NULL
# Visible across all conversations
# Good for project facts
```

### Data Location

```bash
# SQLite database
data/memories.db

# Delete to clear all memories
rm data/memories.db
```

---

## Best Practices

### 1. Set Appropriate Threshold

```bash
# For learning user preferences:
MEMORY_SURPRISE_THRESHOLD=0.2  # Store more

# For only critical info:
MEMORY_SURPRISE_THRESHOLD=0.5  # Store less
```

### 2. Regular Pruning

```bash
# Auto-prune old memories
MEMORY_MAX_AGE_DAYS=60  # Delete after 2 months
MEMORY_MAX_COUNT=5000   # Keep only 5k memories
```

### 3. Monitor Performance

```bash
# Check memory count
sqlite3 data/memories.db "SELECT COUNT(*) FROM memories;"

# Check database size
du -h data/memories.db
```

---

## Examples

### User Preference Learning

```
User: "I prefer Python for scripting"
System: [Stores: preference, importance 0.85]

Later...
User: "Write a script to process JSON"
System: [Injects: "I prefer Python"]
Assistant: "Here's a Python script to process JSON..."
```

### Project Context

```
User: "This API uses port 3000"
System: [Stores: fact, importance 0.75]

Later...
User: "How do I test the API?"
System: [Injects: "API uses port 3000"]
Assistant: "curl http://localhost:3000/endpoint"
```

### Decision Tracking

```
User: "Let's use PostgreSQL"
System: [Stores: decision, importance 0.90]

Later...
User: "Set up the database"
System: [Injects: "Using PostgreSQL"]
Assistant: "Here's the PostgreSQL setup..."
```

---

## Troubleshooting

### Too Many Memories

```bash
# Increase threshold
MEMORY_SURPRISE_THRESHOLD=0.5

# Reduce max count
MEMORY_MAX_COUNT=5000

# Reduce max age
MEMORY_MAX_AGE_DAYS=30
```

### Not Enough Memories

```bash
# Decrease threshold
MEMORY_SURPRISE_THRESHOLD=0.2

# Check extraction is enabled
MEMORY_EXTRACTION_ENABLED=true
```

### Poor Relevance

```bash
# Adjust retrieval limit
MEMORY_RETRIEVAL_LIMIT=10

# Check search is working
sqlite3 data/memories.db "SELECT * FROM memories_fts WHERE memories_fts MATCH 'your query';"
```

---

## Next Steps

- **[Token Optimization](token-optimization.md)** - Cost reduction strategies
- **[Features Guide](features.md)** - Core features
- **[FAQ](faq.md)** - Common questions

---

## Getting Help

- **[GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)** - Report issues
