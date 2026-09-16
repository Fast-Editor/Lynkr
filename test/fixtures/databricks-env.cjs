"use strict";

// Test-harness defaults for the repository's databricks-primary config guard
// (src/config/index.js throws unless MODEL_PROVIDER=databricks is paired with
// DATABRICKS_API_BASE + DATABRICKS_API_KEY). The unit runner sets these inline
// (`npm run test:unit`); this tracked fixture lets `node --test` reproduce the
// same harness without an env wrapper so independent verification is a plain
// argv array. Values mirror the repo script exactly (test-key / http://test.com).

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";
process.env.LOG_FILE_ENABLED = process.env.LOG_FILE_ENABLED || "false";
