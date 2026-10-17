/**
 * Runtime-aware adapter for the engine's canonical structured-content parser.
 *
 * Node builds and Cloudflare Workers must produce the same content graph. The
 * parser remains owned by `@thallylabs/core`; this adapter only supplies the
 * customer-authored bytes — through the active ContentSource on the async
 * path (so managed publishes are visible without a build), or the embedded
 * source map on the legacy sync path.
 */

import { isSafeContentIdentifier, type ContentDocument } from '@thallylabs/core/content'
import { parseMdxContent } from '@thallylabs/core/markdown'
import { parseFrontmatter } from '@/lib/frontmatter'
import {
  readRuntimeSource,
  runtimeSourceExists,
  runtimeSourceModifiedAt,
} from '@/lib/runtime-sources'
import { getContentSource } from '@/lib/content-source'
import { createBoundedCache, estimateRetainedPayloadBytes } from '@/lib/bounded-cache'

const CONTENT_ROOT = 'src/content'

/** Physical lookup order shared by full document reads and prepared search reads. */
export function contentFileCandidates(pageId: string, locale?: string): Array<string> {
  if (!isSafeContentIdentifier(pageId, locale)) return []
  const candidates: Array<string> = []
  if (locale) {
    candidates.push(
      `${CONTENT_ROOT}/${locale}/${pageId}.mdx`,
      `${CONTENT_ROOT}/${locale}/${pageId}/index.mdx`,
    )
  }
  candidates.push(`${CONTENT_ROOT}/${pageId}.mdx`, `${CONTENT_ROOT}/${pageId}/index.mdx`)
  return candidates
}

function resolveContentFile(pageId: string, locale?: string): string | null {
  for (const filePath of contentFileCandidates(pageId, locale)) {
    if (runtimeSourceExists(filePath)) return filePath
  }
  return null
}

// The build-observed mtime keeps the cache deterministic in both Node and
// workerd and lets development edits invalidate only their own document. The
// cache key carries the origin ("embedded" vs the ContentSource kind) because
// the sync and async paths can read DIFFERENT bytes for the same file path
// under the assets source, and mtime equality alone must not conflate them.
interface CachedDocument { modifiedAtMs: number; document: ContentDocument }
const documentCache = new Map<string, CachedDocument>()
const assetDocuments = createBoundedCache<CachedDocument>({ maxEntries: 128, maxBytes: 4 * 1024 * 1024 })

function parseDocument(
  origin: string,
  pageId: string,
  filePath: string,
  raw: string,
  modifiedAtMs: number,
): ContentDocument {
  const cacheKey = `${origin}:${filePath}`
  const cached = origin === 'assets' ? assetDocuments.get(cacheKey) : documentCache.get(cacheKey)
  if (cached?.modifiedAtMs === modifiedAtMs) return cached.document

  const { data, content } = parseFrontmatter(raw)
  const document: ContentDocument = {
    pageId,
    frontmatter: data,
    rawBody: content,
    // All structured consumers share the agent projection while the browser
    // continues to render authored MDX with the human Visibility components.
    content: parseMdxContent(content, 'agents'),
  }

  const entry = { modifiedAtMs, document }
  if (origin === 'assets') assetDocuments.set(cacheKey, entry, estimateRetainedPayloadBytes(entry, 4 * 1024 * 1024))
  else documentCache.set(cacheKey, entry)
  return document
}

/**
 * Read one page into the engine's single structured-content representation.
 *
 * Sync path over the build-embedded sources. Kept for local build-time callers
 * such as search indexing and the CLI readiness check; under the assets
 * ContentSource these read build-time content until the next code release —
 * the publish pipeline re-indexes search out of band. Request-time projections
 * must prefer {@link loadContentDocument}.
 */
export function getContentDocument(pageId: string, locale?: string): ContentDocument | null {
  const filePath = resolveContentFile(pageId, locale)
  if (!filePath) return null
  return parseDocument('embedded', pageId, filePath, readRuntimeSource(filePath), runtimeSourceModifiedAt(filePath))
}

/**
 * Async twin of {@link getContentDocument} that reads through the active
 * ContentSource, so managed content publishes are reflected immediately.
 * Identical to the sync path under the default filesystem source.
 */
export async function loadContentDocument(
  pageId: string,
  locale?: string,
): Promise<ContentDocument | null> {
  const source = getContentSource()
  for (const filePath of contentFileCandidates(pageId, locale)) {
    const file = await source.read(filePath)
    if (file) return parseDocument(source.kind, pageId, filePath, file.content, file.modifiedAtMs)
  }
  return null
}
