/** Prepared lookup shares physical-file precedence; a missing optimization never selects stale fallback text. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getContentSource } from '@/lib/content-source'
import { loadPreparedSearchContent } from '@/lib/search/prepared-content'
vi.mock('@/lib/content-source', () => ({ getContentSource: vi.fn() }))
afterEach(() => vi.resetAllMocks())

describe('prepared search physical source selection', () => {
  it.each([
    ['src/content/fr/guide.mdx', ['src/content/fr/guide.mdx']],
    ['src/content/fr/guide/index.mdx', ['src/content/fr/guide.mdx', 'src/content/fr/guide/index.mdx']],
    ['src/content/guide.mdx', ['src/content/fr/guide.mdx', 'src/content/fr/guide/index.mdx', 'src/content/guide.mdx']],
  ])('uses the first existing candidate %s', async (physical, candidates) => {
    const projection = { headings: '', body: 'current', sections: [] }
    const exists = vi.fn(async (file) => file === physical)
    const searchContent = vi.fn(async () => projection)
    vi.mocked(getContentSource).mockReturnValue({ kind: 'assets', exists, searchContent } as unknown as ReturnType<typeof getContentSource>)
    expect(await loadPreparedSearchContent('guide', 'fr')).toBe(projection)
    expect(exists.mock.calls.map(([file]) => file)).toEqual(candidates)
    expect(searchContent).toHaveBeenCalledExactlyOnceWith(physical)
  })

  it('falls back to canonical parsing of the existing translation when its prepared SHA is missing', async () => {
    const searchContent = vi.fn(async () => undefined)
    vi.mocked(getContentSource).mockReturnValue({ kind: 'assets', exists: async () => true, searchContent } as unknown as ReturnType<typeof getContentSource>)
    expect(await loadPreparedSearchContent('guide', 'fr')).toBeUndefined()
    expect(searchContent).toHaveBeenCalledExactlyOnceWith('src/content/fr/guide.mdx')
    expect(await loadPreparedSearchContent('../escape', 'fr')).toBeUndefined()
    expect(searchContent).toHaveBeenCalledTimes(1)
  })
})
