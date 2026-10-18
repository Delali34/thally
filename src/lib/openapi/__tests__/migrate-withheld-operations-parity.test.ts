/**
 * Monorepo-only contract test: an operation only an access-restricted page
 * documents must be gone from the spec the renderer publishes, however the
 * restricted page spelled the spec's name. This stays out of standalone
 * starters, which do not contain the migration package source.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateRepository } from '../../../../packages/migrate/src/repository'
import { parseOpenApiFrontmatter } from '@/lib/openapi/page-frontmatter'
import { pageReferenceState, type OperationPublicationState } from '@/lib/openapi/publication'
import { sanitizeSpecForPublication } from '@/lib/openapi/sanitize'
import type { OpenAPIDocument } from '@/lib/openapi/types'

const spec = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'T', version: '1' },
  paths: { '/x': { get: { summary: 'PUBLIC' } }, '/internal': { get: { summary: 'SECRET' } } },
})
const page = (extra = ''): string => `---\ntitle: P\n${extra}---\n\nBody.\n`

/** Migrates a Mintlify repository written to a temporary folder. */
function migrate(files: Record<string, string>): ReturnType<typeof migrateRepository> {
  const root = mkdtempSync(join(tmpdir(), 'thally-withheld-parity-'))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
}

/** The paths each published spec still lists after the renderer's sanitiser ran. */
function publishedPathsOf(bundle: ReturnType<typeof migrate>): Record<string, Array<string>> {
  return Object.fromEntries(bundle.assets.filter((asset) => asset.path.startsWith('openapi/')).map((asset) => {
    const published = sanitizeSpecForPublication(JSON.parse(Buffer.from(asset.content).toString('utf8')) as OpenAPIDocument)
    return [asset.path, Object.keys(published.paths ?? {}).sort()]
  }))
}

/** Migrates a Mintlify repository and returns the paths each published spec still lists after the renderer's sanitiser ran. */
function publishedPaths(files: Record<string, string>): Record<string, Array<string>> {
  return publishedPathsOf(migrate(files))
}

/** What the renderer's page-reference state says about a migrated page: `excluded` is a page that 404s. */
function renderedPageState(bundle: ReturnType<typeof migrate>, id: string): OperationPublicationState {
  const openapi = bundle.pages.find((page) => page.id === id)?.openapi
  const sources = [...new Set(bundle.docsConfig.tabs.flatMap((tab) => tab.api ? [tab.api.source] : []))]
  return pageReferenceState(parseOpenApiFrontmatter(openapi)!, sources.map((path) => ({
    config: { id: path, label: '', source: { type: 'file' as const, path } },
    document: JSON.parse(Buffer.from(bundle.assets.find((asset) => asset.path === path)!.content).toString('utf8')) as unknown,
  })))
}

