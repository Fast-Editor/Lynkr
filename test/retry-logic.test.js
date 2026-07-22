const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");

const { withRetry } = require("../src/clients/retry");

describe("Retry Logic Integration", () => {
  let mockServer;
  let requestCounts;

  before((done) => {
    requestCounts = {};
    mockServer = http.createServer((req, res) => {
      const url = req.url;
      requestCounts[url] = (requestCounts[url] || 0) + 1;

      if (url === "/fail-twice") {
        if (requestCounts[url] <= 2) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Server error" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        }
      } else if (url === "/rate-limit") {
        if (requestCounts[url] <= 2) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": "1",
          });
          res.end(JSON.stringify({ error: "Rate limited" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        }
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: "ok" }));
      }
    });

    mockServer.listen(9999, done);
  });

  after((done) => {
    if (mockServer) {
      mockServer.close(done);
    } else {
      done();
    }
  });

  it("should retry on server errors and eventually succeed", async () => {
    const response = await withRetry(async () => {
      return await fetch("http://localhost:9999/fail-twice");
    }, {
      maxRetries: 3,
      initialDelay: 50,
      maxDelay: 200,
    });

    assert.ok(response.ok, "Response should be ok after retries");
    const result = await response.json();
    assert.ok(result.success);
    assert.ok(requestCounts["/fail-twice"] >= 3, `Expected at least 3 requests, got ${requestCounts["/fail-twice"]}`);
  });

  it("should handle 429 rate limiting with retry", async () => {
    const response = await withRetry(async () => {
      return await fetch("http://localhost:9999/rate-limit");
    }, {
      maxRetries: 3,
      initialDelay: 50,
      maxDelay: 200,
    });

    assert.ok(response.ok, "Should eventually succeed after retries");
    const result = await response.json();
    assert.ok(result.success, "Result should indicate success");
    assert.ok(requestCounts["/rate-limit"] >= 2, "Should have retried at least once");
  });
});
