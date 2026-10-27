/**
 * `@thallylabs/core/content` — the content pipeline as a standalone entry.
 *
 * Published as its own subpath so consumers that only parse or project content
 * (e.g. `parseMdxContent`, `mdxToMarkdown`) can import it without pulling the
 * search engine and embeddings graph into their bundles. Everything here is
 * also re-exported from the main barrel; the two entries share compiled chunks,
 * so mixing them never duplicates code.
 */
export { parseMdxContent, parseMdxTree } from './parse.js'
export { projectMdxAudience } from './audience.js'
export { markdownToPlainText } from './plain-text.js'
export { isSafeContentIdentifier } from './identifiers.js'
export type { ContentAudience } from './audience.js'
export {
  getContentDocument,
  loadContentDocument,
} from './document.js'
export {
  registerAsyncContentDocumentSource,
  registerContentDocumentSource,
} from './source-registry.js'
export type {
  ContentDocument,
} from './document.js'
export type {
  AsyncContentDocumentResolver,
  ContentDocumentResolver,
} from './source-registry.js'
export { mdxToMarkdown } from './to-markdown.js'
export type {
  ContentHeading,
  ContentTocItem,
  ContentCodeBlock,
  ContentLink,
  ContentSection,
  ContentUpdate,
  ParsedContent,
} from './types.js'
