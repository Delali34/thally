/**
 * Acquisition cache: retain at most 480 settled URLs and the runner's at most
 * 32 concurrent acquisitions. Pending requests are pinned until settlement so
 * a slow shared URL cannot be evicted and fetched again concurrently.
 */
import type { MigrationCapturedAsset } from './url-run-types.js'

/** Create a per-run cache; durable asset provenance remains in the journal. */
export function createMigrationAssetCache() {
  const settled = new Map<string, MigrationCapturedAsset>()
  const pending = new Map<string, Promise<MigrationCapturedAsset>>()
  const remember = (url: string, asset: MigrationCapturedAsset): MigrationCapturedAsset => {
    settled.delete(url)
    settled.set(url, asset)
    if (settled.size > 480) settled.delete(settled.keys().next().value!)
    return asset
  }
  const get = (url: string): Promise<MigrationCapturedAsset> | undefined => {
    const asset = settled.get(url)
    if (asset) return Promise.resolve(remember(url, asset))
    return pending.get(url)
  }
  return {
    remember,
    get,
    has(url: string) { return settled.has(url) || pending.has(url) },
    get size() { return settled.size + pending.size },
    load(url: string, acquire: () => Promise<MigrationCapturedAsset>): Promise<MigrationCapturedAsset> {
      const existing = get(url)
      if (existing) return existing
      // Deferred invocation also makes synchronous host failures follow the
      // same cleanup contract as rejected asynchronous acquisitions.
      const request = Promise.resolve().then(acquire).then((asset) => {
        pending.delete(url)
        return remember(url, asset)
      }, (error: unknown) => {
        pending.delete(url)
        throw error
      })
      pending.set(url, request)
      return request
    },
    delete(url: string): void { settled.delete(url) },
  }
}
