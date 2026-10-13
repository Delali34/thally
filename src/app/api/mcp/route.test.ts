/**
 * Remote MCP endpoint: protocol behavior, every tool and resource, and the
 * abuse limits of a public endpoint, pinned with raw JSON-RPC requests.
 * `sdk-client.test.ts` drives the same route with the official SDK client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  mcpEnabled: true,
  counters: new Map<string, number>(),
  failStorage: false,
}))

vi.mock('@/data/docs', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).docsModule)
vi.mock('@/lib/content/document', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).contentDocumentModule)
vi.mock('@/lib/i18n/request', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).i18nRequestModule)
vi.mock('@/lib/i18n/translation-source', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).translationSourceModule)
vi.mock('@/config/api-reference', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).apiReferenceConfigModule)
vi.mock('@/lib/openapi/fetch', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).openApiFetchModule)
vi.mock('@/lib/site-config', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).siteConfigModule)
vi.mock('@/lib/admin/settings', () => ({ getAdminSettings: async () => ({ mcpEnabled: state.mcpEnabled }) }))
vi.mock('@/lib/agent-readiness', () => ({
  computePublishedAgentReadiness: async () => ({
    score: 87,
    grade: 'B',
    totalPages: 3,
    subscores: [
      { id: 'x', label: 'Descriptions', score: 0.9, weight: 0.5, detail: 'Most pages have one.' },
      { id: 'y', label: 'API reference', score: 1, weight: 0.1, detail: 'No API spec.', status: 'skip' },
    ],
  }),
}))
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    kvIncrement: async (namespace: string, key: string, options?: { amount?: number }) => {
      if (state.failStorage) throw new Error('storage down')
      const id = `${namespace}:${key}`
      const count = (state.counters.get(id) ?? 0) + (options?.amount ?? 1)
      state.counters.set(id, count)
      return { count }
    },
  }),
}))

import { GET, POST } from './route'
import { HUMAN_ONLY, AGENT_ONLY, PLAYGROUND_SECRET, apiReferenceConfigModule, entries, sources } from '@/lib/mcp/__tests__/agent-surface-fixture'
import { getApiOperationBySlug } from '@/data/api-reference'
import { createWebMcpTools } from '@/lib/mcp/web-mcp'
import { resetSearchEngine } from '@/lib/search/engine'

const ENDPOINT = 'https://docs.acme.test/api/mcp'

/** Response bodies are asserted structurally; their exact types live in the route. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
}

async function rpc(method: string, params?: Record<string, unknown>, headers?: Record<string, string>) {
  const response = await post({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, headers)
  return { response, body: await response.json() }
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args })
  return body.result as { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError: boolean }
}

/** Exercise native context through the actual MCP route and normalized API graph. */
async function currentApiPage() {
  const tools = createWebMcpTools({
    defaultLocale: 'en', locales: ['en', 'es'],
    location: () => ({ origin: 'https://docs.acme.test', pathname: '/api/users/post', hash: '' }),
    navigate: () => {},
    fetch: async (input, init) => {
      if (input === '/api/mcp') return post(String(init?.body))
      if (input === '/api/docs/api/users/post?format=json') return Response.json({ nav: {} })
      throw new Error(`Unexpected content request: ${String(input)}`)
    },
  })
  return tools.find((tool) => tool.name === 'get_current_page')!.execute({})
}

