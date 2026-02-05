#!/usr/bin/env node

/**
 * Test script for deduplication functionality
 * Creates mock log entries and verifies deduplication works correctly
 */

const fs = require("fs");
const path = require("path");
const { ContentDeduplicator } = require("../src/logger/deduplicator");

// Test configuration
const TEST_DICT_PATH = path.join(process.cwd(), "logs", "test-dictionary.jsonl");
const TEST_LOG_PATH = path.join(process.cwd(), "logs", "test-audit.log");

// Clean up test files if they exist
function cleanup() {
  if (fs.existsSync(TEST_DICT_PATH)) {
    fs.unlinkSync(TEST_DICT_PATH);
  }
  if (fs.existsSync(TEST_LOG_PATH)) {
    fs.unlinkSync(TEST_LOG_PATH);
  }
}

// Test 1: Basic deduplication
function testBasicDeduplication() {
  console.log("\n=== Test 1: Basic Deduplication ===");

  const deduplicator = new ContentDeduplicator(TEST_DICT_PATH, {
    minSize: 50, // Lower threshold for testing
    cacheSize: 10,
  });

  const content1 = "This is a test content that is longer than 50 characters and should be deduplicated.";
  const content2 = "This is a test content that is longer than 50 characters and should be deduplicated.";
  const content3 = "Short";

  // First content should be stored
  const ref1 = deduplicator.storeContent(content1);
  console.log("✓ Stored content1:", ref1);

  // Second identical content should return same reference
  const ref2 = deduplicator.storeContent(content2);
  console.log("✓ Stored content2 (should be same hash):", ref2);

  // Verify same hash
  if (ref1.$ref !== ref2.$ref) {
    console.error("✗ FAIL: Different hashes for identical content!");
    return false;
  }
  console.log("✓ PASS: Identical content produces same hash");

  // Short content should not be deduplicated (below threshold)
  const shouldNotDedup = deduplicator.shouldDeduplicate(content3, 50);
  if (shouldNotDedup) {
    console.error("✗ FAIL: Short content should not be deduplicated!");
    return false;
  }
  console.log("✓ PASS: Short content not deduplicated");

  return true;
}

// Test 2: Content restoration
function testContentRestoration() {
  console.log("\n=== Test 2: Content Restoration ===");

  const deduplicator = new ContentDeduplicator(TEST_DICT_PATH, {
    minSize: 50,
    cacheSize: 10,
  });

  const originalContent = "This is original content that needs to be restored from the dictionary file.";

  // Store and get reference
  const ref = deduplicator.storeContent(originalContent);
  console.log("✓ Stored content with ref:", ref.$ref);

  // Retrieve content
  const retrieved = deduplicator.getContent(ref.$ref);
  console.log("✓ Retrieved content length:", retrieved?.length);

  // Verify content matches
  if (retrieved !== originalContent) {
    console.error("✗ FAIL: Retrieved content doesn't match original!");
    console.error("Expected:", originalContent);
    console.error("Got:", retrieved);
    return false;
  }
  console.log("✓ PASS: Content restored correctly");

  return true;
}

// Test 3: Entry deduplication and restoration
function testEntryProcessing() {
  console.log("\n=== Test 3: Entry Deduplication and Restoration ===");

  const deduplicator = new ContentDeduplicator(TEST_DICT_PATH, {
    minSize: 50,
    cacheSize: 10,
  });

  const systemPrompt = "You are a helpful AI assistant. This is a long system prompt that should be deduplicated.";
  const userMessage = "This is a user message that is long enough to be deduplicated by the deduplication system.";

  const entry = {
    type: "llm_request",
    correlationId: "test-123",
    systemPrompt: systemPrompt,
    userMessages: userMessage,
    model: "test-model",
  };

  // Deduplicate entry
  const deduplicated = deduplicator.deduplicateEntry(entry, ["systemPrompt", "userMessages"]);
  console.log("✓ Deduplicated entry:", JSON.stringify(deduplicated, null, 2));

  // Verify fields are now references
  if (typeof deduplicated.systemPrompt !== "object" || !deduplicated.systemPrompt.$ref) {
    console.error("✗ FAIL: systemPrompt was not deduplicated!");
    return false;
  }
  if (typeof deduplicated.userMessages !== "object" || !deduplicated.userMessages.$ref) {
    console.error("✗ FAIL: userMessages was not deduplicated!");
    return false;
  }
  console.log("✓ PASS: Fields converted to references");

  // Restore entry
  const restored = deduplicator.restoreEntry(deduplicated);
  console.log("✓ Restored entry keys:", Object.keys(restored));

  // Verify restoration
  if (restored.systemPrompt !== systemPrompt) {
    console.error("✗ FAIL: systemPrompt not restored correctly!");
    console.error("Expected:", systemPrompt);
    console.error("Got:", restored.systemPrompt);
    return false;
  }
  if (restored.userMessages !== userMessage) {
    console.error("✗ FAIL: userMessages not restored correctly!");
    console.error("Expected:", userMessage);
    console.error("Got:", restored.userMessages);
    return false;
  }
  console.log("✓ PASS: Entry restored correctly");

  return true;
}

