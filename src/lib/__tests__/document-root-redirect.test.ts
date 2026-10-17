/** Missing-home selection uses real route/matcher semantics and the exact document reader gate. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarCollection } from '@/data/docs'
import { ANONYMOUS_READER } from '@/lib/reader-auth/access'

const fixture = vi.hoisted(() => ({
  collections: [] as Array<SidebarCollection>,
  redirects: [] as Array<{ source: string; destination: string }>,
  docs: new Map<string, { id: string; allowed: boolean; openapi?: unknown }>(),
  unpublished: new Set<string>(),
  load: vi.fn(), resolve: vi.fn(), gate: vi.fn(), operation: vi.fn(),
}))
vi.mock('@/data/docs', () => ({
  loadSidebarCollections: (...args: unknown[]) => { fixture.load(...args); return Promise.resolve(fixture.collections) },
  getRedirectsConfig: () => fixture.redirects,
  isDocPublished: (id: string) => !fixture.unpublished.has(id),
}))
vi.mock('@/data/get-doc', () => ({ getDocFromParams: (slug: Array<string>, locale?: string) => {
  fixture.resolve(slug, locale)
  return Promise.resolve(fixture.docs.get(`${locale ?? 'default'}:${slug.join('/')}`) ?? null)
} }))
vi.mock('@/lib/reader-auth/page-gate', () => ({ canReaderViewResolvedDoc: (doc: { allowed: boolean }, ...args: unknown[]) => {
  fixture.gate(doc, ...args); return Promise.resolve(doc.allowed)
} }))
vi.mock('@/data/api-reference', () => ({ lookupApiOperationForFrontmatter: (...args: unknown[]) => fixture.operation(...args) }))
import { loadRootDocumentRedirect } from '@/lib/document-root-redirect'
const i18n = { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }] }
const page = (href: string) => ({ type: 'page' as const, item: { id: href, title: href, href } })
function navigation(hrefs: Array<string>) { fixture.collections = [{ id: 'docs', label: 'Docs', sections: [{ title: 'Docs', items: [], nodes: hrefs.map(page) }] }] }
function document(path: string, allowed = true, locale = 'default') { fixture.docs.set(`${locale}:${path}`, { id: path, allowed }) }
const select = (locale?: string) => loadRootDocumentRedirect({ i18n, locale, reader: ANONYMOUS_READER })
beforeEach(() => { fixture.collections = []; fixture.redirects = []; fixture.docs.clear(); fixture.unpublished.clear(); fixture.load.mockClear(); fixture.resolve.mockClear(); fixture.gate.mockClear(); fixture.operation.mockReset().mockResolvedValue({ node: {} }) })

describe('missing documentation root', () => {
  it('chooses authored DFS order even inside a collapsed group, resolving actual files before returning', async () => {
    fixture.collections = [{ id: 'docs', label: 'Docs', sections: [{ title: 'First', items: [], nodes: [
      { type: 'group', group: { id: 'nested', title: 'Nested', defaultOpen: false, nodes: [page('/missing'), page('/docs/start')] } }, page('/docs/second'),
    ] }, { title: 'Later', items: [page('/docs/last').item] }] }]
    document('docs/start'); document('docs/second'); document('docs/last')
    expect(await select()).toBe('/docs/start')
    expect(fixture.resolve.mock.calls).toEqual([[['missing'], undefined], [['docs', 'start'], undefined]])
    expect(fixture.gate).toHaveBeenCalledWith(fixture.docs.get('default:docs/start'), ANONYMOUS_READER, undefined)
  })

  it('skips missing, private and unpublished entries without revealing their destination', async () => {
    navigation(['/missing', '/private', '/withheld', '/docs/visible'])
    document('private', false); document('withheld'); document('docs/visible')
    fixture.unpublished.add('withheld')
    expect(await select()).toBe('/docs/visible')
    expect(fixture.gate).not.toHaveBeenCalledWith(fixture.docs.get('default:withheld'), expect.anything(), expect.anything())
  })

  it('rejects root aliases, external destinations, unsafe encodings and noncanonical query/fragment links', async () => {
    navigation(['/', '/introduction', '/fr', '/fr/introduction', 'https://outside.test/docs', '//outside.test/docs', '/\\outside.test/docs', '/%2F%2Foutside.test', '/%2e%2e', '/%', '/docs?view=other', '/docs#part', '/docs/start%20here'])
    document('docs/start here')
    expect(await select()).toBe('/docs/start%20here')
    expect(fixture.resolve.mock.calls).toEqual([[['docs', 'start here'], undefined]])
  })

  it('omits redirect sources, including parameterized aliases and cyclic/root-bound chains', async () => {
    navigation(['/docs', '/docs/a', '/docs/b', '/old/one/two', '/oldish/valid'])
    fixture.redirects = [{ source: '/docs', destination: '/' }, { source: '/docs/:id', destination: '/docs/a' }, { source: '/old/:slug*', destination: '/' }]
    for (const id of ['docs', 'docs/a', 'docs/b', 'old/one/two', 'oldish/valid']) document(id)
    expect(await select()).toBe('/oldish/valid')
    expect(fixture.resolve.mock.calls).toEqual([[['oldish', 'valid'], undefined]])
  })

  it('deduplicates canonical path aliases before document reads', async () => {
    navigation(['/private/', '/private', '/good']); document('private', false); document('good')
    expect(await select()).toBe('/good')
    expect(fixture.resolve.mock.calls.filter(([slug]) => slug.join('/') === 'private')).toHaveLength(1)
  })

  it('keeps translated/version paths and resolves access in that exact locale', async () => {
    navigation(['/docs', '/fr', '/fr/introduction', '/fr/v1/guide']); document('v1/guide', true, 'fr')
    expect(await select('fr')).toBe('/fr/v1/guide')
    expect(fixture.load).toHaveBeenCalledWith('fr', ANONYMOUS_READER)
    expect(fixture.resolve).toHaveBeenCalledWith(['v1', 'guide'], 'fr')
    expect(fixture.gate).toHaveBeenCalledWith(fixture.docs.get('fr:v1/guide'), ANONYMOUS_READER, 'fr')
  })

  it('keeps a non-English primary locale unprefixed', async () => {
    navigation(['/docs']); document('docs')
    expect(await loadRootDocumentRedirect({ i18n: { ...i18n, defaultLocale: 'fr' }, reader: ANONYMOUS_READER })).toBe('/docs')
  })

  it('returns no destination for empty or wholly unavailable/private navigation', async () => {
    expect(await select()).toBeNull()
    navigation(['/missing', '/private', '/']); document('private', false)
    expect(await select()).toBeNull()
  })
})


it('omits an actual hidden operation even if its document ID is an alternate index spelling', async () => {
  navigation(['/api/index', '/guide']); document('api/index'); document('guide')
  fixture.docs.get('default:api/index')!.openapi = { path: '/hidden' }
  fixture.operation.mockResolvedValue({ node: null, reason: 'withheld' })
  expect(await select()).toBe('/guide')
  expect(fixture.operation).toHaveBeenCalledOnce()
})