beforeEach(() => {
  state.mcpEnabled = true
  state.failStorage = false
  state.counters.clear()
  resetSearchEngine()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('lifecycle and protocol', () => {
  it('rejects foreign browser origins and accepts same-origin or remote clients', async () => {
    const rejected = await rpc('tools/call', { name: 'list_pages', arguments: {} }, { origin: 'https://evil.test' })
    expect(rejected.response.status).toBe(403)
    expect(state.counters.size).toBe(0)
    expect((await rpc('ping', undefined, { origin: 'https://docs.acme.test' })).body.result).toEqual({})
    expect((await rpc('ping')).body.result).toEqual({})
  })

  it('negotiates the newest protocol and advertises tools and resources', async () => {
    const { response, body } = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(response.headers.get('mcp-session-id')).toBeTruthy()
    expect(body.result).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'acme-docs-docs' },
    })
    expect(typeof body.result.instructions).toBe('string')
  })

  it.each(['2025-06-18', '2025-03-26', '2024-11-05'])('keeps older protocol %s', async (version) => {
    const { body } = await rpc('initialize', { protocolVersion: version })
    expect(body.result.protocolVersion).toBe(version)
  })

  it('falls back to the latest version for an unknown one', async () => {
    const { body } = await rpc('initialize', { protocolVersion: '1999-01-01' })
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('rejects an unsupported MCP-Protocol-Version header after initialization', async () => {
    const { response, body } = await rpc('tools/list', undefined, { 'mcp-protocol-version': '1999-01-01' })
    expect(response.status).toBe(400)
    expect(body.error.code).toBe(-32000)
  })

  it('reflects only a well-formed session id', async () => {
    const echoed = await rpc('ping', undefined, { 'mcp-session-id': 'abc-123' })
    expect(echoed.response.headers.get('mcp-session-id')).toBe('abc-123')
    const oversized = await rpc('ping', undefined, { 'mcp-session-id': 'x'.repeat(500) })
    expect(oversized.response.headers.get('mcp-session-id')).toBeNull()
  })

  it('answers notifications with 202 and no body', async () => {
    const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('treats any id-less message as a notification', async () => {
    const response = await post({ jsonrpc: '2.0', method: 'tools/list' })
    expect(response.status).toBe(202)
  })

  it('answers a legacy batch, skipping notifications', async () => {
    const response = await post([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    const body = await response.json()
    expect(body.map((item: { id: number }) => item.id)).toEqual([1, 2])
  })

  it('rejects empty and oversized batches', async () => {
    expect((await post([])).status).toBe(400)
    const big = Array.from({ length: 21 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'ping' }))
    expect((await post(big)).status).toBe(400)
  })

  it('returns protocol errors for malformed input', async () => {
    const parse = await post('{not json')
    expect(parse.status).toBe(400)
    expect((await parse.json()).error.code).toBe(-32700)

    expect((await (await post([42])).json())[0].error.code).toBe(-32600)
    expect((await rpc('no/such/method')).body.error.code).toBe(-32601)
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: 'x' })).status).toBe(200)
  })

  it('rejects bodies over the size cap', async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } })
    expect(response.status).toBe(413)
  })

  it('is disabled by the admin toggle', async () => {
    state.mcpEnabled = false
    const { response } = await rpc('ping')
    expect(response.status).toBe(404)
  })

  it('serves no SSE stream on GET', async () => {
    const response = await GET(new NextRequest(ENDPOINT))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })
})

describe('tools/list', () => {
  it('lists every tool with schemas and read-only annotations', async () => {
    const { body } = await rpc('tools/list')
    const tools = body.result.tools as Array<Json>
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_docs', 'search_sections', 'read_page', 'list_pages',
      'list_api_operations', 'get_api_operation', 'list_changes', 'agent_readiness',
    ])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.outputSchema.type).toBe('object')
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(tool.title).toBeTruthy()
    }
  })
})

