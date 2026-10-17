/** Byte fidelity, reader-range isolation and cancellation of native delivery. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { nativeAgentExportByteLength, nativeAgentExportStream } from './native-stream'
import type { NativeAgentExportPlan } from './native-protocol'
import { agentExportHeader, agentExportPagePrefix, AGENT_EXPORT_PAGE_SUFFIX } from './format'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const page = { title: 'Page', description: 'Current description', href: '/page' }
function makePlan(parts: Array<Uint8Array>): NativeAgentExportPlan {
  return {
    version: 1, origin: 'https://current.example', locale: 'fr', siteName: 'Current site', siteDescription: 'Current identity',
    shards: parts.map((bytes, index) => ({ path: `bulk/${String(index).padStart(4, '0')}.txt`, bytes: bytes.length, sha256: digest(bytes) })),
    pages: [{ ...page, ranges: parts.map((bytes, shard) => ({ shard, start: 0, end: bytes.length })) }], apiMarkdown: [],
  }
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Array<Uint8Array> = []
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    expect(part.value.byteLength).toBeLessThanOrEqual(64 * 1024)
    parts.push(part.value)
  }
  return Buffer.concat(parts)
}
const header = (plan: NativeAgentExportPlan) => agentExportHeader({ name: plan.siteName, description: plan.siteDescription }, plan.origin, plan.locale)

describe('native agent export', () => {
  it('preserves canonical bytes across UTF-8 splits between shards and chunks', async () => {
    const markdown = Buffer.from('🙂é\n```typescript\nconst literal = "{safe}";\n```\nhttps://authored.example\n')
    const parts = [markdown.subarray(0, 2), markdown.subarray(2)]
    const plan = makePlan(parts)
    const result = await collect(nativeAgentExportStream(plan, { async fetch(request) {
      const index = plan.shards.findIndex((shard) => request.url.endsWith(shard.path))
      let position = 0
      return new Response(new ReadableStream({ pull(controller) {
        if (position === parts[index].length) controller.close()
        else controller.enqueue(parts[index].subarray(position, ++position))
      } }))
    } }, new AbortController().signal))
    expect(result).toEqual(Buffer.from(header(plan) + agentExportPagePrefix(page, plan.origin) + markdown.toString() + AGENT_EXPORT_PAGE_SUFFIX))
    expect(nativeAgentExportByteLength(plan)).toBe(result.byteLength)
  })

  it('counts current API framing and authored Unicode without reading protected assets', async () => {
    const plan = makePlan([])
    plan.apiMarkdown = ['## Café 🙂\n\nGET /v1/items\n']
    const result = await collect(nativeAgentExportStream(plan, { async fetch() { throw new Error('No asset ranges selected') } }, new AbortController().signal))
    expect(nativeAgentExportByteLength(plan)).toBe(result.byteLength)
  })

  it('does not emit unauthorized bytes between selected ranges', async () => {
    const bytes = Buffer.from('PUBLIC-ONEPRIVATE-SECRET-PAGETWO')
    const plan = makePlan([bytes])
    plan.pages = [
      { ...page, title: 'One', ranges: [{ shard: 0, start: 0, end: 10 }] },
      { ...page, title: 'Two', ranges: [{ shard: 0, start: bytes.length - 3, end: bytes.length }] },
    ]
    let fetches = 0
    const result = Buffer.from(await collect(nativeAgentExportStream(plan, { async fetch() { fetches += 1; return new Response(bytes) } }, new AbortController().signal))).toString()
    expect(result).toContain('PUBLIC-ONE')
    expect(result).toContain('TWO')
    expect(result).not.toContain('PRIVATE-SECRET-PAGE')
    expect(fetches).toBe(1)
  })

  it('crosses ten thousand page boundaries with one source read and bounded output', async () => {
    const bytes = Buffer.alloc(10_000, 120)
    const plan = makePlan([bytes])
    plan.pages = Array.from({ length: 10_000 }, (_, index) => ({ ...page, title: `Page ${index}`, ranges: [{ shard: 0, start: index, end: index + 1 }] }))
    let reads = 0
    let fetches = 0
    const stream = nativeAgentExportStream(plan, { async fetch() {
      fetches += 1
      return new Response(new ReadableStream({ pull(controller) { reads += 1; if (reads === 1) controller.enqueue(bytes); else controller.close() } }, { highWaterMark: 0 }))
    } }, new AbortController().signal)
    expect(fetches).toBe(0)
    const body = Buffer.from(await collect(stream)).toString()
    expect(body.match(/\n# Page \d+\n/g)).toHaveLength(10_000)
    expect(fetches).toBe(1)
    expect(reads).toBe(2)
  })

  it('fails the stream instead of completing a corrupt or truncated corpus', async () => {
    const bytes = Buffer.from('valid')
    const plan = makePlan([bytes])
    await expect(collect(nativeAgentExportStream(plan, { async fetch() { return new Response('wrong') } }, new AbortController().signal))).rejects.toThrow(/integrity/)
    await expect(collect(nativeAgentExportStream(plan, { async fetch() { return new Response('v') } }, new AbortController().signal))).rejects.toThrow(/range|integrity/)
    await expect(collect(nativeAgentExportStream(plan, { async fetch() { return new Response('too-long') } }, new AbortController().signal))).rejects.toThrow(/length/)
  })

  it.each([64 * 1024, 128 * 1024])('withholds final bytes until EOF hash verification for a %i-byte response', async (total) => {
    const initial = makePlan([Buffer.alloc(1)])
    const framingBytes = Buffer.byteLength(header(initial) + agentExportPagePrefix(page, initial.origin) + AGENT_EXPORT_PAGE_SUFFIX)
    const bytes = Buffer.alloc(total - framingBytes, 120)
    const plan = makePlan([bytes])
    plan.shards[0].sha256 = digest(Buffer.alloc(bytes.length, 121))
    const reader = nativeAgentExportStream(plan, { async fetch() { return new Response(bytes) } }, new AbortController().signal).getReader()
    let delivered = 0
    await expect((async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        delivered += next.value.byteLength
      }
    })()).rejects.toThrow(/integrity/)
    // A FixedLengthStream must not receive its declared count before the
    // integrity check, including when the body ends exactly on a batch edge.
    expect(delivered).toBeLessThan(total)
    expect(delivered).toBe(Math.max(0, total - 64 * 1024))
  })

  it('fails after a streamed prefix without releasing its unverified last batch', async () => {
    const bytes = Buffer.alloc(4 * 64 * 1024, 120)
    const plan = makePlan([bytes])
    let reads = 0
    const reader = nativeAgentExportStream(plan, { async fetch() {
      return new Response(new ReadableStream({ pull(controller) {
        if (reads === 3) controller.error(new Error('post-prefix failure'))
        else { controller.enqueue(bytes.subarray(reads * 64 * 1024, ++reads * 64 * 1024)) }
      } }, { highWaterMark: 0 }))
    } }, new AbortController().signal).getReader()
    let delivered = 0
    await expect((async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        delivered += next.value.byteLength
      }
    })()).rejects.toThrow('post-prefix failure')
    expect(delivered).toBeGreaterThan(0)
    expect(delivered).toBeLessThan(3 * 64 * 1024)
  })

  it('forwards consumer cancellation exactly once after an emitted prefix', async () => {
    const bytes = Buffer.alloc(4 * 64 * 1024, 120)
    const plan = makePlan([bytes, bytes])
    let cancelled = 0
    let reads = 0
    let fetches = 0
    const reader = nativeAgentExportStream(plan, { async fetch() {
      fetches += 1
      return new Response(new ReadableStream({ pull(controller) {
        controller.enqueue(bytes.subarray(reads * 64 * 1024, ++reads * 64 * 1024))
      }, cancel() { cancelled += 1 } }, { highWaterMark: 0 }))
    } }, new AbortController().signal).getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
    const afterCancel = reads
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toBe(afterCancel)
    expect(cancelled).toBe(1)
    expect(fetches).toBe(1)
  })

  it('cancels a pending body without starting another shard', async () => {
    const bytes = Buffer.from('body')
    const plan = makePlan([bytes, bytes])
    const abort = new AbortController()
    let complete: (() => void) | undefined
    let fetches = 0
    let cancelled = 0
    const stream = nativeAgentExportStream(plan, { async fetch() {
      fetches += 1
      return new Response(new ReadableStream({ pull(controller) {
        return new Promise<void>((resolve) => { complete = () => { try { controller.enqueue(bytes) } catch {} resolve() } })
      }, cancel() { cancelled += 1 } }, { highWaterMark: 0 }))
    } }, abort.signal)
    const reader = stream.getReader()
    const pending = reader.read()
    while (!complete) await new Promise((resolve) => setTimeout(resolve, 0))
    abort.abort()
    await expect(pending).rejects.toThrow(/Aborted/)
    complete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetches).toBe(1)
    expect(cancelled).toBe(1)
  })
})
