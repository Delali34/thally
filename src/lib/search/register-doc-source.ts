/**
 * App → engine binding for page enumeration.
 *
 * `@thallylabs/core` is framework-agnostic and does not know how this site
 * lists its pages, so it exposes a resolver seam. This module fills it with the
 * app's `docs.json` + `src/content`-derived page list and runtime-aware content
 * reader. It is imported for its side-effect by every engine entry point
 * (search + embeddings), so registration always runs before the first corpus
 * or embedding-index build.
 *
 * Idempotent (last-wins), so multiple entry points importing it is harmless.
 * `DocEntry` is a structural superset of core's `DocEntrySummary`, so the app's
 * richer entries satisfy the resolver contract directly.
 */
import {
  registerSupplementalSearchRecordsSource,
  registerAsyncContentDocumentSource,
  registerAsyncSearchContentSource,
  registerAsyncDocEntriesSource,
  registerContentDocumentSource,
  registerDocEntriesSource,
} from '@thallylabs/core/registry'
import { canReaderViewPage, getDocEntries, getCurrentVersionPageIds, loadDocEntries, type DocEntry } from '@/data/docs'
import { getReaderAuthConfig } from '@/lib/reader-auth/config'
import { ANONYMOUS_READER, canReaderAccessUnmarkedContent, type ReaderContext } from '@/lib/reader-auth/access'
import { getContentDocument, loadContentDocument } from '@/lib/content/document'
import { getIndexableDocTranslation } from '@/lib/i18n/translation-source'
import { localizedPath } from '@/lib/i18n/config'
import { getEffectiveI18nConfig } from '@/lib/i18n/request'
import { loadPreparedSearchContent } from './prepared-content'

/**
 * The one listing rule for agent and search surfaces: search, MCP
 * `list_pages`/resources, `llms-full.txt` and the docs index all enumerate
 * pages through the async resolver registered below, so `hidden` and
 * `noindex` pages never appear in one listing but not another. Hidden and
 * noindex pages stay readable by explicit id/URL, like their HTML pages.
 *
 * On a versioned site, older versions (v1, v0) stay reachable by URL but never
 * outrank the current docs.
 */
export const isSearchable = (entry: { id: string; noindex?: boolean; hidden?: boolean }, currentVersionIds: Set<string> | null) =>
  !entry.noindex && !entry.hidden && (!currentVersionIds || currentVersionIds.has(entry.id))

registerDocEntriesSource(() => {
  const currentVersionIds = getCurrentVersionPageIds()
  return getDocEntries().filter((entry) => isSearchable(entry, currentVersionIds))
})
registerContentDocumentSource((pageId, locale) => getContentDocument(pageId, locale))
/**
 * Pages a reader may find through the agent listings, for one locale: the
 * {@link isSearchable} rule applied to the reader's view of the published
 * pages, and on a non-default locale only pages with an indexable
 * translation that this reader may also open (a translation may restrict its
 * page further than the primary file).
 *
 * The search corpus is shared by every searcher, so it is registered below
 * with the anonymous reader. MCP `list_pages`/resources and `llms-full.txt`
 * call it with the request's reader so a signed-in agent sees the same
 * listing rule over the pages it may open.
 */
export async function loadListedDocEntries(
  locale?: string,
  reader: ReaderContext = ANONYMOUS_READER,
): Promise<Array<Pick<DocEntry, 'id' | 'title' | 'description' | 'keywords' | 'href'> & Partial<DocEntry>>> {
  const entries = await loadDocEntries(reader)
  const i18n = await getEffectiveI18nConfig()
  const currentVersionIds = getCurrentVersionPageIds()
  if (!locale || locale === i18n.defaultLocale) return entries.filter((entry) => isSearchable(entry, currentVersionIds))
  if (!i18n.locales.some((item) => item.code === locale)) return []
  const translated = await Promise.all(entries.map(async (entry) => {
    if (!isSearchable(entry, currentVersionIds)) return null
    if (!(await canReaderViewPage(entry.id, reader, locale))) return null
    const metadata = await getIndexableDocTranslation(entry.slug, locale)
    if (!metadata) return null
    return {
      id: entry.id,
      title: metadata.title ?? entry.title,
      description: metadata.description ?? entry.description,
      keywords: metadata.keywords ?? entry.keywords,
      href: localizedPath(entry.href, locale, i18n.defaultLocale),
    }
  }))
  return translated.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
}

registerAsyncDocEntriesSource((locale) => loadListedDocEntries(locale))
registerAsyncContentDocumentSource((pageId, locale) => loadContentDocument(pageId, locale))
registerAsyncSearchContentSource(loadPreparedSearchContent)

// Generated API-reference operations have no MDX document, so they join the
// index as supplemental records. Loaded lazily so importing the search engine
// does not pull the OpenAPI normalizer into bundles that never search. Only
// the default locale: operation pages are not translated (docs-index agrees).
//
// The corpus is anonymous, and operations carry no page frontmatter: on a
// reader-auth site whose default is private they are not public content.
registerSupplementalSearchRecordsSource(async (locale) => {
  if (!canReaderAccessUnmarkedContent(ANONYMOUS_READER, getReaderAuthConfig())) return []
  const i18n = await getEffectiveI18nConfig()
  if (locale && locale !== i18n.defaultLocale) return []
  const { getApiOperationSearchIndex } = await import('@/data/api-reference')
  return getApiOperationSearchIndex()
})
