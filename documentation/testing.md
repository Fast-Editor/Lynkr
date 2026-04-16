# Testing Guide

Comprehensive guide to testing Lynkr, including unit tests, integration tests, and manual testing.

---

## Running Tests

### Quick Start

```bash
# Run all tests
npm test

# Run specific test file
npm test test/config.test.js

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

---

## Test Structure

Lynkr uses **Node.js built-in test runner** (no external dependencies):

```javascript
const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Feature Name", () => {
  beforeEach(() => {
    // Setup before each test
  });

  afterEach(() => {
    // Cleanup after each test
  });

  it("should do something specific", () => {
    // Test implementation
  });
});
```

---

## Test Categories

### 1. Unit Tests

Test individual functions and modules in isolation.

**Location**: `test/`

**Examples**:
- `test/config.test.js` - Configuration loading and validation
- `test/prompt-cache.test.js` - Prompt caching logic
- `test/circuit-breaker.test.js` - Circuit breaker state machine

**Running**:
```bash
npm test test/config.test.js
```

### 2. Integration Tests

Test integration between multiple components.

**Location**: `test/`

**Examples**:
- `test/databricks-integration.test.js` - Databricks provider
- `test/bedrock-integration.test.js` - AWS Bedrock provider
- `test/openrouter-integration.test.js` - OpenRouter provider
- `test/cursor-integration.test.js` - Cursor IDE compatibility

**Running**:
```bash
npm test test/databricks-integration.test.js
```

### 3. End-to-End Tests

Test complete request/response flows.

**Location**: `test/e2e/`

**Examples**:
- `test/e2e/claude-cli.test.js` - Claude Code CLI integration
- `test/e2e/cursor.test.js` - Cursor IDE integration
- `test/e2e/streaming.test.js` - Streaming responses

**Running**:
```bash
npm test test/e2e/
```

---

## Writing Tests

### Basic Test Structure

```javascript
const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Module Name", () => {
  let originalEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Clear module cache to get fresh config
    delete require.cache[require.resolve("../src/config")];
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  it("should handle valid input", () => {
    // Arrange
    const input = "test-input";

    // Act
    const result = myFunction(input);

    // Assert
    assert.strictEqual(result, "expected-output");
  });

  it("should throw error for invalid input", () => {
    // Assert that function throws
    assert.throws(
      () => myFunction(null),
      /Expected error message/
    );
  });
});
```

### Testing Async Functions

```javascript
it("should handle async operations", async () => {
  const result = await myAsyncFunction();
  assert.strictEqual(result.success, true);
});

it("should reject with error", async () => {
  await assert.rejects(
    () => myAsyncFunction("invalid"),
    /Expected error/
  );
});
```

### Testing Environment Variables

```javascript
it("should use environment variable", () => {
  process.env.MY_VARIABLE = "test-value";

  const config = require("../src/config");

  assert.strictEqual(config.myVariable, "test-value");
});
```

### Mocking External Dependencies

```javascript
// Simple mock
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  return {
    ok: true,
    json: async () => ({ data: "mocked" }),
  };
};

// Test code...

// Restore
global.fetch = originalFetch;
```

---

## Test Coverage

### Viewing Coverage

```bash
# Generate coverage report
npm run test:coverage

# View HTML report
open coverage/index.html
```

### Coverage Goals

- **Overall**: 80%+ coverage
- **Critical paths**: 90%+ coverage
- **Edge cases**: All error conditions tested
- **New code**: 100% coverage for new features

---

## Provider Testing

### Testing With Real Providers

To test with real provider APIs:

```bash
# Set real credentials
export MODEL_PROVIDER=databricks
export DATABRICKS_API_BASE=https://your-workspace.databricks.com
export DATABRICKS_API_KEY=your-real-key

# Run integration tests
npm test test/databricks-integration.test.js
```

**Note**: These tests make real API calls and may incur costs.

### Testing With Mock Providers

For local testing without API costs:

```javascript
beforeEach(() => {
  // Mock API responses
  global.fetch = async (url, options) => {
    if (url.includes("/invocations")) {
      return {
        ok: true,
        json: async () => ({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "mocked response" }],
          model: "claude-3-5-sonnet",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      };
    }
  };
});
```

---

## Manual Testing

### Testing Claude Code CLI

```bash
# Start Lynkr
npm start

# In another terminal, configure Claude CLI
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy

# Test basic query
claude "What is 2+2?"

# Test file operations
claude "List files in current directory"

# Test tool calling
claude "What changed in git?"
```

### Testing Cursor IDE

1. **Start Lynkr**: `npm start`

2. **Configure Cursor**:
   - Settings → Models → OpenAI API
   - API Key: `sk-lynkr`
   - Base URL: `http://localhost:8081/v1`
   - Model: `claude-3.5-sonnet`

3. **Test Chat**: `Cmd+L` / `Ctrl+L`
   - Enter: "Hello, can you see this?"
   - Should get response

4. **Test Inline Edits**: `Cmd+K` / `Ctrl+K`
   - Select code
   - Enter: "Add error handling"
   - Should modify code

5. **Test @Codebase**: (requires embeddings)
   - In chat: `@Codebase find authentication`
   - Should return relevant files

### Testing Health Endpoints

