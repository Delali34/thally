/** Real reader token/access/version rules remain authoritative with prepared bytes. */
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { ContentSource } from '@/lib/content-source/types'
import type { PreparedBulkDescriptor } from '@/lib/agent-export/prepared-contract'

const state = vi.hoisted(() => ({ sources: {} as Record<string, string>, source: null as ContentSource | null, oldCurrent: false, revision: 0 }))
const config = vi.hoisted(() => ({ auth: { mode: 'jwt', default: 'private' }, markdown: { enabled: true }, navigation: { versions: [{ label: 'v2', default: true }, { label: 'v1' }] }, i18n: { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] }, tabs: [{ tab: 'Current', version: 'v2', hidden: false, pages: ['introduction', 'unmarked', 'beta', 'hidden', 'draft'] }, { tab: 'Old', version: 'v1', hidden: true, pages: ['old'] }] }))
const operation = vi.hoisted(() => ({ slug: ['default', 'widgets', 'get'], href: '/api/default/widgets/get', operation: { title: 'List widgets', method: 'GET', path: '/widgets', tags: ['Widgets'], responses: [], servers: [], security: [], authSchemes: [], parameters: { path: [], query: [], header: [], cookie: [] } } }))
vi.mock('@/lib/docs-json-config', () => ({ getDocsJsonConfig: () => ({ ...config, tabs: config.tabs.map((tab) => ({ ...tab, hidden: state.oldCurrent ? tab.version !== 'v1' : tab.version !== 'v2' })) }), getDocsJsonConfigRevision: () => state.revision }))
vi.mock('@/lib/runtime-sources', () => ({ listRuntimeSources: () => Object.keys(state.sources), readRuntimeSource: (file: string) => state.sources[file], runtimeSourceExists: (file: string) => file in state.sources, runtimeSourceModifiedAt: () => 0 }))
vi.mock('@/lib/content-index', () => ({ getContentIndex: () => null, loadContentIndex: async () => null, isIndexedContentPath: () => false }))
vi.mock('@/lib/content-source', () => ({ getContentSource: () => state.source, isRemoteContentSource: () => true }))
vi.mock('@/config/api-reference', () => ({ apiReferenceConfig: { defaultSpecId: 'default', specs: [] }, getOpenApiSpecUrl: () => null }))
vi.mock('@/data/api-reference', () => ({ getAllApiOperationNodes: async () => [operation], getApiOperationBySlug: async () => null, getApiOperationSearchIndex: async () => [], servedSpecPathForFrontmatter: async () => undefined, withApiNavigation: async (collections: unknown) => collections }))
vi.mock('@/lib/cloud-link/client', () => ({ getCloudSiteConfig: async () => null }))
vi.mock('@/lib/i18n/request', () => ({ getEffectiveI18nConfig: async () => config.i18n, getRepositoryI18nConfig: () => config.i18n }))
vi.mock('@/lib/site-config', () => ({ resolveSiteConfig: async () => ({ name: 'Reader docs', description: 'Private by default' }), resolveRequestSiteConfig: async () => ({ name: 'Reader docs', description: 'Private by default' }) }))
import { GET } from './route'
import { parseMdxContent } from '@thallylabs/core/markdown'
import { parseFrontmatter } from '@/lib/frontmatter'
import { fetchWithNativeAgentExport } from '@/lib/agent-export/native-worker'
import { resetReaderAuthConfigForTests } from '@/lib/reader-auth/config'
import { mintAgentToken } from '@/lib/reader-auth/session'

