/**
 * Pure MDX parsing and Markdown projection entry for request-time consumers.
 *
 * This subpath deliberately excludes the filesystem-backed document reader.
 * Serverless bundlers can therefore import parsing helpers without tracing a
 * project checkout—or unrelated source files—into the deployed function.
 */

export { parseMdxContent, parseMdxTree } from './content/parse.js'
export { projectMdxAudience } from './content/audience.js'
export type { ContentAudience } from './content/audience.js'
export { mdxToMarkdown } from './content/to-markdown.js'
export type {
  ContentHeading,
  ContentTocItem,
  ContentCodeBlock,
  ContentLink,
  ContentSection,
  ContentUpdate,
  ParsedContent,
} from './content/types.js'
