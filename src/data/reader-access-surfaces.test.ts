/**
 * Reader access across every projection, end to end on a fixture site.
 *
 * `guides/secret` is restricted to the `beta` group and `guides/staff` to any
 * signed-in reader. Each surface must omit both for an anonymous reader (and
 * answer a direct request exactly like a missing page), and serve the secret
 * page to a reader holding a `beta` agent token or session. MCP page tools and
 * resources and `llms-full.txt` take the request's reader; shared surfaces
 * (search corpus, sitemap) stay anonymous-only: that is the fail-closed
 * default of the shared loaders in `@/data/docs`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const MARKER = 'SECRET-MARKER-7f3a'
const STAFF_MARKER = 'STAFF-MARKER-19bc'

const state = vi.hoisted(() => ({ sources: {} as Record<string, string> }))
const config = vi.hoisted(() => ({
  auth: { mode: 'jwt', default: 'public', loginUrl: 'https://app.example.com/login' },
  markdown: { enabled: true },
  tabs: [{ tab: 'Docs', groups: [{ group: 'Guides', pages: ['introduction', 'guides/open', 'guides/secret', 'guides/staff'] }] }],
}))

vi.mock('@/lib/docs-json-config', () => ({ getDocsJsonConfig: () => config, getDocsJsonConfigRevision: () => 1 }))
vi.mock('@/lib/runtime-sources', () => ({
  listRuntimeSources: () => Object.keys(state.sources),
  readRuntimeSource: (file: string) => state.sources[file],
  runtimeSourceExists: (file: string) => file in state.sources,
  runtimeSourceModifiedAt: () => null,
}))
vi.mock('@/lib/content-index', () => ({ getContentIndex: () => null, loadContentIndex: async () => null, isIndexedContentPath: () => false }))
vi.mock('@/config/api-reference', () => ({ apiReferenceConfig: { defaultSpecId: 'default', specs: [] }, getOpenApiSpecUrl: () => null }))
vi.mock('@/data/api-reference', () => ({
  getAllApiOperationNodes: async () => [],
  servedSpecPathForFrontmatter: async () => undefined,
  withApiNavigation: async (collections: unknown) => collections,
}))
vi.mock('@/lib/cloud-link/client', () => ({ getCloudSiteConfig: async () => null }))
vi.mock('@/lib/cloud-link/request', () => ({ getRequestOrigin: async () => 'https://docs.example.com' }))
vi.mock('@/lib/i18n/request', () => {
  const i18n = { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] }
  return { getEffectiveI18nConfig: async () => i18n, getRepositoryI18nConfig: () => i18n }
})
vi.mock('@/lib/site-config', () => {
  const site = { name: 'Docs', description: 'Fixture docs', repoUrl: '', links: [] }
  return { resolveSiteConfig: async () => site, resolveRequestSiteConfig: async () => site, resolveBuildSiteConfig: () => site, siteIdentity: () => site }
})

const page = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n\n${body}\n`

let betaToken = ''
let betaCookie = ''

beforeAll(async () => {
  vi.stubEnv('THALLY_READER_SESSION_SECRET', 's'.repeat(40))
  vi.stubEnv('THALLY_READER_TOKEN_KEYS', `k1:${'t'.repeat(40)}`)
  vi.stubEnv('THALLY_SITE_URL', 'https://docs.example.com')
  state.sources = {
    'src/content/introduction.mdx': page('title: Introduction\npublic: true', 'Welcome.'),
    'src/content/guides/open.mdx': page('title: Open guide\ndescription: Anyone may read this', 'Open body.'),
    'src/content/guides/secret.mdx': page('title: Secret roadmap\ndescription: Beta-only plans\ngroups: [beta]', `Beta content ${MARKER}.`),
    'src/content/guides/staff.mdx': page('title: Staff handbook\npublic: false', `Staff content ${STAFF_MARKER}.`),
  }
  const { mintAgentToken, signReaderSession } = await import('@/lib/reader-auth/session')
  betaToken = (await mintAgentToken({ label: 'ci', groups: ['beta'], expiresInSeconds: 3600 })).token
  betaCookie = (await signReaderSession({ subject: 'u1', groups: ['beta'] }))!.token
})

afterAll(() => vi.unstubAllEnvs())

beforeEach(async () => {
  const { resetReaderAuthConfigForTests } = await import('@/lib/reader-auth/config')
  resetReaderAuthConfigForTests()
})

const anonymous = (path: string) => new NextRequest(`https://docs.example.com${path}`)
const withToken = (path: string) => new NextRequest(`https://docs.example.com${path}`, { headers: { authorization: `Bearer ${betaToken}` } })
const withCookie = (path: string) => new NextRequest(`https://docs.example.com${path}`, { headers: { cookie: `thally_reader=${betaCookie}` } })

describe('shared loaders', () => {
  it('list restricted pages only for a reader allowed to open them', async () => {
    const { loadDocEntries, getDocEntries, getSidebarCollections } = await import('@/data/docs')
    const { resolveReader } = await import('@/lib/reader-auth/context')
    const ids = (entries: Array<{ id: string }>) => entries.map((entry) => entry.id).sort()
    expect(ids(await loadDocEntries())).toEqual(['guides/open', 'introduction'])
    expect(ids(getDocEntries())).toEqual(['guides/open', 'introduction'])
    const beta = await resolveReader(`Bearer ${betaToken}`, null)
    expect(ids(await loadDocEntries(beta))).toEqual(['guides/open', 'guides/secret', 'guides/staff', 'introduction'])

    const titles = (reader?: typeof beta) => JSON.stringify(getSidebarCollections(undefined, reader))
    expect(titles()).not.toContain('Secret roadmap')
    expect(titles()).not.toContain('Staff handbook')
    expect(titles(beta)).toContain('Secret roadmap')
  })

  it('prev/next and breadcrumbs never point an anonymous reader at a restricted page', async () => {
    const { getNavContext } = await import('@/data/docs')
    const nav = getNavContext('guides/open')
    expect(JSON.stringify(nav)).not.toContain('Secret roadmap')
  })
})

describe('reader-aware projections', () => {
  it('/api/docs/* answers a restricted page like a missing one', async () => {
    const { GET } = await import('@/app/api/docs/[...slug]/route')
    const params = { params: Promise.resolve({ slug: ['guides', 'secret'] }) }
    const denied = await GET(anonymous('/api/docs/guides/secret?format=json'), params)
    const missing = await GET(anonymous('/api/docs/guides/nope?format=json'), { params: Promise.resolve({ slug: ['guides', 'nope'] }) })
    expect(denied.status).toBe(404)
    const deniedBody = await denied.text()
    expect(deniedBody).not.toContain(MARKER)
    expect(deniedBody).not.toContain('Secret roadmap')
    // Suggestions are drawn from visible pages only (the echoed request path aside).
    expect(JSON.parse(deniedBody).did_you_mean).toEqual([])
    expect(missing.status).toBe(404)

    const allowed = await GET(withToken('/api/docs/guides/secret?format=json'), params)
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain(MARKER)
    expect(allowed.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('the .md mirror (/api/markdown) 404s for anonymous readers and serves allowed ones', async () => {
    const { GET } = await import('@/app/api/markdown/[...slug]/route')
    const params = () => ({ params: Promise.resolve({ slug: ['guides', 'secret'] }) })
    expect((await GET(anonymous('/api/markdown/guides/secret'), params())).status).toBe(404)
    const allowed = await GET(withCookie('/api/markdown/guides/secret'), params())
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain(MARKER)
    expect(allowed.headers.get('Cache-Control')).toBe('private, no-store')
    expect((await GET(withToken('/api/markdown/guides/staff'), { params: Promise.resolve({ slug: ['guides', 'staff'] }) })).status).toBe(200)
  })

  it('llms.txt lists the page only for an allowed reader', async () => {
    const { GET } = await import('@/app/llms.txt/route')
    const anon = await (await GET(anonymous('/llms.txt'))).text()
    expect(anon).toContain('Open guide')
    expect(anon).not.toContain('Secret roadmap')
    expect(anon).not.toContain('Staff handbook')
    expect(await (await GET(withToken('/llms.txt'))).text()).toContain('Secret roadmap')
  })

  it('/api/docs-index lists the page only for an allowed reader', async () => {
    const { GET } = await import('@/app/api/docs-index/route')
    const anon = await (await GET(anonymous('/api/docs-index'))).text()
    expect(anon).not.toContain('guides/secret')
    expect(anon).not.toContain('guides/staff')
    const allowed = await GET(withToken('/api/docs-index'))
    expect(await allowed.text()).toContain('guides/secret')
    expect(allowed.headers.get('Cache-Control')).toBe('private, no-store')
  })
  it('lazy navigation uses the same real reader filter and never public-caches private views', async () => {
    const { GET } = await import('@/app/api/docs-index/route')
    const path = '/api/docs-index?view=navigation&scope=default'
    const anonymousResponse = await GET(anonymous(path))
    const anon = await anonymousResponse.text()
    expect(anon).toContain('Open guide')
    expect(anon).not.toContain('Secret roadmap')
    expect(anon).not.toContain('Staff handbook')
    const allowed = await GET(withCookie(path))
    const body = await allowed.json()
    expect(JSON.stringify(body)).toContain('Secret roadmap')
    expect(JSON.stringify(body)).toContain('Staff handbook')
    expect(allowed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const deniedRevision = await GET(anonymous(`${path}&revision=${body.revision}`))
    expect(deniedRevision.status).toBe(409)
    expect(await deniedRevision.text()).not.toContain('Secret roadmap')
    expect(deniedRevision.headers.get('Cache-Control')).toBe('private, no-store')
  })

})

describe('anonymous-only projections (shared, so never reader-specific)', () => {
  it('the search corpus never contains a restricted page', async () => {
    await import('@/lib/search/register-doc-source')
    const { resolveDocEntries, resolveDocEntriesAsync } = await import('@thallylabs/core/registry')
    const ids = (entries: Array<{ id: string }>) => entries.map((entry) => entry.id)
    expect(ids(resolveDocEntries())).not.toContain('guides/secret')
    expect(ids(await resolveDocEntriesAsync())).not.toContain('guides/secret')
    expect(ids(await resolveDocEntriesAsync())).not.toContain('guides/staff')
  })

  it('MCP search_docs stays anonymous even for a signed-in reader', async () => {
    const { getSiteTool } = await import('@/lib/mcp/site-tools')
    const { resolveReader } = await import('@/lib/reader-auth/context')
    const beta = await resolveReader(`Bearer ${betaToken}`, null)
    const result = await getSiteTool('search_docs')!.handler({ query: 'Secret roadmap' }, { origin: 'https://docs.example.com', reader: beta })
    expect(JSON.stringify(result)).not.toContain('guides/secret')
  })
})

describe('reader-aware agent projections (MCP, llms-full.txt)', () => {
  const origin = 'https://docs.example.com'

  it('MCP list_pages and read_page expose a restricted page only to an allowed reader', async () => {
    const { getSiteTool } = await import('@/lib/mcp/site-tools')
    const { resolveReader } = await import('@/lib/reader-auth/context')
    const beta = await resolveReader(`Bearer ${betaToken}`, null)

    const anonymousList = JSON.stringify(await getSiteTool('list_pages')!.handler({}, { origin }))
    expect(anonymousList).toContain('guides/open')
    expect(anonymousList).not.toContain('guides/secret')
    expect(anonymousList).not.toContain('guides/staff')
    const betaList = JSON.stringify(await getSiteTool('list_pages')!.handler({}, { origin, reader: beta }))
    expect(betaList).toContain('guides/secret')
    expect(betaList).toContain('guides/staff')

    // Denied reads look exactly like a missing page.
    await expect(getSiteTool('read_page')!.handler({ pageId: 'guides/secret' }, { origin })).rejects.toThrow(/No page found/)
    const read = await getSiteTool('read_page')!.handler({ pageId: 'guides/secret' }, { origin, reader: beta })
    expect(read.text).toContain(MARKER)
  })

  it('MCP resources honor the reader for listing and reading', async () => {
    const { listResources, readResource } = await import('@/lib/mcp/site-resources')
    const { resolveReader } = await import('@/lib/reader-auth/context')
    const beta = await resolveReader(`Bearer ${betaToken}`, null)
    expect(JSON.stringify(await listResources(undefined))).not.toContain('guides/secret')
    expect(JSON.stringify(await listResources(undefined, beta))).toContain('docs://pages/guides/secret')
    expect(await readResource('docs://pages/guides/secret', origin)).toBeNull()
    expect((await readResource('docs://pages/guides/secret', origin, beta))?.text).toContain(MARKER)
  })

  it('llms-full.txt includes restricted content only for an allowed reader, never shared-cached', async () => {
    const { GET } = await import('@/app/llms-full.txt/route')
    const anon = await GET(anonymous('/llms-full.txt'))
    const anonBody = await anon.text()
    expect(anonBody).toContain('Open body')
    expect(anonBody).not.toContain(MARKER)
    expect(anonBody).not.toContain(STAFF_MARKER)
    expect(anon.headers.get('Cache-Control')).toBe('private, no-store')

    const allowed = await (await GET(withToken('/llms-full.txt'))).text()
    expect(allowed).toContain(MARKER)
    expect(allowed).toContain(STAFF_MARKER)
  })
})

describe('crawler and build surfaces', () => {
  it('the sitemap only announces pages an anonymous crawler may open', async () => {
    const { default: sitemap } = await import('@/app/sitemap')
    const urls = (await sitemap()).map((entry) => entry.url)
    expect(urls).toContain('https://docs.example.com/guides/open')
    expect(urls.some((url) => url.includes('guides/secret') || url.includes('guides/staff'))).toBe(false)
  })

  it('static generation never prerenders a restricted page and renders per request under reader auth', async () => {
    const { generateStaticParams } = await import('@/app/(docs)/[[...slug]]/page')
    expect(await generateStaticParams()).toEqual([{ slug: [] }])
  }, 60_000)
})
