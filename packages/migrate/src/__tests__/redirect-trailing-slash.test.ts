/**
 * Next removes the trailing slash from a request before it looks for a redirect, so an exact source
 * written with one never matches. Every platform's exact redirect sources are written without it; a
 * pattern source is left as written, because stripping its slash would start a redirect that can loop.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateRepository } from '../index.js'
import { dropConflictingRedirects, dropUnroutableRedirects } from '../redirects.js'
import type { MigrationDocsConfig, MigrationWarning } from '../types.js'

type Redirects = NonNullable<MigrationDocsConfig['redirects']>

function normalized(redirects: Redirects): { redirects: Redirects; warnings: Array<MigrationWarning> } {
  const warnings: Array<MigrationWarning> = []
  const result = dropUnroutableRedirects({ tabs: [], redirects }, warnings)
  return { redirects: result.redirects ?? [], warnings }
}

describe('redirect sources with a trailing slash', () => {
  it('writes an exact source without the slash and keeps the rest of the redirect', () => {
    const { redirects, warnings } = normalized([
      { source: '/libsql/client-access/', destination: '/sdk' },
      { source: '/old/', destination: '/new', permanent: true },
      { source: '/a//', destination: '/b' },
    ])
    expect(redirects).toEqual([
      { source: '/libsql/client-access', destination: '/sdk' },
      { source: '/old', destination: '/new', permanent: true },
      { source: '/a', destination: '/b' },
    ])
    expect(warnings).toEqual([])
  })

  it('leaves a pattern source exactly as written, so no redirect that never matched starts to loop', () => {
    // Stripped, these would match and send /docs/a to /docs/v2/a, /docs/v2/v2/a, ... and /Docs/a to /docs/a for ever (Next ignores case).
    const input: Redirects = [
      { source: '/docs/:path*/', destination: '/docs/v2/:path*' },
      { source: '/Docs/:path*/', destination: '/docs/:path*' },
      { source: '/docs/:path*/', destination: '/docs/:path*' },
      { source: '/blog/:path*/', destination: '/blog/:path*?from=old' },
      { source: '/api/:version/', destination: '/api/:version/v2' },
    ]
    const { redirects, warnings } = normalized(input)
    expect(redirects).toEqual(input)
    expect(warnings).toEqual([])
  })

  it('never shortens the root', () => {
    expect(normalized([{ source: '/', destination: '/guide' }]).redirects).toEqual([{ source: '/', destination: '/guide' }])
  })

  it('keeps the first redirect when a slash source and a plain one are the same address, and says so', () => {
    const slashFirst = normalized([
      { source: '/a/', destination: '/x' },
      { source: '/a', destination: '/y' },
      { source: '/b', destination: '/z' },
    ])
    expect(slashFirst.redirects).toEqual([{ source: '/a', destination: '/x' }, { source: '/b', destination: '/z' }])
    expect(slashFirst.warnings).toHaveLength(1)
    expect(slashFirst.warnings[0].message).toBe("Skipped 1 redirect from /a: its source differs from an earlier redirect's source only by a trailing slash, which Thally ignores when matching, so the earlier redirect was kept. Check it in the source docs.")

    const plainFirst = normalized([
      { source: '/a', destination: '/y' },
      { source: '/a/', destination: '/x' },
    ])
    expect(plainFirst.redirects).toEqual([{ source: '/a', destination: '/y' }])
    expect(plainFirst.warnings[0].message).toContain('Skipped 1 redirect from /a/: its source differs')
  })

  it('lists only the dropped sources in one warning when several repeat an earlier one', () => {
    const { redirects, warnings } = normalized([
      { source: '/a/', destination: '/x' },
      { source: '/a', destination: '/y' },
      { source: '/b', destination: '/z' },
      { source: '/b/', destination: '/w' },
    ])
    expect(redirects).toEqual([{ source: '/a', destination: '/x' }, { source: '/b', destination: '/z' }])
    expect(warnings.map((warning) => warning.message)).toEqual(["Skipped 2 redirects from /a, /b/: each source differs from an earlier redirect's source only by a trailing slash, which Thally ignores when matching, so the earlier redirect was kept. Check them in the source docs."])
  })

  it('omits a redirect whose source becomes its own destination, which would loop for ever', () => {
    const exact = normalized([{ source: '/a/', destination: '/a' }, { source: '/a', destination: '/y' }])
    expect(exact.redirects).toEqual([{ source: '/a', destination: '/y' }])
    expect(exact.warnings.map((warning) => warning.message)).toEqual(['Self-redirect from /a/ to /a was omitted.'])

    // Next matches a redirect source without regard to letter case, so these loop as well.
    const cased = normalized([
      { source: '/Docs/', destination: '/docs' },
      { source: '/Guide/', destination: '/guide/' },
      { source: '/Docs', destination: '/y' },
    ])
    expect(cased.redirects).toEqual([{ source: '/Docs', destination: '/y' }])
    expect(cased.warnings.map((warning) => warning.message)).toEqual([
      'Self-redirect from /Docs/ to /docs was omitted.',
      'Self-redirect from /Guide/ to /guide/ was omitted.',
    ])
  })

  it('leaves a redirect from a different letter case to the conflict check when it had no slash to lose', () => {
    const input: Redirects = [{ source: '/Docs', destination: '/docs' }]
    expect(normalized(input).redirects).toEqual(input)
  })

  it('catches a cycle that a stripped source closes, with the check the other redirects go through', () => {
    const warnings: Array<MigrationWarning> = []
    const unroutable = dropUnroutableRedirects({ tabs: [], redirects: [{ source: '/a/', destination: '/b' }, { source: '/b', destination: '/a' }, { source: '/keep/', destination: '/c' }] }, warnings)
    const result = dropConflictingRedirects(unroutable, [], warnings)
    expect(result.redirects).toEqual([{ source: '/a', destination: '/b' }, { source: '/keep', destination: '/c' }])
    expect(warnings.map((warning) => warning.message)).toEqual([expect.stringContaining('would send visitors in a circle: /b -> /a')])
  })

  it('leaves a repeated source alone when no trailing slash is involved', () => {
    const { redirects, warnings } = normalized([
      { source: '/a', destination: '/x' },
      { source: '/a', destination: '/y' },
    ])
    expect(redirects).toHaveLength(2)
    expect(warnings).toEqual([])
  })
})