// Test 4: Dictionary persistence
function testDictionaryPersistence() {
  console.log("\n=== Test 4: Dictionary Persistence ===");

  // Create first deduplicator and store content
  const deduplicator1 = new ContentDeduplicator(TEST_DICT_PATH, {
    minSize: 50,
    cacheSize: 10,
  });

  const content = "This is test content for persistence verification across deduplicator instances.";
  const ref = deduplicator1.storeContent(content);
  console.log("✓ Stored content with first deduplicator:", ref.$ref);

  // Wait for async write to complete
  setTimeout(() => {
    // Create second deduplicator (should load from dictionary)
    const deduplicator2 = new ContentDeduplicator(TEST_DICT_PATH, {
      minSize: 50,
      cacheSize: 10,
    });

    // Try to retrieve with second deduplicator
    const retrieved = deduplicator2.getContent(ref.$ref);

    if (retrieved !== content) {
      console.error("✗ FAIL: Content not persisted to dictionary!");
      console.error("Expected:", content);
      console.error("Got:", retrieved);
      return false;
    }
    console.log("✓ PASS: Dictionary persisted and loaded correctly");

    // Show dictionary stats
    const stats = deduplicator2.getStats();
    console.log("\nDeduplication Stats:");
    console.log(`  Cache size: ${stats.cacheSize}`);
    console.log(`  Unique blocks: ${stats.uniqueContentBlocks}`);
    console.log(`  Total references: ${stats.totalReferences}`);

    return true;
  }, 100);
}

// Test 5: Size calculation and verification
function testSizeCalculation() {
  console.log("\n=== Test 5: Size Calculation ===");

  const deduplicator = new ContentDeduplicator(TEST_DICT_PATH, {
    minSize: 50,
    cacheSize: 10,
  });

  const content = "This is a test content string that will be deduplicated and have its size calculated.";
  const ref = deduplicator.storeContent(content);

  console.log("✓ Content length:", content.length);
  console.log("✓ Reference size field:", ref.size);

  if (ref.size !== content.length) {
    console.error("✗ FAIL: Size mismatch!");
    return false;
  }
  console.log("✓ PASS: Size calculated correctly");

  // Calculate space saved
  const refSize = JSON.stringify(ref).length;
  const originalSize = content.length;
  const saved = originalSize - refSize;
  const savedPercent = ((saved / originalSize) * 100).toFixed(1);

  console.log(`\nSpace saved: ${saved} bytes (${savedPercent}%)`);
  console.log(`  Original: ${originalSize} bytes`);
  console.log(`  Reference: ${refSize} bytes`);

  return true;
}

// Test 6: Content sanitization (empty User: entries removal)
function testContentSanitization() {
  console.log("\n=== Test 6: Content Sanitization (Empty User: Removal) ===");

  const deduplicator = new ContentDeduplicator(TEST_DICT_PATH, {
    minSize: 50,
    cacheSize: 10,
    sanitize: true, // Enable sanitization
  });

  // Content with multiple empty "User:" entries
  const dirtyContent = `Claude: I'll implement...

User:

Claude: Now I'll implement...

User:

User:

User:

Respond with the title for the conversation and nothing else.`;

  console.log("✓ Original content length:", dirtyContent.length);
  console.log("✓ Empty 'User:' entries in original:", (dirtyContent.match(/User:\s*\n/g) || []).length);

  // Store the content (should be sanitized internally)
  const ref = deduplicator.storeContent(dirtyContent);
  console.log("✓ Stored content with ref:", ref.$ref);

  // Retrieve it back
  const retrieved = deduplicator.getContent(ref.$ref);
  console.log("✓ Retrieved content length:", retrieved?.length);

  // Count empty "User:" entries in retrieved content
  // Pattern: "User:" followed by newline(s) and then "Claude:" or another "User:" or end
  const emptyUserMatches = retrieved.match(/User:\s*\n+(?=(Claude:|User:|$))/g) || [];
  console.log("✓ Empty 'User:' entries in retrieved:", emptyUserMatches.length);

  // Verify empty User: entries were removed
  if (emptyUserMatches.length > 0) {
    console.error("✗ FAIL: Empty User: entries not removed!");
    console.error("Retrieved content:", retrieved);
    return false;
  }

  // Verify content still contains Claude: entries
  if (!retrieved.includes("Claude:")) {
    console.error("✗ FAIL: Claude: entries were incorrectly removed!");
    return false;
  }

  // Verify the last line is preserved
  if (!retrieved.includes("Respond with the title")) {
    console.error("✗ FAIL: Content was over-sanitized!");
    return false;
  }

  console.log("✓ PASS: Empty User: entries removed, content preserved");

  // Test with sanitization disabled
  const dedupNoSanitize = new ContentDeduplicator(TEST_DICT_PATH, {
    minSize: 50,
    cacheSize: 10,
    sanitize: false, // Disable sanitization
  });

  const refNoSanitize = dedupNoSanitize.storeContent(dirtyContent);
  const retrievedNoSanitize = dedupNoSanitize.getContent(refNoSanitize.$ref);

  // Should have empty User: entries when sanitization is disabled
  const emptyUserNoSanitize = retrievedNoSanitize.match(/User:\s*\n+(?=(Claude:|User:|$))/g) || [];
  if (emptyUserNoSanitize.length === 0) {
    console.error("✗ FAIL: Content was sanitized even with sanitize=false!");
    return false;
  }

  console.log("✓ PASS: Sanitization can be disabled");

  return true;
}

