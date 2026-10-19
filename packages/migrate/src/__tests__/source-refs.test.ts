import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { importSourceRef, migrateRepository, parseSourceRefFlags } from '../index.js'
import { prefixRootLinks, SOURCE_REF_MAX_FILES, stripControlCharacters, SOURCE_REF_MAX_REPOSITORY_KB, sourceRefOversizeReason, withheldNotSaved } from '../source-refs.js'
import type { MigrationFetcher } from '../types.js'

function write(root: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'thally-source-ref-'))
}

/** A referenced SDK repository: docs/ with its own docs.json, an orphan page and an image. */
function sdkRepo(extra: Record<string, string> = {}): string {
  return write(tmp(), {
    'docs/docs.json': JSON.stringify({ navigation: { pages: ['overview', { group: 'Chat', pages: ['sdks/chat/README'] }] } }),
    'docs/overview.mdx': '---\ntitle: Overview\n---\nSee [chat](/sdks/chat/README) and [rel](./sdks/chat/README.md).\n\n![logo](/images/logo.png)\n\n```\n[code](/sdks/keep)\n```\n',
    'docs/sdks/chat/README.md': '# Chat\n\nBack to <a href="/overview">overview</a>.',
    'docs/models/orphan.mdx': '---\ntitle: Orphan\n---\nOrphan page.',
    'docs/images/logo.png': 'png',
    ...extra,
  })
}

function mainRepo(extra: Record<string, string> = {}): string {
  return write(tmp(), {
    'docs.json': JSON.stringify({
      navigation: { tabs: [{ tab: 'SDKs', groups: [{ group: 'TypeScript SDK', icon: 'code', expanded: false, pages: [{ sourceRef: 'Acme/ts-sdk' }] }, { group: 'Intro', pages: ['introduction'] }] }] },
    }),
    'introduction.mdx': '---\ntitle: Home\n---\nHome.',
    ...extra,
  })
}

const MAPPING = { repo: 'Acme/ts-sdk', mountPath: 'client-sdks/typescript' }

describe('parseSourceRefFlags', () => {
  it('accepts a repository and a slug mount path', () => {
    expect(parseSourceRefFlags(['Acme/ts-sdk=client-sdks/typescript'])).toEqual([MAPPING])
  })

  it.each([
    ['Acme/ts-sdk=../x'],
    ['Acme/ts-sdk=/abs'],
    ['Acme/ts-sdk=a/../b'],
    ['Acme/ts-sdk=a//b'],
    ['Acme/ts-sdk=.hidden'],
    ['Acme/ts-sdk=Upper'],
    ['Acme/ts-sdk'],
    ['Acme/ts-sdk='],
    ['../x=docs'],
    ['Acme/..=docs'],
    ['acme=docs'],
    ['a/b/c=docs'],
    ['Acme/.=docs'],
    ['Acme/..=docs'],
    ['Acme/ts-sdk.git=docs'],
    ['Acme/ts-sdk=api'],
    ['Acme/ts-sdk=api/v1'],
    ['Acme/ts-sdk=_next'],
    ['Acme/ts-sdk=_thally/x'],
    ['Acme/ts-sdk=public'],
    ['Acme/ts-sdk=static'],
    ['Acme/ts-sdk=llms.txt'],
    ['Acme/ts-sdk=sitemap.xml'],
    ['Acme/ts-sdk=robots.txt'],
    ['Acme/ts-sdk=changelog'],
    ['Acme/ts-sdk=admin'],
  ])('rejects %s', (value) => {
    expect(() => parseSourceRefFlags([value])).toThrow(/--source-ref/)
  })

  it('rejects duplicate repositories and overlapping mounts', () => {
    expect(() => parseSourceRefFlags(['A/b=x', 'a/B=y'])).toThrow(/twice/)
    expect(() => parseSourceRefFlags(['A/b=x', 'A/c=x'])).toThrow(/overlap/)
    expect(() => parseSourceRefFlags(['A/b=x', 'A/c=x/y'])).toThrow(/overlap/)
  })
})

describe('prefixRootLinks', () => {
  it('prefixes root-absolute targets outside code and leaves relative, external and protocol-relative ones', () => {
    const body = [
      '[a](/x) [b](x) [c](https://e.com/x) [d](//cdn/x) [e](#h) [f](</sp ace>)',
      '<a href="/y">y</a> <img src=\'/z.png\' /> <Card href="https://e.com" />',
      '[ref]: /w',
      '`[code](/inline)`',
      '```\n[code](/fenced)\n```',
    ].join('\n')
    expect(prefixRootLinks(body, 'm')).toBe([
      '[a](/m/x) [b](x) [c](https://e.com/x) [d](//cdn/x) [e](#h) [f](</m/sp ace>)',
      '<a href="/m/y">y</a> <img src=\'/m/z.png\' /> <Card href="https://e.com" />',
      '[ref]: /m/w',
      '`[code](/inline)`',
      '```\n[code](/fenced)\n```',
    ].join('\n'))
  })
})

