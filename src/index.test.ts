import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the types and test the rule evaluation logic directly
// We re-implement testRule here since it's not exported (internal)
interface Rule {
  name: string;
  tool: "bash" | "write" | "edit";
  field: "command" | "path" | "content";
  pattern: string;
  requires?: string;
  unless?: string;
  reason: string;
  noOverride?: boolean;
}

function testRule(rule: Rule, value: string): boolean {
  if (!new RegExp(rule.pattern).test(value)) return false;
  if (rule.requires && !new RegExp(rule.requires).test(value)) return false;
  if (rule.unless && new RegExp(rule.unless).test(value)) return false;
  return true;
}

function extractOverride(text: string, ruleName: string): string | null {
  const pattern = new RegExp(
    `(?:#|//|/\\*|<!--|--|%%|;;)\\s*steering-override:\\s*${ruleName}\\s*[—–-]\\s*(.+?)\\s*(?:\\*/|-->)?\\s*$`,
    "im",
  );
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

// ─── Default rules (copied from index.ts for testing) ──────────────

const noForcePush: Rule = {
  name: "no-force-push",
  tool: "bash",
  field: "command",
  pattern: "\\bgit\\s+push\\b.*--force(?!-with-lease)",
  reason: "no force push",
};

const noHardReset: Rule = {
  name: "no-hard-reset",
  tool: "bash",
  field: "command",
  pattern: "\\bgit\\s+reset\\s+--hard\\b",
  reason: "no hard reset",
};

const noRmRfSlash: Rule = {
  name: "no-rm-rf-slash",
  tool: "bash",
  field: "command",
  pattern: "\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\\s+/(?:\\s|$)",
  reason: "no rm -rf /",
  noOverride: true,
};

const conventionalCommits: Rule = {
  name: "conventional-commits",
  tool: "bash",
  field: "command",
  pattern: "\\bgit\\s+commit\\b.*-m\\s+[\"'](?!(feat|fix|style|refactor|docs|test|chore|perf|ci|build|revert)(\\(.+\\))?(!)?: )",
  reason: "conventional commits",
};

const noLongRunning: Rule = {
  name: "no-long-running-commands",
  tool: "bash",
  field: "command",
  pattern: "\\b(npm\\s+run\\s+dev|npm\\s+start|yarn\\s+start|yarn\\s+dev|npx\\s+.*--watch|webpack\\s+(--watch|serve)|jest\\s+--watch|nodemon|tsc\\s+--watch)\\b",
  reason: "no long running",
};

// ─── Tests ─────────────────────────────────────────────────────────

describe("no-force-push", () => {
  it("blocks git push --force", () => {
    assert.ok(testRule(noForcePush, "git push --force origin main"));
  });
  it("allows git push --force-with-lease", () => {
    assert.ok(!testRule(noForcePush, "git push --force-with-lease origin main"));
  });
  it("allows normal git push", () => {
    assert.ok(!testRule(noForcePush, "git push origin main"));
  });
});

describe("no-hard-reset", () => {
  it("blocks git reset --hard", () => {
    assert.ok(testRule(noHardReset, "git reset --hard HEAD~1"));
  });
  it("allows git reset --soft", () => {
    assert.ok(!testRule(noHardReset, "git reset --soft HEAD~1"));
  });
});

describe("no-rm-rf-slash", () => {
  it("blocks rm -rf /", () => {
    assert.ok(testRule(noRmRfSlash, "rm -rf /"));
  });
  it("blocks rm -rf / with extra flags", () => {
    assert.ok(testRule(noRmRfSlash, "rm -rf / --no-preserve-root"));
  });
  it("allows rm -rf on a safe path", () => {
    assert.ok(!testRule(noRmRfSlash, "rm -rf ./build"));
  });
  it("allows rm -rf on absolute safe path", () => {
    assert.ok(!testRule(noRmRfSlash, "rm -rf /tmp/build"));
  });
});

describe("conventional-commits", () => {
  it("blocks non-conventional commit", () => {
    assert.ok(testRule(conventionalCommits, 'git commit -m "updated stuff"'));
  });
  it("allows conventional commit", () => {
    assert.ok(!testRule(conventionalCommits, 'git commit -m "feat: add new feature"'));
  });
  it("allows scoped conventional commit", () => {
    assert.ok(!testRule(conventionalCommits, 'git commit -m "fix(auth): handle token expiry"'));
  });
  it("allows breaking change conventional commit", () => {
    assert.ok(!testRule(conventionalCommits, 'git commit -m "feat!: drop Node 14 support"'));
  });
  it("ignores git commit without -m", () => {
    assert.ok(!testRule(conventionalCommits, "git commit --amend"));
  });
});

describe("no-long-running-commands", () => {
  it("blocks npm run dev", () => {
    assert.ok(testRule(noLongRunning, "npm run dev"));
  });
  it("blocks npm start", () => {
    assert.ok(testRule(noLongRunning, "npm start"));
  });
  it("blocks jest --watch", () => {
    assert.ok(testRule(noLongRunning, "jest --watch"));
  });
  it("blocks nodemon", () => {
    assert.ok(testRule(noLongRunning, "nodemon server.js"));
  });
  it("allows npm run build", () => {
    assert.ok(!testRule(noLongRunning, "npm run build"));
  });
  it("allows jest without --watch", () => {
    assert.ok(!testRule(noLongRunning, "jest --coverage"));
  });
});

describe("requires/unless conditions", () => {
  it("requires condition must also match", () => {
    const rule: Rule = {
      name: "test",
      tool: "bash",
      field: "command",
      pattern: "\\baws\\s",
      requires: "s3",
      reason: "test",
    };
    assert.ok(testRule(rule, "aws s3 ls"));
    assert.ok(!testRule(rule, "aws ec2 describe-instances"));
  });

  it("unless condition exempts the match", () => {
    const rule: Rule = {
      name: "test",
      tool: "bash",
      field: "command",
      pattern: "\\baws\\s",
      unless: "--profile",
      reason: "test",
    };
    assert.ok(testRule(rule, "aws s3 ls"));
    assert.ok(!testRule(rule, "aws s3 ls --profile prod"));
  });
});

describe("override extraction", () => {
  it("extracts override reason with em dash", () => {
    const reason = extractOverride(
      "git push --force # steering-override: no-force-push — deploying hotfix",
      "no-force-push",
    );
    assert.equal(reason, "deploying hotfix");
  });

  it("extracts override reason with en dash", () => {
    const reason = extractOverride(
      "git push --force # steering-override: no-force-push – deploying hotfix",
      "no-force-push",
    );
    assert.equal(reason, "deploying hotfix");
  });

  it("returns null when no override present", () => {
    const reason = extractOverride("git push --force", "no-force-push");
    assert.equal(reason, null);
  });

  it("returns null for wrong rule name", () => {
    const reason = extractOverride(
      "git push --force # steering-override: other-rule — reason",
      "no-force-push",
    );
    assert.equal(reason, null);
  });

  it("extracts override with // comment syntax", () => {
    const reason = extractOverride(
      'const x = 1;\n// steering-override: no-env-write — needed for config',
      "no-env-write",
    );
    assert.equal(reason, "needed for config");
  });

  it("extracts override with /* */ comment syntax", () => {
    const reason = extractOverride(
      '/* steering-override: no-env-write — needed for config */\nconst x = 1;',
      "no-env-write",
    );
    assert.equal(reason, "needed for config");
  });

  it("extracts override with <!-- --> comment syntax", () => {
    const reason = extractOverride(
      '<!-- steering-override: no-html-edit — fixing layout -->\n<div>hello</div>',
      "no-html-edit",
    );
    assert.equal(reason, "fixing layout");
  });

  it("extracts override from multiline content", () => {
    const content = `line 1
line 2
# steering-override: my-rule — good reason
line 4`;
    const reason = extractOverride(content, "my-rule");
    assert.equal(reason, "good reason");
  });
});

// ─── Write/Edit override scenarios ─────────────────────────────────

describe("write tool override scenarios", () => {
  const noEnvWrite: Rule = {
    name: "no-env-write",
    tool: "write",
    field: "content",
    pattern: "SECRET_KEY",
    reason: "don't write secrets to files",
  };

  const noEnvWriteHard: Rule = {
    name: "no-env-write-hard",
    tool: "write",
    field: "content",
    pattern: "SECRET_KEY",
    reason: "don't write secrets to files",
    noOverride: true,
  };

  it("write rule triggers on matching content", () => {
    assert.ok(testRule(noEnvWrite, "SECRET_KEY=abc123"));
  });

  it("write override is extractable from file content with # comment", () => {
    const content = "# steering-override: no-env-write — placeholder for testing\nSECRET_KEY=placeholder";
    const reason = extractOverride(content, "no-env-write");
    assert.equal(reason, "placeholder for testing");
  });

  it("write override is extractable from file content with // comment", () => {
    const content = "// steering-override: no-env-write — needed for dev\nexport const SECRET_KEY = 'dev';";
    const reason = extractOverride(content, "no-env-write");
    assert.equal(reason, "needed for dev");
  });

  it("noOverride rule has no extractable override", () => {
    // The override comment is there but the rule has noOverride: true
    // so it should still block (logic is in the hook, not extractOverride)
    assert.ok(noEnvWriteHard.noOverride);
  });
});

describe("edit tool override scenarios", () => {
  const noProtectedEdit: Rule = {
    name: "no-protected-edit",
    tool: "edit",
    field: "path",
    pattern: "\\.lock$",
    reason: "don't manually edit lock files",
  };

  it("edit rule triggers on matching path", () => {
    assert.ok(testRule(noProtectedEdit, "package-lock.json.lock"));
    assert.ok(!testRule(noProtectedEdit, "src/index.ts"));
  });

  it("edit override is extractable from newText", () => {
    const newText = "updated: true\n// steering-override: no-protected-edit — fixing corrupted lock";
    const reason = extractOverride(newText, "no-protected-edit");
    assert.equal(reason, "fixing corrupted lock");
  });

  it("edit override works across multiple edits joined", () => {
    const combined = "first edit text\nsecond edit with # steering-override: no-protected-edit — emergency fix";
    const reason = extractOverride(combined, "no-protected-edit");
    assert.equal(reason, "emergency fix");
  });
});
