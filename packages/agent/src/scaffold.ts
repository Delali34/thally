/** Generate review-gated Track workflows while keeping receiver tooling out of owner dependencies. */
import fs from "node:fs";
import path from "node:path";
import {
  DOCS_PREVIEW_LABEL,
  TRACK_OWNED_BRANCH_PREFIXES,
  buildTrackInstruction,
} from "@thallylabs/mcp/track";
import { DEFAULT_AGENT_MODEL } from "./model.js";

/** Broker protocol marker; receiver implementation updates do not change grants. */
export const DOCS_AGENT_WORKFLOW_CONTRACT = "thally-track/v4";

/** Receiver implementation revision used to offer existing sites a reviewed upgrade. */
export const DOCS_AGENT_WORKFLOW_REVISION = "thally-track-receiver/v1";

/** One resolution policy for dispatches and drift; lean sites have no local CLI. */
const DOCS_AGENT_CLI_RUNNER = `run_thally() {
  # Only the source workspace has the package build command. A missing local
  # CLI is normal in standalone sites, including the lean starter.
  if node -e 'const fs = require("node:fs"); try { const root = JSON.parse(fs.readFileSync("package.json", "utf8")); const cli = JSON.parse(fs.readFileSync("packages/cli/package.json", "utf8")); if (!Array.isArray(root.workspaces) || !root.workspaces.includes("packages/*") || typeof root.scripts?.["packages:build"] !== "string" || cli.name !== "@thallylabs/cli") process.exit(1); } catch { process.exit(1); }'; then
    npm run packages:build
    node packages/cli/dist/index.js "$@"
  else
    # Pin the receiver contract, including for sites with an older local CLI.
    # npm's execution cache leaves the owner's manifest and lockfile unchanged.
    npx --yes --ignore-scripts --package=@thallylabs/cli@0.8.122 thally "$@"
  fi
}`;

/**
 * The docs-repo "hub" workflow: it listens for a dispatched docs task (from a
 * `@thally` comment or a merge in a product repo), runs the agent, and opens a
 * documentation PR — plus a scheduled drift sweep. This is the only place the
 * ANTHROPIC_API_KEY lives; product repos never see it.
 */
