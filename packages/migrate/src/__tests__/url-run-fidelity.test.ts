/** Regression contracts for format identities, container code and complete tab observations. */
import { describe, expect, it } from 'vitest'
import { runUrlMigration, validateUrlMigration } from '../url-run.js'
import type { MigrationCapture, MigrationNavigationOccurrence } from '../url-run-types.js'

const response = (path: string, body: string, contentType = 'text/html'): MigrationCapture => ({ finalUrl: new URL(path, 'https://docs.test'), body, contentType })
const html = (title: string, body = '', head = '') => `<html lang="en"><head>${head}</head><body><main><article><h1>${title}</h1><p>Original documentation prose.</p>${body}</article></main></body></html>`

function legacyLocaleNavigation(englishPages = ['/api/status'], chinesePages = ['/zh-hans-api/status']): Array<MigrationNavigationOccurrence> {
  return [
    { kind: 'tab', label: 'API', locale: 'en', children: englishPages.map(url => ({ kind: 'page', label: 'Status', url })) },
    { kind: 'tab', label: 'API', locale: 'zh-Hans', children: chinesePages.map(url => ({ kind: 'page', label: 'Status', url })) },
  ]
}

async function migrateLegacyLocale(navigation: Array<MigrationNavigationOccurrence>, additionalCaptures: Array<MigrationCapture> = []) {
  const captures = new Map([
    response('/api/status', html('English status', '<h2 id="details">Details</h2><p>Original English status payload.</p><a href="/zh-hans-api/status#details">Chinese status</a>')),
    response('/zh-hans-api/status', html('中文状态', '<h2 id="details">详细信息</h2><p>原始中文文档内容。</p><a href="/api/status#details">English status</a><a href="/zh-hans-api/status#details">当前状态</a>')),
    ...additionalCaptures,
  ].map(capture => [capture.finalUrl.pathname, capture]))
  return runUrlMigration({ sourceUrl: 'https://docs.test/api/status', scopePath: '/', captureProvider: { capture: async ({ url }) => {
    const capture = captures.get(url.pathname)
    if (!capture) throw new Error('Missing source')
    return { ...capture, navigation }
  } } })
}

