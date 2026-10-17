/** The bounded URL cache cannot discard pending work or poison retries. */
import { describe, expect, it } from 'vitest'
import { createMigrationAssetCache } from '../url-asset-cache.js'
import type { MigrationCapturedAsset } from '../url-run-types.js'

const asset: MigrationCapturedAsset = { url: 'https://docs.test/image.png', contentType: 'image/png', content: new Uint8Array([1]) }

describe('migration acquisition cache', () => {
  it('bounds settled URL metadata, refreshes hits and retains pending coalescing', async () => {
    const cache = createMigrationAssetCache()
    for (let index = 0; index < 480; index++) cache.remember(String(index), asset)
    await cache.get('0')
    const releases: Array<(value: MigrationCapturedAsset) => void> = []
    let acquisitions = 0
    const requests = Array.from({ length: 32 }, (_, index) => cache.load(`pending-${index}`, () => {
      acquisitions++
      return new Promise<MigrationCapturedAsset>((resolve) => { releases.push(resolve) })
    }))
    await Promise.resolve()
    expect(cache.size).toBe(512)
    expect(cache.load('pending-0', async () => { throw new Error('Must coalesce') })).toBe(requests[0])
    // Settled churn cannot evict an old, slow pending request.
    for (let index = 480; index < 1000; index++) cache.remember(String(index), asset)
    expect(cache.size).toBe(512)
    expect(cache.get('pending-0')).toBe(requests[0])
    expect(cache.has('0')).toBe(false)
    releases.forEach((release) => release(asset))
    await Promise.all(requests)
    expect(acquisitions).toBe(32)
    expect(cache.size).toBe(480)
    expect(await cache.get('pending-0')).toBe(asset)
  })

  it('refreshes settled recency and recovers rejected or synchronous acquisitions', async () => {
    const cache = createMigrationAssetCache()
    for (let index = 0; index < 480; index++) cache.remember(String(index), asset)
    await cache.get('0')
    cache.remember('next', asset)
    expect(cache.has('0')).toBe(true)
    expect(cache.has('1')).toBe(false)
    await expect(cache.load('failure', () => { throw new Error('Unavailable') })).rejects.toThrow('Unavailable')
    expect(cache.has('failure')).toBe(false)
    expect(await cache.load('failure', async () => asset)).toBe(asset)
    cache.delete('failure')
    expect(cache.has('failure')).toBe(false)
  })
})