describe('migrate withheld operations parity', () => {
  it('drops a restricted operation from the published spec when the restricted ref is written as ./spec, spec#frag or spec?v=3', () => {
    for (const config of ['docs.json', 'mint.json']) {
      for (const spelling of ['./spec', 'spec#section', 'spec?version=3']) {
        expect(publishedPaths({
          [config]: JSON.stringify(config === 'docs.json' ? { navigation: { pages: ['pub', 's'] } } : { navigation: [{ group: 'G', pages: ['pub', 's'] }] }),
          'spec.json': spec,
          'pub.mdx': page('openapi: "spec GET /x"\n'),
          's.mdx': page(`groups: [admin]\nopenapi: "${spelling} GET /internal"\n`),
        })).toEqual({ 'openapi/spec.json': ['/x'] })
      }
    }
  })

  it('drops a restricted operation from a spec renamed to avoid a file name collision', () => {
    expect(publishedPaths({
      'docs.json': JSON.stringify({ navigation: { tabs: [
        { tab: 'Guides', pages: ['pub', 's'] },
        { tab: 'A', openapi: 'a/spec.json' },
        { tab: 'B', openapi: 'b/spec.json' },
      ] } }),
      'a/spec.json': spec,
      'b/spec.json': spec,
      'pub.mdx': page('openapi: "spec GET /internal"\n'),
      's.mdx': page('groups: [admin]\nopenapi: "b/spec.json GET /internal"\n'),
    })).toEqual({ 'openapi/spec.json': ['/internal', '/x'], 'openapi/b-spec.json': ['/x'] })
  })

  describe('bare operation references keep an operation public only in the spec they belong to', () => {
    const specWith = (...paths: Array<string>): string => JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: Object.fromEntries(paths.map((path) => [path, { get: { summary: path } }])),
    })
    const specs = {
      'first.json': specWith('/ping'),
      'second.json': specWith('/health', '/x'),
      'public.json': specWith('/x'),
    }
    const withSpecs = (files: Record<string, string>): Record<string, Array<string>> => publishedPaths({ ...specs, ...files })
    /** Two top-level specs, plus another API area bound to `public.json` whose navigation lists a bare `GET /x`. */
    const twoDefaults = (config: string, pages: Array<string>): string => JSON.stringify(
      config === 'docs.json'
        ? { api: { openapi: ['first.json', 'second.json'] }, navigation: { tabs: [{ tab: 'Guides', pages }, { tab: 'Public API', openapi: 'public.json', pages: ['GET /x'] }] } }
        : { api: { openapi: ['first.json', 'second.json'] }, tabs: [{ name: 'Public API', url: 'public', openapi: 'public.json' }], navigation: [{ group: 'Guides', pages }, { group: 'Public API', pages: ['GET /x'] }] },
    )

    for (const config of ['docs.json', 'mint.json']) {
      it(`does not let a bare navigation entry of another API area keep a restricted operation public (${config})`, () => {
        const result = withSpecs({
          [config]: twoDefaults(config, ['pub', 's']),
          'pub.mdx': page('openapi: "second.json GET /health"\n'),
          's.mdx': page('groups: [admin]\nopenapi: "second.json GET /x"\n'),
        })
        expect(result['openapi/second.json']).toEqual(['/health'])
        expect(result['openapi/first.json']).toEqual(['/ping'])
      })

      it(`does not let a bare page reference that belongs to no single spec keep a restricted operation public (${config})`, () => {
        expect(withSpecs({
          [config]: twoDefaults(config, ['pub', 's', 'bare']),
          'pub.mdx': page('openapi: "second.json GET /health"\n'),
          'bare.mdx': page('openapi: "GET /x"\n'),
          's.mdx': page('groups: [admin]\nopenapi: "second.json GET /x"\n'),
        })['openapi/second.json']).toEqual(['/health'])
      })

      it(`keeps an operation public in the site's default spec when a bare navigation entry names it (${config})`, () => {
        expect(withSpecs({
          [config]: JSON.stringify(config === 'docs.json'
            ? { api: { openapi: 'public.json' }, navigation: { pages: ['pub', 's', 'GET /x'] } }
            : { api: { openapi: 'public.json' }, navigation: [{ group: 'G', pages: ['pub', 's', 'GET /x'] }] }),
          'pub.mdx': page(),
          's.mdx': page('groups: [admin]\nopenapi: "public.json GET /x"\n'),
        })['openapi/public.json']).toEqual(['/x'])
      })
    }

    it('keeps an operation public in the spec the tab of a bare navigation entry binds', () => {
      const result = withSpecs({
        'docs.json': twoDefaults('docs.json', ['pub', 's']),
        'pub.mdx': page(),
        's.mdx': page('groups: [admin]\nopenapi: "public.json GET /x"\n'),
      })
      expect(result['openapi/public.json']).toEqual(['/x'])
    })

    it('keeps an operation public in the spec the tab listing a bare page reference binds', () => {
      expect(withSpecs({
        'docs.json': JSON.stringify({ navigation: { tabs: [
          { tab: 'Guides', pages: ['s'] },
          { tab: 'Public API', openapi: 'public.json', pages: ['bare'] },
        ] } }),
        'bare.mdx': page('openapi: "GET /x"\n'),
        's.mdx': page('groups: [admin]\nopenapi: "public.json GET /x"\n'),
      })['openapi/public.json']).toEqual(['/x'])
    })
  })

  describe('a bare public reference keeps its operation public wherever its page is listed', () => {
    const secret = page('groups: [admin]\nopenapi: "b.json GET /internal"\n')
    const tabs = (...entries: Array<Record<string, unknown>>): string => JSON.stringify({ navigation: { tabs: entries } })

    for (const [listed, file] of [['reference', 'reference/index.mdx'], ['reference/index', 'reference.mdx'], ['/reference.md', 'reference/index.mdx']]) {
      it(`resolves a page listed as ${listed} to its file ${file}`, () => {
        const bundle = migrate({
          'docs.json': tabs({ tab: 'B', openapi: 'b.json', pages: [listed, 'secret'] }),
          'b.json': spec,
          [file]: page('openapi: "GET /internal"\n'),
          'secret.mdx': secret,
        })
        expect(publishedPathsOf(bundle)['openapi/b.json']).toEqual(['/internal', '/x'])
        expect(renderedPageState(bundle, 'reference')).toBe('published')
      })
    }

    for (const spelling of ['/b.json', './b.json']) {
      it(`counts ${spelling} and b.json as one owner when two tabs list the page`, () => {
        const bundle = migrate({
          'docs.json': tabs({ tab: 'A', openapi: 'b.json', pages: ['pub', 'secret'] }, { tab: 'C', openapi: spelling, pages: ['pub'] }),
          'b.json': spec,
          'pub.mdx': page('openapi: "GET /internal"\n'),
          'secret.mdx': secret,
        })
        expect(publishedPathsOf(bundle)['openapi/b.json']).toEqual(['/internal', '/x'])
        expect(renderedPageState(bundle, 'pub')).toBe('published')
      })
    }

    it('counts a spec named by its folder path and by its file name as one owner', () => {
      const bundle = migrate({
        'docs.json': tabs({ tab: 'A', openapi: 'specs/b.json', pages: ['pub', 'secret'] }, { tab: 'C', openapi: 'b.json', pages: ['pub'] }),
        'specs/b.json': spec,
        'pub.mdx': page('openapi: "GET /internal"\n'),
        'secret.mdx': secret,
      })
      expect(Object.values(publishedPathsOf(bundle))).toEqual([['/internal', '/x']])
      expect(renderedPageState(bundle, 'pub')).toBe('published')
    })

    it('still withholds the operation from a spec the page is not listed under', () => {
      const bundle = migrate({
        'docs.json': tabs({ tab: 'B', openapi: 'b.json', pages: ['reference'] }, { tab: 'C', openapi: 'c.json', pages: ['secret'] }),
        'b.json': spec,
        'c.json': spec,
        'reference/index.mdx': page('openapi: "GET /internal"\n'),
        'secret.mdx': page('groups: [admin]\nopenapi: "c.json GET /internal"\n'),
      })
      expect(publishedPathsOf(bundle)).toEqual({ 'openapi/b.json': ['/internal', '/x'], 'openapi/c.json': ['/x'] })
    })

    it('still withholds the operation when the page is listed under tabs bound to different specs', () => {
      const bundle = migrate({
        'docs.json': tabs({ tab: 'A', openapi: 'a.json', pages: ['pub', 'secret'] }, { tab: 'B', openapi: 'b.json', pages: ['pub'] }),
        'a.json': spec,
        'b.json': spec,
        'pub.mdx': page('openapi: "GET /internal"\n'),
        'secret.mdx': secret,
      })
      expect(publishedPathsOf(bundle)['openapi/b.json']).toEqual(['/x'])
    })
  })
})

