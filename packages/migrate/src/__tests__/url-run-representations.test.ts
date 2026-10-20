/** Declared alternates preserve the HTML article independently of capture order. */
import { describe, expect, it } from 'vitest'
import { runUrlMigration } from '../url-run.js'
import type { MigrationCapture, UrlMigrationRunOptions } from '../url-run-types.js'

const origin = 'https://docs.test'
const markdown = '# Guide\n\nMachine representation.\n\n[Interactive guide](/docs/guide)'
const html = '<html><head><link rel="alternate" type="text/markdown" href="/docs/guide.md"></head><body><article><h1>Guide</h1><p>Interactive article preserved.</p><details><summary>Additional detail</summary><p>Hidden detail preserved.</p></details></article></body></html>'
const response = (url: URL, body: string, contentType = 'text/html'): MigrationCapture => ({ finalUrl: url, body, contentType })

function options(overrides: Partial<UrlMigrationRunOptions> = {}): UrlMigrationRunOptions {
  return { sourceUrl: `${origin}/docs/guide.md`, scopePath: '/docs', concurrency: 1,
    captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/docs/guide.md') return response(url, markdown, 'text/markdown')
      if (url.pathname === '/docs/guide') return response(url, html)
      throw new Error('No discovery index')
    } }, ...overrides }
}

function assertHtmlWins(run: Awaited<ReturnType<typeof runUrlMigration>>) {
  expect(run.validation.issues).toEqual([])
  expect(run.bundle.pages).toHaveLength(1)
  expect(run.bundle.pages[0].body).toContain('Interactive article preserved.')
  expect(run.bundle.pages[0].body).toContain('Hidden detail preserved.')
  expect(run.checkpoint.records.find(record => record.url === `${origin}/docs/guide.md`)).toMatchObject({ outcome: 'alias', aliasOf: `${origin}/docs/guide` })
}

