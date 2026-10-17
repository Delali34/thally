/**
 * Versioned, content-only search assets shared by the public build and reader.
 * These assets never authorize a page: current manifest membership/raw SHA and
 * the ordinary request-time page listing remain authoritative.
 */
import type { SearchContentProjection } from '@thallylabs/core/search'

/** Increment when canonical parsing or search projection semantics change. */
export const PREPARED_SEARCH_FORMAT = 'thally-search-content-v1'
export const MAX_SEARCH_SHARD_BYTES = 1024 * 1024
export const MAX_SEARCH_SHARDS = 256

export interface PreparedSearchShardDescriptor {
  path: string
  sha256: string
  bytes: number
}

export interface PreparedSearchDescriptor {
  version: 1
  shards: Array<PreparedSearchShardDescriptor>
}

export interface PreparedSearchRecord {
  sha256: string
  content: SearchContentProjection
}

export interface PreparedSearchShard {
  version: 1
  format: typeof PREPARED_SEARCH_FORMAT
  records: Record<string, PreparedSearchRecord>
}

/** SHA strings have one spelling so content-only publishers can compare bytes. */
export function isRawSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Reject unbounded/foreign descriptors before making any asset request. */
export function isPreparedSearchDescriptor(value: unknown): value is PreparedSearchDescriptor {
  if (!value || typeof value !== 'object') return false
  const descriptor = value as PreparedSearchDescriptor
  return descriptor.version === 1 && Array.isArray(descriptor.shards)
    && descriptor.shards.length > 0 && descriptor.shards.length <= MAX_SEARCH_SHARDS
    && descriptor.shards.every((shard, index) => shard && shard.path === `search/${String(index).padStart(4, '0')}.json`
      && isRawSha256(shard.sha256) && Number.isSafeInteger(shard.bytes)
      && shard.bytes > 0 && shard.bytes <= MAX_SEARCH_SHARD_BYTES)
}

function isProjection(value: unknown): value is SearchContentProjection {
  if (!value || typeof value !== 'object') return false
  const content = value as SearchContentProjection
  return typeof content.headings === 'string' && typeof content.body === 'string' && content.body.length <= 4000
    && Array.isArray(content.sections) && content.sections.length <= MAX_SEARCH_SHARD_BYTES
    && content.sections.every((section) => section && typeof section.id === 'string'
      && typeof section.title === 'string' && typeof section.text === 'string' && section.text.length <= 2000)
}

/** Decode only after the transport has enforced byte bounds and verified SHA. */
export function decodePreparedSearchShard(body: string): PreparedSearchShard | null {
  let value: PreparedSearchShard
  try { value = JSON.parse(body) as PreparedSearchShard } catch { return null }
  if (!value || value.version !== 1 || value.format !== PREPARED_SEARCH_FORMAT
    || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) return null
  const records = Object.entries(value.records)
  if (records.length > MAX_SEARCH_SHARD_BYTES) return null
  return records.every(([filePath, record]) => filePath.startsWith('src/content/') && filePath.endsWith('.mdx')
    && filePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
    && record && isRawSha256(record.sha256) && isProjection(record.content)) ? value : null
}
