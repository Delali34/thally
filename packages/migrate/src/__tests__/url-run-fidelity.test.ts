/** Regression contracts for format identities, container code and complete tab observations. */
import { describe, expect, it } from 'vitest'
import { runUrlMigration, validateUrlMigration } from '../url-run.js'
import type { MigrationCapture } from '../url-run-types.js'

const response = (path: string, body: string, contentType = 'text/html'): MigrationCapture => ({ finalUrl: new URL(path, 'https://docs.test'), body, contentType })
const html = (title: string, body = '', head = '') => `<html lang="en"><head>${head}</head><body><main><article><h1>${title}</h1><p>Original documentation prose.</p>${body}</article></main></body></html>`

describe('URL import fidelity regressions', () => {
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
  it('reports inherited broken anchors separately while blocking anchors lost during conversion', async () => {
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/guide', captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing source')
      return response('/guide', html('Guide', '<h2 id="present">Present</h2><a href="#present">Valid</a><a href="#already-broken">Source defect</a>'))
    } } })
    expect(run.validation.status).toBe('passed')
    expect(run.validation.issues).toEqual([])
    expect(run.validation.warnings).toEqual([expect.objectContaining({ code: 'source-link-warning', message: expect.stringContaining('#already-broken') })])
    expect(run.bundle.warnings).toEqual([expect.objectContaining({ message: expect.stringContaining('#already-broken') })])
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
