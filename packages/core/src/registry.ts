/** Pure host-registration entry with no filesystem fallback in its graph. */

export {
  registerAsyncDocEntriesSource,
  registerDocEntriesSource,
  resolveDocEntries,
  resolveDocEntriesAsync,
} from './doc-source.js'
export type { DocEntrySummary } from './doc-source.js'
export {
  registerAsyncContentDocumentSource,
  registerContentDocumentSource,
} from './content/source-registry.js'
export type {
  AsyncContentDocumentResolver,
  ContentDocumentResolver,
} from './content/source-registry.js'
export type { ContentDocument } from './content/document.js'
export { registerAsyncSearchContentSource } from './search/projection.js'
export type { AsyncSearchContentResolver } from './search/projection.js'
export { registerSupplementalSearchRecordsSource } from './search/supplemental.js'
export type { SupplementalSearchRecord, SearchRecordType } from './search/supplemental.js'