describe('prefixRootLinks edge cases', () => {
  it('does not prefix a link that is already under the mount path', () => {
    const body = '[a](/m/n/x) [b](/m/n) [c](/m/n#h) [d](/m/nx) <a href="/m/n/y">y</a> <a href={"/m/n/z"}>z</a>'
    expect(prefixRootLinks(body, 'm/n')).toBe('[a](/m/n/x) [b](/m/n) [c](/m/n#h) [d](/m/n/m/nx) <a href="/m/n/y">y</a> <a href={"/m/n/z"}>z</a>')
  })

  it('prefixes string literals inside JSX attribute expressions', () => {
    expect(prefixRootLinks('<a href={"/x"}>x</a> <img src={\'/y.png\'} /> <a href={ "/z" }>z</a> <a href={cond ? "/a" : "/b"}>q</a> <a href={"https://e.com"}>e</a>', 'm'))
      .toBe('<a href={"/m/x"}>x</a> <img src={\'/m/y.png\'} /> <a href={ "/m/z" }>z</a> <a href={cond ? "/a" : "/b"}>q</a> <a href={"https://e.com"}>e</a>')
  })
})

describe('forwarded warning text', () => {
  it('strips control characters and escape sequences from sub-repository file names', () => {
    expect(stripControlCharacters('bad\x1b[31mred\x1b[0m\x07name\x00.mdx\tkept\nkept')).toBe('badredname.mdx\tkept\nkept')
    const repo = sdkRepo({ 'docs/we\x1b[31mird.mdx': '---\ntitle: W\n---\n<Unknown />' })
    const result = importSourceRef(MAPPING, repo)
    expect(result.warnings.some((warning) => (warning.message + (warning.source ?? '')).includes('weird'))).toBe(true)
    expect(result.warnings.every((warning) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(warning.message + (warning.source ?? '')))).toBe(true)
  })
})

describe('importSourceRef', () => {
  it('mounts all pages (orphans included), assets and navigation under the mount path', () => {
    const imported = importSourceRef(MAPPING, sdkRepo())
    const ids = imported.pages.map((page) => page.id).sort()
    expect(ids).toEqual(['client-sdks/typescript/models/orphan', 'client-sdks/typescript/overview', 'client-sdks/typescript/sdks/chat/README'])
    expect(imported.assets.map((asset) => asset.path)).toContain('client-sdks/typescript/images/logo.png')
    expect(imported.navigation).toEqual(['client-sdks/typescript/overview', { group: 'Chat', pages: ['client-sdks/typescript/sdks/chat/README'] }])
    const bundle = migrateRepository({ repositoryDir: mainRepo(), sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [imported] })
    const overview = bundle.pages.find((page) => page.id.endsWith('/overview'))!
    expect(overview.body).toContain('[chat](/client-sdks/typescript/sdks/chat/README)')
    expect(overview.body).toContain('![logo](/client-sdks/typescript/images/logo.png)')
    expect(overview.body).toContain('[code](/sdks/keep)')
    expect(overview.body).toContain('(./sdks/chat/README')
  })

  it('warns and imports nothing when there is no Mintlify docs.json', () => {
    const none = importSourceRef(MAPPING, write(tmp(), { 'docs/readme.md': '# hi' }))
    expect(none.pages).toEqual([])
    expect(none.warnings[0].message).toMatch(/no Mintlify docs\.json/)
    const notMintlify = importSourceRef(MAPPING, write(tmp(), { 'docs/docs.json': '{"name":"x"}', 'docs/a.md': '# a' }))
    expect(notMintlify.pages).toEqual([])
  })

  it('refuses a repository over the file cap instead of importing part of it', () => {
    const files: Record<string, string> = {}
    for (let index = 0; index <= SOURCE_REF_MAX_FILES; index++) files[`docs/p${index}.md`] = '# p'
    const result = importSourceRef(MAPPING, sdkRepo(files))
    expect(result.pages).toEqual([])
    expect(result.warnings[0].message).toMatch(/more than 5000 files.*Nothing was imported/)
  })

  it('ignores symlinks that escape the docs root and dot-directories', () => {
    const secretDir = write(tmp(), { 'secret.md': '# Secret\n\nTOP SECRET' })
    const repo = sdkRepo({ 'docs/.hidden/page.md': '# Hidden' })
    symlinkSync(join(secretDir, 'secret.md'), join(repo, 'docs', 'leak.md'))
    symlinkSync(secretDir, join(repo, 'docs', 'leakdir'))
    const result = importSourceRef(MAPPING, repo)
    const text = JSON.stringify(result.pages)
    expect(text).not.toContain('TOP SECRET')
    expect(result.pages.some((page) => page.id.includes('hidden') || page.id.includes('leak'))).toBe(false)
    expect(result.warnings.some((warning) => /symbolic link/.test(warning.message))).toBe(true)
  })

  it('refuses a docs directory that is a symlink', () => {
    const target = sdkRepo()
    const outer = tmp()
    symlinkSync(join(target, 'docs'), join(outer, 'docs'))
    expect(importSourceRef(MAPPING, outer).pages).toEqual([])
  })
})

