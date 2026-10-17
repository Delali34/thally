/** Search indexes translated page text and destinations separately from source pages. */
import { describe, expect, it } from 'vitest'
import { registerAsyncContentDocumentSource } from '../content/source-registry.js'
import { registerAsyncDocEntriesSource } from '../doc-source.js'
import { resetSearchEngine, searchDocs } from './engine.js'

describe('localized search', () => {
  it('matches translated prose and returns the locale URL', async () => {
    registerAsyncDocEntriesSource(async (locale) => locale === 'fr'
      ? [{ id: 'guide', title: 'Guide français', description: 'Installer', keywords: [], href: '/fr/guide' }]
      : [])
    registerAsyncContentDocumentSource(async (_pageId, locale) => locale === 'fr'
      ? {
          pageId: 'guide',
          frontmatter: { title: 'Guide français' },
          rawBody: 'Bonjour documentation',
          content: {
            text: 'Bonjour documentation',
            headings: [],
            markdown: 'Bonjour documentation',
            codeBlocks: [],
            links: [],
            toc: [],
            sections: [],
          },
        }
      : null)
    resetSearchEngine()
    const hits = await searchDocs('bonjour', { mode: 'fulltext', locale: 'fr' })
    expect(hits[0]).toMatchObject({ title: 'Guide français', href: '/fr/guide' })
  })

  it.each([
    ['zh-Hans', '安装文档', '安装'],
    ['ja', 'インストールガイド', 'インストール'],
    ['ar', 'مرحبا الوثائق', 'مرحبا'],
  ])('finds %s text without Latin word boundaries', async (locale, body, query) => {
    registerAsyncDocEntriesSource(async (requested) => requested === locale
      ? [{ id: 'guide', title: body, description: '', keywords: [], href: `/${locale}/guide` }]
      : [])
    registerAsyncContentDocumentSource(async (_pageId, requested) => requested === locale
      ? {
          pageId: 'guide',
          frontmatter: { title: body },
          rawBody: body,
          content: { text: body, headings: [], markdown: body, codeBlocks: [], links: [], toc: [], sections: [] },
        }
      : null)
    resetSearchEngine()
    const hits = await searchDocs(query, { mode: 'fulltext', locale })
    expect(hits[0]).toMatchObject({ href: `/${locale}/guide` })
  })
})
