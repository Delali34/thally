/** Merge invariants for importing into an existing localized Thally site. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { mergeMigrationConfig } from '../index.js'
import { migrateRepository } from '../repository.js'
import { renderMigrationFiles } from '../render.js'

const roots: Array<string> = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** Migrate a one-off Mintlify source and return the rendered page file for `id`. */
function renderedPage(files: Record<string, string>, id: string): string {
  const root = mkdtempSync(join(tmpdir(), 'thally-render-'))
  roots.push(root)
  const all = { 'docs.json': JSON.stringify({ name: 'Acme', navigation: { pages: ['intro'] } }), ...files }
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
  return String(renderMigrationFiles(bundle).find((file) => file.path === `src/content/${id}.mdx`)!.content)
}

describe('page social metadata', () => {
  it('carries og:title and og:description into the migrated page and sets the Mintlify title separator', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-meta-'))
    roots.push(root)
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ name: 'Acme Docs', navigation: { pages: ['intro'] } }))
    writeFileSync(join(root, 'intro.mdx'), '---\ntitle: Intro page\nog:title: "Intro | Acme"\nog:description: "Short blurb"\n---\nHello\n')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = String(renderMigrationFiles(bundle).find((file) => file.path === 'src/content/intro.mdx')!.content)
    expect(page).toContain('ogTitle: "Intro | Acme"')
    expect(page).toContain('ogDescription: "Short blurb"')
    expect(bundle.docsConfig.seo?.titleSeparator).toBe(' - ')
    expect(bundle.docsConfig.seo?.sitemap).toBe('navigable')
  })
})

describe('page icon frontmatter', () => {
  it('carries icon and a supported iconType into the migrated page', () => {
    const out = renderedPage({ 'intro.mdx': '---\ntitle: Intro\nicon: book-open\niconType: solid\n---\nHello\n' }, 'intro')
    expect(out).toContain('icon: "book-open"')
    expect(out).toContain('iconType: "solid"')
  })
})

describe('migration config merge', () => {
  it('unions existing and imported locales without duplicating page ids', () => {
    const merged = mergeMigrationConfig(
      {
        tabs: [{ tab: 'Existing', groups: [{ group: 'Start', pages: ['introduction'] }] }],
        navigation: { display: 'tabs' },
        i18n: {
          defaultLocale: 'en',
          locales: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Español' }],
        },
      },
      {
        tabs: [{ tab: 'Documentation', groups: [{ group: 'Start', pages: ['introduction', 'guides/install'] }] }],
        navigation: { display: 'dropdown' },
        i18n: {
          defaultLocale: 'en',
          locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }],
        },
      },
    )

    expect(merged.i18n?.locales.map((locale) => locale.code)).toEqual(['en', 'es', 'fr'])
    expect(merged.navigation).toEqual({ display: 'dropdown' })
    expect(merged.tabs).toEqual([
      { tab: 'Existing', groups: [{ group: 'Start', pages: ['introduction'] }] },
      { tab: 'Documentation', groups: [{ group: 'Start', pages: ['guides/install'] }] },
    ])
  })

  it('deduplicates and merges root navigation nodes without adding a wrapper group', () => {
    const merged = mergeMigrationConfig(
      {
        tabs: [{ tab: 'Documentation', pages: ['introduction'] }],
      },
      {
        tabs: [{
          tab: 'Documentation',
          pages: [
            'introduction',
            { group: 'Guides', pages: ['guides/install'] },
          ],
          groups: [{ group: 'Reference', pages: ['reference/api'] }],
        }],
      },
    )

    expect(merged.tabs).toEqual([{
      tab: 'Documentation',
      pages: [
        'introduction',
        { group: 'Guides', pages: ['guides/install'] },
        { group: 'Reference', pages: ['reference/api'] },
      ],
    }])
  })
})

