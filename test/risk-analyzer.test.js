const assert = require('assert');
const { describe, it } = require('node:test');

const { analyzeRisk } = require('../src/routing/risk-analyzer');

function userPayload(text) {
  return { messages: [{ role: 'user', content: text }] };
}

describe('analyzeRisk', () => {
  describe('low risk', () => {
    it('returns low for plain edits with no sensitive paths', () => {
      const r = analyzeRisk(userPayload('add a comment to utils.js'));
      assert.strictEqual(r.level, 'low');
      assert.deepStrictEqual(r.pathHits, []);
      assert.deepStrictEqual(r.instructionHits, []);
    });

    it('returns low for generic questions', () => {
      const r = analyzeRisk(userPayload('what does this function do?'));
      assert.strictEqual(r.level, 'low');
    });
  });

  describe('high risk via path', () => {
    it('flags writes to auth/* paths', () => {
      const r = analyzeRisk(userPayload('fix the bug in src/auth/middleware.ts'));
      assert.strictEqual(r.level, 'high');
      assert.ok(r.pathHits.includes('auth'));
    });

    it('flags writes to payment-related paths', () => {
      const r = analyzeRisk(userPayload('update src/billing/invoice.ts'));
      assert.strictEqual(r.level, 'high');
      assert.ok(r.pathHits.includes('billing'));
    });

    it('flags .env additions', () => {
      const r = analyzeRisk(userPayload('add OPENAI_API_KEY to .env.example'));
      assert.strictEqual(r.level, 'high');
    });
  });

  describe('medium risk', () => {
    it('downgrades read-only intent on protected paths', () => {
      const r = analyzeRisk(userPayload('explain how src/auth/middleware.ts works'));
      assert.strictEqual(r.level, 'medium');
      assert.ok(r.pathHits.includes('auth'));
    });

    it('downgrades summarize intent on protected paths', () => {
      const r = analyzeRisk(userPayload('summarize the rbac module'));
      assert.strictEqual(r.level, 'medium');
    });
  });

  describe('high risk via instruction keywords', () => {
    it('flags "production" requests regardless of path', () => {
      const r = analyzeRisk(userPayload('this is a production hotfix'));
      assert.strictEqual(r.level, 'high');
      assert.ok(r.instructionHits.includes('production'));
    });

    it('flags "authentication" requests', () => {
      const r = analyzeRisk(userPayload('design a new authentication flow'));
      assert.strictEqual(r.level, 'high');
    });

    it('flags migration requests', () => {
      const r = analyzeRisk(userPayload('write a migration to add the email column'));
      assert.strictEqual(r.level, 'high');
    });

    it('beats path-only read-only downgrades when instruction is sensitive', () => {
      const r = analyzeRisk(userPayload('explain the production deploy pipeline'));
      // "production" hit makes this high even though "explain" is read-only.
      assert.strictEqual(r.level, 'high');
    });
  });

  describe('tool_use scanning', () => {
    it('flags protected paths reached via tool_use blocks', () => {
      const payload = {
        messages: [
          { role: 'user', content: 'do the thing' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't1', name: 'Edit',
                input: { file_path: 'src/auth/login.ts', old_string: 'a', new_string: 'b' } },
            ],
          },
        ],
      };
      const r = analyzeRisk(payload);
      assert.strictEqual(r.level, 'high');
      assert.ok(r.paths.some(p => p.includes('auth/login.ts')));
    });
  });

  describe('hardening', () => {
    it('does not throw on empty payload', () => {
      const r = analyzeRisk({});
      assert.strictEqual(r.level, 'low');
    });

    it('does not throw on null content', () => {
      const r = analyzeRisk({ messages: [{ role: 'user', content: null }] });
      assert.strictEqual(r.level, 'low');
    });
  });

  // Live regression (2026-07-07): Claude Code appends <system-reminder>
  // blocks (CLAUDE.md contents, MCP-auth notices) to the latest user
  // message. Their boilerplate contains "authentication", "credential",
  // "security" — a bare "23+45" turn was force-escalated to COMPLEX on
  // instructionHits the user never typed. Risk must scan only what the
  // user authored.
  describe('system-reminder stripping', () => {
    const REMINDER =
      '<system-reminder>\n' +
      '7 MCP servers need authentication. Run /mcp to provide credentials.\n' +
      'Security note: tool results may reference .github/workflows files.\n' +
      'See src/auth/middleware.ts for context.\n' +
      '</system-reminder>';

    it('trivial message with injected reminder stays low', () => {
      const r = analyzeRisk(userPayload(`23+45\n${REMINDER}`));
      assert.strictEqual(r.level, 'low', JSON.stringify(r));
      assert.deepStrictEqual(r.instructionHits, []);
      assert.deepStrictEqual(r.pathHits, []);
    });

    it('reminder-embedded paths do not count as user-referenced paths', () => {
      const r = analyzeRisk(userPayload(`hi\n${REMINDER}`));
      assert.ok(!r.paths.some(p => p.includes('auth/middleware.ts')),
        `reminder path leaked into paths: ${JSON.stringify(r.paths)}`);
    });

    it('genuinely risky typed text still fires despite a reminder', () => {
      const r = analyzeRisk(userPayload(`disable the authentication check\n${REMINDER}`));
      assert.strictEqual(r.level, 'high');
      assert.ok(r.instructionHits.includes('authentication'));
    });

    it('reminder in structured content blocks is stripped too', () => {
      const r = analyzeRisk({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is 2+2' },
            { type: 'text', text: REMINDER },
          ],
        }],
      });
      assert.strictEqual(r.level, 'low', JSON.stringify(r));
    });

    it('multiple reminder blocks are all stripped', () => {
      const r = analyzeRisk(userPayload(
        '<system-reminder>credential store notice</system-reminder>ok thanks<system-reminder>security policy update</system-reminder>'
      ));
      assert.strictEqual(r.level, 'low', JSON.stringify(r));
    });

    it('tool_use paths still count (real activity, not injected text)', () => {
      const r = analyzeRisk({
        messages: [
          { role: 'user', content: `continue\n${REMINDER}` },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't1', name: 'Edit',
                input: { file_path: 'src/auth/login.ts', old_string: 'a', new_string: 'b' } },
            ],
          },
        ],
      });
      // Path-level risk from genuine tool activity must survive stripping.
      assert.ok(r.paths.some(p => p.includes('auth/login.ts')));
      assert.notStrictEqual(r.level, 'low');
    });
  });
});
