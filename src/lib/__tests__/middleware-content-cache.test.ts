/**
 * Managed content cache headers: under THALLY_CONTENT_SOURCE=assets, doc
 * responses must carry `Cache-Tag: site:{siteId}` (the purge handle for
 * content publishes). Only unambiguous full HTML and machine projections may
 * receive a long CDN TTL; browser paths without that evidence stay tag-only.
 * Headers must not leak onto admin surfaces, non-content APIs, gated sites, or
 * the default filesystem mode. Routing assertions cover the same edge paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/admin/auth-edge', () => ({
  ADMIN_SESSION_COOKIE: 'admin-session',
  DOCS_ACCESS_COOKIE: 'docs-access',
  getInternalAnalyticsSecretEdge: () => 'analytics-secret',
  isAdminAuthenticatedEdge: vi.fn().mockResolvedValue(false),
  isAdminEnabledEdge: vi.fn().mockReturnValue(false),
  isDocsAccessEnabledEdge: vi.fn().mockReturnValue(false),
  isDocsAccessGrantedEdge: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/auth/session', () => ({
  SESSION_COOKIE: 'session',
  verifySession: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/traffic-classifier', () => ({
  // Doc-page paths are tracked, so the analytics branch runs during these
  // tests — the classification must be shaped, and fetch is stubbed below.
  classifyRequest: vi
    .fn()
    .mockReturnValue({ visitorType: 'human', agentSignal: null, format: 'html' }),
  isAgentRequest: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/agent-endpoints', () => ({
  isAgentDiscoveryEndpoint: vi.fn().mockReturnValue(false),
  isContentBearingAgentEndpoint: vi.fn().mockReturnValue(false),
  isMachineEndpoint: vi.fn().mockReturnValue(false),
  isPublicAgentEndpoint: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/site-config', () => ({
  resolveSiteConfig: vi.fn().mockResolvedValue({
    name: 'Example Docs',
    description: 'Example documentation',
    repoUrl: 'https://github.com/example/docs',
    links: [],
  }),
}))

vi.mock('@/lib/cloud-link/edge', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cloud-link/edge')>('@/lib/cloud-link/edge')
  return {
    getCloudAccessConfigEdge: vi.fn().mockResolvedValue(null),
    isCloudAccessConfiguredEdge: vi.fn().mockReturnValue(false),
    // Real implementation: it only parses THALLY_CLOUD_SITE_CONFIG from env.
    getManagedSiteIdEdge: actual.getManagedSiteIdEdge,
  }
})

import { GET as getWellKnownDocument } from '@/app/api/well-known/[...document]/route'
import { middleware } from '@/middleware'
import { isDocsAccessEnabledEdge, isDocsAccessGrantedEdge } from '@/lib/admin/auth-edge'
import { isMachineEndpoint, isPublicAgentEndpoint } from '@/lib/agent-endpoints'
import {
  getCloudAccessConfigEdge,
  isCloudAccessConfiguredEdge,
} from '@/lib/cloud-link/edge'
import { classifyRequest, isAgentRequest } from '@/lib/traffic-classifier'

const EVENT = { waitUntil: vi.fn() } as never

function docRequest(path: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://docs.example.com${path}`, { headers })
}

const savedContentSource = process.env.THALLY_CONTENT_SOURCE
const savedSiteConfig = process.env.THALLY_CLOUD_SITE_CONFIG

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isDocsAccessEnabledEdge).mockReturnValue(false)
  vi.mocked(isPublicAgentEndpoint).mockReturnValue(false)
  vi.mocked(isMachineEndpoint).mockReturnValue(false)
  vi.mocked(getCloudAccessConfigEdge).mockReset().mockResolvedValue(null)
  vi.mocked(isCloudAccessConfiguredEdge).mockReturnValue(false)
  vi.mocked(isAgentRequest).mockReturnValue(false)
  vi.mocked(classifyRequest).mockReturnValue({
    visitorType: 'human',
    agentSignal: null,
    format: 'html',
  } as never)
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null)) as never
  delete process.env.THALLY_CONTENT_SOURCE
  delete process.env.THALLY_CLOUD_SITE_CONFIG
})

afterEach(() => {
  fetchSpy.mockRestore()
  if (savedContentSource === undefined) delete process.env.THALLY_CONTENT_SOURCE
  else process.env.THALLY_CONTENT_SOURCE = savedContentSource
  if (savedSiteConfig === undefined) delete process.env.THALLY_CLOUD_SITE_CONFIG
  else process.env.THALLY_CLOUD_SITE_CONFIG = savedSiteConfig
})

/**
 * Managed assets mode with the access config affirmatively public — the only
 * configuration in which cache headers may be emitted.
 */
