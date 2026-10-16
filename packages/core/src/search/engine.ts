/** Full-text and hybrid search over local or asynchronously resolved content. */

import { create, insertMultiple, search } from '@orama/orama'
import type { AnyOrama, Tokenizer } from '@orama/orama'
import { buildSearchCorpusAsync, resetSearchCorpora } from './corpus.js'
import { resetSectionCorpora } from './sections.js'
import type { SearchRecord, SearchRecordSection } from './corpus.js'
import type { SearchRecordType } from './supplemental.js'
import { getEmbeddingIndex } from '../embeddings/index-store.js'
import { getEmbeddingProvider, STOPWORDS } from '../embeddings/provider.js'
import { QUERY_STOPWORDS } from '../embeddings/lexical.js'
import type { EmbeddingVector } from '../embeddings/types.js'

export type SearchMode = 'fulltext' | 'hybrid'

export interface SearchHit {
  /** Page id, or the supplemental record id (an API operation's slug path). */
  pageId: string
  type: SearchRecordType
  title: string
  description: string
  href: string
  score: number
  snippet: string
  /** Heading id of the best-matching section, when the match sits under a heading. */
  anchor?: string
  /** Text of that heading. */
  heading?: string
  /** HTTP method and path template, for API operations. */
  method?: string
  path?: string
}

interface IndexedRecord extends SearchRecord {
  embedding?: EmbeddingVector
}

interface SearchEngine {
  db: AnyOrama
  dimensions: number
}

function meanPool(vectors: Array<EmbeddingVector>, dimensions: number): EmbeddingVector {
  const acc = new Array<number>(dimensions).fill(0)
  for (const vector of vectors) {
    for (let i = 0; i < dimensions && i < vector.length; i += 1) acc[i] += vector[i]
  }
  let sumSquares = 0
  for (let i = 0; i < dimensions; i += 1) {
    acc[i] /= vectors.length
    sumSquares += acc[i] * acc[i]
  }
  if (sumSquares === 0) return acc
  const norm = Math.sqrt(sumSquares)
  return acc.map((value) => value / norm)
}

async function pageEmbeddings(records: Array<SearchRecord>, dimensions: number, locale?: string): Promise<Map<string, EmbeddingVector>> {
  const map = new Map<string, EmbeddingVector>()
  if (!locale) {
    try {
      // The persisted index describes the source language only. Translated
      // prose needs its own vectors when hybrid search is requested.
      const index = await getEmbeddingIndex()
      const byPage = new Map<string, Array<EmbeddingVector>>()
      for (const chunk of index.chunks) {
        const list = byPage.get(chunk.pageId) ?? []
        list.push(chunk.embedding)
        byPage.set(chunk.pageId, list)
      }
      for (const [pageId, vectors] of byPage) {
        if (vectors.length) map.set(pageId, meanPool(vectors, dimensions))
      }
    } catch {
      // Fall through to on-the-fly embedding below.
    }
  }

  // Supplemental records (API operations) are never embedded here: with a
  // hosted provider that would be a billed call per operation on every cold
  // start (and can exceed the provider's batch size on large specs). They keep
  // a zero vector and rank on their text (title, path, parameter names).
  const missing = records.filter((record) => !map.has(record.pageId) && (record.type ?? 'page') === 'page')
  if (missing.length) {
    const provider = getEmbeddingProvider()
    const vectors = await provider.embed(
      missing.map((record) => `${record.title}\n${record.description}\n${record.body}`),
    )
    missing.forEach((record, i) => map.set(record.pageId, vectors[i]))
  }
  return map
}

const enginePromises = new Map<string, Promise<SearchEngine>>()

/** ICU word boundaries cover scripts that Orama's English splitter drops. */
function createLocaleTokenizer(locale?: string): Tokenizer {
  const language = locale ?? 'en'
  const segmenter = new Intl.Segmenter(language, { granularity: 'word' })
  return {
    language,
    normalizationCache: new Map(),
    tokenize: (raw) => Array.from(new Set(
      Array.from(segmenter.segment(raw))
        .filter((part) => part.isWordLike)
        .map((part) => part.segment.normalize('NFKC').toLocaleLowerCase(language)),
    )),
  }
}

async function buildEngine(locale?: string, includeEmbeddings = true): Promise<SearchEngine> {
  const provider = getEmbeddingProvider()
  const dimensions = provider.dimensions
  const records = await buildSearchCorpusAsync(locale)
  const embeddings = includeEmbeddings
    ? await pageEmbeddings(records, dimensions, locale)
    : new Map<string, EmbeddingVector>()

  const db = create({
    components: { tokenizer: createLocaleTokenizer(locale) },
    schema: {
      pageId: 'string',
      title: 'string',
      description: 'string',
      headings: 'string',
      body: 'string',
      keywords: 'string',
      href: 'string',
      type: 'string',
      // Full-text ranking never uses vectors. Even zero vectors retain
      // dimensions × pages backing stores, exceeding Worker memory at scale.
      ...(includeEmbeddings ? { embedding: `vector[${dimensions}]` as const } : {}),
    },
  }) as AnyOrama

  // Fields outside the schema (sections, method, path) ride along in Orama's
  // document store unindexed, so hits can carry them back.
  const indexed: Array<IndexedRecord> = records.map((record) => ({
    ...record,
    type: record.type ?? 'page',
    ...(includeEmbeddings ? { embedding: embeddings.get(record.pageId) ?? new Array<number>(dimensions).fill(0) } : {}),
  }))

  await insertMultiple(db, indexed as never)
  return { db, dimensions }
}

