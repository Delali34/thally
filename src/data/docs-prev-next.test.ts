/** Previous/next follows the existing reader-filtered tree without quadratic duplicate scans. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarCollection } from './docs'

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

beforeEach(() => {
  vi.resetModules()
  state.config = { tabs: [] }
  state.sources = {}
})

describe('previous/next navigation', () => {
  it('keeps first-seen order and labels across repeated groups and tabs', async () => {
    state.config = { tabs: [
      { tab: 'First', groups: [{ group: 'Start', pages: ['a', 'b'] }, { group: 'More', pages: ['a', 'c'] }] },
      { tab: 'Second', pages: ['b', 'd', 'a'] },
    ] }
    state.sources = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => page(id)))
    const { getPrevNextLinks, getSidebarCollections } = await import('./docs')
    // The same page can have another display label at a later occurrence;
    // it must not replace the first occurrence's label in adjacent links.
    getSidebarCollections()[0].sections[1].items[0].title = 'Later a'
    expect(getPrevNextLinks('/a')).toEqual({ prev: null, next: { title: 'b', href: '/b' } })
    expect(getPrevNextLinks('/b')).toEqual({ prev: { title: 'a', href: '/a' }, next: { title: 'c', href: '/c' } })
    // Neighbours come only from the tab that first lists the page: First ends
    // at /c, and /d paginates within Second (b, d, a), not across the tab edge.
    expect(getPrevNextLinks('/c')).toEqual({ prev: { title: 'b', href: '/b' }, next: null })
    expect(getPrevNextLinks('/d')).toEqual({ prev: { title: 'b', href: '/b' }, next: { title: 'a', href: '/a' } })
    expect(getPrevNextLinks('/b/')).toEqual({ prev: null, next: null })
    expect(getPrevNextLinks('/missing')).toEqual({ prev: null, next: null })
  })

  it('keeps pagination inside the current tab at its first and last pages', async () => {
    state.config = { tabs: [
      { tab: 'Guides', pages: ['g1', 'g2', 'g3'] },
      { tab: 'CLI', pages: ['c1', 'c2', 'c3'] },
    ] }
    state.sources = Object.fromEntries(['g1', 'g2', 'g3', 'c1', 'c2', 'c3'].map(id => page(id)))
    const { getPrevNextLinks } = await import('./docs')
    const link = (id: string) => ({ title: id, href: `/${id}` })
    // First and last pages of a tab get no neighbour from the tabs around it.
    expect(getPrevNextLinks('/g1')).toEqual({ prev: null, next: link('g2') })
    expect(getPrevNextLinks('/g3')).toEqual({ prev: link('g2'), next: null })
    expect(getPrevNextLinks('/c1')).toEqual({ prev: null, next: link('c2') })
    expect(getPrevNextLinks('/c3')).toEqual({ prev: link('c2'), next: null })
    // Middle pages are unchanged.
    expect(getPrevNextLinks('/g2')).toEqual({ prev: link('g1'), next: link('g3') })
    expect(getPrevNextLinks('/c2')).toEqual({ prev: link('c1'), next: link('c3') })
  })

  it('paginates a page listed in two tabs within the first tab that lists it', async () => {
    state.config = { tabs: [
      { tab: 'First', pages: ['a', 'shared', 'b'] },
      { tab: 'Second', pages: ['c', 'shared', 'd'] },
    ] }
    state.sources = Object.fromEntries(['a', 'b', 'c', 'd', 'shared'].map(id => page(id)))
    const { getPrevNextLinks } = await import('./docs')
    const link = (id: string) => ({ title: id, href: `/${id}` })
    expect(getPrevNextLinks('/shared')).toEqual({ prev: link('a'), next: link('b') })
    // The second tab's other pages still see /shared as their neighbour.
    expect(getPrevNextLinks('/c')).toEqual({ prev: null, next: link('shared') })
    expect(getPrevNextLinks('/d')).toEqual({ prev: link('shared'), next: null })
  })

  it('retains served-root redirects and exact href matching', async () => {
    state.config = {
      redirects: [{ source: '/', destination: '/introduction' }],
      tabs: [{ tab: 'Docs', pages: ['introduction', 'guide', 'introduction'] }],
    }
    state.sources = Object.fromEntries(['introduction', 'guide'].map(id => page(id)))
    const { getPrevNextLinks } = await import('./docs')
    expect(getPrevNextLinks('/guide').prev).toEqual({ title: 'introduction', href: '/introduction' })
    expect(getPrevNextLinks('/')).toEqual({ prev: null, next: null })
  })

  it('retains translated order and reader filtering before deduplication', async () => {
    state.config = {
      auth: { mode: 'jwt', default: 'public' },
      i18n: {
        defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }],
        navigation: { fr: [{ tab: 'Français', pages: ['open', 'secret', 'last', 'open'] }] },
      },
      tabs: [{ tab: 'English', pages: ['open', 'secret', 'last'] }],
    }
    state.sources = Object.fromEntries([
      page('open'), page('secret', 'groups: [beta]'), page('last'),
      page('fr/open'), page('fr/secret', 'groups: [beta]'), page('fr/last'),
    ])
    const { getPrevNextLinks } = await import('./docs')
    expect(getPrevNextLinks('/fr/open')).toEqual({ prev: null, next: { title: 'fr/last', href: '/fr/last' } })
    expect(getPrevNextLinks('/fr/open', { isAuthenticated: true, groups: ['beta'], source: 'session' }))
      .toEqual({ prev: null, next: { title: 'fr/secret', href: '/fr/secret' } })
    expect(getPrevNextLinks('/open').next).toEqual({ title: 'last', href: '/last' })
  })

  it('bounds href reads linearly for 10,000 distinct navigation entries', async () => {
    const count = 10_000
    const ids = Array.from({ length: count }, (_, index) => `page-${String(index).padStart(5, '0')}`)
    state.config = { tabs: [{ tab: 'Reference', pages: ids }] }
    state.sources = Object.fromEntries(ids.map(id => page(id)))
    const { getPrevNextLinks, getSidebarCollections } = await import('./docs')
    const collections = getSidebarCollections()
    let hrefReads = 0
    for (const item of collections[0].sections[0].items) {
      const href = item.href
      Object.defineProperty(item, 'href', { get: () => { hrefReads += 1; return href }, configurable: true })
    }
    const started = performance.now()
    const result = getPrevNextLinks('/page-05000')
    const elapsedMs = performance.now() - started
    const linearHrefReads = hrefReads
    expect(result).toEqual({
      prev: { title: 'page-04999', href: '/page-04999' }, next: { title: 'page-05001', href: '/page-05001' },
    })
    expect(linearHrefReads).toBeLessThanOrEqual(count * 3)

    // Retain a measured reference to the old public algorithm; correctness
    // uses exact outputs and operation counts, never a flaky timing threshold.
    const legacyStarted = performance.now()
    const legacy = legacyAdjacent(collections, '/page-05000')
    const legacyElapsedMs = performance.now() - legacyStarted
    expect(legacy.result).toEqual(result)
    expect(legacy.comparisons).toBe(count * (count - 1) / 2)
    console.info('PREV_NEXT_10000_PERFORMANCE', JSON.stringify({ count, linearHrefReads, elapsedMs, legacyComparisons: legacy.comparisons, legacyElapsedMs }))
  })
})

/** Exact former algorithm, used only as an output/performance negative control. */
function legacyAdjacent(collections: Array<SidebarCollection>, currentHref: string) {
  const pages: Array<{ title: string; href: string }> = []
  let comparisons = 0
  for (const collection of collections) for (const section of collection.sections) for (const item of section.items) {
    if (!pages.some(candidate => { comparisons += 1; return candidate.href === item.href })) pages.push({ title: item.title, href: item.href })
  }
  const index = pages.findIndex(candidate => candidate.href === currentHref)
  return { comparisons, result: { prev: index > 0 ? pages[index - 1] : null, next: index >= 0 && index < pages.length - 1 ? pages[index + 1] : null } }
}
