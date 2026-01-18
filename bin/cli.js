#!/usr/bin/env node

const args = process.argv.slice(2);

// Handle --help and --version before loading server (avoids credential validation)
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Lynkr - Self-hosted Claude Code & Cursor proxy

Usage: lynkr [options]

Options:
  --help, -h     Show this help message
  --version, -v  Show version number

Supported Providers:
  databricks, azure-anthropic, ollama, openrouter, azure-openai,
  openai, llamacpp, lmstudio, bedrock

Environment Variables (vary by provider):
  MODEL_PROVIDER              Provider to use (default: databricks)
  DATABRICKS_API_BASE         Databricks workspace URL
  DATABRICKS_API_KEY          Databricks API token
  AZURE_ANTHROPIC_ENDPOINT    Azure Anthropic endpoint
  AZURE_ANTHROPIC_API_KEY     Azure Anthropic API key
  OLLAMA_ENDPOINT             Ollama server URL (default: http://localhost:11434)
  OPENAI_API_KEY              OpenAI API key
  PORT                        Server port (default: 8080)
  LOG_LEVEL                   Logging level (default: info)
  LOG_PRETTY                  Enable pretty-printed logs (requires pino-pretty)

For full documentation, see: https://github.com/vishalveerareddy123/Lynkr
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = require("../package.json");
  console.log(pkg.version);
  process.exit(0);
}

// Now load and start the server (triggers credential validation)
require("../index.js");
