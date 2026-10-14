# `thally` CLI

Product knowledge, kept in step with your code.

Create a docs site, write and publish content, and prepare updates from product
changes for your team to review.

```bash
npx @thallylabs/cli init my-docs --yes
cd my-docs
npx thally dev
```

`init` installs dependencies by default (`--no-install` skips it), and new
sites include `@thallylabs/cli` as a dev dependency, so `npx thally` runs the
project's own CLI. Once the preview is ready, `thally dev` prints the local
`llms.txt` and `/api/mcp` endpoints and a `claude mcp add --transport http`
command for connecting Claude Code.

## Terminal output

Interactive terminals show the THALLY wordmark, task headings, and live progress.
Running `thally` opens a short welcome; `thally --help` shows the command reference.
The wordmark adapts to narrow terminals. Output automatically
uses plain text in CI, when output is not a TTY, with `TERM=dumb`, or when
`NO_COLOR` is set. `thally --version` prints only the installed version; MCP
stdio and machine-readable check output keep their protocol format.

Setup and migration end with an olive next-action panel and one copyable
preview command, including `npm install` when needed.

Scaffolding and migration keep subprocess logs quiet in interactive terminals.
Pass `--verbose` to show installation and build logs as they happen:

```bash
thally init my-docs --yes --verbose
thally migrate https://github.com/your-org/your-docs --platform auto --verbose
```

Long-running steps show their current activity and elapsed time. Plain logs report an elapsed heartbeat every 15 seconds. Conversion, rendering, and content validation run off the terminal thread so progress keeps updating during larger imports.

Failures always show diagnostics, including without `--verbose`; quiet output retains the last 64 KiB. Non-interactive
runs retain subprocess output for scripts and CI.

## The model

You own the portable content and configuration surfaces:

- `src/content/` — MDX pages
- `docs.json` — navigation, theme, and product configuration
- `src/data/site.ts` — site identity, links, and brand defaults
- `src/mdx/custom-components.tsx` — customer MDX components
- `snippets/` — reusable MDX
- `public/` and `openapi.yaml` — public assets and API specifications

Framework-owned paths are recorded in `starter-release.json` and managed by
Thally. `src/app/` is framework plumbing, but it is not the complete ownership
contract. The `thally` commands keep the runtime invisible while preserving
customer-owned paths during upgrades.

## Commands

| Command | What it does |
| --- | --- |
| `thally init [dir] [--yes] [--no-install] [--verbose]` | Create a new documentation site |
| `thally new <page-id> [--title "..."]` | Create a page and add it to navigation |
| `thally migrate <github-or-docs-url> [dir] [--platform <mintlify\|docusaurus\|fern\|auto>] [--verbose]` | Import an existing documentation site |
| `thally translate --locale <code>` | Translate content into a locale |
| `thally dev [-- <server options>]` | Preview your site locally and print its agent endpoints |
| `thally build` | Build the production site |
| `thally start` | Serve the built production site |
| `thally deploy [--prod] [--cloudflare]` | Build and publish through Vercel or Cloudflare |
| `thally check [dir] [--agents] [--fix] [--ci] [--drift] [--external]` | Check content and agent readiness; `--external` also checks links to public hosts (warnings only) |
| `thally starter update [--apply] [--require-complete]` | Review or apply a complete framework and dependency update |
| `thally agent "<instruction>"` | Draft updates from product changes for review |
| `thally track <add\|list\|test\|setup>` | Turn merged product PRs into docs PRs |
| `thally mcp` | Start the Model Context Protocol server (stdio) |

`thally migrate` writes a `migration-report.json` with content and production
build check statuses. Failed checks return a nonzero status while retaining imported
files for review. `--skip-validation` explicitly performs an unverified import.
Fresh migrations install dependencies and validate the production build
automatically, without an extra confirmation or execution flag. Migration runs
project code locally, including imported MDX and components, so use sources you
own or trust. `--skip-validation` also skips dependency installation.

`thally migrate` asks which platform currently hosts the docs and dispatches to
the Mintlify, Docusaurus, or Fern adapter. Non-interactive callers can pass
`--platform mintlify`, `--platform docusaurus`, `--platform fern`, or
`--platform auto`.

Run `thally --help` for the full command reference and `thally <command> --help`
for a command's options; help never runs the command. Unknown options are
rejected. Options for the underlying dev server or build go after `--`, for
example `thally dev -- --port 4000`.

`thally deploy` prints the deployed URL reported by Vercel or Wrangler (or your
configured `THALLY_SITE_URL`) and the result of the Agent Readiness Score; a low
score is reported but does not stop the deploy.

`thally starter update` is a dry run by default. It compares the previously
recorded scaffold, the promoted target scaffold, and the current project. It
automatically updates unchanged framework-owned files and merges independent
package changes while preserving user-owned paths. Conflicting changes stop
the entire update before `--apply` writes anything. Framework files, reviewed
configuration, dependencies, and release provenance advance together.

An unrecognized release manifest can recover automatically when the complete
installed framework and package identity match a verified published snapshot.
Modified or unverifiable framework files require review; the updater never
guesses an old version or changes the manifest alone. Automated workflows can
require the complete-update capability with `--require-complete`.

Use this command, or the template's **Update Thally framework** workflow, for
customer sites. **Sync Thally runtime** is the canonical starter maintainer
workflow and cannot run against a customer repository.

## How it works

- **Framework commands** (`dev`, `build`, `start`, `deploy`) prefer the
  project's npm scripts and fall back to invoking the framework directly — so
  the framework is an implementation detail, not part of your surface.
- **Authoring commands** (`init`, `migrate`, `translate`) delegate to
  `create-thally-docs`; `starter update` uses the same immutable scaffold
  catalog and ownership-aware updater; `mcp` starts `@thallylabs/mcp`. All
  capabilities are reachable through the single `thally` binary.
- **`check --agents`** runs content lint plus the Agent Readiness Score, with a
  CI-friendly non-zero exit code when the score is below the threshold.
