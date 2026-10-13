/**
 * Reader access on the agent surfaces that arrived with the MCP v2 tools:
 * changelog entries (`list_changes`, feeds), localized MCP reads, the MCP
 * endpoint itself with an agent token, and generated API operations on a
 * private-by-default site (MCP API tools and resources, search records).
 *
 * `beta/changelog` is restricted to the `beta` group, and the French
 * translations of `changelog` and `guides/open` restrict pages that are open
 * in English. Anonymous callers must never see either; a `beta` token must.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const MARKER = 'BETA-CHANGE-5d21'
const FR_MARKER = 'FR-RESTRICTED-8c0e'
const ORIGIN = 'https://docs.example.com'

const state = vi.hoisted(() => ({ sources: {} as Record<string, string> }))
const config = vi.hoisted(() => ({
  auth: { mode: 'jwt', default: 'public' },
  markdown: { enabled: true },
  i18n: { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] },
  tabs: [{ tab: 'Docs', groups: [{ group: 'Guides', pages: ['introduction', 'guides/open', 'changelog', 'beta/changelog'] }] }],
}))
const operationNode = vi.hoisted(() => ({
  slug: ['default', 'widgets', 'get'],
  href: '/api/default/widgets/get',
  operation: { title: 'List widgets', method: 'GET', path: '/widgets', tags: ['Widgets'], parameters: { path: [], query: [], header: [], cookie: [] } },
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
  getAllApiOperationNodes: async () => [operationNode],
  getApiOperationBySlug: async (slug: Array<string>) => slug.join('/') === 'widgets/get' ? operationNode : null,
  getApiOperationSearchIndex: async () => [{
    id: operationNode.slug.join('/'),
    type: 'api_operation',
    title: operationNode.operation.title,
    description: 'Return every widget in the account.',
    href: operationNode.href,
    keywords: ['Widgets'],
    body: '/widgets Widgets',
    method: 'GET',
    path: '/widgets',
  }],
  servedSpecPathForFrontmatter: async () => undefined,
  withApiNavigation: async (collections: unknown) => collections,
}))
vi.mock('@/lib/cloud-link/client', () => ({ getCloudSiteConfig: async () => null }))
vi.mock('@/lib/i18n/request', () => {
  const i18n = { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] }
  return { getEffectiveI18nConfig: async () => i18n, getRepositoryI18nConfig: () => i18n }
})
vi.mock('@/lib/site-config', () => {
  const site = { name: 'Docs', description: 'Fixture docs', repoUrl: '', links: [] }
  return { resolveSiteConfig: async () => site, resolveRequestSiteConfig: async () => site, resolveBuildSiteConfig: () => site, siteIdentity: () => site }
})
vi.mock('@/lib/admin/settings', () => ({ getAdminSettings: async () => ({ mcpEnabled: true }) }))
vi.mock('@/lib/storage', () => ({ getStorage: () => ({ kvIncrement: async () => ({ count: 1 }) }) }))

let betaToken = ''

beforeAll(async () => {
  vi.stubEnv('THALLY_READER_SESSION_SECRET', 's'.repeat(40))
  vi.stubEnv('THALLY_READER_TOKEN_KEYS', `k1:${'t'.repeat(40)}`)
  vi.stubEnv('THALLY_SITE_URL', ORIGIN)
  state.sources = {
    'src/content/introduction.mdx': '---\ntitle: Introduction\npublic: true\n---\nWelcome.\n',
    'src/content/guides/open.mdx': '---\ntitle: Open guide\n---\nOpen body.\n',
    'src/content/fr/guides/open.mdx': `---\ntitle: Guide restreint\ngroups: [beta]\n---\n${FR_MARKER} guide\n`,
    'src/content/changelog.mdx': '---\ntitle: Changelog\n---\n\n<Update label="v2" date="2026-06-01">\nOpen change shipped.\n</Update>\n',
    'src/content/fr/changelog.mdx': `---\ntitle: Journal\ngroups: [beta]\n---\n\n<Update label="fr" date="2026-06-03">\n${FR_MARKER} changement\n</Update>\n`,
    'src/content/beta/changelog.mdx': `---\ntitle: Beta changelog\ngroups: [beta]\n---\n\n<Update label="beta-1" date="2026-06-02">\n${MARKER} shipped to beta.\n</Update>\n`,
  }
  const { mintAgentToken } = await import('@/lib/reader-auth/session')
  betaToken = (await mintAgentToken({ label: 'ci', groups: ['beta'], expiresInSeconds: 3600 })).token
})

afterAll(() => vi.unstubAllEnvs())

beforeEach(async () => {
  const { resetReaderAuthConfigForTests } = await import('@/lib/reader-auth/config')
  resetReaderAuthConfigForTests()
})

async function betaReader() {
  const { resolveReader } = await import('@/lib/reader-auth/context')
  return resolveReader(`Bearer ${betaToken}`, null)
}

describe('changelog', () => {
  it('list_changes includes a gated changelog page only for an allowed reader', async () => {
    const { getSiteTool } = await import('@/lib/mcp/site-tools')
    const anonymous = JSON.stringify(await getSiteTool('list_changes')!.handler({}, { origin: ORIGIN }))
    expect(anonymous).toContain('Open change shipped')
    expect(anonymous).not.toContain(MARKER)
    const beta = JSON.stringify(await getSiteTool('list_changes')!.handler({}, { origin: ORIGIN, reader: await betaReader() }))
    expect(beta).toContain(MARKER)
  })

  it('a localized changelog whose translation restricts the page is withheld', async () => {
    const { getSiteTool } = await import('@/lib/mcp/site-tools')
    const anonymous = JSON.stringify(await getSiteTool('list_changes')!.handler({ locale: 'fr' }, { origin: ORIGIN }))
    expect(anonymous).not.toContain(FR_MARKER)
    expect(anonymous).not.toContain(MARKER)
    const beta = JSON.stringify(await getSiteTool('list_changes')!.handler({ locale: 'fr' }, { origin: ORIGIN, reader: await betaReader() }))
    expect(beta).toContain(FR_MARKER)
  })

  it('the feeds stay anonymous, whoever asks', async () => {
    const { GET: rss } = await import('@/app/changelog/rss.xml/route')
    const { GET: json } = await import('@/app/changelog/feed.json/route')
    const headers = { authorization: `Bearer ${betaToken}` }
    const rssBody = await (await rss(new Request(`${ORIGIN}/changelog/rss.xml`, { headers }))).text()
    const jsonBody = await (await json(new Request(`${ORIGIN}/changelog/feed.json`, { headers }))).text()
    expect(rssBody).toContain('Open change shipped')
    for (const body of [rssBody, jsonBody]) {
      expect(body).not.toContain(MARKER)
      expect(body).not.toContain(FR_MARKER)
    }
  })
})

describe('localized MCP reads', () => {
  it('read_page applies a translation that restricts an open page', async () => {
    const { getSiteTool } = await import('@/lib/mcp/site-tools')
    await expect(getSiteTool('read_page')!.handler({ pageId: 'guides/open', locale: 'fr' }, { origin: ORIGIN })).rejects.toThrow(/No page found/)
    const read = await getSiteTool('read_page')!.handler({ pageId: 'guides/open', locale: 'fr' }, { origin: ORIGIN, reader: await betaReader() })
    expect(read.text).toContain(FR_MARKER)
    // The English page stays open to everyone.
    expect((await getSiteTool('read_page')!.handler({ pageId: 'guides/open' }, { origin: ORIGIN })).text).toContain('Open body')
  })

  it('list_pages for a locale omits a page whose translation restricts it', async () => {
    const { getSiteTool } = await import('@/lib/mcp/site-tools')
    expect(JSON.stringify(await getSiteTool('list_pages')!.handler({ locale: 'fr' }, { origin: ORIGIN }))).not.toContain('Guide restreint')
    expect(JSON.stringify(await getSiteTool('list_pages')!.handler({ locale: 'fr' }, { origin: ORIGIN, reader: await betaReader() }))).toContain('Guide restreint')
  })
})

describe('MCP endpoint with an agent token', () => {
  async function call(method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
    const { POST } = await import('@/app/api/mcp/route')
    const response = await POST(new NextRequest(`${ORIGIN}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }))
    return JSON.stringify(await response.json())
  }
  const bearer = () => ({ authorization: `Bearer ${betaToken}` })

  it('passes the verified reader to page tools and resources', async () => {
    expect(await call('tools/call', { name: 'list_pages', arguments: {} })).not.toContain('beta/changelog')
    expect(await call('tools/call', { name: 'list_pages', arguments: {} }, bearer())).toContain('beta/changelog')
    expect(await call('tools/call', { name: 'read_page', arguments: { pageId: 'beta/changelog' } })).not.toContain(MARKER)
    expect(await call('tools/call', { name: 'read_page', arguments: { pageId: 'beta/changelog' } }, bearer())).toContain(MARKER)
    expect(await call('resources/list', {})).not.toContain('beta/changelog')
    expect(await call('resources/list', {}, bearer())).toContain('docs://pages/beta/changelog')
    expect(await call('resources/read', { uri: 'docs://pages/beta/changelog' })).toContain('Resource not found')
    expect(await call('resources/read', { uri: 'docs://pages/beta/changelog' }, bearer())).toContain(MARKER)
    expect(await call('tools/call', { name: 'list_changes', arguments: {} }, bearer())).toContain(MARKER)
  })

  it('ignores a forged or invalid token (anonymous view)', async () => {
    const forged = { authorization: 'Bearer thrt_not-a-real-token' }
    expect(await call('tools/call', { name: 'list_pages', arguments: {} }, forged)).not.toContain('beta/changelog')
  })
})

describe('generated API operations on a private-by-default site', () => {
  beforeEach(async () => {
    const { resetReaderAuthConfigForTests } = await import('@/lib/reader-auth/config')
    const { resetSearchEngine } = await import('@/lib/search/engine')
    config.auth.default = 'private'
    resetReaderAuthConfigForTests()
    resetSearchEngine()
  })

  afterEach(async () => {
    const { resetReaderAuthConfigForTests } = await import('@/lib/reader-auth/config')
    const { resetSearchEngine } = await import('@/lib/search/engine')
    config.auth.default = 'public'
    resetReaderAuthConfigForTests()
    resetSearchEngine()
  })

  it('MCP API tools and resources hide operations from anonymous callers', async () => {
    const { getSiteTool, loadVisibleApiOperationNodes } = await import('@/lib/mcp/site-tools')
    const { readResource } = await import('@/lib/mcp/site-resources')
    expect(await loadVisibleApiOperationNodes()).toEqual([])
    expect(await loadVisibleApiOperationNodes(await betaReader())).toHaveLength(1)
    const listed = await getSiteTool('list_api_operations')!.handler({}, { origin: ORIGIN })
    expect(listed.structured.total).toBe(0)
    await expect(getSiteTool('get_api_operation')!.handler({ method: 'GET', path: '/widgets' }, { origin: ORIGIN })).rejects.toThrow(/No published API operation/)
    expect(await readResource('docs://api/default/widgets/get', ORIGIN)).toBeNull()
    await expect(getSiteTool('get_api_operation')!.handler({ operationId: 'api/widgets/get' }, { origin: ORIGIN })).rejects.toThrow(/No published API operation/)
    await expect(getSiteTool('get_api_operation')!.handler({ operationId: '/api/widgets/get' }, { origin: ORIGIN })).rejects.toThrow(/No published API operation/)
  })

  it('the anonymous search corpus carries no API operation records', async () => {
    const { searchDocs } = await import('@/lib/search/engine')
    const hits = await searchDocs('widgets', { mode: 'fulltext', limit: 10 })
    expect(hits.some((hit) => hit.type === 'api_operation')).toBe(false)
  })

  it('a public site still indexes them (control)', async () => {
    const { resetReaderAuthConfigForTests } = await import('@/lib/reader-auth/config')
    config.auth.default = 'public'
    resetReaderAuthConfigForTests()
    const { searchDocs } = await import('@/lib/search/engine')
    const hits = await searchDocs('widgets', { mode: 'fulltext', limit: 10 })
    expect(hits.some((hit) => hit.type === 'api_operation')).toBe(true)
  })
})