const DOCS_AGENT_WORKFLOW_TEMPLATE = `# Contract: ${DOCS_AGENT_WORKFLOW_CONTRACT}
# Receiver: ${DOCS_AGENT_WORKFLOW_REVISION}
name: Thally docs agent

on:
  # A product repo dispatches a docs task here (see the sender workflow).
  repository_dispatch:
    types: [thally-document, thally-readiness]
  # Run it by hand from the Actions tab.
  workflow_dispatch:
    inputs:
      instruction:
        description: What to document
        required: true
      from_pr:
        description: Product PR URL (optional context)
        required: false
      context:
        description: Pre-resolved product PR context (optional)
        required: false
  # Weekly provenance drift sweep — flags pages whose sources changed.
  schedule:
    - cron: '0 6 * * 1'

permissions:
  contents: read

jobs:
  document:
    if: github.event_name != 'schedule'
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 20
      - run: npm ci
      - name: Configure git
        run: |
          git config user.name "thally-agent"
          git config user.email "thally-agent@users.noreply.github.com"
      - name: Draft docs and open a PR
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          THALLY_AGENT_MODEL: \${{ vars.THALLY_AGENT_MODEL || '${DEFAULT_AGENT_MODEL}' }}
          # A fine-grained PAT / App token with write on this docs repo (and read
          # on your product repos). Falls back to the built-in token.
          GH_TOKEN: \${{ secrets.THALLY_AGENT_TOKEN || secrets.GITHUB_TOKEN }}
          # Lets the agent read tracked product-repo PRs (Thally Track).
          THALLY_GITHUB_TOKEN: \${{ secrets.THALLY_AGENT_TOKEN || secrets.GITHUB_TOKEN }}
          # Dispatch/input values are passed as ENV, never expanded inline into the
          # run script — untrusted content in the instruction can't inject shell
          # commands (GitHub Actions script-injection hardening).
          INSTRUCTION: \${{ github.event.client_payload.instruction || inputs.instruction }}
          FROM_PR: \${{ github.event.client_payload.from_pr || inputs.from_pr }}
          TRACK_CONTEXT: \${{ github.event.client_payload.context || inputs.context }}
          REQUESTER: \${{ github.event.client_payload.requester }}
          THALLY_PR_GRANT: \${{ github.event.client_payload.thally_pr_grant }}
          THALLY_PR_BRANCH: \${{ github.event.client_payload.thally_pr_branch }}
          THALLY_PR_BROKER_URL: \${{ github.event.client_payload.thally_pr_broker_url || 'https://app.thally.io/api/github/readiness-pr' }}
        run: |
          if [ -n "\${THALLY_PR_GRANT:-}" ]; then
            echo "::add-mask::$THALLY_PR_GRANT"
          fi
          ${DOCS_AGENT_CLI_RUNNER.replaceAll("\n", "\n          ")}
          REQUESTER_ARGS=()
          if [ -n "$REQUESTER" ]; then
            REQUESTER_ARGS=(--requester "$REQUESTER")
          fi
          OUTPUT_ARGS=(--pr)
          if [ -n "\${THALLY_PR_GRANT:-}" ]; then
            # A readiness repair leaves its validated changes staged. The
            # workflow pushes the pre-granted branch, then asks Cloud to open
            # the PR as the Thally App after GitHub OIDC authentication.
            OUTPUT_ARGS=()
          fi
          if [ -n "$TRACK_CONTEXT" ]; then
            CONTEXT_FILE="$RUNNER_TEMP/thally-track-context.md"
            printf '%s' "$TRACK_CONTEXT" > "$CONTEXT_FILE"
            run_thally agent "$INSTRUCTION" --from-pr "$FROM_PR" --context-file "$CONTEXT_FILE" "\${REQUESTER_ARGS[@]}" "\${OUTPUT_ARGS[@]}"
          elif [ -n "$FROM_PR" ]; then
            run_thally agent "$INSTRUCTION" --from-pr "$FROM_PR" "\${REQUESTER_ARGS[@]}" "\${OUTPUT_ARGS[@]}"
          else
            run_thally agent "$INSTRUCTION" "\${REQUESTER_ARGS[@]}" "\${OUTPUT_ARGS[@]}"
          fi
          if [ -n "\${THALLY_PR_GRANT:-}" ]; then
            GENERATED_BRANCH="$(git branch --show-current)"
            if [[ "$GENERATED_BRANCH" != thally/agent-* ]]; then
              echo "No documentation changes were needed."
              exit 0
            fi
            if [[ ! "$THALLY_PR_BRANCH" =~ ^thally/agent-readiness-[a-f0-9]{16}$ ]]; then
              echo "The readiness PR branch grant is invalid." >&2
              exit 1
            fi
            git branch -m "$THALLY_PR_BRANCH"
            git commit -m "docs: improve Thally Agent Readiness"
            git push -u origin "$THALLY_PR_BRANCH"

            node -e 'const url = new URL(process.env.THALLY_PR_BROKER_URL); const isProduction = url.origin === "https://app.thally.io"; const isPreview = /^deploy-preview-[0-9]+--thally-cloud\\.netlify\\.app$/.test(url.hostname); if (url.pathname !== "/api/github/readiness-pr" || (!isProduction && !isPreview)) process.exit(1)'

            OIDC_RESPONSE="$(curl --silent --show-error --fail-with-body \
              -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
              "\${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=thally-readiness-pr")"
            export OIDC_RESPONSE
            OIDC_TOKEN="$(node -e 'const body = JSON.parse(process.env.OIDC_RESPONSE); if (typeof body.value !== "string") process.exit(1); process.stdout.write(body.value)')"
            unset OIDC_RESPONSE
            echo "::add-mask::$OIDC_TOKEN"
            REQUEST_FILE="$RUNNER_TEMP/thally-readiness-pr-request.json"
            RESPONSE_FILE="$RUNNER_TEMP/thally-readiness-pr-response.json"
            node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ grant: process.env.THALLY_PR_GRANT }))' "$REQUEST_FILE"
            curl --silent --show-error --fail-with-body \
              --output "$RESPONSE_FILE" \
              -H "Authorization: Bearer $OIDC_TOKEN" \
              -H "Content-Type: application/json" \
              --data-binary "@$REQUEST_FILE" \
              "$THALLY_PR_BROKER_URL"
            unset OIDC_TOKEN
            node -e 'const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (typeof body.pull_request_url !== "string") process.exit(1); process.stdout.write("Pull request: " + body.pull_request_url + "\\n")' "$RESPONSE_FILE"
          fi

  drift-sweep:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 20
      - run: npm ci
      - name: Check for stale docs
        run: |
          ${DOCS_AGENT_CLI_RUNNER.replaceAll("\n", "\n          ")}
          run_thally check --drift --ci
`;

export interface DocsAgentWorkflowOptions {
  /** Branch containing the production docs; repository_dispatch still reads this workflow from the default branch. */
  docsBranch?: string;
  /** Repository-relative directory containing docs.json for monorepo sites. */
  docsRootDir?: string | null;
}

