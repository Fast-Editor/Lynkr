# OAuth Subscription Routing: How It Works

## Your Question

**"How does it send to anthropic backends via subscription"**

---

## Current Behavior (As of 9.6.0)

**Lynkr currently uses API keys from `.env`, NOT OAuth tokens from incoming requests.**

### What Happens Now

```
Claude Code (with Pro/Max OAuth token)
  ↓ Sends: Authorization: Bearer <oauth-token>
  ↓
Lynkr Proxy (localhost:8081)
  ↓ IGNORES incoming Authorization header
  ↓ Uses config.anthropic.apiKey from .env instead
  ↓ Routes based on tier (SIMPLE → Ollama, COMPLEX → Anthropic)
  ↓
Anthropic API
  ✓ Uses API key from .env (NOT subscription)
```

**Result:** You need an Anthropic API key in `.env`, can't use Claude Code Pro/Max subscription.

---

## What SHOULD Happen (OAuth Passthrough)

```
Claude Code (with Pro/Max OAuth token)
  ↓ Sends: Authorization: Bearer <oauth-token>
  ↓
Lynkr Proxy (localhost:8081)
  ↓ Preserves incoming Authorization header
  ↓ Routes based on tier
  ↓ If target = anthropic:* → Forward OAuth token AS-IS
  ↓
Anthropic API
  ✓ Validates OAuth token
  ✓ Charges to Pro/Max subscription
```

**Result:** Works with Claude Code subscription, no API key needed!

---

## The Gap

### What's Missing

**Lynkr doesn't check for incoming OAuth tokens yet.** The code in `src/clients/databricks.js` always uses:

```javascript
// Current code (uses .env API key)
const headers = {
  "x-api-key": config.azureAnthropic.apiKey,  // From .env
  "anthropic-version": "2023-06-01",
};
```

**It should be:**

```javascript
// Proposed code (checks for OAuth first)
const authHeader = incomingHeaders?.authorization || incomingHeaders?.Authorization;
const headers = {
  "x-api-key": authHeader ? undefined : config.azureAnthropic.apiKey,
  "anthropic-version": "2023-06-01",
};

if (authHeader) {
  headers["Authorization"] = authHeader;  // Forward OAuth token
}
```

---

## How Headroom Does It

Headroom's approach (what you asked about):

```
1. Headroom wraps the official Claude Code binary
2. Sets ANTHROPIC_BASE_URL=http://localhost:PORT
3. Claude Code sends OAuth token in Authorization header
4. Headroom proxy receives request WITH OAuth token
5. Headroom forwards entire request to Anthropic, INCLUDING Authorization header
6. Anthropic validates OAuth → charges subscription
```

**Key:** Headroom PRESERVES the Authorization header, doesn't replace it.

---

## Implementation Plan (To Support Subscriptions)

### Phase 1: Detect OAuth Token

**File:** `src/clients/databricks.js`

**Add function:**
```javascript
function getAuthHeader(incomingHeaders, providerConfig) {
  // Priority:
  // 1. OAuth token from incoming request (Claude Code subscription)
  // 2. API key from .env (API-based usage)
  
  const incomingAuth = incomingHeaders?.authorization || incomingHeaders?.Authorization;
  
  if (incomingAuth && incomingAuth.startsWith('Bearer ')) {
    // Has OAuth token - use it (subscription mode)
    return { type: 'oauth', value: incomingAuth };
  }
  
  if (providerConfig.apiKey) {
    // No OAuth - use configured API key
    return { type: 'api-key', value: `Bearer ${providerConfig.apiKey}` };
  }
  
  return { type: 'none', value: null };
}
```

---

### Phase 2: Update All Provider Calls

**Example for Anthropic:**

