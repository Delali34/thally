/** Redirecting source leaves retain distinct sidebar labels through portable page metadata. */
import { describe, expect, it } from 'vitest'
import { renderMigrationFiles } from '../render.js'
import { runUrlMigration } from '../url-run.js'
import type { MigrationNavigationOccurrence, UrlMigrationRunOptions } from '../url-run-types.js'

const origin = 'https://docs.test'
const primary = '/docs/dashboard/domains/tracking'
const alias = '/docs/knowledge-base/why-open-rates'
const article = '<article><h1>Tracking</h1><p>Tracking preserves open-rate evidence.</p><h2 id="configuration">Configuration</h2><p>Configure tracking for your domain.</p></article>'
const navigation: Array<MigrationNavigationOccurrence> = [
  { label: 'Dashboard', children: [{ label: 'Tracking', url: `${origin}${primary}` }] },
  { label: 'Knowledge base', children: [{ label: 'Why are my open rates not accurate', url: `${origin}${alias}` }] },
]

function options(overrides: Partial<UrlMigrationRunOptions> = {}): UrlMigrationRunOptions {
  return { sourceUrl: `${origin}${primary}`, scopePath: '/docs', concurrency: 1,
    captureProvider: { capture: async ({ url }) => {
      if ([primary, alias].includes(url.pathname)) return { finalUrl: new URL(primary, origin), contentType: 'text/html', body: article, navigation }
      throw new Error('No discovery index')
    } }, ...overrides }
}

describe('redirect aliases with authored navigation labels', () => {
  it.each([primary, alias])('preserves both leaf labels when the first captured URL is %s', async source => {
    const run = await runUrlMigration(options({ sourceUrl: `${origin}${source}`, concurrency: 4 }))
    expect(run.validation.issues).toEqual([])
    expect(run.validation.counts).toMatchObject({ imported: 1, alias: 1, failed: 0, pending: 0 })
    expect(run.bundle.docsConfig.tabs[0].pages).toEqual([
      { group: 'Dashboard', pages: ['dashboard/domains/tracking'] },
      { group: 'Knowledge base', pages: ['knowledge-base/why-open-rates'] },
    ])
    const canonical = run.bundle.pages.find(page => page.id === 'dashboard/domains/tracking')!
    const redirect = run.bundle.pages.find(page => page.id === 'knowledge-base/why-open-rates')!
    expect(canonical.navTitle).toBe('Tracking')
    expect(canonical.noindex).toBeUndefined()
    expect(redirect).toMatchObject({ navTitle: 'Why are my open rates not accurate', noindex: true, source: `${origin}${alias}`, body: canonical.body })
    expect(run.bundle.docsConfig.redirects).toEqual([{ source: '/knowledge-base/why-open-rates', destination: '/dashboard/domains/tracking', permanent: true }])
    const files = renderMigrationFiles(run.bundle)
    expect(files.find(file => file.path === 'src/content/knowledge-base/why-open-rates.mdx')?.content).toContain('navTitle: "Why are my open rates not accurate"')
    expect(files.find(file => file.path === 'src/content/knowledge-base/why-open-rates.mdx')?.content).toContain('noindex: true')
    const replay = await runUrlMigration(options({ sourceUrl: `${origin}${source}`, checkpoint: JSON.parse(JSON.stringify(run.checkpoint)),
      captureProvider: { capture: async () => { throw new Error('A completed journal must not recapture') } } }))
    expect(replay).toEqual(run)
  })

  it('prefers the final article label even when alias navigation appears first', async () => {
    const run = await runUrlMigration(options({ captureProvider: { capture: async ({ url }) => {
      if ([primary, alias].includes(url.pathname)) return { finalUrl: new URL(primary, origin), contentType: 'text/html', body: article, navigation: [...navigation].reverse() }
      throw new Error('No discovery index')
    } } }))
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages.find(page => page.id === 'dashboard/domains/tracking')?.navTitle).toBe('Tracking')
    expect(run.bundle.pages.find(page => page.id === 'knowledge-base/why-open-rates')?.navTitle).toBe('Why are my open rates not accurate')
  })

  it('does not create a conflict or duplicate page when alias labels already agree', async () => {
    const run = await runUrlMigration(options({ captureProvider: { capture: async ({ url }) => {
      if ([primary, alias].includes(url.pathname)) return { finalUrl: new URL(primary, origin), contentType: 'text/html', body: article,
        navigation: navigation.map(group => ({ ...group, children: group.children!.map(node => ({ ...node, label: 'Tracking' })) })) }
      throw new Error('No discovery index')
    } } }))
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages).toHaveLength(1)
    expect(run.bundle.pages[0].navTitle).toBe('Tracking')
    expect(run.bundle.docsConfig.redirects).toBeUndefined()
  })

  it('reuses one alias metadata page across repeated occurrences of its label', async () => {
    const run = await runUrlMigration(options({ captureProvider: { capture: async ({ url }) => {
      if ([primary, alias].includes(url.pathname)) return { finalUrl: new URL(primary, origin), contentType: 'text/html', body: article,
        navigation: [...navigation, { label: 'Troubleshooting', children: navigation[1].children }] }
      throw new Error('No discovery index')
    } } }))
    expect(run.validation.issues).toEqual([])
    expect(run.bundle.pages).toHaveLength(2)
    expect(run.bundle.docsConfig.redirects).toHaveLength(1)
    expect(run.bundle.docsConfig.tabs[0].pages).toContainEqual({ group: 'Troubleshooting', pages: ['knowledge-base/why-open-rates'] })
  })

  it('does not overwrite an independently imported page at the alias destination', async () => {
    const collision = `${alias}.html`
    const run = await runUrlMigration(options({ captureProvider: { capture: async ({ url }) => {
      if (url.pathname === collision) return { finalUrl: url, contentType: 'text/html', body: '<article><h1>Separate page</h1><p>Independently authored content.</p></article>' }
      if ([primary, alias].includes(url.pathname)) return { finalUrl: new URL(primary, origin), contentType: 'text/html', body: article,
        navigation: [...navigation, { label: 'Separate page', url: `${origin}${collision}` }] }
      throw new Error('No discovery index')
    } } }))
    expect(run.bundle.pages).toHaveLength(2)
    expect(run.bundle.pages.find(page => page.id === 'knowledge-base/why-open-rates')?.body).toContain('Independently authored content.')
    expect(run.bundle.docsConfig.redirects).toBeUndefined()
    expect(run.validation.status).toBe('partial')
    expect(run.validation.issues).toContainEqual(expect.objectContaining({ code: 'unsupported-component', message: expect.stringContaining('cannot retain distinct sidebar titles safely') }))
  })

  it('keeps incompatible labels on the exact same route visible as a validation issue', async () => {
    const run = await runUrlMigration(options({ captureProvider: { capture: async ({ url }) => {
      if (url.pathname === primary) return { finalUrl: url, contentType: 'text/html', body: article,
        navigation: navigation.map(group => ({ ...group, children: group.children!.map(node => ({ ...node, url: `${origin}${primary}` })) })) }
      throw new Error('No discovery index')
    } } }))
    expect(run.bundle.pages).toHaveLength(1)
    expect(run.validation.status).toBe('partial')
    expect(run.validation.issues).toContainEqual(expect.objectContaining({ code: 'unsupported-component', message: expect.stringContaining('cannot retain distinct sidebar titles safely') }))
  })
})