/** Strip only boundary slashes in linear time, even for hostile long input. */
function trimBoundarySlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(start, end);
}

/**
 * Build the docs-side receiver for a specific connected site.
 *
 * GitHub loads repository_dispatch workflows only from the repository default
 * branch. Cloud therefore installs this file there while an explicit checkout
 * ref and working directory keep agent edits on the site's configured docs
 * branch/root.
 */
export function buildDocsAgentWorkflow(
  options: DocsAgentWorkflowOptions = {},
): string {
  const docsBranch = options.docsBranch?.trim();
  const docsRootDir =
    options.docsRootDir == null
      ? undefined
      : trimBoundarySlashes(options.docsRootDir);
  if (
    docsRootDir
      ?.split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("The docs root must be a repository-relative directory.");
  }

  let workflow = DOCS_AGENT_WORKFLOW_TEMPLATE;
  if (docsBranch) {
    workflow = workflow.replaceAll(
      "          fetch-depth: 0",
      `          fetch-depth: 0\n          ref: ${JSON.stringify(docsBranch)}`,
    );
  }
  if (docsRootDir) {
    workflow = workflow.replaceAll(
      "    runs-on: ubuntu-latest\n    steps:",
      `    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: ${JSON.stringify(docsRootDir)}\n    steps:`,
    );
  }
  return workflow;
}

/** Generic root/default-branch receiver scaffolded by the public CLI. */
export const DOCS_AGENT_WORKFLOW = buildDocsAgentWorkflow();

/** Product-repo sender: a `@thally` comment on a PR dispatches a task to the docs repo. */
export function mentionSenderWorkflow(docsRepo: string): string {
  return `name: Thally mention

on:
  issue_comment:
    types: [created]

jobs:
  dispatch:
    # Only PR comments from collaborators, starting with "@thally".
    if: >-
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '@thally') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch docs task
        env:
          GH_TOKEN: \${{ secrets.THALLY_DISPATCH_TOKEN }}
        run: |
          INSTRUCTION="\${{ github.event.comment.body }}"
          PR_URL="\${{ github.event.issue.html_url }}"
          gh api repos/${docsRepo}/dispatches -f event_type=thally-document \\
            -F "client_payload[instruction]=\${INSTRUCTION#@thally }" \\
            -F "client_payload[from_pr]=$PR_URL" \\
            -F "client_payload[requester]=\${{ github.event.comment.user.login }}"
`;
}

/**
 * Product-repo sender: on merge to main, dispatch a task iff the diff touches
 * documented surface. Edit the paths filter to match your `watch` globs.
 */
export function mergeSenderWorkflow(docsRepo: string): string {
  return `name: Thally merge dispatch

on:
  push:
    branches: [main]
    paths:
      # Only fire when documented surface changes (match your docs.json watch globs).
      - 'src/**'
      - 'openapi.yaml'

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch docs task
        env:
          GH_TOKEN: \${{ secrets.THALLY_DISPATCH_TOKEN }}
        run: |
          gh api repos/${docsRepo}/dispatches -f event_type=thally-document \\
            -F "client_payload[instruction]=Document the changes merged in \${{ github.repository }}@\${{ github.sha }}" \\
            -F "client_payload[from_pr]=\${{ github.event.head_commit.url }}"
`;
}

export interface TrackSenderRepo {
  owner: string;
  repo: string;
  branch?: string;
  paths?: Array<string>;
  outputTab?: string;
  outputGroup?: string;
}

/**
 * Product-repo sender for Thally Track: dispatch a `from_pr` docs task to the docs
 * repo when a PR either MERGES into the tracked base branch, OR is an open PR
 * labelled `docs-preview` (draft the docs BEFORE the feature ships). The
 * pure-GitHub-Actions alternative to the webhook relay — no server in the loop.
 *
 * Two safeguards mirror the webhook: a loop guard skips every Track-owned
 * branch namespace (so a self-tracking repo doesn't chase its own tail),
 * and everything untrusted (PR number/url/login) flows through ENV so bash never
 * re-parses it. The placement directive is baked from the tracking config —
 * escaped for the double-quoted bash context so a tab/group name containing a
 * quote, backtick, `$`, or backslash can't break out of the string.
 */
