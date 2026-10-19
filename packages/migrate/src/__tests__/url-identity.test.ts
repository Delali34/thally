/** Exact capture fixtures distinguish section permalinks from query-selected articles. */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { declaredMigrationArticleUrl, isMigrationUtilityUrl, observedMigrationArticleIdentity } from '../url-identity.js'
import { runUrlMigration, validateUrlMigration } from '../url-run.js'
import type { MigrationCapture } from '../url-run-types.js'

const source = 'https://docs.example.test'
function capture(path: string, extra = '', head = ''): MigrationCapture {
  return { finalUrl: new URL(path, source), contentType: 'text/html', body: `<html lang="en"><head>${head}</head><body><main><article><h1>Guide</h1><h2 id="install">Install</h2><p>Complete article with enough original technical content.</p><pre><code>setup(1)</code></pre>${extra}</article></main></body></html>` }
}

describe('observed URL article identity', () => {
  it('proposes only one observed anchor-valued query while preserving version identity', () => {
    const first = observedMigrationArticleIdentity(capture('/guide?version=v2&section=install'))!
    expect(first.canonicalUrl).toBe(`${source}/guide?version=v2`)
    expect(first.sectionAnchor).toBe('install')
    expect(observedMigrationArticleIdentity(capture('/guide?version=v2'))!.canonicalUrl).toBe(`${source}/guide?version=v2`)
    expect(observedMigrationArticleIdentity(capture('/guide?section=absent'))!.canonicalUrl).toBe(`${source}/guide?section=absent`)
    expect(observedMigrationArticleIdentity(capture('/guide?section=install&other=install'))!.canonicalUrl).toBe(`${source}/guide?section=install&other=install`)
  })

  it('ignores cross-origin and cross-route canonical claims and preserves directory-index behavior', () => {
    for (const canonical of ['https://elsewhere.test/guide', '/different', 'https://user:password@docs.example.test/guide']) {
      const page = capture('/guide?version=v2', '', `<link rel="canonical" href="${canonical}">`)
      expect(observedMigrationArticleIdentity(page)!.canonicalUrl).toBe(`${source}/guide?version=v2`)
      expect(declaredMigrationArticleUrl(page).href).toBe(page.finalUrl.href)
    }
    expect(declaredMigrationArticleUrl(capture('/guide/index', '', '<link rel="canonical" href="/guide">')).href).toBe(`${source}/guide`)
  })

  it('includes code whitespace, metadata and captured alternatives in exact article equality', () => {
    const base = capture('/guide')
    const fingerprint = observedMigrationArticleIdentity(base)!.articleSha256
    const changedCode = { ...base, body: base.body.replace('setup(1)', 'setup(1)\n') }
    const changedLocale = { ...base, locale: 'fr' }
    const changedTitle = capture('/guide', '', '<title>Different version</title>')
    const changedDeferred = capture('/guide', '', '<script type="application/json">{"deferredCode":"different()"}</script>')
    const changedState = { ...base, states: [{ id: 'python', label: 'Python', response: capture('/guide', '<pre><code>different()</code></pre>') }] }
    for (const changed of [changedCode, changedLocale, changedTitle, changedDeferred, changedState]) expect(observedMigrationArticleIdentity(changed)!.articleSha256).not.toBe(fingerprint)
  })

  it('recognizes exact provider utility endpoints without swallowing authored neighbors', () => {
    expect(isMigrationUtilityUrl(new URL('/cdn-cgi/l/email-protection#123', source))).toBe(true)
    for (const path of ['/guide/email-protection', '/cdn-cgi/l/email-protection-guide', '/cdn-cgi/article']) expect(isMigrationUtilityUrl(new URL(path, source))).toBe(false)
  })
})

