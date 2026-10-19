/** Managed document caching must bound retained trees without changing the load contract. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDocFromParams } from './get-doc'
import { interpretMDX } from '@/lib/mdx-interpret'

const state = vi.hoisted(() => ({ missing: new Set<string>() }))
vi.mock('@/data/docs', () => ({ deriveTitleFromSlug: (slug: string) => slug, getI18nConfig: () => ({ defaultLocale: 'en' }) }))
vi.mock('next-mdx-remote/rsc', () => ({ compileMDX: vi.fn() }))
vi.mock('@/lib/mdx-interpret', () => ({ interpretMDX: vi.fn() }))
vi.mock('@/mdx/remark', () => ({ remarkPlugins: [] }))
vi.mock('@/mdx/rehype', () => ({ rehypePlugins: [] }))
vi.mock('@/components/mdx/mdx-components', () => ({ useMDXComponents: () => ({}) }))
vi.mock('@/mdx/snippet-registry', () => ({ resolveSnippetComponent: vi.fn() }))
vi.mock('@/lib/runtime-sources', () => ({ runtimeSourceExists: () => false, readRuntimeSource: () => '' }))
vi.mock('@/generated/runtime-docs', () => ({ runtimeDocs: {} }))
vi.mock('@/lib/content-source', () => ({ getContentSource: () => ({
  kind: 'assets',
  exists: async (path: string) => !state.missing.has(path),
  read: async (path: string) => state.missing.has(path) ? null : ({ content: `# ${path}`, modifiedAtMs: 1 }),
}) }))
afterEach(() => { vi.unstubAllEnvs(); state.missing.clear() })

function interpreted(text = 'Exact {code} <bytes>') {
  return { content: createElement('pre', {}, text), frontmatter: { title: 'Preserved title' } }
}

describe('bounded managed rendered documents', () => {
  it('preserves operation description placement when managed content is interpreted', async () => {
    vi.mocked(interpretMDX).mockResolvedValue({ content: null, frontmatter: { title: 'Create a key', description: 'Short metadata summary.', descriptionPlacement: 'operation' } })
    expect(await getDocFromParams(['managed-endpoint-summary'])).toMatchObject({ description: 'Short metadata summary.', descriptionPlacement: 'operation' })
  })
  it('coalesces concurrent compilation and evicts old rendered entries after the entry budget', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.mocked(interpretMDX).mockReset().mockResolvedValue(interpreted())
    const [first, concurrent] = await Promise.all([getDocFromParams(['cache-count-0']), getDocFromParams(['cache-count-0'])])
    expect(concurrent).toBe(first)
    expect(interpretMDX).toHaveBeenCalledTimes(1)
    for (let i = 1; i <= 64; i++) await getDocFromParams([`cache-count-${i}`])
    const recent = await getDocFromParams(['cache-count-64'])
    expect(await getDocFromParams(['cache-count-64'])).toBe(recent)
    const reloaded = await getDocFromParams(['cache-count-0'])
    expect(reloaded).not.toBe(first)
    expect(interpretMDX).toHaveBeenCalledTimes(66)
    expect(renderToStaticMarkup(createElement(reloaded!.component))).toBe(renderToStaticMarkup(createElement(first!.component)))
    expect(reloaded).toMatchObject({ id: 'cache-count-0', title: 'Preserved title', access: first!.access })
  })

  it('charges the hidden rendered tree rather than only its small component closure', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const text = 'a'.repeat(2_200_000)
    vi.mocked(interpretMDX).mockReset().mockResolvedValue(interpreted(text))
    const first = await getDocFromParams(['cache-byte-one'])
    await getDocFromParams(['cache-byte-two'])
    const reloaded = await getDocFromParams(['cache-byte-one'])
    expect(reloaded).not.toBe(first)
    expect(interpretMDX).toHaveBeenCalledTimes(3)
    expect(renderToStaticMarkup(createElement(reloaded!.component))).toContain(text)
    vi.mocked(interpretMDX).mockResolvedValue(interpreted(text.repeat(2)))
    const large = await getDocFromParams(['cache-oversized'])
    expect(await getDocFromParams(['cache-oversized'])).not.toBe(large)
    expect(interpretMDX).toHaveBeenCalledTimes(5)
  })

  it('retries a rejected compilation and a formerly missing route', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.mocked(interpretMDX).mockReset().mockRejectedValueOnce(new Error('temporary compile failure')).mockResolvedValue(interpreted())
    await expect(getDocFromParams(['cache-retry'])).rejects.toThrow('temporary compile failure')
    expect(await getDocFromParams(['cache-retry'])).not.toBeNull()
    state.missing.add('src/content/cache-missing.mdx')
    state.missing.add('src/content/cache-missing/index.mdx')
    expect(await getDocFromParams(['cache-missing'])).toBeNull()
    state.missing.clear()
    expect(await getDocFromParams(['cache-missing'])).not.toBeNull()
    expect(interpretMDX).toHaveBeenCalledTimes(3)
  })
})