```javascript
// Before (always uses API key)
async function invokeAzureAnthropic(body) {
  const headers = {
    "x-api-key": config.azureAnthropic.apiKey,
    "anthropic-version": "2023-06-01",
  };
  // ...
}

// After (checks for OAuth first)
async function invokeAzureAnthropic(body, incomingHeaders) {
  const auth = getAuthHeader(incomingHeaders, config.azureAnthropic);
  
  const headers = {
    "anthropic-version": "2023-06-01",
  };
  
  if (auth.type === 'oauth') {
    headers["Authorization"] = auth.value;  // Forward OAuth
  } else if (auth.type === 'api-key') {
    headers["x-api-key"] = config.azureAnthropic.apiKey;  // Use .env key
  } else {
    throw new Error("No authentication available for Anthropic");
  }
  
  // ...
}
```

---

### Phase 3: Thread Headers Through Call Stack

**Current flow:**
```
router.js → processMessage() → invokeProvider()
                                   ↓ (no headers passed)
                            databricks.js functions
```

**Need:**
```
router.js → processMessage(headers) → invokeProvider(headers)
                                         ↓ (headers passed)
                                  databricks.js functions (headers)
```

**Changes needed:**
- `src/api/router.js`: Already passes `headers: req.headers` to `processMessage()`
- `src/orchestrator/index.js`: Need to thread `headers` to provider calls
- `src/clients/databricks.js`: Update all `invoke*` functions to accept `headers`

---

## Temporary Workaround (Until Implemented)

**You can't use Claude Code subscription with Lynkr wrap yet.** You need API keys.

### Option A: Use API Keys for All Tiers

```bash
# .env
TIER_SIMPLE=ollama:llama3.2                    # Free local
TIER_COMPLEX=anthropic:claude-sonnet-4          # Needs ANTHROPIC_API_KEY
TIER_REASONING=anthropic:claude-opus-4          # Needs ANTHROPIC_API_KEY

ANTHROPIC_API_KEY=sk-ant-...                    # Required for anthropic tiers
OLLAMA_ENDPOINT=http://localhost:11434
```

---

### Option B: Mix Free Local + API-Based Cloud

```bash
# .env
TIER_SIMPLE=ollama:llama3.2                    # Free local
TIER_MEDIUM=ollama:qwen2.5                     # Free local
TIER_COMPLEX=openai:gpt-4o                     # Cheap OpenAI ($)
TIER_REASONING=anthropic:claude-sonnet-4       # Anthropic API ($$$)

OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OLLAMA_ENDPOINT=http://localhost:11434
```

---

### Option C: All Free (No Subscription/API)

```bash
# .env
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=ollama:qwen2.5
TIER_COMPLEX=ollama:deepseek-coder
TIER_REASONING=ollama:qwen2.5-coder:32b

OLLAMA_ENDPOINT=http://localhost:11434
```

**Limitation:** No access to Claude/GPT-4 quality, but 100% free.

---

## Testing OAuth Support

### When Implemented, Test Like This

```bash
# 1. Login to Claude Code (gets OAuth token)
claude login

# 2. NO API keys in .env (test OAuth passthrough)
# .env
TIER_SIMPLE=ollama:llama3.2
TIER_COMPLEX=anthropic:claude-sonnet-4
# ANTHROPIC_API_KEY=  ← COMMENTED OUT (forces OAuth)

# 3. Run wrap
lynkr wrap claude

# 4. Try a complex query
> Refactor this class  ← Should route to COMPLEX (Anthropic via OAuth)
```

**Expected:**
- Lynkr detects incoming OAuth token
- Forwards to Anthropic with OAuth header
- Anthropic validates → charges subscription
- No API key needed

**Current behavior:**
- Fails with "No Anthropic API key configured"

---

## Why This Matters

### With OAuth Passthrough (Future)

**Users can:**
- ✅ Use Claude Code Pro/Max subscription
- ✅ Get tier routing benefits (60-70% requests stay local)
- ✅ No separate API billing for Anthropic
- ✅ 3-5x more usage from same subscription limits