describe('migrateRepository with sourceRefs', () => {
  it('replaces the sourceRef node with the mounted navigation and merges pages and assets', () => {
    const imported = importSourceRef(MAPPING, sdkRepo())
    const bundle = migrateRepository({ repositoryDir: mainRepo(), sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [imported] })
    const group = bundle.docsConfig.tabs[0].groups!.find((candidate) => candidate.group === 'TypeScript SDK')!
    expect(group.icon).toBe('code')
    expect(group.pages).toEqual(['client-sdks/typescript/overview', { group: 'Chat', pages: ['client-sdks/typescript/sdks/chat/README'] }])
    const ids = bundle.pages.map((page) => page.id)
    expect(ids).toContain('introduction')
    expect(ids).toContain('client-sdks/typescript/models/orphan')
    expect(bundle.assets.map((asset) => asset.path)).toContain('client-sdks/typescript/images/logo.png')
    expect(bundle.sourceRefs).toEqual([{ ...MAPPING, pages: 3 }])
    expect(bundle.stats.imported).toBe(bundle.pages.length)
    expect(bundle.warnings.some((warning) => /sourceRef.*not migrated/.test(warning.message))).toBe(false)
    expect(bundle.warnings.some((warning) => /branding, colors and redirects were ignored/.test(warning.message))).toBe(true)
  })

  it('redirects a mounted page whose frontmatter url is another address, from its mounted path', () => {
    const imported = importSourceRef(MAPPING, sdkRepo({
      'docs/docs.json': JSON.stringify({ navigation: { pages: ['overview', 'github', { group: 'Community', pages: ['community/index', 'community/roadmap'] }] } }),
      'docs/github.mdx': '---\ntitle: GitHub\nurl: "https://github.com/Acme/ts-sdk"\n---\nOn GitHub.',
      'docs/community/index.mdx': '---\ntitle: Community\nurl: https://community.example.com\n---\nJoin us.',
      'docs/community/roadmap.mdx': '---\ntitle: Roadmap\nurl: "javascript:alert(1)"\n---\nNext.',
    }))
    const bundle = migrateRepository({ repositoryDir: mainRepo(), sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [imported] })
    expect(bundle.docsConfig.redirects).toEqual(expect.arrayContaining([
      { source: '/client-sdks/typescript/github', destination: 'https://github.com/Acme/ts-sdk', permanent: false },
      { source: '/client-sdks/typescript/community', destination: 'https://community.example.com', permanent: false },
    ]))
    // The page keeps its sidebar entry, stays out of the sitemap, and a url that is not a web address is no link.
    expect(bundle.pages.find((page) => page.id === 'client-sdks/typescript/github')).toMatchObject({ noindex: true })
    expect(bundle.docsConfig.redirects?.map((redirect) => redirect.source)).not.toContain('/client-sdks/typescript/community/roadmap')
    expect(bundle.docsConfig.redirects?.filter((redirect) => redirect.source === '/client-sdks/typescript/github')).toHaveLength(1)
  })

  it('redirects the mount root to the first page of the sub-site navigation', () => {
    const imported = importSourceRef(MAPPING, sdkRepo())
    const bundle = migrateRepository({ repositoryDir: mainRepo(), sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [imported] })
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/client-sdks/typescript', destination: '/client-sdks/typescript/overview', permanent: false })
  })

  it('keeps the warning with the flag hint when the repository is not mapped', () => {
    const bundle = migrateRepository({ repositoryDir: mainRepo(), sourceUrl: 'https://github.com/example/docs', platform: 'mintlify' })
    expect(bundle.warnings.some((warning) => warning.message.includes('--source-ref Acme/ts-sdk=<path>'))).toBe(true)
    expect(bundle.sourceRefs).toBeUndefined()
  })

  it('warns about a mapping the navigation never references', () => {
    const other = importSourceRef({ repo: 'Acme/other', mountPath: 'other' }, sdkRepo())
    const bundle = migrateRepository({ repositoryDir: mainRepo(), sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [other] })
    expect(bundle.warnings.some((warning) => warning.message.includes('Acme/other=other matched no sourceRef'))).toBe(true)
    expect(bundle.pages.some((page) => page.id.startsWith('other/'))).toBe(false)
  })

  it('rejects a mount path the main site already owns', () => {
    const imported = importSourceRef(MAPPING, sdkRepo())
    const repo = mainRepo({ 'client-sdks/typescript/guide.mdx': '---\ntitle: Guide\n---\nGuide.' })
    const bundle = migrateRepository({ repositoryDir: repo, sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [imported] })
    expect(bundle.warnings.some((warning) => warning.code === 'collision' && /already exists/.test(warning.message))).toBe(true)
    expect(bundle.pages.some((page) => page.id === 'client-sdks/typescript/overview')).toBe(false)
    expect(bundle.sourceRefs).toBeUndefined()
  })

  it('does not overwrite a main page that shares an imported page id', () => {
    const imported = importSourceRef(MAPPING, sdkRepo())
    const clash = { ...imported, pages: [...imported.pages, { ...imported.pages[0], id: 'introduction', navigationId: 'introduction' }] }
    const bundle = migrateRepository({ repositoryDir: mainRepo(), sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [clash] })
    expect(bundle.pages.filter((page) => page.id === 'introduction')).toHaveLength(1)
    expect(bundle.warnings.some((warning) => warning.code === 'collision' && warning.message.includes('"introduction"'))).toBe(true)
  })
})

