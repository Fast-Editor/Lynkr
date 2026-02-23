const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Mock configuration
process.env.NODE_ENV = "test";
process.env.MODEL_PROVIDER = "databricks";
process.env.DATABRICKS_API_KEY = "test-key";
process.env.DATABRICKS_API_BASE = "http://test.com";

// Create a temporary workspace for testing
const testWorkspaceRoot = path.join(os.tmpdir(), `lynkr-test-edit-${Date.now()}`);
fs.mkdirSync(testWorkspaceRoot, { recursive: true });
process.env.WORKSPACE_ROOT = testWorkspaceRoot;

const { executeToolCall } = require("../src/tools");
require("../src/tools/workspace").registerWorkspaceTools();

describe("Edit Tools Tests", () => {
  let testFilePath;

  before(() => {
    // Create test file
    testFilePath = "test-file.txt";
    const fullPath = path.join(testWorkspaceRoot, testFilePath);
    fs.writeFileSync(
      fullPath,
      "Hello World\nThis is a test\nHello again\nEnd of file"
    );
  });

  after(() => {
    // Clean up
    try {
      fs.rmSync(testWorkspaceRoot, { recursive: true, force: true });
    } catch (err) {
      console.error("Failed to clean up test workspace:", err);
    }
  });

  describe("Edit tool (string replacement)", () => {
    it("should replace a unique string", async () => {
      const result = await executeToolCall({
        function: {
          name: "Edit",
          arguments: JSON.stringify({
            file_path: testFilePath,
            old_string: "This is a test",
            new_string: "This is modified",
          }),
        },
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 200);

      // Verify file content
      const content = fs.readFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "utf8"
      );
      assert.strictEqual(
        content,
        "Hello World\nThis is modified\nHello again\nEnd of file"
      );

      // Restore for next test
      fs.writeFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "Hello World\nThis is a test\nHello again\nEnd of file"
      );
    });

    it("should fail when old_string is not unique (without replace_all)", async () => {
      const result = await executeToolCall({
        function: {
          name: "Edit",
          arguments: JSON.stringify({
            file_path: testFilePath,
            old_string: "Hello",
            new_string: "Hi",
          }),
        },
      });

      assert.strictEqual(result.ok, false);
      assert.match(
        result.content,
        /appears multiple times|not unique/i
      );
    });

    it("should replace all occurrences with replace_all=true", async () => {
      const result = await executeToolCall({
        function: {
          name: "Edit",
          arguments: JSON.stringify({
            file_path: testFilePath,
            old_string: "Hello",
            new_string: "Hi",
            replace_all: true,
          }),
        },
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 200);

      // Verify file content
      const content = fs.readFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "utf8"
      );
      assert.strictEqual(
        content,
        "Hi World\nThis is a test\nHi again\nEnd of file"
      );

      // Restore for next test
      fs.writeFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "Hello World\nThis is a test\nHello again\nEnd of file"
      );
    });

    it("should fail when old_string is not found", async () => {
      const result = await executeToolCall({
        function: {
          name: "Edit",
          arguments: JSON.stringify({
            file_path: testFilePath,
            old_string: "NonexistentString",
            new_string: "Something",
          }),
        },
      });

      assert.strictEqual(result.ok, false);
      assert.match(result.content, /not found/i);
    });

    it("should fail when editing non-existent file", async () => {
      const result = await executeToolCall({
        function: {
          name: "Edit",
          arguments: JSON.stringify({
            file_path: "nonexistent.txt",
            old_string: "test",
            new_string: "modified",
          }),
        },
      });

      assert.strictEqual(result.ok, false);
      assert.match(result.content, /non-existent file/i);
    });

    it("should fail when old_string equals new_string", async () => {
      const result = await executeToolCall({
        function: {
          name: "Edit",
          arguments: JSON.stringify({
            file_path: testFilePath,
            old_string: "Hello",
            new_string: "Hello",
          }),
        },
      });

      assert.strictEqual(result.ok, false);
      assert.match(result.content, /must be different/i);
    });
  });

  describe("edit_patch tool (unified diff)", () => {
    before(() => {
      // Reset file for patch tests
      fs.writeFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "Hello World\nThis is a test\nHello again\nEnd of file"
      );
    });

    it("should apply a valid unified diff patch", async () => {
      const patch = `--- test-file.txt
+++ test-file.txt
@@ -1,4 +1,4 @@
 Hello World
-This is a test
+This is PATCHED
 Hello again
 End of file`;

      const result = await executeToolCall({
        function: {
          name: "edit_patch",
          arguments: JSON.stringify({
            file_path: testFilePath,
            patch: patch,
          }),
        },
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 200);

      // Verify file content
      const content = fs.readFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "utf8"
      );
      assert.match(content, /PATCHED/);

      // Restore
      fs.writeFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "Hello World\nThis is a test\nHello again\nEnd of file"
      );
    });

    it("should fail when patch parameter is missing", async () => {
      const result = await executeToolCall({
        function: {
          name: "edit_patch",
          arguments: JSON.stringify({
            file_path: testFilePath,
            // Missing patch parameter
          }),
        },
      });

      assert.strictEqual(result.ok, false);
      assert.match(result.content, /patch must be a non-empty string/i);
    });

    it("should fail when patching non-existent file", async () => {
      const patch = `--- nonexistent.txt
+++ nonexistent.txt
@@ -1 +1 @@
-old
+new`;

      const result = await executeToolCall({
        function: {
          name: "edit_patch",
          arguments: JSON.stringify({
            file_path: "nonexistent.txt",
            patch: patch,
          }),
        },
      });

      assert.strictEqual(result.ok, false);
      assert.match(result.content, /non-existent file/i);
    });
  });

  describe("Tool separation verification", () => {
    it("should have both Edit and edit_patch as separate tools", async () => {
      const { hasTool } = require("../src/tools");

      assert.strictEqual(hasTool("Edit"), true, "Edit tool should exist");
      assert.strictEqual(
        hasTool("edit_patch"),
        true,
        "edit_patch tool should exist"
      );
    });

    it("Edit should accept old_string/new_string parameters", async () => {
      const result = await executeToolCall({
        function: {
          name: "Edit",
          arguments: JSON.stringify({
            file_path: testFilePath,
            old_string: "test",
            new_string: "TEST",
          }),
        },
      });

      // Should succeed with these parameters
      assert.strictEqual(result.ok, true);

      // Restore
      fs.writeFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "Hello World\nThis is a test\nHello again\nEnd of file"
      );
    });

    it("edit_patch should accept patch parameter", async () => {
      const patch = `--- test-file.txt
+++ test-file.txt
@@ -1,1 +1,1 @@
-Hello World
+Hi World`;

      const result = await executeToolCall({
        function: {
          name: "edit_patch",
          arguments: JSON.stringify({
            file_path: testFilePath,
            patch: patch,
          }),
        },
      });

      // Should succeed with patch parameter
      assert.strictEqual(result.ok, true);

      // Restore
      fs.writeFileSync(
        path.join(testWorkspaceRoot, testFilePath),
        "Hello World\nThis is a test\nHello again\nEnd of file"
      );
    });
  });
});
