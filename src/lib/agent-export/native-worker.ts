/**
 * Cloudflare-native body transport after the ordinary Next GET authorizes it.
 *
 * The fresh in-process capability grants no HTTP caller authority. Next must
 * accept a bounded plain plan AND finish its marked empty response before any
 * protected body is read. Only the final native stream outlives that boundary.
 * Existing Worker methods and named Durable Object exports stay with OpenNext.
 */
import { createNativeAgentExportCapability, NATIVE_AGENT_EXPORT_SYMBOL, NATIVE_AGENT_EXPORT_HANDOFF_HEADER, NATIVE_AGENT_EXPORT_HANDOFF_VALUE } from './native-protocol'
import { nativeAgentExportByteLength, nativeAgentExportStream, type NativeExportAssetBinding } from './native-stream'

interface NativeLifetime { waitUntil: (promise: Promise<unknown>) => void }
interface NativeApplication { fetch: (request: Request, environment: object, context: NativeLifetime) => Response | Promise<Response> }
interface NativeLengthBridge { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
type NativeLengthConstructor = new (bytes: number) => NativeLengthBridge

/** Optional platform extension; Node/self-hosted handlers retain their old path. */
function fixedLengthConstructor(): NativeLengthConstructor | null {
  const candidate = (globalThis as typeof globalThis & { FixedLengthStream?: NativeLengthConstructor }).FixedLengthStream
  return typeof candidate === 'function' ? candidate : null
}

function assetBinding(environment: object): NativeExportAssetBinding | null {
  const value = (environment as { ASSETS?: NativeExportAssetBinding }).ASSETS
  return value && typeof value.fetch === 'function' ? value : null
}

function failure(): Response {
  return new Response('The prepared export handoff could not be completed.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } })
}

/** A marked handoff must finish empty; an unexpected body never becomes success. */
async function consumeHandoff(response: Response, signal: AbortSignal): Promise<boolean> {
  if (!response.body) return !signal.aborted
  const reader = response.body.getReader()
  let hasCancelled = false
  const cancel = () => {
    if (hasCancelled) return
    hasCancelled = true
    // Adapter cancellation may never settle. Cancellation must unblock this
    // handoff immediately instead of holding its authorization context open.
    void reader.cancel(new DOMException('Aborted', 'AbortError')).catch(() => undefined)
  }
  let resolveAbort!: () => void
  const aborted = new Promise<null>((resolve) => { resolveAbort = () => resolve(null) })
  const onAbort = () => { cancel(); resolveAbort() }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), aborted])
      if (!part || signal.aborted || (!part.done && part.value.byteLength)) {
        cancel()
        return false
      }
      if (part.done) return true
    }
  } finally { signal.removeEventListener('abort', onAbort); reader.releaseLock() }
}

/** Preserve the existing application result unless a verified native handoff succeeds. */
export async function fetchWithNativeAgentExport(
  application: NativeApplication,
  request: Request,
  environment: object,
  context: NativeLifetime,
): Promise<Response> {
  const url = new URL(request.url)
  const FixedLength = fixedLengthConstructor()
  const assets = assetBinding(environment)
  if (request.method !== 'GET' || url.pathname !== '/llms-full.txt' || !FixedLength || !assets) return application.fetch(request, environment, context)

  const handoff = createNativeAgentExportCapability(request)
  let response: Response
  try {
    response = await application.fetch(request, { ...environment, [NATIVE_AGENT_EXPORT_SYMBOL]: handoff.capability }, context)
  } catch (error) { handoff.finish(); throw error }
  const plan = handoff.finish()
  const isMarked = response.headers.get(NATIVE_AGENT_EXPORT_HANDOFF_HEADER) === NATIVE_AGENT_EXPORT_HANDOFF_VALUE
  if (!plan && !isMarked) return response
  const headers = new Headers(response.headers)
  headers.delete(NATIVE_AGENT_EXPORT_HANDOFF_HEADER)
  if (response.status !== 200) return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  if (!plan || !isMarked || request.signal.aborted) {
    void response.body?.cancel().catch(() => undefined)
    return failure()
  }
  try {
    if (!(await consumeHandoff(response, request.signal))) return failure()
  } catch { return failure() }
  // Placeholder transport metadata must not describe the replacement body.
  // Security, reader cache policy, language, Vary and links are copied exactly.
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'etag']) headers.delete(name)
  const bridge = new FixedLength(nativeAgentExportByteLength(plan))
  const pump = nativeAgentExportStream(plan, assets, request.signal).pipeTo(bridge.writable, { signal: request.signal })
  context.waitUntil(pump)
  return new Response(bridge.readable, { status: 200, headers })
}