describe('sourceRef custom components', () => {
  it('bundles the sub-repository components with the main ones so every Migrated tag is registered', () => {
    const foo = (label: string): string => `export const Foo = () => <button onClick={() => 1}>${label}</button>\n`
    const sub = write(tmp(), {
      'docs.json': JSON.stringify({ navigation: { pages: ['intro'] } }),
      'intro.mdx': 'import { Foo } from "/snippets/Foo.jsx"\n\n<Foo />\n',
      'snippets/Foo.jsx': foo('sub'),
    })
    const main = mainRepo({
      'docs.json': JSON.stringify({ navigation: { pages: ['introduction', { sourceRef: 'Acme/ts-sdk' }] } }),
      'introduction.mdx': 'import { Foo } from "/snippets/Foo.jsx"\n\n<Foo />\n',
      'snippets/Foo.jsx': foo('main'),
    })
    const imported = importSourceRef(MAPPING, sub)
    const bundle = migrateRepository({ repositoryDir: main, sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [imported] })
    const files = bundle.componentFiles ?? []
    const registry = String(files.find((file) => file.path === 'src/mdx/custom-components.tsx')?.content)
    const tags = bundle.pages.flatMap((page) => page.body.match(/<Migrated[0-9a-f]+/g) ?? []).map((tag) => tag.slice(1))
    expect(bundle.pages.map((page) => page.id)).toContain('client-sdks/typescript/intro')
    expect(new Set(tags).size).toBe(2)
    for (const tag of tags) expect(registry).toContain(`  ${tag},`)
    for (const [, specifier] of registry.matchAll(/^import \{ \w+ as Migrated[0-9a-f]+ \} from "\.\/([^"]+)"$/gm)) {
      expect(files.some((file) => file.path.replace(/\.tsx?$/, '') === `src/mdx/${specifier}`)).toBe(true)
    }
    expect(bundle.warnings.some((warning) => /Not imported:.*custom components/.test(warning.message))).toBe(false)
  })
})

describe('sourceRef component links', () => {
  const component = [
    'export const Nav = () => (',
    '  <nav onClick={() => 1}>',
    '    <a href="/overview">overview</a>',
    '    <a href={"/overview#top"}>top</a>',
    '    <img src="/images/logo.png" alt="" />',
    '    <a href="/introduction">main site</a>',
    '    <a href="/client-sdks/typescript/overview">already mounted</a>',
    '    <a href="https://example.com/overview">external</a>',
    '    <a href="//cdn.example.com/x">protocol relative</a>',
    '    <a href="#anchor">anchor</a>',
    '    <a href="mailto:a@b.co">mail</a>',
    '    <button onClick={() => items[0](/re/)}>code</button>',
    '  </nav>',
    ')',
    '',
  ].join('\n')

  it('prefixes root-absolute links and images in mounted component files like page bodies', () => {
    const sub = write(tmp(), {
      'docs.json': JSON.stringify({ navigation: { pages: ['overview'] } }),
      'overview.mdx': 'import { Nav } from "/snippets/Nav.jsx"\n\n---\ntitle: Overview\n---\n\n<Nav />\n',
      'snippets/Nav.jsx': component,
      'images/logo.png': 'png',
    })
    const main = mainRepo({ 'docs.json': JSON.stringify({ navigation: { pages: ['introduction', { sourceRef: 'Acme/ts-sdk' }] } }) })
    const bundle = migrateRepository({ repositoryDir: main, sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [importSourceRef(MAPPING, sub)] })
    const source = (bundle.componentFiles ?? []).map((file) => String(file.content)).find((content) => content.includes('main site'))!
    expect(source).toContain('href="/client-sdks/typescript/overview"')
    expect(source).toContain('href={"/client-sdks/typescript/overview#top"}')
    expect(source).toContain('src="/client-sdks/typescript/images/logo.png"')
    expect(source).toContain('href="/introduction"')
    expect(source).toContain('href="https://example.com/overview"')
    expect(source).toContain('href="//cdn.example.com/x"')
    expect(source).toContain('href="#anchor"')
    expect(source).toContain('href="mailto:a@b.co"')
    expect(source).not.toContain('/client-sdks/typescript/client-sdks')
    // code that merely looks like a Markdown link is left alone
    expect(source).toContain('items[0](/re/)')
  })
})

