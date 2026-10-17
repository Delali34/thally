/** Resolve prepared search text using exactly the ordinary document's physical-file precedence. */
import type { SearchContentProjection } from '@thallylabs/core/search'
import { getContentSource } from '@/lib/content-source'
import { contentFileCandidates } from '@/lib/content/document'

/** Current membership wins over a stale prepared file or a different locale fallback. */
export async function loadPreparedSearchContent(pageId: string, locale?: string): Promise<SearchContentProjection | undefined> {
  const source = getContentSource()
  if (!source.searchContent) return undefined
  for (const filePath of contentFileCandidates(pageId, locale)) {
    if (await source.exists(filePath)) return source.searchContent(filePath)
  }
  return undefined
}