describe('redirect sources with a trailing slash, by platform', () => {
  const pages = { index: '# Home\n\nWelcome.', sdk: '# SDK\n\nBody.' }

  it('migrates a Mintlify redirect source with a trailing slash', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-redirect-slash-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { groups: [{ group: 'Start', pages: ['index', 'sdk'] }] },
      redirects: [{ source: '/libsql/client-access/', destination: '/sdk' }],
    }))
    for (const [name, content] of Object.entries(pages)) writeFileSync(join(root, `${name}.mdx`), content)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
    expect(bundle.docsConfig.redirects).toContainEqual(expect.objectContaining({ source: '/libsql/client-access', destination: '/sdk' }))
    expect((bundle.docsConfig.redirects ?? []).map((redirect) => redirect.source)).not.toContain('/libsql/client-access/')
  })

  it('writes a Mintlify exact source without the slash and a pattern source as written', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-redirect-slash-pattern-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { groups: [{ group: 'Start', pages: ['index', 'sdk'] }] },
      redirects: [{ source: '/docs/:path*/', destination: '/docs/v2/:path*' }, { source: '/old/', destination: '/sdk' }],
    }))
    for (const [name, content] of Object.entries(pages)) writeFileSync(join(root, `${name}.mdx`), content)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
    const sources = (bundle.docsConfig.redirects ?? []).map((redirect) => redirect.source)
    expect(sources).toContain('/old')
    expect(sources).toContain('/docs/:path*/')
    expect(sources).not.toContain('/docs/:path*')
  })

  it('migrates a Fern redirect source with a trailing slash', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-redirect-slash-fern-'))
    mkdirSync(join(root, 'fern'))
    writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
    writeFileSync(join(root, 'fern', 'docs.yml'), [
      'title: Docs',
      'navigation:',
      '  - page: SDK',
      '    path: sdk.mdx',
      'redirects:',
      '  - source: /libsql/client-access/',
      '    destination: /sdk',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'fern', 'sdk.mdx'), pages.sdk)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    const sources = (bundle.docsConfig.redirects ?? []).map((redirect) => redirect.source)
    expect(sources).toContain('/libsql/client-access')
    expect(sources).not.toContain('/libsql/client-access/')
  })

  it('migrates a Docusaurus redirect source with a trailing slash', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-redirect-slash-docusaurus-'))
    writeFileSync(join(root, 'docusaurus.config.js'), [
      'module.exports = { presets: [["classic", { docs: {} }]], plugins: [["@docusaurus/plugin-client-redirects", { redirects: [',
      '  { from: "/libsql/client-access/", to: "/sdk" },',
      '] }]] }',
    ].join('\n'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'sdk.md'), pages.sdk)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    const sources = (bundle.docsConfig.redirects ?? []).map((redirect) => redirect.source)
    expect(sources).toContain('/libsql/client-access')
    expect(sources).not.toContain('/libsql/client-access/')
  })
})
