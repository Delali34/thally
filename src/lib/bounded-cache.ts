/**
 * Process-local LRU caches with explicit entry and retained-payload budgets.
 * These bounds limit cache ownership, not total V8 heap or concurrent requests.
 * Eviction never mutates values or cancels a caller's work; immutable content
 * can always be loaded again from its authoritative release source.
 */

import { isPromise } from 'node:util/types'

interface BoundedCacheOptions {
  maxEntries: number
  maxBytes: number
}

interface CacheEntry<Value> {
  value: Value
  bytes: number
}

/** Estimate reachable payload without evaluating getters or following function closures. */
export function estimateRetainedPayloadBytes(value: unknown, limit = 8 * 1024 * 1024): number {
  const seen = new WeakSet<object>()
  const pending: Array<unknown> = [value]
  let bytes = 0
  let visited = 0
  while (pending.length && bytes <= limit && visited++ < 100_000) {
    const current = pending.pop()
    if (typeof current === 'string') { bytes += current.length * 2; continue }
    if (current === null || current === undefined) continue
    if (typeof current !== 'object') { bytes += typeof current === 'function' ? 128 : 16; continue }
    if (seen.has(current)) continue
    seen.add(current)
    // Promise settlement retains an opaque payload which own properties cannot
    // measure. In development React owner graphs also reach Next's instrumented
    // request promises: enumerating them performs forbidden synchronous access.
    // Reject cache admission without reading `.then`, awaiting request data, or
    // pretending the eventual payload fits a fixed bookkeeping allowance.
    // isPromise covers other realms; instanceof also covers Next's Proxy wrapper.
    if (isPromise(current) || current instanceof Promise) return limit + 1
    bytes += 128
    if (ArrayBuffer.isView(current)) { bytes += current.byteLength; continue }
    if (current instanceof ArrayBuffer) { bytes += current.byteLength; continue }
    for (const key of Object.keys(current)) {
      bytes += key.length * 2 + 16
      if (bytes > limit) return limit + 1
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor && 'value' in descriptor) pending.push(descriptor.value)
    }
  }
  return pending.length || bytes > limit ? limit + 1 : bytes
}

/** Build an independent LRU. Weights include a small per-key bookkeeping allowance. */
export function createBoundedCache<Value>({ maxEntries, maxBytes }: BoundedCacheOptions) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Cache budgets must be positive safe integers.')
  const entries = new Map<string, CacheEntry<Value>>()
  let bytes = 0
  const remove = (key: string): void => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    bytes -= entry.bytes
  }
  return {
    get(key: string): Value | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    peek(key: string): Value | undefined { return entries.get(key)?.value },
    set(key: string, value: Value, payloadBytes: number): boolean {
      remove(key)
      const weight = Math.ceil(payloadBytes) + key.length * 2 + 64
      if (!Number.isFinite(payloadBytes) || payloadBytes < 0 || !Number.isFinite(weight) || weight > maxBytes) return false
      while (entries.size >= maxEntries || bytes + weight > maxBytes) remove(entries.keys().next().value!)
      entries.set(key, { value, bytes: weight })
      bytes += weight
      return true
    },
    delete: remove,
    clear(): void { entries.clear(); bytes = 0 },
    snapshot(): { entries: number; bytes: number } { return { entries: entries.size, bytes } },
  }
}

/** Coalesce bounded in-flight work; only successful admissible values remain cached. */
export function createBoundedPromiseCache<Value>(options: BoundedCacheOptions & {
  sizeOf(value: Value): number
  shouldCache?(value: Value): boolean
}) {
  interface PendingEntry { promise: Promise<Value> }
  const cache = createBoundedCache<PendingEntry>(options)
  return {
    getOrLoad(key: string, load: () => Promise<Value>): Promise<Value> {
      const found = cache.get(key)
      if (found) return found.promise
      const entry = {} as PendingEntry
      entry.promise = Promise.resolve().then(load).then((value) => {
        // An evicted pending request must not replace a newer request for the
        // same key when it eventually completes or fails.
        if (cache.peek(key) === entry) {
          try {
            if ((options.shouldCache?.(value) ?? (value !== null && value !== undefined))) cache.set(key, entry, options.sizeOf(value))
            else cache.delete(key)
          } catch {
            // An estimator is an optimization boundary, never permission to
            // fail a successful authoritative load or pin a rejected promise.
            cache.delete(key)
          }
        }
        return value
      }, (error: unknown) => {
        if (cache.peek(key) === entry) cache.delete(key)
        throw error
      })
      // A reservation bounds pending cache references too. The actual payload
      // is charged on settlement; requests outside this cache retain their own work.
      cache.set(key, entry, 256)
      return entry.promise
    },
    clear: cache.clear,
    snapshot: cache.snapshot,
  }
}
