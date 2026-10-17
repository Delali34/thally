/** Asset-service backpressure covers response bodies, retries and recovery. */
import { describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CONTENT_MANIFEST_PATH, createAssetsContentSource, type ContentSource } from '@/lib/content-source'

const fallback: ContentSource = {
  kind: 'filesystem', exists: async () => false, read: async () => null,
  modifiedAt: async () => 0, list: async () => [],
}
const paths = (count: number) => Array.from({ length: count }, (_, index) => `src/content/capacity-${index}.mdx`)
const manifest = (files: Array<string>) => Response.json({ version: 1, files: Object.fromEntries(files.map((path) => [path, {}])) })

describe('bounded asset reads', () => {
  it('reads all 10,000 requested bodies with at most four transfers in one owner', async () => {
    const files = paths(10_000)
    let active = 0
    let peak = 0
    let completed = 0
    const source = createAssetsContentSource(fallback, () => async (path) => {
      if (path === CONTENT_MANIFEST_PATH) return manifest(files)
      active += 1
      peak = Math.max(peak, active)
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await Promise.resolve()
          controller.enqueue(new TextEncoder().encode(`Exact ${path}`))
          controller.close()
        },
      })
      const response = new Response(body)
      const text = response.text.bind(response)
      response.text = async () => {
        try { return await text() }
        finally { active -= 1; completed += 1 }
      }
      return response
    })
    const result = await Promise.all(files.map((path) => source.read(path)))
    expect(peak).toBe(4)
    expect(active).toBe(0)
    expect(completed).toBe(10_000)
    expect(result.every((file, index) => file?.content === `Exact /_thally/content/${files[index]}`)).toBe(true)
  })

  it('keeps four transfer slots per request with one shared binding, without cross-request wakeups', async () => {
    const contexts = new AsyncLocalStorage<object>()
    const files = paths(10)
    const releases = new Map<string, () => void>()
    const started: Array<string> = []
    const sharedFetcher = async (path: string) => {
      if (path === CONTENT_MANIFEST_PATH) return manifest(files)
      started.push(path)
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        releases.set(path, () => { controller.enqueue(new TextEncoder().encode(path)); controller.close() })
      } }))
    }
    const source = createAssetsContentSource(fallback, () => sharedFetcher, () => contexts.getStore() ?? null)
    await source.exists(files[0])
    const first = contexts.run({}, () => Promise.all(files.slice(0, 5).map((path) => source.read(path))))
    await vi.waitFor(() => expect(started).toHaveLength(4))
    const second = contexts.run({}, () => Promise.all(files.slice(5).map((path) => source.read(path))))
    await vi.waitFor(() => expect(started).toHaveLength(8))
    // Releasing one first-request slot may start only its own fifth read.
    releases.get(`/_thally/content/${files[0]}`)!()
    releases.delete(`/_thally/content/${files[0]}`)
    await vi.waitFor(() => expect(started).toContain(`/_thally/content/${files[4]}`))
    expect(started).not.toContain(`/_thally/content/${files[9]}`)
    releases.get(`/_thally/content/${files[5]}`)!()
    releases.delete(`/_thally/content/${files[5]}`)
    await vi.waitFor(() => expect(started).toHaveLength(10))
    for (const release of releases.values()) release()
    expect((await first).length + (await second).length).toBe(10)
  })

  it('does not release slots while headers are available but bodies are pending', async () => {
    const files = paths(8)
    const releases: Array<() => void> = []
    let started = 0
    const source = createAssetsContentSource(fallback, () => async (path) => {
      if (path === CONTENT_MANIFEST_PATH) return manifest(files)
      started += 1
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          releases.push(() => { controller.enqueue(new TextEncoder().encode(path)); controller.close() })
        },
      }))
    })
    const pending = Promise.all(files.map((path) => source.read(path)))
    await vi.waitFor(() => expect(started).toBe(4))
    expect(releases).toHaveLength(4)
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(started).toBe(8))
    releases.splice(0).forEach((release) => release())
    expect(await pending).toHaveLength(8)
  })

  it('cancels transient response bodies before retrying and does not retry missing files', async () => {
    const [path] = paths(1)
    let calls = 0
    let cancelled = 0
    const source = createAssetsContentSource(fallback, () => async (assetPath) => {
      if (assetPath === CONTENT_MANIFEST_PATH) return manifest([path])
      calls += 1
      if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled += 1 } }), { status: 503 })
      return new Response('Recovered payload')
    })
    expect((await source.read(path))?.content).toBe('Recovered payload')
    expect(calls).toBe(2)
    expect(cancelled).toBe(1)
    const missingFetch = vi.fn(async () => new Response(null, { status: 404 }))
    const missing = createAssetsContentSource(fallback, () => async (assetPath) => assetPath === CONTENT_MANIFEST_PATH ? manifest([path]) : missingFetch())
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await missing.read(path)).toBeNull()
    expect(missingFetch).toHaveBeenCalledOnce()
    warning.mockRestore()
  })

  it.each(['manifest', 'file'])('rejects exhausted %s failures and recovers on the next read without a reset', async (target) => {
    const [path] = paths(1)
    let unavailable = true
    let failures = 0
    const source = createAssetsContentSource(fallback, () => async (assetPath) => {
      if (unavailable && (target === 'manifest' ? assetPath === CONTENT_MANIFEST_PATH : assetPath !== CONTENT_MANIFEST_PATH)) {
        failures += 1
        return new Response(null, { status: 503 })
      }
      return assetPath === CONTENT_MANIFEST_PATH ? manifest([path]) : new Response('Recovered exact bytes')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(source.read(path)).rejects.toThrow('temporarily unavailable (503)')
    expect(failures).toBe(3)
    unavailable = false
    expect((await source.read(path))?.content).toBe('Recovered exact bytes')
    warning.mockRestore()
  })

  it('releases capacity and retries when a successful response body fails during consumption', async () => {
    const [path] = paths(1)
    let calls = 0
    const source = createAssetsContentSource(fallback, () => async (assetPath) => {
      if (assetPath === CONTENT_MANIFEST_PATH) return manifest([path])
      calls += 1
      if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Truncated transport')) } }))
      return new Response('Complete body')
    })
    expect((await source.read(path))?.content).toBe('Complete body')
    expect(calls).toBe(2)
  })
})
