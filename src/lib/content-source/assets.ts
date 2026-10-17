/**
 * The managed-runtime ContentSource: content served from the deployed
 * Worker's own static assets.
 *
 * A content publish uploads customer files under a reserved asset prefix and
 * a manifest listing them, reusing the previous release's Worker modules.
 * Because assets are immutable per deployment (a publish mints a new script),
 * successful values may be reused while bounded cache capacity permits.
 *
 * Layout (the contract the publish pipeline must produce):
 *   /_thally/content/manifest.json                 — ContentManifest (below)
 *   /_thally/content/<project-relative-path>       — file bytes, verbatim
 * e.g. /_thally/content/src/content/introduction.mdx
 *
 * Missing bindings and unavailable deployment manifests fall back to embedded
 * content. Transient transport/service failures retry, then reject: silently
 * omitting published pages would permanently poison derived search indexes.
 * `AGENTS.md` is the exception to fallback: it carries
 * tenant identity, so assets mode reports it missing rather than exposing a
 * baseline Worker's embedded guidance.
 */

import type { ContentSource, ContentSourceFile } from './types'
import { createBoundedPromiseCache } from '@/lib/bounded-cache'
import { getContentAssetFetcher, type ContentAssetFetcher } from './runtime'

/** Reserved asset prefix for published content. Shared with the publish pipeline. */
export const CONTENT_ASSET_PREFIX = '/_thally/content/'

/** Manifest asset path. One fetch answers exists/list/modifiedAt for the release. */
export const CONTENT_MANIFEST_PATH = `${CONTENT_ASSET_PREFIX}manifest.json`

/** Root guidance is tenant-bound and must never fall back across deployments. */
const TENANT_IDENTITY_BOUND_PATH = 'AGENTS.md'
const MAX_ASSET_READS = 4
const ASSET_READ_ATTEMPTS = 3

export interface ContentManifestEntry {
  /** Publish-observed modification time (e.g. commit timestamp). */
  modifiedAtMs?: number
}

export interface ContentManifest {
  version: 1
  /** Project-relative POSIX path → metadata, for every published content file. */
  files: Record<string, ContentManifestEntry>
}

function isContentManifest(value: unknown): value is ContentManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<ContentManifest>
  return manifest.version === 1 && typeof manifest.files === 'object' && manifest.files !== null
}

/**
 * Reject absolute or traversing paths before they reach a URL. The asset
 * namespace mirrors project-relative paths only; anything else is hostile or
 * a bug.
 */