describe('in-place imported navbar branding', () => {
  function importedBrand() {
    const root = mkdtempSync(join(tmpdir(), 'thally-render-brand-'))
    roots.push(root)
    mkdirSync(join(root, 'images'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ name: 'Imported Docs', logo: { light: '/images/logo.svg', dark: '/images/logo-dark.svg' }, navigation: { groups: [{ group: 'Guide', pages: ['intro'] }] } }))
    writeFileSync(join(root, 'intro.mdx'), '# Intro\n\nImported documentation.')
    for (const name of ['logo.svg', 'logo-dark.svg']) writeFileSync(join(root, 'images', name), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')
    return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
  }
  it('retains light/dark imported logo paths and their emitted assets when the starter only supplied a primary action', () => {
    const rendered = renderMigrationFiles(importedBrand(), { existingConfig: { tabs: [], navbar: { primary: { label: 'Start', href: '/quickstart' } } } })
    const config = JSON.parse(String(rendered.find((file) => file.path === 'docs.json')!.content))
    expect(config.navbar).toEqual({ primary: { label: 'Start', href: '/quickstart' }, logo: { light: '/images/logo.svg', dark: '/images/logo-dark.svg', showTitle: false } })
    for (const mode of ['light', 'dark']) expect(rendered.some((file) => file.path === `public${config.navbar.logo[mode]}`)).toBe(true)
  })
  it.each([null, { light: '/owner/light.svg', dark: '/owner/dark.svg', showTitle: true }])('preserves the owner explicit navbar logo %j', (logo) => {
    const rendered = renderMigrationFiles(importedBrand(), { existingConfig: { tabs: [], navbar: { primary: null, logo } } })
    const config = JSON.parse(String(rendered.find((file) => file.path === 'docs.json')!.content))
    expect(config.navbar.logo).toEqual(logo)
    expect(config.navbar.primary).toBeNull()
  })
})

describe('in-place redirect preservation', () => {
  it('merges imported aliases while preserving owner precedence for equivalent sources', () => {
    const merged = mergeMigrationConfig({ tabs: [], redirects: [{ source: '/Owner-Alias/', destination: '/owner-target', permanent: false }] }, { tabs: [], redirects: [{ source: '/owner-alias', destination: '/imported-target', permanent: true }, { source: '/new-alias', destination: '/canonical', permanent: true }] })
    expect(merged.redirects).toEqual([{ source: '/Owner-Alias/', destination: '/owner-target', permanent: false }, { source: '/new-alias', destination: '/canonical', permanent: true }])
  })
  it('does not introduce an alias cycle through an existing owner redirect', () => {
    const merged = mergeMigrationConfig({ tabs: [], redirects: [{ source: '/canonical', destination: '/alias', permanent: false }] }, { tabs: [], redirects: [{ source: '/alias', destination: '/canonical', permanent: true }] })
    expect(merged.redirects).toEqual([{ source: '/canonical', destination: '/alias', permanent: false }])
  })
  it.each(['/x/../canonical', '/%2e%2e/canonical', '/x/%2E%2e/canonical?lang=go#response', '/canonical?lang=go#response'])('rejects imported cycles after browser destination normalization: %s', (destination) => {
    const owner = [{ source: '/canonical', destination: '/alias', permanent: false }]
    const merged = mergeMigrationConfig({ tabs: [], redirects: owner }, { tabs: [], redirects: [{ source: '/alias', destination, permanent: true }] })
    expect(merged.redirects).toEqual(owner)
  })
  it.each(['/x/../alias', '/%2e%2e/alias', '/x/%2E%2e/alias?lang=go#response'])('normalizes an existing owner destination when checking imported cycles: %s', (destination) => {
    const owner = [{ source: '/canonical', destination, permanent: false }]
    const merged = mergeMigrationConfig({ tabs: [], redirects: owner }, { tabs: [], redirects: [{ source: '/alias', destination: '/canonical', permanent: true }] })
    expect(merged.redirects).toEqual(owner)
  })
  it('retains safe imported destinations verbatim, including external addresses and normalized paths', () => {
    const owner = [{ source: '/canonical', destination: '/alias', permanent: false }]
    const incoming = [{ source: '/new', destination: '/x/../guide?lang=go#response', permanent: true }, { source: '/alias', destination: 'https://example.com/canonical', permanent: true }, { source: '/other', destination: '//example.com/canonical', permanent: true }]
    const merged = mergeMigrationConfig({ tabs: [], redirects: owner }, { tabs: [], redirects: incoming })
    expect(merged.redirects).toEqual([...owner, ...incoming])
  })
})
