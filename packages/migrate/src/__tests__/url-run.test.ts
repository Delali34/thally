/** Evidence-bearing imports prove actual conversion, JSON recovery and inventory coverage. */
import { describe, expect, it } from 'vitest'
import { classifyMigrationResponse, runUrlMigration } from '../url-run.js'
import { compile } from '@mdx-js/mdx'
import type { MigrationCapture, MigrationCaptureProvider, UrlMigrationCheckpointDelta } from '../url-run-types.js'

function response(path: string, body: string, contentType = 'text/html'): MigrationCapture {
  return { finalUrl: new URL(path, 'https://docs.test'), body, contentType }
}
function provider(pages: Record<string, MigrationCapture>): MigrationCaptureProvider {
  return { capture: async ({ url }) => {
    const value = pages[url.pathname]
    if (!value) throw new Error('404')
    return value
  } }
}
const article = (title: string, body = '') => `<html><body><main><article><h1>${title}</h1><p>Technical documentation for this controlled source page.</p>${body}</article></main></body></html>`

describe('evidence URL runner', () => {
  it('classifies redirected machine indexes before conversion', async () => {
    expect(classifyMigrationResponse(response('/llms.txt', '# Index', 'text/plain'))).toBe('index')
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/', captureProvider: provider({
      '/': response('/llms.txt', '[Guide](/guide)', 'text/plain'),
      '/guide': response('/guide', article('Guide')),
    }) })
    expect(run.bundle.pages.map((page) => page.title)).toEqual(['Guide'])
    expect(run.checkpoint.records.find((record) => record.url === 'https://docs.test/')?.outcome).toBe('excluded')
  })

  it('preserves exact code, nested nav order, anchors, bytes and dynamic alternatives', async () => {
    const png = Buffer.from('iVBORw0KGgo=', 'base64')
    const code = '  const a = "<Tag>{data}</Tag>";\n\n'
    const source = response('/guide', article('Guide', `<h2 id="custom-anchor">Example</h2><pre><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre><img src="/logo.png"><a href="/second#target">Next</a>`))
    source.navigation = [{ label: 'Start', children: [{ label: 'Second', url: 'https://docs.test/second' }, { label: 'Guide', url: 'https://docs.test/guide' }] }]
    source.assets = [{ url: 'https://docs.test/logo.png', contentType: 'image/png', content: png }]
    source.states = [{ id: 'python', label: 'Python', response: response('/guide', article('Guide', '<pre><code>print(1)\n</code></pre>')) }]
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: provider({
      '/guide': source,
      '/second': response('/second', article('Second', '<h2 id="target">Target</h2>')),
    }) })
    expect(run.validation.issues).toEqual([])
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.assets[0].content).toEqual(png)
    expect(run.bundle.pages[0].body).toContain(code)
    expect(run.bundle.pages[0].body).toContain('[Next](/second#target)')
    expect(run.bundle.pages[0].body).toContain('<a id="custom-anchor" />')
    expect(run.bundle.docsConfig.tabs[0].pages).toEqual([{ group: 'Start', pages: ['second', 'guide'] }])
    expect(run.checkpoint.records.find((record) => record.page)?.evidence?.code).toEqual([code, 'print(1)\n'])
  })

  it('resumes JSON checkpoints, requeues corrupt pages and emits bounded deltas', async () => {
    const deltas: Array<UrlMigrationCheckpointDelta> = []
    const pages = {
      '/one': response('/one', article('One', '<a href="/two">Two</a>')),
      '/two': response('/two', article('Two')),
    }
    const first = await runUrlMigration({ sourceUrl: 'https://docs.test/one', captureProvider: provider(pages), maxCaptures: 1, batchSize: 1, onCheckpoint: async (delta) => { deltas.push(JSON.parse(JSON.stringify(delta))) } })
    expect(first.validation.status).toBe('partial')
    expect(deltas[0].converterVersion).toBe('url-evidence-v1')
    expect(deltas.flatMap((delta) => delta.records).some((record) => record.url.endsWith('/two'))).toBe(true)
    const checkpoint = JSON.parse(JSON.stringify(first.checkpoint))
    checkpoint.records.find((record: { page?: unknown }) => record.page).page.body = 'corrupted'
    const captured: Array<string> = []
    const second = await runUrlMigration({ sourceUrl: 'https://docs.test/one', checkpoint, captureProvider: {
      capture: async (request) => { captured.push(request.url.pathname); return provider(pages).capture(request) },
    } })
    expect(captured).toContain('/one')
    expect(second.bundle.pages).toHaveLength(2)
    expect(second.validation.status).toBe('passed')
  })

  it('rejects executable MDX and exposes missing anchors and unsafe assets', async () => {
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/safe', captureProvider: provider({
      '/safe': response('/safe', article('Safe', '<a href="/unsafe">Unsafe</a><a href="/other#absent">Broken</a><img src="/x.svg">')),
      '/unsafe': response('/unsafe', '# Unsafe\n\n{process.exit(1)}', 'text/markdown'),
      '/other': response('/other', article('Other')),
    }) })
    expect(run.validation.status).toBe('partial')
    expect(run.validation.issues.map((issue) => issue.code)).toContain('missing-anchor')
    expect(run.validation.issues.map((issue) => issue.code)).toContain('asset-failed')
    expect(run.bundle.pages.some((page) => page.id === 'unsafe')).toBe(false)
  })

  it('cancels without committing an unfinished capture', async () => {
    const controller = new AbortController()
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/a', signal: controller.signal, captureProvider: {
      capture: async () => { controller.abort(); return response('/a', article('A')) },
    } })
    expect(run.validation.status).toBe('cancelled')
    expect(run.bundle.pages).toHaveLength(0)
    expect(run.checkpoint.records[0].outcome).toBe('pending')
  })

  it('escapes expression-bearing admonition headings from rendered HTML', async () => {
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/a', captureProvider: provider({
      '/a': response('/a', article('A', '<div class="theme-admonition"><div class="admonitionHeading">{process.exit(1)}</div><p>Source text remains literal.</p></div>')),
    }) })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages[0].body).toContain('&#123;process.exit(1)&#125;')
  })

  it('preserves literal prose braces and technical delimiters under the inert gate', async () => {
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/a', captureProvider: provider({
      '/a': response('/a', article('A', '<p>Literal {safe} text and closing } remain readable.</p><h2 id="custom">Code</h2><pre><code>const example = `&lt;Tag&gt;{data}&lt;/Tag&gt;`;\n</code></pre><a href="#custom">Code anchor</a>')),
    }) })
    expect(run.validation.issues).toEqual([])
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages[0].body).toContain('Literal \\{safe\\} text and closing \\}')
    expect(run.bundle.pages[0].body).toContain('const example = `<Tag>{data}</Tag>`;\n')
  })

  it('preserves observed DOM hierarchy, locale/version identity and redirect aliases', async () => {
    const source = response('/fr/v2/guide', `<header><nav><a href="/pricing">Pricing</a></nav></header><aside><section><h3>Guides</h3><ul><li><a href="/fr/v2/next">Next</a></li><li><a href="/fr/v2/guide">Guide short</a></li></ul></section></aside>${article('Guide', '<a href="/legacy#example">Alias</a>')}`)
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/fr/v2/guide', scopePath: '/', captureProvider: provider({
      '/fr/v2/guide': source,
      '/fr/v2/next': response('/fr/v2/next', article('Next', '<h2 id="example">Example</h2>')),
      '/legacy': response('/fr/v2/next', article('Next', '<h2 id="example">Example</h2>')),
    }) })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages.map((page) => page.id)).toEqual(['v2/guide', 'v2/next'])
    expect(run.bundle.docsConfig.tabs[0].pages).toEqual([{ group: 'Guides', pages: ['v2/next', 'v2/guide'] }])
    expect(run.bundle.pages[0].body).toContain('[Alias](/v2/next#example)')
    expect(run.bundle.pages[0].navTitle).toBe('Guide short')
    expect(run.checkpoint.records.find((record) => record.page)?.version).toBe('v2')
    expect(run.bundle.docsConfig.i18n?.locales.map((locale) => locale.code)).toContain('fr')
  })

  it('copies three distinct passive SVG diagrams and rejects an active alias payload', async () => {
    const diagrams = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L20 20" stroke="blue"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="shape"><circle r="4" fill="red"/></g></defs><use href="#shape"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"><stop stop-color="green"/></linearGradient></defs><rect width="20" height="20" fill="url(#paint)"/></svg>',
    ]
    const source = response('/guide', article('Diagrams', diagrams.map((_svg, index) => `<img src="/diagram-${index}.svg">`).join('')))
    source.assets = diagrams.map((body, index) => ({ url: `https://docs.test/diagram-${index}.svg`, contentType: 'image/svg+xml', content: Buffer.from(body) }))
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: provider({ '/guide': source }) })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.assets).toHaveLength(3)
    expect(run.bundle.assets.map((asset) => Buffer.from(asset.content).toString())).toEqual(diagrams)
    expect(new Set(run.bundle.assets.map((asset) => asset.path)).size).toBe(3)
    const malicious = { ...source, assets: source.assets.map((asset, index) => index === 1 ? { ...asset, content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/><defs><use id="a" href="https://evil.test/svg"/></defs></svg>') } : asset) }
    const rejected = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: provider({ '/guide': malicious }) })
    expect(rejected.validation.status).toBe('partial')
    expect(rejected.validation.issues.map((issue) => issue.code)).toContain('asset-failed')
    expect(rejected.bundle.assets).toHaveLength(2)
  })

  it('preserves literal responsive picture choices and localizes every candidate', async () => {
    const png = Buffer.from('iVBORw0KGgo=', 'base64')
    const paths = ['/small.png', '/large.png', '/wide.png']
    const source = response('/guide', article('Pictures', '<picture><source media="(min-width: 800px)" type="image/png" srcset="/wide.png 1600w, /large.png 800w" sizes="100vw"><img src="/small.png" srcset="/small.png 400w, /large.png 800w" sizes="(max-width: 600px) 100vw, 600px" alt="Literal {alt} &amp; size" width="600" height="300"></picture>'))
    source.assets = paths.map((path, index) => ({ url: `https://docs.test${path}`, contentType: 'image/png', content: Buffer.concat([png, Buffer.from([index])]) }))
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: provider({ '/guide': source }) })
    expect(run.validation.issues).toEqual([])
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.assets).toHaveLength(3)
    const body = run.bundle.pages[0].body
    expect(body).toContain('<picture>')
    expect(body).toContain('<source srcSet=')
    expect(body).toContain('media="(min-width: 800px)"')
    expect(body).toContain('sizes="(max-width: 600px) 100vw, 600px"')
    expect(body).toContain('alt="Literal &#123;alt&#125; &amp; size"')
    expect(body).not.toContain('migration.invalid')
    expect(body).not.toContain('https://docs.test/')
    expect(body).toMatch(/srcSet="\/migration-assets\/[a-f0-9]+\.png 400w, \/migration-assets\/[a-f0-9]+\.png 800w"/)
    await expect(compile(body)).resolves.toBeDefined()
  })

  it('counts shared asset bytes once, reuses acquisition, and keeps distinct budgets honest', async () => {
    const png = Buffer.concat([Buffer.from('iVBORw0KGgo=', 'base64'), Buffer.alloc(100_000)])
    let requests = 0
    const captureProvider: MigrationCaptureProvider = { capture: async ({ url }) => {
      if (!/^\/p\d+$/.test(url.pathname)) throw new Error('404')
      return response(url.pathname, article('Shared', `<img src="/shared.png">${url.pathname === '/p0' ? Array.from({ length: 15 }, (_, i) => `<a href="/p${i + 1}">Page</a>`).join('') : ''}`))
    } }
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/p0', maxTotalBytes: 150_000, captureProvider, assetFetcher: async (url) => {
      requests++
      return { url: url.href, contentType: 'image/png', content: png }
    } })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages).toHaveLength(16)
    expect(run.bundle.assets).toHaveLength(1)
    expect(requests).toBe(1)
    expect(run.stopReason).toBe('complete')
    const resumed = await runUrlMigration({ sourceUrl: 'https://docs.test/p0', maxTotalBytes: 150_000, captureProvider, checkpoint: JSON.parse(JSON.stringify(run.checkpoint)), assetFetcher: async () => { throw new Error('Must reuse reconciled assets') } })
    expect(resumed.validation.status).toBe('passed')
    const distinct = response('/distinct', article('Distinct', '<img src="/one.png"><img src="/two.png">'))
    distinct.assets = [0, 1].map((number) => ({ url: `https://docs.test/${number ? 'two' : 'one'}.png`, contentType: 'image/png', content: Buffer.concat([png, Buffer.from([number])]) }))
    const limited = await runUrlMigration({ sourceUrl: 'https://docs.test/distinct', maxTotalBytes: 150_000, captureProvider: provider({ '/distinct': distinct }) })
    expect(limited.validation.status).toBe('partial')
    expect(limited.stopReason).toBe('byte-limit')
    expect(limited.bundle.assets).toHaveLength(1)
  })

  it('drains discovery at the article cap and preserves complete static tab alternatives', async () => {
    const source = response('/docs/intro', `<aside><ul><li><div><a href="/docs/intro">Getting started</a></div><ul><li><a href="/docs/intro">Installation</a></li></ul></li></ul></aside>${article('Installation', '<nav class="theme-doc-breadcrumbs"><a aria-label="Home page"><svg><path d="M0 0"/></svg></a></nav><button aria-label="Copy code"><svg><path d="M0 0"/></svg></button><a class="hash-link"><svg><path d="M0 0"/></svg></a><div class="tabs-container"><ul class="tabs"><li role="tab" aria-controls="npm">npm</li><li role="tab" aria-controls="yarn">yarn</li></ul><div><div role="tabpanel" id="npm"><pre><code>npm install example</code></pre></div><div role="tabpanel" id="yarn" hidden><pre><code>yarn add example</code></pre></div></div></div>')}`)
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/docs/intro', scopePath: '/docs/intro', maxPages: 1, captureProvider: provider({ '/docs/intro': source }) })
    expect(run.validation.issues).toEqual([])
    expect(run.validation.status).toBe('passed')
    expect(run.validation.counts.pending).toBe(0)
    expect(run.stopReason).toBe('complete')
    expect(run.bundle.pages[0].navTitle).toBe('Installation')
    expect(run.bundle.pages[0].body).toContain('<Tab title="npm">')
    expect(run.bundle.pages[0].body).toContain('<Tab title="yarn">')
    expect(run.bundle.docsConfig.tabs[0].pages).toEqual([{ group: 'Getting started', pages: ['introduction'] }])
    const lazy = { ...source, body: source.body.replace('<pre><code>yarn add example</code></pre>', '') }
    const partial = await runUrlMigration({ sourceUrl: 'https://docs.test/docs/intro', scopePath: '/docs/intro', maxPages: 1, captureProvider: provider({ '/docs/intro': lazy }) })
    expect(partial.validation.status).toBe('partial')
    expect(partial.validation.issues.map((issue) => issue.code)).toContain('unsupported-component')
  })

  it('renders the document title once and keeps its source heading anchor', async () => {
    const source = response('/guide', '<header><h1>Site brand</h1></header><article><header><h1 id="start-here">Start here</h1><p>The title is rendered by the destination document header.</p></header><h2 id="next">Next</h2><a href="#start-here">Top</a></article>')
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: provider({ '/guide': source }) })
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages[0].title).toBe('Start here')
    expect(run.bundle.pages[0].descriptionPlacement).toBe('body')
    expect(run.bundle.pages[0].body).not.toMatch(/^# /m)
    expect(run.bundle.pages[0].body).toContain('<a id="start-here" />')
    expect(run.bundle.pages[0].body).toContain('## Next')
    expect(run.bundle.pages[0].body).toContain('The title is rendered by the destination document header.')
    const multiple = { ...source, body: source.body.replace('</article>', '<h1>Another top-level heading</h1></article>') }
    const partial = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: provider({ '/guide': multiple }) })
    expect(partial.validation.status).toBe('partial')
    expect(partial.bundle.pages[0].body).toContain('# Another top-level heading')
  })

  it('reconciles JSONB-reordered checkpoint keys without recapturing committed pages', async () => {
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/one', captureProvider: provider({ '/one': response('/one', article('One')) }) })
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, field]) => [key, reorder(field)])) : value
    const checkpoint = reorder(JSON.parse(JSON.stringify(run.checkpoint))) as typeof run.checkpoint
    const resumed = await runUrlMigration({ sourceUrl: 'https://docs.test/one', checkpoint, captureProvider: { capture: async () => { throw new Error('Committed page must not be recaptured') } } })
    expect(resumed.validation.status).toBe('passed')
    expect(resumed.bundle.pages).toEqual(run.bundle.pages)
  })

  it('converts and validates a full 10000-page inventory beyond the former cap', async () => {
    const size = 10_000
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/p0', maxPages: size, concurrency: 24, captureProvider: {
      capture: async ({ url }) => {
        if (url.pathname === '/sitemap.xml') return response('/sitemap.xml', `<urlset>${Array.from({ length: size }, (_, i) => `<url><loc>https://docs.test/p${i}</loc></url>`).join('')}</urlset>`, 'application/xml')
        const match = url.pathname.match(/^\/p(\d+)$/)
        if (!match) throw new Error('404')
        return response(url.pathname, `# Page ${match[1]}\n\nTechnical payload ${match[1]}.\n\n\`\`\`ts\nconst number = ${match[1]}\n\`\`\``, 'text/markdown')
      },
    } })
    expect(run.bundle.pages).toHaveLength(size)
    expect(run.validation.status).toBe('passed')
    expect(run.validation.counts.pending).toBe(0)
  }, 120_000)
})
