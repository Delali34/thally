# @thallylabs/core

The framework-agnostic content engine behind the open-source
[Thally](https://thally.io) docs platform. It turns one directory of MDX into
structured, queryable product knowledge for people, search engines, and AI
tools through content parsing, search, embeddings, and brand-token utilities.

It has no dependency on Next.js, React, or any particular host — the host
provides its list of pages through a small resolver seam, and core does the
rest. Thally's own site is one host; you can build another.

## Install

```bash
npm install @thallylabs/core
```

## What's inside

| Export | Purpose |
| --- | --- |
| `@thallylabs/core` | Everything below in one barrel: content parsing, search (`searchDocs`, `buildSearchCorpus`), and embeddings (`buildEmbeddingIndex`, `getRelevantChunks`). |
| `@thallylabs/core/content` | Just the content pipeline (`parseMdxContent`, `getContentDocument`, `mdxToMarkdown`, `ContentDocument`) — for consumers that transform content and don't need search or embeddings. |
| `@thallylabs/core/search` | Search and canonical `projectSearchContent` text; hosts may register an optional `registerAsyncSearchContentSource` to reuse verified build-prepared text. |
| `@thallylabs/core/theme` | Pure brand-token utilities (colors, CSS theme variables) — no Node or content dependencies, safe to import from client bundles. |

The package is side-effect free (`"sideEffects": false`), so bundlers
tree-shake unused exports even when you import from the barrel. Size-sensitive
consumers (edge workers, client bundles) should still prefer the subpath
entries — they keep unused modules out of the module graph entirely, which
also helps bundlers that can't prove the barrel's re-exports are unused.

## The one thing a host must wire up

Search and the embedding index need to enumerate the site's pages, but *how*
pages are enumerated is a host concern. Register a resolver once at startup,
before the first search or embedding build:

```ts
import { registerDocEntriesSource } from '@thallylabs/core'

registerDocEntriesSource(() => myPages) // each page: { id, title, description, href, keywords }
```

Content parsing (`getContentDocument`, `mdxToMarkdown`) is self-contained and
needs no registration.

A prepared search resolver supplies content fields only. The host must still
enumerate currently visible pages and supply their current metadata. Return
`undefined` when a prepared record is missing or stale to use the ordinary
canonical document parser; reject temporary service failures so a partial
corpus cannot become a successful cached index.

## License

MIT © Thally