/** The document an asset of a migrated bundle holds. */
function documentAt(bundle: ReturnType<typeof migrate>, path: string): OpenAPIDocument {
  return JSON.parse(Buffer.from(bundle.assets.find((asset) => asset.path === path)!.content).toString('utf8')) as OpenAPIDocument
}

/** The document a migrated page's `openapi` frontmatter points at: the bytes the page renders. */
function documentBoundTo(bundle: ReturnType<typeof migrate>, id: string): OpenAPIDocument {
  return documentAt(bundle, parseOpenApiFrontmatter(bundle.pages.find((entry) => entry.id === id)?.openapi)!.specRef!)
}

const titleOf = (document: OpenAPIDocument): string => (document.info as { title: string }).title

/** The paths each published spec still lists after the renderer's sanitiser ran, by the title of the spec. */
function publishedPathsByTitle(bundle: ReturnType<typeof migrate>): Record<string, Array<string>> {
  return Object.fromEntries(bundle.assets.filter((asset) => asset.path.startsWith('openapi/')).map((asset) => {
    const document = documentAt(bundle, asset.path)
    return [titleOf(document), Object.keys(sanitizeSpecForPublication(document).paths ?? {}).sort()]
  }))
}

/** Every page id the navigation lists, in any tab or group. */
function listedPageIds(bundle: ReturnType<typeof migrate>): Array<string> {
  const ids: Array<string> = []
  const visit = (nodes: ReadonlyArray<unknown> = []): void => {
    for (const node of nodes) {
      if (typeof node === 'string') ids.push(node)
      else if (node && typeof node === 'object') visit((node as { pages?: Array<unknown> }).pages)
    }
  }
  for (const tab of bundle.docsConfig.tabs) { visit(tab.pages); visit(tab.groups) }
  return ids
}

