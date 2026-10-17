/** Reject malformed protected indexes before any native asset path is opened. */
import { describe, expect, it } from 'vitest'
import { isPreparedBulkDescriptor, MAX_BULK_SHARD_BYTES, PREPARED_BULK_FORMAT, type PreparedBulkDescriptor } from './prepared-contract'
import { bulkSourceRevision } from './source-revision'

const sha = 'a'.repeat(64)
function valid(): PreparedBulkDescriptor {
  return { version: 1, format: PREPARED_BULK_FORMAT, sourceRevision: sha, shards: [{ path: 'bulk/0000.txt', bytes: 12, sha256: sha }], records: { 'src/content/page.mdx': { sha256: sha, ranges: [{ shard: 0, start: 0, end: 12 }] } } }
}

describe('prepared bulk descriptor', () => {
  it('accepts empty bodies and valid split physical records', () => {
    const descriptor = valid()
    descriptor.records['src/content/fr/page.mdx'] = { sha256: sha, ranges: [] }
    expect(isPreparedBulkDescriptor(descriptor)).toBe(true)
    expect(isPreparedBulkDescriptor({ ...descriptor, shards: [], records: {} })).toBe(true)
  })

  it.each(['../page.mdx', 'src/content/../page.mdx', 'src/content//page.mdx', 'src/content/page\\name.mdx', 'src/content/page\0.mdx', 'src/content/page.ts'])('rejects a physical path outside the source contract: %s', (physicalPath) => {
    const descriptor = valid()
    descriptor.records = { [physicalPath]: descriptor.records['src/content/page.mdx'] }
    expect(isPreparedBulkDescriptor(descriptor)).toBe(false)
  })

  it('rejects ordinal escapes, unsupported versions, oversized and invalid hashes', () => {
    for (const mutation of [
      (d: PreparedBulkDescriptor) => { d.shards[0].path = '../secret' },
      (d: PreparedBulkDescriptor) => { d.shards[0].bytes = MAX_BULK_SHARD_BYTES + 1 },
      (d: PreparedBulkDescriptor) => { d.shards[0].sha256 = 'A'.repeat(64) },
      (d: PreparedBulkDescriptor) => { d.sourceRevision = 'unknown' },
    ]) { const descriptor = valid(); mutation(descriptor); expect(isPreparedBulkDescriptor(descriptor)).toBe(false) }
    expect(isPreparedBulkDescriptor({ ...valid(), version: 2 })).toBe(false)
  })

  it('rejects ranges outside their declared shard or out of order', () => {
    for (const ranges of [[{ shard: 0, start: 0, end: 13 }], [{ shard: 1, start: 0, end: 1 }], [{ shard: 0, start: 2, end: 2 }], [{ shard: 0, start: 0, end: 8 }, { shard: 0, start: 7, end: 12 }]]) {
      const descriptor = valid()
      descriptor.records['src/content/page.mdx'].ranges = ranges
      expect(isPreparedBulkDescriptor(descriptor)).toBe(false)
    }
  })

  it('binds every current source SHA independently of JSON ordering, timestamps and derived affinities', () => {
    const first = { 'src/content/b.mdx': { sha256: 'b'.repeat(64), modifiedAtMs: 1, searchShard: 'search/0000.json' }, 'docs.json': { sha256: sha } }
    const second = { 'docs.json': { sha256: sha }, 'src/content/b.mdx': { sha256: 'b'.repeat(64), modifiedAtMs: 2 } }
    expect(bulkSourceRevision(first)).toBe(bulkSourceRevision(second))
    expect(bulkSourceRevision({ ...second, 'docs.json': { sha256: 'c'.repeat(64) } })).not.toBe(bulkSourceRevision(first))
    expect(bulkSourceRevision({ 'src/content/b.mdx': {} })).toBeNull()
  })
})