export function getSearchEngine(locale?: string, includeEmbeddings = true): Promise<SearchEngine> {
  const key = `${locale ?? ''}:${includeEmbeddings ? 'hybrid' : 'fulltext'}`
  const cached = enginePromises.get(key)
  if (cached) return cached
  const pending = buildEngine(locale, includeEmbeddings)
  enginePromises.set(key, pending)
  return pending
}

export function resetSearchEngine() {
  enginePromises.clear()
  resetSearchCorpora()
  resetSectionCorpora()
}

/** Lowercased query words with surrounding punctuation removed ("navigation?" → "navigation"). */
function queryTerms(query: string): Array<string> {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((term) => term.length >= 2)
}

function buildSnippet(body: string, terms: Array<string>): string {
  if (!body) return ''
  const lower = body.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found !== -1) {
      at = found
      break
    }
  }
  if (at === -1) return `${body.slice(0, 160).trim()}${body.length > 160 ? '…' : ''}`
  const start = Math.max(0, at - 60)
  const end = Math.min(body.length, at + 120)
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`
}

/**
 * The section that best explains a page hit: the most query-term occurrences,
 * with a heading match counting extra. Ranking stays page-level; this only
 * picks where to point the reader and what to quote.
 */
function bestSection(sections: Array<SearchRecordSection> | undefined, terms: Array<string>): SearchRecordSection | null {
  if (!sections?.length || terms.length === 0) return null
  let best: SearchRecordSection | null = null
  let bestScore = 0
  for (const section of sections) {
    const title = section.title.toLowerCase()
    const text = section.text.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (title.includes(term)) score += 3
      let from = text.indexOf(term)
      while (from !== -1 && score < 50) {
        score += 1
        from = text.indexOf(term, from + term.length)
      }
    }
    if (score > bestScore) {
      best = section
      bestScore = score
    }
  }
  return best
}

/**
 * The words of a query that carry meaning for full-text ranking. Orama scores
 * every term, so a question ("How do I add a page to the sidebar
 * navigation?") was ranked mostly on "how", "do", "a", "to" and "the" — words
 * on every page — and the page about sidebar navigation fell out of the top
 * five. Dropping the same function words the retrieval ranker drops fixes
 * that. When nothing survives (a query of only stopwords), the raw query is
 * kept so the search still returns something.
 */
export function fullTextQuery(query: string): string {
  // Filter whole whitespace-separated words and pass survivors through
  // verbatim: Orama tokenized the index with its own ICU tokenizer, which
  // keeps identifiers such as `THALLY_EMBEDDING_PROVIDER` or `foo.bar` whole,
  // so re-tokenizing them here would stop them matching.
  const meaningful = query.split(/\s+/).filter((word) => {
    const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()
    return bare.length > 0 && !STOPWORDS.has(bare) && !QUERY_STOPWORDS.has(bare)
  })
  return meaningful.length ? meaningful.join(' ') : query
}

export async function searchDocs(
  query: string,
  options: { limit?: number; mode?: SearchMode; locale?: string } = {},
): Promise<Array<SearchHit>> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const limit = options.limit ?? 8
  const mode = options.mode ?? 'hybrid'
  const engine = await getSearchEngine(options.locale, mode === 'hybrid')

  const searchParams: Record<string, unknown> = {
    term: fullTextQuery(trimmed),
    properties: ['title', 'description', 'headings', 'body', 'keywords'],
    boost: { title: 3, headings: 2, description: 1.5, keywords: 1.5 },
    tolerance: 1,
    limit,
  }

  if (mode === 'hybrid') {
    const provider = getEmbeddingProvider()
    const [queryEmbedding] = await provider.embed([trimmed])
    searchParams.mode = 'hybrid'
    searchParams.vector = { value: queryEmbedding, property: 'embedding' }
    searchParams.similarity = 0.2
  } else {
    searchParams.mode = 'fulltext'
  }

  const results = await search(engine.db, searchParams as never)

  const terms = queryTerms(fullTextQuery(trimmed))
  return results.hits.map((hit): SearchHit => {
    const doc = hit.document as unknown as SearchRecord
    const section = bestSection(doc.sections, terms)
    return {
      pageId: doc.pageId,
      type: doc.type ?? 'page',
      title: doc.title,
      description: doc.description,
      href: doc.href,
      score: hit.score,
      snippet: buildSnippet(section?.text || doc.body || doc.description, terms),
      ...(section?.id ? { anchor: section.id, heading: section.title } : {}),
      ...(doc.method ? { method: doc.method } : {}),
      ...(doc.path ? { path: doc.path } : {}),
    }
  })
}
