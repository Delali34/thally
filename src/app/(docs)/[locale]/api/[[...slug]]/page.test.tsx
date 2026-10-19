/** API-prefixed MDX must reach the localized document renderer. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  specLinkVisible: true,
  source: null as null | object,
  hasTranslation: true,
  docs: [] as Array<{ slug: string[]; href: string }>,
  nodes: [] as Array<{ slug: string[]; href: string }>,
  node: null as null | object,
  renderDoc: vi.fn<(props: { params: Promise<{ slug: string[] }> }) => Promise<null>>(async () => null),
  metadata: vi.fn<(props: { params: Promise<{ slug: string[] }> }) => Promise<{ title: string }>>(
    async () => ({ title: 'Guide français' }),
  ),
}))

vi.mock('@/app/(docs)/[[...slug]]/page', () => ({
  default: fixtures.renderDoc,
  generateMetadata: fixtures.metadata,
}))
vi.mock('@/lib/content-source', () => ({ isRemoteContentSource: () => false, getContentSource: () => ({ kind: 'filesystem' }) }))
vi.mock('@/lib/i18n/translation-source', () => ({ findDocSource: vi.fn(async () => fixtures.source), hasDocTranslation: async () => fixtures.hasTranslation, getIndexableDocTranslation: async () => ({ title: 'Translated API' }) }))
vi.mock('next/navigation', () => ({ redirect: (href: string) => { throw new Error(`redirect:${href}`) }, notFound: () => { throw new Error('not-found') } }))
vi.mock('@/data/api-reference', () => ({
  getApiOperationBySlug: vi.fn(async () => fixtures.node),
  getAllApiOperationNodes: vi.fn(async () => fixtures.nodes),
  getApiOperationNodes: vi.fn(async () => fixtures.nodes),
}))
vi.mock('@/lib/i18n/request', () => ({
  getEffectiveI18nConfig: async () => ({ defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'fr' }] }),
  getRepositoryI18nConfig: () => ({ defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'fr' }] }),
}))
vi.mock('@/data/docs', () => ({
  getApiPlaygroundDisplay: () => undefined,
  getApiSpecLinkVisible: () => fixtures.specLinkVisible,
  getBreadcrumbs: () => [],
  getDocEntries: () => fixtures.docs,
  loadDocEntries: async () => fixtures.docs,
  getSeoConfig: () => ({ titleSeparator: ' - ' }),
}))
vi.mock('@/lib/site-url', () => ({ getSiteUrl: () => 'https://docs.example.test' }))
vi.mock('@/config/api-reference', () => ({ apiReferenceConfig: { defaultSpecId: 'default' }, getOpenApiSpecUrl: () => 'https://docs.example.test/openapi.json' }))
vi.mock('@/lib/site-config', () => ({ resolveBuildSiteConfig: () => ({ name: 'Docs' }) }))

import LocaleApiReferencePage, { generateMetadata, generateStaticParams } from './page'

describe('localized API MDX routing', () => {
  it('delegates non-OpenAPI slugs and metadata to localized docs', async () => {
    const params = Promise.resolve({ locale: 'fr', slug: ['overview'] })
    await LocaleApiReferencePage({ params })
    await generateMetadata({ params })

    expect(fixtures.renderDoc).toHaveBeenCalledWith({
      params: expect.any(Promise),
    })
    expect(await fixtures.renderDoc.mock.calls[0]![0].params).toEqual({ slug: ['fr', 'api', 'overview'] })
    expect(await fixtures.metadata.mock.calls[0]![0].params).toEqual({ slug: ['fr', 'api', 'overview'] })
  })

  it('shows the visible spec link by default and hides it with api.specLink false', async () => {
    fixtures.node = {
      href: '/api/default/analytics/query/post',
      operation: { title: 'Query', method: 'POST', path: '/analytics/query', specId: 'default' },
    }
    const params = Promise.resolve({ locale: 'fr', slug: ['default', 'analytics', 'query', 'post'] })
    fixtures.specLinkVisible = true
    expect(JSON.stringify(await LocaleApiReferencePage({ params }))).toContain('OpenAPI specification:')
    fixtures.specLinkVisible = false
    expect(JSON.stringify(await LocaleApiReferencePage({ params }))).not.toContain('OpenAPI specification:')
    fixtures.node = null
  })

  it.each([
    ['a nested page', 'platform', ['overview']],
    ['the folder index', 'platform', []],
    ['a slug that is also an operation', 'platform', ['default', 'analytics', 'query', 'post']],
    ['the default locale', 'en', ['overview']],
  ])('renders %s under a first segment that is not a secondary locale as the document route does', async (_name, locale, slug) => {
    fixtures.renderDoc.mockClear()
    fixtures.metadata.mockClear()
    fixtures.node = { href: '/api/default/analytics/query/post', operation: { title: 'Query', method: 'POST', path: '/analytics/query', specId: 'default' } }
    const params = Promise.resolve({ locale, slug })
    await LocaleApiReferencePage({ params })
    expect(await generateMetadata({ params })).toEqual({ title: 'Guide français' })

    expect(await fixtures.renderDoc.mock.calls[0]![0].params).toEqual({ slug: [locale, 'api', ...slug] })
    expect(await fixtures.metadata.mock.calls[0]![0].params).toEqual({ slug: [locale, 'api', ...slug] })
    fixtures.node = null
  })
})


describe('localized authored API root routing', () => {
  beforeEach(() => {
    fixtures.source = null
    fixtures.hasTranslation = true
    fixtures.docs = []
    fixtures.nodes = []
    fixtures.node = null
    fixtures.renderDoc.mockClear()
    fixtures.metadata.mockClear()
  })

  it.each([false, true])('delegates a translated or source-fallback root to docs (fallback=%s)', async isFallback => {
    fixtures.source = { filePath: isFallback ? 'src/content/api.mdx' : 'src/content/fr/api.mdx', isFallback }
    fixtures.hasTranslation = !isFallback
    fixtures.docs = [{ slug: ['api'], href: '/api' }, { slug: ['api', 'overview'], href: '/api/overview' }]
    fixtures.nodes = [{ slug: ['default', 'get'], href: '/api/default/get' }]
    const params = Promise.resolve({ locale: 'fr' })
    await LocaleApiReferencePage({ params })
    expect(await fixtures.renderDoc.mock.calls[0]![0].params).toEqual({ slug: ['fr', 'api'] })
    expect(await generateMetadata({ params })).toEqual({ title: 'Guide français' })
    expect((await generateStaticParams()).some(entry => entry.locale === 'fr' && entry.slug.length === 0)).toBe(!isFallback)
  })

  it.each(['reader-policy-denied', 'publication-denied'])('preserves document denial for a localized root: %s', async reason => {
    fixtures.source = { filePath: 'src/content/fr/api.mdx', isFallback: false }
    fixtures.docs = [{ slug: ['api', 'overview'], href: '/api/overview' }]
    fixtures.renderDoc.mockRejectedValueOnce(new Error(reason))
    await expect(LocaleApiReferencePage({ params: Promise.resolve({ locale: 'fr' }) })).rejects.toThrow(reason)
  })

  it('preserves localized child redirects when no root source exists', async () => {
    fixtures.docs = [{ slug: ['api', 'overview'], href: '/api/overview' }]
    await expect(LocaleApiReferencePage({ params: Promise.resolve({ locale: 'fr' }) })).rejects.toThrow('redirect:/fr/api/overview')
  })
})