function enableManagedAssetsMode(): void {
  process.env.THALLY_CONTENT_SOURCE = 'assets'
  process.env.THALLY_CLOUD_SITE_CONFIG = JSON.stringify({ siteId: 'site_123' })
  vi.mocked(getCloudAccessConfigEdge).mockResolvedValue({
    access: { mode: 'public' },
    portable: { markdown: { enabled: true } },
  })
}

describe('managed content cache headers', () => {
  it.each(['/_thally/content/src/content/private-roadmap.mdx', '/_thally/content/search/0000.json'])('never exposes the internal content asset %s', async (assetPath) => {
    enableManagedAssetsMode()
    const response = await middleware(
      docRequest(assetPath),
      EVENT,
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(getCloudAccessConfigEdge).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('routes OAuth discovery through the framework-owned runtime', async () => {
    const response = await middleware(
      docRequest('/.well-known/oauth-authorization-server'),
      EVENT,
    )

    expect(response.headers.get('x-middleware-rewrite')).toContain(
      '/api/well-known/oauth-authorization-server',
    )
    expect(getCloudAccessConfigEdge).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('adds Cache-Tag and a long CDN TTL to full HTML doc pages in assets mode', async () => {
    enableManagedAssetsMode()
    const response = await middleware(
      docRequest('/getting-started', { accept: 'text/html' }),
      EVENT,
    )

    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('Cache-Tag')).toBe('site:site_123')
    expect(response.headers.get('CDN-Cache-Control')).toBe(
      'public, s-maxage=31536000, stale-while-revalidate=86400',
    )
    // Existing doc-page headers survive alongside the cache headers.
    expect(response.headers.get('X-Llms-Txt')).toBe('https://docs.example.com/llms.txt')
  })

  it('keeps ambiguous browser document requests tag-only', async () => {
    enableManagedAssetsMode()
    const response = await middleware(docRequest('/getting-started'), EVENT)

    // Next strips RSC headers and `_rsc` before production middleware runs.
    // A request without an explicit HTML Accept header can therefore be an App
    // Router payload and must never receive a shared CDN lifetime.
    expect(response.headers.get('Cache-Tag')).toBe('site:site_123')
    expect(response.headers.get('CDN-Cache-Control')).toBeNull()
  })

  it('retains the long CDN TTL for URL-stable machine projections', async () => {
    enableManagedAssetsMode()
    const response = await middleware(docRequest('/api/docs-index'), EVENT)

    expect(response.headers.get('Cache-Tag')).toBe('site:site_123')
    expect(response.headers.get('CDN-Cache-Control')).toBe('public, s-maxage=31536000')
  })

  it('tags the .md mirror rewrite so publishes purge it too', async () => {
    enableManagedAssetsMode()
    const response = await middleware(docRequest('/getting-started.md'), EVENT)

    expect(response.headers.get('x-middleware-rewrite')).toContain('/api/markdown/getting-started')
    expect(response.headers.get('Cache-Tag')).toBe('site:site_123')
  })

  it('maps the root .md URL to the introduction document', async () => {
    enableManagedAssetsMode()
    const response = await middleware(docRequest('/.md'), EVENT)

    expect(response.headers.get('x-middleware-rewrite')).toContain(
      '/api/markdown/introduction',
    )
  })

  it('does not expose .md page URLs when the setting is disabled', async () => {
    enableManagedAssetsMode()
    vi.mocked(getCloudAccessConfigEdge).mockResolvedValue({
      access: { mode: 'public' },
      portable: { markdown: { enabled: false } },
    })

    const response = await middleware(docRequest('/getting-started.md'), EVENT)

    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it('tags the agent content-negotiation rewrite but never CDN-caches it', async () => {
    enableManagedAssetsMode()
    vi.mocked(isAgentRequest).mockReturnValue(true)
    const response = await middleware(docRequest('/getting-started'), EVENT)

    expect(response.headers.get('x-middleware-rewrite')).toContain('/api/docs/getting-started')
    expect(response.headers.get('Cache-Tag')).toBe('site:site_123')
    // This response varies on User-Agent/Accept under the BROWSER URL's cache
    // key. A CDN TTL here would let the first requester poison the page for
    // everyone (CDNs do not honor Vary on those headers).
    expect(response.headers.get('CDN-Cache-Control')).toBeNull()
  })

  it('never tags in the default filesystem mode', async () => {
    const response = await middleware(docRequest('/getting-started'), EVENT)

    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('Cache-Tag')).toBeNull()
    expect(response.headers.get('CDN-Cache-Control')).toBeNull()
  })

  it('never tags without an injected siteId', async () => {
    process.env.THALLY_CONTENT_SOURCE = 'assets'
    const response = await middleware(docRequest('/getting-started'), EVENT)

    expect(response.headers.get('Cache-Tag')).toBeNull()
  })

  it('never tags non-content API or admin surfaces', async () => {
    enableManagedAssetsMode()

    const search = await middleware(docRequest('/api/search'), EVENT)
    expect(search.headers.get('Cache-Tag')).toBeNull()
    expect(search.headers.get('X-Llms-Txt')).toBeNull()
    expect(search.headers.get('Link')).toBeNull()

    const admin = await middleware(docRequest('/admin'), EVENT)
    expect(admin.headers.get('Cache-Tag')).toBeNull()
  })

  it('lets routing resolve ambiguous API-prefixed paths', async () => {
    const response = await middleware(docRequest('/api/does-not-exist'), EVENT)

    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it('negotiates explicit machine formats for API-prefixed docs pages', async () => {
    enableManagedAssetsMode()
    vi.mocked(isAgentRequest).mockReturnValue(true)
    vi.mocked(isMachineEndpoint).mockReturnValue(true)

    const response = await middleware(
      docRequest('/api/overview', { accept: 'application/json' }),
      EVENT,
    )

    expect(response.headers.get('x-middleware-rewrite')).toContain(
      '/api/docs/api/overview',
    )
    expect(response.headers.get('Cache-Tag')).toBeNull()
    expect(response.headers.get('CDN-Cache-Control')).toBeNull()
  })

  it('preserves browser API-reference pages and RSC navigation', async () => {
    enableManagedAssetsMode()
    const browser = await middleware(
      docRequest('/api/default/posts/get', { accept: 'text/html' }),
      EVENT,
    )
    const rsc = await middleware(
      docRequest('/api/default/posts/get?_rsc=route-state', {
        rsc: '1',
        'next-router-state-tree': '%5B%22%22%5D',
      }),
      EVENT,
    )

    expect(browser.headers.get('x-middleware-next')).toBe('1')
    expect(browser.headers.get('X-Llms-Txt')).toBe('https://docs.example.com/llms.txt')
    expect(browser.headers.get('Link')).toContain('</llms.txt>; rel="llms-txt"')
    expect(browser.headers.get('Link')).toContain(
      '</llms.txt>; rel="alternate"; type="text/markdown"',
    )
    expect(browser.headers.get('Link')).toContain(
      '</openapi.yaml>; rel="service-desc"; type="application/yaml"',
    )
    expect(browser.headers.get('Link')).toContain(
      '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
    )
    // Discovery must not broaden the existing cache eligibility of the shared
    // `/api` namespace, where service endpoints and rendered pages coexist.
    expect(browser.headers.get('Cache-Tag')).toBeNull()
    expect(browser.headers.get('Cache-Control')).toBeNull()
    expect(browser.headers.get('CDN-Cache-Control')).toBeNull()
    expect(browser.headers.get('Netlify-CDN-Cache-Control')).toBeNull()
    expect(rsc.headers.get('x-middleware-next')).toBe('1')
    expect(rsc.headers.get('x-middleware-rewrite')).toBeNull()
    expect(rsc.headers.get('Cache-Tag')).toBeNull()
    expect(rsc.headers.get('CDN-Cache-Control')).toBeNull()
  })

  it('never emits cache headers when the access config is unavailable (fail closed)', async () => {
    // Grant exchange failed or timed out: request gating fails open for
    // availability, but a possibly-gated page must not enter a shared cache.
    enableManagedAssetsMode()
    vi.mocked(getCloudAccessConfigEdge).mockResolvedValue(null)

    const response = await middleware(docRequest('/getting-started'), EVENT)
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('Cache-Tag')).toBeNull()
    expect(response.headers.get('CDN-Cache-Control')).toBeNull()
  })

  it('never emits cache headers when the managed site is password-gated', async () => {
    enableManagedAssetsMode()
    vi.mocked(getCloudAccessConfigEdge).mockResolvedValue({ access: { mode: 'password' } })
    vi.mocked(isDocsAccessGrantedEdge).mockResolvedValue(true)

    const response = await middleware(docRequest('/getting-started'), EVENT)
    expect(response.headers.get('Cache-Tag')).toBeNull()
    expect(response.headers.get('CDN-Cache-Control')).toBe('private, no-store')
  })

  it('returns a structured 401 instead of an HTML redirect for a protected API', async () => {
    vi.mocked(getCloudAccessConfigEdge).mockResolvedValue({ access: { mode: 'password' } })
    vi.mocked(isDocsAccessGrantedEdge).mockResolvedValue(false)

    const response = await middleware(docRequest('/api/docs-index'), EVENT)
    const problem = await response.json()

    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('location')).toBeNull()
    expect(problem).toMatchObject({
      type: 'https://thally.io/problems/docs_access_required',
      code: 'docs_access_required',
      status: 401,
      instance: '/api/docs-index',
    })
  })

  it('fails discovery closed when middleware resolves password access but the route lookup fails', async () => {
    vi.mocked(isPublicAgentEndpoint).mockReturnValue(true)
    vi.mocked(isCloudAccessConfiguredEdge).mockReturnValue(true)
    vi.mocked(getCloudAccessConfigEdge)
      .mockResolvedValueOnce({ access: { mode: 'password' } })
      .mockResolvedValueOnce(null)

    const request = docRequest('/auth.md')
    const middlewareResponse = await middleware(request, EVENT)
    const routeResponse = await getWellKnownDocument(request, {
      params: Promise.resolve({ document: ['auth-md'] }),
    })
    const authGuide = await routeResponse.text()

    expect(middlewareResponse.headers.get('x-middleware-next')).toBe('1')
    expect(middlewareResponse.headers.get('location')).toBeNull()
    expect(getCloudAccessConfigEdge).toHaveBeenCalledTimes(2)
    expect(authGuide).toContain('password-protected documentation service')
    expect(authGuide).toContain('Cookie: docs-access=<session-value>')
    expect(authGuide).not.toContain('access is anonymous')
  })

  it('keeps the interactive access redirect for a protected browser page', async () => {
    vi.mocked(getCloudAccessConfigEdge).mockResolvedValue({ access: { mode: 'password' } })
    vi.mocked(isDocsAccessGrantedEdge).mockResolvedValue(false)

    const response = await middleware(
      docRequest('/getting-started', { accept: 'text/html' }),
      EVENT,
    )

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'https://docs.example.com/access?next=%2Fgetting-started',
    )
  })

  it('never tags while docs-access protection is on (no shared cache of gated pages)', async () => {
    enableManagedAssetsMode()
    vi.mocked(isDocsAccessEnabledEdge).mockReturnValue(true)
    vi.mocked(isDocsAccessGrantedEdge).mockResolvedValue(true)

    const response = await middleware(docRequest('/getting-started'), EVENT)
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('Cache-Tag')).toBeNull()
  })

  it.each([
    ['the RSC query marker', '/getting-started?_rsc=route-state', {}],
    ['the RSC marker', '/getting-started', { rsc: '1' }],
    ['the router state tree', '/getting-started', { 'next-router-state-tree': '%5B%22%22%5D' }],
    ['the router prefetch marker', '/getting-started', { 'next-router-prefetch': '1' }],
    ['the segment prefetch marker', '/getting-started', { 'next-router-segment-prefetch': '/children' }],
    ['an HTML accept header alongside a router marker', '/getting-started', { accept: 'text/html', rsc: '1' }],
  ])('tags managed router payloads for purge but never CDN-caches %s', async (_label, path, headers) => {
    enableManagedAssetsMode()
    const response = await middleware(docRequest(path, headers), EVENT)

    // Direct runtimes can expose one or more router signals. Keep the purge
    // tag, but always let Next own these responses so a prefetched shell can
    // never replace navigated content.
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
    expect(response.headers.get('Cache-Tag')).toBe('site:site_123')
    expect(response.headers.get('CDN-Cache-Control')).toBeNull()
    expect(response.headers.get('Netlify-CDN-Cache-Control')).toBeNull()
  })

  it('never CDN-caches an authenticated HTML page from password-gated docs', async () => {
    vi.mocked(getCloudAccessConfigEdge).mockResolvedValue({ access: { mode: 'password' } })
    vi.mocked(isDocsAccessGrantedEdge).mockResolvedValue(true)

    const response = await middleware(
      docRequest('/getting-started', { accept: 'text/html' }),
      EVENT,
    )

    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('CDN-Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Netlify-CDN-Cache-Control')).toBe('private, no-store')
  })

  it('does not count intent-prefetched routes as page views', async () => {
    await middleware(
      docRequest('/quickstart?_rsc=prefetch-state', {
        rsc: '1',
        'next-router-prefetch': '1',
      }),
      EVENT,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
