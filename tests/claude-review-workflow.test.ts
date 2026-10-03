import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  fileURLToPath(new URL("../.github/workflows/claude-code-review.yml", import.meta.url)),
  "utf8",
);

test("paid Claude review only runs after a maintainer's explicit opt-in", () => {
  assert.match(workflow, /pull_request_target:\s*\n\s+types: \[labeled\]/);
  assert.match(workflow, /issue_comment:\s*\n\s+types: \[created\]/);
  assert.match(workflow, /github\.event\.comment\.body == '\/claude-review'/);
  assert.match(workflow, /github\.event\.label\.name == 'claude-review'/);
  assert.match(workflow, /github\.event\.issue\.state == 'open'/);
  assert.match(workflow, /github\.event\.comment\.author_association == 'OWNER'/);
  assert.match(workflow, /github\.event\.sender\.type != 'Bot'/);
  assert.doesNotMatch(workflow, /types: \[[^\]]*(?:opened|synchronize|ready_for_review|reopened)/);

  const gate = workflow.match(/    if: >\n([\s\S]*?)\n\n    runs-on:/)?.[1] ?? "";
  assert.ok(gate.includes("issue_comment"));
  assert.ok(gate.includes("pull_request_target"));
  assert.doesNotMatch(gate, /pull_request\.author_association/);
});

test("missing Claude credentials skip all review work without failing the job", () => {
  assert.match(workflow, /id: review-auth[\s\S]*?CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.match(workflow, /echo "enabled=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /echo "enabled=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /if: steps\.review-auth\.outputs\.enabled == 'true'\n\s+env:\n\s+GH_TOKEN:/);

  for (const step of [
    "Resolve target PR",
    "Checkout PR head for review context (read-only; never executed)",
    "Stage PR context for the reviewer",
    "Run Claude Code Review",
  ]) {
    const start = workflow.indexOf(`- name: ${step}`);
    assert.notEqual(start, -1, `${step} exists in the workflow`);
    const next = workflow.indexOf("\n      - ", start + 1);
    const block = workflow.slice(start, next === -1 ? undefined : next);
    assert.match(
      block,
      /if: steps\.review-auth\.outputs\.enabled == 'true'/,
      `${step} is skipped when the credential is absent`,
    );
  }
  assert.match(workflow, /steps\.review-auth\.outputs\.enabled == 'true' && steps\.claude-review\.outputs\.execution_file/);
});
