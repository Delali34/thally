/** Mintlify group `directory`: a root page lists its group's pages as cards. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { compile } from '@mdx-js/mdx'
import { describe, expect, it } from 'vitest'

import { migrateRepository, parseMarkdownPage, projectMintlifyNavigation } from '../index.js'
import type { MigrationBundle, MigrationFetcher } from '../index.js'
import { appendMintlifyDirectories } from '../mintlify-directory.js'
import { hydrateRemoteApiSpecs } from '../remote-api.js'

const MARKER = '{/* thally:directory */}'

function site(navigation: unknown, files: Record<string, string>): MigrationBundle {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-directory-'))
  const all = { 'docs.json': JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation }), ...files }
  for (const [name, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
}

const doc = (title: string, description?: string, extra = ''): string =>
  `---\ntitle: ${JSON.stringify(title)}\n${description ? `description: ${JSON.stringify(description)}\n` : ''}${extra}---\n\nBody of ${title}.\n`
const bodyOf = (bundle: MigrationBundle, id: string): string => bundle.pages.find((page) => page.id === id)!.body
const directoryOf = (bundle: MigrationBundle, id: string): string => bodyOf(bundle, id).split(MARKER)[1] ?? ''
const directoryWarnings = (bundle: MigrationBundle) => bundle.warnings.filter((warning) => /directory/i.test(warning.message))

describe('Mintlify group directory', () => {
  it('lists the root group pages as cards, then each nested group under a plain label with its own cards', () => {
    const bundle = site({ pages: [
      'intro',
      { group: 'Guides', root: 'guides/overview', directory: 'card', pages: [
        'guides/first',
        { group: 'Deep', root: 'guides/deep/overview', pages: ['guides/deep/one', 'guides/deep/two'] },
        'guides/second',
        { group: 'Plain', pages: ['guides/plain/only'] },
      ] },
    ] }, {
      'intro.mdx': doc('Intro'),
      'guides/overview.mdx': doc('Guides overview'),
      'guides/first.mdx': doc('First page', 'About the first page.', 'sidebarTitle: Sidebar one\nicon: rocket\n'),
      'guides/second.mdx': doc('Second page'),
      'guides/deep/overview.mdx': doc('Deep overview'),
      'guides/deep/one.mdx': doc('Deep one', 'Deep one text.'),
      'guides/deep/two.mdx': doc('Deep two', 'Deep two text.'),
      'guides/plain/only.mdx': doc('Plain only', 'Plain only text.'),
    })
    const body = bodyOf(bundle, 'guides/overview')
    expect(body.startsWith('Body of Guides overview.')).toBe(true)
    expect(directoryOf(bundle, 'guides/overview')).toBe([
      '',
      '',
      '<CardGroup cols={1}>',
      '  <Card title="First page" href="/guides/first" icon="rocket">About the first page.</Card>',
      '  <Card title="Second page" href="/guides/second" />',
      '</CardGroup>',
      '',
      '**[Deep](/guides/deep/overview)**',
      '',
      '<CardGroup cols={1}>',
      '  <Card title="Deep one" href="/guides/deep/one">Deep one text.</Card>',
      '  <Card title="Deep two" href="/guides/deep/two">Deep two text.</Card>',
      '</CardGroup>',
      '',
      '**Plain**',
      '',
      '<CardGroup cols={1}>',
      '  <Card title="Plain only" href="/guides/plain/only">Plain only text.</Card>',
      '</CardGroup>',
      '',
    ].join('\n'))
    // A group label is not a heading, so the table of contents gains no entry.
    expect(directoryOf(bundle, 'guides/overview')).not.toMatch(/^#/m)
    expect(bodyOf(bundle, 'intro')).not.toContain(MARKER)
    expect(directoryWarnings(bundle)).toEqual([])
  })

  it('inherits directory from the nearest ancestor group and lets none turn it off', () => {
    const bundle = site({ pages: [{ group: 'Outer', root: 'outer/overview', directory: 'card', pages: [
      'outer/a',
      { group: 'Inherits', root: 'outer/inherits/overview', pages: ['outer/inherits/b'] },
      { group: 'Off', root: 'outer/off/overview', directory: 'none', pages: [
        'outer/off/c',
        { group: 'Back on', root: 'outer/off/back/overview', directory: 'card', pages: ['outer/off/back/d'] },
        { group: 'Stays off', root: 'outer/off/stays/overview', pages: ['outer/off/stays/e'] },
      ] },
    ] }] }, Object.fromEntries([
      'outer/overview', 'outer/a', 'outer/inherits/overview', 'outer/inherits/b', 'outer/off/overview', 'outer/off/c',
      'outer/off/back/overview', 'outer/off/back/d', 'outer/off/stays/overview', 'outer/off/stays/e',
    ].map((id) => [`${id}.mdx`, doc(id)])))
    expect(bodyOf(bundle, 'outer/overview')).toContain(MARKER)
    expect(bodyOf(bundle, 'outer/inherits/overview')).toContain('<Card title="outer/inherits/b" href="/outer/inherits/b" />')
    expect(bodyOf(bundle, 'outer/off/overview')).not.toContain(MARKER)
    expect(bodyOf(bundle, 'outer/off/back/overview')).toContain('<Card title="outer/off/back/d"')
    expect(bodyOf(bundle, 'outer/off/stays/overview')).not.toContain(MARKER)
  })

  it('shows a group nested below the first level as one card with its page count', () => {
    const bundle = site({ pages: [{ group: 'Top', root: 'top/overview', directory: 'card', pages: [
      { group: 'Middle', pages: [
        'top/middle/a',
        { group: 'Inner', root: 'top/middle/inner/overview', pages: [
          'top/middle/inner/b',
          'top/middle/inner/c',
          { group: 'Innermost', pages: ['top/middle/inner/deeper/d'] },
        ] },
        { group: 'Single', pages: ['top/middle/single/e'] },
        { group: 'No root', pages: ['top/middle/noroot/f', 'top/middle/noroot/g'] },
      ] },
    ] }] }, Object.fromEntries([
      'top/overview', 'top/middle/a', 'top/middle/inner/overview', 'top/middle/inner/b', 'top/middle/inner/c',
      'top/middle/inner/deeper/d', 'top/middle/single/e', 'top/middle/noroot/f', 'top/middle/noroot/g',
    ].map((id) => [`${id}.mdx`, doc(id)])))
    const cards = directoryOf(bundle, 'top/overview')
    expect(cards).toContain('**Middle**')
    expect(cards).toContain('  <Card title="top/middle/a" href="/top/middle/a" />')
    expect(cards).toContain('  <Card title="Inner" href="/top/middle/inner/overview">3 pages</Card>')
    expect(cards).toContain('  <Card title="Single">1 page</Card>')
    expect(cards).toContain('  <Card title="No root">2 pages</Card>')
  })

  it('leaves hidden and access-restricted pages out of the cards and names them in one warning', () => {
    const bundle = site({ pages: [{ group: 'Docs', root: 'docs/overview', directory: 'card', pages: [
      'docs/open',
      'docs/secret',
      'docs/private',
      'docs/hidden-page',
      { group: 'Hidden group', hidden: true, pages: ['docs/hidden-group/x'] },
      { group: 'Sub', pages: ['docs/sub/ok', 'docs/sub/secret'] },
    ] }] }, {
      'docs/overview.mdx': doc('Docs overview'),
      'docs/open.mdx': doc('Open'),
      'docs/secret.mdx': doc('Secret', undefined, 'groups: [staff]\n'),
      'docs/private.mdx': doc('Private', undefined, 'public: false\n'),
      'docs/hidden-page.mdx': doc('Hidden page', undefined, 'hidden: true\n'),
      'docs/hidden-group/x.mdx': doc('Hidden group page'),
      'docs/sub/ok.mdx': doc('Sub ok'),
      'docs/sub/secret.mdx': doc('Sub secret', undefined, 'groups: [staff]\n'),
    })
    const cards = directoryOf(bundle, 'docs/overview')
    expect(cards).toContain('<Card title="Open" href="/docs/open" />')
    expect(cards).toContain('<Card title="Sub ok" href="/docs/sub/ok" />')
    expect(cards).not.toMatch(/Secret|Private|Hidden/i)
    const warnings = directoryWarnings(bundle)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('unsupported-config')
    expect(warnings[0].message).toContain('"Docs"')
    expect(warnings[0].message).toContain('5 hidden or access-restricted pages')
    for (const id of ['docs/secret', 'docs/private', 'docs/hidden-page', 'docs/hidden-group/x', 'docs/sub/secret']) {
      expect(warnings[0].message).toContain(id)
    }
  })

  it('shows an accordion group as cards and says so', () => {
    const bundle = site({ pages: [{ group: 'Docs', root: 'docs/overview', directory: 'accordion', pages: ['docs/a'] }] }, {
      'docs/overview.mdx': doc('Docs overview'),
      'docs/a.mdx': doc('A'),
    })
    expect(directoryOf(bundle, 'docs/overview')).toContain('<Card title="A" href="/docs/a" />')
    const warnings = directoryWarnings(bundle)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toBe('Group "Docs" sets directory to accordion, which Thally does not have. Its pages are listed as cards on /docs/overview instead.')
  })

  it('escapes braces, angle brackets, quotes and markdown in titles, descriptions and group labels', async () => {
    const projected = projectMintlifyNavigation({ navigation: { pages: [{ group: 'Docs', root: 'docs/overview', directory: 'card', pages: [
      'docs/odd',
      { group: 'Sub "q" {y} <z> *w*', pages: ['docs/sub/odd'] },
    ] }] } })
    const entry = (id: string, title: string, description?: string) => parseMarkdownPage({
      id,
      navigationId: id,
      raw: `---\ntitle: ${JSON.stringify(title)}\n${description ? `description: ${JSON.stringify(description)}\n` : ''}---\n\nBody.`,
      source: 'https://example.com/docs',
    })!
    const pages = [
      entry('docs/overview', 'Docs overview'),
      entry('docs/odd', 'Say "hi" {x} <b> & more', 'Use {braces}, <tags>, `code`, *stars*, _under_ [brackets] \\ & more.'),
      entry('docs/sub/odd', 'Sub <odd>', 'Line one\nline two'),
    ]
    appendMintlifyDirectories(pages, projected.directories, [])
    // The result is valid MDX whose attributes and text hold exactly what the source wrote.
    const compiled = String(await compile(pages[0].body, { outputFormat: 'function-body' }))
    expect(compiled).toContain('title: "Say \\"hi\\" {x} <b> & more"')
    expect(compiled).toContain('"Use {braces}, <tags>, `code`, *stars*, _under_ [brackets] \\\\ & more."')
    expect(compiled).toContain('title: "Sub <odd>"')
    expect(compiled).toContain('"Line one line two"')
    expect(compiled).toContain('"Sub \\"q\\" {y} <z> *w*"')
    // The cards sit directly in the grid, not inside a paragraph.
    expect(compiled).not.toMatch(/_components\.p, \{\s*children: _jsx\(Card/)
  })

  it('adds nothing and warns about nothing without a directory setting', () => {
    const bundle = site({ pages: [
      { group: 'Plain', root: 'plain/overview', pages: ['plain/a'] },
      { group: 'Off', root: 'off/overview', directory: 'none', pages: ['off/a'] },
      { group: 'No root', directory: 'card', pages: ['noroot/a'] },
    ] }, Object.fromEntries(['plain/overview', 'plain/a', 'off/overview', 'off/a', 'noroot/a'].map((id) => [`${id}.mdx`, doc(id)])))
    expect(bundle.pages.filter((page) => page.body.includes(MARKER))).toEqual([])
    expect(directoryWarnings(bundle)).toEqual([])
  })

  it('warns when the root page is not a migrated page', () => {
    const bundle = site({ pages: [
      'intro',
      { group: 'Missing root', root: 'missing/overview', directory: 'card', pages: ['missing/a'] },
      { group: 'Link root', root: 'https://example.com/docs', directory: 'card', pages: ['missing/b'] },
    ] }, { 'intro.mdx': doc('Intro'), 'missing/a.mdx': doc('A'), 'missing/b.mdx': doc('B') })
    const warnings = directoryWarnings(bundle).map((warning) => warning.message)
    expect(warnings).toContainEqual(expect.stringContaining('Group "Missing root" sets directory, but its root page missing/overview was not migrated'))
    expect(warnings).toContainEqual(expect.stringContaining('Group "Link root" sets directory, but its root'))
    expect(bundle.pages.filter((page) => page.body.includes(MARKER))).toEqual([])
  })

  it('appends the cards once however often the pass runs', () => {
    const projected = projectMintlifyNavigation({ navigation: { pages: [{ group: 'G', root: 'g/overview', directory: 'card', pages: ['g/a'] }] } })
    const pages = ['g/overview', 'g/a'].map((id) => parseMarkdownPage({ id, navigationId: id, raw: `---\ntitle: ${id}\n---\n\nBody.`, source: 'https://example.com/docs' })!)
    const warnings: MigrationBundle['warnings'] = []
    appendMintlifyDirectories(pages, projected.directories, warnings)
    const once = pages[0].body
    appendMintlifyDirectories(pages, projected.directories, warnings)
    expect(once).toContain(MARKER)
    expect(pages[0].body).toBe(once)
    expect(once.match(/<Card /g)).toHaveLength(1)
  })

  it('lists the cards of every group that shares a root page, in navigation order, once however often the pass runs', () => {
    const projected = projectMintlifyNavigation({ navigation: { pages: [
      { group: 'First', root: 'overview', directory: 'card', pages: ['a'] },
      { group: 'Second', root: 'overview', directory: 'card', pages: ['b'] },
    ] } })
    const pages = ['overview', 'a', 'b'].map((id) => parseMarkdownPage({ id, navigationId: id, raw: `---\ntitle: ${id}\n---\n\nBody.`, source: 'https://example.com/docs' })!)
    appendMintlifyDirectories(pages, projected.directories, [])
    const once = pages[0].body
    expect(once.match(/<Card /g)).toHaveLength(2)
    expect(once.indexOf('href="/a"')).toBeLessThan(once.indexOf('href="/b"'))
    expect(once.split(MARKER)).toHaveLength(2)
    appendMintlifyDirectories(pages, projected.directories, [])
    expect(pages[0].body).toBe(once)
  })

  it('lists a group that appears twice once', () => {
    const projected = projectMintlifyNavigation({ navigation: { pages: [{ group: 'G', root: 'g/overview', directory: 'card', pages: ['g/a'] }] } })
    const pages = ['g/overview', 'g/a'].map((id) => parseMarkdownPage({ id, navigationId: id, raw: `---\ntitle: ${id}\n---\n\nBody.`, source: 'https://example.com/docs' })!)
    appendMintlifyDirectories(pages, [...projected.directories, ...projected.directories], [])
    expect(pages[0].body.match(/<Card /g)).toHaveLength(1)
  })
})

describe('Mintlify group directory that lists API operations', () => {
  const response = { responses: { 200: { description: 'OK' } } }
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Example', version: '1' },
    paths: {
      '/users': { get: { summary: 'List users', tags: ['Users'], ...response } },
      '/users/{id}': { delete: { summary: 'Delete user', tags: ['Users'], ...response } },
    },
  }
  const SPEC_URL = 'https://specs.example.com/openapi.json'
  const files = { 'users/overview.mdx': doc('Users overview'), 'users/guide.mdx': doc('Guide'), 'openapi.json': JSON.stringify(spec) }
  const navigation = (pages: Array<unknown>, openapi: unknown = 'openapi.json') => ({
    tabs: [{ tab: 'API', openapi, groups: [{ group: 'Users', root: 'users/overview', directory: 'card', pages }] }],
  })
  const cards = (bundle: MigrationBundle): Array<string> => directoryOf(bundle, 'users/overview').split('\n').filter((line) => line.startsWith('  <Card '))
  const messages = (bundle: MigrationBundle): Array<string> => directoryWarnings(bundle).map((warning) => warning.message)

  it('says the operations a group lists are not cards on its root page, and lists the pages', () => {
    const bundle = site(navigation(['users/guide', 'GET /users', 'DELETE /users/{id}']), files)
    expect(cards(bundle)).toEqual(['  <Card title="Guide" href="/users/guide" />'])
    expect(messages(bundle)).toEqual([
      'Group "Users" sets directory and lists 2 API operations (entries such as "GET /path"), which Thally does not show as cards: the cards on its root page /users/overview list pages only. Link to the operations from that page if they should be listed.',
    ])
  })

  it('says it for one operation, and for a group that lists nothing else', () => {
    const bundle = site(navigation(['GET /users']), files)
    expect(cards(bundle)).toEqual([])
    expect(messages(bundle)).toEqual([expect.stringContaining('Group "Users" sets directory and lists 1 API operation (entries such as "GET /path"), which Thally does not show')])
  })

  it('counts the operations of a nested group, one that lists nothing else included', () => {
    const bundle = site({ tabs: [{ tab: 'API', openapi: 'openapi.json', groups: [{ group: 'API', root: 'users/overview', directory: 'card', pages: [
      'users/guide',
      { group: 'Users', pages: ['GET /users'] },
      { group: 'Deeper', pages: [{ group: 'Deepest', pages: ['DELETE /users/{id}'] }] },
    ] }] }] }, files)
    expect(messages(bundle)).toEqual([expect.stringContaining('Group "API" sets directory and lists 2 API operations')])
    expect(cards(bundle)).toEqual(['  <Card title="Guide" href="/users/guide" />'])
  })

  it('says it once for each group that lists operations, and for a group of a remote spec', async () => {
    const fetcher: MigrationFetcher = async (url) => ({ finalUrl: url, body: JSON.stringify(spec), contentType: 'application/json' })
    const migrated = site({ tabs: [{ tab: 'API', openapi: SPEC_URL, groups: [
      { group: 'Guides', root: 'users/overview', directory: 'card', pages: ['users/guide'] },
      { group: 'Users', root: 'users/overview', directory: 'card', pages: ['GET /users'] },
    ] }] }, { 'users/overview.mdx': files['users/overview.mdx'], 'users/guide.mdx': files['users/guide.mdx'] })
    expect(messages(migrated)).toEqual([expect.stringContaining('Group "Users" sets directory and lists 1 API operation')])
    const hydrated = await hydrateRemoteApiSpecs(migrated, fetcher)
    expect(messages(hydrated)).toEqual(messages(migrated))
    expect(cards(hydrated)).toEqual(['  <Card title="Guide" href="/users/guide" />'])
  })

  it('says nothing for a group that lists no operation', () => {
    const bundle = site(navigation(['users/guide']), files)
    expect(messages(bundle)).toEqual([])
  })
})
