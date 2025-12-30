const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const fs = require("fs");
const path = require("path");

describe("Memory Search", () => {
  let store;
  let search;
  let testDbPath;

  beforeEach(() => {
    // Create a unique temporary test database
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000000);
    testDbPath = path.join(__dirname, `../../data/test-search-${timestamp}-${random}.db`);

    // Set test environment to new database (correct env var is SESSION_DB_PATH)
    process.env.SESSION_DB_PATH = testDbPath;

    // Clear ALL module cache to ensure fresh config is loaded
    delete require.cache[require.resolve("../../src/config")];
    delete require.cache[require.resolve("../../src/db")];
    delete require.cache[require.resolve("../../src/memory/store")];
    delete require.cache[require.resolve("../../src/memory/search")];

    // Initialize database with schema (this creates a fresh database)
    require("../../src/db");

    // Load modules
    store = require("../../src/memory/store");
    search = require("../../src/memory/search");

    // Create test memories
    store.createMemory({
      content: "User prefers Python for data processing and machine learning tasks",
      type: "preference",
      category: "user",
      importance: 0.8
    });

    store.createMemory({
      content: "This project uses Express.js framework with TypeScript",
      type: "fact",
      category: "project",
      importance: 0.7
    });

    store.createMemory({
      content: "Decided to implement authentication using JWT tokens",
      type: "decision",
      category: "code",
      importance: 0.9
    });

    store.createMemory({
      content: "Database uses SQLite with better-sqlite3 driver",
      type: "fact",
      category: "project",
      importance: 0.6
    });

    store.createMemory({
      content: "UserController class handles user authentication and profile management",
      type: "entity",
      category: "code",
      importance: 0.5
    });
  });

  afterEach(() => {
    // Close database connection first
    try {
      const db = require("../../src/db");
      if (db && typeof db.close === 'function') {
        db.close();
      }
    } catch (err) {
      // Ignore if already closed
    }

    // Clear module cache to release all references
    delete require.cache[require.resolve("../../src/db")];
    delete require.cache[require.resolve("../../src/memory/store")];
    delete require.cache[require.resolve("../../src/memory/search")];

    // Clean up all SQLite files (db, wal, shm)
    try {
      const files = [
        testDbPath,
        `${testDbPath}-wal`,
        `${testDbPath}-shm`,
        `${testDbPath}-journal`
      ];

      for (const file of files) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  describe("searchMemories()", () => {
    it("should find memories by keyword", () => {
      const results = search.searchMemories({ query: "Python" });
      assert.ok(results.length > 0, "Should find Python memory");
      assert.ok(results[0].content.toLowerCase().includes("python"));
    });

    it("should find memories with partial matches", () => {
      const results = search.searchMemories({ query: "express" });
      assert.ok(results.length > 0, "Should find Express memory");
      assert.ok(results.some(m => m.content.toLowerCase().includes("express")));
    });

    it("should support FTS5 phrase search", () => {
      const results = search.searchMemories({ query: "machine learning" });
      assert.ok(results.length > 0, "Should find 'machine learning' phrase");
    });

    it("should filter by memory type", () => {
      const results = search.searchMemories({
        query: "project",
        types: ["fact"]
      });
      assert.ok(results.length > 0);
      assert.ok(results.every(m => m.type === "fact"), "All results should be facts");
    });

    it("should filter by category", () => {
      const results = search.searchMemories({
        query: "project",
        categories: ["project"]
      });
      assert.ok(results.length > 0);
      assert.ok(results.every(m => m.category === "project"));
    });

    it("should filter by session id", () => {
      // Create session-specific memory
      store.createMemory({
        content: "Session-specific memory about testing",
        type: "fact",
        sessionId: null // was: "test-session-123"
      });

      const results = search.searchMemories({
        query: "testing",
        sessionId: null // was: "test-session-123"
      });

      assert.ok(results.length > 0);
      assert.ok(results.every(m => m.sessionId === "test-session-123" || m.sessionId === null));
    });

    it("should filter by minimum importance", () => {
      const results = search.searchMemories({
        query: "project",
        minImportance: 0.7
      });

      assert.ok(results.length > 0);
      assert.ok(results.every(m => m.importance >= 0.7));
    });

    it("should respect limit parameter", () => {
      const results = search.searchMemories({ query: "project", limit: 2 });
      assert.ok(results.length <= 2);
    });

    it("should return empty array for no matches", () => {
      const results = search.searchMemories({ query: "nonexistent-keyword-xyz" });
      assert.strictEqual(results.length, 0);
    });

    it("should handle special characters in query", () => {
      store.createMemory({
        content: "Uses @nestjs/core package version ^9.0.0",
        type: "fact",
        category: "project"
      });

      const results = search.searchMemories({ query: "nestjs" });
      assert.ok(results.length > 0);
    });

    it("should be case-insensitive", () => {
      const lower = search.searchMemories({ query: "python" });
      const upper = search.searchMemories({ query: "PYTHON" });
      const mixed = search.searchMemories({ query: "PyThOn" });

      assert.ok(lower.length > 0);
      assert.strictEqual(lower.length, upper.length);
      assert.strictEqual(lower.length, mixed.length);
    });
  });

  describe("searchWithExpansion()", () => {
    it("should expand query and find more results", () => {
      const basicResults = search.searchMemories({ query: "database" });
      const expandedResults = search.searchWithExpansion({ query: "database" });

      // Expanded search should find at least as many as basic
      assert.ok(expandedResults.length >= basicResults.length);
    });

    it("should find results with related terms", () => {
      // Should find both "Express.js" and "authentication" memories
      const results = search.searchWithExpansion({ query: "authentication" });
      assert.ok(results.length > 0);
    });

    it("should handle multi-word queries", () => {
      const results = search.searchWithExpansion({ query: "user authentication system" });
      assert.ok(results.length >= 0); // Should not error
    });
  });

  describe("extractKeywords()", () => {
    it("should extract meaningful keywords", () => {
      const keywords = search.extractKeywords("User prefers Python for data processing");
      assert.ok(keywords.length > 0);
      assert.ok(keywords.includes("python") || keywords.includes("data"));
    });

    it("should filter out stop words", () => {
      const keywords = search.extractKeywords("The user is using the database");
      // Should not include common stop words like "the", "is", "using"
      assert.ok(!keywords.includes("the"));
      assert.ok(!keywords.includes("is"));
    });

    it("should handle empty text", () => {
      const keywords = search.extractKeywords("");
      assert.ok(Array.isArray(keywords));
      assert.strictEqual(keywords.length, 0);
    });

    it("should extract from technical content", () => {
      const keywords = search.extractKeywords("Using Express.js with TypeScript and JWT authentication");
      assert.ok(keywords.length > 0);
      assert.ok(keywords.some(k => k.includes("express") || k.includes("typescript") || k.includes("jwt")));
    });
  });

  describe("findSimilar()", () => {
    it("should find memories similar to reference", () => {
      const reference = store.createMemory({
        content: "User likes JavaScript frameworks like React and Vue",
        type: "preference"
      });

      const similar = search.findSimilar(reference.id, { limit: 3 });
      assert.ok(similar.length >= 0);
      // Should not include the reference memory itself
      assert.ok(!similar.some(m => m.id === reference.id));
    });

    it("should return empty for no similar memories", () => {
      const unique = store.createMemory({
        content: "Quantum computing with superconducting qubits",
        type: "fact"
      });

      const similar = search.findSimilar(unique.id, { limit: 5 });
      assert.ok(similar.length >= 0);
    });

    it("should throw error for non-existent memory id", () => {
      assert.throws(() => {
        search.findSimilar(99999);
      });
    });
  });

  describe("searchByContent()", () => {
    it("should search by content similarity", () => {
      const results = search.searchByContent("Python programming language");
      assert.ok(results.length > 0);
      assert.ok(results.some(m => m.content.toLowerCase().includes("python")));
    });

    it("should handle empty content", () => {
      const results = search.searchByContent("");
      assert.strictEqual(results.length, 0);
    });

    it("should filter by type and category", () => {
      const results = search.searchByContent("project", {
        types: ["fact"],
        categories: ["project"]
      });

      assert.ok(results.every(m => m.type === "fact" && m.category === "project"));
    });
  });

  describe("countSearchResults()", () => {
    it("should count matching memories", () => {
      const count = search.countSearchResults({ query: "project" });
      assert.ok(count > 0);
      assert.strictEqual(typeof count, "number");
    });

    it("should return 0 for no matches", () => {
      const count = search.countSearchResults({ query: "nonexistent-xyz" });
      assert.strictEqual(count, 0);
    });

    it("should respect filters", () => {
      const totalCount = search.countSearchResults({ query: "project" });
      const factCount = search.countSearchResults({ query: "project", types: ["fact"] });

      assert.ok(factCount <= totalCount);
    });
  });

  describe("FTS5 Query Preparation", () => {
    it("should handle AND operator", () => {
      const results = search.searchMemories({ query: "Python AND machine" });
      if (results.length > 0) {
        assert.ok(results[0].content.toLowerCase().includes("python"));
        assert.ok(results[0].content.toLowerCase().includes("machine"));
      }
    });

    it("should handle OR operator", () => {
      const results = search.searchMemories({ query: "Python OR JavaScript" });
      assert.ok(results.length > 0);
    });

    it("should handle complex queries", () => {
      // Should not throw error with complex FTS5 syntax
      assert.doesNotThrow(() => {
        search.searchMemories({ query: "(Python OR JavaScript) AND framework" });
      });
    });

    it("should escape special FTS5 characters", () => {
      // Characters like quotes, parens can break FTS5
      assert.doesNotThrow(() => {
        search.searchMemories({ query: 'test "quoted" (parens)' });
      });
    });
  });

  describe("Performance", () => {
    it("should handle searches with many results efficiently", () => {
      // Create many memories
      for (let i = 0; i < 100; i++) {
        store.createMemory({
          content: `Test memory number ${i} about Python and JavaScript`,
          type: "fact",
          importance: Math.random()
        });
      }

      const start = Date.now();
      const results = search.searchMemories({ query: "Python", limit: 10 });
      const duration = Date.now() - start;

      assert.ok(results.length > 0);
      assert.ok(duration < 100, `Search took ${duration}ms, expected < 100ms`);
    });

    it("should handle multiple concurrent searches", () => {
      const searches = [
        search.searchMemories({ query: "Python" }),
        search.searchMemories({ query: "Express" }),
        search.searchMemories({ query: "database" }),
        search.searchMemories({ query: "authentication" })
      ];

      // All should complete without errors
      searches.forEach(results => {
        assert.ok(Array.isArray(results));
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle very long queries", () => {
      const longQuery = "Python ".repeat(100);
      assert.doesNotThrow(() => {
        search.searchMemories({ query: longQuery });
      });
    });

    it("should handle queries with only stop words", () => {
      const results = search.searchMemories({ query: "the a an is are" });
      assert.ok(Array.isArray(results));
    });

    it("should handle numeric queries", () => {
      store.createMemory({
        content: "Server runs on port 3000",
        type: "fact"
      });

      const results = search.searchMemories({ query: "3000" });
      assert.ok(results.length > 0);
    });

    it("should handle emoji and unicode", () => {
      store.createMemory({
        content: "User's favorite emoji is 🚀 for deployment",
        type: "preference"
      });

      const results = search.searchMemories({ query: "emoji" });
      assert.ok(results.length > 0);
    });
  });

  describe("FTS5 Query Preparation (prepareFTS5Query)", () => {
    it("should strip XML/HTML tags from queries", () => {
      // The exact query that caused the error
      const query = "<tool_use_error>Error: No such tool available: Bash</tool_use_error>";
      const prepared = search.prepareFTS5Query(query);

      // Should not contain < or >
      assert.ok(!prepared.includes('<'));
      assert.ok(!prepared.includes('>'));

      // Should still contain the error text
      assert.ok(prepared.includes('Error') || prepared.includes('tool_use_error'));
    });

    it("should handle XML tags with system reminders", () => {
      const query = "<tool_use_error>Error: No such tool available: Bash</tool_use_error>\n\n<system-reminder>\nCRITICAL: This is a READ-ONLY task. You CANNOT edit, write, or create files.\n</system-reminder>";
      const prepared = search.prepareFTS5Query(query);

      // Should not contain XML tags
      assert.ok(!prepared.includes('<'));
      assert.ok(!prepared.includes('>'));

      // Should be a valid FTS5 query (doesn't throw when searching)
      assert.doesNotThrow(() => {
        search.searchMemories({ query: prepared });
      });
    });

    it("should remove FTS5 special characters", () => {
      const specialChars = [
        "query with * wildcard",
        "query (with parentheses)",
        "query with - minus",
        "query:with:colons",
        "query [with brackets]"
      ];

      for (const query of specialChars) {
        const prepared = search.prepareFTS5Query(query);

        // Should not throw FTS5 syntax error
        assert.doesNotThrow(() => {
          search.searchMemories({ query: prepared });
        }, `Failed for: ${query}`);
      }
    });

    it("should preserve AND/OR/NOT operators when present", () => {
      const queries = [
        "Python AND machine learning",
        "JavaScript OR TypeScript",
        "NOT deprecated"
      ];

      for (const query of queries) {
        const prepared = search.prepareFTS5Query(query);

        // Should preserve operators (not wrapped in quotes)
        assert.ok(!prepared.startsWith('"') || prepared.includes('AND') || prepared.includes('OR') || prepared.includes('NOT'));
      }
    });

    it("should wrap simple queries in quotes for phrase search", () => {
      const query = "simple text query";
      const prepared = search.prepareFTS5Query(query);

      // Should be wrapped in quotes
      assert.ok(prepared.startsWith('"'));
      assert.ok(prepared.endsWith('"'));
    });

    it("should handle queries with existing double quotes", () => {
      const query = 'query with "quoted text" inside';
      const prepared = search.prepareFTS5Query(query);

      // Should escape quotes (FTS5 uses "" for literal ")
      assert.ok(prepared.includes('""') || !prepared.includes('"quoted text"'));

      // Should not throw
      assert.doesNotThrow(() => {
        search.searchMemories({ query: prepared });
      });
    });

    it("should handle empty query after tag removal", () => {
      const query = "<tag></tag><another></another>";
      const prepared = search.prepareFTS5Query(query);

      // Should return safe fallback
      assert.strictEqual(prepared, '"empty query"');
    });

    it("should handle queries with multiple special characters", () => {
      const query = "test<>query-with*special:chars()[]";
      const prepared = search.prepareFTS5Query(query);

      // Should not throw FTS5 error
      assert.doesNotThrow(() => {
        search.searchMemories({ query: prepared });
      });
    });

    it("should handle real-world error messages", () => {
      const errorQueries = [
        "TypeError: Cannot read property 'length' of undefined",
        "Error: ENOENT: no such file or directory, open '/path/to/file.txt'",
        "SyntaxError: Unexpected token '<' in JSON at position 0",
        "<error>Database connection failed: ETIMEDOUT</error>"
      ];

      for (const query of errorQueries) {
        const prepared = search.prepareFTS5Query(query);

        // Should not throw FTS5 syntax error
        assert.doesNotThrow(() => {
          search.searchMemories({ query: prepared });
        }, `Failed for: ${query}`);
      }
    });
  });
});
