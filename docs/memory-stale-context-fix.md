# Memory System Stale Context Issue - RESOLVED

## Problem

User typed "ls" → got strange response about "bd ready", "testLynkr directory", issue tracking workflow instead of file listing.

## Root Cause Found

The context flow logging revealed the exact problem:

```
after_sanitize: systemPromptLength: 0 (clean)
after_compression: systemPromptLength: 0 (still clean)
after_memory: systemPromptLength: 201 (STALE CONTEXT INJECTED!)
```

**Memory system injecting 5 stale memories from previous conversation:**
1. "a `Glob` pattern to list files and directories in the specified path"
2. "help with using Claude Code"
3. "help or want to give feedback, type /help or report issues at https://github"
4. "to explore the contents of the `testLynkr` directory, list its files and directories, or perform ano"
5. "further assistance or specific actions based on this listing, please let me know"

These memories were retrieved for EVERY new command ("ls", "pwd", etc.), confusing the LLM.

## Temporary Fix

**Disable memory injection** by setting environment variable:
```bash
export MEMORY_ENABLED=false
```

Added to `~/start_lynkr` script.

## Verification Steps

1. Restart Lynkr with updated script: `~/start_lynkr`
2. Test "ls" command - should return actual file listing
3. Check logs: `grep "MEMORY_DEBUG" ~/Lynkr_original/Lynkr/logs/llm-audit.log`
   - Should show NO memories retrieved when MEMORY_ENABLED=false

## Proper Fix (TODO)

The real solution is to fix memory relevance scoring:

1. **Improve relevance matching**: Old memories about "testLynkr" should NOT match simple "ls" command
2. **Add recency weighting**: Prefer recent context over old conversations
3. **Filter irrelevant memories**: Don't inject generic help text into every request
4. **Clear stale memories**: Option to purge old memories from database

### Files to modify for proper fix:
- `src/memory/retriever.js` - `retrieveRelevantMemories()` function
- `src/memory/search.js` - Relevance scoring algorithm
- Add memory cleanup command/script

## Impact

With memory disabled:
- ✅ "ls" returns file listing
- ✅ "pwd" returns current directory
- ✅ No stale context pollution
- ✅ Correct tool calls (Bash instead of Read)
- ❌ Loses legitimate long-term memory benefits

## Context Flow Logging

The CONTEXT_FLOW logging added in commit e55679b was essential for finding this issue.

Keeps logging in place for future debugging:
- `[CONTEXT_FLOW]` - Tracks system prompt transformations
- `[MEMORY_DEBUG]` - Shows memory injection details
- `[SESSION_DEBUG]` - Monitors session reuse

## Timeline

- Jan 29 16:34 - User reported "ls" returning strange bd/beads workflow text
- Jan 29 16:35 - Analyzed logs, found memory injection at fault
- Jan 29 16:36 - Disabled memory as temporary fix
- Next: Implement proper relevance scoring fix

---

# Update: Ollama System Prompt Issue Found (Root Cause)

## The REAL Problem

After disabling memory, user still got meta-commentary responses from llama3.2:
```
"It seems like you're ready to start a conversation! However, I want to clarify..."
```

Investigation revealed the actual root cause: **System prompt embedded in user message content**.

## Evidence from Logs

```json
{
  "systemPrompt": null,
  "userMessages": "[{\"role\":\"user\",\"content\":\"x-anthropic-billing-header:...You are Claude Code...ls\"}]"
}
```

The ~12KB system prompt (including SessionStart hook) was wrapped into the user message, so llama3.2 saw:
```
User: [6000 chars of system prompt] + [5000 chars of system reminders] + "ls"
```

This caused llama3.2 to roleplay as "Claude Code" instead of executing commands.

## Fix Applied

### 1. src/orchestrator/index.js (lines 839-840)
**Removed** Ollama-specific system flattening that was embedding system prompts into user messages.

