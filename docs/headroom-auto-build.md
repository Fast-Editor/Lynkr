# Headroom Auto-Build Explained

## Why the Initial Build Failed

When you first ran `lynkr wrap claude`, Headroom tried to **pull** the Docker image from Docker Hub instead of building it locally.

### The Flow

```
lynkr wrap claude
  ↓
ensureRunning() in src/headroom/launcher.js
  ↓
Check if image exists: lynkr/headroom-sidecar:latest
  ↓
Image not found locally
  ↓
Check config: HEADROOM_DOCKER_AUTO_BUILD
  ↓
  ├─ true  → buildImage() from ./headroom-sidecar  ✅
  └─ false → pullImage() from Docker Hub           ❌ (404 error)
```

### What Happened

1. **Default config:** `HEADROOM_DOCKER_AUTO_BUILD` was commented out (defaults to `false`)
2. **Pull attempt:** Lynkr tried to pull `lynkr/headroom-sidecar:latest` from Docker Hub
3. **404 error:** Image doesn't exist on Docker Hub (it's a local-only image)
4. **Manual fix:** We manually built it with `docker compose --profile headroom build headroom`

---

## Solution: Auto-Build Enabled

**Now configured in `.env`:**

```bash
HEADROOM_DOCKER_BUILD_CONTEXT=./headroom-sidecar
HEADROOM_DOCKER_AUTO_BUILD=true
```

**Next time:**
- If the image doesn't exist, Lynkr will **automatically build** it from `./headroom-sidecar/Dockerfile`
- No manual `docker compose build` needed
- Works on first run of `lynkr wrap claude`

---

## When Builds Trigger

### ✅ Auto-Build Triggers

| Scenario | Trigger | When |
|---|---|---|
| `npm start` | `prestart` hook | Always checks/builds |
| `lynkr wrap claude` | `ensureRunning()` | Only if image missing + `AUTO_BUILD=true` |
| `node bin/cli.js wrap claude` | `ensureRunning()` | Only if image missing + `AUTO_BUILD=true` |

### ❌ Manual Build Required (if AUTO_BUILD=false)

```bash
# Option 1: Use docker-compose
docker compose --profile headroom build headroom

# Option 2: Use docker directly
docker build -t lynkr/headroom-sidecar:latest headroom-sidecar/

# Option 3: Use npm lifecycle hook
npm run prestart
```

---

## Configuration

### Recommended (Default Now)

```bash
# .env
HEADROOM_ENABLED=true
HEADROOM_DOCKER_ENABLED=true
HEADROOM_DOCKER_IMAGE=lynkr/headroom-sidecar:latest
HEADROOM_DOCKER_BUILD_CONTEXT=./headroom-sidecar
HEADROOM_DOCKER_AUTO_BUILD=true  # ✅ Auto-build if missing
```

**Behavior:**
- First run: Builds image automatically (~3-5 minutes)
- Subsequent runs: Uses existing image (instant)
- Image update: Delete image (`docker rmi lynkr/headroom-sidecar:latest`) and restart

---

### Alternative: Manual Build (Auto-Build Disabled)

```bash
# .env
HEADROOM_ENABLED=true
HEADROOM_DOCKER_ENABLED=true
HEADROOM_DOCKER_IMAGE=lynkr/headroom-sidecar:latest
# HEADROOM_DOCKER_BUILD_CONTEXT=./headroom-sidecar
# HEADROOM_DOCKER_AUTO_BUILD=true  # ❌ Disabled
```

**Behavior:**
- First run: Tries to pull from Docker Hub → 404 error
- Workaround: Manually build before running wrap
- Use case: CI/CD where image is pre-built

---

## Build Details

### What Gets Built

**Image:** `lynkr/headroom-sidecar:latest`  
**Context:** `./headroom-sidecar/`  
**Size:** ~3.5 GB (includes Python, ML libraries, compression algorithms)  
**Build time:** 3-5 minutes (first time)

### Dockerfile Contents

```dockerfile
FROM python:3.12-slim

# Install system dependencies (including g++ for hnswlib)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY server.py .
COPY config.py .

# ... (rest of Dockerfile)
```

**Key fix:** Added `g++` and `build-essential` for compiling `hnswlib` (C++ extension).

