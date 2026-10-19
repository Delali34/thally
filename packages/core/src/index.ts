/**
 * `@thallylabs/core` — the framework-agnostic core of the Thally docs engine.
 *
 * This is the server-oriented main entry: the content pipeline (single-parse
 * MDX → typed content graph), the search engine and corpus, and the embedding
 * index. It has no dependency on Next.js, React, or `docs.json`; the host wires
 * in its page list through {@link registerDocEntriesSource} (see `./doc-source`).
 *
 * Leaner subpath entries exist for consumers that don't want the full barrel:
 * `@thallylabs/core/content` exposes just the content pipeline, and
 * `@thallylabs/core/theme` exposes the pure brand/theme token helpers so
 * client bundles never pull in Node/MDX/search code. The package declares
 * `"sideEffects": false`, so keep every module here import-safe: no top-level
 * global mutation, registration, or I/O — bundlers are told they may drop any
 * module whose exports go unused.
 *
 * Boundary note: nothing here may import `src/cloud` — core is engine-side and
 * ships in the OSS distribution. Cloud-tier services reach engine code, never
 * the reverse.
 */

// Doc-entry source registry (host-provided page enumeration).
export {
  registerAsyncDocEntriesSource,
  registerDocEntriesSource,
  resolveDocEntries,
  resolveDocEntriesAsync,
} from './doc-source.js'
export type { DocEntrySummary } from './doc-source.js'

// Slug helper (shared with the app's src/lib/utils re-export).
export { slugify, updateAnchorId } from './slugify.js'

// Content pipeline.
export {
  parseMdxContent,
  projectMdxAudience,
  getContentDocument,
  loadContentDocument,
  registerAsyncContentDocumentSource,
  registerContentDocumentSource,
  mdxToMarkdown,
  markdownToPlainText,
} from './content/index.js'
export type { ContentAudience } from './content/index.js'
export type {
  AsyncContentDocumentResolver,
  ContentDocument,
  ContentDocumentResolver,
  ContentHeading,
  ContentTocItem,
  ContentCodeBlock,
  ContentLink,
  ContentSection,
  ContentUpdate,
  ParsedContent,
} from './content/index.js'

// Search.
export {
  searchDocs,
  getSearchEngine,
  resetSearchEngine,
} from './search/engine.js'
export type { SearchMode, SearchHit } from './search/engine.js'
export {
  buildSearchCorpus,
  buildSearchCorpusAsync,
  getClientSearchCorpus,
} from './search/corpus.js'
export type { SearchRecord, SearchRecordSection } from './search/corpus.js'
export { searchSections, getSectionCorpus } from './search/sections.js'
export type { SectionHit, SearchSectionsOptions } from './search/sections.js'
export { registerSupplementalSearchRecordsSource } from './search/supplemental.js'
export type { SupplementalSearchRecord, SearchRecordType } from './search/supplemental.js'

// Embeddings.
export {
  getEmbeddingProvider,
  localHashProvider,
  embedLocal,
  resetEmbeddingProvider,
  chunkDocument,
  estimateTokens,
  buildEmbeddingIndex,
  getEmbeddingIndex,
  resetEmbeddingIndex,
  getRelevantChunks,
  rankChunks,
  rankIndexedChunks,
  rankLexicalChunks,
  wordTokens,
} from './embeddings/index.js'
export type {
  PageSource,
  BuildOptions,
  RankOptions,
  Chunk,
  EmbeddedChunk,
  EmbeddingIndex,
  EmbeddingProvider,
  EmbeddingVector,
  RetrievalResult,
} from './embeddings/index.js'
