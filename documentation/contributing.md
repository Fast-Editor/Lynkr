# Contributing Guide

Thank you for your interest in contributing to Lynkr! This guide will help you get started.

---

## Ways to Contribute

### 1. Report Bugs

Found a bug? Please report it:

1. **Search [existing issues](https://github.com/Fast-Editor/Lynkr/issues)** first
2. **Create a new issue** with:
   - Lynkr version
   - Provider being used
   - Steps to reproduce
   - Expected vs actual behavior
   - Error messages and logs
   - Environment details (OS, Node version)

### 2. Suggest Features

Have an idea for a new feature?

1. **Search [GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions)** first
2. **Create a discussion** describing:
   - The problem you're solving
   - Proposed solution
   - Use cases
   - Alternatives considered

### 3. Improve Documentation

Documentation improvements are always welcome:

- Fix typos or unclear wording
- Add examples
- Expand explanations
- Add troubleshooting steps
- Translate documentation

### 4. Submit Code

Contributing code? Follow these steps:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/your-feature-name`
3. **Make your changes**
4. **Add tests** for new functionality
5. **Run tests**: `npm test`
6. **Commit with descriptive message**
7. **Push to your fork**
8. **Create a Pull Request**

---

## Development Setup

### Prerequisites

- **Node.js 18+**
- **npm** or **yarn**
- **Git**
- Optional: **Docker** for testing containerized deployment

### Clone and Install

```bash
# Fork the repo on GitHub first, then:
git clone https://github.com/YOUR_USERNAME/Lynkr.git
cd Lynkr

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your test credentials
nano .env
```

### Run in Development Mode

```bash
# Auto-restart on file changes
npm run dev

# Or normal mode
npm start
```

### Run Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test test/config.test.js

# Run with coverage
npm run test:coverage
```

---

## Code Style

### General Guidelines

- **Use modern JavaScript** (ES6+)
- **Follow existing code style** (2-space indentation)
- **Add comments** for complex logic
- **Write descriptive variable names**
- **Keep functions small and focused**

### File Organization

```
src/
├── api/               # Express routes and middleware
├── clients/           # Provider client implementations
├── config/            # Configuration loading and validation
├── orchestrator/      # Agent loop and tool execution
├── tools/             # Tool implementations
├── cache/             # Caching layer
├── observability/     # Metrics and logging
├── db/                # Database operations
└── mcp/               # Model Context Protocol integration
```

### Naming Conventions

- **Files**: `kebab-case.js` (e.g., `prompt-cache.js`)
- **Functions**: `camelCase` (e.g., `invokeModel()`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `DEFAULT_PORT`)
- **Classes**: `PascalCase` (e.g., `CircuitBreaker`)

---

## Testing Guidelines

### Writing Tests

Use Node.js built-in test runner:

```javascript
const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Feature name", () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  it("should do something specific", () => {
    // Arrange
    const input = "test";

    // Act
    const result = myFunction(input);

    // Assert
    assert.strictEqual(result, "expected");
  });
});
```

### Test Coverage

- **Aim for 80%+ coverage** for new code
- **Test edge cases** and error conditions
- **Mock external dependencies** (API calls, file system)
- **Test happy paths** and failure scenarios

### Running Tests

```bash
# All tests
npm test

# Specific file
npm test test/config.test.js

# With coverage
npm run test:coverage

# Watch mode (runs on file changes)
npm run test:watch
```

---

## Pull Request Process

### Before Submitting

1. **Ensure tests pass**: `npm test`
2. **Check code style**: Follow existing conventions
3. **Update documentation** if needed
4. **Add test coverage** for new features
5. **Rebase on latest main**: `git rebase origin/main`

### PR Template

When creating a pull request, include:

```markdown
## Description
Brief description of the changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Performance improvement
- [ ] Refactoring

## Changes Made
- Item 1
- Item 2

## Testing
- [ ] Existing tests pass
- [ ] Added new tests
- [ ] Manual testing performed

## Checklist
- [ ] Code follows style guidelines
- [ ] Documentation updated
- [ ] Tests added/updated
- [ ] No new warnings
```

### Review Process

1. **Maintainers will review** your PR
2. **Address feedback** if requested
3. **Make changes** in new commits
4. **Once approved**, maintainer will merge

---

## Adding a New Provider

To add support for a new LLM provider:

### 1. Update Configuration

**File**: `src/config/index.js`

```javascript
// Add to SUPPORTED_MODEL_PROVIDERS
const SUPPORTED_MODEL_PROVIDERS = new Set([
  "databricks", "azure-anthropic", "ollama",
  "openrouter", "azure-openai", "openai",
  "llamacpp", "lmstudio", "bedrock", "newprovider"  // Add here
]);

// Parse environment variables
const newProviderApiKey = process.env.NEW_PROVIDER_API_KEY?.trim() || null;
const newProviderEndpoint = process.env.NEW_PROVIDER_ENDPOINT?.trim() || "https://api.newprovider.com";

// Add validation
if (modelProvider === "newprovider" && !newProviderApiKey) {
  throw new Error("NEW_PROVIDER_API_KEY is required when MODEL_PROVIDER=newprovider");
}

// Export config
module.exports = {
  // ...
  newProvider: {
    apiKey: newProviderApiKey,
    endpoint: newProviderEndpoint,
  },
};
```

### 2. Implement Invocation Function

**File**: `src/clients/databricks.js`

```javascript
/**
 * Invoke new provider
 * @param {Object} body - Anthropic-format request body
 * @returns {Object} Response with json and actualProvider
 */
async function invokeNewProvider(body) {
  // 1. Validate configuration
  if (!config.newProvider?.apiKey) {
    throw new Error("NEW_PROVIDER_API_KEY is required");
  }

  // 2. Convert Anthropic format to provider format
  const providerRequest = convertAnthropicToNewProviderFormat(body);

  // 3. Make API request
  const response = await fetch(config.newProvider.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.newProvider.apiKey}`,
    },
    body: JSON.stringify(providerRequest),
  });

  if (!response.ok) {
    throw new Error(`Provider API error: ${response.statusText}`);
  }

  const data = await response.json();

  // 4. Convert provider format back to Anthropic format
  const anthropicResponse = convertNewProviderToAnthropicFormat(data);

  return {
    json: anthropicResponse,
    actualProvider: "newprovider",
  };
}

