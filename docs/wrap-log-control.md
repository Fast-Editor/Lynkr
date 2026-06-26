# Wrap Mode: Log Control

## Problem

When running `lynkr wrap claude`, you might see intermixed JSON logs that clutter the terminal:

```
{"level":30,"time":1782436809903,"env":"production","name":"claude-backend",...}
{"level":30,"time":1782436813703,"env":"production","name":"claude-backend",...}
> Try "how does index.html work?"
{"level":30,"time":1782436813704,"env":"production","name":"claude-backend",...}
```

**Cause:** Your `.env` file has `LOG_LEVEL=info`, which outputs all Lynkr logs to stdout. Since Claude Code also writes to the same terminal, the logs intermix.

---

## Solution (Automatic)

**As of this fix, Lynkr wrap automatically suppresses verbose logs.**

When you run `lynkr wrap <target>`, Lynkr now:
1. Checks if `LOG_LEVEL` is set
2. If `LOG_LEVEL=info` (or not set), overrides it to `error`
3. Only shows errors, not info/debug logs
4. Keeps your terminal clean

**You don't need to do anything** — it works automatically!

---

## Manual Control

### Hide Logs (Default - Clean Output)

```bash
# Wrap automatically sets this
lynkr wrap claude
```

**Output:**
```
╭─ Lynkr Wrap ─────────────────────────────────────────
│  Starting Claude Code through Lynkr proxy...
╰──────────────────────────────────────────────────────

✓ Found Claude Code at: /opt/homebrew/bin/claude
✓ Starting Lynkr on port 8081...
✓ Lynkr ready on http://localhost:8081

╭─ Claude Code ────────────────────────────────────────
│  Launching with Lynkr routing enabled...
│  • Tier routing: active
│  • Compression: active
│  • Caching: active
╰──────────────────────────────────────────────────────

> Try "how does index.html work?"
```

**Clean!** No JSON logs.

---

### Show Debug Logs (Troubleshooting)

```bash
# Show all logs (info level)
LOG_LEVEL=info lynkr wrap claude

# Show debug logs
LOG_LEVEL=debug lynkr wrap claude
```

**Output:**
```
✓ Starting Lynkr on port 8081...
{"level":30,"time":...,"msg":"Z.AI bulkhead initialized"}
{"level":30,"time":...,"msg":"SQLite session store initialised"}
{"level":30,"time":...,"msg":"Headroom sidecar initialized"}
...
```

**Use this when:**
- Debugging connection issues
- Checking which tiers are being hit
- Verifying Headroom is working
- Troubleshooting routing decisions

---

## Permanent Configuration

### Option 1: Keep .env Clean (Recommended)

**In `.env`:**
```bash
LOG_LEVEL=error  # Clean output by default
```

**Result:** Always clean output, even outside wrap mode.

---

### Option 2: Override Per-Command

**In `.env`:**
```bash
LOG_LEVEL=info  # Verbose logs for npm start
```

**Run wrap with override:**
```bash
LOG_LEVEL=error lynkr wrap claude  # Clean for wrap only
```

**Result:** Verbose logs for `npm start`, clean for wrap.

---

## Why Logs Intermix

### The Technical Reason

```
Terminal (stdout/stderr)
    ↓
├─ Lynkr server logs (JSON, goes to stdout)
└─ Claude Code UI (text, also stdout)
    ↓
Both share the same terminal → intermixed output
```

### The Fix

```javascript
// bin/wrap.js
if (!process.env.LOG_LEVEL || process.env.LOG_LEVEL === 'info') {
  process.env.LOG_LEVEL = 'error';  // Override to error
}
```

**Result:** Lynkr only logs errors, not info → clean terminal.

---

## When to Show Logs

### ✅ Show Logs (Debugging)

- Investigating routing issues
- Checking if Headroom is working
- Verifying tier assignments
- Diagnosing connection problems

**Command:**
```bash
LOG_LEVEL=debug lynkr wrap claude
```

---

### ❌ Hide Logs (Normal Use)

- Daily coding sessions
- Demo/presentation
- Sharing screen
- Clean terminal aesthetic

**Command:**
```bash
lynkr wrap claude  # Default: clean
```

---

## Log Levels Explained

| Level | What You See | Use Case |
|---|---|---|
| `error` | Only errors | **Default wrap mode** — clean output |
| `warn` | Warnings + errors | Troubleshooting issues |
| `info` | All operations | Debugging, development |
| `debug` | Everything | Deep debugging |

**Wrap mode default:** `error` (clean)  
**Server mode default:** `info` (verbose)

---

## Example: Before and After

### Before (LOG_LEVEL=info)

```
✓ Starting Lynkr on port 8081...
{"level":30,"time":1782436809903,"env":"production","name":"claude-backend","requestId":"11fcb740e43b0f753d24f54d3bc952b6","method":"POST","path":"/v1/messages","query":{"beta":"true"},"msg":"Request started"}
{"level":30,"time":1782436813703,"env":"production","name":"claude-backend","dbPath":"/Users/vishalveera.reddy/claude-code/data/telemetry.db","msg":"Routing telemetry database initialised"}
{"level":30,"time":1782436813704,"env":"production","name":"claude-backend","context":"model_invocation","estimated":{"system":191,"tools":0,"messages":2,"total":193},"actual":{"inputTokens":3149,"outputTokens":1,"cacheCreationTokens":0,"cacheReadTokens":0,"totalTokens":3150},"estimateAccuracy":"1632.12%","msg":"Token usage tracked"}
> Try "how does index.html work?"
{"level":30,"time":1782436813706,"env":"production","name":"claude-backend","requestId":"11fcb740e43b0f753d24f54d3bc952b6","method":"POST","path":"/v1/messages","status":200,"duration":3803,"msg":"Request completed"}
```

**Cluttered!**

---

### After (LOG_LEVEL=error)

```
✓ Starting Lynkr on port 8081...
✓ Lynkr ready on http://localhost:8081

╭─ Claude Code ────────────────────────────────────────
│  Launching with Lynkr routing enabled...
╰──────────────────────────────────────────────────────

> Try "how does index.html work?"
```

**Clean!**

---

## FAQ

**Q: Can I disable the Lynkr banner too?**  
A: Yes, set `LYNKR_WRAP_QUIET=true` (not implemented yet, but can be added if needed).

**Q: Will this hide errors?**  
A: No — errors are always shown, even at `LOG_LEVEL=error`.

**Q: What about Headroom logs?**  
A: Headroom logs to its own container. View them with:
```bash
docker logs lynkr-headroom
```

**Q: Can I show logs for just one session?**  
A: Yes:
```bash
LOG_LEVEL=debug lynkr wrap claude  # This session only
```

**Q: Does this affect `npm start`?**  
A: No — `npm start` uses the `.env` setting directly. Wrap overrides it only for wrap mode.

---

## Summary

**Problem:** JSON logs intermix with Claude Code UI  
**Cause:** `LOG_LEVEL=info` in `.env`  
**Fix:** Wrap now auto-sets `LOG_LEVEL=error`  
**Result:** Clean terminal by default  

**To debug:** `LOG_LEVEL=debug lynkr wrap claude`  
**To clean:** `lynkr wrap claude` (default)

---

**Your terminal is now clean by default!** 🎉
