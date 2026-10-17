/** Failed asynchronous index builds retry without evicting newer generations. */
import { afterEach, describe, expect, it } from 'vitest'
import { registerAsyncContentDocumentSource } from '../content/source-registry.js'
import { registerAsyncDocEntriesSource } from '../doc-source.js'
import { getSearchEngine, resetSearchEngine, searchDocs } from './engine.js'

afterEach(resetSearchEngine)
const entries = [{ id: 'recovered', title: 'Recovery', description: '', keywords: [], href: '/recovered' }]
const document = {
  pageId: 'recovered', frontmatter: {}, rawBody: 'recoveryneedle',
  content: { text: 'recoveryneedle', markdown: '', headings: [], codeBlocks: [], links: [], toc: [], sections: [] },
}

describe('search build recovery', () => {
  it('shares an in-flight build, rejects unavailable content and retries both caches', async () => {
    let unavailable = true
    let reads = 0
    registerAsyncDocEntriesSource(async () => entries)
    registerAsyncContentDocumentSource(async () => {
      reads += 1
      if (unavailable) throw new Error('Temporary asset failure')
      return document
    })
    const first = getSearchEngine(undefined, false)
    expect(getSearchEngine(undefined, false)).toBe(first)
    await expect(first).rejects.toThrow('Temporary asset failure')
    unavailable = false
    expect((await searchDocs('recoveryneedle', { mode: 'fulltext' }))[0]?.pageId).toBe('recovered')
    expect(reads).toBe(2)
  })

  it('does not let a stale rejected build delete the replacement corpus or engine', async () => {
    let rejectOld!: (reason: Error) => void
    const oldEntries = new Promise<typeof entries>((_resolve, reject) => { rejectOld = reject })
    let first = true
    registerAsyncDocEntriesSource(() => {
      if (!first) return Promise.resolve(entries)
      first = false
      return oldEntries
    })
    registerAsyncContentDocumentSource(async () => document)
    const old = getSearchEngine(undefined, false)
    const rejected = expect(old).rejects.toThrow('Stale failure')
    resetSearchEngine()
    const replacement = getSearchEngine(undefined, false)
    await replacement
    rejectOld(new Error('Stale failure'))
    await rejected
    expect(getSearchEngine(undefined, false)).toBe(replacement)
    expect((await searchDocs('recoveryneedle', { mode: 'fulltext' }))[0]?.pageId).toBe('recovered')
  })
})
