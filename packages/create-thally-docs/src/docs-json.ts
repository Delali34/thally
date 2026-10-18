import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DocsJsonNavigationGroup {
  group: string
  pages: Array<string | DocsJsonNavigationGroup>
}

export interface DocsJsonTab {
  tab: string
  href?: string
  pages?: Array<string | DocsJsonNavigationGroup>
  groups?: Array<DocsJsonNavigationGroup>
  api?: { source: string; navigation?: boolean }
}

export interface DocsJsonConfig {
  tabs: Array<DocsJsonTab>
  navigation?: { versions?: Array<{ label?: string }> }
  redirects?: Array<{ source: string; destination: string; permanent?: boolean }>
  ai?: { chat?: boolean }
  i18n?: {
    defaultLocale: string
    locales: Array<{ code: string; label: string }>
    /** Per-locale tab trees, used instead of the root `tabs` for that locale. */
    navigation?: Record<string, Array<DocsJsonTab>>
  }
  /** Admin-dashboard team roster — git-committed, no database. */
  team?: {
    members?: Array<{ email: string; role: 'owner' | 'editor' | 'viewer' }>
    domains?: Array<{ domain: string; role: 'owner' | 'editor' | 'viewer' }>
  }
  /** Thally Track — product repos whose merged PRs trigger docs-agent PRs (typed for `thally track add`). */
  tracking?: {
    repos?: Array<{
      owner: string
      repo: string
      branch?: string
      paths?: Array<string>
      outputTab?: string
      outputGroup?: string
    }>
  }
}

export function readDocsJson(projectDir: string): DocsJsonConfig {
  const docsPath = join(projectDir, 'docs.json')
  const raw = readFileSync(docsPath, 'utf8')
  return JSON.parse(raw) as DocsJsonConfig
}

export function writeDocsJson(projectDir: string, config: DocsJsonConfig): void {
  const docsPath = join(projectDir, 'docs.json')
  writeFileSync(docsPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

/**
 * Thally Track is OPT-IN. `docs.json` is copied verbatim into a scaffold (unlike
 * `/cli/`, `/packages/`, and the Track/agent workflows, which are excluded at
 * download time), so the Thally project's own `tracking` block — which watches
 * `thallylabs/thally` — would otherwise become the default for every new site,
 * silently pointing the user's docs agent at our repo. We strip it here so a
 * fresh scaffold starts with ZERO tracked repos.
 *
 * A user opts in afterwards with `thally track add <owner/repo>` (writes a fresh
 * `tracking` block), then `thally track setup` to wire a trigger. See the Thally
 * Track guide.
 */
export function resetTrackingConfig(projectDir: string): void {
  const config = readDocsJson(projectDir)
  if (config.tracking) {
    delete config.tracking
    writeDocsJson(projectDir, config)
  }
}

/**
 * Opt-IN entry point used when the user says yes to Thally Track during
 * `create-thally-docs`. Writes a fresh `tracking` block for the repos they named
 * (branch `main`, all files) — a starting point they refine in docs.json or with
 * `thally track add`. No-op for an empty list.
 */
export function writeTrackingConfig(
  projectDir: string,
  repos: Array<{ owner: string; repo: string }>,
): void {
  if (repos.length === 0) return
  const config = readDocsJson(projectDir)
  config.tracking = { repos: repos.map((r) => ({ owner: r.owner, repo: r.repo, branch: 'main' })) }
  writeDocsJson(projectDir, config)
}
