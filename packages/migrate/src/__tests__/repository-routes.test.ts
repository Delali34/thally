/** Route identity regressions for multilingual repositories with custom landing pages. */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateRepository, projectMintlifyNavigation } from '../index.js'
import { withoutDashboardWarning } from './dashboard-warning.js'

function repository(config: Record<string, unknown>, pages: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-routes-'))
  writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', ...config }))
  for (const [path, content] of Object.entries(pages)) {
    const destination = join(root, `${path}.mdx`)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
  }
  return root
}

describe('Mintlify repository route identity', () => {
  it('uses authored navigation for the root while retaining an unlisted custom home', () => {
    const root = repository({
      navigation: { groups: [{ group: 'Overview', pages: ['introduction/introduction'] }] },
    }, {
      home: '---\ntitle: Custom home\nmode: custom\n---\n\nA separate landing page.',
      'introduction/introduction': '# Documentation\n\nThe primary documentation overview.',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(bundle.pages.map((page) => page.id)).toEqual(['introduction/introduction', 'home'])
    expect(bundle.docsConfig.tabs[0].groups?.[0].pages).toEqual(['introduction/introduction'])
    expect(bundle.docsConfig.redirects).toEqual(expect.arrayContaining([
      { source: '/', destination: '/introduction/introduction', permanent: true },
      { source: '/introduction', destination: '/introduction/introduction', permanent: false },
    ]))
  })

  it('aligns directory and legacy section translations with default navigation', () => {
    const root = repository({
      navigation: { languages: [
        { language: 'zh-hans', groups: [{ group: '指南', pages: [
          'zh-Hans/introduction/introduction', 'zh-hans-api-reference/getToken',
        ] }] },
        { language: 'en', default: true, groups: [{ group: 'Guide', pages: [
          'introduction/introduction', 'api-reference/getToken',
        ] }] },
      ] },
    }, {
      'introduction/introduction': '# Overview\n\nDefault overview.',
      'api-reference/getToken': '# Get token\n\nDefault API reference.',
      'zh-Hans/introduction/introduction': '# 概览\n\n翻译。',
      'zh-hans-api-reference/getToken': '---\ntitle: 代币\n---\n\n翻译。',
      'zh-hans-api-reference/unlisted': '# Additional endpoint\n\nNo canonical counterpart.',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(bundle.docsConfig.i18n).toMatchObject({ defaultLocale: 'en', locales: [{ code: 'zh-Hans' }, { code: 'en' }] })
    expect(bundle.docsConfig.tabs[0].groups?.[0].pages).toEqual(['introduction/introduction', 'api-reference/getToken'])
    expect(bundle.pages.find((page) => page.id === 'zh-Hans/api-reference/getToken')).toMatchObject({
      navigationId: 'api-reference/getToken', locale: 'zh-Hans', title: '代币',
    })
    expect(bundle.pages.some((page) => page.id === 'zh-hans-api-reference/unlisted')).toBe(true)
    expect(bundle.docsConfig.redirects).toEqual(expect.arrayContaining([
      { source: '/zh-hans-api-reference/getToken', destination: '/zh-Hans/api-reference/getToken', permanent: false },
      { source: '/zh-Hans', destination: '/zh-Hans/introduction/introduction', permanent: false },
      { source: '/introduction', destination: '/introduction/introduction', permanent: false },
      { source: '/zh-Hans/introduction', destination: '/zh-Hans/introduction/introduction', permanent: false },
    ]))
    expect(withoutDashboardWarning(bundle.warnings)).toEqual([])
  })

  it('preserves source redirects and default-language directory aliases', () => {
    const root = repository({
      redirects: [{ source: '/', destination: '/home', permanent: true }],
      navigation: { languages: [{ language: 'en', groups: [{ group: 'Guide', pages: ['en/guides/start'] }] }] },
    }, {
      home: '# Welcome\n\nCustom landing page.',
      'en/guides/start': '# Start\n\nStart the integration.',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(bundle.docsConfig.redirects?.filter((redirect) => redirect.source === '/')).toEqual([
      { source: '/', destination: '/home', permanent: true },
    ])
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/en/guides/start', destination: '/guides/start', permanent: false })
  })

  it('does not double the locale segment when a versioned layout nests it mid-path (CrewAI shape)', () => {
    // CrewAI's real docs.json: navigation.languages[].versions[].tabs, where
    // every version's own page references already embed the locale one
    // level in ("edge/ar/introduction", not "ar/edge/introduction" nor
    // plain "introduction"). Locale prefixing the raw navigationId on top
    // of that produced "ar/edge/ar/introduction" — the locale twice.
    const root = repository({
      navigation: { languages: [
        { language: 'en', default: true, versions: [
          { version: 'edge', groups: [{ group: 'Guide', pages: ['edge/en/introduction'] }] },
        ] },
        { language: 'ar', versions: [
          { version: 'edge', groups: [{ group: 'Guide', pages: ['edge/ar/introduction'] }] },
        ] },
      ] },
    }, {
      'edge/en/introduction': '# Introduction\n\nDefault overview.',
      'edge/ar/introduction': '---\ntitle: مقدمة\n---\n\nترجمة.',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    // Shared nav is locale-independent: no "en" or "ar" baked into the ref.
    expect(bundle.docsConfig.tabs[0].groups?.[0].pages).toEqual(['edge/introduction'])
    // Default-locale content lives at the plain id, matching the shared nav.
    expect(bundle.pages.some((page) => page.id === 'edge/introduction')).toBe(true)
    // Non-default locale gets exactly one locale segment, not two.
    const arabic = bundle.pages.find((page) => page.locale === 'ar')
    expect(arabic).toMatchObject({ id: 'ar/edge/introduction', navigationId: 'edge/introduction' })
    expect(bundle.pages.some((page) => page.id?.startsWith('ar/edge/ar/'))).toBe(false)
  })

  it('redirects a version-less link to the default version (CrewAI shape)', () => {
    // CrewAI's live site serves each version at a URL prefixed with its
    // identifier ("/v2/en/learn/x"), including the default version's own
    // pages — but a link that omits the version ("/en/learn/x", as authored
    // elsewhere in the same docs) still 307s to the default version there.
    // Thally has no unprefixed route for that page (every version, default
    // included, keeps its identifier as a literal path segment), so the
    // migrated site needs the same redirect or that link just dead-ends.
    const root = repository({
      navigation: { languages: [{ language: 'en', default: true, versions: [
        { version: 'v1', groups: [{ group: 'Guide', pages: ['v1/en/learn/x'] }] },
        { version: 'v2', default: true, groups: [{ group: 'Guide', pages: ['v2/en/learn/x'] }] },
      ] }] },
    }, {
      'v1/en/learn/x': '# X\n\nOld version.',
      'v2/en/learn/x': '# X\n\nCurrent version.',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(bundle.pages.some((page) => page.id === 'v2/learn/x')).toBe(true)
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/en/learn/x', destination: '/v2/learn/x', permanent: false })
    // The non-default version keeps its identifier; no bare alias for it.
    expect(bundle.docsConfig.redirects).not.toContainEqual(
      expect.objectContaining({ source: '/en/learn/x', destination: '/v1/learn/x' }),
    )
  })

  it('skips invalid locale directories without discarding valid navigation', () => {
    const projected = projectMintlifyNavigation({ navigation: { languages: [
      { language: '../../escape', pages: ['unsafe'] },
      { language: 'en', pages: ['introduction'] },
    ] } })
    expect(projected.pageReferences).toEqual([{ ref: 'introduction', navigationId: 'introduction', locale: 'en' }])
    expect(projected.warnings).toHaveLength(1)
  })

  it('keeps a shared source file in the primary language and avoids self redirects', () => {
    const root = repository({ navigation: { languages: [
      { language: 'en', pages: ['introduction'] },
      { language: 'fr', pages: ['introduction'] },
    ] } }, { introduction: '# Welcome\n\nA shared overview for both language menus.' })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(bundle.pages.map((page) => page.id)).toEqual(['introduction'])
    // `/` still goes to /introduction, but /fr has no page of its own to go to.
    expect(bundle.docsConfig.redirects).toEqual([{ source: '/', destination: '/introduction', permanent: true }])
  })
})


describe('Mintlify mounted machine links', () => {
  it('retains the Markdown mirror format while removing a proven source mount', () => {
    const root = repository({ navigation: { groups: [{ group: 'Guide', pages: ['introduction', 'guide'] }] } }, { introduction: '# Welcome\n\n[Mirror](/docs/guide.md#example)\n', guide: '# Guide\n\nExample.' })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(bundle.pages.find((page) => page.id === 'introduction')?.body).toContain('[Mirror](/guide.md#example)')
  })
})


describe('Mintlify source document links', () => {
  it('maps proven MDX filenames to HTML while retaining Markdown mirror requests', () => {
    const root = repository({ navigation: { groups: [{ group: 'Guide', pages: ['introduction', 'quickstart'] }] } }, { introduction: '# Welcome\n\n[HTML](/quickstart.mdx#run) [Mounted HTML](/docs/quickstart.mdx) [Mirror](/quickstart.md) [Unknown](/missing.mdx)', quickstart: '# Quickstart\n\nRun the example.' })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    const body = bundle.pages.find((page) => page.id === 'introduction')?.body
    expect(body).toContain('[HTML](/quickstart#run)')
    expect(body).toContain('[Mounted HTML](/quickstart)')
    expect(body).toContain('[Mirror](/quickstart.md)')
    expect(body).toContain('[Unknown](/missing.mdx)')
  })
})

describe('generated API route inventory matches runtime catch-all routing', () => {
  it('lists actual operation routes and /api redirect, without inventing spec-root landing pages', async () => {
    const { migrationApiRoutes } = await import('../repository.js')
    const bundle = {
      docsConfig: { tabs: [{ tab: 'API', api: { source: 'openapi/first.json' } }, { tab: 'Secondary', api: { source: 'openapi/second.json' } }] },
      assets: ['first', 'second'].map((name) => ({ path: `openapi/${name}.json`, projectRelative: true, content: Buffer.from(JSON.stringify({ openapi: '3.0.0', paths: { '/users': { get: { responses: {} } } } })) })),
    }
    expect(migrationApiRoutes(bundle).sort()).toEqual(['/api', '/api/default/users/get', '/api/secondary/users/get'])
  })
  it('does not advertise /api when the default spec has no operations to redirect to', async () => {
    const { migrationApiRoutes } = await import('../repository.js')
    expect(migrationApiRoutes({ docsConfig: { tabs: [{ tab: 'API', api: { source: 'openapi/empty.json' } }] }, assets: [{ path: 'openapi/empty.json', content: Buffer.from('{"openapi":"3.0.0","paths":{}}'), projectRelative: true }] })).toEqual([])
  })
})
