/**
 * In-process, request-owned handoff from Next authorization to native delivery.
 *
 * No HTTP header, cookie, route or serialized environment value can create a
 * capability. The Worker creates a fresh Symbol-valued object for one fetch;
 * its one-shot callback accepts only bounded plain data and closes before any
 * export body is read. This module has no Next or adapter dependencies.
 */
import type { PreparedBulkRange, PreparedBulkShard } from './prepared-contract'
import { isBulkSha256, MAX_BULK_RECORDS, MAX_BULK_SHARD_BYTES, MAX_BULK_SHARDS } from './prepared-contract'

export const NATIVE_AGENT_EXPORT_HANDOFF_HEADER = 'X-Thally-Native-Export'
export const NATIVE_AGENT_EXPORT_HANDOFF_VALUE = 'v1'

export const NATIVE_AGENT_EXPORT_SYMBOL = Symbol.for('@thallylabs/native-agent-export/v1')
export const MAX_NATIVE_PLAN_PAYLOAD_BYTES = 8 * 1024 * 1024

export interface NativeAgentExportPage {
  title: string
  description: string
  href: string
  ranges: Array<PreparedBulkRange>
}

export interface NativeAgentExportPlan {
  version: 1
  origin: string
  locale: string
  siteName: string
  siteDescription: string
  shards: Array<PreparedBulkShard>
  pages: Array<NativeAgentExportPage>
  /** Already-authorized canonical operation Markdown, without credentials. */
  apiMarkdown: Array<string>
}

export interface NativeAgentExportCapability {
  version: 1
  requestUrl: string
  accept: (plan: NativeAgentExportPlan) => boolean
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function keysAre(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** Reject unexpected objects/functions and unbounded data at the native seam. */
export function isNativeAgentExportPlan(value: unknown): value is NativeAgentExportPlan {
  if (!plain(value) || !keysAre(value, ['version', 'origin', 'locale', 'siteName', 'siteDescription', 'shards', 'pages', 'apiMarkdown']) || value.version !== 1) return false
  let size = 0
  const string = (item: unknown): item is string => {
    if (typeof item !== 'string') return false
    // Three bytes per UTF-16 unit bounds UTF-8 without allocating encodings.
    // This is a transfer/retention budget, not a total-heap guarantee.
    size += item.length * 3 + 32
    return size <= MAX_NATIVE_PLAN_PAYLOAD_BYTES
  }
  if (!string(value.origin) || !string(value.locale) || !string(value.siteName) || !string(value.siteDescription)) return false
  try { if (new URL(value.origin).origin !== value.origin || !['http:', 'https:'].includes(new URL(value.origin).protocol)) return false } catch { return false }
  if (!Array.isArray(value.shards) || value.shards.length > MAX_BULK_SHARDS || !Array.isArray(value.pages) || value.pages.length > MAX_BULK_RECORDS || !Array.isArray(value.apiMarkdown) || value.apiMarkdown.length > MAX_BULK_RECORDS) return false
  const shards: Array<PreparedBulkShard> = []
  for (const [index, shard] of value.shards.entries()) {
    if (!plain(shard) || !keysAre(shard, ['path', 'bytes', 'sha256']) || shard.path !== `bulk/${String(index).padStart(4, '0')}.txt` || !isBulkSha256(shard.sha256) || !Number.isSafeInteger(shard.bytes) || (shard.bytes as number) <= 0 || (shard.bytes as number) > MAX_BULK_SHARD_BYTES) return false
    shards.push({ path: shard.path, bytes: shard.bytes as number, sha256: shard.sha256 })
    size += 160
  }
  let previousShard = -1
  let previousEnd = -1
  for (const page of value.pages) {
    if (!plain(page) || !keysAre(page, ['title', 'description', 'href', 'ranges']) || !string(page.title) || !string(page.description) || !string(page.href) || !Array.isArray(page.ranges) || page.ranges.length > MAX_BULK_SHARDS) return false
    size += 96
    for (const range of page.ranges) {
      if (!plain(range) || !keysAre(range, ['shard', 'start', 'end']) || !Number.isSafeInteger(range.shard) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return false
      const shard = range.shard as number
      const start = range.start as number
      const end = range.end as number
      if (shard < 0 || shard >= shards.length || start < 0 || end <= start || end > shards[shard].bytes || shard < previousShard || (shard === previousShard && start < previousEnd)) return false
      previousShard = shard
      previousEnd = end
      size += 64
    }
    if (size > MAX_NATIVE_PLAN_PAYLOAD_BYTES) return false
  }
  for (const markdown of value.apiMarkdown) if (!string(markdown)) return false
  return size <= MAX_NATIVE_PLAN_PAYLOAD_BYTES
}

/** Fresh acceptance closure; old, duplicate and aborted handoffs cannot win. */
export function createNativeAgentExportCapability(request: Request): {
  capability: NativeAgentExportCapability
  finish: () => NativeAgentExportPlan | null
} {
  let isOpen = true
  let accepted: NativeAgentExportPlan | null = null
  const capability: NativeAgentExportCapability = {
    version: 1,
    requestUrl: request.url,
    accept(plan) {
      if (!isOpen || accepted || request.signal.aborted || !isNativeAgentExportPlan(plan) || plan.origin !== new URL(request.url).origin) return false
      accepted = plan
      return true
    },
  }
  return {
    capability,
    finish() {
      isOpen = false
      const plan = request.signal.aborted ? null : accepted
      accepted = null
      return plan
    },
  }
}

/**
 * Next may normalize the origin internally; pathname/query must still match
 * the original native request. Only that unforgeable capability supplies its
 * original origin. Client headers are never part of this protocol.
 */
export function nativeAgentExportCapability(
  request: Request,
  environment: Record<PropertyKey, unknown> | undefined,
): NativeAgentExportCapability | null {
  const candidate = environment?.[NATIVE_AGENT_EXPORT_SYMBOL]
  if (!plain(candidate) || candidate.version !== 1 || typeof candidate.requestUrl !== 'string' || typeof candidate.accept !== 'function' || request.method !== 'GET') return null
  try {
    const original = new URL(candidate.requestUrl)
    const current = new URL(request.url)
    if (original.pathname !== '/llms-full.txt' || current.pathname !== original.pathname || current.search !== original.search) return null
  } catch { return null }
  return {
    version: 1,
    requestUrl: candidate.requestUrl,
    accept: candidate.accept as NativeAgentExportCapability['accept'],
  }
}