```bash
# Liveness probe
curl http://localhost:8081/health/live
# Expected: {"status":"ok"}

# Readiness probe
curl http://localhost:8081/health/ready
# Expected: {"status":"ready","checks":{"database":"ok","provider":"ok"}}

# Deep health check
curl "http://localhost:8081/health/ready?deep=true"
# Expected: Detailed health information
```

### Testing Embeddings

```bash
# Test embeddings endpoint
curl http://localhost:8081/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "input": "function to sort array",
    "model": "text-embedding-ada-002"
  }'

# Should return embedding vector
```

### Testing Metrics

```bash
# Get Prometheus metrics
curl http://localhost:8081/metrics

# Should return metrics like:
# lynkr_requests_total{provider="databricks",status="200"} 42
# lynkr_request_duration_seconds_sum 12.5
```

---

## Performance Testing

### Load Testing

Use tools like Apache Bench or k6:

```bash
# Simple load test with curl
for i in {1..100}; do
  curl -s http://localhost:8081/health/live > /dev/null &
done
wait

# Or use Apache Bench
ab -n 1000 -c 10 http://localhost:8081/health/live

# Or use k6
k6 run test/load/simple-load-test.js
```

### Stress Testing

```bash
# High concurrency
ab -n 10000 -c 100 http://localhost:8081/health/live

# Check metrics after
curl http://localhost:8081/metrics | grep lynkr_requests
```

---

## Debugging Tests

### Enable Debug Logging

```bash
# Run tests with debug output
LOG_LEVEL=debug npm test
```

### Run Single Test

```bash
# Run specific test file
npm test test/config.test.js

# Run only tests matching pattern
npm test -- --grep="should accept bedrock"
```

### Inspect Test Failures

```bash
# Run tests with verbose output
npm test -- --verbose

# Run tests with stack traces
npm test -- --trace-uncaught
```

---

## Continuous Integration

Lynkr uses GitHub Actions for CI:

**File**: `.github/workflows/test.yml`

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Generate coverage
        run: npm run test:coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

---

## Test Best Practices

### 1. Isolate Tests

- Each test should be independent
- Use `beforeEach`/`afterEach` for setup/cleanup
- Don't rely on test execution order

### 2. Clear Test Names

```javascript
// Good
it("should throw error when API key is missing", () => {});

// Bad
it("test config", () => {});
```

### 3. Arrange-Act-Assert Pattern

```javascript
it("should calculate total correctly", () => {
  // Arrange
  const items = [1, 2, 3];

  // Act
  const total = calculateTotal(items);

  // Assert
  assert.strictEqual(total, 6);
});
```

### 4. Test Edge Cases

```javascript
it("should handle empty array", () => {
  assert.strictEqual(calculateTotal([]), 0);
});

it("should handle null input", () => {
  assert.throws(() => calculateTotal(null));
});

it("should handle negative numbers", () => {
  assert.strictEqual(calculateTotal([-1, -2]), -3);
});
```

### 5. Mock External Dependencies

Don't make real API calls in unit tests:

```javascript
beforeEach(() => {
  // Mock fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: "mocked" }),
  });
});
```

---

## Common Test Scenarios

### Testing Configuration

```javascript
it("should accept bedrock as MODEL_PROVIDER", () => {
  process.env.MODEL_PROVIDER = "bedrock";
  process.env.AWS_BEDROCK_API_KEY = "test-key";

  const config = require("../src/config");

  assert.strictEqual(config.modelProvider.type, "bedrock");
});
```

### Testing Error Handling

```javascript
it("should throw error for invalid provider", () => {
  process.env.MODEL_PROVIDER = "invalid";

  assert.throws(
    () => require("../src/config"),
    /Unsupported MODEL_PROVIDER/
  );
});
```

### Testing Async Retries

```javascript
it("should retry on transient failure", async () => {
  let callCount = 0;

  global.fetch = async () => {
    callCount++;
    if (callCount < 3) {
      return { ok: false, status: 503 };
    }
    return { ok: true, json: async () => ({}) };
  };

  const result = await invokeWithRetry();

  assert.strictEqual(callCount, 3);
  assert.ok(result);
});
```

### Testing Circuit Breaker

```javascript
it("should open circuit after threshold failures", async () => {
  const breaker = new CircuitBreaker({ threshold: 3 });

  // Simulate 3 failures
  for (let i = 0; i < 3; i++) {
    await breaker.call(() => Promise.reject(new Error("fail")))
      .catch(() => {});
  }

  // Circuit should now be open
  assert.strictEqual(breaker.state, "open");
});
```

---

## Troubleshooting Tests

### Tests Hanging

```bash
# Set timeout
npm test -- --timeout 5000

# Or in test file
it("should complete quickly", { timeout: 1000 }, async () => {
  // Test code
});
```

### Tests Failing Intermittently

- Check for race conditions
- Add explicit waits for async operations
- Ensure tests don't depend on timing

### Module Cache Issues

```javascript
beforeEach(() => {
  // Clear module cache
  delete require.cache[require.resolve("../src/config")];
});
```

---

## Next Steps

- **[Contributing Guide](contributing.md)** - How to contribute
- **[Development Setup](contributing.md#development-setup)** - Set up dev environment
- **[GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)** - Report test failures

---

## Getting Help

- **[GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)** - Report bugs