// Test 7: Content sanitization preserves non-empty User: entries
function testSanitizationPreservesContent() {
  console.log("\n=== Test 7: Sanitization Preserves Non-Empty User: Entries ===");

  const deduplicator = new ContentDeduplicator(TEST_DICT_PATH, {
    minSize: 50,
    cacheSize: 10,
    sanitize: true,
  });

  // Content with both empty and non-empty User: entries
  const mixedContent = `Claude: I'll help you.

User: Can you explain this?

Claude: Sure, here's the explanation.

User:

User: Another question here.

Claude: Here's the answer.`;

  console.log("✓ Original has both empty and non-empty User: entries");

  const ref = deduplicator.storeContent(mixedContent);
  const retrieved = deduplicator.getContent(ref.$ref);

  // Check that non-empty User: entries are preserved
  if (!retrieved.includes("User: Can you explain this?")) {
    console.error("✗ FAIL: Non-empty User: entry was removed!");
    return false;
  }

  if (!retrieved.includes("User: Another question here.")) {
    console.error("✗ FAIL: Non-empty User: entry was removed!");
    return false;
  }

  // Check that empty User: entries are removed
  const lines = retrieved.split('\n');
  let hasEmptyUser = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === 'User:' || line === 'User: ') {
      const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
      if (nextLine === '' || nextLine === 'Claude:' || nextLine === 'User:') {
        hasEmptyUser = true;
        break;
      }
    }
  }

  if (hasEmptyUser) {
    console.error("✗ FAIL: Empty User: entries not removed from mixed content!");
    return false;
  }

  console.log("✓ PASS: Non-empty User: entries preserved, empty ones removed");

  return true;
}

// Main test runner
async function runTests() {
  console.log("=".repeat(60));
  console.log("LLM Audit Log Deduplication Test Suite");
  console.log("=".repeat(60));

  // Clean up before tests
  cleanup();

  const tests = [
    testBasicDeduplication,
    testContentRestoration,
    testEntryProcessing,
    testSizeCalculation,
    testContentSanitization,
    testSanitizationPreservesContent,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = test();
      if (result) {
        passed++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`✗ Test failed with error: ${err.message}`);
      console.error(err.stack);
      failed++;
    }
  }

  // Run async test separately
  setTimeout(() => {
    testDictionaryPersistence();

    console.log("\n" + "=".repeat(60));
    console.log("Test Results");
    console.log("=".repeat(60));
    console.log(`Passed: ${passed}/${passed + failed}`);
    console.log(`Failed: ${failed}/${passed + failed}`);

    if (failed === 0) {
      console.log("\n✓ All tests passed!");
      console.log("\nDictionary file created at:", TEST_DICT_PATH);
      console.log("You can inspect it with: cat", TEST_DICT_PATH);
    } else {
      console.log("\n✗ Some tests failed!");
      process.exit(1);
    }

    // Clean up after tests
    console.log("\nCleaning up test files...");
    cleanup();
    console.log("✓ Test files removed");
  }, 200);
}

// Run tests
if (require.main === module) {
  runTests().catch((err) => {
    console.error("Test suite failed:", err);
    process.exit(1);
  });
}

module.exports = { runTests };
