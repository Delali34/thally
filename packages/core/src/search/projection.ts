/** Canonical search text and optional host-prepared projections of that text. */

import type { ParsedContent } from '../content/types.js'

export interface SearchContentSection {
  id: string
  title: string
  text: string
}

/** Content-only fields: listing metadata and access decisions remain request-time concerns. */
export interface SearchContentProjection {
  headings: string
  body: string
  sections: Array<SearchContentSection>
}

/** One projection shared by ordinary reads and build-prepared managed assets. */
export function projectSearchContent(content: ParsedContent): SearchContentProjection {
  return {
    headings: content.headings.map((heading) => heading.text).join(' · '),
    body: content.text.slice(0, 4000),
    sections: (content.sections ?? []).map((section) => ({
      id: section.id,
      title: section.title,
      text: section.text.slice(0, 2000),
    })),
  }
}

export type AsyncSearchContentResolver = (
  pageId: string,
  locale?: string,
) => Promise<SearchContentProjection | undefined>

let resolver: AsyncSearchContentResolver | undefined

/**
 * Supply an optional prepared canonical projection. Undefined requests the
 * ordinary document reader; transport failures must reject so a partial
 * corpus cannot become a successful cached index.
 */
export function registerAsyncSearchContentSource(source: AsyncSearchContentResolver): void {
  resolver = source
}

/** Internal lookup after the host's current page-list/access filters have run. */
export function resolvePreparedSearchContent(pageId: string, locale?: string): Promise<SearchContentProjection | undefined> {
  return resolver?.(pageId, locale) ?? Promise.resolve(undefined)
}
