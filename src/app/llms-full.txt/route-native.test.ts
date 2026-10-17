/** Compare the real GET's public/locale/API projections across both transports. */
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { ContentSource } from '@/lib/content-source/types'
import type { PreparedBulkDescriptor } from '@/lib/agent-export/prepared-contract'

const state = vi.hoisted(() => ({ source: null as ContentSource | null }))
vi.mock('@/lib/content-source', () => ({ getContentSource: () => state.source }))
vi.mock('@/data/docs', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).docsModule)
vi.mock('@/lib/content/document', async (original) => ({ ...(await original<typeof import('@/lib/content/document')>()), ...(await import('@/lib/mcp/__tests__/agent-surface-fixture')).contentDocumentModule }))
vi.mock('@/lib/i18n/request', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).i18nRequestModule)
vi.mock('@/lib/i18n/translation-source', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).translationSourceModule)
vi.mock('@/config/api-reference', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).apiReferenceConfigModule)
vi.mock('@/lib/openapi/fetch', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).openApiFetchModule)
vi.mock('@/lib/site-config', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).siteConfigModule)
vi.mock('@/lib/agent-readiness', () => ({ computePublishedAgentReadiness: vi.fn() }))

import { GET } from './route'
import { fetchWithNativeAgentExport } from '@/lib/agent-export/native-worker'
import { PREPARED_BULK_FORMAT } from '@/lib/agent-export/prepared-contract'
import { contentDocumentModule, sources, HUMAN_ONLY, AGENT_ONLY, PLAYGROUND_SECRET } from '@/lib/mcp/__tests__/agent-surface-fixture'

const scopes = new AsyncLocalStorage<{ env: object; ctx: object }>()
const contextKey = Symbol.for('__cloudflare-context__')
const originalContext = Object.getOwnPropertyDescriptor(globalThis, contextKey)
let lengths: Array<number> = []
let payload: Buffer
beforeEach(() => {
  lengths = []
  vi.stubGlobal('FixedLengthStream', function (length: number) { lengths.push(length); return new TransformStream() })
  Object.defineProperty(globalThis, contextKey, { configurable: true, get: () => scopes.getStore() })
  const descriptor: PreparedBulkDescriptor = { version: 1, format: PREPARED_BULK_FORMAT, sourceRevision: 'a'.repeat(64), shards: [], records: {} }
  const pieces: Array<Buffer> = []
  let size = 0
  for (const id of ['guides/auth', 'es/guides/auth', 'introduction', 'changelog', 'guides/hidden', 'guides/draft']) {
    const isSpanish = id.startsWith('es/')
    const markdown = contentDocumentModule.getContentDocument(isSpanish ? id.slice(3) : id, isSpanish ? 'es' : undefined)!.content.markdown
    const bytes = Buffer.from(markdown)
    descriptor.records[`src/content/${id}.mdx`] = { sha256: createHash('sha256').update(sources[id]).digest('hex'), ranges: [{ shard: 0, start: size, end: size + bytes.length }] }
    pieces.push(bytes)
    size += bytes.length
  }
  payload = Buffer.concat(pieces)
  descriptor.shards = [{ path: 'bulk/0000.txt', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }]
  state.source = { kind: 'assets', bulkExport: async () => descriptor, read: async () => null, exists: async () => false, list: async () => [], modifiedAt: async () => 0 }
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (originalContext) Object.defineProperty(globalThis, contextKey, originalContext)
  else Reflect.deleteProperty(globalThis, contextKey)
})

async function nativeResponse(query = '') {
  const tasks: Array<Promise<unknown>> = []
  const ctx = { waitUntil: (task: Promise<unknown>) => { tasks.push(task) } }
  const fetch = vi.fn(async (request: Request) => { expect(request.headers.get('accept-encoding')).toBe('identity'); return new Response(new Uint8Array(payload)) })
  const application = { fetch: (request: Request, env: object) => scopes.run({ env, ctx }, () => GET(new NextRequest(request))) }
  const response = await fetchWithNativeAgentExport(application, new Request(`https://docs.acme.test/llms-full.txt${query}`), { ASSETS: { fetch } }, ctx)
  const body = await response.text()
  await Promise.all(tasks)
  return { response, body, fetch }
}

describe('authorized native GET transport', () => {
  it.each(['', '?locale=es'])('retains exact canonical listing, technical bytes, locale and authorized API text: %s', async (query) => {
    const legacy = await GET(new NextRequest(`https://docs.acme.test/llms-full.txt${query}`))
    const expected = await legacy.text()
    const { body, response, fetch } = await nativeResponse(query)
    expect(Buffer.from(body).equals(Buffer.from(expected))).toBe(true)
    expect(lengths).toEqual([Buffer.byteLength(expected)])
    expect(fetch).toHaveBeenCalledOnce()
    expect(body).not.toContain(HUMAN_ONLY)
    expect(body).not.toContain(PLAYGROUND_SECRET)
    expect(body).not.toContain('zebras')
    expect(response.headers.get('cache-control')).toBe(legacy.headers.get('cache-control'))
    expect(response.headers.get('content-language')).toBe(query ? 'es' : 'en')
    if (query) { expect(body).toContain('Autenticación'); expect(body).not.toContain('# API reference'); expect(body).not.toContain('# Introduction') }
    else { expect(body).toContain(AGENT_ONLY); expect(body).toContain('## POST /users — Create user') }
  })

  it('rejects an invalid locale without native delivery or exposing a prepared plan', async () => {
    const result = await nativeResponse('?locale=xx')
    expect(result.response.status).toBe(400)
    expect(result.fetch).not.toHaveBeenCalled()
    expect(lengths).toEqual([])
  })

  it('creates a fresh uncached handoff for each repeated request', async () => {
    const one = await nativeResponse()
    const two = await nativeResponse()
    expect(two.body).toBe(one.body)
    expect(lengths).toHaveLength(2)
    expect(one.fetch).toHaveBeenCalledOnce()
    expect(two.fetch).toHaveBeenCalledOnce()
    expect(one.response.headers.has('x-thally-native-export')).toBe(false)
  })
})