export function trackSenderWorkflow(
  docsRepo: string,
  repo: TrackSenderRepo,
): string {
  const branch = repo.branch ?? "main";
  const pathsBlock = repo.paths?.length
    ? `\n    paths:\n${repo.paths.map((p) => `      - '${p}'`).join("\n")}`
    : "";
  // Escape values baked into the double-quoted INSTRUCTION="…" bash string.
  const bashDq = (s: string) => s.replace(/([\\"$`])/g, "\\$1");
  // ONE source of truth for the instruction prose: build it the same way the
  // webhook relay does (buildTrackInstruction), with the runtime PR number as a
  // token we swap for the bash env var AFTER escaping (so the $ isn't escaped).
  const PR_TOKEN = "__THALLY_PR_NUMBER__";
  const bake = (preview: boolean) =>
    bashDq(
      buildTrackInstruction(
        repo,
        { number: PR_TOKEN as unknown as number },
        { preview },
      ),
    ).replace(PR_TOKEN, "${THALLY_PR_NUMBER}");
  const mergedInstruction = bake(false);
  const previewInstruction = bake(true);
  const trackOwnedBranchGuard = TRACK_OWNED_BRANCH_PREFIXES.map(
    (prefix) => `!startsWith(github.event.pull_request.head.ref, '${prefix}')`,
  ).join(" &&\n      ");
  // docsRepo lands UNQUOTED in the `gh api repos/<docsRepo>/dispatches` path —
  // constrain it to a valid owner/repo so it can't inject a shell metachar.
  const safeDocsRepo = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(docsRepo)
    ? docsRepo
    : "OWNER/DOCS-REPO";
  return `name: Thally track dispatch

on:
  pull_request:
    # closed → catches merges; labeled/synchronize/opened/reopened → catches
    # docs-preview requests (matches the webhook path's preview actions).
    types: [closed, labeled, synchronize, opened, reopened]
    branches: [${branch}]${pathsBlock}

jobs:
  dispatch:
    # Fire when the PR MERGED, or when it's an OPEN, docs-preview-labelled PR —
    # but never for any Track-owned writer branch (loop guard).
    if: >-
      ${trackOwnedBranchGuard} &&
      (github.event.pull_request.merged == true ||
       (github.event.action != 'closed' &&
        contains(github.event.pull_request.labels.*.name, '${DOCS_PREVIEW_LABEL}')))
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch docs task
        env:
          GH_TOKEN: \${{ secrets.THALLY_DISPATCH_TOKEN }}
          THALLY_PR_URL: \${{ github.event.pull_request.html_url }}
          THALLY_PR_NUMBER: \${{ github.event.pull_request.number }}
          THALLY_REQUESTER: \${{ github.event.pull_request.user.login }}
          THALLY_MERGED: \${{ github.event.pull_request.merged }}
        run: |
          if [ "$THALLY_MERGED" = "true" ]; then
            INSTRUCTION="${mergedInstruction}"
            PREVIEW=false
          else
            INSTRUCTION="${previewInstruction}"
            PREVIEW=true
          fi
          gh api repos/${safeDocsRepo}/dispatches -f event_type=thally-document \\
            -F "client_payload[instruction]=\${INSTRUCTION}" \\
            -F "client_payload[from_pr]=\${THALLY_PR_URL}" \\
            -F "client_payload[requester]=\${THALLY_REQUESTER}" \\
            -F "client_payload[preview]=\${PREVIEW}"
`;
}

/**
 * Gate who can change the admin team roster: a PR touching docs.json needs a
 * designated owner's approval. Pair with branch protection on main. This is the
 * answer to "can anyone invite themselves via a PR?" — no, not without approval.
 */
export function codeownersFor(team = "@your-org/docs-admins"): string {
  return `# Changes to the admin team roster (the "team" block) require approval from a
# designated owner. REQUIRES branch protection on main (PRs + required review),
# otherwise a direct push bypasses this.
/docs.json   ${team}
`;
}

export interface ScaffoldResult {
  written: Array<string>;
  senderSnippet: string;
}

/** Write the docs-repo agent workflow + a CODEOWNERS roster gate; return the sender snippet. */
export function scaffoldAgentWorkflow(
  projectDir: string,
  docsRepo = "<owner>/<docs-repo>",
): ScaffoldResult {
  const written: Array<string> = [];

  const wfDir = path.join(projectDir, ".github", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  const wf = path.join(wfDir, "thally-agent.yml");
  fs.writeFileSync(wf, DOCS_AGENT_WORKFLOW);
  written.push(path.relative(projectDir, wf));

  const co = path.join(projectDir, ".github", "CODEOWNERS");
  if (!fs.existsSync(co)) {
    fs.writeFileSync(co, codeownersFor());
    written.push(path.relative(projectDir, co));
  }

  return { written, senderSnippet: mentionSenderWorkflow(docsRepo) };
}