describe('article identity journal integration', () => {
  it('captures each exact query, counts distinct articles, rewrites section links and resumes without recapture', async () => {
    const extra = '<a href="/guide?topic=install">Install permalink</a><a href="/cdn-cgi/l/email-protection#abc">Email</a>'
    const requested: string[] = []
    const run = await runUrlMigration({ sourceUrl: `${source}/guide`, concurrency: 3, captureProvider: { capture: async ({ url }) => {
      requested.push(url.href)
      if (url.pathname !== '/guide') throw new Error('Missing index')
      return capture(url.pathname + url.search, extra)
    } } })
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages).toHaveLength(1)
    expect(run.validation.counts.alias).toBe(1)
    expect(run.bundle.pages[0].body).toContain('[Install permalink](/guide#install)')
    expect(requested).toContain(`${source}/guide?topic=install`)
    expect(requested.some(url => url.includes('/cdn-cgi/'))).toBe(false)
    expect(run.checkpoint.records.find(record => record.url.endsWith('?topic=install'))).toMatchObject({ outcome: 'alias', aliasOf: `${source}/guide`, aliasAnchor: 'install', evidence: { articleIdentity: { canonicalUrl: `${source}/guide` } } })
    const checkpoint = JSON.parse(JSON.stringify(run.checkpoint))
    const resumed = await runUrlMigration({ sourceUrl: `${source}/guide`, checkpoint, captureProvider: { capture: async () => { throw new Error('Must reuse durable evidence') } } })
    expect(resumed).toEqual(run)
    checkpoint.records.find((record: { page?: unknown }) => record.page).page.body = '# Guide\n\nInstall without original anchor.'
    expect(validateUrlMigration(checkpoint).issues.some(issue => issue.code === 'missing-anchor')).toBe(true)
  })

  it.each([false, true])('preserves query-driven article changes even with canonical declaration=%s', async (declared) => {
    const run = await runUrlMigration({ sourceUrl: `${source}/guide`, captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing index')
      return capture(url.pathname + url.search, `${url.search ? '<p>Distinct selected article payload.</p>' : ''}<a href="/guide?topic=install">Query page</a>`, declared ? '<link rel="canonical" href="/guide">' : '')
    } } })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.pages).toHaveLength(2)
    expect(run.validation.counts.alias).toBe(0)
    expect(run.bundle.pages.map(page => page.id)).toEqual(['guide', expect.stringMatching(/^guide--[a-f0-9]+$/)])
  })

  it('does not replace a failed variant with a guessed section alias', async () => {
    const run = await runUrlMigration({ sourceUrl: `${source}/guide`, captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide' || url.search) throw new Error('Capture missing')
      return capture('/guide', '<a href="/guide?topic=install">Install</a>')
    } } })
    expect(run.validation.status).toBe('partial')
    expect(run.checkpoint.records.find(record => record.url.endsWith('?topic=install'))?.outcome).toBe('failed')
  })

  it('preserves each proven query section even when discovery contains only query URLs', async () => {
    const result = await runUrlMigration({ sourceUrl: `${source}/guide?section=install`, captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing index')
      return capture(url.pathname + url.search, '<h2 id="usage">Usage</h2><a href="?section=install">Install</a><a href="?section=usage">Usage</a>')
    } } })
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages).toHaveLength(1)
    expect(result.bundle.pages[0].body).toContain(`#install)`)
    expect(result.bundle.pages[0].body).toContain(`#usage)`)
  })

  it('retains version queries when an observed section parameter is removed', async () => {
    const result = await runUrlMigration({ sourceUrl: `${source}/guide`, captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing index')
      return capture(url.pathname + url.search, '<a href="?version=v2">Version two</a><a href="?version=v2&part=install">Version two section</a>')
    } } })
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages).toHaveLength(2)
    expect(result.checkpoint.records.find(record => record.url.endsWith('?version=v2&part=install'))).toMatchObject({ outcome: 'alias', aliasOf: `${source}/guide?version=v2`, aliasAnchor: 'install' })
  })

  it.each(['version', 'states'])('requires exact %s evidence before reusing a byte-identical article conversion', async kind => {
    const result = await runUrlMigration({ sourceUrl: `${source}/guide`, concurrency: 1, captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing index')
      const document = capture(url.pathname + url.search, '<a href="?part=install">Section</a>')
      if (url.search && kind === 'version') document.version = 'v2'
      if (url.search && kind === 'states') document.states = [{ id: 'other', label: 'Other language', response: capture('/guide', '<pre><code>other(2)</code></pre>') }]
      return document
    } } })
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages).toHaveLength(2)
    expect(result.validation.counts.alias).toBe(0)
  })

  it('retains each raw capture digest when literal email evidence proves randomized encodings equal', async () => {
    const bodies = new Map<string, string>()
    const result = await runUrlMigration({ sourceUrl: `${source}/guide`, concurrency: 1, captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing index')
      const encoded = url.search ? 'cba3aea7a7a48baeb3aaa6bba7aee5bfaeb8bf' : '1179747d7d7e517469707c617d743f65746265'
      const document = capture(url.pathname + url.search, `<a href="?part=install">Section</a><pre><code>contact("<a href="/cdn-cgi/l/email-protection" data-cfemail="${encoded}">[email protected]</a>")</code></pre>`)
      bodies.set(url.href, document.body)
      return document
    } } })
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages).toHaveLength(1)
    expect(result.bundle.pages[0].body).toContain('contact("hello@example.test")')
    const primary = result.checkpoint.records.find(record => record.page)!
    const alias = result.checkpoint.records.find(record => record.outcome === 'alias')!
    expect(alias.evidence!.sha256).not.toBe(primary.evidence!.sha256)
    expect(alias.evidence!.sha256).toBe(createHash('sha256').update(bodies.get(alias.url)!).digest('hex'))
    expect(alias.evidence!.articleIdentity!.articleSha256).toBe(primary.evidence!.articleIdentity!.articleSha256)
  })
})
