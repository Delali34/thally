/** The corpus preserves its bytes/privacy while demand and cancellation bound document reads. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { AsyncLocalStorage } from 'node:async_hooks'

const state = vi.hoisted(() => ({ count: 2, canSeePrivate: false, reads: vi.fn(), reader: { userId: 'reader' } }))
const entry = (id: string) => ({ id, title: id.toUpperCase(), description: `${id} description`, href: `/${id}` })
vi.mock('@/data/docs', () => ({
  loadDocEntries: async () => [entry('alpha'), entry('beta'), entry('private')],
  loadSidebarCollections: async () => [{ sections: [{ items: [{ href: '/beta' }, { href: '/private' }, { href: '/alpha' }] }] }],
}))
vi.mock('@/lib/content', () => ({ loadContentDocument: (...args: unknown[]) => state.reads(...args) }))
vi.mock('@/lib/i18n/request', () => ({ getEffectiveI18nConfig: async () => ({ defaultLocale: 'en', locales: [{ code: 'en' }] }) }))
vi.mock('@/lib/mcp/site-tools', () => ({
  listAgentPages: async (_locale: unknown, reader: unknown) => {
    expect(reader).toBe(state.reader)
    return state.count === 2
      ? [entry('alpha'), entry('beta'), ...(state.canSeePrivate ? [entry('private')] : [])]
      : Array.from({ length: state.count }, (_, i) => entry(`large-${i}`))
  },
  loadVisibleApiOperationNodes: async () => [],
}))
vi.mock('@/lib/site-config', () => ({ resolveRequestSiteConfig: async () => ({ name: 'Exact docs', description: 'Description' }) }))
vi.mock('@/lib/reader-auth/context', () => ({ getReaderContextFromRequest: async () => state.reader }))
vi.mock('@/lib/reader-auth/cache', () => ({ contentCacheControl: () => 'private, no-store' }))
import { GET } from './route'

const document = (id: string) => ({ content: { markdown: `Exact ${id} ✓\n\n\`\`\`sh\nprintf '{bytes}'\n\`\`\`` } })
const request = (signal?: AbortSignal) => new NextRequest('https://docs.test/llms-full.txt', { signal })
beforeEach(() => { state.count = 2; state.canSeePrivate = false; state.reads.mockReset().mockImplementation(async (id: string) => document(id)) })

describe('pull-driven corpus', () => {
  it('retains each response request scope when a host pulls outside GET or under another request', async () => {
    const requests = new AsyncLocalStorage<string>()
    const seen: Array<string | undefined> = []
    state.reads.mockImplementation(async (id: string) => {
      seen.push(requests.getStore())
      await Promise.resolve()
      seen.push(requests.getStore())
      return document(id)
    })
    const first = await requests.run('first', () => GET(request()))
    const second = await requests.run('second', () => GET(request()))
    await requests.run('unrelated consumer', () => Promise.all([first.text(), second.text()]))
    expect(seen).toHaveLength(8)
    expect(seen.filter((scope) => scope === 'first')).toHaveLength(4)
    expect(seen.filter((scope) => scope === 'second')).toHaveLength(4)
    expect(requests.getStore()).toBeUndefined()
  })

  it('preserves the exact buffered line sequence, Unicode, technical bytes, ordering and reader visibility', async () => {
    const response = await GET(request())
    const body = await response.text()
    // Authored expected bytes are independent of the stream implementation.
    const header = '# Exact docs — Complete Documentation\n\n> Description\n\nSource: https://docs.test\nLanguage: en\n\n## Instructions for agents\n\n- Use https://docs.test/llms.txt to inspect the page index before scanning this full corpus.\n- Use https://docs.test/skill.md for retrieval rules and https://docs.test/AGENTS.md before editing.\n- Use https://docs.test/api/mcp for read-only search, section retrieval, page, API and changelog tools.\n- Cite canonical page URLs, distinguish documented facts from inference, and state when the documentation does not support a claim.\n\n---\n'
    const beta = "\n# BETA\n\n> beta description\n\nURL: https://docs.test/beta\n\nExact beta ✓\n\n```sh\nprintf '{bytes}'\n```\n\n---\n"
    const alpha = "\n# ALPHA\n\n> alpha description\n\nURL: https://docs.test/alpha\n\nExact alpha ✓\n\n```sh\nprintf '{bytes}'\n```\n\n---\n"
    expect(new TextEncoder().encode(body)).toEqual(new TextEncoder().encode(header + beta + alpha))
    expect(state.reads.mock.calls.map(([id]) => id)).toEqual(['beta', 'alpha'])
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    state.canSeePrivate = true
    expect(await (await GET(request())).text()).toContain('Exact private ✓')
  })

  it('does not read ahead of demand and stops before another document after cancellation', async () => {
    const response = await GET(request())
    expect(state.reads).not.toHaveBeenCalled()
    const reader = response.body!.getReader()
    await reader.read() // Header only.
    expect(state.reads).not.toHaveBeenCalled()
    await reader.read()
    expect(state.reads.mock.calls.map(([id]) => id)).toEqual(['beta'])
    await reader.cancel()
    expect((await reader.read()).done).toBe(true)
    expect(state.reads).toHaveBeenCalledTimes(1)
  })

  it('cancels immediately during an in-flight read and discards its eventual result', async () => {
    let resolve!: (value: ReturnType<typeof document>) => void
    state.reads.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const reader = (await GET(request())).body!.getReader()
    await reader.read()
    const pending = reader.read()
    await vi.waitFor(() => expect(state.reads).toHaveBeenCalledTimes(1))
    await reader.cancel()
    expect((await pending).done).toBe(true)
    resolve(document('beta'))
    await Promise.resolve()
    expect(state.reads).toHaveBeenCalledTimes(1)
  })

  it('honors request abort without loading a page', async () => {
    const abort = new AbortController()
    const reader = (await GET(request(abort.signal))).body!.getReader()
    await reader.read()
    abort.abort()
    expect((await reader.read()).done).toBe(true)
    expect(state.reads).not.toHaveBeenCalled()
  })

  it('streams all 10,000 canonical projections sequentially', async () => {
    state.count = 10_000
    let active = 0; let maximum = 0
    state.reads.mockImplementation(async (id: string) => {
      maximum = Math.max(maximum, ++active)
      await Promise.resolve()
      active--
      return document(id)
    })
    const body = await (await GET(request())).text()
    expect(state.reads).toHaveBeenCalledTimes(10_000)
    expect(maximum).toBe(1)
    expect([...body.matchAll(/^URL: /gm)]).toHaveLength(10_000)
    expect(body).toContain('Exact large-9999 ✓')
  })
})
