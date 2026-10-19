/** A page whose `openapi:` frontmatter cannot be resolved keeps its authored body. */
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({ eyebrowMode: 'group', lookup: { node: null, reason: 'unresolved' } as unknown, missing: false, privateIntro: false, privateDefault: false, root: vi.fn(), description: '', descriptionPlacement: undefined as 'body' | 'operation' | undefined, header: vi.fn(), og: vi.fn<(input: unknown) => string>(() => ''), jsonLd: vi.fn<(input: unknown) => object>(() => ({})) }))

vi.mock('next/navigation', () => ({
  redirect: (path: string) => { throw new Error(`NEXT_REDIRECT:${path}`) },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
vi.mock('@/data/get-doc', () => ({
  getDocFromParams: async () => fixtures.missing ? null : ({
    id: 'api-reference/endpoint/scrape',
    title: 'Scrape',
    description: fixtures.description,
    descriptionPlacement: fixtures.descriptionPlacement,
    slug: ['api-reference', 'endpoint', 'scrape'],
    keywords: [],
    lastUpdated: '2026-01-01',
    component: () => <p>Authored scrape body</p>,
    openapi: { specId: 'default', specRef: 'openapi/missing.json', method: 'POST', path: '/scrape' },
    access: { groupSets: [], isMalformed: false, isPublic: !fixtures.privateIntro },
  }),
}))
vi.mock('@/lib/document-root-redirect', () => ({ loadRootDocumentRedirect: (...args: unknown[]) => fixtures.root(...args) }))
vi.mock('@/lib/reader-auth/context', () => ({ getReaderContext: async () => ({ isAuthenticated: false, groups: [], source: 'anonymous' }) }))
vi.mock('@/lib/reader-auth/config', () => ({ getReaderAuthConfig: () => ({ isEnabled: fixtures.privateDefault, defaultVisibility: fixtures.privateDefault ? 'private' : 'public' }), isReaderAuthActive: () => fixtures.privateDefault }))
vi.mock('@/data/api-reference', () => ({ lookupApiOperationForFrontmatter: async () => fixtures.lookup }))
vi.mock('@/data/docs', () => ({
  ensureDocPublication: async () => undefined,
  getApiPlaygroundDisplay: () => undefined,
  getDocEntries: async () => [],
  getEyebrowMode: () => fixtures.eyebrowMode,
  getSeoConfig: () => ({ titleSeparator: ' - ' }),
  isDocPublished: () => true,
  canReaderViewPage: async () => true,
  loadNavContext: async () => ({ group: 'Capacity', groupPath: ['Errors', 'Capacity'], breadcrumb: [], prev: { title: 'Previous page', href: '/prev' }, next: null }),
}))
vi.mock('@/components/docs/doc-layout', () => ({ DocLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))
vi.mock('@/components/docs/doc-pagination', () => ({ DocPagination: ({ prev }: { prev: { title: string } | null }) => <nav>{prev?.title}</nav> }))
vi.mock('@/components/docs/doc-header', () => ({ DocHeader: ({ eyebrow, showDescription }: { eyebrow?: unknown; showDescription?: boolean }) => { fixtures.header({ showDescription }); return <i data-eyebrow={JSON.stringify(eyebrow)} /> } }))
vi.mock('@/components/api/api-layout', () => ({ ApiLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/api/operation-panel', async () => {
  const { Markdown } = await import('@/components/mdx/markdown')
  return { OperationPanel: ({ children, operation, showDescription = true }: { children: React.ReactNode; operation: { description?: string }; showDescription?: boolean }) => (
    <section>{showDescription && operation.description ? <Markdown>{operation.description}</Markdown> : null}{children}</section>
  ) }
})
vi.mock('@/components/api/manual-api-endpoint', () => ({ ManualApiEndpoint: () => null }))
vi.mock('@/components/seo/json-ld-script', () => ({ JsonLdScript: () => null }))
vi.mock('@/components/layout/localized-sidebar-hydrator', () => ({ LocalizedSidebarHydrator: () => null }))
vi.mock('@/components/layout/locale-availability', () => ({ LocaleAvailabilityHydrator: () => null }))
vi.mock('@/components/docs/locale-fallback-banner', () => ({ LocaleFallbackBanner: () => null }))
vi.mock('@/components/docs/locale-stale-banner', () => ({ LocaleStaleBanner: () => null }))
vi.mock('@/lib/i18n/request', () => ({ getEffectiveI18nConfig: async () => ({ defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'fr' }] }) }))
vi.mock('@/lib/i18n/content', () => ({ getContentI18nConfig: async () => ({ locales: [] }) }))
vi.mock('@/lib/i18n/navigation', () => ({ localizeDocNavigation: async (nav: unknown) => nav }))
vi.mock('@/lib/i18n/translation-source', () => ({ hasDocTranslation: async () => false }))
vi.mock('@/lib/site-url', () => ({ getSiteUrl: () => 'https://docs.example.test' }))
vi.mock('@/lib/site-config', () => ({ resolveBuildSiteConfig: () => ({ name: 'Docs' }) }))
vi.mock('@/lib/content-source', () => ({ isRemoteContentSource: () => false }))
vi.mock('@/lib/agent-discovery', () => ({ buildAgentAlternateLinks: () => ({}) }))
vi.mock('@/lib/og', () => ({ buildOgImageUrl: (input: unknown) => fixtures.og(input), formatOgBreadcrumb: () => '', formatOgDisplayUrl: () => '' }))
vi.mock('@/lib/i18n/metadata', () => ({ buildLocaleAlternates: () => ({}) }))
vi.mock('@/lib/json-ld', () => ({ buildDocPageJsonLd: (input: unknown) => fixtures.jsonLd(input) }))

import DocsPage, { generateMetadata } from './page'

beforeEach(() => { fixtures.header.mockClear(); fixtures.descriptionPlacement = undefined; fixtures.description = ''; fixtures.eyebrowMode = 'group'; fixtures.missing = false; fixtures.privateIntro = false; fixtures.privateDefault = false; fixtures.lookup = { node: null, reason: 'unresolved' }; fixtures.root.mockReset().mockResolvedValue('/docs') })

const render = async () => renderToStaticMarkup(await DocsPage({ params: Promise.resolve({ slug: ['api-reference', 'endpoint', 'scrape'] }) }))

describe('docs page with an unresolved openapi spec', () => {
  it('renders the authored body with a notice when the spec or operation cannot be found', async () => {
    fixtures.lookup = { node: null, reason: 'unresolved' }
    const html = await render()
    expect(html).toContain('Authored scrape body')
    expect(html).toContain('role="note"')
  })

  it('renders the page body inside the operation panel when the operation resolves', async () => {
    fixtures.lookup = { node: { operation: {} } }
    const html = await render()
    expect(html).toContain('<section><p>Authored scrape body</p></section>')
    expect(html).not.toContain('role="note"')
    expect(html).toContain('Previous page')
  })

  it('gives the header the nearest group, or the whole group path when docs.json sets eyebrow to path', async () => {
    fixtures.lookup = { node: { operation: {} } }
    expect(await render()).toContain('data-eyebrow="&quot;Capacity&quot;"')
    fixtures.eyebrowMode = 'path'
    expect(await render()).toContain('data-eyebrow="[&quot;Errors&quot;,&quot;Capacity&quot;]"')
  })

  it('404s a hidden or excluded operation even when the page is listed as published', async () => {
    fixtures.lookup = { node: null, reason: 'withheld' }
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
  })
})


for (const slug of [undefined, [], ['fr']]) {
  it(`redirects a missing ${JSON.stringify(slug)} root through the reader-scoped fallback`, async () => {
    fixtures.missing = true
    await expect(DocsPage({ params: Promise.resolve({ slug }) })).rejects.toThrow('NEXT_REDIRECT:/docs')
    expect(fixtures.root).toHaveBeenCalledWith(expect.objectContaining({ locale: slug?.[0] === 'fr' ? 'fr' : undefined, reader: expect.objectContaining({ isAuthenticated: false }) }))
  })
}

it('keeps a present introduction and ordinary missing routes on their existing paths', async () => {
  await DocsPage({ params: Promise.resolve({ slug: [] }) })
  expect(fixtures.root).not.toHaveBeenCalled()
  fixtures.missing = true
  await expect(DocsPage({ params: Promise.resolve({ slug: ['missing'] }) })).rejects.toThrow('NEXT_NOT_FOUND')
  expect(fixtures.root).not.toHaveBeenCalled()
})

it('never bypasses a private introduction through another visible navigation page', async () => {
  fixtures.privateIntro = true
  await expect(DocsPage({ params: Promise.resolve({ slug: [] }) })).rejects.toThrow('NEXT_NOT_FOUND')
  expect(fixtures.root).not.toHaveBeenCalled()
})

it('retains no-visible-document 404 and private-by-default login behavior', async () => {
  fixtures.missing = true; fixtures.root.mockResolvedValue(null)
  await expect(DocsPage({ params: Promise.resolve({ slug: [] }) })).rejects.toThrow('NEXT_NOT_FOUND')
  fixtures.privateDefault = true
  await expect(DocsPage({ params: Promise.resolve({ slug: [] }) })).rejects.toThrow('NEXT_REDIRECT:/api/reader/login?redirect=%2F')
})

describe('a description with inline code', () => {
  const description = 'The `trigger.dev dev` command is used to run your tasks locally.'
  const plain = 'The trigger.dev dev command is used to run your tasks locally.'
  const params = Promise.resolve({ slug: ['api-reference', 'endpoint', 'scrape'] })

  it('is plain text in the meta, social and preview image tags', async () => {
    fixtures.description = description
    const metadata = await generateMetadata({ params })
    expect(metadata.description).toBe(plain)
    expect(metadata.openGraph?.description).toBe(plain)
    expect(metadata.twitter?.description).toBe(plain)
    expect(fixtures.og).toHaveBeenCalledWith(expect.objectContaining({ description: plain }))
  })

  it('is plain text in the structured data', async () => {
    fixtures.description = description
    fixtures.lookup = { node: { operation: {} } }
    await render()
    expect(fixtures.jsonLd).toHaveBeenCalledWith(expect.objectContaining({ description: plain }))
  })

})

describe('an API page with no description of its own', () => {
  const params = Promise.resolve({ slug: ['api-reference', 'endpoint', 'scrape'] })
  const operation = (description?: string) => ({ node: { operation: { description } } })

  it('is described by its operation, as one plain line, in the meta, social and structured-data tags', async () => {
    fixtures.lookup = operation('Phase 1 of the batch API.\nCreates a **batch** record with `runCount`.\n\nStream [items](/items) next.')
    const expected = 'Phase 1 of the batch API. Creates a batch record with runCount. Stream items next.'
    const metadata = await generateMetadata({ params })
    expect(metadata.description).toBe(expected)
    expect(metadata.openGraph?.description).toBe(expected)
    expect(metadata.twitter?.description).toBe(expected)
    expect(fixtures.og).toHaveBeenCalledWith(expect.objectContaining({ description: expected }))
    await render()
    expect(fixtures.jsonLd).toHaveBeenCalledWith(expect.objectContaining({ description: expected }))
  })

  it('keeps the description it has, and has none when the operation has none or cannot be loaded', async () => {
    fixtures.lookup = operation('From the operation.')
    fixtures.description = 'Authored.'
    expect((await generateMetadata({ params })).description).toBe('Authored.')
    fixtures.description = ''
    fixtures.lookup = operation(undefined)
    expect((await generateMetadata({ params })).description).toBe('')
    fixtures.lookup = { node: null, reason: 'unresolved' }
    expect((await generateMetadata({ params })).description).toBe('')
  })
})


describe('a generated endpoint summary', () => {
  const description = 'Creates a key. The key is shown only once.\n\n**Warning:** Store it before closing this page. Use `{secret}` literally.'

  it('keeps the metadata summary while rendering every paragraph through Markdown', async () => {
    fixtures.description = 'Creates a key.'
    fixtures.descriptionPlacement = 'operation'
    fixtures.lookup = { node: { operation: { description } } }
    const html = await render()
    expect(html).toContain('The key is shown only once.')
    expect(html).toContain('<strong>Warning:</strong> Store it before closing this page.')
    expect(html).toContain('<code>{secret}</code>')
    expect(html.match(/Creates a key\./g)).toHaveLength(1)
    expect(fixtures.header).toHaveBeenCalledWith({ showDescription: false })
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: ['api-reference', 'endpoint', 'scrape'] }) })
    expect(metadata.description).toBe('Creates a key.')
  })

  it('keeps authored description overrides and existing body-placement semantics', async () => {
    fixtures.description = 'Authored explanation.'
    fixtures.lookup = { node: { operation: { description } } }
    expect(await render()).not.toContain('Store it before closing this page.')
    fixtures.descriptionPlacement = 'body'
    expect(await render()).not.toContain('Store it before closing this page.')
  })
})
