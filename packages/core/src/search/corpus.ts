/** Search-record projections over the canonical structured content graph. */

import { getContentDocument, loadContentDocument } from '../content/index.js'
import { resolveDocEntries, resolveDocEntriesAsync } from '../doc-source.js'
import { projectSearchContent, resolvePreparedSearchContent } from './projection.js'
import { resolveSupplementalSearchRecords, type SearchRecordType } from './supplemental.js'

/**
 * A heading-bounded slice kept beside a record so a hit can point at the
 * section that matched (`href#anchor`). Not indexed: ranking stays page-level.
 */
export interface SearchRecordSection {
  /** Heading id; '' for the page preamble. */
  id: string
  title: string
  text: string
}

export interface SearchRecord {
  id: string
  pageId: string
  title: string
  description: string
  headings: string
  body: string
  keywords: string
  href: string
  /** Absent on records built before typed records existed; treat as `page`. */
  type?: SearchRecordType
  sections?: Array<SearchRecordSection>
  method?: string
  path?: string
}

const BODY_LIMIT = 4000
const CLIENT_BODY_LIMIT = 700

function buildRecords(bodyLimit: number): Array<SearchRecord> {
  const records: Array<SearchRecord> = []
  for (const entry of resolveDocEntries()) {
    const document = getContentDocument(entry.id)
    if (!document) continue
    const headings = document.content.headings.map((heading) => heading.text).join(' · ')
    const body = document.content.text.slice(0, bodyLimit)
    records.push({
      id: entry.id,
      pageId: entry.id,
      title: entry.title,
      description: entry.description,
      headings,
      body,
      keywords: entry.keywords.join(' '),
      href: entry.href,
    })
  }
  return records
}

async function buildRecordsAsync(bodyLimit: number, locale?: string): Promise<Array<SearchRecord>> {
  const records = await Promise.all(
    (await resolveDocEntriesAsync(locale)).map(async (entry): Promise<SearchRecord | null> => {
      const prepared = await resolvePreparedSearchContent(entry.id, locale)
      const document = prepared ? null : await loadContentDocument(entry.id, locale)
      const content = prepared ?? (document ? projectSearchContent(document.content) : null)
      if (!content) return null
      return {
        id: entry.id,
        pageId: entry.id,
        title: entry.title,
        description: entry.description,
        headings: content.headings,
        body: content.body.slice(0, bodyLimit),
        keywords: entry.keywords.join(' '),
        href: entry.href,
        type: 'page',
        sections: content.sections,
      }
    }),
  )
  const pages = records.filter((record): record is SearchRecord => record !== null)
  const pageIds = new Set(pages.map((record) => record.id))
  // Generated records (API operations) join the same index, so one query ranks
  // pages and operations together. A page id always wins a collision.
  const supplemental = (await resolveSupplementalSearchRecords(locale))
    .filter((record) => !pageIds.has(record.id))
    .map((record): SearchRecord => ({
      id: record.id,
      pageId: record.id,
      title: record.title,
      description: record.description,
      headings: '',
      body: (record.body ?? '').slice(0, bodyLimit),
      keywords: record.keywords.join(' '),
      href: record.href,
      type: record.type,
      ...(record.method ? { method: record.method } : {}),
      ...(record.path ? { path: record.path } : {}),
    }))
  return [...pages, ...supplemental]
}

let serverCorpus: Array<SearchRecord> | null = null

/** Full corpus (long body) used by the server hybrid index. */
export function buildSearchCorpus(): Array<SearchRecord> {
  if (!serverCorpus) serverCorpus = buildRecords(BODY_LIMIT)
  return serverCorpus
}

const asyncServerCorpora = new Map<string, Promise<Array<SearchRecord>>>()

/** Full server corpus supporting remote/asset-backed content readers. */
export function buildSearchCorpusAsync(locale?: string): Promise<Array<SearchRecord>> {
  const key = locale ?? ''
  const cached = asyncServerCorpora.get(key)
  if (cached) return cached
  const pending = buildRecordsAsync(BODY_LIMIT, locale)
  asyncServerCorpora.set(key, pending)
  // A temporary content-service outage must not pin a failed index until
  // the next deployment. Identity fencing preserves a newer reset/retry.
  void pending.catch(() => {
    if (asyncServerCorpora.get(key) === pending) asyncServerCorpora.delete(key)
  })
  return pending
}

let clientCorpus: Array<SearchRecord> | null = null

/** Lighter corpus (truncated body) shipped to the browser for instant search. */
export function getClientSearchCorpus(): Array<SearchRecord> {
  if (!clientCorpus) clientCorpus = buildRecords(CLIENT_BODY_LIMIT)
  return clientCorpus
}

/** Drop the memoized request-time corpora (used by `resetSearchEngine`). */
export function resetSearchCorpora() {
  asyncServerCorpora.clear()
}
