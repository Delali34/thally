/**
 * Protected, build-derived Markdown fragments for native full exports.
 *
 * This index carries physical bytes and their source affinity only. It never
 * grants access, lists a reader's pages, or supplies titles/routing metadata.
 * The request's ordinary document listing remains the authorization authority.
 */

export const PREPARED_BULK_FORMAT = 'thally-agent-bulk-v1'
export const PREPARED_BULK_DESCRIPTOR_PATH = '/_thally/content/bulk/descriptor.json'
export const MAX_BULK_SHARD_BYTES = 16 * 1024 * 1024
export const MAX_BULK_SHARDS = 256
export const MAX_BULK_DESCRIPTOR_BYTES = 8 * 1024 * 1024
export const MAX_BULK_RECORDS = 100_000

export interface PreparedBulkRange {
  shard: number
  start: number
  end: number
}

export interface PreparedBulkRecord {
  sha256: string
  ranges: Array<PreparedBulkRange>
}

export interface PreparedBulkShard {
  path: string
  bytes: number
  sha256: string
}

export interface PreparedBulkDescriptor {
  version: 1
  format: typeof PREPARED_BULK_FORMAT
  /** Identity of every authored source SHA, excluding derived descriptors. */
  sourceRevision: string
  shards: Array<PreparedBulkShard>
  records: Record<string, PreparedBulkRecord>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** A source or generated asset identity, never a URL or authority token. */
export function isBulkSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Reject paths before they can address the internal asset binding. */
export function isBulkContentPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 &&
    value.startsWith('src/content/') && value.endsWith('.mdx') &&
    !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** Validate a bounded decoded index, including every byte-range boundary. */
export function isPreparedBulkDescriptor(value: unknown): value is PreparedBulkDescriptor {
  if (!isObject(value) || value.version !== 1 || value.format !== PREPARED_BULK_FORMAT ||
      !isBulkSha256(value.sourceRevision) || !Array.isArray(value.shards) ||
      value.shards.length > MAX_BULK_SHARDS || !isObject(value.records)) return false
  const shards: Array<PreparedBulkShard> = []
  for (const [index, item] of value.shards.entries()) {
    if (!isObject(item) || item.path !== `bulk/${String(index).padStart(4, '0')}.txt` ||
        !Number.isSafeInteger(item.bytes) || (item.bytes as number) <= 0 ||
        (item.bytes as number) > MAX_BULK_SHARD_BYTES || !isBulkSha256(item.sha256)) return false
    shards.push({ path: item.path, bytes: item.bytes as number, sha256: item.sha256 })
  }
  const records = Object.entries(value.records)
  if (records.length > MAX_BULK_RECORDS) return false
  for (const [physicalPath, record] of records) {
    if (!isBulkContentPath(physicalPath) || !isObject(record) || !isBulkSha256(record.sha256) ||
        !Array.isArray(record.ranges) || record.ranges.length > MAX_BULK_SHARDS) return false
    let previousShard = -1
    let previousEnd = -1
    for (const range of record.ranges) {
      if (!isObject(range) || !Number.isSafeInteger(range.shard) || !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end)) return false
      const shard = range.shard as number
      const start = range.start as number
      const end = range.end as number
      if (shard < 0 || shard >= shards.length || start < 0 || end <= start || end > shards[shard].bytes ||
          shard < previousShard || (shard === previousShard && start < previousEnd)) return false
      previousShard = shard
      previousEnd = end
    }
  }
  return true
}
