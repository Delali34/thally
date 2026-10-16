/** Full-text indexing must not retain unused vector storage; hybrid remains separate. */
import { afterEach, describe, expect, it } from 'vitest'
import { registerAsyncContentDocumentSource } from '../content/source-registry.js'
import { registerAsyncDocEntriesSource } from '../doc-source.js'
import { getSearchEngine, resetSearchEngine, searchDocs } from './engine.js'

afterEach(resetSearchEngine)
function registerPages(count: number) {
  registerAsyncDocEntriesSource(async () => Array.from({ length: count }, (_, index) => ({
    id: `capacity-${index}`, title: `Page ${index}`, description: '', keywords: [], href: `/capacity-${index}`,
  })))
  registerAsyncContentDocumentSource(async (id) => ({
    pageId: id, frontmatter: {}, rawBody: '',
    content: { text: id === 'capacity-7123' ? 'uniquecapacityneedle' : 'Ordinary page', markdown: '', headings: [], codeBlocks: [], links: [], toc: [] },
  }))
  resetSearchEngine()
}

describe('full-text capacity', () => {
  it('indexes and searches 10,000 actual records with no vector schema or stored vectors', async () => {
    registerPages(10_000)
    const engine = await getSearchEngine(undefined, false)
    // Inspect the real Orama storage, not a mocked allocation count. Removing
    // zero values alone is insufficient if its vector schema still allocates.
    const data = engine.db.data as unknown as {
      index: { vectorIndexes: Record<string, unknown> }
      docs: { docs: Record<string, Record<string, unknown>> }
    }
    expect(data.index.vectorIndexes).toEqual({})
    const documents = Object.values(data.docs.docs)
    expect(documents).toHaveLength(10_000)
    expect(documents.every((document) => !('embedding' in document))).toBe(true)
    const hits = await searchDocs('uniquecapacityneedle', { mode: 'fulltext', limit: 1 })
    expect(hits[0]).toMatchObject({ pageId: 'capacity-7123', href: '/capacity-7123' })
  })

  it('preserves the hybrid vector schema independently of the full-text cache', async () => {
    registerPages(2)
    const fulltext = await getSearchEngine(undefined, false)
    const hybrid = await getSearchEngine(undefined, true)
    expect(hybrid).not.toBe(fulltext)
    expect(hybrid.db.data.index.vectorIndexes).toHaveProperty('embedding')
    expect(fulltext.db.data.index.vectorIndexes).not.toHaveProperty('embedding')
    expect((await searchDocs('Ordinary', { mode: 'hybrid', limit: 1 }))[0]).toHaveProperty('pageId')
  })
})
