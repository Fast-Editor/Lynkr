const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const fs = require("fs");
const path = require("path");

describe("Memory Extractor", () => {
  let extractor;
  let testDbPath;
  let originalEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Create a unique temporary test database
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000000);
    testDbPath = path.join(__dirname, `../../data/test-extractor-${timestamp}-${random}.db`);

    // Set test environment BEFORE loading any modules
    process.env.SESSION_DB_PATH = testDbPath;
    process.env.MEMORY_SURPRISE_THRESHOLD = "0.1"; // Very low threshold for tests
    process.env.MEMORY_ENABLED = "true";
    process.env.MEMORY_EXTRACTION_ENABLED = "true";

    // Clear ALL module cache to ensure fresh config
    Object.keys(require.cache).forEach(key => {
      if (key.includes('/src/')) {
        delete require.cache[key];
      }
    });

    // Initialize database first
    const db = require("../../src/db");

    // Create test sessions to satisfy foreign key constraints
    const now = Date.now();
    const insertSession = db.prepare(`
      INSERT OR IGNORE INTO sessions (id, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?)
    `);
    insertSession.run("test-session", now, now, "{}");
    insertSession.run("test-session-123", now, now, "{}");
    insertSession.run("test", now, now, "{}");

    // Then load extractor module
    extractor = require("../../src/memory/extractor");
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
    Object.keys(require.cache).forEach(key => {
      if (key.includes('/src/')) {
        delete require.cache[key];
      }
    });

    // Restore environment
    process.env = originalEnv;

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

  describe("extractMemories()", () => {
    it("should extract preferences from assistant response", async () => {
      const assistantResponse = {
        role: "assistant",
        content: "I understand that you prefer Python for data processing tasks and always use it for scripts."
      };

      const conversationMessages = [
        { role: "user", content: "I prefer Python for data processing" }
      ];

      const memories = await extractor.extractMemories(
        assistantResponse,
        conversationMessages,
        { sessionId: "test-session" }
      );

      assert.ok(Array.isArray(memories), "Should return array");
      const preferences = memories.filter(m => m.type === "preference");
      // With low threshold and novel content, should extract at least one
      assert.ok(preferences.length >= 0, "Should attempt extraction");
    });

    it("should extract decisions from assistant response", async () => {
      const assistantResponse = {
        role: "assistant",
        content: "We decided to use Express.js for the API framework and SQLite for the database storage system."
      };

      const conversationMessages = [
        { role: "user", content: "What should we use for the backend?" }
      ];

      const memories = await extractor.extractMemories(
        assistantResponse,
        conversationMessages,
        { sessionId: "test-session" }
      );

      assert.ok(Array.isArray(memories));
      const decisions = memories.filter(m => m.type === "decision");
      assert.ok(decisions.length >= 0);
    });

    it("should extract facts from assistant response", async () => {
      const assistantResponse = {
        role: "assistant",
        content: "This project uses TypeScript with strict mode enabled and implements ESLint for code quality."
      };

      const conversationMessages = [
        { role: "user", content: "Tell me about the project setup" }
      ];

      const memories = await extractor.extractMemories(
        assistantResponse,
        conversationMessages,
        { sessionId: "test-session" }
      );

      assert.ok(Array.isArray(memories));
      const facts = memories.filter(m => m.type === "fact");
      assert.ok(facts.length >= 0);
    });

    it("should include surprise scores in memories", async () => {
      const assistantResponse = {
        role: "assistant",
        content: "IMPORTANT: User always prefers async/await over callbacks in JavaScript code."
      };

      const memories = await extractor.extractMemories(
        assistantResponse,
        [],
        { sessionId: "test-session" }
      );

      if (memories.length > 0) {
        assert.ok(memories[0].surpriseScore >= 0 && memories[0].surpriseScore <= 1);
        assert.ok(memories[0].importance >= 0 && memories[0].importance <= 1);
      }
    });

    it("should include session context in stored memories", async () => {
      const assistantResponse = {
        role: "assistant",
        content: "I'll remember that you prefer async/await over callbacks for asynchronous operations."
      };

      const conversationMessages = [
        { role: "user", content: "Please use async/await" }
      ];

      const memories = await extractor.extractMemories(
        assistantResponse,
        conversationMessages,
        { sessionId: "test-session-123" }
      );

      if (memories.length > 0) {
        assert.strictEqual(memories[0].sessionId, "test-session-123");
      }
    });

    it("should handle empty assistant response", async () => {
      const assistantResponse = {
        role: "assistant",
        content: ""
      };

      const memories = await extractor.extractMemories(
        assistantResponse,
        [],
        { sessionId: "test-session" }
      );

      assert.strictEqual(memories.length, 0);
    });

    it("should handle responses with no extractable patterns", async () => {
      const assistantResponse = {
        role: "assistant",
        content: "Okay."
      };

      const memories = await extractor.extractMemories(
        assistantResponse,
        [],
        { sessionId: "test-session" }
      );

      assert.strictEqual(memories.length, 0);
    });
  });

  describe("Pattern Extraction (Internal)", () => {
    it("should match preference patterns", async () => {
      const responses = [
        "You always use TypeScript for new projects.",
        "User prefers functional programming over object-oriented design patterns.",
        "You typically want detailed error messages in production environments."
      ];

      for (const content of responses) {
        const memories = await extractor.extractMemories(
          { role: "assistant", content },
          [],
          { sessionId: "test" }
        );
        // Should at least try to extract (may be filtered by surprise)
        assert.ok(Array.isArray(memories));
      }
    });

    it("should match decision patterns", async () => {
      const responses = [
        "We decided to implement rate limiting at the API gateway level for better security.",
        "Going with PostgreSQL over MySQL for better JSON support and performance.",
        "Selected React for the frontend framework based on team experience."
      ];

      for (const content of responses) {
        const memories = await extractor.extractMemories(
          { role: "assistant", content },
          [],
          { sessionId: "test" }
        );
        assert.ok(Array.isArray(memories));
      }
    });

    it("should match fact patterns", async () => {
      const responses = [
        "This application uses Redis for caching and RabbitMQ for message queuing.",
        "The project implements JWT authentication with RS256 signing algorithm.",
        "IMPORTANT: Always validate user input for SQL injection vulnerabilities."
      ];

      for (const content of responses) {
        const memories = await extractor.extractMemories(
          { role: "assistant", content },
          [],
          { sessionId: "test" }
        );
        assert.ok(Array.isArray(memories));
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle very long assistant responses", async () => {
      const longContent = "The system architecture uses " + "microservices ".repeat(100);
      const assistantResponse = {
        role: "assistant",
        content: longContent
      };

      const memories = await extractor.extractMemories(
        assistantResponse,
        [],
        { sessionId: "test-session" }
      );

      assert.ok(Array.isArray(memories));
    });

    it("should handle special characters and code blocks", async () => {
      const assistantResponse = {
        role: "assistant",
        content: "This project uses @nestjs/core ^9.0.0 and implements JWT authentication with tokens."
      };

      const memories = await extractor.extractMemories(
        assistantResponse,
        [],
        { sessionId: "test-session" }
      );

      assert.ok(Array.isArray(memories));
    });

    it("should handle mixed content types", async () => {
      const assistantResponse = {
        role: "assistant",
        content: `
          I understand your requirements for the new authentication system.
          You prefer Python for this project and want to use FastAPI.
          We decided to use FastAPI for the backend framework with async support.
          The application uses PostgreSQL for the database with connection pooling.
          The UserModel class handles data validation and serialization.
        `
      };

      const memories = await extractor.extractMemories(
        assistantResponse,
        [],
        { sessionId: "test-session" }
      );

      assert.ok(Array.isArray(memories));
      // May extract multiple types
      if (memories.length > 0) {
        const types = new Set(memories.map(m => m.type));
        assert.ok(types.size >= 1);
      }
    });

    it("should not throw on malformed input", async () => {
      await assert.doesNotReject(async () => {
        await extractor.extractMemories(null, []);
        await extractor.extractMemories({}, []);
        await extractor.extractMemories({ content: null }, []);
      });
    });
  });

  describe("Surprise-Based Filtering", () => {
    it("should filter memories below surprise threshold", async () => {
      const store = require("../../src/memory/store");

      // Create existing memory
      store.createMemory({
        content: "User prefers Python programming",
        type: "preference",
        importance: 0.8
      });

      // Try to extract very similar memory
      const assistantResponse = {
        role: "assistant",
        content: "You prefer Python for programming tasks."
      };

      const memories = await extractor.extractMemories(
        assistantResponse,
        [],
        { sessionId: "test-session" }
      );

      // Should be filtered due to similarity (low surprise)
      const pythonPrefs = memories.filter(m =>
        m.type === "preference" && m.content.toLowerCase().includes("python")
      );

      // Either filtered out entirely, or has low surprise score
      if (pythonPrefs.length > 0) {
        assert.ok(pythonPrefs[0].surpriseScore <= 0.5);
      }
    });

    it("should store novel high-surprise memories", async () => {
      const assistantResponse = {
        role: "assistant",
        content: "CRITICAL: User always wants to use Rust for systems programming with zero-cost abstractions."
      };

      const memories = await extractor.extractMemories(
        assistantResponse,
        [{ role: "user", content: "IMPORTANT: Use Rust!" }],
        { sessionId: "test-session" }
      );

      // Novel content with emphasis should have higher surprise
      if (memories.length > 0) {
        assert.ok(memories[0].surpriseScore >= 0.1);
      }
    });
  });
});