const titled = (title: string): string => JSON.stringify({
  openapi: '3.0.0',
  info: { title, version: '1' },
  paths: { '/x': { get: { summary: 'X' } }, '/y': { get: { summary: 'Y' } }, '/internal': { get: { summary: 'SECRET' } } },
})
/** The repository scan only picks a spec that opens with its `openapi` version, so one that does not is never the scan's choice, whatever order the folder lists its files in. */
const unscanned = (title: string): string => {
  const { openapi, ...rest } = JSON.parse(titled(title)) as Record<string, unknown>
  return JSON.stringify({ ...rest, openapi })
}

describe('every spec asset name comes from one allocator', () => {
  for (const spelling of ['b/openapi.json', '/b/openapi.json', './b/openapi.json']) {
    it(`binds a page-only spec to its own bytes when the repository scan chose another spec with the same file name (${spelling})`, () => {
      const bundle = migrate({
        'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
        'a/openapi.json': titled('DEFAULT-A'),
        'b/openapi.json': unscanned('PAGE-B'),
        'pub.mdx': page(`openapi: "${spelling} GET /x"\n`),
        'secret.mdx': page(`groups: [admin]\nopenapi: "${spelling} GET /internal"\n`),
      })
      expect(titleOf(documentBoundTo(bundle, 'pub'))).toBe('PAGE-B')
      expect(titleOf(documentAt(bundle, bundle.docsConfig.tabs.find((tab) => tab.api && !tab.hidden)!.api!.source))).toBe('DEFAULT-A')
      expect(publishedPathsByTitle(bundle)).toEqual({ 'DEFAULT-A': ['/internal', '/x', '/y'], 'PAGE-B': ['/x', '/y'] })
      expect(renderedPageState(bundle, 'pub')).toBe('published')
    })
  }
})

describe('a bare public reference belongs to the page its file publishes as', () => {
  const tabs = (...entries: Array<Record<string, unknown>>): string => JSON.stringify({ navigation: { tabs: entries } })

  // `guide/readme` and `guide/index` are two pages, however navigation spells them; each keeps its own tab's spec.
  for (const [readmeEntry, indexEntry] of [
    ['guide/readme.mdx', 'guide/index.mdx'], ['/guide/readme', '/guide/index'], ['guide/readme', 'guide/index'], ['guide/readme', 'guide/index.md'],
  ]) {
    for (const [readmeSpec, indexSpec] of [['a.json', 'b.json'], ['b.json', 'a.json']]) {
      it(`keeps ${readmeEntry} (${readmeSpec}) and ${indexEntry} (${indexSpec}) apart`, () => {
        const bundle = migrate({
          'docs.json': tabs(
            { tab: 'A', openapi: readmeSpec, pages: [readmeEntry] },
            { tab: 'B', openapi: indexSpec, pages: [indexEntry] },
          ),
          'a.json': titled('A'),
          'b.json': titled('B'),
          'guide/readme.mdx': page('openapi: "GET /y"\n'),
          'guide/index.mdx': page('openapi: "GET /x"\n'),
          // Restricted pages name each operation in each spec.
          'r1.mdx': page('groups: [admin]\nopenapi: "a.json GET /x"\n'),
          'r2.mdx': page('groups: [admin]\nopenapi: "a.json GET /y"\n'),
          'r3.mdx': page('groups: [admin]\nopenapi: "b.json GET /x"\n'),
          'r4.mdx': page('groups: [admin]\nopenapi: "b.json GET /y"\n'),
        })
        expect(bundle.pages.filter((entry) => entry.source.includes('#guide/')).map((entry) => entry.id).sort()).toEqual(['guide', 'guide/readme'])
        // Each public operation is published in its own tab's spec and withheld from the other.
        expect(publishedPathsByTitle(bundle)).toEqual({
          [readmeSpec === 'a.json' ? 'A' : 'B']: ['/internal', '/y'],
          [indexSpec === 'a.json' ? 'A' : 'B']: ['/internal', '/x'],
        })
        expect(renderedPageState(bundle, 'guide')).toBe('published')
        expect(renderedPageState(bundle, 'guide/readme')).toBe('published')
      })
    }
  }
})