describe('sourceRef components shared with the main site', () => {
  const shared = 'export const Link = () => <a href="/intro" onClick={() => 1}>go</a>\n'
  const page = 'import { Link } from "/snippets/Link.jsx"\n\n---\ntitle: P\n---\n\n<Link />\n'

  it('keeps an identical component per site, each with its own URLs', () => {
    const sub = write(tmp(), {
      'docs.json': JSON.stringify({ navigation: { pages: ['intro', 'p'] } }),
      'intro.mdx': '---\ntitle: Intro\n---\nIntro.',
      'p.mdx': page,
      'snippets/Link.jsx': shared,
    })
    const main = mainRepo({
      'docs.json': JSON.stringify({ navigation: { pages: ['introduction', 'p', { sourceRef: 'Acme/ts-sdk' }] } }),
      'p.mdx': page,
      'snippets/Link.jsx': shared,
    })
    const bundle = migrateRepository({ repositoryDir: main, sourceUrl: 'https://github.com/Acme/ts-sdk', platform: 'mintlify', sourceRefs: [importSourceRef(MAPPING, sub)] })
    const files = bundle.componentFiles ?? []
    const registry = String(files.find((file) => file.path === 'src/mdx/custom-components.tsx')?.content)
    const tagOf = (id: string): string => bundle.pages.find((candidate) => candidate.id === id)!.body.match(/<(Migrated[0-9a-f]+)/)![1]
    const sourceOf = (tag: string): string => {
      const specifier = registry.match(new RegExp(`as ${tag} \\} from "\\./([^"]+)"`))![1]
      return String(files.find((file) => file.path === `src/mdx/${specifier}`)!.content)
    }
    expect(sourceOf(tagOf('p'))).toContain('href="/intro"')
    expect(sourceOf(tagOf('client-sdks/typescript/p'))).toContain('href="/client-sdks/typescript/intro"')
  })
})

describe('sourceRef quarantine wording', () => {
  it('never claims a withheld sub-repository file was saved', () => {
    const repo = write(tmp(), {
      'docs.json': JSON.stringify({ navigation: { pages: ['intro', 'secret'] } }),
      'intro.mdx': '---\ntitle: I\n---\nhi ![](/images/pub.png)',
      'secret.mdx': '---\ntitle: S\ngroups: [admin]\n---\nSECRET ![](/images/priv.png)',
      'images/pub.png': 'x',
      'images/priv.png': 'y',
      'images/orphan.png': 'z',
    })
    const result = importSourceRef(MAPPING, repo)
    const messages = result.warnings.map((warning) => warning.message)
    // The restricted page imports with its rule; the image only it uses stays out of public/.
    expect(result.pages.find((page) => page.id === 'client-sdks/typescript/secret')?.groups).toEqual(['admin'])
    expect(result.assets.some((asset) => asset.path.includes('priv.png'))).toBe(false)
    expect(messages.some((message) => /page\(s\) are restricted with `groups`/.test(message))).toBe(true)
    expect(messages.filter((message) => message.includes('migration-quarantine'))).toEqual([])
    expect(messages.some((message) => /saved under|is saved at/.test(message))).toBe(false)
  })

  it.each([
    ['Access-restricted on the source site (groups), so it was NOT published. The original is saved at migration-quarantine/a.mdx; links will break.', /It is withheld from the site \(not saved\); links will break/],
    ['Access-restricted page (x) was dropped by the file limit, so it was NOT published and was not saved under migration-quarantine/; recover it.', /is not saved; recover it/],
    ['Access-restricted page (x) could not be read, so it was not copied to migration-quarantine/; recover it.', /is not saved; recover it/],
    ['Copy any that published pages need from migration-quarantine/assets/ into public/ by hand.', /not saved/],
    ['2 unreferenced asset(s) were kept out of public/ because x; review migration-quarantine/assets/ and copy any that published pages need. Z', /not saved\)\. Z/],
  ])('rewrites %s', (message, expected) => {
    const rewritten = withheldNotSaved(message)
    expect(rewritten).not.toContain('migration-quarantine')
    expect(rewritten).toMatch(expected)
  })
})