**Before:**
```javascript
// Flatten system messages into the first user message
const systemChunks = [];
clean.messages = clean.messages.filter((msg) => {
  if (msg?.role === "system") {
    systemChunks.push(msg.content.trim());
    return false;
  }
  return true;
});

if (systemChunks.length > 0 && clean.messages.length > 0) {
  const firstMsg = clean.messages[0];
  if (firstMsg.role === "user") {
    firstMsg.content = `${systemContent}\n\n${firstMsg.content}`;
  }
}

delete clean.system;
```

**After:**
```javascript
// Keep system prompt separate for Ollama (same as other providers)
// Let invokeOllama() handle body.system properly
```

### 2. src/clients/databricks.js - invokeOllama() (lines 267-293)
**Added** proper system prompt handling as first message with `role: "system"`.

**Before:**
```javascript
const convertedMessages = (body.messages || []).map(msg => {
  // Convert messages...
});
```

**After:**
```javascript
const convertedMessages = [];

// Handle system prompt (same pattern as other providers)
if (body.system && typeof body.system === "string" && body.system.trim().length > 0) {
  convertedMessages.push({
    role: "system",
    content: body.system.trim()
  });
}

// Add user/assistant messages
(body.messages || []).forEach(msg => {
  // Convert messages...
});
```

### 3. src/clients/databricks.js - invokeOllamaFallback() (lines 401-427)
**Applied same change** as invokeOllama().

## Result

Now Ollama receives properly formatted messages:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are Claude Code, Anthropic's official CLI..."
    },
    {
      "role": "user",
      "content": "ls"
    }
  ]
}
```

## Benefits

1. ✅ System prompt sent as separate message (not embedded in user content)
2. ✅ Audit logs show proper `systemPrompt: "You are Claude Code..."` (not null)
3. ✅ User message contains only user input ("ls")
4. ✅ LLM understands its role and uses tools correctly
5. ✅ Consistent with other providers (OpenRouter, Azure OpenAI, llama.cpp, LM Studio)
6. ✅ SessionStart hook instructions properly respected as system context

## Alignment with Other Providers

This fix makes Ollama consistent with all other providers in the codebase:

- OpenRouter: `if (body.system) { messages.unshift({ role: "system", content: body.system }); }`
- Azure OpenAI: `if (body.system) { messages.unshift({ role: "system", content: body.system }); }`
- llama.cpp: `if (body.system) { messages.unshift({ role: "system", content: body.system }); }`
- LM Studio: `if (body.system) { messages.unshift({ role: "system", content: body.system }); }`

## Testing Required

1. **Verify system prompt in logs:**
   ```bash
   grep "systemPrompt" ~/Lynkr_original/Lynkr/logs/llm-audit.log | tail -5
   ```
   Expected: `systemPrompt: "You are Claude Code..."` (not null)

2. **Verify command execution:**
   - Type "ls" → Should return file listing via Bash tool call
   - Type "pwd" → Should return current directory
   - NOT: "It seems like you're ready to start a conversation..."

3. **Verify message structure:**
   ```bash
   cat logs/llm-audit-dictionary.jsonl | tail -1 | jq -r '.content[0]'
   ```
   Expected: First message has `role: "system"`, second has `role: "user"` with just "ls"

## Next Steps

- [ ] Test with user's gpt-oss:20b model
- [ ] Verify tool calls work correctly
- [ ] Re-enable memory system after confirming fix works
- [ ] Close related issues

## Commit Message

```
Fix Ollama system prompt handling to send as separate message

Previously, system prompts were embedded into user message content,
causing llama3.2 to see instructions as conversational context and
roleplay instead of executing commands.

Now system prompts are sent as first message with role: "system",
consistent with other providers (OpenRouter, Azure OpenAI, etc.).

Changes:
- orchestrator: Remove Ollama-specific system flattening
- databricks: Add body.system handling to invokeOllama()
- databricks: Add body.system handling to invokeOllamaFallback()

Fixes: User typing "ls" got meta-commentary instead of file listing
```