describe('page and spec spellings resolve through one page identity and one asset allocator', () => {
  /** [how the navigation lists the page, the file that publishes as it]. */
  const pageSpellings: Array<[string, string]> = [
    ['x', 'x.mdx'], ['x', 'x/index.mdx'], ['x/index', 'x.mdx'], ['x/Index', 'x/index.mdx'],
    ['x/readme', 'x/readme.mdx'], ['/x', 'x.mdx'], ['x.mdx', 'x.mdx'],
  ]
  /** How docs.json and pages spell a spec file, which always has a namesake at `a/openapi.json`. */
  const specSpellings = ['openapi.json', '/openapi.json', './openapi.json', 'dir/openapi.json', '/dir/openapi.json', './dir/openapi.json']
  /** How the spec the page names is bound: by its own tab, by no tab (named only by pages), or beside the spec the repository scan picked. */
  const bindings = ['tab', 'page-only', 'scan'] as const
  const namesake = 'a/openapi.json'

  for (const binding of bindings) {
    for (const spelling of specSpellings) {
      it(`${binding}: ${spelling} binds its own bytes and a bare operation stays public only in its owner's spec, for every page spelling`, () => {
        const file = spelling.replace(/^(?:\.?\/+)+/, '')
        for (const [listed, pageFile] of pageSpellings) {
          const tab = { tab: 'B', openapi: spelling, pages: [listed, 'pub'] }
          const navigation = binding === 'tab'
            ? { tabs: [{ tab: 'A', openapi: namesake }, tab] }
            : binding === 'page-only' ? { tabs: [{ tab: 'A', openapi: namesake, pages: [listed, 'pub'] }] } : { pages: [listed, 'pub'] }
          const bundle = migrate({
            'docs.json': JSON.stringify({ navigation }),
            [namesake]: titled('NAMESAKE'),
            [file]: unscanned('TARGET'),
            'pub.mdx': page(`openapi: "${spelling} GET /x"\n`),
            [pageFile]: page('openapi: "GET /y"\n'),
            // Restricted pages name the same operations in each spec; each spelling resolves to exactly one of them (`openapi.json` is the root file, exactly), so /internal is withheld there alone.
            'r1.mdx': page(`groups: [admin]\nopenapi: "${spelling} GET /y"\n`),
            'r2.mdx': page(`groups: [admin]\nopenapi: "${namesake} GET /y"\n`),
            'r3.mdx': page(`groups: [admin]\nopenapi: "${spelling} GET /internal"\n`),
          })
          const label = `${binding} ${spelling} listed as ${listed} (${pageFile})`
          // The page is the one the navigation lists, whatever the spelling.
          const barePage = bundle.pages.find((entry) => entry.source.endsWith(`#${pageFile}`))!
          expect(listedPageIds(bundle), label).toContain(barePage.id)
          // A page's bound spec is the file it names, even when its namesake was bound first.
          expect(titleOf(documentBoundTo(bundle, 'pub')), label).toBe('TARGET')
          // The bare operation is public in the spec it belongs to: that of the tab it is listed under, else the scan's.
          const owner = binding === 'tab' ? 'TARGET' : 'NAMESAKE'
          expect(publishedPathsByTitle(bundle), label).toEqual({
            TARGET: owner === 'TARGET' ? ['/x', '/y'] : ['/x'],
            NAMESAKE: [...owner === 'NAMESAKE' ? ['/y'] : [], '/internal', '/x'].sort(),
          })
          expect(renderedPageState(bundle, barePage.id), label).toBe('published')
          expect(renderedPageState(bundle, 'pub'), label).toBe('published')
        }
      })
    }
  }
})

