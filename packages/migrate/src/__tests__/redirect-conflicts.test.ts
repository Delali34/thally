/** A migrated redirect set must never hide a served page or send a visitor in a circle. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createContext, Script } from 'node:vm'

import { checkCustomRoutes } from 'next/dist/lib/load-custom-routes.js'
import { modifyRouteRegex } from 'next/dist/lib/redirect-status.js'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match.js'
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination.js'
import { describe, expect, it } from 'vitest'

import { migrateRepository, migrateUrl, type MigrationFetcher } from '../index.js'
import { dropConflictingRedirects, dropUnroutableRedirects } from '../redirects.js'
import type { MigrationBundle, MigrationDocsConfig, MigrationWarning } from '../types.js'

type Redirects = NonNullable<MigrationDocsConfig['redirects']>

/**
 * First literal redirect cycle, followed the way a browser would, or null. The
 * first redirect listed for a source is the one that fires; a request is
 * matched on its path, so a destination's query and fragment are ignored and
 * its dot segments are resolved; a destination off the site ends the walk.
 */
function redirectCycle(redirects: Redirects): Array<string> | null {
  const next = new Map<string, string>()
  for (const { source, destination } of redirects) if (!next.has(source)) next.set(source, /^(https?:)?\/\//.test(destination) ? '' : new URL(destination.split(/[?#]/, 1)[0], 'http://x').pathname)
  for (const start of next.keys()) {
    const path = [start]
    for (let current = next.get(start); current; current = next.get(current)) {
      if (path.includes(current)) return [...path, current]
      path.push(current)
    }
  }
  return null
}

/**
 * `dropConflictingRedirects` under a watchdog. A test timeout cannot interrupt a
 * synchronous loop, but a `vm` timeout can, so a hang is reported as a failure
 * instead of freezing the run.
 */
const watchdog = { script: new Script('result = drop({ tabs: [], redirects }, pages, warnings)'), context: createContext({ drop: dropConflictingRedirects }) }

function dropWithin(redirects: Redirects, pages: ReadonlyArray<{ id: string }>, limitMs = 1000): { redirects: Redirects; warnings: Array<MigrationWarning> } {
  const warnings: Array<MigrationWarning> = []
  Object.assign(watchdog.context, { redirects, pages, warnings })
  watchdog.script.runInContext(watchdog.context, { timeout: limitMs })
  return { redirects: (watchdog.context as { result: MigrationDocsConfig }).result.redirects ?? [], warnings }
}

/** Deterministic generator (mulberry32), so a failing redirect set can be rebuilt from its seed. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const messages = (bundle: MigrationBundle): string => bundle.warnings.map((warning) => warning.message).join('\n')

function mintlify(config: Record<string, unknown>, pages: Record<string, string>): MigrationBundle {
  const root = mkdtempSync(join(tmpdir(), 'thally-redirect-conflicts-'))
  writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', ...config }))
  for (const [path, content] of Object.entries(pages)) {
    mkdirSync(dirname(join(root, `${path}.mdx`)), { recursive: true })
    writeFileSync(join(root, `${path}.mdx`), content)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
}

describe('Mintlify redirects that would loop or hide a page', () => {
  it('keeps the root page at / when the source redirected /introduction back to /', () => {
    const bundle = mintlify({
      redirects: [{ source: '/introduction', destination: '/' }, { source: '/old', destination: '/guide' }],
      navigation: { groups: [{ group: 'Start', pages: ['index', 'guide'] }] },
    }, {
      index: '---\ntitle: Home\n---\n\nWelcome.',
      guide: '---\ntitle: Guide\n---\n\nBody.',
    })
    const redirects = bundle.docsConfig.redirects ?? []
    expect(bundle.pages.map((page) => page.id)).toContain('introduction')
    // Mintlify served the root index at `/`: the root stays the page and `/introduction` stays an alias of it.
    expect(redirects).toContainEqual({ source: '/introduction', destination: '/', permanent: true })
    expect(redirects.some((redirect) => redirect.source === '/')).toBe(false)
    expect(redirects).toContainEqual({ source: '/old', destination: '/guide', permanent: true })
    expect(redirectCycle(redirects)).toBeNull()
    expect(messages(bundle)).not.toContain('/introduction')
  })

  it('still drops /introduction -> / when / itself redirects to another page', () => {
    const bundle = mintlify({
      redirects: [{ source: '/', destination: '/guide' }, { source: '/introduction', destination: '/' }],
      navigation: { groups: [{ group: 'Start', pages: ['index', 'guide'] }] },
    }, {
      index: '---\ntitle: Home\n---\n\nWelcome.',
      guide: '---\ntitle: Guide\n---\n\nBody.',
    })
    const redirects = bundle.docsConfig.redirects ?? []
    expect(redirects).toContainEqual({ source: '/', destination: '/guide', permanent: true })
    expect(redirects.some((redirect) => redirect.source === '/introduction')).toBe(false)
    expect(redirectCycle(redirects)).toBeNull()
  })

  it('drops a redirect from a differently cased address to a page, and says it can come back on a case-sensitive host', () => {
    const bundle = mintlify({
      redirects: [{ source: '/Guide', destination: '/guide' }, { source: '/old', destination: '/guide' }],
      navigation: { groups: [{ group: 'Start', pages: ['index', 'guide'] }] },
    }, {
      index: '---\ntitle: Home\n---\n\nWelcome.',
      guide: '---\ntitle: Guide\n---\n\nBody.',
    })
    const redirects = bundle.docsConfig.redirects ?? []
    expect(redirects.map((redirect) => redirect.source)).not.toContain('/Guide')
    expect(redirects).toContainEqual({ source: '/old', destination: '/guide', permanent: true })
    expect(messages(bundle)).toContain('Skipped 1 redirect from /Guide: that URL differs only in letter case from a page in this site, so on a server that ignores letter case it would hide that page. If your host matches URLs case-sensitively, add it back to docs.json.')
    expect(messages(bundle)).not.toMatch(/Self-redirect|also a page/)
  })

  it('keeps a redirect that does not touch a page', () => {
    const bundle = mintlify({
      redirects: [{ source: '/old', destination: '/guide' }],
      navigation: { groups: [{ group: 'Start', pages: ['index', 'guide'] }] },
    }, { index: '# Home\n\nWelcome.', guide: '# Guide\n\nBody.' })
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/old', destination: '/guide', permanent: true })
    expect(messages(bundle)).not.toMatch(/hide|circle/)
  })

  it('drops the redirect that closes a cycle between two missing URLs and keeps the first', () => {
    const bundle = mintlify({
      redirects: [{ source: '/a', destination: '/b' }, { source: '/b', destination: '/a' }],
      navigation: { groups: [{ group: 'Start', pages: ['index'] }] },
    }, { index: '# Home\n\nWelcome.' })
    const redirects = bundle.docsConfig.redirects ?? []
    expect(redirects).toContainEqual({ source: '/a', destination: '/b', permanent: true })
    expect(redirects.some((redirect) => redirect.source === '/b')).toBe(false)
    expect(redirectCycle(redirects)).toBeNull()
    expect(messages(bundle)).toContain('/b')
  })
})

describe('Mintlify catch-all redirects whose prefix is a page', () => {
  it('keeps a trailing :path* redirect for deeper paths, so the page it also matched at zero segments stays reachable', () => {
    const bundle = mintlify({
      redirects: [
        { source: '/docs/sdks/typescript/:path*', destination: '/docs/sdks/typescript' },
        { source: '/old', destination: '/docs/sdks/typescript' },
      ],
      navigation: { groups: [{ group: 'Start', pages: ['index', 'docs/sdks/typescript'] }] },
    }, {
      index: '---\ntitle: Home\n---\n\nWelcome.',
      'docs/sdks/typescript': '---\ntitle: TypeScript\n---\n\nBody.',
    })
    const redirects = bundle.docsConfig.redirects ?? []
    expect(bundle.pages.map((page) => page.id)).toContain('docs/sdks/typescript')
    expect(redirects).toContainEqual({ source: '/docs/sdks/typescript/:path+', destination: '/docs/sdks/typescript', permanent: true })
    expect(redirects.map((redirect) => redirect.source)).not.toContain('/docs/sdks/typescript/:path*')
    expect(redirects).toContainEqual({ source: '/old', destination: '/docs/sdks/typescript', permanent: true })
    expect(messages(bundle)).not.toMatch(/Skipped|circle|hide/)
  })
})

describe('Mintlify root catch-all redirects', () => {
  it('keeps the home page reachable at /, since /:path* also matches the root', () => {
    const bundle = mintlify({
      redirects: [{ source: '/:path*', destination: 'https://example.com/docs' }],
      navigation: { groups: [{ group: 'Start', pages: ['index', 'guide'] }] },
    }, {
      index: '---\ntitle: Home\n---\n\nWelcome.',
      guide: '---\ntitle: Guide\n---\n\nBody.',
    })
    expect(bundle.pages.map((page) => page.id)).toContain('introduction')
    const redirects = bundle.docsConfig.redirects ?? []
    expect(redirects).toContainEqual({ source: '/:path+', destination: 'https://example.com/docs', permanent: true })
    expect(redirects.map((redirect) => redirect.source)).not.toContain('/:path*')
  })
})

describe('Mintlify redirects to an address outside the site', () => {
  // docs.json of dub.co: live Mintlify answers both with a 308 to the external address.
  const external = [
    { source: '/docs/examples', destination: 'https://github.com/dubinc/examples' },
    { source: '/docs/integrations/zapier', destination: 'https://dub.co/integrations/zapier' },
  ]

  it('carries them through a repository migration unchanged, with no warning about them', () => {
    const bundle = mintlify({
      redirects: [...external, { source: '/evil', destination: '//evil.example' }, { source: '/script', destination: 'javascript:alert(1)' }],
      navigation: { groups: [{ group: 'Start', pages: ['index'] }] },
    }, { index: '---\ntitle: Home\n---\n\nWelcome.' })
    const redirects = bundle.docsConfig.redirects ?? []
    for (const redirect of external) expect(redirects).toContainEqual({ ...redirect, permanent: true })
    expect(redirects.map((redirect) => redirect.source)).not.toContain('/evil')
    expect(redirects.map((redirect) => redirect.source)).not.toContain('/script')
    expect(bundle.warnings.filter((warning) => /docs\/examples|zapier/.test(warning.message))).toEqual([])
    expect(messages(bundle)).toContain('Skipped 2 redirects from /evil, /script')
  })

  it('treats one as the end of a chain, so a page it also names is not mistaken for a loop', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const input: MigrationDocsConfig = { tabs: [], redirects: [...external, { source: '/a', destination: '/docs/examples' }] }
    expect(dropUnroutableRedirects(input, warnings)).toBe(input)
    expect(dropConflictingRedirects(input, [{ id: 'introduction' }], warnings)).toBe(input)
    expect(warnings).toEqual([])
  })

  it("is composed by Next's own matcher with the scheme and host intact", () => {
    for (const { source, destination } of external) {
      expect(() => checkCustomRoutes([{ source, destination, permanent: false }], 'redirect')).not.toThrow()
      const match = getPathMatch(source, { removeUnnamedParams: true, strict: true })
      const { parsedDestination, newUrl } = prepareDestination({ appendParamsToQuery: false, destination, params: match(source) as Record<string, string>, query: {} })
      expect(`${parsedDestination.protocol}//${parsedDestination.hostname}${newUrl}`).toBe(destination)
    }
  })
})

describe('Mintlify redirect status through a repository migration', () => {
  it('makes an authored redirect permanent by default and leaves the redirects the migrator adds temporary', () => {
    const bundle = mintlify({
      redirects: [
        { source: '/old', destination: '/guide' },
        { source: '/kept-temporary', destination: '/guide', permanent: false },
        { source: '/docs/examples', destination: 'https://github.com/dubinc/examples' },
      ],
      navigation: { groups: [{ group: 'Start', pages: ['index', 'section/overview'] }] },
    }, {
      index: '---\ntitle: Home\n---\n\nWelcome.',
      guide: '---\ntitle: Guide\n---\n\nBody.',
      'section/overview': '---\ntitle: Section\n---\n\nBody.',
    })
    const redirects = bundle.docsConfig.redirects ?? []
    expect(redirects).toContainEqual({ source: '/old', destination: '/guide', permanent: true })
    expect(redirects).toContainEqual({ source: '/kept-temporary', destination: '/guide', permanent: false })
    expect(redirects).toContainEqual({ source: '/docs/examples', destination: 'https://github.com/dubinc/examples', permanent: true })
    // The route aliases the migrator creates on its own keep the flag they were made with.
    expect(redirects).toContainEqual({ source: '/section', destination: '/section/overview', permanent: false })
  })
})

describe('Mintlify default version redirects', () => {
  it('leaves the page a version alias would hide alone, and says nothing about the alias', () => {
    const bundle = mintlify({
      navigation: { versions: [
        { version: 'v2', default: true, groups: [{ group: 'Start', pages: ['v2/guide'] }] },
        { version: 'v1', groups: [{ group: 'Start', pages: ['v1/guide'] }] },
      ] },
    }, {
      'v2/guide': '# Guide v2\n\nBody.',
      'v1/guide': '# Guide v1\n\nBody.',
      guide: '# Guide\n\nBody.',
    })
    expect(bundle.pages.map((page) => page.id)).toContain('guide')
    expect((bundle.docsConfig.redirects ?? []).map((redirect) => redirect.source)).not.toContain('/guide')
    expect(messages(bundle)).not.toMatch(/\/guide/)
  })
})

describe('Fern and Docusaurus redirects that hide a page', () => {
  it('drops a Fern redirect whose source is a page of the site', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-redirect-conflicts-fern-'))
    mkdirSync(join(root, 'fern'))
    writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
    writeFileSync(join(root, 'fern', 'docs.yml'), [
      'title: Docs',
      'navigation:',
      '  - page: Guide',
      '    path: guide.mdx',
      '  - page: Other',
      '    path: other.mdx',
      'redirects:',
      '  - source: /guide',
      '    destination: /other',
      '  - source: /old',
      '    destination: /other',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'fern', 'guide.mdx'), '# Guide\n\nBody.')
    writeFileSync(join(root, 'fern', 'other.mdx'), '# Other\n\nBody.')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    const sources = (bundle.docsConfig.redirects ?? []).map((redirect) => redirect.source)
    expect(bundle.pages.map((page) => page.id)).toContain('guide')
    expect(sources).toContain('/old')
    expect(sources).not.toContain('/guide')
    expect(messages(bundle)).toContain('/guide')
  })

  it('drops a Docusaurus redirect whose source is a page of the site', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-redirect-conflicts-docusaurus-'))
    writeFileSync(join(root, 'docusaurus.config.js'), [
      'module.exports = { presets: [["classic", { docs: {} }]], plugins: [["@docusaurus/plugin-client-redirects", { redirects: [',
      '  { from: "/guide", to: "/other" },',
      '  { from: "/old", to: "/other" },',
      '] }]] }',
    ].join('\n'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\nBody.')
    writeFileSync(join(root, 'docs', 'other.md'), '# Other\n\nBody.')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    const sources = (bundle.docsConfig.redirects ?? []).map((redirect) => redirect.source)
    expect(bundle.pages.map((page) => page.id)).toContain('guide')
    expect(sources).toContain('/old')
    expect(sources).not.toContain('/guide')
    expect(messages(bundle)).toContain('/guide')
  })
})


describe('URL migration redirects', () => {
  it('leaves out a redirect Next.js cannot match literally, as a repository migration does', async () => {
    const sourceUrl = 'https://product.test/docs/introduction'
    const navigation = { global: null, dropdowns: [{ dropdown: 'Documentation', groups: [{ group: 'Start', pages: [{ title: 'Welcome', href: '/introduction' }] }] }] }
    const docsConfig = {
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: [] },
      redirects: [{ source: '/client/c++/intro', destination: '/introduction' }, { source: '/old', destination: '/introduction' }],
    }
    const flight = [
      `18:["$","$Provider",null,{"value":{"docsConfig":${JSON.stringify(docsConfig)}}}]`,
      `19:["$","$Scoped",null,{"scopedNav":${JSON.stringify(navigation)}}]`,
    ].join('\n')
    const html = `<html><head><link href="/docs/_mintlify/site.css"></head><body><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`
    const markdown = '# Welcome\n\nWelcome to the product.'
    const respond = (url: string, body: string, contentType: string) => ({ finalUrl: new URL(url), body, contentType })
    const fetcher: MigrationFetcher = async (url, request) => {
      if (url.toString() === sourceUrl && request.accept.startsWith('text/html')) return respond(sourceUrl, html, 'text/html')
      if (url.toString() === sourceUrl) return { ...respond(sourceUrl, markdown, 'text/markdown'), headers: { 'x-llms-txt': '/docs/llms.txt' } }
      if (url.pathname === '/docs/llms.txt') return respond(url.toString(), '- [Page](/docs/introduction)', 'text/plain')
      if (url.pathname.replace(/\.md$/, '') === '/docs/introduction') return respond(url.toString(), markdown, 'text/markdown')
      throw new Error(`missing fixture: ${url}`)
    }
    const bundle = await migrateUrl({ sourceUrl, platform: 'mintlify', fetcher })
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/old', destination: '/introduction', permanent: true })
    expect((bundle.docsConfig.redirects ?? []).map((redirect) => redirect.source)).not.toContain('/client/c++/intro')
    expect(messages(bundle)).toContain('Skipped 1 redirect from /client/c++/intro')
  })
})

describe('dropConflictingRedirects', () => {
  const pages = [{ id: 'introduction' }, { id: 'guide' }, { id: 'fr/guide' }, { id: 'section/index' }]
  const config = (redirects: Redirects): MigrationDocsConfig => ({ tabs: [], redirects })

  it('leaves patterns, query destinations and an unrelated redirect alone', () => {
    const redirects: Redirects = [
      { source: '/docs/:slug*', destination: '/guide' },
      { source: '/legacy', destination: '/guide?tab=x' },
      { source: '/', destination: '/introduction', permanent: true },
    ]
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    expect(dropConflictingRedirects(config(redirects), pages, warnings).redirects).toEqual(redirects)
    expect(warnings).toEqual([])
  })

  it('rewrites a trailing :name* to :name+ when its zero-segment reading is a page, keeping the destination and flags', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([
      { source: '/guide/:path*', destination: '/guide' },
      { source: '/section/:path*', destination: '/docs/section/:path*', permanent: true },
      { source: '/fr/guide/:rest*', destination: '/x?y=1' },
    ]), pages, warnings)
    expect(result.redirects).toEqual([
      { source: '/guide/:path+', destination: '/guide' },
      { source: '/section/:path+', destination: '/docs/section/:path*', permanent: true },
      { source: '/fr/guide/:rest+', destination: '/x?y=1' },
    ])
    expect(warnings).toEqual([])
  })

  it('rewrites a trailing :name* whose zero-segment reading is its own destination, even when no page is there', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([
      { source: '/docs/:path*', destination: '/docs' },
      { source: '/api/:path*', destination: '/api/?view=all#top' },
      { source: '/:path*', destination: '/' },
    ]), pages, warnings)
    expect(result.redirects).toEqual([
      { source: '/docs/:path+', destination: '/docs' },
      { source: '/api/:path+', destination: '/api/?view=all#top' },
      { source: '/:path+', destination: '/' },
    ])
    expect(warnings).toEqual([])
  })

  it('rewrites a root catch-all whose destination is elsewhere, because the home page is served at /', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([
      { source: '/:path*', destination: 'https://example.com/docs', permanent: true },
    ]), pages, warnings)
    expect(result.redirects).toEqual([{ source: '/:path+', destination: 'https://example.com/docs', permanent: true }])
    expect(warnings).toEqual([])
    const match = getPathMatch('/:path+', { removeUnnamedParams: true, strict: true })
    expect(match('/')).toBe(false)
    expect(match('/anything/deeper')).toEqual({ path: ['anything', 'deeper'] })
  })

  it('leaves a root catch-all alone when nothing else answers at /', () => {
    const noHome = config([{ source: '/:path*', destination: 'https://example.com/docs' }])
    expect(dropConflictingRedirects(noHome, [{ id: 'guide' }], [])).toBe(noHome)
  })

  it('rewrites a root catch-all when / has a redirect of its own, in either order, so that redirect is the one that fires', () => {
    const shadowing = config([{ source: '/:path*', destination: 'https://example.com/docs' }, { source: '/', destination: '/guide' }])
    expect(dropConflictingRedirects(shadowing, [{ id: 'guide' }], []).redirects).toEqual([
      { source: '/:path+', destination: 'https://example.com/docs' },
      { source: '/', destination: '/guide' },
    ])
    const rootFirst = config([{ source: '/', destination: '/guide' }, { source: '/:path*', destination: 'https://example.com/docs' }])
    expect(dropConflictingRedirects(rootFirst, pages, []).redirects).toEqual([
      { source: '/', destination: '/guide' },
      { source: '/:path+', destination: 'https://example.com/docs' },
    ])
  })

  describe('a catch-all that ends in a slash', () => {
    /** The matcher `next start` builds for a redirect source: strict path-to-regexp plus Next's optional trailing slash. */
    const served = (source: string) => getPathMatch(source, { strict: true, removeUnnamedParams: true, regexModifier: (regex) => modifyRouteRegex(regex, ['/_next']) })

    it('reads the zero-segment path of /:path*/ as the root, like /:path*, and narrows it', () => {
      expect(served('/:path*/')('/')).toEqual({})
      const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
      const result = dropConflictingRedirects(config([{ source: '/:path*/', destination: 'https://example.com/docs', permanent: true }]), pages, warnings)
      expect(result.redirects).toEqual([{ source: '/:path+/', destination: 'https://example.com/docs', permanent: true }])
      expect(warnings).toEqual([])
      expect(() => checkCustomRoutes([{ ...result.redirects![0], permanent: true }], 'redirect')).not.toThrow()
      expect(served(result.redirects![0].source)('/')).toBe(false)
      expect(served(result.redirects![0].source)('/old/deeper/')).toEqual({ path: ['old', 'deeper'] })
    })

    it('narrows /x/:path*/ in the same cases as /x/:path*: a page or its own destination at the prefix', () => {
      const result = dropConflictingRedirects(config([
        { source: '/guide/:path*/', destination: '/guide' },
        { source: '/fr/guide/:rest*/', destination: '/x' },
        { source: '/docs/:path*/', destination: '/docs?view=all' },
        { source: '/Guide/:path*/', destination: '/x' },
      ]), pages, [])
      expect(result.redirects).toEqual([
        { source: '/guide/:path+/', destination: '/guide' },
        { source: '/fr/guide/:rest+/', destination: '/x' },
        { source: '/docs/:path+/', destination: '/docs?view=all' },
        { source: '/Guide/:path+/', destination: '/x' },
      ])
    })

    it('leaves a slashed catch-all alone when its zero-segment reading is neither a page nor its destination, and when nothing answers at /', () => {
      const input = config([
        { source: '/old/:path*/', destination: '/new/:path*' },
        { source: '/legacy/:path*/', destination: '/guide' },
      ])
      expect(dropConflictingRedirects(input, pages, [])).toBe(input)
      const noHome = config([{ source: '/:path*/', destination: 'https://example.com/docs' }])
      expect(dropConflictingRedirects(noHome, [{ id: 'guide' }], [])).toBe(noHome)
    })

    it('keeps the narrowed source through a second pass, which is how a remote spec and then the repository both see it', () => {
      const once = dropConflictingRedirects(config([{ source: '/:path*/', destination: 'https://example.com/docs' }, { source: '/guide/:path*/', destination: '/guide' }]), pages, [])
      const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
      expect(dropConflictingRedirects(dropUnroutableRedirects(once, warnings), pages, warnings)).toBe(once)
      expect(warnings).toEqual([])
    })
  })

  it('judges the zero-segment reading under both readings of letter case', () => {
    const result = dropConflictingRedirects(config([
      { source: '/Guide/:path*', destination: '/x' },
      { source: '/DOCS/api/:rest*', destination: '/docs/API' },
    ]), pages, [])
    expect(result.redirects).toEqual([
      { source: '/Guide/:path+', destination: '/x' },
      { source: '/DOCS/api/:rest+', destination: '/docs/API' },
    ])
  })

  it('leaves a catch-all alone when its zero-segment reading is neither a page nor its destination', () => {
    const input = config([
      { source: '/old/:path*', destination: '/new/:path*' },
      { source: '/legacy/:path*', destination: '/guide' },
      { source: '/docs/:slug*', destination: '/docs/v2/:slug*' },
    ])
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    expect(dropConflictingRedirects(input, pages, warnings)).toBe(input)
    expect(warnings).toEqual([])
  })

  it('leaves a source alone unless its only pattern is a final :name* segment', () => {
    const input = config([
      { source: '/guide/*/:path*', destination: '/guide' },
      { source: '/guide/*', destination: '/guide' },
      { source: '/:lang/guide/:path*', destination: '/guide' },
      { source: '/guide/:a*/:b*', destination: '/guide' },
      { source: '/guide/:path+', destination: '/guide' },
      { source: '/guide/:path', destination: '/guide' },
    ])
    expect(dropConflictingRedirects(input, pages, [])).toBe(input)
  })

  it('leaves /introduction/:path* -> / alone: like /introduction -> /, it only retires an alias of the root page', () => {
    const input = config([{ source: '/introduction/:path*', destination: '/' }])
    expect(dropConflictingRedirects(input, pages, [])).toBe(input)
    const rootRedirected = config([{ source: '/', destination: '/guide' }, { source: '/introduction/:path*', destination: '/' }])
    expect(dropConflictingRedirects(rootRedirected, pages, []).redirects).toEqual([{ source: '/', destination: '/guide' }, { source: '/introduction/:path+', destination: '/' }])
  })

  it('writes a redirect Next accepts, which no longer matches the page but still matches deeper paths', () => {
    const [{ source, destination }, pair] = dropConflictingRedirects(config([
      { source: '/guide/:path*', destination: '/guide' },
      { source: '/section/:path*', destination: '/docs/section/:path*' },
    ]), pages, []).redirects!
    for (const redirect of [{ source, destination }, pair]) expect(() => checkCustomRoutes([{ ...redirect, permanent: false }], 'redirect')).not.toThrow()
    const match = getPathMatch(source, { removeUnnamedParams: true, strict: true })
    expect(match('/guide')).toBe(false)
    expect(match('/guide/overview')).toEqual({ path: ['overview'] })
    expect(prepareDestination({ appendParamsToQuery: false, destination, params: match('/guide/a/b') as Record<string, string | Array<string>>, query: {} }).newUrl).toBe('/guide')
    const matchPair = getPathMatch(pair.source, { removeUnnamedParams: true, strict: true })
    expect(matchPair('/section')).toBe(false)
    expect(prepareDestination({ appendParamsToQuery: false, destination: pair.destination, params: matchPair('/section/a/b') as Record<string, string | Array<string>>, query: {} }).newUrl).toBe('/docs/section/a/b')
  })

  it('does not rewrite a source it already rewrote, so a second pass over a migrated set changes nothing', () => {
    const once = dropConflictingRedirects(config([{ source: '/guide/:path*', destination: '/guide' }]), pages, [])
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    expect(dropConflictingRedirects(dropUnroutableRedirects(once, warnings), pages, warnings)).toBe(once)
    expect(warnings).toEqual([])
  })

  it('drops a redirect from any served page, including locale pages and a directory index', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([
      { source: '/guide/', destination: '/x' },
      { source: '/fr/guide', destination: '/x' },
      { source: '/section', destination: '/x' },
      { source: '/keep', destination: '/x' },
    ]), pages, warnings)
    expect(result.redirects).toEqual([{ source: '/keep', destination: '/x' }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('/guide/, /fr/guide, /section')
  })

  it('breaks a longer cycle at the redirect that closes it', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([
      { source: '/a', destination: '/b' },
      { source: '/b', destination: '/c' },
      { source: '/c', destination: '/a' },
      { source: '/d', destination: '/a' },
    ]), pages, warnings)
    expect(result.redirects).toEqual([
      { source: '/a', destination: '/b' },
      { source: '/b', destination: '/c' },
      { source: '/d', destination: '/a' },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('/c')
  })

  it('compares routes without regard to letter case, since a server may ignore it', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([
      { source: '/Guide', destination: '/guide' },
      { source: '/FR/guide', destination: '/x' },
      { source: '/a', destination: '/B' },
      { source: '/b', destination: '/A' },
      { source: '/Quickstart', destination: '/quickstart' },
      { source: '/guide/', destination: '/x' },
    ]), pages, warnings)
    expect(result.redirects).toEqual([{ source: '/a', destination: '/B' }])
    expect(warnings.map((warning) => warning.message)).toEqual([
      'Skipped 1 redirect from /guide/: that URL is also a page in this site, and a redirect would hide it. To redirect instead, delete the page and add the redirect to docs.json.',
      'Skipped 2 redirects from /Guide, /FR/guide: those URLs differ only in letter case from pages in this site, so on a server that ignores letter case they would hide those pages. If your host matches URLs case-sensitively, add them back to docs.json.',
      'Skipped 2 redirects that would send visitors in a circle on a server that ignores letter case, since the addresses involved differ only in letter case: /b -> /A, /Quickstart -> /quickstart. If your host matches URLs case-sensitively, add them back to docs.json.',
    ])
  })

  it('breaks a cycle whose routes differ in case, keeping the redirect listed first', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([
      { source: '/a', destination: '/B' },
      { source: '/b', destination: '/A' },
      { source: '/c', destination: '/d' },
      { source: '/D', destination: '/C' },
    ]), pages, warnings)
    expect(result.redirects).toEqual([{ source: '/a', destination: '/B' }, { source: '/c', destination: '/d' }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('/b -> /A, /D -> /C')
    expect(warnings[0].message).toContain('letter case')
  })

  it('still breaks a loop between routes of the same case', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([
      { source: '/Old', destination: '/New' },
      { source: '/New', destination: '/Old' },
    ]), pages, warnings)
    expect(result.redirects).toEqual([{ source: '/Old', destination: '/New' }])
    expect(warnings.map((warning) => warning.message)).toEqual(['Skipped 1 redirect that would send visitors in a circle: /New -> /Old. Check these redirects in the source docs.'])
  })

  it('words a conflict as a letter-case one only when letter case alone causes it', () => {
    const exact: Array<{ code: 'unsupported-config'; message: string }> = []
    dropConflictingRedirects(config([
      { source: '/guide', destination: '/x' },
      { source: '/Old', destination: '/New' },
      { source: '/New', destination: '/Old' },
    ]), pages, exact)
    expect(exact).toHaveLength(2)
    expect(exact.map((warning) => warning.message).join('\n')).not.toMatch(/letter case|case-sensitive/)

    const onlyCase: Array<{ code: 'unsupported-config'; message: string }> = []
    dropConflictingRedirects(config([
      { source: '/Guide', destination: '/x' },
      { source: '/a', destination: '/B' },
      { source: '/b', destination: '/A' },
    ]), pages, onlyCase)
    expect(onlyCase).toHaveLength(2)
    for (const warning of onlyCase) expect(warning.message).toMatch(/only in letter case/)
    expect(onlyCase.map((warning) => warning.message).join('\n')).not.toMatch(/also a page|Check these redirects/)
  })

  it('walks a long chain of redirects once, however they are ordered', () => {
    const size = 20_000
    // Each redirect points at the source of the one listed before it, so every walk would reach the end of the chain.
    const chain: Redirects = Array.from({ length: size }, (_, index) => ({ source: `/p${size - index}`, destination: `/p${size - index + 1}` }))
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropConflictingRedirects(config([...chain, { source: `/p${size + 1}`, destination: '/p1' }]), pages, warnings)
    expect(result.redirects).toEqual(chain)
    expect(warnings).toHaveLength(1)
  })

  it('does not hang on redirects that loop only when letter case is respected', () => {
    const { redirects, warnings } = dropWithin([
      { source: '/a', destination: '/end' },
      { source: '/A', destination: '/b' },
      { source: '/b', destination: '/A' },
      { source: '/end', destination: '/A' },
    ], pages)
    expect(redirects).toEqual([{ source: '/a', destination: '/end' }, { source: '/A', destination: '/b' }])
    expect(warnings.map((warning) => warning.message)).toEqual([
      'Skipped 1 redirect that would send visitors in a circle: /b -> /A. Check these redirects in the source docs.',
      'Skipped 1 redirect that would send visitors in a circle on a server that ignores letter case, since the addresses involved differ only in letter case: /end -> /A. If your host matches URLs case-sensitively, add it back to docs.json.',
    ])
  }, 2000)

  it('checks a case variant of a listed source, which only a case-sensitive host serves, for a loop of its own', () => {
    const { redirects, warnings } = dropWithin([
      { source: '/a', destination: '/b' },
      { source: '/A', destination: '/C' },
      { source: '/C', destination: '/A' },
    ], pages)
    expect(redirects).toEqual([{ source: '/a', destination: '/b' }, { source: '/A', destination: '/C' }])
    expect(warnings.map((warning) => warning.message)).toEqual(['Skipped 1 redirect that would send visitors in a circle: /C -> /A. Check these redirects in the source docs.'])
  }, 2000)

  it('follows a destination with a query by its path, since Next matches a redirect source on the path alone', () => {
    const { redirects, warnings } = dropWithin([
      { source: '/a', destination: '/b?x=1' },
      { source: '/b', destination: '/a' },
    ], pages)
    expect(redirects).toEqual([{ source: '/a', destination: '/b?x=1' }])
    expect(warnings.map((warning) => warning.message)).toEqual(['Skipped 1 redirect that would send visitors in a circle: /b -> /a. Check these redirects in the source docs.'])
  }, 2000)

  it('follows a destination with a fragment by its path, under both readings of letter case', () => {
    const { redirects, warnings } = dropWithin([
      { source: '/a', destination: '/b/#top' },
      { source: '/b', destination: '/a' },
      { source: '/c', destination: '/D?x=1' },
      { source: '/d', destination: '/C#top' },
      { source: '/e', destination: '/E#top' },
    ], pages)
    expect(redirects).toEqual([{ source: '/a', destination: '/b/#top' }, { source: '/c', destination: '/D?x=1' }])
    expect(warnings.map((warning) => warning.message)).toEqual([
      'Skipped 1 redirect that would send visitors in a circle: /b -> /a. Check these redirects in the source docs.',
      'Skipped 2 redirects that would send visitors in a circle on a server that ignores letter case, since the addresses involved differ only in letter case: /d -> /C#top, /e -> /E#top. If your host matches URLs case-sensitively, add them back to docs.json.',
    ])
  }, 2000)

  it('drops a redirect to its own path with only a query or fragment added, since the source matches the path alone', () => {
    const { redirects, warnings } = dropWithin([
      { source: '/g', destination: '/g?view=all' },
      { source: '/h', destination: '/h/#top' },
      { source: '/i', destination: '/j?view=all' },
    ], pages)
    expect(redirects).toEqual([{ source: '/i', destination: '/j?view=all' }])
    expect(warnings.map((warning) => warning.message)).toEqual(['Skipped 2 redirects that would send visitors in a circle: /g -> /g?view=all, /h -> /h/#top. Check these redirects in the source docs.'])
  }, 2000)

  it('keeps a destination with a query or fragment that does not lead back, and an address off the site', () => {
    const input: Redirects = [
      { source: '/a', destination: '/b?x=1' },
      { source: '/b', destination: '/c#top' },
      { source: '/d', destination: '/a?y=2' },
      { source: '/e', destination: '//example.com/e' },
      { source: '/example.com/e', destination: '/e' },
      { source: '/f', destination: 'https://example.com/f?z=1' },
    ]
    const { redirects, warnings } = dropWithin(input, pages)
    expect(redirects).toEqual(input)
    expect(warnings).toEqual([])
  }, 2000)

  it('keeps a later redirect from a source whose first redirect leaves the site, which never fires', () => {
    const input: Redirects = [
      { source: '/a', destination: 'https://example.com' },
      { source: '/a', destination: '/b' },
      { source: '/b', destination: '/a' },
      { source: '/c', destination: '//example.com/c' },
      { source: '/c', destination: '/d' },
      { source: '/d', destination: '/c' },
    ]
    const { redirects, warnings } = dropWithin(input, pages)
    expect(redirects).toEqual(input)
    expect(warnings).toEqual([])
  }, 2000)

  it('still checks a case variant of a source that leaves the site, which a case-sensitive host serves', () => {
    const { redirects, warnings } = dropWithin([
      { source: '/e', destination: 'https://example.com' },
      { source: '/E', destination: '/f' },
      { source: '/f', destination: '/E' },
    ], pages)
    expect(redirects).toEqual([{ source: '/e', destination: 'https://example.com' }, { source: '/E', destination: '/f' }])
    expect(warnings.map((warning) => warning.message)).toEqual(['Skipped 1 redirect that would send visitors in a circle: /f -> /E. Check these redirects in the source docs.'])
  }, 2000)

  it('resolves dot segments in a destination, written plainly or percent-encoded, before looking for a loop', () => {
    const { redirects, warnings } = dropWithin([
      { source: '/a', destination: '/x/../a' },
      { source: '/b', destination: '/x/%2e%2e/b' },
      { source: '/c', destination: '/x/%2E%2e/./c' },
      { source: '/d', destination: '/x/../e' },
      { source: '/e', destination: '/d' },
      { source: '/f', destination: '/x/../g' },
    ], pages)
    expect(redirects).toEqual([{ source: '/d', destination: '/x/../e' }, { source: '/f', destination: '/x/../g' }])
    expect(warnings.map((warning) => warning.message)).toEqual(['Skipped 4 redirects that would send visitors in a circle: /a -> /x/../a, /b -> /x/%2e%2e/b, /c -> /x/%2E%2e/./c, /e -> /d. Check these redirects in the source docs.'])
  }, 2000)

  it('keeps no loop and no hidden page under either comparison, over seeded random mixed-case sets', () => {
    const random = seeded(20261017)
    const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)]
    const routes = ['/a', '/A', '/b', '/B', '/c', '/C', '/end']
    const foldAll = (list: Redirects): Redirects => list.map(({ source, destination }) => ({ source: source.toLowerCase(), destination: destination.toLowerCase() }))
    let dropped = 0
    for (let run = 0; run < 2000; run++) {
      const sitePages = ['a', 'B', 'c', 'end'].filter(() => random() < 0.1).map((id) => ({ id }))
      const served = new Set(sitePages.map((page) => `/${page.id.toLowerCase()}`))
      const suffix = (): string => (random() < 0.3 ? pick(['?q=1', '#x']) : '')
      const prefix = (): string => (random() < 0.15 ? pick(['/x/..', '/x/%2e%2E', '/x/.%2e/y/..']) : '')
      const destination = (): string => (random() < 0.12 ? pick(['https://example.com/a', '//example.com/b']) : `${prefix()}${pick(routes)}${suffix()}`)
      const input: Redirects = Array.from({ length: 1 + Math.floor(random() * 8) }, () => ({ source: pick(routes), destination: destination() }))
      const context = JSON.stringify({ run, pages: sitePages.map((page) => page.id), input })
      const { redirects: kept, warnings } = dropWithin(input, sitePages)
      // Safe: next start (case ignored) and OpenNext (case kept) each follow the first redirect listed for a source.
      expect(redirectCycle(kept), context).toBeNull()
      expect(redirectCycle(foldAll(kept)), context).toBeNull()
      expect(kept.filter((redirect) => served.has(redirect.source.toLowerCase())), context).toEqual([])
      // Not over-eager: each dropped redirect hid a page or closed a loop with the redirects kept before it.
      const text = warnings.map((warning) => warning.message).join('\n')
      input.forEach((redirect, index) => {
        if (kept.includes(redirect)) return
        dropped++
        const earlier = [...kept.filter((other) => input.indexOf(other) < index), redirect]
        const unsafe = served.has(redirect.source.toLowerCase()) || redirectCycle(earlier) !== null || redirectCycle(foldAll(earlier)) !== null
        expect(unsafe, context).toBe(true)
        expect(text, context).toContain(redirect.source)
      })
    }
    expect(dropped).toBeGreaterThan(1000)
  }, 10_000)

  it('returns a config without redirects unchanged', () => {
    const bare: MigrationDocsConfig = { tabs: [] }
    expect(dropConflictingRedirects(bare, pages, [])).toBe(bare)
  })
})

