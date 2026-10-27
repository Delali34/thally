# create-thally-docs

Scaffold an open-source [Thally](https://github.com/thallylabs/thally) docs
site for people, search engines, and AI tools. The result keeps your source in
Git and publishes each page as HTML, Markdown, structured JSON, JSON-LD, and
agent discovery files.

## Quick start

```bash
npx create-thally-docs my-docs
cd my-docs
npm run dev
```

The default site does not bundle the Thally CLI or deployment tooling. Run
`npm run check` to validate documentation, or `npm run starter:update` to preview
a framework update using the current official CLI. Legacy sites that explicitly
install a local CLI retain their existing preview command.

The dev server starts at [http://localhost:3040](http://localhost:3040). If that
port is occupied, run `npm run dev -- --port 3041`. A freshly scaffolded
site is agent-ready out of the box and scores 100/A on the built-in
[Agent Readiness Score](https://github.com/thallylabs/thally).

Run non-interactively with smart defaults:

```bash
npx create-thally-docs my-docs --yes
```

Dependencies are installed by default, so the preview command works right
away. Pass `--no-install` to skip installation (for example in CI or when you
use another package manager). The interactive setup asks only for the project
directory, name, an optional GitHub repository, Thally Track, installation,
and extra languages; the description and brand palette are one-line edits in
`src/data/site.ts`. The generated `.env.local` never pins a `localhost` site
URL, so a build from this checkout cannot bake local links into `llms.txt` or
the sitemap.

## Terminal output

Interactive terminals show the THALLY wordmark, task headings, and live progress.
The wordmark adapts to narrow terminals. Output automatically
uses plain text in CI, when output is not a TTY, with `TERM=dumb`, or when
`NO_COLOR` is set.

Setup and migration end with a highlighted next-action panel. The preview
command is one copyable line, including `npm install` when needed.

Scaffolding and migration keep subprocess logs quiet in interactive terminals.
Add `--verbose` to see installation and build logs as they happen:

```bash
npx create-thally-docs my-docs --yes --verbose
npx create-thally-docs migrate https://github.com/your-org/your-docs --platform auto --verbose
```

Long-running steps show their current activity and elapsed time. Plain logs report an elapsed heartbeat every 15 seconds. Conversion, rendering, and content validation run off the terminal thread so progress keeps updating during larger imports.

Failures always show diagnostics, including without `--verbose`; quiet output retains the last 64 KiB. Non-interactive
runs retain subprocess output for scripts and CI. These options also work with
`thally init` and `thally migrate`.

## What you get

- **MDX content** in `src/content/`, navigation in `docs.json`
- **Agent endpoints** — `/llms.txt`, `/ai.txt`, `/api/docs-index`, `/api/agent-readiness`
- **Hybrid search**, an **admin analytics** dashboard, and **retrieval-grounded AI chat** when the site is linked to Thally Cloud
- **Starter content** with keywords and structured pages, ready to edit

## Other commands

| Command | What it does |
| --- | --- |
| `create-thally-docs <dir>` | Scaffold a new project |
| `create-thally-docs migrate <github-or-docs-url-or-directory> [dir]` | Import a docs repository or public docs site through the shared migration engine |
| `create-thally-docs check [dir] [--fix] [--ci] [--drift] [--external]` | Lint content for MDX syntax errors (pages and snippets that cannot be parsed), broken links, orphan pages, and missing frontmatter; `--external` also checks links to public hosts (bounded, warnings only) |
| `create-thally-docs translate --locale <code>` | Translate content into another locale |

Public URL imports default to 1,000 pages. The web migration flow supports up to
1,000 pages; for larger sites, use the CLI with an explicit `--max-pages` value
(up to 10,000). This is a crawl limit, not a guarantee that every site of that
size will import or build successfully. Source access, content size, and the
destination runtime still apply. For example:

```bash
npx create-thally-docs migrate https://docs.example.com my-docs --max-pages 1500 --yes
```

A local checkout works without making a private repository public:

```bash
npx create-thally-docs migrate "../private docs" my-docs --platform mintlify --yes
npx create-thally-docs migrate https://docs.example.com my-docs --openapi https://docs.example.com/openapi.json --yes
```

Local sources are supported by the local CLI (`thally migrate` forwards the same
arguments). The selected input and output must be separate directories. The
importer snapshots documentation inputs without executing configuration; it skips
hidden files, dependency directories and symlinks that escape the selected root.
The Cloud and MCP URL adapters do not gain access to local paths or `file://` URLs.

Website migration restores publisher-provided embedded OpenAPI operations and
can discover a single linked `openapi.json`/`openapi.yaml` specification. Supply
`--openapi <https-url>` when the source does not expose one, or links several.
Only unambiguous operation routes are bound to crawled pages; their original
prose and URLs stay intact, and generated API navigation excludes those operations.
Markdown mirror links retain `.md`; machine indexes and spec links use the new
site's equivalent routes. The migration report identifies unresolved internal links
and unsupported frontmatter that need review. Supported code-fence labels,
line numbers, wrapping, focus and highlights remain portable.

An in-place import (`--into <dir>`) preserves authored files that conflict with
incoming content and lists them in `migration-report.json`; validation fails until
you resolve those conflicts. Authored navigation is merged. Untouched sample
navigation is replaced only after comparison with the project's verified immutable
starter archive and unchanged sample content. If provenance cannot be proved, the
existing navigation is preserved and the report explains why.

Interactive migrations ask whether the source is Mintlify, Docusaurus, Fern, or
another auto-detected platform. When automatic detection receives a live
website URL, the CLI recommends its source GitHub repository and requires
confirmation before continuing with the less precise website crawl. For
scripts and CI, pass
`--platform mintlify`, `--platform docusaurus`, `--platform fern`, or
`--platform auto`; `--yes`
keeps backward-compatible auto-detection when no platform flag is supplied.
Explicit `--platform auto` and `--yes` runs print the live-site limitation
without introducing an interactive prompt. Running `migrate` without
`--platform` or `--yes` from a non-interactive shell (a script, a CI job, a
piped command) also skips the platform prompt — it can't be answered there —
and auto-detects instead, with a warning naming the flag that silences it.

Mintlify repository migrations preserve the source information architecture
instead of rebuilding navigation from folders: nested project roots, `$ref`
navigation files, tabs, groups, dropdowns, products, versions, languages,
redirects, page metadata, snippets, assets, and compatible OpenAPI settings are
projected into Thally. A live Mintlify URL uses the structured configuration
embedded by Mintlify when it is available, with bounded same-site crawling as a
fallback.

Migrated OpenAPI specs are written to `openapi/`, not `public/` (which the host
serves as-is). `--into` never deletes authored files; only verified unchanged starter samples may be removed: an older copy of a spec already in
`public/` stays publicly downloadable (a `public/openapi.json` even answers
`/openapi.json` in place of the filtered spec), so the migration lists such files and
`thally check` warns about them until you delete them manually.

Repository-local JSX/TSX components and supported static dependencies are copied
into the customer-owned MDX registry. Simple interactive HTML blocks are moved
into client components, and locale/root routing is normalized. Unsupported
customizations remain visible as warnings rather than being silently dropped.

After importing, the CLI automatically installs dependencies for fresh projects,
runs static content checks and a production build, and writes
`migration-report.json`. A failed check or build returns a nonzero exit status;
the imported files remain available for inspection. Warnings may include
pre-existing source problems and compatibility limitations even when a build
passes. Review them before publishing. Use `--skip-validation` for an explicit
import-only run; its report is marked unverified. An existing `--into` project
without a build script is also reported as unverified.

Migration is a local build workflow for projects you own or trust. Dependency
installation and builds execute project code, including imported MDX and
JSX/TSX; they are not sandboxed. No additional confirmation or execution flag
is needed. `--skip-validation` also skips dependency installation.

A fresh migration leaves the destination repository unset. After creating the
new repository, set `site.repoUrl` in `src/data/site.ts` to its root GitHub URL
to enable edit and issue links. The source location remains in the migration
report; it is not used as the destination for reader feedback.

Prefer a single binary? Install [`@thallylabs/cli`](https://www.npmjs.com/package/@thallylabs/cli)
and use `thally init`, which delegates here.

## License

MIT