describe('a restricted spec reference withholds only from the spec a page would resolve it to', () => {
  const tabs = (...entries: Array<Record<string, unknown>>): string => JSON.stringify({ navigation: { tabs: entries } })
  const guides = { tab: 'Guides', pages: ['pub', 'secret'] }
  const twoSpecs = (...bound: Array<string>): string => tabs(guides, ...bound.map((source, index) => ({ tab: `T${index}`, openapi: source })))
  /** What the renderer publishes, keyed by the title of each spec. */
  const published = (bundle: ReturnType<typeof migrate>): Record<string, Array<string>> => publishedPathsByTitle(bundle)

  // `a.json` names the root file exactly, so it is not ambiguous with `b/a.json`; a ref names its spec in any spelling.
  for (const spelling of ['a.json', '/a.json', './a.json', 'a.json#section', 'a.json?v=3']) {
    it(`leaves b/a.json public when the public and the restricted page both name ${spelling} GET /x`, () => {
      const bundle = migrate({
        'docs.json': twoSpecs('a.json', 'b/a.json'),
        'a.json': titled('ROOT'),
        'b/a.json': titled('NESTED'),
        'pub.mdx': page(`openapi: "${spelling} GET /x"\n`),
        'secret.mdx': page(`groups: [admin]\nopenapi: "${spelling} GET /x"\n`),
      })
      // The operation is public where the public page names it; nothing names it in the other spec, so it stays public there.
      expect(published(bundle)).toEqual({ ROOT: ['/internal', '/x', '/y'], NESTED: ['/internal', '/x', '/y'] })
      expect(renderedPageState(bundle, 'pub')).toBe('published')
    })
  }

  for (const [restricted, other] of [['a.json', 'b/a.json'], ['b/a.json', 'a.json']]) {
    it(`withholds from ${restricted} only, and keeps the page naming ${other} published, when only the restricted page names ${restricted}`, () => {
      const bundle = migrate({
        'docs.json': twoSpecs('a.json', 'b/a.json'),
        'a.json': titled('ROOT'),
        'b/a.json': titled('NESTED'),
        'pub.mdx': page(`openapi: "${other} GET /x"\n`),
        'secret.mdx': page(`groups: [admin]\nopenapi: "${restricted} GET /x"\n`),
      })
      const [withheldTitle, keptTitle] = restricted === 'a.json' ? ['ROOT', 'NESTED'] : ['NESTED', 'ROOT']
      expect(published(bundle)).toEqual({ [withheldTitle]: ['/internal', '/y'], [keptTitle]: ['/internal', '/x', '/y'] })
      expect(renderedPageState(bundle, 'pub')).toBe('published')
    })
  }

  // A name that fits several specs names none of them alone: the restricted ref still withholds from every candidate.
  for (const spelling of ['a.json', 'a', 'A.JSON']) {
    it(`still withholds from every candidate when the restricted ref ${spelling} names several specs`, () => {
      const bundle = migrate({
        'docs.json': twoSpecs('x/a.json', 'y/a.json'),
        'x/a.json': titled('X'),
        'y/a.json': titled('Y'),
        'pub.mdx': page('openapi: "x/a.json GET /y"\n'),
        'secret.mdx': page(`groups: [admin]\nopenapi: "${spelling} GET /x"\n`),
      })
      expect(published(bundle)).toEqual({ X: ['/internal', '/y'], Y: ['/internal', '/y'] })
    })
  }

  it('still withholds a bare restricted operation from every spec', () => {
    const bundle = migrate({
      'docs.json': twoSpecs('a.json', 'b/a.json'),
      'a.json': titled('ROOT'),
      'b/a.json': titled('NESTED'),
      'pub.mdx': page('openapi: "a.json GET /y"\n'),
      'secret.mdx': page('groups: [admin]\nopenapi: "GET /x"\n'),
    })
    expect(published(bundle)).toEqual({ ROOT: ['/internal', '/y'], NESTED: ['/internal', '/y'] })
  })
})