function isSafeProjectPath(projectPath: string): boolean {
  if (!projectPath || projectPath.startsWith('/')) return false
  return projectPath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function assetUrlPath(projectPath: string): string {
  // Encode each segment (not the slashes) so file names with spaces or
  // unicode round-trip through the asset URL space.
  return CONTENT_ASSET_PREFIX + projectPath.split('/').map(encodeURIComponent).join('/')
}

/** Create a release-scoped reader with bounded, retryable asset transfers. */
export function createAssetsContentSource(
  fallback: ContentSource,
  resolveFetcher: () => ContentAssetFetcher | null = getContentAssetFetcher,
): ContentSource {
  // Release identity makes reuse correct; budgets keep a long-lived isolate
  // from retaining every page that a crawler or reader has ever requested.
  let manifestPromise: Promise<ContentManifest | null> | null = null
  const files = createBoundedPromiseCache<ContentSourceFile | null>({
    maxEntries: 128, maxBytes: 4 * 1024 * 1024,
    sizeOf: (file) => file ? file.content.length * 2 + 128 : 0,
  })
  let warnedUnavailable = false
  let activeReads = 0
  const waitingReads = new Set<() => void>()

  /** Hold capacity through body consumption, not merely response headers. */
  async function withReadSlot<T>(read: () => Promise<T>): Promise<T> {
    if (activeReads < MAX_ASSET_READS) activeReads += 1
    else await new Promise<void>((resolve) => waitingReads.add(resolve))
    try {
      return await read()
    } finally {
      // Transfer ownership directly so a new caller cannot steal a slot
      // between waking the oldest reader and its promise continuation.
      const next = waitingReads.values().next().value
      if (next) {
        waitingReads.delete(next)
        next()
      } else activeReads -= 1
    }
  }

  async function readResponse(fetchAsset: ContentAssetFetcher, assetPath: string): Promise<{ status: number; body: string | null }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withReadSlot(async () => {
          const response = await fetchAsset(assetPath)
          if (response.ok) return { status: response.status, body: await response.text() }
          // Failed response bodies still occupy a connection until cancelled.
          await response.body?.cancel()
          if ([408, 425, 429].includes(response.status) || response.status >= 500) {
            throw new Error(`Published content asset temporarily unavailable (${response.status})`)
          }
          return { status: response.status, body: null }
        })
      } catch (error) {
        if (attempt + 1 >= ASSET_READ_ATTEMPTS) throw error
        // Retry outside the slot so healthy queued reads can make progress.
        await new Promise<void>((resolve) => setTimeout(resolve, 25 * 2 ** attempt))
      }
    }
  }

  function readFallback(projectPath: string): Promise<ContentSourceFile | null> {
    return projectPath === TENANT_IDENTITY_BOUND_PATH
      ? Promise.resolve(null)
      : fallback.read(projectPath)
  }

  function warnFallbackOnce(reason: string): void {
    if (warnedUnavailable) return
    warnedUnavailable = true
    console.warn(
      `[thally] content source "assets" is unavailable (${reason}); falling back to build-embedded content.`,
    )
  }

  /**
   * Load the manifest once per isolate. A missing fetcher is not cached as a
   * failure — the Cloudflare context may simply not exist yet. Terminal
   * deployment defects are cached; exhausted transient failures reject and
   * clear the attempt so a later request can recover in the same isolate.
   */
  function loadManifest(): Promise<ContentManifest | null> {
    const fetchAsset = resolveFetcher()
    if (!fetchAsset) {
      warnFallbackOnce('no assets fetcher')
      return Promise.resolve(null)
    }
    if (!manifestPromise) {
      const pending = (async () => {
        const response = await readResponse(fetchAsset, CONTENT_MANIFEST_PATH)
        // A served-but-unusable manifest (missing, or malformed JSON) is a
        // deployment defect a retry cannot fix — cache the failure so a
        // broken release does not hammer the asset host on every read.
        if (response.body === null) {
          warnFallbackOnce(`manifest fetch returned ${response.status}`)
          return null
        }
        try {
          const parsed: unknown = JSON.parse(response.body)
          if (!isContentManifest(parsed)) {
            warnFallbackOnce('manifest is malformed')
            return null
          }
          return parsed
        } catch {
          warnFallbackOnce('manifest is malformed')
          return null
        }
      })()
      manifestPromise = pending
      void pending.catch(() => {
        if (manifestPromise === pending) manifestPromise = null
      })
    }
    return manifestPromise
  }

  function readAsset(projectPath: string, manifest: ContentManifest): Promise<ContentSourceFile | null> {
    const fetchAsset = resolveFetcher()
    // A temporarily unavailable binding must not turn embedded fallback bytes
    // into a successful asset-cache entry for the rest of the deployment.
    if (!fetchAsset) return readFallback(projectPath)
    return files.getOrLoad(projectPath, async () => {
      try {
        const response = await readResponse(fetchAsset, assetUrlPath(projectPath))
        if (response.body === null) {
          console.warn(`[thally] published content asset missing: ${projectPath} (${response.status})`)
          return null
        }
        return {
          content: response.body,
          modifiedAtMs: manifest.files[projectPath]?.modifiedAtMs ?? 0,
        }
      } catch (error) {
        console.warn(`[thally] published content asset read failed: ${projectPath} (${error instanceof Error ? error.message : 'fetch failed'})`)
        throw error
      }
    })
  }

  return {
    kind: 'assets',

    async exists(projectPath: string): Promise<boolean> {
      if (!isSafeProjectPath(projectPath)) return false
      const manifest = await loadManifest()
      if (!manifest) return fallback.exists(projectPath)
      return Object.prototype.hasOwnProperty.call(manifest.files, projectPath)
    },

    async read(projectPath: string): Promise<ContentSourceFile | null> {
      if (!isSafeProjectPath(projectPath)) return null
      const manifest = await loadManifest()
      if (!manifest) return readFallback(projectPath)
      if (!Object.prototype.hasOwnProperty.call(manifest.files, projectPath)) return null
      return readAsset(projectPath, manifest)
    },

    async modifiedAt(projectPath: string): Promise<number> {
      if (!isSafeProjectPath(projectPath)) return 0
      const manifest = await loadManifest()
      if (!manifest) return fallback.modifiedAt(projectPath)
      return manifest.files[projectPath]?.modifiedAtMs ?? 0
    },

    async list(prefix: string): Promise<Array<string>> {
      const manifest = await loadManifest()
      if (!manifest) return fallback.list(prefix)
      const normalizedPrefix = `${prefix.replace(/\/+$/, '')}/`
      return Object.keys(manifest.files).filter((key) => key.startsWith(normalizedPrefix))
    },
  }
}