describe('publisher-declared Markdown representations', () => {
  it('requests HTML without opting extensionless routes into Markdown negotiation', async () => {
    const accepts: Array<string | undefined> = []
    const run = await runUrlMigration(options({ sourceUrl: `${origin}/docs/guide`, captureProvider: undefined, fetcher: async (url, request) => {
      accepts.push(request.accept)
      if (url.pathname === '/docs/guide') return response(url, html)
      throw new Error('No index')
    } }))
    assertHtmlWins(run)
    expect(accepts.length).toBeGreaterThan(0)
    expect(accepts.every(accept => accept === 'text/html,application/xhtml+xml')).toBe(true)
  })

  it.each([1, 2, 5])('replaces an earlier imported Markdown page at concurrency %i', async concurrency => {
    const run = await runUrlMigration(options({ concurrency }))
    assertHtmlWins(run)
    const replay = await runUrlMigration(options({ concurrency, checkpoint: JSON.parse(JSON.stringify(run.checkpoint)), captureProvider: { capture: async () => { throw new Error('Must not recapture') } } }))
    expect(replay).toEqual(run)
  })

  it('upgrades the counted Markdown page when the page budget is already full', async () => {
    const run = await runUrlMigration(options({ maxPages: 1 }))
    assertHtmlWins(run)
  })

  it.each([
    ['/docs/guide', '/docs/guide/index.md'],
    ['/docs/guide/index', '/docs/guide.md'],
    ['/docs/guide/index', '/docs/guide/index.md'],
    ['/docs/guide', '/docs/guide/index.mdx'],
    ['/docs/guide/index', '/docs/guide.mdx'],
    ['/docs/guide/index', '/docs/guide/index.mdx'],
  ])('upgrades HTML %s from declared directory-index representation %s at the full budget', async (primary, alternate) => {
    const run = await runUrlMigration(options({ sourceUrl: `${origin}${alternate}`, maxPages: 1,
      captureProvider: { capture: async ({ url }) => {
        if (url.pathname === alternate) return response(url, markdown.replace('](/docs/guide)', `](${primary})`), 'text/markdown')
        if (url.pathname === primary) return response(url, html.replace('/docs/guide.md', alternate))
        throw new Error('No index')
      } },
    }))
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages).toHaveLength(1)
    expect(run.bundle.pages[0].body).toContain('Interactive article preserved.')
    expect(run.checkpoint.records.find(record => record.url === `${origin}${alternate}`)).toMatchObject({ outcome: 'alias', aliasOf: `${origin}${primary}` })
  })

  it('upgrades a Markdown artifact restored from a partial checkpoint', async () => {
    const first = await runUrlMigration(options({ maxCaptures: 1 }))
    expect(first.bundle.pages[0].body).toContain('Machine representation.')
    assertHtmlWins(await runUrlMigration(options({ checkpoint: first.checkpoint })))
  })

  it('keeps HTML when an earlier Markdown conversion finishes its assets later', async () => {
    let releaseAsset!: () => void
    const waitingForHtml = new Promise<void>(resolve => { releaseAsset = resolve })
    const run = await runUrlMigration(options({ sourceUrl: `${origin}/docs/start`, concurrency: 5,
      captureProvider: { capture: async ({ url }) => {
        if (url.pathname === '/docs/start') return response(url, '<article><h1>Start</h1><a href="/docs/guide.md">Markdown</a><a href="/docs/guide">Guide</a></article>')
        if (url.pathname === '/docs/guide.md') return response(url, `${markdown}\n\n![Figure](/figure.png)`, 'text/markdown')
        if (url.pathname === '/docs/guide') return response(url, html)
        throw new Error('No index')
      } },
      assetFetcher: async url => {
        await waitingForHtml
        return { url: url.href, contentType: 'image/png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1i8AAAAASUVORK5CYII=', 'base64') }
      },
      onRecord: async record => { if (record.url === `${origin}/docs/guide`) releaseAsset() },
    }))
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages).toHaveLength(2)
    expect(run.bundle.pages.find(page => page.id === 'guide')?.body).toContain('Hidden detail preserved.')
    expect(run.checkpoint.records.find(record => record.url === `${origin}/docs/guide.md`)).toMatchObject({ outcome: 'alias', aliasOf: `${origin}/docs/guide` })
  })

  it('rebuilds the declaration when its sibling journal chunk was not persisted', async () => {
    const first = await runUrlMigration(options())
    first.checkpoint.records = first.checkpoint.records.filter(record => record.url !== `${origin}/docs/guide.md`)
    const run = await runUrlMigration(options({ checkpoint: first.checkpoint, captureProvider: { capture: async () => { throw new Error('Must not recapture') } } }))
    assertHtmlWins(run)
  })

  it('preserves an explicit fallback when the HTML article cannot be converted', async () => {
    const run = await runUrlMigration(options({ captureProvider: { capture: async ({ url }) => {
      if (url.pathname.endsWith('.md')) return response(url, markdown, 'text/markdown')
      if (url.pathname === '/docs/guide') return response(url, '<html><head><link rel="alternate" type="text/markdown" href="/docs/guide.md"></head><body><main></main></body></html>')
      throw new Error('No index')
    } } }))
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages[0].body).toContain('Machine representation.')
    expect(run.checkpoint.records.find(record => record.url === `${origin}/docs/guide`)).toMatchObject({ outcome: 'alias', aliasOf: `${origin}/docs/guide.md` })
  })

  it('keeps independent same-route pages as destination collisions', async () => {
    const run = await runUrlMigration(options({ captureProvider: { capture: async ({ url }) => {
      if (url.pathname.endsWith('.md')) return response(url, markdown, 'text/markdown')
      if (url.pathname === '/docs/guide') return response(url, html.replace('<link rel="alternate" type="text/markdown" href="/docs/guide.md">', ''))
      throw new Error('No index')
    } } }))
    expect(run.checkpoint.records.find(record => record.url === `${origin}/docs/guide`)).toMatchObject({ outcome: 'failed', reason: 'Destination collision for guide.' })
  })
})
