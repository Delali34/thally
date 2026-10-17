/**
 * ContentSource — one abstraction over where customer-authored content lives.
 *
 * The engine reads MDX pages, snippets, and content-adjacent config through
 * this interface so the same rendering pipeline works whether content is
 * embedded in the build (OSS/self-host default) or served from the deployed
 * Worker's own static assets (managed hosting, where a content publish swaps
 * assets without rebuilding the Worker).
 *
 * This is deliberately NOT a cloud-bridge service: the bridge carries paid
 * data-plane features (Track, AI answers, analytics), while content sourcing
 * is a runtime concern selected by environment. Nothing here imports
 * `src/cloud`.
 *
 * All paths are project-relative POSIX paths — the same keys used by
 * `@/lib/runtime-sources` (e.g. `src/content/introduction.mdx`,
 * `snippets/note.mdx`, `docs.json`).
 */

import type { SearchContentProjection } from '@thallylabs/core/search'

export type ContentSourceKind = 'filesystem' | 'assets'

export interface ContentSourceFile {
  content: string
  /**
   * Build- or publish-observed modification time. Used only for relative
   * comparisons (translation staleness), never as a wall-clock timestamp.
   */
  modifiedAtMs: number
}

export interface ContentSource {
  kind: ContentSourceKind
  /** Whether a content file exists at this project-relative path. */
  exists(projectPath: string): Promise<boolean>
  /** Read one file, null when absent; transient service failures may reject. */
  read(projectPath: string): Promise<ContentSourceFile | null>
  /** Modification time for staleness comparisons; 0 when unknown/missing. */
  modifiedAt(projectPath: string): Promise<number>
  /** List file paths below a project-relative directory prefix. */
  list(prefix: string): Promise<Array<string>>
  /** Optional verified canonical search text; undefined uses the ordinary document parser. */
  searchContent?(projectPath: string): Promise<SearchContentProjection | undefined>
}
