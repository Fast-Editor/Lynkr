# Lynkr Installation Guide

Simple, step-by-step installation for all platforms.

---

## Quick Install (Recommended)

### 1. Install Node.js 20+

**macOS**
```bash
brew install node
```

**Ubuntu/Debian**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows**
Download from [nodejs.org](https://nodejs.org)

### 2. Install Lynkr

```bash
npm install -g lynkr
```

### 3. Start Lynkr

```bash
lynkr start
```

That's it! Lynkr is now running on `http://localhost:8081`

---

## Initial Configuration

On first run, Lynkr creates a `.env` file in `~/.lynkr/.env`

### Option A: Free Local (Ollama)

1. **Install Ollama**
   ```bash
   # macOS/Linux
   curl -fsSL https://ollama.com/install.sh | sh
   
   # Or download from https://ollama.com
   ```

2. **Pull a model**
   ```bash
   ollama pull qwen2.5-coder:latest
   ```

3. **Edit `~/.lynkr/.env`**
   ```bash
   MODEL_PROVIDER=ollama
   FALLBACK_ENABLED=false
   OLLAMA_MODEL=qwen2.5-coder:latest
   OLLAMA_ENDPOINT=http://localhost:11434
   
   # Recommended settings
   POLICY_MAX_STEPS=50
   POLICY_MAX_TOOL_CALLS=100
   POLICY_SAFE_COMMANDS_ENABLED=false
   ```

4. **Restart Lynkr**
   ```bash
   lynkr start
   ```

### Option B: Cloud (OpenRouter)

1. **Get API key from [openrouter.ai](https://openrouter.ai)**

2. **Edit `~/.lynkr/.env`**
   ```bash
   MODEL_PROVIDER=openrouter
   OPENROUTER_API_KEY=sk-or-v1-your-key-here
   FALLBACK_ENABLED=false
   
   # Recommended settings
   POLICY_MAX_STEPS=50
   POLICY_MAX_TOOL_CALLS=100
   ```

3. **Restart Lynkr**
   ```bash
   lynkr start
   ```

### Option C: Enterprise (AWS Bedrock)

1. **Get AWS credentials**

2. **Edit `~/.lynkr/.env`**
   ```bash
   MODEL_PROVIDER=bedrock
   AWS_BEDROCK_API_KEY=your-aws-key
   AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
   FALLBACK_ENABLED=false
   
   # Recommended settings
   POLICY_MAX_STEPS=50
   POLICY_MAX_TOOL_CALLS=100
   ```

3. **Restart Lynkr**
   ```bash
   lynkr start
   ```

---

## Connect Your AI Tool

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy
claude "write hello world in python"
```

Add to your `~/.zshrc` or `~/.bashrc` to make permanent:
```bash
echo 'export ANTHROPIC_BASE_URL=http://localhost:8081' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY=dummy' >> ~/.zshrc
source ~/.zshrc
```

### Cursor IDE

1. Open Cursor Settings
2. Go to **Models** section
3. Set **Base URL**: `http://localhost:8081/v1`
4. Set **API Key**: `any-value`
5. Click **Save**

### Codex CLI

Edit `~/.codex/config.toml`:
```toml
model_provider = "lynkr"

[model_providers.lynkr]
base_url = "http://localhost:8081/v1"
wire_api = "responses"
```

---

## Alternative Installation Methods

### Homebrew (macOS/Linux)

```bash
brew tap fast-editor/lynkr
brew install lynkr
lynkr start
```

### Docker

```bash
git clone https://github.com/Fast-Editor/Lynkr.git
cd Lynkr
docker-compose up -d
```

Your `.env` file is in the repo root.

### From Source

```bash
git clone https://github.com/Fast-Editor/Lynkr.git
cd Lynkr
npm install
cp .env.example .env
npm start
```

Edit `.env` in the repo directory.

---

## Verify Installation

### 1. Check Lynkr is running

```bash
curl http://localhost:8081/health
```

Should return: `{"status":"healthy"}`

### 2. Test with Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy
claude "say hello"
```

Should get a response from your configured model.

### 3. Check logs

```bash
# If installed via npm
lynkr start

# Look for:
# [Ollama] Server ready, model "qwen2.5-coder:latest" available
# Claude→Databricks proxy listening on http://localhost:8081
```

---

## Troubleshooting Installation

### "command not found: lynkr"

NPM global bin directory not in PATH.

**Fix:**
```bash
# Find npm global bin path
npm config get prefix

# Add to PATH (example for /usr/local)
echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### "Error: Cannot find module 'pino'"

Dependencies not installed.

**Fix:**
```bash
npm install -g lynkr --force
```

### "EACCES: permission denied"

NPM doesn't have write permissions.

**Fix (macOS/Linux):**
```bash
sudo npm install -g lynkr
```

**Better fix (avoid sudo):**
```bash
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="~/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g lynkr
```

### "Port 8081 already in use"

Something else is using port 8081.

**Fix:** Edit `~/.lynkr/.env`
```bash
PORT=8082
```

Then update your tools to use `http://localhost:8082`

### Ollama connection refused

Ollama not running.

**Fix:**
```bash
# macOS/Linux - check if running
ps aux | grep ollama

# Start Ollama
ollama serve

# Or restart
pkill ollama && ollama serve
```

---

## Upgrading Lynkr

```bash
npm update -g lynkr
```

Or force reinstall:
```bash
npm uninstall -g lynkr
npm install -g lynkr
```

---

## Uninstall

```bash
npm uninstall -g lynkr
rm -rf ~/.lynkr
```

---

## Next Steps

- [Configuration Examples](README.md#configuration-examples)
- [Tier Routing Setup](README.md#advanced-tier-routing-save-even-more)
- [Provider Documentation](documentation/providers.md)
- [Troubleshooting Guide](documentation/troubleshooting.md)

---

**Need help?** [Open an issue](https://github.com/Fast-Editor/Lynkr/issues) or [ask in Discussions](https://github.com/Fast-Editor/Lynkr/discussions)