describe('URL import fidelity regressions', () => {
  it('normalizes a legacy locale namespace only with explicit language navigation and a primary counterpart', async () => {
    const result = await migrateLegacyLocale(legacyLocaleNavigation())
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages).toHaveLength(2)
    expect(result.bundle.pages.map(page => page.id).sort()).toEqual(['api/status', 'zh-Hans/api/status'])
    const primary = result.bundle.pages.find(page => page.id === 'api/status')!
    const translated = result.bundle.pages.find(page => page.id === 'zh-Hans/api/status')!
    expect(translated).toMatchObject({ navigationId: 'api/status', locale: 'zh-Hans', title: '中文状态', source: 'https://docs.test/zh-hans-api/status' })
    expect(translated.body).toContain('原始中文文档内容。')
    expect(translated.body).not.toContain('Original English status payload.')
    expect(primary.body).toContain('[Chinese status](/zh-Hans/api/status#details)')
    expect(translated.body).toContain('[English status](/api/status#details)')
    expect(translated.body).toContain('[当前状态](/zh-Hans/api/status#details)')
    expect(result.bundle.docsConfig.redirects).toEqual([{ source: '/zh-hans-api/status', destination: '/zh-Hans/api/status', permanent: true }])
    expect(result.bundle.docsConfig.tabs).toEqual([{ tab: 'API', pages: ['api/status'] }])
    expect(result.bundle.docsConfig.i18n).toMatchObject({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'zh-Hans', label: 'zh-Hans' }], navigation: { 'zh-Hans': [{ tab: 'API', pages: ['api/status'] }] } })
    const replay = await runUrlMigration({ sourceUrl: result.checkpoint.sourceUrl, scopePath: result.checkpoint.scopePath, checkpoint: structuredClone(result.checkpoint), captureProvider: { capture: async () => { throw new Error('No recapture') } } })
    expect(replay).toEqual(result)
  })

  it('does not infer a translated counterpart from a primary page absent from primary navigation', async () => {
    const result = await migrateLegacyLocale(legacyLocaleNavigation([], ['/zh-hans-api/status']))
    expect(result.bundle.pages.find(page => page.source.endsWith('/zh-hans-api/status'))).toMatchObject({ id: 'zh-hans-api/status', navigationId: 'zh-hans-api/status', locale: 'en' })
    expect(result.bundle.pages.some(page => page.id === 'zh-Hans/api/status')).toBe(false)
    expect(result.bundle.docsConfig.redirects ?? []).toEqual([])
    expect(result.validation.status).toBe('partial')
    expect(result.validation.issues).toContainEqual(expect.objectContaining({ code: 'navigation-missing' }))
  })

  it('does not normalize a source assigned to conflicting language collections', async () => {
    const result = await migrateLegacyLocale(legacyLocaleNavigation(['/api/status', '/zh-hans-api/status']))
    expect(result.bundle.pages.find(page => page.source.endsWith('/zh-hans-api/status'))).toMatchObject({ id: 'zh-hans-api/status', navigationId: 'zh-hans-api/status', locale: 'en' })
    expect(result.bundle.pages.some(page => page.id === 'zh-Hans/api/status')).toBe(false)
    expect(result.bundle.docsConfig.redirects ?? []).toEqual([])
    expect(result.validation.status).toBe('partial')
    expect(result.validation.issues).toContainEqual(expect.objectContaining({ code: 'navigation-missing' }))
  })

  it('blocks a legacy locale projection that collides with an existing authored translation', async () => {
    const canonical = response('/zh-Hans/api/status', html('Authored Chinese status', '<h2 id="details">Details</h2><p>Distinct authored translation.</p>').replace('<html lang="en">', '<html lang="zh-Hans">'))
    const result = await migrateLegacyLocale(legacyLocaleNavigation(['/api/status'], ['/zh-hans-api/status', '/zh-Hans/api/status']), [canonical])
    expect(result.validation.status).toBe('partial')
    expect(result.validation.issues).toContainEqual(expect.objectContaining({ code: 'collision', message: expect.stringContaining('zh-Hans/api/status') }))
    expect(result.bundle.pages.filter(page => page.id === 'zh-Hans/api/status').map(page => page.source).sort()).toEqual(['https://docs.test/zh-Hans/api/status', 'https://docs.test/zh-hans-api/status'])
  })

  it('keeps declared directory-index and Markdown aliases on one canonical article', async () => {
    const fetched: string[] = []
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/catalog', captureProvider: { capture: async ({ url }) => {
      fetched.push(url.pathname)
      if (url.pathname === '/catalog') return response('/catalog', html('Catalog', '<a href="/catalog/index">Index</a><a href="/.well-known/ai-plugin.json">Manifest</a>'))
      if (url.pathname === '/catalog/index') return response('/catalog/index', html('Catalog', '', '<link rel="canonical" href="/catalog"><link rel="alternate" type="text/markdown" href="/catalog/index.md">'))
      if (url.pathname === '/.well-known/ai-plugin.json') return response(url.pathname, '{"name":"Documentation manifest"}', 'text/plain')
      throw new Error('Missing source')
    } } })
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages).toHaveLength(1)
    expect(result.checkpoint.records.find(record => record.url.endsWith('/catalog/index.md'))).toMatchObject({ outcome: 'alias', aliasOf: 'https://docs.test/catalog' })
    expect(fetched).not.toContain('/catalog/index.md')
    expect(result.checkpoint.records.find(record => record.url.endsWith('ai-plugin.json'))?.outcome).toBe('excluded')
  })
  it.each([false, true])('recovers deferred API fields only from a complete local operation (external ref: %s)', async (externalRef) => {
    const fetched: string[] = []
    const markdown = '# API\n\n```yaml get /status\nopenapi: 3.0.3\ninfo: {title: Example, version: "1"}\npaths:\n  /status:\n    get:\n      responses:\n        "200":\n          description: Status\n          content:\n            application/json:\n              schema:\n                $ref: "' + (externalRef ? 'https://private.invalid/schema' : '#/components/schemas/Status') + '"\ncomponents:\n  schemas:\n    Status:\n      type: object\n      properties:\n        ready: {type: boolean, description: Complete nested field}\n```'
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/api', captureProvider: { capture: async ({ url }) => {
      fetched.push(url.href)
      if (url.pathname === '/api') return response('/api', html('API', '<pre><code>GET /status</code></pre><details class="expandable"><summary data-component-part="expandable-button">Attributes</summary></details>', '<link rel="alternate" type="text/markdown" href="/api.md">'))
      if (url.pathname === '/api.md') return response('/api.md', markdown, 'text/markdown')
      throw new Error('Missing source')
    } } })
    expect(fetched.every(url => new URL(url).origin === 'https://docs.test')).toBe(true)
    if (externalRef) {
      expect(result.validation.status).toBe('partial')
      expect(result.bundle.assets).toHaveLength(0)
      expect(result.validation.issues).toContainEqual(expect.objectContaining({ code: 'unsupported-component' }))
      return
    }
    expect(result.validation.status).toBe('passed')
    const spec = result.bundle.assets.find(asset => asset.path.startsWith('openapi/'))!
    expect(spec.projectRelative).toBe(true)
    expect(JSON.parse(Buffer.from(spec.content).toString()).components.schemas.Status.properties.ready.description).toBe('Complete nested field')
    expect(result.bundle.pages[0].openapi).toBe(`${spec.path} GET /status`)
    expect(result.bundle.pages[0].body).toContain('GET /status')
    expect(result.bundle.docsConfig.tabs).toContainEqual(expect.objectContaining({ hidden: true, api: { source: spec.path, navigation: false } }))
    expect(fetched.filter(url => url.endsWith('/api.md'))).toHaveLength(1)
    const replay = await runUrlMigration({ sourceUrl: 'https://docs.test/api', checkpoint: JSON.parse(JSON.stringify(result.checkpoint)), captureProvider: { capture: async () => { throw new Error('No recapture') } } })
    expect(replay).toEqual(result)
    const corrupt = structuredClone(result.checkpoint)
    corrupt.records.find(record => record.apiSpecification)!.apiSpecification!.document.info = { title: 'Changed without a matching digest' }
    const recaptured = await runUrlMigration({ sourceUrl: 'https://docs.test/api', checkpoint: corrupt, captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/api') throw new Error('No declared schema exists')
      return response('/api', html('API', '<details class="expandable"><summary data-component-part="expandable-button">Missing attributes</summary></details>'))
    } } })
    expect(recaptured.validation.status).toBe('partial')
    expect(recaptured.validation.issues).toContainEqual(expect.objectContaining({ code: 'unsupported-component' }))
    expect(recaptured.bundle.assets.some(asset => asset.path.startsWith('openapi/'))).toBe(false)
  })
  it('falls back to the page for proven source defects while blocking anchors lost during conversion', async () => {
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing source')
      return response('/guide', html('Guide', '<h2 id="present">Present</h2><a href="#present">Valid</a><a href="#pre%73ent">Encoded valid</a><a href="#already-broken">Source defect</a><a href="##present">Malformed source fragment</a><pre><code>link = &quot;#already-broken&quot;</code></pre>'))
    } } })
    expect(run.validation.status).toBe('passed')
    expect(run.validation.issues).toEqual([])
    expect(run.validation.warnings).toEqual([expect.objectContaining({ code: 'source-link-warning', message: expect.stringContaining('#already-broken') }), expect.objectContaining({ code: 'source-link-warning', message: expect.stringContaining('##present') })])
    expect(run.bundle.warnings).toEqual([expect.objectContaining({ message: expect.stringContaining('#already-broken') }), expect.objectContaining({ message: expect.stringContaining('##present') })])
    expect(run.bundle.pages[0].body).toContain('[Valid](/guide#present)')
    expect(run.bundle.pages[0].body).toContain('[Encoded valid](/guide#pre%73ent)')
    expect(run.bundle.pages[0].body).toContain('[Source defect](/guide)')
    expect(run.bundle.pages[0].body).toContain('[Malformed source fragment](/guide)')
    expect(run.bundle.pages[0].body).toContain('link = "#already-broken"')
    const replay = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', checkpoint: structuredClone(run.checkpoint), captureProvider: { capture: async () => { throw new Error('No recapture') } } })
    expect(replay).toEqual(run)
    const damaged = structuredClone(run.checkpoint)
    const page = damaged.records.find(record => record.page)!.page!
    page.body = page.body.replace('<a id="present" />', '').replace('## Present', '## Changed')
    expect(validateUrlMigration(damaged).issues).toContainEqual(expect.objectContaining({ code: 'missing-anchor', message: expect.stringContaining('Conversion lost') }))
  })
  it('deduplicates only publisher-declared same-route Markdown representations', async () => {
    const fetched: string[] = []
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: { capture: async ({ url }) => {
      fetched.push(url.pathname)
      if (url.pathname === '/guide') return response('/guide', html('Guide', '<a href="/guide.md">Markdown</a>', '<link rel="alternate" type="text/markdown" href="/guide.md">'))
      throw new Error('Unexpected source fetch')
    } } })
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages).toHaveLength(1)
    expect(fetched).not.toContain('/guide.md')
    expect(result.checkpoint.records.find(record => record.url.endsWith('/guide.md'))).toMatchObject({ outcome: 'alias', aliasOf: 'https://docs.test/guide' })
    expect(result.bundle.pages[0].body).toContain('[Markdown](/guide)')
    const replay = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', checkpoint: JSON.parse(JSON.stringify(result.checkpoint)), captureProvider: { capture: async () => { throw new Error('No recapture') } } })
    expect(replay).toEqual(result)
  })

  it('does not infer aliases from filenames or accept a cross-route declaration', async () => {
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/guide') return response('/guide', html('Guide', '<a href="/guide.md">Different input</a>', '<link rel="alternate" type="text/markdown" href="/other.md">'))
      if (url.pathname === '/guide.md') return response('/guide.md', html('Different guide'))
      throw new Error('Missing source')
    } } })
    expect(result.validation.issues.some(issue => issue.code === 'missing-page' && issue.message.includes('Destination collision'))).toBe(true)
    expect(result.checkpoint.records.find(record => record.url.endsWith('/guide.md'))?.outcome).toBe('failed')
  })

  it('releases failed conversion reservations so a declared inert representation can recover', async () => {
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/guide') return response('/guide', '<html><head><link rel="alternate" type="text/markdown" href="/guide.md"></head><body><main></main></body></html>')
      if (url.pathname === '/guide.md') return response('/guide.md', '# Recovered guide\n\nOriginal readable article.', 'text/markdown')
      throw new Error('Missing source')
    } } })
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages).toHaveLength(1)
    expect(result.checkpoint.records.find(record => record.url.endsWith('/guide'))).toMatchObject({ outcome: 'alias', aliasOf: 'https://docs.test/guide.md' })
  })

  it('restores exact fenced code inside a list without changing its Markdown container', async () => {
    const code = '{\n  "strategy": "minWaitTime"\n}\n'
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', maxCaptures: 1, captureProvider: { capture: async () => response('/guide', html('Guide', `<ol><li><p>Configure routing.</p><pre><code class="language-json">${code}</code></pre></li></ol>`)) } })
    expect(result.checkpoint.records[0].outcome).toBe('imported')
    expect(result.validation.issues.filter(issue => issue.code === 'code-mismatch' || issue.code === 'unsafe-content')).toEqual([])
    expect(result.checkpoint.records[0].evidence?.code).toEqual([code])
  })

  it('preserves nested blockquote code with long source indentation', async () => {
    const code = `${' '.repeat(16_384)}{ "strategy": "minWaitTime" }\n`
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', maxCaptures: 1, captureProvider: { capture: async () => response('/guide', html('Guide', `<blockquote><blockquote><pre><code class="language-json">${code}</code></pre></blockquote></blockquote>`)) } })
    expect(result.checkpoint.records[0].outcome).toBe('imported')
    expect(result.validation.issues.filter(issue => issue.code === 'code-mismatch' || issue.code === 'unsafe-content')).toEqual([])
    expect(result.checkpoint.records[0].evidence?.code).toEqual([code])
    expect(result.bundle.pages[0].body).toContain('> > ```json')
  })

  it('merges later tab sidebars into exact ordered tabs and retains repeated placements', async () => {
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/one', captureProvider: { capture: async ({ url }) => {
      if (!['/one', '/two'].includes(url.pathname)) throw new Error('Missing source')
      return { ...response(url.pathname, html(url.pathname)), navigation: [
        { kind: 'tab', label: 'Overview', locale: 'en', children: [{ kind: 'group', label: 'Start', children: [{ kind: 'page', label: 'One', url: '/one' }] }] },
        { kind: 'tab', label: 'SDK', locale: 'en', children: url.pathname === '/two' ? [{ kind: 'group', label: 'Install', children: [{ kind: 'page', label: 'Two', url: '/two' }, { kind: 'page', label: 'One', url: '/one' }] }] : [{ kind: 'page', label: 'SDK', url: '/two' }] },
        { kind: 'tab', label: 'Playground', locale: 'en', url: 'https://playground.test/' },
      ] }
    } } })
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.docsConfig.tabs).toEqual([
      { tab: 'Overview', pages: [{ group: 'Start', pages: ['one'] }] },
      { tab: 'SDK', pages: [{ group: 'Install', pages: ['two', 'one'] }] },
      { tab: 'Playground', href: 'https://playground.test/' },
    ])
  })
})
