/** Prepared assets are byte-bound, integrity-checked optimizations, never publication authority. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMdxContent } from '@thallylabs/core/markdown'
import { buildSearchCorpusAsync, getSearchEngine, projectSearchContent, registerAsyncSearchContentSource, resetSearchEngine, searchDocs } from '@thallylabs/core/search'
import { registerAsyncContentDocumentSource, registerAsyncDocEntriesSource } from '@thallylabs/core/registry'
import { writeManagedContentAssets, type RuntimeSourceMap } from '../../../scripts/lib/runtime-content-files'
import { createAssetsContentSource, CONTENT_MANIFEST_PATH, type ContentManifest } from '@/lib/content-source/assets'
import type { ContentSource } from '@/lib/content-source/types'
import { MAX_SEARCH_SHARD_BYTES, PREPARED_SEARCH_FORMAT } from '@/lib/search/prepared-content-contract'

const roots: Array<string> = []
const sha = (body: string) => createHash('sha256').update(body).digest('hex')
const fallback: ContentSource = { kind: 'filesystem', read: async () => null, exists: async () => false, modifiedAt: async () => 0, list: async () => [] }
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  resetSearchEngine()
  registerAsyncSearchContentSource(async () => undefined)
  vi.restoreAllMocks()
})

async function fixture(sources: RuntimeSourceMap) {
  const root = mkdtempSync(path.join(tmpdir(), 'thally-prepared-search-'))
  roots.push(root)
  const manifest: ContentManifest = await writeManagedContentAssets(root, sources)
  const bodies = new Map<string, string>()
  for (const shard of manifest.search?.shards ?? []) bodies.set(shard.path, readFileSync(path.join(root, 'public/_thally/content', shard.path), 'utf8'))
  const fetcher = vi.fn(async (assetPath: string) => {
    if (assetPath === CONTENT_MANIFEST_PATH) return new Response(JSON.stringify(manifest))
    const body = bodies.get(assetPath.slice('/_thally/content/'.length))
    return new Response(body ?? '', { status: body === undefined ? 404 : 200 })
  })
  return { root, manifest, bodies, fetcher, source: createAssetsContentSource(fallback, () => fetcher) }
}

describe('prepared search assets', () => {
  it('uses the canonical agent projection, raw source SHA and deterministic bounded shards', async () => {
    const raw = '---\ntitle: Ignored listing metadata\n---\n# Café\n\n<Human>human-only</Human>\n\n<Agent>机器 needle</Agent>\n\n## Detail\n\nText.'
    const data = await fixture({ 'src/content/a.mdx': { content: raw, modifiedAtMs: 5 } })
    const projection = await data.source.searchContent!('src/content/a.mdx')
    expect(projection).toEqual(projectSearchContent(parseMdxContent(raw.slice(raw.indexOf('# Café')), 'agents')))
    expect(projection?.body).not.toContain('human-only')
    expect(data.manifest.files['src/content/a.mdx']).toEqual({ modifiedAtMs: 5, sha256: sha(raw), searchShard: 0 })
    const body = data.bodies.get('search/0000.json')!
    expect(data.manifest.search).toEqual({ version: 1, shards: [{ path: 'search/0000.json', sha256: sha(body), bytes: Buffer.byteLength(body) }] })
    const again = await writeManagedContentAssets(data.root, { 'src/content/a.mdx': { content: raw, modifiedAtMs: 5 } })
    expect(again).toEqual(data.manifest)
  })

  it('ignores removed, changed, legacy and unprepared source entries without authorizing stale text', async () => {
    const data = await fixture({ 'src/content/a.mdx': { content: 'old', modifiedAtMs: 1 } })
    const original = { ...data.manifest.files['src/content/a.mdx'] }
    delete data.manifest.files['src/content/a.mdx']
    expect(await data.source.searchContent!('src/content/a.mdx')).toBeUndefined()
    // A fresh source owns a fresh immutable release manifest.
    data.manifest.files['src/content/a.mdx'] = { ...original, sha256: sha('new') }
    expect(await createAssetsContentSource(fallback, () => data.fetcher).searchContent!('src/content/a.mdx')).toBeUndefined()
    delete data.manifest.files['src/content/a.mdx'].sha256
    expect(await createAssetsContentSource(fallback, () => data.fetcher).searchContent!('src/content/a.mdx')).toBeUndefined()
    data.manifest.files['src/content/a.mdx'] = { modifiedAtMs: 2, sha256: sha('new') }
    expect(await createAssetsContentSource(fallback, () => data.fetcher).searchContent!('src/content/a.mdx')).toBeUndefined()
    expect(await data.source.searchContent!('../secret.mdx')).toBeUndefined()
  })

  it.each(['hash', 'version', 'schema', 'path', 'oversize'] as const)('falls back for invalid %s without admitting derived content', async (failure) => {
    const data = await fixture({ 'src/content/a.mdx': { content: 'needle', modifiedAtMs: 1 } })
    const descriptor = data.manifest.search!.shards[0]
    let body = data.bodies.get(descriptor.path)!
    if (failure === 'hash') descriptor.sha256 = '0'.repeat(64)
    if (failure === 'version') body = body.replace(PREPARED_SEARCH_FORMAT, 'unknown-parser-version')
    if (failure === 'schema') {
      const parsed = JSON.parse(body)
      parsed.records['src/content/a.mdx'].content.sections = 'not-an-array'
      body = JSON.stringify(parsed)
    }
    if (failure === 'path') descriptor.path = '../secret.json'
    if (failure === 'oversize') body = ' '.repeat(MAX_SEARCH_SHARD_BYTES + 1)
    if (failure !== 'hash' && failure !== 'path') { descriptor.sha256 = sha(body); descriptor.bytes = failure === 'oversize' ? MAX_SEARCH_SHARD_BYTES : Buffer.byteLength(body) }
    data.bodies.set('search/0000.json', body)
    expect(await data.source.searchContent!('src/content/a.mdx')).toBeUndefined()
  })

  it('coalesces shared shards and recovers after an exhausted transient failure', async () => {
    const data = await fixture({ 'src/content/a.mdx': { content: 'needle', modifiedAtMs: 1 }, 'src/content/b.mdx': { content: 'other', modifiedAtMs: 1 } })
    let unavailable = true
    const fetcher = vi.fn(async (assetPath: string) => assetPath.includes('/search/') && unavailable ? new Response('unavailable', { status: 503 }) : data.fetcher(assetPath))
    const source = createAssetsContentSource(fallback, () => fetcher)
    await expect(Promise.all(['a', 'b'].map((id) => source.searchContent!(`src/content/${id}.mdx`)))).rejects.toThrow('temporarily unavailable')
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/search/'))).toHaveLength(3)
    unavailable = false
    const records = await Promise.all(Array.from({ length: 40 }, (_, i) => source.searchContent!(`src/content/${i % 2 ? 'a' : 'b'}.mdx`)))
    expect(records.every(Boolean)).toBe(true)
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/search/'))).toHaveLength(4)
  })

  it('cancels over-limit streaming bodies before JSON parsing', async () => {
    const data = await fixture({ 'src/content/a.mdx': { content: 'needle', modifiedAtMs: 1 } })
    let cancelled = false
    const fetcher = async (url: string) => url === CONTENT_MANIFEST_PATH ? data.fetcher(url) : new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(65536)) }, cancel() { cancelled = true },
    }))
    expect(await createAssetsContentSource(fallback, () => fetcher).searchContent!('src/content/a.mdx')).toBeUndefined()
    expect(cancelled).toBe(true)
  })

  it('shares the same four body-consumption slots with raw content', async () => {
    const sources = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/content/${i}.mdx`, { content: `needle${i}`, modifiedAtMs: 1 }]))
    const data = await fixture(sources)
    // Give each entry its own valid descriptor to exercise concurrent transfers.
    const original = data.manifest.search!.shards[0]
    data.manifest.search!.shards = Array.from({ length: 6 }, (_, i) => ({ ...original, path: `search/${String(i).padStart(4, '0')}.json` }))
    for (const [i, entry] of Object.values(data.manifest.files).entries()) entry.searchShard = i % 6
    let active = 0, peak = 0
    const fetcher = async (url: string) => {
      if (url === CONTENT_MANIFEST_PATH) return new Response(JSON.stringify(data.manifest))
      active += 1; peak = Math.max(peak, active)
      const body = url.includes('/search/') ? data.bodies.get('search/0000.json')! : 'raw'
      return new Response(new ReadableStream({ async start(controller) { await new Promise((resolve) => setTimeout(resolve, 2)); controller.enqueue(new TextEncoder().encode(body)); active -= 1; controller.close() } }))
    }
    const source = createAssetsContentSource(fallback, () => fetcher)
    await Promise.all(Object.keys(sources).flatMap((file) => [source.read(file), source.searchContent!(file)]))
    expect(peak).toBe(4)
  })

  it('partitions large text without changing canonical content and leaves oversized records unprepared', async () => {
    const text = Array.from({ length: 110 }, (_, i) => `## Section ${i}\n\n${'word '.repeat(400)}`).join('\n\n')
    const sources = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/content/${i}.mdx`, { content: text, modifiedAtMs: 1 }]))
    const data = await fixture(sources)
    expect(data.manifest.search!.shards.length).toBeGreaterThan(1)
    expect(data.manifest.search!.shards.every((shard) => shard.bytes <= MAX_SEARCH_SHARD_BYTES)).toBe(true)
    for (const file of Object.keys(sources)) expect(await data.source.searchContent!(file)).toEqual(projectSearchContent(parseMdxContent(text, 'agents')))
    const oversized = await fixture({ 'src/content/huge.mdx': { content: text.repeat(6), modifiedAtMs: 1 } })
    expect(oversized.manifest.search).toBeUndefined()
    expect(oversized.manifest.files['src/content/huge.mdx'].searchShard).toBeUndefined()
  }, 30_000) // This exercises several MiB of real canonical parsing, not a mocked shard boundary.

  it('bounds settled shard ownership while coalescing every in-flight shard', async () => {
    const sources = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`src/content/${i}.mdx`, { content: `needle${i}`, modifiedAtMs: 1 }]))
    const data = await fixture(sources)
    const descriptor = data.manifest.search!.shards[0]
    data.manifest.search!.shards = Array.from({ length: 130 }, (_, i) => ({ ...descriptor, path: `search/${String(i).padStart(4, '0')}.json` }))
    for (const [i, entry] of Object.values(data.manifest.files).entries()) entry.searchShard = i
    const fetcher = vi.fn(async (url: string) => url === CONTENT_MANIFEST_PATH ? new Response(JSON.stringify(data.manifest)) : new Response(data.bodies.get('search/0000.json')))
    const source = createAssetsContentSource(fallback, () => fetcher)
    await Promise.all(Object.keys(sources).flatMap((file) => [source.searchContent!(file), source.searchContent!(file)]))
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/search/'))).toHaveLength(130)
    // Native digests can settle out of order. Establish known LRU order
    // before checking the 128-entry bound instead of assuming shard 0 won
    // the concurrent hash race above.
    await source.searchContent!('src/content/0.mdx')
    for (const file of Object.keys(sources).slice(1)) await source.searchContent!(file)
    const beforeRefetch = fetcher.mock.calls.filter(([url]) => url.includes('/search/')).length
    await source.searchContent!('src/content/0.mdx')
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/search/'))).toHaveLength(beforeRefetch + 1)
  })

  it('builds the exact ordinary 10000-page corpus and keyword results with bounded prepared reads', async () => {
    const entries = Array.from({ length: 10_000 }, (_, i) => ({ id: `page-${i}`, href: `/page-${i}`, title: `Page ${i}`, description: '', keywords: [] }))
    const body = (id: string) => `# ${id}\n\n<Human>must-not-be-searchable</Human>\n\n<Agent>Visible text ${id === 'page-9999' ? 'uniquecapacityneedle' : 'ordinary'}.</Agent>\n\n## Café 中文\n\nExact section.`
    registerAsyncDocEntriesSource(async () => entries)
    registerAsyncContentDocumentSource(async (id) => ({ pageId: id, frontmatter: {}, rawBody: body(id), content: parseMdxContent(body(id), 'agents') }))
    const ordinary = await buildSearchCorpusAsync()
    resetSearchEngine()
    const data = await fixture(Object.fromEntries(entries.map((entry) => [`src/content/${entry.id}.mdx`, { content: body(entry.id), modifiedAtMs: 1 }])))
    registerAsyncSearchContentSource((id) => data.source.searchContent!(`src/content/${id}.mdx`))
    const prepared = await buildSearchCorpusAsync()
    expect(sha(JSON.stringify(prepared))).toBe(sha(JSON.stringify(ordinary)))
    expect(prepared.every((record) => !record.body.includes('must-not-be-searchable'))).toBe(true)
    expect((await searchDocs('uniquecapacityneedle', { mode: 'fulltext' }))[0]?.pageId).toBe('page-9999')
    const engine = await getSearchEngine(undefined, false)
    expect(Object.keys(engine.db.data.index.vectorIndexes)).toEqual([])
    expect(data.fetcher).toHaveBeenCalledTimes(1 + data.manifest.search!.shards.length)
    expect(data.manifest.search!.shards.length).toBeLessThan(10)
  }, 60_000) // Real 10k file writes, two canonical parses per page and an actual full-text index.
})
