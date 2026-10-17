/** The query-only memory profile must never weaken the public raw engine.
 * Exercise actual Orama filters/sort/ranking and cache generations; the create
 * observer records real storage, rather than substituting a mock search engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnyOrama } from '@orama/orama'

const observed = vi.hoisted(() => ({ engines: [] as Array<{ db: unknown; schema: unknown; sort: unknown }> }))
vi.mock('@orama/orama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orama/orama')>()
  return {
    ...actual,
    create(...args: Parameters<typeof actual.create>) {
      const db = actual.create(...args)
      observed.engines.push({ db, schema: args[0].schema, sort: args[0].sort })
      return db
    },
  }
})

import { search } from '@orama/orama'
import { registerAsyncContentDocumentSource } from '../content/source-registry.js'
import { parseMdxContent } from '../content/parse.js'
import { registerAsyncDocEntriesSource } from '../doc-source.js'
import { buildSearchCorpusAsync } from './corpus.js'
import { fullTextQuery, getSearchEngine, resetSearchEngine, searchDocs } from './engine.js'
import { registerAsyncSearchContentSource } from './projection.js'
import { registerSupplementalSearchRecordsSource } from './supplemental.js'

const entries = [
  { id: 'alpha', title: 'Key rotation', description: 'Rotate credentials', href: '/guide/alpha', keywords: ['rotation'] },
  { id: 'beta', title: 'Operations', description: 'Rotation workflow', href: '/guide/beta', keywords: [] },
]
const document = (id: string, text = '## Rotation procedure\n\nRotation keeps credentials safe. Rotate keys monthly.') => ({
  pageId: id, frontmatter: {}, rawBody: text, content: parseMdxContent(text, 'agents'),
})
function registerFixture() {
  registerAsyncDocEntriesSource(async () => entries)
  registerAsyncContentDocumentSource(async (id) => document(id, id === 'alpha'
    ? undefined : 'Rotation is part of maintenance.'))
  registerSupplementalSearchRecordsSource(async () => [{
    id: 'api-rotate', type: 'api_operation', title: 'Rotate key', description: 'Key rotation endpoint',
    href: '/api/keys', keywords: ['rotation'], method: 'POST', path: '/keys/rotate',
  }])
}
const fulltextParameters = {
  term: fullTextQuery('rotation'), mode: 'fulltext',
  properties: ['title', 'description', 'headings', 'body', 'keywords'],
  boost: { title: 3, headings: 2, description: 1.5, keywords: 1.5 }, tolerance: 1, limit: 8,
}
const ranked = async (db: AnyOrama) => (await search(db, fulltextParameters as never)).hits.map(hit => ({
  pageId: (hit.document as unknown as { pageId: string }).pageId, score: hit.score,
}))

beforeEach(() => {
  resetSearchEngine()
  observed.engines = []
  registerAsyncSearchContentSource(async () => undefined)
  registerSupplementalSearchRecordsSource(async () => [])
})
afterEach(() => { resetSearchEngine(); registerSupplementalSearchRecordsSource(async () => []) })

describe('internal full-text query profile', () => {
  it('retains raw metadata filters and sorting before and after an internal query', async () => {
    registerFixture()
    const pending = getSearchEngine(undefined, false)
    const raw = await pending
    const rawQueries = async () => {
      const filtered = async (where: unknown) => (await search(raw.db, { term: '', where, limit: 8 } as never)).hits.map(hit => (hit.document as unknown as { pageId: string }).pageId)
      expect(await filtered({ pageId: 'alpha' })).toEqual(['alpha'])
      expect(await filtered({ href: '/api/keys' })).toEqual(['api-rotate'])
      expect(await filtered({ type: 'api_operation' })).toEqual(['api-rotate'])
      const sorted = await search(raw.db, { term: '', where: { type: 'page' }, sortBy: { property: 'pageId', order: 'DESC' } } as never)
      expect(sorted.hits.map(hit => (hit.document as unknown as { pageId: string }).pageId)).toEqual(['beta', 'alpha'])
      const urls = await search(raw.db, { term: '', sortBy: { property: 'href', order: 'ASC' } } as never)
      expect(urls.hits.map(hit => (hit.document as unknown as { href: string }).href)).toEqual(['/api/keys', '/guide/alpha', '/guide/beta'])
    }
    await rawQueries()
    await searchDocs('rotation', { mode: 'fulltext' })
    expect(getSearchEngine(undefined, false)).toBe(pending)
    await rawQueries()
    const query = observed.engines.find(engine => engine.db !== raw.db)!
    expect(Object.keys(query.schema as object).sort()).toEqual(['body', 'description', 'headings', 'keywords', 'title'])
    expect(query.sort).toEqual({ enabled: false })
    expect((query.db as AnyOrama).data.sorting).toEqual({ disabled: true })
    expect((query.db as AnyOrama).data.index.vectorIndexes).toEqual({})
    expect(observed.engines[0].sort).toBeUndefined()
    expect(Object.keys(raw.db.schema)).toEqual(['pageId', 'title', 'description', 'headings', 'body', 'keywords', 'href', 'type'])
  })

  it('preserves exact full-text ranking and hit metadata across both raw modes', async () => {
    registerFixture()
    const rawText = await getSearchEngine(undefined, false)
    const hybridPending = getSearchEngine()
    expect(getSearchEngine(undefined, true)).toBe(hybridPending)
    const rawHybrid = await hybridPending
    const expected = await ranked(rawText.db)
    expect(await ranked(rawHybrid.db)).toEqual(expected)
    const hits = await searchDocs('rotation', { mode: 'fulltext' })
    expect(hits.map(({ pageId, score }) => ({ pageId, score }))).toEqual(expected)
    expect(hits.find(hit => hit.pageId === 'alpha')).toMatchObject({
      title: 'Key rotation', description: 'Rotate credentials', href: '/guide/alpha', type: 'page',
      anchor: 'rotation-procedure', heading: 'Rotation procedure', snippet: 'Rotation keeps credentials safe. Rotate keys monthly.',
    })
    expect(hits.find(hit => hit.pageId === 'api-rotate')).toMatchObject({
      type: 'api_operation', method: 'POST', path: '/keys/rotate', href: '/api/keys',
      title: 'Rotate key', description: 'Key rotation endpoint', snippet: 'Key rotation endpoint',
    })
    const count = observed.engines.length
    await searchDocs('rotation', { mode: 'hybrid' })
    expect(observed.engines).toHaveLength(count)
    expect(rawHybrid.db.data.index.vectorIndexes).toHaveProperty('embedding')
    expect(rawText.db.data.index.vectorIndexes).not.toHaveProperty('embedding')
  })

  it('singleflights concurrent internal/raw builds over one shared corpus', async () => {
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    let listings = 0
    registerAsyncDocEntriesSource(async () => { listings += 1; await ready; return entries })
    registerAsyncContentDocumentSource(async id => document(id))
    const first = searchDocs('rotation', { mode: 'fulltext' })
    const second = searchDocs('rotation', { mode: 'fulltext' })
    const raw = getSearchEngine(undefined, false)
    release()
    expect(await second).toEqual(await first)
    await raw
    expect(listings).toBe(1)
    expect(observed.engines).toHaveLength(2)
  })

  it('retries a failed internal build and fences stale failures after reset across profiles', async () => {
    let rejectOld!: (reason: Error) => void
    const oldListing = new Promise<typeof entries>((_resolve, reject) => { rejectOld = reject })
    let old = true
    registerAsyncDocEntriesSource(() => old ? oldListing : Promise.resolve(entries))
    registerAsyncContentDocumentSource(async id => document(id))
    const staleQuery = expect(searchDocs('rotation', { mode: 'fulltext' })).rejects.toThrow('Old listing failed')
    const staleRaw = expect(getSearchEngine(undefined, false)).rejects.toThrow('Old listing failed')
    resetSearchEngine()
    old = false
    const currentRaw = getSearchEngine(undefined, false)
    const currentHits = await searchDocs('rotation', { mode: 'fulltext' })
    await currentRaw
    rejectOld(new Error('Old listing failed'))
    await Promise.all([staleQuery, staleRaw])
    expect(getSearchEngine(undefined, false)).toBe(currentRaw)
    const count = observed.engines.length
    expect(await searchDocs('rotation', { mode: 'fulltext' })).toEqual(currentHits)
    expect(observed.engines).toHaveLength(count)

    resetSearchEngine()
    let unavailable = true
    registerAsyncDocEntriesSource(async () => { if (unavailable) throw new Error('Retryable listing'); return entries })
    await expect(searchDocs('rotation', { mode: 'fulltext' })).rejects.toThrow('Retryable listing')
    unavailable = false
    expect((await searchDocs('rotation', { mode: 'fulltext' })).map(hit => hit.pageId)).toEqual(currentHits.map(hit => hit.pageId))
  })

  it('keeps locale profiles separate while preserving the same current corpus projection', async () => {
    registerAsyncDocEntriesSource(async locale => locale === 'fr'
      ? [{ id: 'alpha', title: 'Rotation française', description: '', href: '/fr/alpha', keywords: [] }]
      : entries)
    registerAsyncContentDocumentSource(async id => document(id))
    const frenchRaw = await getSearchEngine('fr', false)
    const french = await searchDocs('rotation', { mode: 'fulltext', locale: 'fr' })
    expect(french.map(hit => hit.href)).toEqual(['/fr/alpha'])
    expect(french.map(({ pageId, score }) => ({ pageId, score }))).toEqual(await ranked(frenchRaw.db))
    expect((await searchDocs('rotation', { mode: 'fulltext' })).map(hit => hit.href)).not.toContain('/fr/alpha')
    expect((await buildSearchCorpusAsync('fr')).map(record => record.href)).toEqual(['/fr/alpha'])
    expect(observed.engines).toHaveLength(3)
  })
})
