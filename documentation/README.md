# Lynkr Documentation

Welcome to the comprehensive documentation for Lynkr, the self-hosted Claude Code proxy with multi-provider support.

---

## Getting Started

New to Lynkr? Start here:

- **[Installation Guide](installation.md)** - Complete installation instructions for all methods (npm, git clone, homebrew, Docker)
- **[Provider Configuration](providers.md)** - Detailed setup for all 9+ supported providers (Databricks, Bedrock, OpenRouter, Ollama, llama.cpp, Azure OpenAI, Azure Anthropic, OpenAI, LM Studio)
- **[Quick Start Examples](installation.md#quick-start-examples)** - Copy-paste configurations to get running fast

---

## IDE & CLI Integration

Connect Lynkr to your development tools:

- **[Claude Code CLI Setup](claude-code-cli.md)** - Configure Claude Code CLI to use Lynkr
- **[Codex CLI Setup](codex-cli.md)** - Configure OpenAI Codex CLI with Lynkr (config.toml, wire_api, troubleshooting)
- **[Cursor IDE Integration](cursor-integration.md)** - Full Cursor IDE setup with troubleshooting
- **[Embeddings Configuration](embeddings.md)** - Enable @Codebase semantic search with 4 provider options (Ollama, llama.cpp, OpenRouter, OpenAI)

---

## Core Features

Understand Lynkr's capabilities:

- **[Architecture & Features](features.md)** - System architecture, request flow, format conversion, and core capabilities
- **[Routing & Model Tiering](routing.md)** - 4-tier model system, 15-dimension complexity scoring, agentic workflow detection, and cost optimization
- **[Memory System](memory-system.md)** - Titans-inspired long-term memory with surprise-based filtering and decay
- **[Token Optimization](token-optimization.md)** - Achieve 60-80% cost reduction through smart tool selection, prompt caching, and memory deduplication
- **[Headroom Compression](headroom.md)** - 47-92% token reduction through intelligent context compression (Smart Crusher, CCR, LLMLingua)
- **[Tools & Execution Modes](tools.md)** - Tool calling, server vs client execution, custom tool integration, MCP support

---

## Deployment & Operations

Production deployment guides:

- **[Docker Deployment](docker.md)** - docker-compose setup with GPU support, volume management, and multi-service orchestration
- **[Production Hardening](production.md)** - Circuit breakers, load shedding, Prometheus metrics, health checks, and observability
- **[API Reference](api.md)** - Complete endpoint documentation, request/response formats, OpenAI compatibility layer

---

## Support & Development

Get help and contribute:

- **[Troubleshooting Guide](troubleshooting.md)** - Common issues and solutions for all providers
- **[FAQ](faq.md)** - Frequently asked questions about features, providers, and deployment
- **[Testing Guide](testing.md)** - Running tests, writing new tests, CI/CD integration
- **[Contributing Guide](contributing.md)** - How to contribute, code style, pull request process

---

## External Resources

- **[DeepWiki Documentation](https://deepwiki.com/vishalveerareddy123/Lynkr)** - AI-powered documentation search and Q&A
- **[GitHub Repository](https://github.com/vishalveerareddy123/Lynkr)** - Source code and issue tracker
- **[NPM Package](https://www.npmjs.com/package/lynkr)** - Official npm package
- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Community Q&A and feature discussions

---

## Quick Navigation by Topic

### Setup & Configuration
- [Installation](installation.md) | [Providers](providers.md) | [Claude Code](claude-code-cli.md) | [Codex CLI](codex-cli.md) | [Cursor](cursor-integration.md) | [Embeddings](embeddings.md)

### Features & Optimization
- [Features](features.md) | [Routing](routing.md) | [Memory System](memory-system.md) | [Token Optimization](token-optimization.md) | [Headroom](headroom.md) | [Tools](tools.md)

### Deployment & Production
- [Docker](docker.md) | [Production](production.md) | [API Reference](api.md)

### Help & Development
- [Troubleshooting](troubleshooting.md) | [FAQ](faq.md) | [Testing](testing.md) | [Contributing](contributing.md)

---

## Documentation Structure

This documentation is organized into focused guides:

1. **Getting Started** - Installation and basic configuration
2. **IDE & CLI Integration** - Connect to Claude Code, Codex CLI, and Cursor
3. **Core Features** - Deep dives into capabilities
4. **Deployment** - Production setup and operations
5. **Support** - Troubleshooting and community resources

Each guide is self-contained but cross-linked where relevant.

---

**Need help?** Check [Troubleshooting](troubleshooting.md) or visit [GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions).