describe('sourceRef repository size limits', () => {
  const sizeFetcher = (body: string): MigrationFetcher => async (url) => ({ finalUrl: url, body, contentType: 'application/json' })

  it('refuses a repository GitHub reports as over the cap, naming the sizes', async () => {
    const reason = await sourceRefOversizeReason('Acme/ts-sdk', sizeFetcher(JSON.stringify({ size: SOURCE_REF_MAX_REPOSITORY_KB + 1 })))
    expect(reason).toMatch(/200 MB limit/)
  })

  it('proceeds when the repository is small, the size is missing, or the API is unavailable', async () => {
    expect(await sourceRefOversizeReason('Acme/ts-sdk', sizeFetcher(JSON.stringify({ size: 1000 })))).toBeNull()
    expect(await sourceRefOversizeReason('Acme/ts-sdk', sizeFetcher('{}'))).toBeNull()
    expect(await sourceRefOversizeReason('Acme/ts-sdk', sizeFetcher('not json'))).toBeNull()
    const failing = vi.fn().mockRejectedValue(new Error('rate limited'))
    expect(await sourceRefOversizeReason('Acme/ts-sdk', failing)).toBeNull()
    expect(String(failing.mock.calls[0][0])).toBe('https://api.github.com/repos/Acme/ts-sdk')
  })

  it('ignores a docs.json over 1 MB instead of parsing it', () => {
    const huge = JSON.stringify({ navigation: { pages: ['overview'] }, padding: 'x'.repeat(1_100_000) })
    const result = importSourceRef(MAPPING, write(tmp(), { 'docs/docs.json': huge, 'docs/overview.mdx': '# hi' }))
    expect(result.pages).toEqual([])
    expect(result.warnings[0].message).toMatch(/no Mintlify docs\.json/)
  })
})

describe('sourceRef links that name main-site pages', () => {
  // OpenRouter's SDK READMEs link `/docs/guides/...` (the live site serves its docs under /docs).
  const sdk = (): string => write(tmp(), {
    'docs/docs.json': JSON.stringify({ navigation: { pages: ['sdks/analytics/README'] } }),
    'docs/sdks/analytics/README.md': [
      '[Management key](/docs/guides/overview/auth/management-api-keys) required.',
      '[Auth](/docs/api-reference/authentication/) and [anchor](/guides/overview/auth/management-api-keys#top)',
      '[own](/sdks/analytics/README) [dup](/overview/auth) [gone](/docs/nowhere/at-all)',
      '[keys](/docs/guides/overview/auth/management-api-keys?x=1)',
    ].join('\n'),
    'docs/overview/auth.md': '# Own overview',
  })
  const main = (): string => write(tmp(), {
    'docs.json': JSON.stringify({
      navigation: { pages: ['introduction', 'guides/overview/auth/management-api-keys', 'overview/auth', 'api_reference/authentication', { sourceRef: 'Acme/go-sdk' }] },
      redirects: [{ source: '/api-reference/authentication', destination: '/api_reference/authentication' }],
    }),
    'introduction.mdx': '---\ntitle: Home\n---\nHome.',
    'guides/overview/auth/management-api-keys.mdx': '---\ntitle: Keys\n---\nKeys.',
    'overview/auth.mdx': '---\ntitle: Main overview\n---\nMain.',
    'api_reference/authentication.mdx': '---\ntitle: Auth\n---\nAuth.',
  })

  it('resolves base-path, redirected and exact main links, prefers the sub-site page, and reports the rest once', () => {
    const imported = importSourceRef({ repo: 'Acme/go-sdk', mountPath: 'client-sdks/go' }, sdk())
    const bundle = migrateRepository({ repositoryDir: main(), sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [imported] })
    const body = bundle.pages.find((page) => page.id === 'client-sdks/go/sdks/analytics/README')!.body
    expect(body).toContain('[Management key](/guides/overview/auth/management-api-keys) required.')
    expect(body).toContain('[Auth](/api-reference/authentication/) and [anchor](/guides/overview/auth/management-api-keys#top)')
    expect(body).toContain('[own](/client-sdks/go/sdks/analytics/README) [dup](/client-sdks/go/overview/auth) [gone](/client-sdks/go/docs/nowhere/at-all)')
    expect(body).toContain('[keys](/guides/overview/auth/management-api-keys?x=1)')
    const warnings = bundle.warnings.filter((warning) => /match no page in the sub-site or the main site/.test(warning.message))
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('/docs/nowhere/at-all')
  })
})

