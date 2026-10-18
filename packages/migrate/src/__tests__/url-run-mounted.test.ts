/** Mounted docs retain their page inventory while external links remain links. */
import { describe, expect, it } from 'vitest'
import { runUrlMigration } from '../url-run.js'
import type { MigrationCapture } from '../url-run-types.js'
const origin = 'https://example.test'
const capture = (path: string, body: string): MigrationCapture => ({ finalUrl: new URL(path, origin), body, contentType: 'text/html' })
const article = (body: string) => `<html><head><link rel="alternate" href="/docs/sitemap.xml" type="application/xml"></head><body><article><h1>Documentation</h1><p>Original documentation content.</p>${body}</article></body></html>`

describe('mounted documentation inventory', () => {
  it('matches positional code panels within their own group', async () => {
    const body = '<article><h1>Examples</h1><div class="code-group"><div role="tablist"><button role="tab">200</button><button role="tab">400</button></div><div role="tabpanel"><pre><code>{"ok":true}</code></pre></div><div role="tabpanel"><pre><code>{"error":"invalid"}</code></pre></div></div><div class="code-group"><div role="tablist"><button role="tab">Example</button></div><div role="tabpanel"><pre><code>second group</code></pre></div></div></article>'
    const run = await runUrlMigration({ sourceUrl: 'https://example.test/docs/intro', scopePath: '/docs', captureProvider: { capture: async ({ url }) => { if(url.pathname !== '/docs/intro') throw Error('404'); return { finalUrl: url, body, contentType: 'text/html' } } } })
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages[0].body).toContain('second group')
    const lazy = await runUrlMigration({ sourceUrl: 'https://example.test/docs/intro', scopePath: '/docs', captureProvider: { capture: async ({ url }) => { if(url.pathname !== '/docs/intro') throw Error('404'); return { finalUrl: url, body: body.replace('<pre><code>second group</code></pre>', ''), contentType: 'text/html' } } } })
    expect(lazy.validation.issues.some(issue => issue.code === 'unsupported-component')).toBe(true)
    const ambiguousBody = '<article><h1>Examples</h1><div class="code-group"><div role="tablist"><button role="tab">First</button></div><div role="tablist"><button role="tab">Deferred</button></div><div role="tabpanel"><pre><code>first example</code></pre></div></div></article>'
    const ambiguous = await runUrlMigration({ sourceUrl: 'https://example.test/docs/intro', scopePath: '/docs', captureProvider: { capture: async ({ url }) => { if(url.pathname !== '/docs/intro') throw Error('404'); return { finalUrl: url, body: ambiguousBody, contentType: 'text/html' } } } })
    expect(ambiguous.validation.issues.some(issue => issue.code === 'unsupported-component')).toBe(true)
  })
  it('retains same-origin redirects outside the documentation mount as links', async () => {
    const body = '<article><h1>Start</h1><a href="/docs/contact">Contact</a></article><aside><a href="/docs/intro">Start</a><a href="/docs/contact">Contact</a></aside>'
    const run = await runUrlMigration({ sourceUrl: 'https://example.test/docs/intro', scopePath: '/docs', captureProvider: { capture: async ({ url }) => { if(url.pathname === '/docs/intro') return { finalUrl: url, body, contentType: 'text/html' }; if(url.pathname === '/docs/contact') return { finalUrl: new URL('https://example.test/contact'), body: '<h1>Contact</h1>', contentType: 'text/html', status: 200 }; throw Error('404') } } })
    expect(run.bundle.pages).toHaveLength(1)
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.docsConfig.navigation?.shortcuts).toContainEqual({ label: 'Contact', href: 'https://example.test/contact' })
  })
  it('preserves dropdown collections, group order, and explicit sidebar labels', async () => {
    const navigation = { scopedNav: { dropdowns: [
      { dropdown: 'Documentation', groups: [{ group: 'Start', pages: [{ title: 'Long page title', sidebarTitle: 'Introduction', href: '/introduction' }] }] },
      { dropdown: 'API Reference', groups: [{ group: 'Resources', pages: [{ title: 'Long API title', sidebarTitle: 'Status', href: '/status' }] }] },
    ] } }
    const run = await runUrlMigration({ sourceUrl: `${origin}/docs/introduction`, scopePath: '/docs', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/docs/introduction') return capture(url.pathname, article('') + `<script type="application/json">${JSON.stringify(navigation)}</script>`)
      if (url.pathname === '/docs/status') return capture(url.pathname, article(''))
      throw new Error('Index absent')
    } } })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.docsConfig.navigation?.display).toBe('dropdown')
    expect(run.bundle.docsConfig.tabs.map(tab => tab.tab)).toEqual(['Documentation', 'API Reference'])
    expect(run.bundle.docsConfig.tabs[0].pages).toEqual([{ group: 'Start', pages: ['introduction'] }])
    expect(run.bundle.pages.find(page => page.id === 'introduction')?.navTitle).toBe('Introduction')
    expect(run.bundle.pages.find(page => page.id === 'status')?.navTitle).toBe('Status')
  })
  it('uses the selected mount for configuration IDs even without discovery hints', async () => {
    const navigation = { docsConfig: { navigation: { groups: [{ group: 'Docs', pages: ['introduction', 'guides/setup', { title: 'Reference', href: 'https://external.test/reference/#authentication' }] }] } } }
    const run = await runUrlMigration({ sourceUrl: `${origin}/docs/introduction`, scopePath: '/docs', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/docs/introduction') return capture(url.pathname, article('') .replace('<link rel="alternate" href="/docs/sitemap.xml" type="application/xml">', '') + `<script type="application/json">${JSON.stringify(navigation)}</script>`)
      if (url.pathname === '/docs/guides/setup') return capture(url.pathname, article(''))
      throw new Error('Index absent')
    } } })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages).toHaveLength(2)
    expect(run.bundle.docsConfig.tabs[0].pages).toEqual([{ group: 'Docs', pages: ['introduction', 'guides/setup'] }])
    expect(run.bundle.docsConfig.navigation?.shortcuts).toContainEqual({ label: 'Reference', href: 'https://external.test/reference/#authentication' })
  })
  it('resolves scoped publisher navigation hrefs against the documentation mount', async () => {
    const navigation = { scopedNav: { groups: [{ group: 'Docs', pages: [{ title: 'Start', href: '/introduction' }, { title: 'Setup', href: '/guides/setup' }] }] } }
    const run = await runUrlMigration({ sourceUrl: `${origin}/docs/introduction`, scopePath: '/docs', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/docs/introduction') return capture(url.pathname, article('') + `<script type="application/json">${JSON.stringify(navigation)}</script>`)
      if (url.pathname === '/docs/guides/setup') return capture(url.pathname, article(''))
      throw new Error('Index absent')
    } } })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages).toHaveLength(2)
    expect(run.bundle.docsConfig.tabs[0].pages).toEqual([{ group: 'Docs', pages: ['introduction', 'guides/setup'] }])
  })
  it('retains the imported representation when its HTML primary already aliases it', async () => {
    const sourceUrl = `${origin}/docs/introduction`
    const initial = await runUrlMigration({ sourceUrl, scopePath: '/docs', captureProvider: { capture: async ({ url }) => {
      if (url.href === sourceUrl) return capture(url.pathname, article(''))
      throw new Error('Index absent')
    } } })
    const primary = initial.checkpoint.records.find(record => record.outcome === 'imported')!
    const representation = { ...structuredClone(primary), url: `${sourceUrl}.md`, representationOf: sourceUrl }
    initial.checkpoint.records.push(representation)
    primary.outcome = 'alias'; primary.aliasOf = representation.url
    delete primary.page; delete primary.pageSha256; delete primary.assets
    const run = await runUrlMigration({ sourceUrl, scopePath: '/docs', checkpoint: initial.checkpoint, captureProvider: { capture: async () => { throw new Error('Must not recapture') } } })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages).toHaveLength(1)
    expect(run.checkpoint.records.some(record => record.aliasOf === record.url)).toBe(false)
    expect(run.checkpoint.records.find(record => record.url === representation.url)?.outcome).toBe('imported')
  })
  it('copies a video poster while retaining the remote video source', async () => {
    const acquired: string[] = []
    const run = await runUrlMigration({ sourceUrl: `${origin}/docs/introduction`, scopePath: '/docs', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/docs/introduction') return capture(url.pathname, article('<video controls src="/clip.mp4" poster="/cover.png"></video>'))
      throw new Error('Index absent')
    } }, assetFetcher: async url => {
      acquired.push(url.href)
      return { url: url.href, contentType: 'image/png', content: Buffer.from('iVBORw0KGgo=', 'base64') }
    } })
    expect(run.validation.status).toBe('passed')
    expect(acquired).toEqual([`${origin}/cover.png`])
    expect(run.bundle.pages[0].body).toContain(`${origin}/clip.mp4`)
    expect(run.bundle.pages[0].body).toContain('poster="/migration-assets/')
    expect(run.validation.warnings).toContainEqual(expect.objectContaining({ code: 'source-asset-warning' }))
  })
  it('imports sibling docs, preserves external destinations, and never captures marketing pages or aggregate corpora', async () => {
    const requested: string[] = []
    const navigation = { docsConfig: { navigation: { groups: [{ group: 'Start', pages: ['introduction', 'guides/setup', { title: 'Source', href: '/docs/source' }] }] } } }
    const html = article('<a href="/blog/news">News</a><a href="/docs/llms-full.txt">Corpus</a><a href="/docs/package.json">Package</a>') + `<script type="application/json">${JSON.stringify(navigation)}</script>`
    const run = await runUrlMigration({ sourceUrl: `${origin}/docs/introduction`, scopePath: '/docs', captureProvider: { capture: async ({ url }) => {
      requested.push(url.href)
      if (url.pathname === '/docs/introduction') return capture(url.pathname, html)
      if (url.pathname === '/docs/guides/setup') return capture(url.pathname, article('<p>Setup instructions.</p>'))
      if (url.pathname === '/docs/source') return { ...capture(url.pathname, ''), status: 302, headers: { location: 'https://github.com/example/docs' } }
      throw new Error('Index absent')
    } } })
    expect(run.validation.issues).toEqual([])
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages.map(page => page.id).sort()).toEqual(['guides/setup', 'introduction'])
    expect(requested).not.toContain(`${origin}/blog/news`)
    expect(requested).not.toContain(`${origin}/docs/llms-full.txt`)
    expect(requested).not.toContain(`${origin}/docs/package.json`)
    expect(requested.every(url => new URL(url).origin === origin)).toBe(true)
    expect(run.bundle.docsConfig.navigation?.shortcuts).toContainEqual({ label: 'Source', href: 'https://github.com/example/docs' })
    expect(run.bundle.docsConfig.tabs[0].pages).toEqual([{ group: 'Start', pages: ['introduction', 'guides/setup'] }])
  })
  it.each([404, 410] as const)('retains an original missing asset URL with a recorded HTTP %s source warning', async status => {
    const run = await runUrlMigration({ sourceUrl: `${origin}/docs/introduction`, scopePath: '/docs', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/docs/introduction') return capture(url.pathname, article('<img src="/images/missing.png" alt="Original screenshot">'))
      throw new Error('Index absent')
    } }, assetFetcher: async url => ({ url: url.href, contentType: '', content: new Uint8Array(), unavailable: { status } }) })
    expect(run.validation.status).toBe('passed')
    expect(run.validation.warnings).toContainEqual(expect.objectContaining({ code: 'asset-failed', message: expect.stringContaining(`HTTP ${status}`) }))
    expect(run.bundle.pages[0].body).toContain('/images/missing.png')
    expect(run.bundle.assets).toEqual([])
  })
  it('does not turn an ordinary asset acquisition error into a source warning', async () => {
    const run = await runUrlMigration({ sourceUrl: `${origin}/docs/introduction`, scopePath: '/docs', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/docs/introduction') return capture(url.pathname, article('<img src="/images/required.png">'))
      throw new Error('Index absent')
    } }, assetFetcher: async () => { throw new Error('Timed out') } })
    expect(run.validation.status).toBe('partial')
    expect(run.validation.issues).toContainEqual(expect.objectContaining({ code: 'asset-failed' }))
    expect(run.validation.warnings ?? []).toEqual([])
  })
})
