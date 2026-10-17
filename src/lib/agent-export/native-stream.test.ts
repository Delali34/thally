/** Byte fidelity, reader-range isolation and cancellation of native delivery. */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { nativeAgentExportByteLength, nativeAgentExportStream } from './native-stream'
import type { NativeAgentExportPlan } from './native-protocol'
import { agentExportApiHeader, agentExportHeader, agentExportPagePrefix, AGENT_EXPORT_PAGE_SUFFIX } from './format'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const page = { title: 'Page', description: 'Current description', href: '/page' }
function makePlan(parts: Array<Uint8Array>): NativeAgentExportPlan {
  return {
    version: 1, origin: 'https://current.example', locale: 'fr', siteName: 'Current site', siteDescription: 'Current identity',
    shards: parts.map((bytes, index) => ({ path: `bulk/${String(index).padStart(4, '0')}.txt`, bytes: bytes.length, sha256: digest(bytes) })),
    pages: [{ ...page, ranges: parts.map((bytes, shard) => ({ shard, start: 0, end: bytes.length })) }], apiMarkdown: [],
  }
}
async function collect(stream: ReadableStream<Uint8Array>, onChunk?: (bytes: Uint8Array) => void): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Array<Uint8Array> = []
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    expect(part.value.byteLength).toBeGreaterThan(0)
    expect(part.value.byteLength).toBeLessThanOrEqual(64 * 1024)
    onChunk?.(part.value)
    parts.push(part.value)
  }
  return Buffer.concat(parts)
}
const header = (plan: NativeAgentExportPlan) => agentExportHeader({ name: plan.siteName, description: plan.siteDescription }, plan.origin, plan.locale)

/** Reference framing uses the ordinary shared formatter, not the stream cursor. */
function canonicalBytes(plan: NativeAgentExportPlan, shards: Array<Uint8Array>): Buffer {
  const pieces = [Buffer.from(header(plan))]
  for (const entry of plan.pages) {
    pieces.push(Buffer.from(agentExportPagePrefix(entry, plan.origin)))
    for (const range of entry.ranges) pieces.push(Buffer.from(shards[range.shard].subarray(range.start, range.end)))
    pieces.push(Buffer.from(AGENT_EXPORT_PAGE_SUFFIX))
  }
  if (plan.apiMarkdown.length) {
    pieces.push(Buffer.from(agentExportApiHeader(plan.origin)))
    for (const markdown of plan.apiMarkdown) pieces.push(Buffer.from(`\n${markdown}\n`))
  }
  return Buffer.concat(pieces)
}

const scalarBoundaries = [1, 2, 3].flatMap((remaining) => ['é', '漢', '😀', '\ud800']
  .filter((scalar) => Buffer.byteLength(scalar) > remaining)
  .map((scalar) => ({ name: `${Buffer.from(scalar).toString('hex')} with ${remaining} bytes remaining`, remaining, scalar })))

function scalarBoundaryPlan(remaining: number, scalar: string): { plan: NativeAgentExportPlan; bytes: Buffer<ArrayBuffer> } {
  const initial = makePlan([Buffer.alloc(1)])
  const beforeTitle = Buffer.byteLength(header(initial) + '\n# ')
  initial.pages[0].title = 'a'.repeat(64 * 1024 - remaining - beforeTitle) + scalar + 'tail'
  initial.pages[0].description = ''
  initial.pages[0].ranges[0].end = 0
  const framingBytes = canonicalBytes(initial, [Buffer.alloc(0)]).byteLength
  const bytes = Buffer.alloc(128 * 1024 - framingBytes, 120)
  initial.shards[0] = { ...initial.shards[0], bytes: bytes.length, sha256: digest(bytes) }
  initial.pages[0].ranges[0].end = bytes.length
  return { plan: initial, bytes }
}

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

  it.each([
    { name: 'ASCII', value: 'plain\0\n"\\' },
    { name: 'multilingual and astral', value: 'Français 中文 العربية 😀𐀀' },
    { name: 'malformed surrogate sequence', value: '\ud800x\udc00\ud800\ud800\udc00' },
  ])('counts exact $name page and API framing', async ({ value }) => {
    const bytes = Buffer.from('```typescript\nconst exact = "{safe}";\n```\n')
    const plan = makePlan([bytes])
    plan.pages[0] = { ...plan.pages[0], title: value, description: value, href: '/référence/😀' }
    plan.siteDescription = value
    plan.apiMarkdown = [`## API\n${value}\n\nGET /v1/items\n`]
    const expected = canonicalBytes(plan, [bytes])
    expect(nativeAgentExportByteLength(plan)).toBe(expected.byteLength)
    expect(await collect(nativeAgentExportStream(plan, { async fetch() { return new Response(bytes) } }, new AbortController().signal))).toEqual(expected)
  })

  it('does not allocate a separate encoded framing buffer for every page', async () => {
    const bytes = Buffer.from('body')
    const plan = makePlan([bytes])
    const expected = canonicalBytes(plan, [bytes])
    // Large exports previously performed this allocation in both the length
    // pass and every delivered prefix/suffix. Existing output batches suffice.
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => { throw new Error('Unexpected per-piece encoded allocation') })
    try {
      expect(nativeAgentExportByteLength(plan)).toBe(expected.byteLength)
      expect(await collect(nativeAgentExportStream(plan, { async fetch() { return new Response(bytes) } }, new AbortController().signal))).toEqual(expected)
    } finally { encode.mockRestore() }
  })

  it('rejects lengths outside the safe integer bound', () => {
    const plan = makePlan([Buffer.from('body')])
    plan.pages[0].ranges[0].end = Number.MAX_SAFE_INTEGER
    expect(() => nativeAgentExportByteLength(plan)).toThrow(/integer bound/)
  })

  it.each(scalarBoundaries)('retries the complete UTF-8 scalar at $name without empty chunks', async ({ remaining, scalar }) => {
    const { plan, bytes } = scalarBoundaryPlan(remaining, scalar)
    const expected = canonicalBytes(plan, [bytes])
    const sizes: Array<number> = []
    const result = await collect(nativeAgentExportStream(plan, { async fetch() { return new Response(bytes) } }, new AbortController().signal), (chunk) => sizes.push(chunk.byteLength))
    expect(expected.byteLength).toBe(128 * 1024)
    expect(nativeAgentExportByteLength(plan)).toBe(expected.byteLength)
    expect(result).toEqual(expected)
    expect(sizes[0]).toBe(64 * 1024 - remaining)
  })

  it.each(scalarBoundaries)('withholds the last partial batch through late SHA failure at $name', async ({ remaining, scalar }) => {
    const { plan, bytes } = scalarBoundaryPlan(remaining, scalar)
    const expected = canonicalBytes(plan, [bytes])
    plan.shards[0].sha256 = '0'.repeat(64)
    const delivered: Array<Uint8Array> = []
    await expect(collect(nativeAgentExportStream(plan, { async fetch() { return new Response(bytes) } }, new AbortController().signal), (chunk) => delivered.push(chunk))).rejects.toThrow(/integrity/)
    const prefix = Buffer.concat(delivered)
    expect(prefix.byteLength).toBeGreaterThan(0)
    expect(prefix.byteLength).toBeLessThan(expected.byteLength)
    expect(prefix).toEqual(expected.subarray(0, prefix.byteLength))
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
