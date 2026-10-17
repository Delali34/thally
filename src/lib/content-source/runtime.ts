/**
 * Lazy, dependency-free access to the deployment's static-assets fetcher.
 *
 * The assets ContentSource needs `env.ASSETS.fetch` from the Cloudflare
 * runtime, but the engine must not depend on `@opennextjs/cloudflare` (it is
 * a dev-only adapter here, and self-host builds may not install it at all).
 * The adapter stores its request context on `globalThis` under a well-known
 * symbol, so we read that directly and fail soft: when no binding is
 * available — Node self-host, tests, `next build` — the accessor returns
 * null and callers fall back to the embedded filesystem source.
 */

/** One asset lookup: a project-relative URL path in, a fetch Response out. */
export type ContentAssetFetcher = (assetPath: string) => Promise<Response>

/**
 * `@opennextjs/cloudflare` publishes its per-request context under this
 * symbol (the same one `getCloudflareContext()` reads). Using the symbol
 * keeps the engine free of the adapter dependency.
 */
const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for('__cloudflare-context__')

/**
 * The binding fetch requires an absolute URL; the host is ignored — only the
 * path selects an asset.
 */
const ASSET_URL_BASE = 'https://assets.internal'

let injectedFetcher: ContentAssetFetcher | null = null

interface CloudflareContextShape {
  env?: Record<string, unknown>
  ctx?: object
}

interface AssetsBindingShape {
  fetch?: (input: URL) => Promise<Response>
}

/**
 * Override the asset fetcher. Tests inject mocks here; non-Cloudflare hosts
 * that serve deployment assets some other way can register their own bridge.
 * Pass null to restore automatic resolution.
 */
export function setContentAssetFetcher(fetcher: ContentAssetFetcher | null): void {
  injectedFetcher = fetcher
}

/**
 * Identity for pending work owned by one adapter invocation, never its shared
 * environment/binding. OpenNext's symbol is an AsyncLocalStorage getter and
 * each request receives its own context and ExecutionContext. A host exposing
 * only the wrapper still gets independent ownership instead of a global queue.
 */
export function getContentAssetRequestContext(): object | null {
  const context = (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT_SYMBOL]
  if (!context || typeof context !== 'object') return null
  const ctx = (context as CloudflareContextShape).ctx
  return ctx && typeof ctx === 'object' ? ctx : context
}

/**
 * Resolve the current asset fetcher, or null when none is available. Resolved
 * on every call (never cached) because the Cloudflare context appears only
 * once the runtime has initialized a request — module scope is too early.
 */
export function getContentAssetFetcher(): ContentAssetFetcher | null {
  if (injectedFetcher) return injectedFetcher

  const context = (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT_SYMBOL] as
    | CloudflareContextShape
    | undefined
  const assets = context?.env?.ASSETS as AssetsBindingShape | undefined
  if (typeof assets?.fetch !== 'function') return null

  return (assetPath: string) => assets.fetch!(new URL(assetPath, ASSET_URL_BASE))
}
