/** Framework-agnostic search entry isolated from filesystem document loading. */

export { searchDocs, getSearchEngine, resetSearchEngine } from './engine.js'
export type { SearchMode, SearchHit } from './engine.js'
export {
  buildSearchCorpus,
  buildSearchCorpusAsync,
  getClientSearchCorpus,
} from './corpus.js'
export type { SearchRecord } from './corpus.js'
export { searchSections, getSectionCorpus } from './sections.js'
export type { SectionHit, SearchSectionsOptions } from './sections.js'
export { registerSupplementalSearchRecordsSource } from './supplemental.js'
export type { SupplementalSearchRecord, SearchRecordType } from './supplemental.js'
export type { SearchRecordSection } from './corpus.js'
export { projectSearchContent, registerAsyncSearchContentSource } from './projection.js'
export type { SearchContentProjection, SearchContentSection, AsyncSearchContentResolver } from './projection.js'
