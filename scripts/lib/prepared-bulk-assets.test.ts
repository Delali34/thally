/** Build projections retain canonical bytes, physical aliases and locale order. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bulkPhysicalOrder, createPreparedBulkWriter } from './prepared-bulk-assets'
import { isPreparedBulkDescriptor, MAX_BULK_SHARD_BYTES } from '../../src/lib/agent-export/prepared-contract'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

describe('prepared bulk build writer', () => {
  it('groups translations and index aliases in authored navigation order', () => {
    const paths = ['src/content/unused.mdx', 'src/content/fr/b.mdx', 'src/content/a/index.mdx', 'src/content/b.mdx', 'src/content/a.mdx', 'src/content/fr/a.mdx', 'src/content/index.mdx', 'docs.json']
    expect(bulkPhysicalOrder(paths, { i18n: { defaultLocale: 'en', locales: ['en', 'fr'] } }, ['b', 'a'])).toEqual(['src/content/fr/b.mdx', 'src/content/b.mdx', 'src/content/a/index.mdx', 'src/content/a.mdx', 'src/content/fr/a.mdx', 'src/content/unused.mdx', 'src/content/index.mdx'])
  })

  it('preserves a document larger than one shard without truncation or another parser', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'thally-bulk-'))
    try {
      const markdown = '🙂' + 'x'.repeat(MAX_BULK_SHARD_BYTES) + '\n```ts\nconst literal = "{safe}"\n```\n'
      const files = { 'src/content/large.mdx': { sha256: digest('authored bytes') }, 'src/content/empty.mdx': { sha256: digest('') } }
      const writer = createPreparedBulkWriter(root, files)
      writer.add('src/content/large.mdx', markdown)
      writer.add('src/content/empty.mdx', '')
      const descriptor = writer.finish()
      expect(isPreparedBulkDescriptor(descriptor)).toBe(true)
      expect(descriptor.shards).toHaveLength(2)
      const shards = descriptor.shards.map((shard) => {
        const bytes = readFileSync(path.join(root, shard.path))
        expect(bytes.length).toBeLessThanOrEqual(MAX_BULK_SHARD_BYTES)
        expect(bytes.length).toBe(shard.bytes)
        expect(digest(bytes)).toBe(shard.sha256)
        return bytes
      })
      const restored = Buffer.concat(descriptor.records['src/content/large.mdx'].ranges.map((range) => shards[range.shard].subarray(range.start, range.end)))
      expect(restored.equals(Buffer.from(markdown))).toBe(true)
      expect(descriptor.records['src/content/empty.mdx'].ranges).toEqual([])
      expect(JSON.parse(readFileSync(path.join(root, 'bulk/descriptor.json'), 'utf8'))).toEqual(descriptor)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects duplicate physical identities and missing raw SHA authority', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'thally-bulk-'))
    try {
      expect(() => createPreparedBulkWriter(root, { 'src/content/page.mdx': {} })).toThrow(/SHA/)
      const writer = createPreparedBulkWriter(root, { 'src/content/page.mdx': { sha256: digest('raw') } })
      writer.add('src/content/page.mdx', 'canonical')
      expect(() => writer.add('src/content/page.mdx', 'changed')).toThrow(/Duplicate/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