describe('dropUnroutableRedirects', () => {
  const config = (redirects: Redirects): MigrationDocsConfig => ({ tabs: [], redirects })

  it('omits self-redirects and sources with route-pattern operators, naming the operator sources in one warning', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropUnroutableRedirects(config([
      { source: '/docs/models/', destination: '/docs/models' },
      { source: '/docs/models', destination: '/docs/models?view=all' },
      { source: '/sdk/c++/users', destination: '/api/users' },
      { source: '/sdk/c++/groups', destination: '/api/groups' },
      { source: '/docs/:slug*', destination: '/guide' },
      { source: '/keep', destination: '/guide' },
    ]), warnings)
    expect(result.redirects).toEqual([
      { source: '/docs/models', destination: '/docs/models?view=all' },
      { source: '/docs/:slug*', destination: '/guide' },
      { source: '/keep', destination: '/guide' },
    ])
    expect(warnings).toHaveLength(2)
    expect(warnings[0].message).toBe('Self-redirect from /docs/models/ to /docs/models was omitted.')
    expect(warnings[1].message).toContain('Skipped 2 redirects from /sdk/c++/users, /sdk/c++/groups')
  })

  it('keeps a source that ends in a :name+ catch-all, and still omits a literal + before it', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const result = dropUnroutableRedirects(config([
      { source: '/docs/sdks/:path+', destination: '/docs/sdks' },
      { source: '/sdk/c++/:rest+', destination: '/x' },
      { source: '/docs/:path+/more', destination: '/x' },
    ]), warnings)
    expect(result.redirects).toEqual([{ source: '/docs/sdks/:path+', destination: '/docs/sdks' }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('Skipped 2 redirects from /sdk/c++/:rest+, /docs/:path+/more')
  })

  describe('route syntax in a destination', () => {
    /** The path `next start` redirects to when this destination is followed, or the error it throws while compiling it. */
    const followed = (destination: string, params: Record<string, string | Array<string>> = {}): string => prepareDestination({ appendParamsToQuery: false, destination, params, query: {} }).newUrl

    it('percent-encodes + ( ) in the path, which Next cannot compile raw, for an address off the site and on it', () => {
      const input: Redirects = [
        { source: '/a', destination: 'https://example.com/a+b' },
        { source: '/b', destination: 'https://example.com/(group)/x?y=1+2#top' },
        { source: '/c', destination: '/c++(d)' },
        { source: '/d/:path*', destination: '/new+x/:path*' },
      ]
      for (const { destination } of input.slice(0, 3)) expect(() => followed(destination), destination).toThrow()
      const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
      const result = dropUnroutableRedirects(config(input), warnings)
      expect(result.redirects).toEqual([
        { source: '/a', destination: 'https://example.com/a%2Bb' },
        { source: '/b', destination: 'https://example.com/%28group%29/x?y=1+2#top' },
        { source: '/c', destination: '/c%2B%2B%28d%29' },
        { source: '/d/:path*', destination: '/new%2Bx/:path*' },
      ])
      expect(warnings).toEqual([])
      expect(() => checkCustomRoutes(result.redirects!.map((redirect) => ({ ...redirect, permanent: true })), 'redirect')).not.toThrow()
      // Next sends the visitor to the same path the source docs named: %2B and %28 decode to the + and ( written there.
      expect(decodeURIComponent(followed(result.redirects![0].destination))).toBe('/a+b')
      expect(decodeURIComponent(followed(result.redirects![1].destination))).toBe('/(group)/x#top')
      expect(decodeURIComponent(followed(result.redirects![2].destination))).toBe('/c++(d)')
      expect(followed(result.redirects![3].destination, { path: ['x', 'y'] })).toBe('/new%2Bx/x/y')
    })

    it('leaves [ ] { }, a percent escape, the query, the fragment and a :param segment as written, since Next compiles them as they are', () => {
      const input = config([
        { source: '/a', destination: 'https://example.com/a[b]/{c}/x%2By' },
        { source: '/b', destination: '/d[e]/%28f%29?q=a+(b)#h' },
        { source: '/c/:path*', destination: '/new/:path*' },
        { source: '/d', destination: 'https://example.com:8080/x' },
      ])
      expect(dropUnroutableRedirects(input, [])).toBe(input)
      for (const { destination } of input.redirects!.filter((redirect) => !redirect.source.includes(':'))) expect(() => followed(destination), destination).not.toThrow()
    })

    it('omits a redirect whose host holds route syntax, which a host cannot escape, and says so once', () => {
      const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
      expect(() => followed('https://a+b.example.com/x')).toThrow()
      expect(() => followed('https://a(b).example.com/x')).toThrow()
      const result = dropUnroutableRedirects(config([
        { source: '/a', destination: 'https://a+b.example.com/x' },
        { source: '/b', destination: 'https://a(b).example.com/x' },
        { source: '/c', destination: 'https://example.com/x' },
      ]), warnings)
      expect(result.redirects).toEqual([{ source: '/c', destination: 'https://example.com/x' }])
      expect(warnings.map((warning) => warning.message)).toEqual([
        'Skipped 2 redirects from /a (a+b.example.com), /b (a(b).example.com): the address each leads to has a host name that is not valid (a host name has only letters, digits, hyphens, underscores and dots, then an optional :port), so following them would fail. Check these redirects in the source docs.',
      ])
    })

    // Next compiles the host as the URL parser decodes it, so `exa%2Bmple.com` reaches path-to-regexp as `exa+mple.com`.
    it('omits a redirect whose host, once decoded, is not a valid DNS name, and says why', () => {
      const hosts = ['exa%2Bmple.com', 'exa%28mple.com', 'exa%7Bmple.com', 'a..example.com', '-bad.example.com']
      for (const host of hosts.slice(0, 3)) expect(() => followed(`https://${host}/x`), host).toThrow()
      const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
      const result = dropUnroutableRedirects(config([
        ...hosts.map((host, index) => ({ source: `/r${index}`, destination: `https://${host}/x` })),
        { source: '/keep', destination: 'https://example.com/x' },
      ]), warnings)
      expect(result.redirects).toEqual([{ source: '/keep', destination: 'https://example.com/x' }])
      expect(warnings).toHaveLength(1)
      expect(warnings[0].message).toContain('from /r0 (exa+mple.com), /r1 (exa(mple.com), /r2 (exa{mple.com), /r3 (a..example.com)')
      expect(warnings[0].message).toContain('has a host name that is not valid (a host name has only letters, digits, hyphens, underscores and dots')
    })

    it('keeps a host written with percent escapes, capitals, an underscore, an international name, an IP address or a port, which Next compiles as plain text', () => {
      const input = config([
        { source: '/a', destination: 'https://ex%61mple.com/x' },
        { source: '/b', destination: 'https://EXAMPLE.com/x' },
        { source: '/c', destination: 'https://münchen.de/x' },
        { source: '/d', destination: 'https://xn--mnchen-3ya.de/x' },
        { source: '/e', destination: 'http://127.0.0.1:3000/x' },
        { source: '/f', destination: 'https://docs.example.com:8443/x?y=1' },
        { source: '/g', destination: 'https://example.com./x' },
        { source: '/h', destination: 'https://my_app.example.com/x' },
      ])
      for (const { destination } of input.redirects!) expect(() => followed(destination), destination).not.toThrow()
      const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
      expect(dropUnroutableRedirects(input, warnings)).toBe(input)
      expect(warnings).toEqual([])
    })

    // A destination may only use the parameters its source defines: Next throws `Expected "oops" to be a string` for any other,
    // and a destination on the site is refused at build time (`destination has segments not in source or has`).
    describe('a :name in the destination that the source does not define', () => {
      const build = (redirects: Redirects) => checkCustomRoutes(redirects.map((redirect) => ({ ...redirect, permanent: true })), 'redirect')
      const quiet = (run: () => unknown) => {
        const error = console.error
        console.error = () => {}
        try {
          return run()
        } finally {
          console.error = error
        }
      }

      it('writes the colon as %3A in an address off the site, which Next then redirects to as written', () => {
        expect(() => followed('https://example.com/docs/:oops')).toThrow('Expected "oops" to be a string')
        const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
        const result = dropUnroutableRedirects(config([{ source: '/old', destination: 'https://example.com/docs/:oops?x=:oops#top' }]), warnings)
        expect(result.redirects).toEqual([{ source: '/old', destination: 'https://example.com/docs/%3Aoops?x=:oops#top' }])
        expect(warnings).toEqual([])
        expect(followed(result.redirects![0].destination)).toBe('/docs/%3Aoops#top')
        expect(decodeURIComponent(followed(result.redirects![0].destination))).toBe('/docs/:oops#top')
      })

      it('does the same for a path on the site, which also fails the build as written', () => {
        quiet(() => expect(() => build([{ source: '/old', destination: '/docs/:oops' }])).toThrow())
        const result = dropUnroutableRedirects(config([{ source: '/old', destination: '/docs/:oops' }]), [])
        expect(result.redirects).toEqual([{ source: '/old', destination: '/docs/%3Aoops' }])
        expect(() => build(result.redirects!)).not.toThrow()
        expect(followed(result.redirects![0].destination)).toBe('/docs/%3Aoops')
      })

      it('writes a colon that is not the start of a name, or sits inside a segment, the same way', () => {
        const input = [
          { source: '/a', destination: 'https://example.com/times/10:30' },
          { source: '/b', destination: '/ratio/:' },
          { source: '/c', destination: '/x/a:b/c' },
          { source: '/d', destination: '/y/:*/z/:+' },
        ]
        for (const { destination } of input) expect(() => followed(destination), destination).toThrow()
        const result = dropUnroutableRedirects(config(input), [])
        expect(result.redirects!.map((redirect) => redirect.destination)).toEqual(['https://example.com/times/10%3A30', '/ratio/%3A', '/x/a%3Ab/c', '/y/%3A%2A/z/%3A%2B'])
        for (const { destination } of result.redirects!) expect(() => followed(destination), destination).not.toThrow()
      })

      it('keeps every parameter the source defines, whether the destination is on the site or off it', () => {
        const input = config([
          { source: '/a/:id', destination: '/b/:id' },
          { source: '/c/:path*', destination: 'https://example.com/d/:path*' },
          { source: '/e/:one/:two', destination: 'https://example.com/:two/:one/:one' },
          { source: '/f/:rest+', destination: '/g/:rest+' },
          { source: '/h/:section/:rest*', destination: '/i/:section/:rest*' },
        ])
        const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
        expect(dropUnroutableRedirects(input, warnings)).toBe(input)
        expect(warnings).toEqual([])
        expect(followed('https://example.com/:two/:one/:one', { one: '1', two: '2' })).toBe('/2/1/1')
      })

      it('encodes only the parameters the source lacks, in a destination that also uses its own', () => {
        const result = dropUnroutableRedirects(config([{ source: '/a/:id', destination: '/b/:id/:other/:id' }]), [])
        expect(result.redirects).toEqual([{ source: '/a/:id', destination: '/b/:id/%3Aother/:id' }])
        expect(followed(result.redirects![0].destination, { id: '7' })).toBe('/b/7/%3Aother/7')
      })

      it('omits a wildcard the source does not have, and says why', () => {
        // `:rest+` throws when it is followed, `:rest*` is left out of the address it sends visitors to, and a site path with either fails the build.
        expect(() => followed('https://example.com/docs/:rest+')).toThrow('Expected "rest" to be an array')
        expect(followed('https://example.com/docs/:rest*')).toBe('/docs')
        quiet(() => expect(() => build([{ source: '/a', destination: '/docs/:rest*' }])).toThrow())
        const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
        const result = dropUnroutableRedirects(config([
          { source: '/a', destination: '/docs/:rest*' },
          { source: '/b/:id', destination: 'https://example.com/docs/:rest+' },
          { source: '/keep', destination: '/docs' },
        ]), warnings)
        expect(result.redirects).toEqual([{ source: '/keep', destination: '/docs' }])
        expect(warnings.map((warning) => warning.message)).toEqual([
          'Redirect from /a to /docs/:rest* was omitted: its destination has :rest*, a wildcard the source does not have, so there is nothing to fill it with.',
          'Redirect from /b/:id to https://example.com/docs/:rest+ was omitted: its destination has :rest+, a wildcard the source does not have, so there is nothing to fill it with.',
        ])
      })

      it('omits a destination that writes a wildcard of the source without its * or +, which Next cannot compile either', () => {
        expect(() => followed('/b/:p', { p: ['x'] })).toThrow('multi-match')
        const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
        const result = dropUnroutableRedirects(config([
          { source: '/a/:p*', destination: '/b/:p' },
          { source: '/c/:p+', destination: 'https://example.com/:p/x' },
          { source: '/d/:p', destination: '/e/:p' },
        ]), warnings)
        expect(result.redirects).toEqual([{ source: '/d/:p', destination: '/e/:p' }])
        expect(warnings.map((warning) => warning.message)).toEqual([
          'Redirect from /a/:p* to /b/:p was omitted: :p matches several path segments in the source, so its destination has to write it :p* or :p+, and Next.js cannot follow it otherwise.',
          'Redirect from /c/:p+ to https://example.com/:p/x was omitted: :p matches several path segments in the source, so its destination has to write it :p* or :p+, and Next.js cannot follow it otherwise.',
        ])
      })

      it('carries the redirect through a Mintlify migration in a form Next follows', () => {
        const bundle = mintlify({
          redirects: [{ source: '/old', destination: 'https://example.com/:oops' }, { source: '/older', destination: '/guide/:oops' }],
          navigation: { groups: [{ group: 'Start', pages: ['index', 'guide'] }] },
        }, { index: '# Home\n\nWelcome.', guide: '# Guide\n\nBody.' })
        const redirects = bundle.docsConfig.redirects ?? []
        expect(redirects).toContainEqual({ source: '/old', destination: 'https://example.com/%3Aoops', permanent: true })
        expect(redirects).toContainEqual({ source: '/older', destination: '/guide/%3Aoops', permanent: true })
        expect(() => build(redirects)).not.toThrow()
        for (const { destination } of redirects) expect(() => followed(destination), destination).not.toThrow()
      })

      it('does not change a destination again on a second pass', () => {
        const once = dropUnroutableRedirects(config([{ source: '/a', destination: 'https://example.com/:oops' }, { source: '/b/:id', destination: '/c/:id/:x' }]), [])
        const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
        expect(dropUnroutableRedirects(once, warnings)).toBe(once)
        expect(warnings).toEqual([])
      })
    })

    it('does not encode again on a second pass, which is how a remote spec and then the repository both see a redirect', () => {
      const once = dropUnroutableRedirects(config([{ source: '/a', destination: 'https://example.com/a+b' }]), [])
      const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
      expect(dropUnroutableRedirects(once, warnings)).toBe(once)
      expect(warnings).toEqual([])
    })

    it('carries a Mintlify redirect to an address with + or ( ) in its path through a migration in a form Next can follow', () => {
      const bundle = mintlify({
        redirects: [{ source: '/old', destination: 'https://example.com/a+b' }, { source: '/older', destination: '/guide(v2)' }],
        navigation: { groups: [{ group: 'Start', pages: ['index', 'guide'] }] },
      }, { index: '# Home\n\nWelcome.', guide: '# Guide\n\nBody.' })
      const redirects = bundle.docsConfig.redirects ?? []
      expect(redirects).toContainEqual({ source: '/old', destination: 'https://example.com/a%2Bb', permanent: true })
      expect(redirects).toContainEqual({ source: '/older', destination: '/guide%28v2%29', permanent: true })
      expect(() => checkCustomRoutes(redirects.map((redirect) => ({ ...redirect, permanent: true })), 'redirect')).not.toThrow()
      for (const { destination } of redirects) expect(() => followed(destination), destination).not.toThrow()
    })
  })

  it('leaves a redirect between two cases of one address to the conflict check, which says why', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const input = config([{ source: '/Guide', destination: '/guide' }])
    expect(dropUnroutableRedirects(input, warnings)).toBe(input)
    expect(warnings).toEqual([])
  })

  it('returns the same config, and says nothing, when every redirect is routable', () => {
    const warnings: Array<{ code: 'unsupported-config'; message: string }> = []
    const input = config([{ source: '/a', destination: '/b' }])
    expect(dropUnroutableRedirects(input, warnings)).toBe(input)
    expect(warnings).toEqual([])
  })
})
