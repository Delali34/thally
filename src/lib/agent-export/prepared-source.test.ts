/** Protected bulk data never authorizes stale or incomplete physical source bytes. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMdxContent } from '@thallylabs/core/markdown'
import { writeManagedContentAssets } from '../../../scripts/lib/runtime-content-files'
import { createAssetsContentSource, CONTENT_MANIFEST_PATH } from '@/lib/content-source/assets'
import type { ContentSource } from '@/lib/content-source/types'
import { MAX_BULK_DESCRIPTOR_BYTES, PREPARED_BULK_DESCRIPTOR_PATH, type PreparedBulkDescriptor } from './prepared-contract'

const roots: Array<string> = []
const fallback: ContentSource = { kind: 'filesystem', read: async () => null, exists: async () => false, modifiedAt: async () => 0, list: async () => [] }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'thally-bulk-source-'))
  roots.push(root)
  const content = '# Café\n\n<Human>human-only</Human>\n\n<Agent>机器 needle</Agent>\n\n```ts\nconst literal = "{safe}"\n```'
  const manifest = await writeManagedContentAssets(root, { 'src/content/page.mdx': { content, modifiedAtMs: 1 }, 'docs.json': { content: '{}', modifiedAtMs: 1 } })
  const descriptor = JSON.parse(readFileSync(path.join(root, 'public/_thally/content/bulk/descriptor.json'), 'utf8')) as PreparedBulkDescriptor
  const fetcher = vi.fn(async (assetPath: string) => {
    if (assetPath === CONTENT_MANIFEST_PATH) return new Response(JSON.stringify(manifest))
    if (assetPath === PREPARED_BULK_DESCRIPTOR_PATH) return new Response(JSON.stringify(descriptor))
    throw new Error('Descriptor lookup must not read or parse source bodies')
  })
  return { root, content, manifest, descriptor, fetcher, source: createAssetsContentSource(fallback, () => fetcher) }
}

describe('prepared bulk source capability', () => {
  it('reuses the same canonical parsed agent Markdown and coalesces only descriptor reads', async () => {
    const data = await fixture()
    const results = await Promise.all(Array.from({ length: 40 }, () => data.source.bulkExport!()))
    expect(results.every((value) => value === results[0])).toBe(true)
    expect(results[0]).toEqual(data.descriptor)
    const record = data.descriptor.records['src/content/page.mdx']
    const markdown = Buffer.concat(record.ranges.map((range) => readFileSync(path.join(data.root, 'public/_thally/content', data.descriptor.shards[range.shard].path)).subarray(range.start, range.end))).toString()
    expect(markdown).toBe(parseMdxContent(data.content, 'agents').markdown)
    expect(markdown).not.toContain('human-only')
    expect(data.fetcher.mock.calls.map(([url]) => url)).toEqual([CONTENT_MANIFEST_PATH, PREPARED_BULK_DESCRIPTOR_PATH])
  })

  it('stores visible sidebar pages before hidden-group extras and registered version references', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'thally-bulk-order-'))
    roots.push(root)
    const config = { navigation: { versions: [{ label: 'v2', default: true }, { label: 'v1' }] }, tabs: [
      { tab: 'Current', version: 'v2', hidden: true, groups: [{ group: 'Hidden', hidden: true, pages: ['extra'] }, { group: 'Visible', pages: ['current'] }] },
      { tab: 'Old', version: 'v1', hidden: true, pages: ['old'] },
    ], i18n: { defaultLocale: 'en', locales: ['en', 'fr'], navigation: { fr: [{ tab: 'French UI', pages: ['old', 'current'] }] } } }
    await writeManagedContentAssets(root, {
      'docs.json': { content: JSON.stringify(config), modifiedAtMs: 1 },
      'src/content/extra.mdx': { content: 'Extra', modifiedAtMs: 1 },
      'src/content/old.mdx': { content: 'Old', modifiedAtMs: 1 },
      'src/content/current.mdx': { content: 'Current', modifiedAtMs: 1 },
      'src/content/fr/current.mdx': { content: 'Actuel', modifiedAtMs: 1 },
    })
    const descriptor = JSON.parse(readFileSync(path.join(root, 'public/_thally/content/bulk/descriptor.json'), 'utf8')) as PreparedBulkDescriptor
    expect(Object.keys(descriptor.records)).toEqual(['src/content/current.mdx', 'src/content/fr/current.mdx', 'src/content/old.mdx', 'src/content/extra.mdx'])
    // Full GET deliberately uses the DEFAULT sidebar even for French bodies;
    // i18n.navigation reorders browser chrome only, not this existing endpoint.
    expect(descriptor.records['src/content/fr/current.mdx'].ranges[0].start).toBeLessThan(descriptor.records['src/content/old.mdx'].ranges[0].start)
  })

  it.each(['changed-source', 'changed-config', 'removed-source', 'legacy-sha', 'missing-record', 'bad-affinity', 'format'] as const)('rejects %s rather than substituting stale or lower-priority bytes', async (failure) => {
    const data = await fixture()
    if (failure === 'changed-source') data.manifest.files['src/content/page.mdx'].sha256 = 'a'.repeat(64)
    if (failure === 'changed-config') data.manifest.files['docs.json'].sha256 = 'a'.repeat(64)
    if (failure === 'removed-source') delete data.manifest.files['src/content/page.mdx']
    if (failure === 'legacy-sha') Object.assign(data.manifest.files['src/content/page.mdx'], { sha256: undefined })
    if (failure === 'missing-record') delete data.descriptor.records['src/content/page.mdx']
    if (failure === 'bad-affinity') data.descriptor.records['src/content/page.mdx'].sha256 = 'a'.repeat(64)
    if (failure === 'format') Object.assign(data.descriptor, { format: 'unknown-parser' })
    expect(await data.source.bulkExport!()).toBeNull()
  })

  it('retries after a transient exhausted descriptor transfer rather than caching a rejected owner', async () => {
    const data = await fixture()
    let unavailable = true
    const fetcher = vi.fn(async (url: string) => url === PREPARED_BULK_DESCRIPTOR_PATH && unavailable ? new Response('unavailable', { status: 503 }) : data.fetcher(url))
    const source = createAssetsContentSource(fallback, () => fetcher)
    await expect(source.bulkExport!()).rejects.toThrow(/temporarily unavailable/)
    expect(fetcher.mock.calls.filter(([url]) => url === PREPARED_BULK_DESCRIPTOR_PATH)).toHaveLength(3)
    unavailable = false
    expect(await source.bulkExport!()).toEqual(data.descriptor)
    expect(fetcher.mock.calls.filter(([url]) => url === PREPARED_BULK_DESCRIPTOR_PATH)).toHaveLength(4)
  })

  it('bounds an untrusted descriptor body before JSON decoding and cancels it exactly once', async () => {
    const data = await fixture()
    let bytes = 0
    let cancels = 0
    const fetcher = async (url: string) => url === CONTENT_MANIFEST_PATH ? data.fetcher(url) : new Response(new ReadableStream({ pull(controller) { bytes += 65536; controller.enqueue(new Uint8Array(65536)) }, cancel() { cancels += 1 } }, { highWaterMark: 0 }))
    expect(await createAssetsContentSource(fallback, () => fetcher).bulkExport!()).toBeNull()
    expect(bytes).toBe(MAX_BULK_DESCRIPTOR_BYTES + 65536)
    expect(cancels).toBe(1)
  })
})
