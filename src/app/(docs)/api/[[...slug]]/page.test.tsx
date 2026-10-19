/** Endpoint pages apply the docs.json title separator like prose pages. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const specLink = vi.hoisted(() => ({ visible: true }))
const fixtures = vi.hoisted(() => ({
  source: null as null | object,
  docs: [] as Array<{ slug: string[]; href: string }>,
  nodes: [] as Array<{ slug: string[]; href: string }>,
  renderDoc: vi.fn<(props: { params: Promise<{ slug: string[] }> }) => Promise<null>>(async () => null),
  metadata: vi.fn<(props: { params: Promise<{ slug: string[] }> }) => Promise<{ title: string }>>(async () => ({ title: 'Authored API' })),
}))
vi.mock('@/lib/content-source', () => ({ isRemoteContentSource: () => false, getContentSource: () => ({ kind: 'filesystem' }) }))
vi.mock('@/lib/i18n/translation-source', () => ({ findDocSource: vi.fn(async () => fixtures.source) }))
vi.mock('next/navigation', () => ({ redirect: (href: string) => { throw new Error(`redirect:${href}`) }, notFound: () => { throw new Error('not-found') } }))

vi.mock('@/app/(docs)/[[...slug]]/page', () => ({ default: fixtures.renderDoc, generateMetadata: fixtures.metadata }))
vi.mock('@/data/api-reference', () => ({
  getApiOperationBySlug: vi.fn(async (slug?: string[]) => !slug?.length ? null : ({
    href: '/api/default/analytics/query/post',
    operation: { title: 'Query analytics data', method: 'POST', path: '/analytics/query', specId: 'default' },
  })),
  getAllApiOperationNodes: vi.fn(async () => fixtures.nodes),
  getApiOperationNodes: vi.fn(async () => fixtures.nodes),
}))
vi.mock('@/data/docs', () => ({
  getApiPlaygroundDisplay: () => undefined,
  getApiSpecLinkVisible: () => specLink.visible,
  getBreadcrumbs: () => [],
  getDocEntries: () => fixtures.docs,
  loadDocEntries: async () => fixtures.docs,
  getSeoConfig: () => ({ titleSeparator: ' - ' }),
}))
vi.mock('@/lib/site-url', () => ({ getSiteUrl: () => 'https://docs.example.test' }))
vi.mock('@/config/api-reference', () => ({ apiReferenceConfig: { defaultSpecId: 'default' }, getOpenApiSpecUrl: () => 'https://docs.example.test/openapi.json' }))
vi.mock('@/lib/site-config', () => ({ resolveBuildSiteConfig: () => ({ name: 'OpenRouter' }) }))
vi.mock('@/lib/navigation-snapshot-server', () => ({ loadNavigationSnapshot: async (scope: string) => ({ schemaVersion: 1, scope, mode: 'inline', collections: [], viewKey: 'anonymous', snapshotId: 'fixture' }) }))

import ApiReferencePage, { generateMetadata, generateStaticParams } from './page'

describe('API endpoint metadata', () => {
  it('uses the configured title separator for the full title', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: ['default', 'analytics', 'query', 'post'] }) })
    expect(metadata.title).toEqual({ absolute: 'Query analytics data - OpenRouter' })
  })

  it('shows the visible spec link by default and hides it with api.specLink false', async () => {
    const params = Promise.resolve({ slug: ['default', 'analytics', 'query', 'post'] })
    specLink.visible = true
    expect(JSON.stringify(await ApiReferencePage({ params }))).toContain('OpenAPI specification:')
    specLink.visible = false
    expect(JSON.stringify(await ApiReferencePage({ params }))).not.toContain('OpenAPI specification:')
  })
})


describe('authored API root routing', () => {
  beforeEach(() => {
    fixtures.source = null
    fixtures.docs = []
    fixtures.nodes = []
    fixtures.renderDoc.mockClear()
    fixtures.metadata.mockClear()
  })

  it('renders the authored root before nested-page and generated-operation redirects', async () => {
    fixtures.source = { filePath: 'src/content/api.mdx', isFallback: false }
    fixtures.docs = [{ slug: ['api'], href: '/api' }, { slug: ['api', 'overview'], href: '/api/overview' }]
    fixtures.nodes = [{ slug: ['default', 'get'], href: '/api/default/get' }]
    await ApiReferencePage({ params: Promise.resolve({}) })
    expect(await fixtures.renderDoc.mock.calls[0]![0].params).toEqual({ slug: ['api'] })
    expect(await generateMetadata({ params: Promise.resolve({}) })).toEqual({ title: 'Authored API' })
    expect(await generateStaticParams()).toContainEqual({ slug: [] })
  })

  it.each(['reader-policy-denied', 'publication-denied'])('keeps the document renderer responsible for denying an authored root: %s', async reason => {
    fixtures.source = { filePath: 'src/content/api.mdx', isFallback: false }
    fixtures.docs = [{ slug: ['api', 'overview'], href: '/api/overview' }]
    fixtures.renderDoc.mockRejectedValueOnce(new Error(reason))
    await expect(ApiReferencePage({ params: Promise.resolve({ slug: [] }) })).rejects.toThrow(reason)
  })

  it('keeps existing child and operation redirects when no authored root exists', async () => {
    fixtures.docs = [{ slug: ['api', 'overview'], href: '/api/overview' }]
    await expect(ApiReferencePage({ params: Promise.resolve({}) })).rejects.toThrow('redirect:/api/overview')
    fixtures.docs = []
    fixtures.nodes = [{ slug: ['default', 'get'], href: '/api/default/get' }]
    await expect(ApiReferencePage({ params: Promise.resolve({}) })).rejects.toThrow('redirect:/api/default/get')
  })
})
