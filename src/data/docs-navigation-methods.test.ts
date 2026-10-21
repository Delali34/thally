/** API navigation consumes parsed frontmatter, preserving authored labels. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/docs-json-config', () => ({
  getDocsJsonConfig: () => ({ tabs: [{ tab: 'Reference', groups: [{ group: 'Pages', pages: ['manual', 'spec', 'guide', 'webhook'] }] }] }),
  getDocsJsonConfigRevision: () => 1,
}))
const content: Record<string, string> = {
  manual: '---\ntitle: Create page\napi: POST /pages\n---\nDescription',
  spec: '---\ntitle: List pages\nopenapi: GET /pages\napi: DELETE /ignored\n---\nDescription',
  guide: '---\ntitle: GET started\n---\nDescription',
  webhook: '---\ntitle: Page event\nopenapi: webhook pageUpdated\n---\nDescription',
}
vi.mock('@/lib/runtime-sources', () => ({
  listRuntimeSources: () => Object.keys(content).map((id) => `src/content/${id}.mdx`),
  readRuntimeSource: (path: string) => content[path.split('/').pop()!.replace('.mdx', '')],
  runtimeSourceExists: () => true,
}))
import { getSidebarCollections } from './docs'

describe('navigation method metadata', () => {
  it('supports manual, OpenAPI and webhook pages without parsing labels', () => {
    const items = getSidebarCollections()[0].sections[0].items
    expect(items.map(({ title, method }) => ({ title, method }))).toEqual([
      { title: 'Create page', method: 'POST' },
      { title: 'List pages', method: 'GET' },
      { title: 'GET started', method: undefined },
      { title: 'Page event', method: 'HOOK' },
    ])
  })
})