---

## Verification

### Check if Auto-Build is Enabled

```bash
grep "HEADROOM_DOCKER_AUTO_BUILD" .env
```

**Expected output:**
```
HEADROOM_DOCKER_AUTO_BUILD=true
```

---

### Check if Image Exists

```bash
docker images | grep headroom
```

**Expected output:**
```
lynkr/headroom-sidecar:latest   ba12d7081f24   10.2GB   3.47GB
```

---

### Test Auto-Build (Clean Slate)

```bash
# 1. Remove existing image
docker rmi lynkr/headroom-sidecar:latest

# 2. Stop any running containers
docker stop lynkr-headroom 2>/dev/null || true
docker rm lynkr-headroom 2>/dev/null || true

# 3. Run wrap (should auto-build)
lynkr wrap claude
```

**Expected behavior:**
- Detects missing image
- Triggers build from `./headroom-sidecar/`
- Builds image (~3-5 minutes)
- Starts container
- Launches Claude Code with Lynkr + Headroom

**Log output:**
```
✓ Found Claude Code at: /opt/homebrew/bin/claude
✓ Starting Lynkr on port 8081...
{"msg":"Initializing Headroom sidecar"}
{"msg":"Building Headroom sidecar image"}  ← AUTO-BUILD
... (build output) ...
{"msg":"Image build complete"}
{"msg":"Creating Headroom container"}
{"msg":"Headroom container started"}
{"msg":"Headroom sidecar is ready"}
✓ Lynkr ready on http://localhost:8081
```

---

## Troubleshooting

### Build Fails: "Unsupported compiler"

**Error:**
```
RuntimeError: Unsupported compiler -- at least C++11 support is needed!
```

**Cause:** Missing C++ compiler (hnswlib dependency)

**Fix:** Already applied in `headroom-sidecar/Dockerfile`:
```dockerfile
RUN apt-get install -y g++ build-essential
```

---

### Build Fails: "Dockerfile not found"

**Error:**
```
Error: Dockerfile not found in: /path/to/headroom-sidecar
```

**Fix:** Check `HEADROOM_DOCKER_BUILD_CONTEXT` points to correct directory:
```bash
# Should be:
HEADROOM_DOCKER_BUILD_CONTEXT=./headroom-sidecar

# Verify it exists:
ls -la headroom-sidecar/Dockerfile
```

---

### Auto-Build Not Triggering

**Symptoms:**
- Still tries to pull from Docker Hub
- Gets 404 error

**Checklist:**
1. ✅ `HEADROOM_DOCKER_AUTO_BUILD=true` in `.env`
2. ✅ `HEADROOM_DOCKER_BUILD_CONTEXT=./headroom-sidecar` in `.env`
3. ✅ `headroom-sidecar/Dockerfile` exists
4. ✅ No image exists: `docker images | grep headroom` returns nothing

**Debug:**
```bash
# Check config
grep HEADROOM .env | grep -i "auto\|build\|context"

# Remove image to trigger rebuild
docker rmi lynkr/headroom-sidecar:latest

# Run with debug logs
LOG_LEVEL=debug lynkr wrap claude
```

---

## Comparison: npm start vs lynkr wrap

| Command | Build Trigger | When | Always Runs |
|---|---|---|---|
| `npm start` | `prestart` hook | Before server starts | Yes (checks every time) |
| `lynkr wrap claude` | `ensureRunning()` | On-demand, if missing | No (only if image missing) |

**Best practice:** Use auto-build (`AUTO_BUILD=true`) so both methods work seamlessly.

---

## Summary

**Before (what happened):**
```bash
HEADROOM_DOCKER_AUTO_BUILD=false  # (commented out = default false)
lynkr wrap claude
→ Tries to pull from Docker Hub
→ 404 error (image doesn't exist)
→ Manual build required
```

**After (fixed):**
```bash
HEADROOM_DOCKER_AUTO_BUILD=true  # ✅ Enabled
lynkr wrap claude
→ Checks if image exists
→ Missing? Auto-builds from ./headroom-sidecar/
→ Uses existing image if present
→ Works seamlessly
```

**Result:** Zero-config Headroom integration — just run `lynkr wrap claude` and it works! 🎉
