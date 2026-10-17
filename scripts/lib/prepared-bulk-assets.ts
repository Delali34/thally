/**
 * Build-only writer for protected canonical Markdown fragments.
 *
 * Search and bulk export receive the same parsed graph in one traversal.
 * Fragments carry no reader decisions or generated URLs; request-time code
 * chooses authorized physical ranges and supplies all page/API framing.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_I18N_CONFIG, normalizeI18nConfig, SUPPORTED_LOCALE_OPTIONS } from '../../src/lib/i18n/config'
import { bulkSourceRevision } from '../../src/lib/agent-export/source-revision'
import {
  MAX_BULK_DESCRIPTOR_BYTES, MAX_BULK_RECORDS, MAX_BULK_SHARD_BYTES, MAX_BULK_SHARDS,
  PREPARED_BULK_FORMAT, type PreparedBulkDescriptor, type PreparedBulkRecord,
} from '../../src/lib/agent-export/prepared-contract'

/**
 * Group translations/physical aliases beside each logical page. Full exports
 * use the DEFAULT sidebar order even for translated bodies; the caller passes
 * that visible-first order, then authored references and inventory extras.
 * A changed request-time navigation binding must be revalidated by the plan.
 */
export function bulkPhysicalOrder(paths: ReadonlyArray<string>, rawConfig: unknown, orderedPageIds: ReadonlyArray<string>): Array<string> {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig as Record<string, unknown> : {}
  const i18n = normalizeI18nConfig(config.i18n, DEFAULT_I18N_CONFIG)
  const locales = new Set([...SUPPORTED_LOCALE_OPTIONS.map((item) => item.code.toLowerCase()), ...i18n.locales.map((item) => item.code.toLowerCase())])
  const byId = new Map<string, Array<string>>()
  const primaryIds: Array<string> = []
  const secondaryIds: Array<string> = []
  for (const physicalPath of paths) {
    if (!physicalPath.startsWith('src/content/') || !physicalPath.endsWith('.mdx')) continue
    const parts = physicalPath.slice('src/content/'.length, -4).split('/')
    const isSecondary = parts.length > 1 && locales.has(parts[0].toLowerCase())
    if (isSecondary) parts.shift()
    if (parts.length > 1 && parts.at(-1) === 'index') parts.pop()
    const id = parts.join('/')
    if (!id) continue
    const group = byId.get(id) ?? []
    group.push(physicalPath)
    byId.set(id, group)
    ;(isSecondary ? secondaryIds : primaryIds).push(id)
  }
  const ids = new Set([
    ...orderedPageIds,
    ...primaryIds,
    ...secondaryIds,
  ])
  return [...ids].flatMap((id) => byId.get(id) ?? [])
}

/** A functional writer with at most one bounded shard and one document live. */
export function createPreparedBulkWriter(
  outputRoot: string,
  files: Readonly<Record<string, { sha256?: string }>>,
): { add: (physicalPath: string, markdown: string) => void; finish: () => PreparedBulkDescriptor } {
  const sourceRevision = bulkSourceRevision(files)
  if (!sourceRevision) throw new Error('Prepared bulk export requires source SHA identities.')
  const descriptor: PreparedBulkDescriptor = { version: 1, format: PREPARED_BULK_FORMAT, sourceRevision, shards: [], records: {} }
  let shard: Buffer | null = null
  let size = 0
  let recordCount = 0
  const flush = (): void => {
    if (!size) return
    if (descriptor.shards.length >= MAX_BULK_SHARDS) throw new Error('Prepared bulk export exceeds its shard bound.')
    const relativePath = `bulk/${String(descriptor.shards.length).padStart(4, '0')}.txt`
    const bytes = shard!.subarray(0, size)
    mkdirSync(path.join(outputRoot, 'bulk'), { recursive: true })
    writeFileSync(path.join(outputRoot, relativePath), bytes)
    descriptor.shards.push({ path: relativePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    shard = null
    size = 0
  }
  const add = (physicalPath: string, markdown: string): void => {
    if (Object.hasOwn(descriptor.records, physicalPath)) throw new Error('Duplicate prepared bulk physical source.')
    // The count is independent of body bytes: a million empty files is still
    // an unbounded index even though it contributes no Markdown payload.
    if (recordCount >= MAX_BULK_RECORDS) throw new Error('Prepared bulk export exceeds its record bound.')
    const record: PreparedBulkRecord = { sha256: files[physicalPath].sha256!, ranges: [] }
    const bytes = Buffer.from(markdown, 'utf8')
    let position = 0
    while (position < bytes.length) {
      if (size === MAX_BULK_SHARD_BYTES) flush()
      if (descriptor.shards.length >= MAX_BULK_SHARDS) throw new Error('Prepared bulk export exceeds its shard bound.')
      const length = Math.min(bytes.length - position, MAX_BULK_SHARD_BYTES - size)
      record.ranges.push({ shard: descriptor.shards.length, start: size, end: size + length })
      // Copy into one bounded shard. Retaining a subarray here could keep an
      // entire previous huge document alive while the next document is parsed.
      shard ??= Buffer.allocUnsafe(MAX_BULK_SHARD_BYTES)
      shard.set(bytes.subarray(position, position + length), size)
      size += length
      position += length
    }
    descriptor.records[physicalPath] = record
    recordCount += 1
  }
  const finish = (): PreparedBulkDescriptor => {
    flush()
    const bytes = Buffer.from(JSON.stringify(descriptor) + '\n')
    if (bytes.length > MAX_BULK_DESCRIPTOR_BYTES) throw new Error('Prepared bulk export index exceeds its byte bound.')
    mkdirSync(path.join(outputRoot, 'bulk'), { recursive: true })
    writeFileSync(path.join(outputRoot, 'bulk', 'descriptor.json'), bytes)
    return descriptor
  }
  return { add, finish }
}
