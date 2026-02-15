# Test Suite Documentation

All tests for the Lynkr project are consolidated in this `test/` directory.

## Test Files

### Unit Tests
**File**: `routing.test.js`
**Purpose**: Tests the hybrid routing logic in isolation
**Run**: `DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node --test test/routing.test.js`
**Coverage**: 10 tests
- Routing with tier-based routing disabled (no TIER_* vars set)
- Simple requests → Ollama
- Complex requests → Cloud
- Tool capability checks
- Fallback configuration

---

### Integration Tests
**File**: `hybrid-routing-integration.test.js`
**Purpose**: Tests configuration validation and metrics recording
**Run**: `node --test test/hybrid-routing-integration.test.js`
**Coverage**: 13 tests
- Configuration validation (5 tests)
- Metrics recording (6 tests)
- Helper functions (2 tests)

---

### Hybrid Routing Performance Tests
**File**: `hybrid-routing-performance.test.js`
**Purpose**: Measures performance overhead of hybrid routing
**Run**: `node test/hybrid-routing-performance.test.js`
**Key Metrics**:
- Routing decision: <0.01ms (36.8M decisions/sec)
- Metrics overhead: <0.01ms (43.6M ops/sec)
- Combined overhead: <0.02ms (15.6M ops/sec)

---

### System Performance Tests
**File**: `performance-tests.js`
**Purpose**: Tests system-wide performance optimizations
**Run**: `DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node test/performance-tests.js`
**Coverage**:
- Database indexes (100% complete)
- Persistent prompt cache
- Regex pattern caching (4.5x faster)
- Lazy loading
- HTTP connection pooling
- Response compression

---

### Middleware Benchmarks
**File**: `performance-benchmark.js`
**Purpose**: Benchmarks middleware overhead
**Run**: `DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node test/performance-benchmark.js`
**Coverage**:
- Metrics collection (3.4M ops/sec)
- Circuit breakers (3.9M ops/sec)
- Input validation (5.7M ops/sec)
- Load shedding
- Combined middleware stack

---

## Running All Tests

### Using npm scripts (Recommended)

**Run all tests (unit + performance):**
```bash
npm test
```

**Run only unit/integration tests:**
```bash
npm run test:unit
```

**Run only performance tests:**
```bash
npm run test:performance
```

**Run only benchmarks:**
```bash
npm run test:benchmark
```

**Run quick smoke test (routing only):**
```bash
npm run test:quick
```

**Run everything including benchmarks:**
```bash
npm run test:all
```

### Manual execution (if needed)

**Quick Test:**
Run all unit and integration tests:
```bash
DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node --test test/
```

**Full Test Suite:**
Run everything including performance tests:
```bash
# Unit + Integration tests
DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node --test test/routing.test.js
DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node --test test/hybrid-routing-integration.test.js

# Performance tests
node test/hybrid-routing-performance.test.js
DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node test/performance-tests.js
DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node test/performance-benchmark.js
```

---

## Test Organization

```
test/
├── README.md                              ← This file
├── routing.test.js                        ← Unit tests (10 tests)
├── hybrid-routing-integration.test.js     ← Integration tests (13 tests)
├── hybrid-routing-performance.test.js     ← Routing performance benchmarks
├── performance-tests.js                   ← System performance tests
└── performance-benchmark.js               ← Middleware benchmarks
```

---

## Important Notes

### Not Test Files
- `src/tests/` - This is **application code**, not tests! It provides test execution functionality as a feature.

### Environment Variables
Most tests require Databricks credentials (even though they're not used in actual API calls):
```bash
export DATABRICKS_API_KEY=test-key
export DATABRICKS_API_BASE=http://test.com
```

### Test Results Summary

| Test Type | Status | Count |
|-----------|--------|-------|
| Unit Tests | ✅ Passing | 10/10 |
| Integration Tests | ✅ Passing | 13/13 |
| Routing Performance | ✅ Complete | <0.02ms overhead |
| System Performance | ✅ Complete | 100% optimizations |
| Middleware Benchmarks | ✅ Complete | Acceptable overhead |

---

## CI/CD Integration

To run in CI/CD pipelines:

```bash
#!/bin/bash
set -e

# Run all tests using npm
echo "Running test suite..."
npm run test:all

echo "All tests passed!"
```

Or for a faster CI pipeline (skip benchmarks):

```bash
#!/bin/bash
set -e

echo "Running tests..."
npm test

echo "Tests passed!"
```

---

## Adding New Tests

When adding new tests, follow these conventions:

1. **Unit tests**: Test individual functions in isolation
   - Place in `test/`
   - Use `node:test` framework
   - Name: `feature-name.test.js`

2. **Integration tests**: Test multiple components together
   - Place in `test/`
   - Use `node:test` framework
   - Name: `feature-name-integration.test.js`

3. **Performance tests**: Benchmark specific features
   - Place in `test/`
   - Use custom benchmark utilities
   - Name: `feature-name-performance.test.js`

4. **Always**: Document in this README!
