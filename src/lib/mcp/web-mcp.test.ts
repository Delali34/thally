/** Browser contracts: canonical parity, fixed authentication boundary and lifecycle. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebMcpTools, registerWebMcpTools, type WebMcpBrowser } from './web-mcp'
import { toolMetadata } from './tool-metadata'
import { webMcpToolMetadata } from './web-mcp-metadata'

const origin = 'https://docs.example.com'
let pathname = '/guides/auth'
let hash = ''
const fetchMock = vi.fn<typeof fetch>()
const navigate = vi.fn()
const browser: WebMcpBrowser = { fetch: fetchMock, location: () => ({ origin, pathname, hash }), navigate, defaultLocale: 'en', locales: ['en', 'es'] }
const tool = (name: string) => createWebMcpTools(browser).find((candidate) => candidate.name === name)!
const result = (structuredContent: Record<string, unknown>, isError = false) => Response.json({ result: { content: [{ type: 'text', text: 'readable prose, not JSON' }], structuredContent, isError } })
const page = { page_id: 'guides/auth', title: 'Auth', locale: 'en', url: `${origin}/guides/auth`, headings: [{ id: 'tokens' }] }
beforeEach(() => { vi.clearAllMocks(); pathname = '/guides/auth'; hash = '' })

describe('native deployed-site tools', () => {
  it('exposes all eight canonical tools and two context actions with only native metadata', () => {
    expect(toolMetadata).toHaveLength(8)
    expect(createWebMcpTools(browser).map((item) => item.name)).toEqual(webMcpToolMetadata.map((item) => item.name))
    for (const metadata of toolMetadata) {
      expect(tool(metadata.name).inputSchema).toEqual(metadata.inputSchema)
      expect(tool(metadata.name)).not.toHaveProperty('outputSchema')
      expect(tool(metadata.name)).not.toHaveProperty('summary')
      expect(tool(metadata.name).annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true })
    }
  })
  it('routes every tool and supported numeric input through the session and quota boundary', async () => {
    for (const metadata of toolMetadata) {
      fetchMock.mockResolvedValueOnce(result({ value: metadata.name }))
      const args = ['search_docs', 'search_sections'].includes(metadata.name) ? { query: 'tokens', limit: 2.5 } : metadata.name === 'read_page' ? { pageId: 'api/overview' } : metadata.name === 'get_api_operation' ? { method: 'GET', path: '/users' } : metadata.name === 'list_api_operations' ? { tag: 'Users', limit: 2 } : metadata.name === 'list_changes' ? { since: '2026-01-01', limit: 2 } : {}
      expect(await tool(metadata.name).execute(args)).toMatchObject({ structuredContent: { value: metadata.name } })
      const [url, options] = fetchMock.mock.calls.at(-1)!
      expect(url).toBe('/api/mcp')
      expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error' })
      expect(JSON.parse(options!.body as string).params.name).toBe(metadata.name)
    }
  })
  it('reads fresh language and normalizes localized page paths on every call', async () => {
    const search = tool('search_docs')
    pathname = '/es/guides/auth'
    fetchMock.mockResolvedValue(result({}))
    await search.execute({ query: 'tokens' })
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).params.arguments.locale).toBe('es')
    await tool('read_page').execute({ pageId: '/es/guides/auth' })
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).params.arguments).toEqual({ pageId: 'guides/auth', locale: 'es' })
  })
  it.each([{ query: '' }, { query: 'ok', limit: NaN }, { query: 'ok', limit: Infinity }, { query: 'ok', url: 'https://evil.test' }, { query: 'ok', limit: '3' }])('rejects malformed inputs before network access: %j', async (args) => {
    expect(await tool('search_docs').execute(args)).toMatchObject({ isError: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([401, 403, 429])('reports reader and rate boundary failures (%s)', async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status }))
    expect(await tool('read_page').execute({ pageId: 'private' })).toMatchObject({ isError: true })
  })
  it('rejects login HTML and malformed JSON-RPC responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Access</html>', { headers: { 'content-type': 'text/html' } }))
    expect(await tool('read_page').execute({ pageId: 'private' })).toMatchObject({ isError: true })
    fetchMock.mockResolvedValueOnce(Response.json({ result: {} }))
    expect(await tool('list_pages').execute({})).toMatchObject({ isError: true })
  })
  it('uses structured results and reader-visible projection navigation', async () => {
    hash = '#tokens'
    fetchMock.mockResolvedValueOnce(result(page)).mockResolvedValueOnce(Response.json({ nav: { next: { href: '/guides/next' } } }))
    expect(await tool('get_current_page').execute({})).toMatchObject({ pageId: 'guides/auth', heading: 'tokens', navigation: { next: { href: '/guides/next' } } })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/docs/guides/auth?format=json')
  })
  it.each(['/', '/es'])('resolves a root using the current renderer home identity: %s', async (path) => {
    pathname = path
    fetchMock.mockResolvedValueOnce(result({ ...page, page_id: 'introduction' })).mockResolvedValueOnce(Response.json({ nav: {} }))
    expect(await tool('get_current_page').execute({})).toMatchObject({ pageId: 'introduction', viewLocale: path === '/es' ? 'es' : 'en' })
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).params.arguments.pageId).toBe('introduction')
  })
  it('reads localized generated aliases through the operation projection', async () => {
    pathname = '/es/api/users/get'
    fetchMock.mockResolvedValueOnce(result({ id: 'default/users/get', title: 'Users', url: `${origin}/api/default/users/get`, parameters: [] }))
    expect(await tool('get_current_page').execute({})).toMatchObject({ pageId: 'default/users/get', locale: 'en', viewLocale: 'es', openapi: { parameters: [] } })
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).params.arguments.operationId).toBe('/api/users/get')
  })
  it('falls back to authored /api documentation when it is not an operation', async () => {
    pathname = '/api/overview'
    fetchMock.mockResolvedValueOnce(result({}, true)).mockResolvedValueOnce(result({ ...page, page_id: 'api/overview' })).mockResolvedValueOnce(Response.json({ nav: {} }))
    expect(await tool('get_current_page').execute({})).toMatchObject({ pageId: 'api/overview' })
  })
  it('navigates only reader-visible published entries and validated headings', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ pages: [{ type: 'doc', id: 'guides/auth', url: `${origin}/guides/auth` }] })).mockResolvedValueOnce(result(page))
    expect(await tool('navigate_to_page').execute({ pageId: 'guides/auth', heading: 'tokens' })).toMatchObject({ status: 'navigation_started' })
    expect(navigate).toHaveBeenCalledWith('/guides/auth#tokens')
  })
  it.each(['https://evil.test/page', `${origin}//evil.test/page`, 'javascript:alert(1)'])('rejects unsafe published destinations: %s', async (url) => {
    fetchMock.mockResolvedValueOnce(Response.json({ pages: [{ type: 'doc', id: 'bad', url }] }))
    expect(await tool('navigate_to_page').execute({ pageId: 'bad' })).toMatchObject({ isError: true })
    expect(navigate).not.toHaveBeenCalled()
  })
  it('rejects operator paths, missing pages, unauthorized operations and unknown headings', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ pages: [] }))
    expect(await tool('navigate_to_page').execute({ pageId: 'admin/settings' })).toMatchObject({ isError: true })
    fetchMock.mockResolvedValueOnce(Response.json({ pages: [] })).mockResolvedValueOnce(result({}, true))
    expect(await tool('navigate_to_page').execute({ pageId: 'api/private/get' })).toMatchObject({ isError: true })
    fetchMock.mockResolvedValueOnce(Response.json({ pages: [{ type: 'doc', id: 'guides/auth', url: `${origin}/guides/auth` }] })).mockResolvedValueOnce(result(page))
    expect(await tool('navigate_to_page').execute({ pageId: 'guides/auth', heading: 'missing' })).toMatchObject({ isError: true })
    expect(navigate).not.toHaveBeenCalled()
  })
  it('uses the generated source-language index for localized navigation by operation ID', async () => {
    pathname = '/es'
    fetchMock.mockResolvedValueOnce(Response.json({ pages: [] })).mockResolvedValueOnce(Response.json({ pages: [{ type: 'api_operation', id: 'default/users/get', url: `${origin}/api/default/users/get` }] }))
    expect(await tool('navigate_to_page').execute({ pageId: 'default/users/get' })).toMatchObject({ status: 'navigation_started' })
    expect(navigate).toHaveBeenCalledWith('/es/api/default/users/get')
  })
  it('distinguishes API page paths from exact operation IDs during navigation', async () => {
    const pages = [
      { type: 'api_operation', id: 'default/users/get', url: `${origin}/api/default/users/get` },
      { type: 'api_operation', id: 'api/users/get', url: `${origin}/api/api/users/get` },
    ]
    fetchMock.mockResolvedValueOnce(Response.json({ pages })).mockResolvedValueOnce(result({ id: 'default/users/get', url: pages[0].url }))
    expect(await tool('navigate_to_page').execute({ pageId: '/api/users/get' })).toMatchObject({ status: 'navigation_started' })
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).params.arguments.operationId).toBe('/api/users/get')
    expect(navigate).toHaveBeenLastCalledWith('/api/default/users/get')

    fetchMock.mockResolvedValueOnce(Response.json({ pages }))
    expect(await tool('navigate_to_page').execute({ pageId: 'api/users/get' })).toMatchObject({ status: 'navigation_started' })
    expect(navigate).toHaveBeenLastCalledWith('/api/api/users/get')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('retains authored API path fallback and heading validation despite colliding operation IDs', async () => {
    const pages = [
      { type: 'doc', id: 'api/users/get', url: `${origin}/api/users/get` },
      { type: 'api_operation', id: 'api/users/get', url: `${origin}/api/api/users/get` },
    ]
    fetchMock.mockResolvedValueOnce(Response.json({ pages })).mockResolvedValueOnce(result({}, true)).mockResolvedValueOnce(result({ ...page, page_id: 'api/users/get' }))
    expect(await tool('navigate_to_page').execute({ pageId: '/api/users/get', heading: 'tokens' })).toMatchObject({ status: 'navigation_started' })
    expect(navigate).toHaveBeenCalledWith('/api/users/get#tokens')
    fetchMock.mockResolvedValueOnce(Response.json({ pages }))
    expect(await tool('navigate_to_page').execute({ pageId: 'api/users/get' })).toMatchObject({ status: 'navigation_started' })
    expect(navigate).toHaveBeenLastCalledWith('/api/api/users/get')
  })
  it('passes cancellation through fetch and never starts aborted navigation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(tool('navigate_to_page').execute({ pageId: 'guides/auth' }, { signal: controller.signal })).rejects.toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('native registration lifecycle', () => {
  it('handles unsupported browsers and asynchronous failures', async () => {
    expect(registerWebMcpTools(undefined, [])).toBeTypeOf('function')
    const onError = vi.fn()
    registerWebMcpTools({ registerTool: vi.fn().mockRejectedValue(new Error('disabled')) }, [tool('list_pages')], onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
  })
  it('aborts only its own registrations on teardown and skips premature registration', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    const cleanup = registerWebMcpTools({ registerTool }, createWebMcpTools(browser))
    await vi.waitFor(() => expect(registerTool).toHaveBeenCalledTimes(10))
    const signal = registerTool.mock.calls[0][1].signal as AbortSignal
    cleanup()
    expect(signal.aborted).toBe(true)
    registerTool.mockClear()
    registerWebMcpTools({ registerTool }, createWebMcpTools(browser))()
    await Promise.resolve()
    expect(registerTool).not.toHaveBeenCalled()
  })
})