describe('sourceRef mounts under restricted navigation', () => {
  const gate = { public: false }
  type Form = 'direct' | 'nested'
  const docsJson = (form: Form, container: Record<string, unknown>, node: Record<string, unknown>): string => JSON.stringify({
    navigation: form === 'direct'
      ? { pages: ['introduction', { group: 'SDK', ...container, pages: [{ sourceRef: 'Acme/ts-sdk', ...node }] }] }
      : { tabs: [{ tab: 'SDKs', ...container, pages: [{ sourceRef: 'Acme/ts-sdk', ...node }] }, { tab: 'Docs', pages: ['introduction'] }] },
  })
  const sub = (): string => sdkRepo({
    'docs/overview.mdx': 'import { Foo } from "/snippets/Foo.jsx"\n\n---\ntitle: Overview\n---\n![logo](/images/logo.png)\n\n<Foo />\n',
    'docs/snippets/Foo.jsx': 'export const Foo = () => <button onClick={() => 1}>subonlymarker</button>\n',
  })
  const run = (form: Form, container: Record<string, unknown>, node: Record<string, unknown>) => {
    const main = mainRepo({ 'docs.json': docsJson(form, container, node) })
    const imported = importSourceRef(MAPPING, sub())
    return migrateRepository({ repositoryDir: main, sourceUrl: 'https://github.com/example/docs', platform: 'mintlify', sourceRefs: [imported] })
  }
  const mounted = (bundle: ReturnType<typeof run>): boolean => bundle.pages.some((page) => page.id.startsWith('client-sdks/typescript/'))

  it.each(['direct', 'nested'] as const)('mounts the %s form when nothing restricts it', (form) => {
    const bundle = run(form, {}, {})
    expect(mounted(bundle)).toBe(true)
    expect(bundle.assets.map((asset) => asset.path)).toContain('client-sdks/typescript/images/logo.png')
    expect(bundle.sourceRefs).toEqual([{ ...MAPPING, pages: 3 }])
    expect(JSON.stringify(bundle.componentFiles)).toContain('subonlymarker')
  })

  it.each([
    ['direct', 'the enclosing container', gate, {}],
    ['direct', 'the node itself', {}, gate],
    ['direct', 'both', gate, gate],
    ['nested', 'the enclosing container', gate, {}],
    ['nested', 'the node itself', {}, gate],
    ['nested', 'both', gate, gate],
    ['direct', 'a group list on the container', { groups: ['admin'] }, {}],
    ['direct', 'a group list on the node', {}, { groups: ['admin'] }],
  ] as const)('withholds the %s form restricted on %s', (form, _where, container, node) => {
    const bundle = run(form, container, node)
    expect(mounted(bundle)).toBe(false)
    expect(bundle.assets.some((asset) => asset.path.startsWith('client-sdks/typescript/'))).toBe(false)
    expect(JSON.stringify(bundle.componentFiles ?? [])).not.toContain('subonlymarker')
    expect(JSON.stringify(bundle.docsConfig)).not.toContain('client-sdks/typescript')
    expect(bundle.sourceRefs).toBeUndefined()
    const messages = bundle.warnings.map((warning) => warning.message)
    expect(messages.filter((message) => /Acme\/ts-sdk.*restricted container\..*left out of the navigation.*make the container public/.test(message))).toHaveLength(1)
    expect(messages.some((message) => /matched no sourceRef/.test(message))).toBe(false)
    expect(JSON.stringify(bundle.pages.map((page) => page.body))).not.toContain('subonlymarker')
  })
})

describe('sourceRef mounts under every kind of restricted container', () => {
  const mount = { sourceRef: 'Acme/ts-sdk' }
  const pub = ['introduction']
  type Build = (gate: Record<string, unknown>, leaf: unknown) => Record<string, unknown>
  const kinds: Record<string, Build> = {
    group: (gate, leaf) => ({ pages: [...pub, { group: 'G', ...gate, pages: [leaf] }] }),
    'nested group': (gate, leaf) => ({ pages: [...pub, { group: 'O', ...gate, pages: [{ group: 'I', pages: [leaf] }] }] }),
    tab: (gate, leaf) => ({ tabs: [{ tab: 'T', ...gate, pages: [leaf] }, { tab: 'D', pages: pub }] }),
    anchor: (gate, leaf) => ({ anchors: [{ anchor: 'A', ...gate, pages: [leaf] }, { anchor: 'B', pages: pub }] }),
    dropdown: (gate, leaf) => ({ dropdowns: [{ dropdown: 'A', ...gate, pages: [leaf] }, { dropdown: 'B', pages: pub }] }),
    product: (gate, leaf) => ({ products: [{ product: 'p', ...gate, pages: [leaf] }, { product: 'q', pages: pub }] }),
    productGroup: (gate, leaf) => ({ productGroups: [{ group: 'PG', ...gate, products: [{ product: 'p', pages: [leaf] }] }, { group: 'PH', products: [{ product: 'q', pages: pub }] }] }),
    version: (gate, leaf) => ({ versions: [{ version: 'v1', ...gate, pages: [leaf] }, { version: 'v2', pages: pub }] }),
    language: (gate, leaf) => ({ languages: [{ language: 'en', default: true, pages: pub }, { language: 'fr', ...gate, pages: [leaf] }] }),
    'language with tabs': (gate, leaf) => ({ languages: [{ language: 'en', default: true, pages: pub }, { language: 'fr', ...gate, tabs: [{ tab: 'T', pages: [leaf] }] }] }),
    'tab menu item': (gate, leaf) => ({ tabs: [{ tab: 'T', menu: [{ item: 'M', ...gate, pages: [leaf] }] }, { tab: 'D', pages: pub }] }),
    root: (gate, leaf) => ({ ...gate, pages: [leaf] }),
  }
  const gates: Array<[string, Record<string, unknown>]> = [['public: false', { public: false }], ['groups', { groups: ['admin'] }]]
  const leaves: Array<[string, unknown]> = [['bare node', mount], ['wrapped in a group', { group: 'W', pages: [mount] }]]
  const run = (navigation: Record<string, unknown>) => migrateRepository({
    repositoryDir: mainRepo({ 'docs.json': JSON.stringify({ navigation }) }),
    sourceUrl: 'https://github.com/example/docs',
    platform: 'mintlify',
    sourceRefs: [importSourceRef(MAPPING, sdkRepo({
      'docs/overview.mdx': 'import { Foo } from "/snippets/Foo.jsx"\n\n---\ntitle: Overview\n---\n![logo](/images/logo.png)\n\n<Foo />\n',
      'docs/snippets/Foo.jsx': 'export const Foo = () => <button onClick={() => 1}>subonlymarker</button>\n',
    }))],
  })

  describe.each(Object.keys(kinds))('%s', (kind) => {
    it.each(leaves)('mounts when unrestricted (%s)', (_name, leaf) => {
      const bundle = run(kinds[kind]({}, leaf))
      expect(bundle.pages.some((page) => page.id.startsWith('client-sdks/typescript/'))).toBe(true)
      expect(bundle.assets.map((asset) => asset.path)).toContain('client-sdks/typescript/images/logo.png')
    })

    describe.each(gates)('restricted by %s', (_gateName, gate) => {
      it.each(leaves)('withholds the mount (%s)', (_name, leaf) => {
        const bundle = run(kinds[kind](gate, leaf))
        expect(bundle.pages.some((page) => page.id.startsWith('client-sdks/typescript/'))).toBe(false)
        expect(bundle.assets.some((asset) => asset.path.startsWith('client-sdks/typescript/'))).toBe(false)
        expect(JSON.stringify(bundle.componentFiles ?? [])).not.toContain('subonlymarker')
        expect(JSON.stringify(bundle.docsConfig)).not.toContain('client-sdks/typescript')
        expect(bundle.sourceRefs).toBeUndefined()
        expect(bundle.warnings.some((warning) => /Acme\/ts-sdk/.test(warning.message) && /restricted/.test(warning.message))).toBe(true)
      })
    })
  })
})

