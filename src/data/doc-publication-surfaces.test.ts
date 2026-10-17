/**
 * Every place that lists or serves documentation pages must apply the shared
 * "is this doc published" decision (`isDocPublished` in
 * `@/data/docs`). These checks fail when a surface is added or rewired around it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (file: string) => readFileSync(join(root, file), 'utf8')

/** Async loaders in docs.ts that decide publication before answering. */
const PUBLICATION_AWARE = /\b(loadDocEntries|loadSidebarCollections|loadNavigationSnapshot|loadNavContext|ensureDocPublication)\(/

const surfaces: Record<string, string> = {
  'src/app/sitemap.ts': 'sitemap',
  'src/app/llms.txt/route.ts': 'llms.txt',
  'src/app/llms-full.txt/route.ts': 'llms-full.txt',
  'src/app/api/docs-index/route.ts': '/api/docs-index',
  'src/app/api/docs/[...slug]/route.ts': '/api/docs (JSON, JSON-LD, Markdown)',
  'src/app/api/markdown/[...slug]/route.ts': '.md mirror and /api/markdown',
  'src/app/skill.md/route.ts': 'skill.md manifest',
  'src/lib/mcp/site-tools.ts': 'MCP list_pages / read_page',
  'src/lib/changelog.ts': 'changelog feeds and MCP list_changes',
  'src/lib/search/register-doc-source.ts': 'search index',
  'src/app/(docs)/layout.tsx': 'sidebar navigation',
  'src/app/(docs)/api/[[...slug]]/page.tsx': 'API sidebar navigation',
  'src/lib/navigation-snapshot-server.ts': 'shared lazy/inline navigation projection',
  'src/components/layout/localized-sidebar-hydrator.tsx': 'localized sidebar',
  'src/app/(docs)/[[...slug]]/page.tsx': 'page navigation, breadcrumbs and prev/next',
}

describe('publication is applied by every surface', () => {
  for (const [file, name] of Object.entries(surfaces)) {
    it(`${name} (${file})`, () => {
      expect(read(file)).toMatch(PUBLICATION_AWARE)
    })
  }

  it('the agent-readiness page facts and the check script prime publication too', () => {
    expect(read('src/lib/agent-readiness/gather.ts')).toContain('await loadDocEntries()')
    expect(read('scripts/agent-readiness.ts')).toContain('ensureDocPublication()')
  })

  it('the markdown mirror refuses an unpublished page', () => {
    expect(read('src/app/api/markdown/[...slug]/route.ts')).toContain('isDocPublished(')
  })

  it('no other module lists pages from the synchronous, unprimed enumerators', () => {
    const allowed = new Set([
      'src/data/docs.ts',
      // Static params only: an unpublished page is a build-time 404 either way.
      'src/app/(docs)/[[...slug]]/page.tsx',
      'src/app/(docs)/api/[[...slug]]/page.tsx',
      'src/app/(docs)/[locale]/api/[[...slug]]/page.tsx',
      // Sync twins that read whatever the async loaders already decided.
      'src/lib/search/register-doc-source.ts',
      'src/lib/agent-readiness/gather.ts',
      // Its only caller (the skill.md route) awaits ensureDocPublication() first.
      'src/lib/agent-manifest.ts',
      // Types only.
      'src/app/api/docs/[...slug]/route.ts',
    ])
    const offenders: Array<string> = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          if (name !== 'generated' && name !== 'node_modules') walk(full)
          continue
        }
        const file = relative(root, full)
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || allowed.has(file)) continue
        if (/\bgetDocEntries\(|\bgetSearchableDocs\(|\bgetDocEntryBySlug\(/.test(readFileSync(full, 'utf8'))) offenders.push(file)
      }
    }
    walk(join(root, 'src'))
    expect(offenders).toEqual([])
  })
})