const origin = 'https://reader.example'
const scopes = new AsyncLocalStorage<{ env: object; ctx: object }>()
const key = Symbol.for('__cloudflare-context__')
const previousContext = Object.getOwnPropertyDescriptor(globalThis, key)
let payload: Buffer
let betaToken = ''
let readerToken = ''
let lengths: Array<number> = []
beforeAll(async () => {
  vi.stubEnv('THALLY_READER_SESSION_SECRET', 'session-fixture-'.repeat(4))
  vi.stubEnv('THALLY_READER_TOKEN_KEYS', `k1:${'token-fixture-'.repeat(4)}`)
  vi.stubEnv('THALLY_SITE_URL', origin)
  vi.stubGlobal('FixedLengthStream', function (length: number) { lengths.push(length); return new TransformStream() })
  Object.defineProperty(globalThis, key, { configurable: true, get: () => scopes.getStore() })
  state.sources = {
    'src/content/introduction.mdx': '---\ntitle: Introduction\npublic: true\n---\nPUBLIC_BODY',
    'src/content/unmarked.mdx': '---\ntitle: Unmarked\n---\nPRIVATE_BODY',
    'src/content/fr/unmarked.mdx': '---\ntitle: Français\ngroups: [beta]\n---\nFRENCH_BETA_BODY',
    'src/content/beta.mdx': '---\ntitle: Beta\ngroups: [beta]\n---\nBETA_BODY',
    'src/content/hidden.mdx': '---\ntitle: Hidden\npublic: true\nhidden: true\n---\nHIDDEN_BODY',
    'src/content/draft.mdx': '---\ntitle: Draft\npublic: true\nnoindex: true\n---\nDRAFT_BODY',
    'src/content/old.mdx': '---\ntitle: Old\npublic: true\n---\nOLD_VERSION_BODY',
  }
  const descriptor: PreparedBulkDescriptor = { version: 1, format: 'thally-agent-bulk-v1', sourceRevision: 'a'.repeat(64), shards: [], records: {} }
  let offset = 0
  const pieces: Array<Buffer> = []
  for (const [physicalPath, raw] of Object.entries(state.sources)) {
    const bytes = Buffer.from(parseMdxContent(parseFrontmatter(raw).content, 'agents').markdown)
    descriptor.records[physicalPath] = { sha256: createHash('sha256').update(raw).digest('hex'), ranges: [{ shard: 0, start: offset, end: offset + bytes.length }] }
    pieces.push(bytes)
    offset += bytes.length
  }
  payload = Buffer.concat(pieces)
  descriptor.shards = [{ path: 'bulk/0000.txt', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }]
  state.source = { kind: 'assets', bulkExport: async () => descriptor, exists: async (file) => file in state.sources, list: async () => Object.keys(state.sources), modifiedAt: async () => 0, read: async (file) => file in state.sources ? { content: state.sources[file], modifiedAtMs: 0 } : null }
  betaToken = (await mintAgentToken({ label: 'beta test', groups: ['beta'], expiresInSeconds: 3600 })).token
  readerToken = (await mintAgentToken({ label: 'reader test', groups: [], expiresInSeconds: 3600 })).token
})
beforeEach(() => { state.oldCurrent = false; state.revision += 1; resetReaderAuthConfigForTests(); lengths = [] })
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (previousContext) Object.defineProperty(globalThis, key, previousContext); else Reflect.deleteProperty(globalThis, key) })

async function compare(token = '', locale = '') {
  const request = new Request(origin + '/llms-full.txt' + (locale ? '?locale=' + locale : ''), { headers: token ? { Authorization: 'Bearer ' + token } : {} })
  const legacy = await GET(new NextRequest(request))
  const expected = await legacy.text()
  const tasks: Array<Promise<unknown>> = []
  const ctx = { waitUntil: (task: Promise<unknown>) => { tasks.push(task) } }
  const application = { fetch: (request: Request, env: object) => scopes.run({ env, ctx }, () => GET(new NextRequest(request))) }
  const response = await fetchWithNativeAgentExport(application, request, { ASSETS: { fetch: async () => new Response(new Uint8Array(payload)) } }, ctx)
  const actual = await response.text()
  await Promise.all(tasks)
  expect(actual).toBe(expected)
  expect(lengths).toEqual([Buffer.byteLength(expected)])
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  for (const excluded of ['HIDDEN_BODY', 'DRAFT_BODY']) expect(actual).not.toContain(excluded)
  return actual
}

describe('native full corpus with real reader authority', () => {
  it('keeps anonymous private-by-default pages and operations out while retaining explicit public pages', async () => {
    const body = await compare()
    expect(body).toContain('PUBLIC_BODY')
    for (const excluded of ['PRIVATE_BODY', 'BETA_BODY', 'OLD_VERSION_BODY', 'List widgets']) expect(body).not.toContain(excluded)
  })
  it('honors a real verified ungrouped reader token and restricts translated group pages', async () => {
    const body = await compare(readerToken)
    expect(body).toContain('PRIVATE_BODY')
    expect(body).toContain('List widgets')
    expect(body).not.toContain('BETA_BODY')
    lengths = []
    expect(await compare(readerToken, 'fr')).not.toContain('FRENCH_BETA_BODY')
  })
  it('includes exact group-authorized translation bodies without default-locale API operations', async () => {
    const body = await compare(betaToken, 'fr')
    expect(body).toContain('FRENCH_BETA_BODY')
    expect(body).not.toContain('List widgets')
    expect(body).not.toContain('PUBLIC_BODY')
  })
  it('withholds invalid credentials and switches actual configured current versions', async () => {
    expect(await compare('thrt_invalid')).not.toContain('PRIVATE_BODY')
    state.oldCurrent = true
    state.revision += 1
    lengths = []
    const body = await compare(betaToken)
    expect(body).toContain('OLD_VERSION_BODY')
    expect(body).not.toContain('PUBLIC_BODY')
    expect(body).not.toContain('PRIVATE_BODY')
  })
})