describe('navigation too deep to check access rules', () => {
  const nest = (levels: number, leaf: unknown, gate: Record<string, unknown> = {}): unknown => {
    let node: unknown = leaf
    for (let level = 0; level < levels; level++) node = { group: `g${level}`, ...(level === levels - 1 ? gate : {}), pages: [node] }
    return node
  }
  const run = (pages: unknown, extra: Record<string, string> = {}) => migrateRepository({
    repositoryDir: mainRepo({ 'docs.json': JSON.stringify({ navigation: { pages: ['introduction', pages] } }), 'deep-page.mdx': '---\ntitle: Deep\n---\nDeep.', ...extra }),
    sourceUrl: 'https://github.com/example/docs',
    platform: 'mintlify',
    sourceRefs: [importSourceRef(MAPPING, sdkRepo())],
  })
  const mounted = (bundle: ReturnType<typeof run>): boolean => bundle.pages.some((page) => page.id.startsWith('client-sdks/typescript/'))
  const tooDeep = (bundle: ReturnType<typeof run>): boolean => bundle.warnings.some((warning) => /too deeply nested/.test(warning.message))

  it('withholds a sourceRef nested past the limit under a restricted group, with a warning', () => {
    const bundle = run(nest(200, { sourceRef: 'Acme/ts-sdk' }, { public: false }))
    expect(mounted(bundle)).toBe(false)
    expect(tooDeep(bundle)).toBe(true)
    expect(bundle.warnings.some((warning) => /Acme\/ts-sdk.*restricted container/.test(warning.message))).toBe(true)
  })

  it('also withholds an unrestricted sourceRef nested past the limit', () => {
    const bundle = run(nest(200, { sourceRef: 'Acme/ts-sdk' }))
    expect(mounted(bundle)).toBe(false)
    expect(tooDeep(bundle)).toBe(true)
  })

  it('mounts a moderately deep sourceRef', () => {
    const bundle = run(nest(20, { sourceRef: 'Acme/ts-sdk' }))
    expect(mounted(bundle)).toBe(true)
    expect(tooDeep(bundle)).toBe(false)
  })

  const menu = (inner: unknown) => ({ tab: 'T', menu: [{ item: 'M', public: false, pages: [inner] }] })
  const runMenu = (inner: unknown) => migrateRepository({
    repositoryDir: mainRepo({ 'docs.json': JSON.stringify({ navigation: { tabs: [menu(inner), { tab: 'D', pages: ['introduction'] }] } }), 'deep-page.mdx': '---\ntitle: Deep\n---\nDeep.' }),
    sourceUrl: 'https://github.com/example/docs',
    platform: 'mintlify',
  })

  it('carries a restricted menu item\'s rule to a page nested 20 levels below it', () => {
    const bundle = runMenu(nest(20, 'deep-page'))
    // Restricted pages migrate with access frontmatter the runtime enforces; never as open pages.
    expect(bundle.pages.find((page) => page.id === 'deep-page')?.public).toBe(false)
  })

  it('withholds every page when the navigation is nested past the limit', () => {
    // nothing is publishable, so the migration refuses outright and says why
    expect(() => runMenu(nest(200, 'deep-page'))).toThrow(/too deeply nested/)
  })
})
