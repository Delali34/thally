/** Prepared text is an optimization of the same canonical corpus, never a listing source. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMdxContent } from '../markdown.js'
import { registerAsyncContentDocumentSource } from '../content/source-registry.js'
import { registerAsyncDocEntriesSource } from '../doc-source.js'
import { buildSearchCorpusAsync, resetSearchCorpora } from './corpus.js'
import { projectSearchContent, registerAsyncSearchContentSource } from './projection.js'

afterEach(() => { resetSearchCorpora(); registerAsyncSearchContentSource(async () => undefined) })

describe('prepared search projection', () => {
  it('is byte-identical to ordinary canonical search fields and skips the document read', async () => {
    const parsed = parseMdxContent('# Café\n\nPreamble.\n\n<Human>private-human</Human>\n\n## 用法\n\n' + 'needle '.repeat(1000), 'agents')
    const entry = { id: 'visible', href: '/fr/current', title: 'Current title', description: 'Current description', keywords: ['current'] }
    registerAsyncDocEntriesSource(async () => [entry])
    const read = vi.fn(async () => ({ pageId: entry.id, frontmatter: {}, rawBody: '', content: parsed }))
    registerAsyncContentDocumentSource(read)
    const ordinary = await buildSearchCorpusAsync('fr')
    resetSearchCorpora()
    const prepared = vi.fn(async () => projectSearchContent(parsed))
    registerAsyncSearchContentSource(prepared)
    expect(await buildSearchCorpusAsync('fr')).toEqual(ordinary)
    expect(read).toHaveBeenCalledTimes(1)
    expect(prepared).toHaveBeenCalledExactlyOnceWith('visible', 'fr')
    expect(ordinary[0].body).not.toContain('private-human')
    expect(ordinary[0].body).toHaveLength(4000)
    expect(ordinary[0].sections?.at(-1)?.text).toHaveLength(2000)
  })

  it('does not enumerate prepared-only pages and rejects/retries unavailable prepared data', async () => {
    registerAsyncDocEntriesSource(async () => [{ id: 'public', title: '', description: '', keywords: [], href: '/public' }])
    let unavailable = true
    const prepared = vi.fn(async (id: string) => {
      if (unavailable) throw new Error('Temporary shard outage')
      return { headings: '', body: id, sections: [] }
    })
    registerAsyncSearchContentSource(prepared)
    await expect(buildSearchCorpusAsync()).rejects.toThrow('Temporary shard outage')
    unavailable = false
    expect((await buildSearchCorpusAsync()).map((record) => record.id)).toEqual(['public'])
    expect(prepared.mock.calls).toEqual([['public', undefined], ['public', undefined]])
  })
})
