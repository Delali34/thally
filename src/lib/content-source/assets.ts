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
 * Failure contract: this source must never take a site down. When the assets
 * binding is missing or the manifest cannot be loaded, operations fall back
 * to the embedded filesystem source. `AGENTS.md` is the exception: it carries
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
   * failure — the Cloudflare context may simply not exist yet — but a fetched
   * failure is, to avoid hammering a broken deployment on every read.
   */
  function loadManifest(): Promise<ContentManifest | null> {
    const fetchAsset = resolveFetcher()
    if (!fetchAsset) {
      warnFallbackOnce('no assets fetcher')
      return Promise.resolve(null)
    }
    if (!manifestPromise) {
      manifestPromise = (async () => {
        let response: Response
        try {
          response = await fetchAsset(CONTENT_MANIFEST_PATH)
        } catch (error) {
          // A thrown fetch is transient: fall back for this read but clear
          // the cached attempt so the next read retries instead of pinning
          // the whole isolate to embedded content.
          manifestPromise = null
          warnFallbackOnce(error instanceof Error ? error.message : 'manifest fetch failed')
          return null
        }
        // A served-but-unusable manifest (missing, or malformed JSON) is a
        // deployment defect a retry cannot fix — cache the failure so a
        // broken release does not hammer the asset host on every read.
        if (!response.ok) {
          warnFallbackOnce(`manifest fetch returned ${response.status}`)
          return null
        }
        try {
          const parsed: unknown = await response.json()
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
        const response = await fetchAsset(assetUrlPath(projectPath))
        if (!response.ok) {
          console.warn(`[thally] published content asset missing: ${projectPath} (${response.status})`)
          return null
        }
        return {
          content: await response.text(),
          modifiedAtMs: manifest.files[projectPath]?.modifiedAtMs ?? 0,
        }
      } catch (error) {
        console.warn(`[thally] published content asset read failed: ${projectPath} (${error instanceof Error ? error.message : 'fetch failed'})`)
        return null
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
