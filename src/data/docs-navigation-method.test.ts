/** Sidebar entries for pages with `openapi:` frontmatter know their HTTP method. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/docs-json-config', () => ({
  getDocsJsonConfig: () => ({
    tabs: [{ tab: 'API', groups: [
      { group: 'Endpoints', pages: ['api/scrape', 'api/hook', 'api/errors'] },
      { group: 'Examples', defaultOpen: true, pages: ['api/errors'] },
      { group: 'Archived', defaultOpen: false, pages: ['api/errors'] },
    ] }],
  }),
  getDocsJsonConfigRevision: () => 1,
}))
vi.mock('@/lib/runtime-sources', () => ({
  listRuntimeSources: () => ['src/content/api/scrape.mdx', 'src/content/api/hook.mdx', 'src/content/api/errors.mdx'],
  readRuntimeSource: (path: string) =>
    path.endsWith('scrape.mdx')
      ? '---\ntitle: Scrape\ndescription: Short search summary.\ndescriptionPlacement: operation\nopenapi: "openapi/v2.json delete /scrape"\n---\nBody'
      : path.endsWith('hook.mdx')
        ? '---\ntitle: Hook\nopenapi: "openapi/w.json webhook crawlPage"\n---\nBody'
        : '---\ntitle: Errors\n---\nBody',
  runtimeSourceExists: () => true,
}))

import { getDocEntries, getSidebarCollections } from './docs'

describe('sidebar method', () => {
  it('keeps the summary and operation placement in indexed document metadata', () => {
    expect(getDocEntries().find((doc) => doc.id === 'api/scrape')).toMatchObject({ description: 'Short search summary.', descriptionPlacement: 'operation' })
    expect(getSidebarCollections()[0].sections[0].items[0].description).toBe('Short search summary.')
  })
  it('carries the upper-cased operation method, HOOK for webhooks, and nothing for plain pages', () => {
    const items = getSidebarCollections()[0].sections[0].items
    expect(items.map((item) => item.method)).toEqual(['DELETE', 'HOOK', undefined])
  })
  it('retains explicit expansion states on root groups without wrapping ordinary headings', () => {
    const sections = getSidebarCollections()[0].sections
    expect(sections[0].nodes?.[0].type).toBe('page')
    expect(sections[1]).toMatchObject({ defaultOpen: true, nodes: [{ type: 'group', group: { defaultOpen: true } }] })
    expect(sections[2]).toMatchObject({ defaultOpen: false, nodes: [{ type: 'group', group: { defaultOpen: false } }] })
  })
})
