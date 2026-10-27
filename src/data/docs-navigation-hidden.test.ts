/**
 * A page that docs.json lists but its frontmatter hides stays out of the
 * sidebar, yet still belongs to the tab and group that list it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  config: { tabs: [] } as Record<string, unknown>,
  sources: {} as Record<string, string>,
}))

vi.mock('@/lib/docs-json-config', () => ({
  getDocsJsonConfig: () => state.config,
  getDocsJsonConfigRevision: () => 1,
}))
vi.mock('@/lib/runtime-sources', () => ({
  listRuntimeSources: () => Object.keys(state.sources),
  readRuntimeSource: (path: string) => state.sources[path] ?? '',
  runtimeSourceExists: (path: string) => path in state.sources,
  runtimeSourceModifiedAt: () => 0,
}))
vi.mock('@/lib/content-index', () => ({
  getContentIndex: () => null, loadContentIndex: async () => null, isIndexedContentPath: () => false,
}))

function page(id: string, frontmatter = ''): [string, string] {
  return [`src/content/${id}.mdx`, `---\ntitle: ${id}\n${frontmatter}\n---\nBody\n`]
}

beforeEach(async () => {
  vi.resetModules()
  const { resetReaderAuthConfigForTests } = await import('@/lib/reader-auth/config')
  resetReaderAuthConfigForTests()
  state.config = {
    tabs: [
      { tab: 'Guides', pages: ['intro'] },
      {
        tab: 'Reference',
        groups: [
          { group: 'CLI', pages: ['cli/reference', 'cli/agent', { group: 'Nested', pages: ['cli/nested', 'cli/next'] }] },
          { group: 'Only hidden', pages: ['solo'] },
        ],
        pages: ['top'],
      },
    ],
  }
  state.sources = Object.fromEntries([
    page('intro'), page('cli/reference', 'hidden: true'), page('cli/agent'), page('cli/nested', 'hidden: true'),
    page('cli/next'), page('solo', 'hidden: true'), page('top', 'hidden: true'),
  ])
})

describe('hidden pages that navigation lists', () => {
  it('stay out of the sidebar and of every list that follows its order', async () => {
    const { getSidebarCollections, getPrevNextLinks } = await import('./docs')
    const reference = getSidebarCollections()[1]
    expect(reference.sections.map((section) => section.items.map((item) => item.href))).toEqual([['/cli/agent', '/cli/next']])
    expect(JSON.stringify(reference.sections)).not.toMatch(/cli\/reference|cli\/nested|solo|"\/top"/)
    expect(getPrevNextLinks('/cli/agent')).toEqual({ prev: null, next: { title: 'cli/next', href: '/cli/next' } })
  })

  it('belong to the tab that lists them, including a group of only hidden pages', async () => {
    const { getSidebarCollections } = await import('./docs')
    const [guides, reference] = getSidebarCollections()
    expect(guides).not.toHaveProperty('hiddenItems')
    expect(reference.hiddenItems?.map((item) => [item.href, item.groupPath])).toEqual([
      ['/cli/reference', ['CLI']], ['/cli/nested', ['CLI', 'Nested']], ['/solo', ['Only hidden']], ['/top', undefined],
    ])
  })

  it('keep their tab and group for breadcrumbs, eyebrow and agent context', async () => {
    const { getBreadcrumbs, getNavCategory, getNavContext, getNavGroupPath } = await import('./docs')
    expect(getBreadcrumbs('/cli/nested').map((crumb) => crumb.label)).toEqual(['Reference', 'CLI', 'Nested', 'cli/nested'])
    expect(getNavGroupPath('/cli/nested')).toEqual(['CLI', 'Nested'])
    expect(getNavCategory('/cli/reference')).toBe('CLI')
    expect(getNavContext('cli/reference')).toMatchObject({ tab: 'Reference', group: 'CLI', prev: null, next: null })
    expect(getNavContext('top')).toMatchObject({ tab: 'Reference', group: '', groupPath: [] })
    expect(getNavContext('cli/agent')).toMatchObject({ tab: 'Reference', group: 'CLI' })
  })

  it('are not listed for a reader who may not open them', async () => {
    state.config = {
      auth: { mode: 'jwt', default: 'public', loginUrl: 'https://app.example.com/login' },
      tabs: [{ tab: 'Reference', pages: ['cli/agent', 'secret', 'cli/reference'] }],
    }
    state.sources = Object.fromEntries([page('cli/agent'), page('secret', 'hidden: true\ngroups: [beta]'), page('cli/reference', 'hidden: true')])
    const { resetReaderAuthConfigForTests } = await import('@/lib/reader-auth/config')
    resetReaderAuthConfigForTests()
    const { getSidebarCollections, getBreadcrumbs } = await import('./docs')
    expect(getSidebarCollections()[0].hiddenItems?.map((item) => item.href)).toEqual(['/cli/reference'])
    expect(getBreadcrumbs('/secret')).toEqual([])
  })
})
