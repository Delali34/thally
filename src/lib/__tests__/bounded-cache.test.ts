/** Cache budgets bound retained ownership without changing authoritative load results. */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createBoundedCache, createBoundedPromiseCache, estimateRetainedPayloadBytes } from '../bounded-cache'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('bounded LRU ownership', () => {
  it('evicts least recently used entries, accounts replacement and rejects oversized values', () => {
    const cache = createBoundedCache<string>({ maxEntries: 2, maxBytes: 400 })
    cache.set('a', 'A', 60); cache.set('b', 'B', 60)
    expect(cache.get('a')).toBe('A')
    cache.set('c', 'C', 60)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('A')
    cache.set('a', 'replacement', 190)
    expect(cache.snapshot()).toEqual({ entries: 2, bytes: 382 })
    expect(cache.set('huge', 'huge', 401)).toBe(false)
    expect(cache.snapshot()).toEqual({ entries: 2, bytes: 382 })
    cache.delete('a'); cache.delete('absent')
    expect(cache.snapshot()).toEqual({ entries: 1, bytes: 126 })
    cache.clear()
    expect(cache.snapshot()).toEqual({ entries: 0, bytes: 0 })
  })

  it('enforces byte capacity independently of entry capacity', () => {
    const cache = createBoundedCache<number>({ maxEntries: 100, maxBytes: 250 })
    cache.set('a', 1, 100); cache.set('b', 2, 100)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.snapshot()).toEqual({ entries: 1, bytes: 166 })
  })

  it('coalesces concurrent loads and never caches failures, nulls or oversized successful payloads', async () => {
    const cache = createBoundedPromiseCache<string | null>({ maxEntries: 2, maxBytes: 1000, sizeOf: value => (value?.length ?? 0) * 2 })
    const request = deferred<string>()
    const load = vi.fn(() => request.promise)
    const first = cache.getOrLoad('same', load)
    expect(cache.getOrLoad('same', load)).toBe(first)
    request.resolve('payload')
    expect(await first).toBe('payload')
    expect(await cache.getOrLoad('same', load)).toBe('payload')
    expect(load).toHaveBeenCalledOnce()
    const failed = vi.fn(async () => { throw new Error('temporary') })
    await expect(cache.getOrLoad('failure', failed)).rejects.toThrow('temporary')
    await expect(cache.getOrLoad('failure', failed)).rejects.toThrow('temporary')
    expect(failed).toHaveBeenCalledTimes(2)
    const absent = vi.fn(async () => null)
    await cache.getOrLoad('missing', absent); await cache.getOrLoad('missing', absent)
    expect(absent).toHaveBeenCalledTimes(2)
    const huge = vi.fn(async () => 'x'.repeat(1000))
    expect(await cache.getOrLoad('huge', huge)).toHaveLength(1000)
    await cache.getOrLoad('huge', huge)
    expect(huge).toHaveBeenCalledTimes(2)
    expect(cache.snapshot().bytes).toBeLessThanOrEqual(1000)
  })

  it.each([false, true])('does not let an evicted pending completion replace/delete a newer load (reject: %s)', async (reject) => {
    const cache = createBoundedPromiseCache<string>({ maxEntries: 1, maxBytes: 1000, sizeOf: value => value.length * 2 })
    const old = deferred<string>()
    const previous = cache.getOrLoad('key', () => old.promise)
    const rejection = previous.catch(() => 'old rejected')
    await cache.getOrLoad('other', async () => 'other')
    const newest = cache.getOrLoad('key', async () => 'new')
    expect(await newest).toBe('new')
    if (reject) old.reject(new Error('stale'))
    else old.resolve('old')
    await rejection
    expect(await cache.getOrLoad('key', async () => 'wrong')).toBe('new')
    expect(cache.snapshot().entries).toBe(1)
  })

  it('returns successful results uncached if sizing fails and bounds unresolved cache entries', async () => {
    const cache = createBoundedPromiseCache<string>({ maxEntries: 2, maxBytes: 1000, sizeOf: () => { throw new Error('sizing') } })
    expect(await cache.getOrLoad('ok', async () => 'result')).toBe('result')
    expect(cache.snapshot().entries).toBe(0)
    const pending = deferred<string>()
    const loads = Array.from({ length: 20 }, (_, index) => cache.getOrLoad(String(index), () => pending.promise))
    expect(cache.snapshot().entries).toBe(2)
    pending.resolve('done')
    expect(await Promise.all(loads)).toEqual(Array.from({ length: 20 }, () => 'done'))
    expect(cache.snapshot().entries).toBe(0)
  })

  it('estimates cyclic payloads conservatively without executing getters', () => {
    const getter = vi.fn(() => 'hidden')
    const object: Record<string, unknown> = { text: 'hello', raw: new Uint8Array(20) }
    object.self = object
    Object.defineProperty(object, 'computed', { get: getter, enumerable: true })
    expect(estimateRetainedPayloadBytes(object)).toBeGreaterThan(40)
    expect(getter).not.toHaveBeenCalled()
    expect(estimateRetainedPayloadBytes({ text: 'x'.repeat(1000) }, 100)).toBe(101)
  })

  it('rejects native and cross-realm promises whose retained results cannot be measured', () => {
    const promises = [Promise.resolve('x'.repeat(10_000)), runInNewContext('Promise.resolve("payload")')]
    for (const promise of promises) {
      expect(estimateRetainedPayloadBytes({ content: { owner: { searchParams: promise } } }, 1000)).toBe(1001)
    }
  })

  it('never enumerates or reads request promises nested in a React owner graph', () => {
    const ownKeys = vi.fn(() => { throw new Error('Object.keys(searchParams) is synchronous dynamic access') })
    const get = vi.fn(() => { throw new Error('request data must not be inspected') })
    const searchParams = new Proxy(Promise.resolve({ query: 'value' }), { ownKeys, get })
    const content = { _owner: { pendingProps: { searchParams } } }

    expect(estimateRetainedPayloadBytes({ content }, 1000)).toBe(1001)
    expect(ownKeys).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('returns successful owner-bearing content uncached without inspecting dynamic request data', async () => {
    const ownKeys = vi.fn(() => { throw new Error('synchronous dynamic access') })
    const result = { content: { _owner: { searchParams: new Proxy(Promise.resolve({}), { ownKeys }) } } }
    const cache = createBoundedPromiseCache<typeof result>({
      maxEntries: 2,
      maxBytes: 1000,
      sizeOf: value => estimateRetainedPayloadBytes(value, 1000),
    })
    const load = vi.fn(async () => result)
    expect(await cache.getOrLoad('doc', load)).toBe(result)
    expect(cache.snapshot()).toEqual({ entries: 0, bytes: 0 })
    expect(await cache.getOrLoad('doc', load)).toBe(result)
    expect(load).toHaveBeenCalledTimes(2)
    expect(ownKeys).not.toHaveBeenCalled()
  })
})
