/**
 * Clone JSON journal containers without materializing a complete serialized
 * corpus. Immutable strings (especially shared asset base64) can remain shared,
 * while every mutable container belongs exclusively to the resumed runner.
 */
import type { UrlMigrationCheckpoint } from './url-run-types.js'

/** Preserve JSON value semantics for the checkpoint's plain data containers. */
export function cloneUrlMigrationCheckpoint(checkpoint: UrlMigrationCheckpoint): UrlMigrationCheckpoint {
  const ancestors = new Set<object>()
  const clone = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined
    if (typeof value !== 'object') throw new TypeError('Checkpoint must contain JSON-safe values.')
    if (ancestors.has(value)) throw new TypeError('Checkpoint must not contain circular references.')
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Checkpoint must contain plain JSON containers.')
    ancestors.add(value)
    try {
      if (Array.isArray(value)) return Array.from(value, (entry) => clone(entry) ?? null)
      // fromEntries creates own properties even for "__proto__"; assignment
      // would instead mutate the clone's prototype for untrusted JSON keys.
      return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
        const copied = clone(entry)
        return copied === undefined ? [] : [[key, copied]]
      }))
    } finally { ancestors.delete(value) }
  }
  return clone(checkpoint) as UrlMigrationCheckpoint
}
