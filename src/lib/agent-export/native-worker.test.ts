/** Fresh handoff, response policy and cancellation at the actual native seam. */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWithNativeAgentExport } from './native-worker'
import { createNativeAgentExportCapability, NATIVE_AGENT_EXPORT_SYMBOL, NATIVE_AGENT_EXPORT_HANDOFF_HEADER, NATIVE_AGENT_EXPORT_HANDOFF_VALUE, type NativeAgentExportCapability, type NativeAgentExportPlan } from './native-protocol'
import { nativeAgentExportByteLength } from './native-stream'

const bytes = Buffer.from('🙂 exact canonical bytes')
const plan = (origin = 'https://current.example'): NativeAgentExportPlan => ({ version: 1, origin, locale: 'fr', siteName: 'Current docs', siteDescription: 'Description', shards: [{ path: 'bulk/0000.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }], pages: [{ title: 'Title', description: 'Reader description', href: '/fr/page', ranges: [{ shard: 0, start: 0, end: bytes.length }] }], apiMarkdown: [] })
const capability = (environment: object) => (environment as Record<symbol, NativeAgentExportCapability>)[NATIVE_AGENT_EXPORT_SYMBOL]
const marked = (body: BodyInit | null = null, headers: Record<string, string> = {}) => new Response(body, { headers: { [NATIVE_AGENT_EXPORT_HANDOFF_HEADER]: NATIVE_AGENT_EXPORT_HANDOFF_VALUE, ...headers } })
const request = (origin = 'https://current.example', signal?: AbortSignal) => new Request(origin + '/llms-full.txt', { signal })
let declared: Array<number> = []
beforeEach(() => {
  declared = []
  vi.stubGlobal('FixedLengthStream', function (length: number) { declared.push(length); return new TransformStream<Uint8Array, Uint8Array>() })
})
afterEach(() => vi.unstubAllGlobals())
const lifetime = () => { const tasks: Array<Promise<unknown>> = []; return { tasks, context: { waitUntil: (task: Promise<unknown>) => { tasks.push(task) } } } }

describe('native Worker export handoff', () => {
  it('finishes the marked Next body before source reads and preserves private/security response policy', async () => {
    const env = { ASSETS: { fetch: vi.fn(async () => { expect(hasFinished).toBe(true); return new Response(bytes) }) } }
    let hasFinished = false
    const { tasks, context } = lifetime()
    const application = { async fetch(_request: Request, environment: object) {
      expect(capability(environment).accept(plan())).toBe(true)
      return marked(new ReadableStream({ start(controller) { queueMicrotask(() => { hasFinished = true; controller.close() }) } }), { 'Cache-Control': 'private, no-store', 'Content-Language': 'fr', 'Content-Type': 'text/plain; charset=utf-8', Vary: 'Cookie', Link: '</llms.txt>; rel="llms-txt"', 'X-Content-Type-Options': 'nosniff', 'Content-Length': '0', 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked', ETag: 'placeholder' })
    } }
    const response = await fetchWithNativeAgentExport(application, request(), env, context)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-language')).toBe('fr')
    expect(response.headers.get('vary')).toBe('Cookie')
    expect(response.headers.get('link')).toContain('/llms.txt')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    for (const key of ['content-length', 'content-encoding', 'transfer-encoding', 'etag', NATIVE_AGENT_EXPORT_HANDOFF_HEADER]) expect(response.headers.has(key)).toBe(false)
    expect(await response.text()).toContain(bytes.toString())
    await Promise.all(tasks)
    expect(declared).toEqual([nativeAgentExportByteLength(plan())])
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
  })

  it('keeps ordinary legacy responses and closes late acceptance without creating a native body', async () => {
    const response = new Response('Original body', { headers: { 'Cache-Control': 'public' } })
    let accept: NativeAgentExportCapability['accept'] | undefined
    const application = { async fetch(_request: Request, environment: object) { accept = capability(environment).accept; return response } }
    const { context } = lifetime()
    expect(await fetchWithNativeAgentExport(application, request(), { ASSETS: { fetch: vi.fn() } }, context)).toBe(response)
    expect(accept!(plan())).toBe(false)
    expect(declared).toEqual([])
  })

  it.each(['no-plan', 'no-marker', 'unexpected-body'] as const)('fails closed for an incomplete %s handoff', async (failure) => {
    const fetch = vi.fn()
    const application = { async fetch(_request: Request, environment: object) {
      if (failure !== 'no-plan') capability(environment).accept(plan())
      return failure === 'no-marker' ? new Response(null) : marked(failure === 'unexpected-body' ? 'unexpected bytes' : null)
    } }
    const result = await fetchWithNativeAgentExport(application, request(), { ASSETS: { fetch } }, lifetime().context)
    expect(result.status).toBe(503)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.has(NATIVE_AGENT_EXPORT_HANDOFF_HEADER)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(declared).toEqual([])
  })

  it('keeps middleware/error status and body even if an earlier step accepted a plan', async () => {
    const application = { async fetch(_request: Request, environment: object) { capability(environment).accept(plan()); return new Response('Reader denied', { status: 401, headers: { [NATIVE_AGENT_EXPORT_HANDOFF_HEADER]: 'v1', 'Cache-Control': 'private, no-store' } }) } }
    const response = await fetchWithNativeAgentExport(application, request(), { ASSETS: { fetch: vi.fn() } }, lifetime().context)
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Reader denied')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.has(NATIVE_AGENT_EXPORT_HANDOFF_HEADER)).toBe(false)
    expect(declared).toEqual([])
  })

  it('cancels a pending empty-body read once without waiting for an unsettled underlying cancel', async () => {
    const abort = new AbortController()
    const fetch = vi.fn()
    let cancels = 0
    let hasStarted = false
    const application = { async fetch(_request: Request, environment: object) {
      capability(environment).accept(plan())
      return marked(new ReadableStream({ pull() { hasStarted = true; return new Promise(() => {}) }, cancel() { cancels += 1; return new Promise(() => {}) } }, { highWaterMark: 0 }))
    } }
    const originalRequest = request('https://current.example', abort.signal)
    const result = fetchWithNativeAgentExport(application, originalRequest, { ASSETS: { fetch } }, lifetime().context)
    await vi.waitFor(() => expect(hasStarted).toBe(true))
    abort.abort()
    expect(originalRequest.signal.aborted).toBe(true)
    await Promise.resolve()
    expect(cancels).toBe(1)
    expect((await result).status).toBe(503)
    expect(cancels).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not wait on an unsettled underlying cancel for unexpected placeholder bytes', async () => {
    let cancels = 0
    const application = { async fetch(_request: Request, environment: object) {
      capability(environment).accept(plan())
      return marked(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel() { cancels += 1; return new Promise(() => {}) } }))
    } }
    expect((await fetchWithNativeAgentExport(application, request(), { ASSETS: { fetch: vi.fn() } }, lifetime().context)).status).toBe(503)
    expect(cancels).toBe(1)
  })

  it('preserves requests without the native platform/binding and all non-export methods or routes', async () => {
    const app = { fetch: vi.fn<(request: Request, environment: object) => Promise<Response>>(async () => new Response('original')) }
    const context = lifetime().context
    for (const req of [new Request('https://current.example/llms-full.txt', { method: 'HEAD' }), new Request('https://current.example/page')]) expect(await (await fetchWithNativeAgentExport(app, req, { ASSETS: { fetch: vi.fn() } }, context)).text()).toBe('original')
    expect(await (await fetchWithNativeAgentExport(app, request(), {}, context)).text()).toBe('original')
    vi.stubGlobal('FixedLengthStream', undefined)
    expect(await (await fetchWithNativeAgentExport(app, request(), { ASSETS: { fetch: vi.fn() } }, context)).text()).toBe('original')
    expect(app.fetch).toHaveBeenCalledTimes(4)
    expect(app.fetch.mock.calls.every(([, env]) => !(env as Record<symbol, unknown>)[NATIVE_AGENT_EXPORT_SYMBOL])).toBe(true)
  })

  it('keeps two overlapping request capabilities and plans isolated', async () => {
    const captures: Array<NativeAgentExportCapability> = []
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const app = { async fetch(_request: Request, environment: object) {
      const cap = capability(environment)
      captures.push(cap)
      if (captures.length === 2) release()
      await barrier
      expect(cap.accept(plan(new URL(cap.requestUrl).origin))).toBe(true)
      return marked()
    } }
    const lifetimes = [lifetime(), lifetime()]
    const responses = await Promise.all(['https://one.example', 'https://two.example'].map((origin, index) => fetchWithNativeAgentExport(app, request(origin), { ASSETS: { fetch: async () => new Response(bytes) } }, lifetimes[index].context)))
    const bodies = await Promise.all(responses.map((response) => response.text()))
    expect(bodies[0]).toContain('Source: https://one.example')
    expect(bodies[0]).not.toContain('https://two.example')
    expect(bodies[1]).toContain('Source: https://two.example')
    expect(captures[0]).not.toBe(captures[1])
    await Promise.all(lifetimes.flatMap((item) => item.tasks))
  })

  it('closes a capability when the application rejects', async () => {
    let captured: NativeAgentExportCapability | undefined
    const app = { async fetch(_request: Request, environment: object) { captured = capability(environment); throw new Error('Application failure') } }
    await expect(fetchWithNativeAgentExport(app, request(), { ASSETS: { fetch: vi.fn() } }, lifetime().context)).rejects.toThrow('Application failure')
    expect(captured!.accept(plan())).toBe(false)
    // A detached HTTP value cannot manufacture a wrapper-owned acceptance.
    expect(createNativeAgentExportCapability(request()).finish()).toBeNull()
  })
})
