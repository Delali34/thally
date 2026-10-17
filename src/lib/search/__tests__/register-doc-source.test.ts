/** Search enumeration follows live locale selection and exposes only indexable translations. */

import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  asyncEntriesResolver: null as null | ((locale?: string) => Promise<Array<{ href: string }>>),
  supplementalResolver: null as null | ((locale?: string) => Promise<Array<{ id: string; type: string }>>),
  getIndexableDocTranslation: vi.fn(),
}))

vi.mock('@thallylabs/core/registry', () => ({
  registerAsyncDocEntriesSource: (resolver: typeof mocks.asyncEntriesResolver) => {
    mocks.asyncEntriesResolver = resolver
  },
  registerDocEntriesSource: vi.fn(),
  registerSupplementalSearchRecordsSource: (resolver: typeof mocks.supplementalResolver) => {
    mocks.supplementalResolver = resolver
  },
  registerAsyncContentDocumentSource: vi.fn(),
  registerAsyncSearchContentSource: vi.fn(),
  registerContentDocumentSource: vi.fn(),
}))
vi.mock('@/data/docs', () => ({
  // Translation-level reader access is covered in src/data/reader-access-locales.test.ts.
  canReaderViewPage: async () => true,
  getDocEntries: () => [],
  getCurrentVersionPageIds: () => new Set(['guide', 'draft']),
  loadDocEntries: async () => [
    { id: 'guide', slug: ['guide'], href: '/guide', title: 'Guide', description: 'Source', keywords: [] },
    { id: 'draft', slug: ['draft'], href: '/draft', title: 'Draft', description: 'Draft', keywords: [], noindex: true },
    { id: 'v1/guide', slug: ['v1', 'guide'], href: '/v1/guide', title: 'Old guide', description: 'Old', keywords: [] },
  ],
}))
vi.mock('@/data/api-reference', () => ({
  getApiOperationSearchIndex: async () => [{ id: 'default/users/get', type: 'api_operation' }],
}))
vi.mock('@/lib/i18n/translation-source', () => ({ getIndexableDocTranslation: mocks.getIndexableDocTranslation }))
vi.mock('@/lib/content/document', () => ({ getContentDocument: vi.fn(), loadContentDocument: vi.fn() }))
vi.mock('@/lib/i18n/request', () => ({
  getEffectiveI18nConfig: async () => ({
    defaultLocale: 'en',
    locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }],
  }),
}))

import '../register-doc-source'

describe('registered search doc entries', () => {
  it('enumerates a live-enabled locale and excludes noindex documents', async () => {
    mocks.getIndexableDocTranslation.mockResolvedValue({ title: 'Guide français' })

    expect(await mocks.asyncEntriesResolver?.('fr')).toEqual([{
      id: 'guide',
      href: '/fr/guide',
      title: 'Guide français',
      description: 'Source',
      keywords: [],
    }])
    expect(mocks.getIndexableDocTranslation).toHaveBeenCalledTimes(1)
  })

  it('leaves hidden-version pages out of the default search corpus', async () => {
    const ids = (await mocks.asyncEntriesResolver?.())?.map((entry) => (entry as { id?: string }).id)
    expect(ids).toEqual(['guide'])
  })

  it('adds API operations to the default-locale corpus only', async () => {
    expect(await mocks.supplementalResolver?.()).toEqual([{ id: 'default/users/get', type: 'api_operation' }])
    expect(await mocks.supplementalResolver?.('en')).toHaveLength(1)
    expect(await mocks.supplementalResolver?.('fr')).toEqual([])
  })
})