describe('tools/call', () => {
  it('distinguishes exact operation IDs from rendered API paths in native context', async () => {
    const specs = apiReferenceConfigModule.apiReferenceConfig.specs
    const apiSpec = { ...specs[0], id: 'api' }
    specs.push(apiSpec)
    try {
      expect((await getApiOperationBySlug(['users', 'post']))?.href).toBe('/api/default/users/post')
      expect((await callTool('get_api_operation', { operationId: 'api/users/post' })).structuredContent).toMatchObject({ id: 'api/users/post' })
      expect((await callTool('get_api_operation', { operationId: '/api/users/post' })).structuredContent).toMatchObject({ id: 'default/users/post' })
      expect((await callTool('get_api_operation', { operationId: '/api/api/users/post' })).structuredContent).toMatchObject({ id: 'api/users/post' })
      expect(await currentApiPage()).toMatchObject({ pageId: 'default/users/post', url: 'https://docs.acme.test/api/default/users/post' })
    } finally {
      specs.splice(specs.indexOf(apiSpec), 1)
    }
  })

  it('keeps authored API paths when only another spec has the colliding operation ID', async () => {
    const specs = apiReferenceConfigModule.apiReferenceConfig.specs
    const defaultSpec = specs[0]
    const apiSpec = { ...defaultSpec, id: 'api' }
    const pageId = 'api/users/post'
    const entry = { ...entries[0], id: pageId, slug: pageId.split('/'), href: `/${pageId}` }
    specs.push(apiSpec)
    Object.assign(defaultSpec, { pageOnly: true })
    entries.push(entry)
    sources[pageId] = '---\ntitle: Authored API guide\n---\n\nRead the authored guide.'
    try {
      expect(await getApiOperationBySlug(['users', 'post'])).toBeNull()
      expect((await callTool('get_api_operation', { operationId: 'api/users/post' })).structuredContent).toMatchObject({ id: 'api/users/post' })
      expect((await callTool('get_api_operation', { operationId: '/api/users/post' })).isError).toBe(true)
      expect(await currentApiPage()).toMatchObject({ pageId, title: 'Authored API guide' })
    } finally {
      specs.splice(specs.indexOf(apiSpec), 1)
      Reflect.deleteProperty(defaultSpec, 'pageOnly')
      entries.splice(entries.indexOf(entry), 1)
      delete sources[pageId]
    }
  })

  it('reports an unknown tool as a protocol error', async () => {
    const { body } = await rpc('tools/call', { name: 'drop_database' })
    expect(body.error).toMatchObject({ code: -32602 })
  })

  it('reports bad arguments as a tool execution error the model can fix', async () => {
    const result = await callTool('search_docs', { query: '' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('query')
    expect((await callTool('read_page', { pageId: 'guides/auth', locale: 'xx' })).content[0].text).toContain('Unsupported locale')
  })

  it('search_docs ranks pages and API operations with section anchors', async () => {
    const result = await callTool('search_docs', { query: 'webhook signature' })
    const [first] = result.structuredContent!.results as Array<Record<string, unknown>>
    expect(first).toMatchObject({
      type: 'page',
      id: 'guides/auth',
      url: 'https://docs.acme.test/guides/auth',
      section_url: 'https://docs.acme.test/guides/auth#webhooks',
    })
    const api = await callTool('search_docs', { query: 'create user' })
    expect((api.structuredContent!.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'api_operation', id: 'default/users/post', method: 'POST', path: '/users',
    })
  })

  it('search_docs never returns hidden or noindex pages', async () => {
    const result = await callTool('search_docs', { query: 'zebras' })
    expect(result.structuredContent!.results).toEqual([])
  })

  it('search_sections returns heading path, deep link and agent-projected text', async () => {
    const result = await callTool('search_sections', { query: 'rotate api key' })
    const [hit] = result.structuredContent!.results as Array<Json>
    expect(hit).toMatchObject({
      page_id: 'guides/auth',
      heading: 'API keys',
      heading_path: ['API keys'],
      section_url: 'https://docs.acme.test/guides/auth#api-keys',
    })
    expect(hit.content).toContain('rotate it monthly')
    expect(JSON.stringify(result)).not.toContain(HUMAN_ONLY)
  })

  it('search_sections supports a translated locale', async () => {
    const result = await callTool('search_sections', { query: 'clave', locale: 'es' })
    expect((result.structuredContent!.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      url: 'https://docs.acme.test/es/guides/auth',
    })
  })

  it('read_page returns the agent Markdown projection', async () => {
    const result = await callTool('read_page', { pageId: '/guides/auth' })
    const page = result.structuredContent as Json
    expect(page).toMatchObject({ page_id: 'guides/auth', title: 'Authentication', locale: 'en' })
    expect(page.markdown).toContain(AGENT_ONLY)
    expect(page.markdown).not.toContain(HUMAN_ONLY)
    expect(page.markdown).not.toMatch(/<\/?(Visibility|Agent|Steps|Step)\b/)
    expect(page.markdown).toContain('#### Store the key')
    expect(page.headings.map((heading: { id: string }) => heading.id)).toEqual(['api-keys', 'webhooks'])
    expect(result.content[0].text).toBe(page.markdown)
  })

  it('read_page serves a translation when one exists and falls back otherwise', async () => {
    const translated = (await callTool('read_page', { pageId: 'guides/auth', locale: 'es' })).structuredContent!
    expect(translated).toMatchObject({ locale: 'es', title: 'Autenticación', url: 'https://docs.acme.test/es/guides/auth' })
    const fallback = (await callTool('read_page', { pageId: 'introduction', locale: 'es' })).structuredContent!
    expect(fallback).toMatchObject({ locale: 'en', url: 'https://docs.acme.test/' })
  })

  it('read_page still reads hidden pages by id but refuses unknown or traversal ids', async () => {
    expect((await callTool('read_page', { pageId: 'guides/hidden' })).isError).toBe(false)
    expect((await callTool('read_page', { pageId: '../../package' })).isError).toBe(true)
  })

  it('list_pages applies the same hidden/noindex rule as search', async () => {
    const result = await callTool('list_pages')
    const ids = (result.structuredContent!.pages as Array<{ page_id: string }>).map((page) => page.page_id)
    expect(ids).toEqual(['introduction', 'guides/auth', 'changelog'])
    const spanish = await callTool('list_pages', { locale: 'es' })
    expect(spanish.structuredContent).toMatchObject({ locale: 'es', total: 1 })
  })

  it('list_api_operations lists published operations only and filters', async () => {
    const result = await callTool('list_api_operations')
    expect(result.structuredContent).toMatchObject({ total: 1 })
    expect((result.structuredContent!.operations as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'default/users/post', method: 'POST', path: '/users', tags: ['Users'], url: 'https://docs.acme.test/api/default/users/post',
    })
    expect((await callTool('list_api_operations', { query: 'internal' })).structuredContent).toMatchObject({ total: 0 })
    expect((await callTool('list_api_operations', { tag: 'users' })).structuredContent).toMatchObject({ total: 1 })
  })

  it('get_api_operation describes schemas and auth without leaking the playground credential', async () => {
    const result = await callTool('get_api_operation', { operationId: 'default/users/post' })
    const detail = result.structuredContent as Json
    expect(detail.request_body).toMatchObject({ required: true, content_type: 'application/json' })
    expect(detail.request_body.schema.properties.email).toMatchObject({ type: 'string', format: 'email' })
    expect(detail.parameters).toEqual([expect.objectContaining({ name: 'dry_run', in: 'query', required: false })])
    expect(detail.responses.map((response: { status: string }) => response.status)).toEqual(['201', '400'])
    expect(detail.auth).toMatchObject({ required: true, schemes: [{ name: 'bearerAuth', kind: 'bearer', in: 'header' }] })
    expect(detail.example.curl).toContain('https://api.acme.test/v1/users')
    expect(detail.example.curl).toContain('Bearer <token>')
    expect(JSON.stringify(result)).not.toContain(PLAYGROUND_SECRET)

    expect((await callTool('get_api_operation', { operationId: '/api/default/users/post' })).structuredContent).toMatchObject({ id: 'default/users/post' })
    expect((await callTool('get_api_operation', { operationId: '/api/users/post' })).structuredContent).toMatchObject({ id: 'default/users/post' })
    expect((await callTool('get_api_operation', { operationId: '/api/internal/get' })).isError).toBe(true)
    const byKey = await callTool('get_api_operation', { method: 'post', path: '/users' })
    expect(byKey.structuredContent).toMatchObject({ id: 'default/users/post' })
    expect((await callTool('get_api_operation', { operationId: 'default/internal/get' })).isError).toBe(true)
    expect((await callTool('get_api_operation', {})).isError).toBe(true)
  })

  it('list_changes returns structured changelog entries newest first, filtered by since', async () => {
    const result = await callTool('list_changes')
    const changes = result.structuredContent as Json
    expect(changes.changelog_url).toBe('https://docs.acme.test/changelog')
    expect(changes.entries.map((entry: { title: string }) => entry.title)).toEqual(['Live branding', 'Search', 'v0.1.0'])
    expect(changes.entries[0]).toMatchObject({
      url: 'https://docs.acme.test/changelog#live-branding',
      published: '2026-06-20T00:00:00.000Z',
      tags: ['branding'],
    })
    expect(changes.entries[0].markdown).toContain('(https://docs.acme.test/guides/auth)')
    expect(JSON.stringify(changes)).not.toContain(HUMAN_ONLY)
    // "Spring 2025" is not a date we can trust: kept, but undated.
    expect(changes.entries[2].published).toBeUndefined()

    const recent = await callTool('list_changes', { since: '2026-04-01' })
    expect(recent.structuredContent).toMatchObject({ total: 1 })
    expect((await callTool('list_changes', { since: 'last week' })).isError).toBe(true)
  })

  it('agent_readiness returns the score as structured content', async () => {
    const result = await callTool('agent_readiness')
    expect(result.structuredContent).toMatchObject({ score: 87, grade: 'B', total_pages: 3 })
    expect(result.content[0].text).toContain('- Descriptions: 90%')
    // Skipped checks (readiness v2) read as n/a, never 100%.
    expect(result.content[0].text).toContain('- API reference: n/a')
    expect((result.structuredContent!.subscores as Array<Json>)[1]).toMatchObject({ status: 'skip' })
  })
})

describe('resources', () => {
  it('lists indexable pages and exposes templates', async () => {
    const list = await rpc('resources/list')
    expect(list.body.result.resources.map((resource: { uri: string }) => resource.uri)).toEqual([
      'docs://pages/introduction', 'docs://pages/guides/auth', 'docs://pages/changelog',
    ])
    expect(list.body.result.nextCursor).toBeUndefined()
    const templates = await rpc('resources/templates/list')
    expect(templates.body.result.resourceTemplates.map((template: { uriTemplate: string }) => template.uriTemplate))
      .toEqual(['docs://pages/{+pageId}', 'docs://api/{+operationId}'])
  })

  it('reads pages and API operations as Markdown', async () => {
    const page = await rpc('resources/read', { uri: 'docs://pages/guides/auth' })
    expect(page.body.result.contents[0]).toMatchObject({ uri: 'docs://pages/guides/auth', mimeType: 'text/markdown' })
    expect(page.body.result.contents[0].text).not.toContain(HUMAN_ONLY)
    const operation = await rpc('resources/read', { uri: 'docs://api/default/users/post' })
    expect(operation.body.result.contents[0].text).toContain('## POST /users — Create user')
  })

  it('returns -32002 for unknown resources and -32602 for bad params', async () => {
    expect((await rpc('resources/read', { uri: 'docs://pages/../../etc/passwd' })).body.error.code).toBe(-32002)
    expect((await rpc('resources/read', { uri: 'file:///etc/passwd' })).body.error.code).toBe(-32002)
    expect((await rpc('resources/read', {})).body.error.code).toBe(-32602)
    expect((await rpc('resources/list', { cursor: '!!' })).body.error.code).toBe(-32602)
  })
})

describe('rate limiting', () => {
  it('counts every metered call in a batch', async () => {
    const batch = Array.from({ length: 20 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_pages' } }))
    for (let i = 0; i < 3; i += 1) expect((await post(batch)).status).toBe(200)
    const limited = await post(batch)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect((await limited.json()).error.code).toBe(-32000)
  })

  it('cannot be bypassed by forging the leftmost X-Forwarded-For hop', async () => {
    const batch = Array.from({ length: 20 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_pages' } }))
    const statuses: Array<number> = []
    for (let i = 0; i < 4; i += 1) {
      const response = await POST(new NextRequest(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}, 198.51.100.9` },
        body: JSON.stringify(batch),
      }))
      statuses.push(response.status)
    }
    expect(statuses).toEqual([200, 200, 200, 429])
  })

  it('does not meter cheap methods and fails open when storage is down', async () => {
    for (let i = 0; i < 80; i += 1) expect((await rpc('tools/list')).response.status).toBe(200)
    state.failStorage = true
    expect((await rpc('tools/call', { name: 'list_pages' })).response.status).toBe(200)
  })
})