**Example:**
- 100 requests/day subscription limit
- 60% routed to free Ollama (don't count against limit)
- 40% hit Anthropic (count against limit)
- **Net:** 250 effective requests (2.5x multiplier)

---

### Without OAuth Passthrough (Current)

**Users must:**
- ❌ Have separate Anthropic API key
- ❌ Pay for API usage separately
- ❌ Can't leverage Pro/Max subscription

**Result:** Tier routing still works, but requires API keys for all cloud providers.

---

## Technical Challenges

### 1. Header Threading

**Problem:** Headers aren't threaded through the full call stack.

**Current:**
```javascript
// router.js
const result = await processMessage({
  headers: req.headers,  // ✅ Passed here
  // ...
});

// orchestrator/index.js
async function processMessage({ headers, ... }) {
  // ...
  await invokeProvider(body);  // ❌ Headers not passed
}

// databricks.js
async function invokeAzureAnthropic(body) {
  // ❌ No access to headers here
}
```

**Fix:** Thread `headers` through all provider calls.

---

### 2. Provider-Specific Auth

Different providers use different auth:

| Provider | Auth Method | Header |
|---|---|---|
| Anthropic (API) | API key | `x-api-key: sk-ant-...` |
| Anthropic (OAuth) | Bearer token | `Authorization: Bearer <oauth>` |
| OpenAI | API key | `Authorization: Bearer sk-...` |
| Azure OpenAI | API key or Bearer | `api-key:` or `Authorization:` |
| Bedrock | Bearer token | `Authorization: Bearer ABSK...` |
| Ollama | None | (no auth) |

**Solution:** Provider-specific auth detection.

---

### 3. Fallback Behavior

**What if OAuth is invalid?**

```javascript
// Proposed behavior
if (auth.type === 'oauth') {
  // Try OAuth first
  headers["Authorization"] = auth.value;
} else if (auth.type === 'api-key') {
  // Fall back to API key
  headers["x-api-key"] = config.apiKey;
} else {
  // No auth available
  if (provider === 'anthropic') {
    throw new Error("Anthropic requires authentication");
  }
}
```

---

## Status & Next Steps

### Current Status (9.6.0)

❌ **OAuth passthrough not implemented**
- Lynkr uses `.env` API keys only
- Can't leverage Claude Code Pro/Max subscription
- Wrap works, but requires separate API billing

---

### Planned Implementation

**Phase 1:** Header threading (pass `headers` through call stack)
**Phase 2:** Auth detection (check for OAuth vs API key)
**Phase 3:** Provider updates (use OAuth when available)
**Phase 4:** Testing (verify subscription charges work)

**Estimate:** 2-4 hours of development

---

### How to Help

**Want this feature?** Open an issue:

```
Title: Support OAuth token passthrough for subscription-based routing

Description:
Enable Lynkr wrap to forward OAuth tokens from Claude Code to Anthropic,
allowing Pro/Max subscription users to benefit from tier routing without
separate API billing.

Benefits:
- 3-5x effective capacity from same subscription
- No separate API costs
- Works with existing Claude Code login
```

---

## Comparison: Headroom vs Lynkr (Auth)

| Feature | Headroom | Lynkr (Current) | Lynkr (Planned) |
|---|---|---|---|
| OAuth passthrough | ✅ | ❌ | 🔄 Planned |
| API key support | ✅ | ✅ | ✅ |
| Mixed auth (OAuth + API) | ❌ | ❌ | ✅ (tier-specific) |
| Subscription billing | ✅ | ❌ | 🔄 Planned |

---

## Summary

**Your question:** "How does it send to anthropic backends via subscription"

**Answer:**
1. **Headroom:** Wraps Claude Code, preserves OAuth token, forwards to Anthropic → subscription billing works
2. **Lynkr (current):** Uses `.env` API keys, ignores OAuth → requires separate API billing
3. **Lynkr (planned):** Will detect OAuth, forward when available → subscription billing will work

**Temporary solution:** Use API keys in `.env` for Anthropic tiers until OAuth passthrough is implemented.

**Implementation:** Needs header threading + auth detection (~2-4 hours work).

---

**TL;DR:** Lynkr doesn't support subscription-based routing yet (it's on the roadmap). For now, use API keys in `.env`.
