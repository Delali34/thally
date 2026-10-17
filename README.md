# Thally

Build and publish Git-owned docs for people and AI tools with Thally's
MIT-licensed documentation engine and public toolchain. One MDX source can
serve HTML, Markdown, structured JSON, JSON-LD, `llms.txt`, RSS, and a live MCP
endpoint. Self-host it or connect the site to Thally Cloud.

## Start a docs site

```bash
npx create-thally-docs my-docs
cd my-docs
npm run dev
```

`create-thally-docs` installs dependencies by default (pass `--no-install` to
skip) and prints the exact preview command. Sites that include the `thally`
CLI as a dev dependency can also run `npx thally dev`, which prints the local
`llms.txt` and MCP endpoints plus a `claude mcp add` command once the server is
ready.

Or clone the dedicated starter directly:

```bash
npx degit thallylabs/starter my-docs
cd my-docs
npm install
npm run dev
```

The server starts at [http://localhost:3040](http://localhost:3040), or the next
available port when 3040 is already in use.

## Keep product knowledge aligned

**The product knowledge layer for software teams.**

Your product changed. Did your docs, website, and help center? Connect the
repositories that define your product and the places customers learn about it.
When a pull request merges, Thally Track gathers the evidence, traces the
impact, and opens evidence-backed pull requests for your team to review. A
no-change result is valid. Nothing publishes without human approval.

## Features

- **MDX content** — write docs in Markdown with React components
- **Unified content engine** — each page is parsed once into a typed content graph; HTML, JSON, JSON-LD, Markdown, search, and embeddings are all projections of that one model
- **Auto-generated API reference** — drop in an OpenAPI spec and get interactive docs with a "Try It" console
- **Sidebar & tabs** — configured from a single `docs.json` file
- **Hybrid search** — instant client-side command palette plus a server-side full-text + vector `/api/search`
- **Retrieval-grounded AI chat** — Q&A with retrieval over your docs and inline citations, available when the site is linked to Thally Cloud; the widget stays hidden otherwise
- **Agent endpoints** — `/llms.txt`, `/ai.txt`, `/api/docs-index`, `/api/docs/{slug}`, and an **Agent Readiness Score** at `/api/agent-readiness`
- **Native WebMCP** — supported browsers expose all eight deployed-site tools plus `get_current_page` and `navigate_to_page` through `document.modelContext`; reader sessions and MCP rate limits apply automatically
- **HTML tool discovery**: the server-rendered `<head>` includes an inert `<script type="application/webmcp+json">` with all ten tools' names, descriptions, and input schemas from the same registry. This versioned Thally discovery extension is not a standardized WebMCP registration mechanism. Native execution still requires JavaScript and a compatible browser. The metadata identifies the eight HTTP-callable tools at `/api/mcp` and links to `/.well-known/mcp.json`; the two browser-session tools cannot be called over HTTP.
- **Remote MCP server** — every deployed site is an MCP endpoint at `/api/mcp` with read-only tools (`search_docs`, `search_sections`, `read_page`, `list_pages`, `list_api_operations`, `get_api_operation`, `list_changes`, `agent_readiness`) and pages as resources; attach with `claude mcp add --transport http <site>/api/mcp`
- **Docs agent** — `thally agent "…"` (or `@thally` on a product PR) drafts docs as a **reviewed pull request**, self-checked with `thally check`; it never merges
- **Provenance & drift** — machine-legible `lastVerified` dates + `thally check --drift` to catch pages stale against the code they document
- **Team accounts & roles** — Google/Microsoft OIDC sign-in + Owner/Editor/Viewer from a git-committed roster in `docs.json` (no database, no per-seat)
- **Unified `thally` CLI + `@thallylabs/mcp`** — one toolchain to scaffold, develop, deploy, check, and drive your docs from any MCP client
- **TOC, dark mode, responsive** — built-in with zero config; persistent sidebar, mobile drawer, command palette
- **Syntax highlighting** — Shiki with CSS variables for theme-aware code blocks

## Project Structure

```
docs.json              # Navigation config — tabs, groups, page order, API reference
openapi.yaml           # Your OpenAPI spec (auto-generates the API Reference tab)
src/
  content/             # MDX documentation pages (flat folder)
    introduction.mdx
    quickstart.mdx
    ...
  app/                 # Next.js App Router
  components/          # Layout, navigation, MDX, and UI primitives
  data/
    docs.ts            # Reads docs.json + frontmatter to build navigation
    site.ts            # Site name, description, links, brand colors
  config/
    api-reference.ts   # Reads API config from docs.json
```

## Adding a Page

1. Create `src/content/my-page.mdx`:
   ```mdx
   ---
   title: My Page
   description: A short description for search and meta tags.
   ---

   Your content here. Use any MDX — headings, code blocks, callouts, etc.
   ```

2. Add `"my-page"` to a group in `docs.json`:
   ```json
   {
     "group": "Getting Started",
     "pages": ["introduction", "quickstart", "my-page"]
   }
   ```

3. Done. Sidebar, search, and navigation update automatically.

## Configuring Navigation (`docs.json`)

```json
{
  "tabs": [
    {
      "tab": "Overview",
      "groups": [
        { "group": "Getting Started", "pages": ["introduction", "quickstart"] },
        { "group": "Core Concepts", "pages": ["authentication", "pagination"] }
      ]
    },
    {
      "tab": "API Reference",
      "api": {
        "source": "openapi.yaml",
        "tagsOrder": ["Pets", "Store"],
        "defaultGroup": "General"
      }
    },
    {
      "tab": "Changelog",
      "href": "/changelog"
    }
  ]
}
```

- **`tab`** — label shown in the top navigation bar
- **`groups`** — sidebar sections, each with a title and ordered page list
- **`api`** — auto-generates API reference from an OpenAPI spec
- **`href`** — links to an internal route or external URL

### Markdown page URLs

Public `.md` versions of documentation pages are available as an opt-in
delivery surface for readers and AI tools. Enable them in `docs.json`:

```json
{
  "markdown": { "enabled": true },
  "tabs": []
}
```

After enabling the setting, append `.md` to a page path: `/quickstart.md`.
For the homepage, use `/.md`. Thally Cloud sites can manage the same setting
from **Site settings** without editing the repository. The feature is disabled
by default, and access protection still applies to Markdown page URLs.

## API Reference

Drop your OpenAPI 3.x spec as `openapi.yaml` in the project root and configure it in `docs.json`:

```json
{
  "tab": "API Reference",
  "api": {
    "source": "openapi.yaml",
    "tagsOrder": ["Pets", "Store"],
    "defaultGroup": "General",
    "overrides": {
      "GET /pets": { "title": "List pets", "badge": "Stable" }
    }
  }
}
```

The template includes an example Pet Store spec. Replace it with your own.

## Customization

### Brand Colors

Edit `src/data/site.ts` to change the site name, description, links, and brand palette. Two presets are included (`primary` green, `secondary` purple) — switch between them or define your own.

### Layout

Edit `src/config/layout.ts` for padding, column widths, and panel styles.

### Environment Variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

| Variable | Purpose |
|---|---|
| `THALLY_SITE_URL` | Public origin for OpenGraph, canonical URLs, JSON-LD, and agent manifests (legacy `DOX_SITE_URL` / `NEXT_PUBLIC_SITE_URL` still honored). When unset, the host-published URL is used: Vercel `VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL` (build and runtime), Netlify `URL`/`DEPLOY_PRIME_URL` and Cloudflare Pages `CF_PAGES_URL` (build time only), Render `RENDER_EXTERNAL_URL` (runtime only); `http://localhost:3040` in local development. A `localhost` value never overrides a host-published URL. Set it explicitly outside Vercel for complete coverage, and for custom domains and Cloudflare Workers |
| `THALLY_CLOUD_SITE_TOKEN` | Optional server-only credential from Thally Cloud. The deployed site exchanges it automatically on its next visit; never prefix it with `NEXT_PUBLIC_` |
| `THALLY_CLOUD_URL` | Optional Thally Cloud base URL. Defaults to `https://app.thally.io` |
| `THALLY_CLOUD_SITE_CONFIG` | Managed-hosting release snapshot injected by Thally Cloud. Self-hosted sites should leave this unset and use `THALLY_CLOUD_SITE_TOKEN` |
| `THALLY_CONTENT_SOURCE` | Optional — where doc content is read from: `filesystem` (default; build-embedded, SSG) or `assets` (managed hosting; content served from static assets and rendered per request). Asset-backed sites answer hybrid search requests with full-text results and `mode_degraded_reason: "runtime_capacity"` to avoid unbounded vector allocation. Self-hosted sites should leave this unset |
| `THALLY_DOCS_CONFIG` | Optional managed-hosting snapshot of `docs.json`, used to publish presentation and navigation settings without recompiling the Worker. Self-hosted sites should leave this unset and edit `docs.json` |
| `THALLY_ADMIN_PASSWORD` / `THALLY_ADMIN_SECRET` | Optional break-glass admin password plus its required high-entropy production session-signing secret |
| `THALLY_ACCESS_PASSWORD` / `THALLY_ACCESS_SECRET` | Optional docs-access password plus its required high-entropy production session-signing secret; the access secret may fall back to `THALLY_ADMIN_SECRET` |
| `THALLY_READER_SESSION_SECRET` | Reader-auth session-signing secret (32+ chars, distinct from admin/access secrets); required in production when docs.json `auth.mode` is `jwt` or `oidc` |
| `THALLY_READER_JWT_SECRET` / `THALLY_READER_JWT_PUBLIC_KEY` / `THALLY_READER_JWKS_URL` | JWT handoff verification key — exactly one: HS256 shared secret, SPKI PEM (RS256/PS256/ES256/EdDSA), or JWKS URL |
| `THALLY_READER_OIDC_ISSUER` / `THALLY_READER_OIDC_CLIENT_ID` / `THALLY_READER_OIDC_CLIENT_SECRET` | Reader sign-in with your OpenID Connect provider (`auth.mode: "oidc"`) |
| `THALLY_READER_ALLOW_DEV_SESSION_KEY` | Local previews only: `1` signs reader sessions with a PUBLIC development key (ignored in production). Anyone who can reach the server can then forge sessions — never set it on a reachable server |
| `THALLY_READER_TOKEN_KEYS` | Optional `kid:secret` list for read-only, group-scoped agent/MCP bearer tokens (`npm run reader-token`) |
| `ANTHROPIC_API_KEY` | Optional — used by local tooling only (`thally agent`, `thally translate`, and non-Markdown conversion in `thally migrate`). The site's AI chat is served by Thally Cloud and reads no model key |
| `THALLY_MCP_RATE_PER_MIN` | Optional per-client limit on remote MCP tool calls and resource reads (default `60`; `0` disables) |
| `THALLY_SEARCH_HYBRID_RATE_PER_MIN` | Optional per-client limit on `/api/search?mode=hybrid` when a hosted embedding provider is configured (default `20`); over the limit, full-text results are served |
| `THALLY_REPO_URL` | Optional — the docs repo Thally Track dispatches to. Defaults to `siteConfig.repoUrl`; set it when `site.ts` keeps the template default (`repoUrl: ''`) but Track should still target your repo |
| `THALLY_TRACK_WEBHOOK_SECRET` | Optional — enables the manual Thally Track webhook (`/api/track/webhook`); merged/preview PRs in tracked repos become docs-agent PRs. Not needed when you Connect a GitHub App |
| `THALLY_GITHUB_TOKEN` | Optional — fine-grained PAT that reads tracked product-repo PRs, relays Track dispatches, and authenticates the admin Docs-tasks queue |
| `THALLY_GITHUB_APP_ID` / `THALLY_GITHUB_APP_INSTALLATION_ID` / `THALLY_GITHUB_APP_PRIVATE_KEY` | Optional — wire a GitHub App by hand instead of the admin "Connect GitHub" button (which stores these encrypted). Grants org-wide access to selected repos |
| `THALLY_DISABLE_BUILD_CACHE` | Optional — set to `1` to turn off Turbopack's persistent build cache (kept under `.next/cache` to speed up warm builds) if a production build misbehaves with it |

Legacy `DOX_*` names are still read as a fallback for every `THALLY_*` variable, so existing deployments keep working without renaming anything.

## Production

```bash
npm run build
npm start
```

Deploy anywhere that supports Next.js — Vercel, Netlify, Cloudflare, Docker, etc.

## Stack

- Next.js 16 / TypeScript / App Router
- Tailwind CSS 3.4 + `@tailwindcss/typography`
- Radix UI (dialog, scroll-area, accordion, slot)
- MDX via `next-mdx-remote` + Shiki syntax highlighting
- `next-themes` for dark mode, `nuqs` for URL state, `zustand` for sidebar state
- `yaml` for inert frontmatter and OpenAPI parsing

## Contributing

Pull requests target `main`. Before opening one, run:

```bash
npm test
npm run lint
npm run build
```

Runtime, rendering, search, and package changes belong in this repository.
`thallylabs/starter` is the standalone site template that `create-thally-docs`,
`thally init`, and MCP project creation scaffold from; its runtime files are
generated from here, so please do not patch them in the starter repository.
Known warnings that are pinned to upstream toolchains are tracked in
[`BUILD-WARNINGS.md`](BUILD-WARNINGS.md).

## License

MIT
