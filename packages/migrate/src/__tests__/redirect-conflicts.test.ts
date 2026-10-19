/** A migrated redirect set must never hide a served page or send a visitor in a circle. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createContext, Script } from 'node:vm'

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
    expect(redirects).toContainEqual({ source: '/introduction', destination: '/' })
    expect(redirects.some((redirect) => redirect.source === '/')).toBe(false)
    expect(redirects).toContainEqual({ source: '/old', destination: '/guide' })
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
    expect(redirects).toContainEqual({ source: '/', destination: '/guide' })
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
    expect(redirects).toContainEqual({ source: '/old', destination: '/guide' })
    expect(messages(bundle)).toContain('Skipped 1 redirect from /Guide: that URL differs only in letter case from a page in this site, so on a server that ignores letter case it would hide that page. If your host matches URLs case-sensitively, add it back to docs.json.')
    expect(messages(bundle)).not.toMatch(/Self-redirect|also a page/)
  })

  it('keeps a redirect that does not touch a page', () => {
    const bundle = mintlify({
      redirects: [{ source: '/old', destination: '/guide' }],
      navigation: { groups: [{ group: 'Start', pages: ['index', 'guide'] }] },
    }, { index: '# Home\n\nWelcome.', guide: '# Guide\n\nBody.' })
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/old', destination: '/guide' })
    expect(messages(bundle)).not.toMatch(/hide|circle/)
  })

  it('drops the redirect that closes a cycle between two missing URLs and keeps the first', () => {
    const bundle = mintlify({
      redirects: [{ source: '/a', destination: '/b' }, { source: '/b', destination: '/a' }],
      navigation: { groups: [{ group: 'Start', pages: ['index'] }] },
    }, { index: '# Home\n\nWelcome.' })
    const redirects = bundle.docsConfig.redirects ?? []
    expect(redirects).toContainEqual({ source: '/a', destination: '/b' })
    expect(redirects.some((redirect) => redirect.source === '/b')).toBe(false)
    expect(redirectCycle(redirects)).toBeNull()
    expect(messages(bundle)).toContain('/b')
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
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/old', destination: '/introduction' })
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