// Add to invokeModel switch
async function invokeModel(body, initialProvider) {
  // ...
  } else if (initialProvider === "newprovider") {
    return await invokeNewProvider(body);
  }
  // ...
}
```

### 3. Add Format Conversion

Create `src/clients/newprovider-utils.js`:

```javascript
/**
 * Convert Anthropic format to provider format
 */
function convertAnthropicToNewProviderFormat(body) {
  return {
    messages: convertMessages(body.messages),
    max_tokens: body.max_tokens || 4096,
    temperature: body.temperature || 0.7,
    // ... provider-specific fields
  };
}

/**
 * Convert provider format to Anthropic format
 */
function convertNewProviderToAnthropicFormat(response) {
  return {
    id: response.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: response.output || response.message || "",
      },
    ],
    model: response.model,
    stop_reason: "end_turn",
    usage: {
      input_tokens: response.usage?.input || 0,
      output_tokens: response.usage?.output || 0,
    },
  };
}

module.exports = {
  convertAnthropicToNewProviderFormat,
  convertNewProviderToAnthropicFormat,
};
```

### 4. Add Tests

**File**: `test/newprovider-integration.test.js`

```javascript
const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("New Provider Integration", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete require.cache[require.resolve("../src/config")];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should accept newprovider as MODEL_PROVIDER", () => {
    process.env.MODEL_PROVIDER = "newprovider";
    process.env.NEW_PROVIDER_API_KEY = "test-key";

    const config = require("../src/config");
    assert.strictEqual(config.modelProvider.type, "newprovider");
  });

  it("should throw error when API key is missing", () => {
    process.env.MODEL_PROVIDER = "newprovider";
    delete process.env.NEW_PROVIDER_API_KEY;

    assert.throws(
      () => require("../src/config"),
      /NEW_PROVIDER_API_KEY is required/
    );
  });

  // Add more tests...
});
```

### 5. Update Documentation

- Add provider to `documentation/providers.md`
- Add configuration example to `.env.example`
- Update README.md provider table
- Add quick start example

---

## Adding a New Tool

To add a new tool implementation:

### 1. Create Tool File

**File**: `src/tools/your-tool.js`

```javascript
const logger = require("../logger");

/**
 * Tool implementation
 * @param {Object} input - Tool input parameters
 * @param {Object} context - Execution context
 * @returns {Object} Tool result
 */
async function yourTool(input, context) {
  try {
    // Validate input
    if (!input.requiredParam) {
      throw new Error("requiredParam is required");
    }

    // Execute tool logic
    const result = await doSomething(input.requiredParam);

    // Return result
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    logger.error({ error, input }, "Tool execution failed");
    throw error;
  }
}

module.exports = {
  yourTool,
};
```

### 2. Register Tool

**File**: `src/tools/index.js`

```javascript
const { yourTool } = require("./your-tool");

const STANDARD_TOOLS = [
  // ... existing tools
  {
    name: "your_tool",
    description: "Description of what your tool does",
    input_schema: {
      type: "object",
      properties: {
        requiredParam: {
          type: "string",
          description: "Description of parameter",
        },
      },
      required: ["requiredParam"],
    },
  },
];

// Add to tool execution mapping
async function executeTool(toolName, toolInput, context) {
  switch (toolName) {
    // ... existing cases
    case "your_tool":
      return await yourTool(toolInput, context);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
```

### 3. Add Tests

**File**: `test/tools/your-tool.test.js`

```javascript
const assert = require("assert");
const { describe, it } = require("node:test");
const { yourTool } = require("../../src/tools/your-tool");

describe("Your Tool", () => {
  it("should execute successfully with valid input", async () => {
    const result = await yourTool(
      { requiredParam: "test" },
      { workspaceRoot: "/tmp" }
    );

    assert.strictEqual(result.success, true);
    assert.ok(result.data);
  });

  it("should throw error with invalid input", async () => {
    await assert.rejects(
      () => yourTool({}, {}),
      /requiredParam is required/
    );
  });
});
```

---

## Community Guidelines

### Code of Conduct

- **Be respectful** and inclusive
- **Welcome newcomers** and help them contribute
- **Provide constructive feedback**
- **Focus on the code**, not the person
- **Assume good intentions**

### Getting Help

- **[GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions)** - Ask questions
- **[Discord](https://discord.gg/qF7DDxrX)** - Real-time chat
- **[Issues](https://github.com/Fast-Editor/Lynkr/issues)** - Report bugs

---

## License

By contributing to Lynkr, you agree that your contributions will be licensed under the Apache 2.0 License.

---

Thank you for contributing to Lynkr! 🎉
