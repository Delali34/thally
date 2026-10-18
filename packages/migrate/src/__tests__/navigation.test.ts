/** Mintlify navigation projection invariants shared by every migration entrypoint. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addMintlifyDirectoryRedirects,
  parseMarkdownPage,
  projectMintlifyNavigation,
  pruneMissingNavigationPages,
} from '../index.js'
import { projectFernNavigation } from '../fern.js'
import { mintlifyNavigationApiReferences, readMintlifyConfig } from '../navigation.js'
import type { MigrationDocsConfig, MigrationPage } from '../types.js'

function page(id: string, navigationId = id, locale?: string): MigrationPage {
  return parseMarkdownPage({ id, navigationId, locale, raw: '# Example', source: 'https://example.com/docs' })!
}

describe('Mintlify referenced directory landings', () => {
  const tabs: MigrationDocsConfig['tabs'] = [{
    tab: 'Guides',
    groups: [{
      group: 'Examples',
      pages: [
        { group: 'Hidden', hidden: true, pages: ['guides/examples/hidden'] },
        { group: 'Nested', pages: ['guides/examples/webhook', 'guides/examples/database'] },
      ],
    }],
  }]

  it('resolves an empty wildcard destination to the first visible nested navigation page', () => {
    const authored = { source: '/examples/:slug*', destination: '/guides/examples/:slug*' }
    const result = addMintlifyDirectoryRedirects({ tabs, redirects: [authored] }, [
      page('guides/examples/database'), page('guides/examples/hidden'), page('guides/examples/webhook'),
    ])
    // '/guides' has no page of its own either, so it also redirects to the
    // same first-descendant landing page as '/guides/examples'.
    expect(result.redirects).toEqual([
      authored,
      { source: '/guides', destination: '/guides/examples/webhook', permanent: false },
      { source: '/guides/examples', destination: '/guides/examples/webhook', permanent: false },
    ])
  })

  it('preserves real directory pages and explicit redirect precedence', () => {
    const incoming = { source: '/examples/:slug*', destination: '/guides/examples/:slug*' }
    const realPage = addMintlifyDirectoryRedirects({ tabs, redirects: [incoming] }, [
      page('guides/examples'), page('guides/examples/webhook'),
    ])
    // '/guides/examples' is a real page and is never overridden, but its
    // ancestor '/guides' still has no page of its own and gets the general
    // first-descendant redirect.
    expect(realPage.redirects).toEqual([
      incoming,
      { source: '/guides', destination: '/guides/examples/webhook', permanent: false },
    ])
    for (const source of ['/guides/examples', '/guides/examples/:path*']) {
      const explicit = { source, destination: '/chosen' }
      const result = addMintlifyDirectoryRedirects({ tabs, redirects: [incoming, explicit] }, [page('guides/examples/webhook')])
      expect(result.redirects).toEqual([
        incoming,
        explicit,
        { source: '/guides', destination: '/guides/examples/webhook', permanent: false },
      ])
    }
  })

  it('adds no landing for an address that differs from a page or an authored redirect only in letter case', () => {
    const cased: MigrationDocsConfig['tabs'] = [{ tab: 'Guides', pages: ['Guides/Examples/webhook'] }]
    const authored = { source: '/guides/examples', destination: '/chosen' }
    const result = addMintlifyDirectoryRedirects({ tabs: cased, redirects: [authored] }, [page('Guides/Examples/webhook'), page('guides')])
    expect(result.redirects).toEqual([authored])
  })

  it('retains a conventional overview landing ahead of a first-descendant fallback', () => {
    const incoming = { source: '/examples', destination: '/guides/examples' }
    const result = addMintlifyDirectoryRedirects({ tabs, redirects: [incoming] }, [
      page('guides/examples/webhook'), page('guides/examples/overview'),
    ])
    expect(result.redirects).toEqual([
      incoming,
      { source: '/guides/examples', destination: '/guides/examples/overview', permanent: false },
      { source: '/guides', destination: '/guides/examples/webhook', permanent: false },
    ])
  })

  it('normalizes query and fragment suffixes without modifying the authored redirect', () => {
    const incoming = { source: '/examples/:slug*', destination: '/guides/examples/:slug*?tab=start#details' }
    const result = addMintlifyDirectoryRedirects({ tabs, redirects: [incoming] }, [page('guides/examples/webhook')])
    expect(result.redirects).toEqual([
      incoming,
      { source: '/guides', destination: '/guides/examples/webhook', permanent: false },
      { source: '/guides/examples', destination: '/guides/examples/webhook', permanent: false },
    ])
    expect(addMintlifyDirectoryRedirects(result, [page('guides/examples/webhook')])).toEqual(result)
  })

  it('resolves localized destination directories only to existing matching locale pages', () => {
    const config: MigrationDocsConfig = {
      tabs,
      i18n: { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }] },
      redirects: [
        { source: '/examples/:slug*', destination: '/guides/examples/:slug*' },
        { source: '/fr/examples/:slug*', destination: '/fr/guides/examples/:slug*' },
        { source: '/es/examples/:slug*', destination: '/es/guides/examples/:slug*' },
      ],
    }
    const result = addMintlifyDirectoryRedirects(config, [
      page('guides/examples/webhook', 'guides/examples/webhook', 'en'),
      page('fr/guides/examples/database', 'guides/examples/database', 'fr'),
    ])
    // Every French ancestor directory ('/fr', '/fr/guides', ...) resolves to
    // the French descendant, never to the English one.
    expect(result.redirects?.slice(3)).toEqual([
      { source: '/guides', destination: '/guides/examples/webhook', permanent: false },
      { source: '/guides/examples', destination: '/guides/examples/webhook', permanent: false },
      { source: '/fr', destination: '/fr/guides/examples/database', permanent: false },
      { source: '/fr/guides', destination: '/fr/guides/examples/database', permanent: false },
      { source: '/fr/guides/examples', destination: '/fr/guides/examples/database', permanent: false },
    ])
  })

  it('does not synthesize directories for pages outside the navigation', () => {
    const result = addMintlifyDirectoryRedirects({ tabs, redirects: [
      { source: '/old', destination: '/unlisted' },
      { source: '/required/:slug', destination: '/guides/examples/:slug' },
    ] }, [page('unlisted/child'), page('guides/examples/database')])
    // 'unlisted/child' is never referenced by the `tabs` fixture's
    // navigation, so no directory redirect is synthesized for it — only the
    // navigation-referenced 'guides/examples/database' page's ancestors do.
    expect(result.redirects).toEqual([
      { source: '/old', destination: '/unlisted' },
      { source: '/required/:slug', destination: '/guides/examples/:slug' },
      { source: '/guides', destination: '/guides/examples/database', permanent: false },
      { source: '/guides/examples', destination: '/guides/examples/database', permanent: false },
    ])
    expect(result.redirects?.some((redirect) => redirect.source === '/unlisted')).toBe(false)
  })

  it('redirects a nav-group directory with no page of its own even with no authored redirect pointing at it', () => {
    // Mirrors the live-site behavior this fix targets: a Mintlify container
    // path (e.g. a `product`/`tab`/`group`, such as Upstash's `/redis`) 307s
    // to its first descendant page purely from navigation structure — no
    // `redirects:` entry involved at all, which the previous implementation
    // required to ever produce this redirect.
    const result = addMintlifyDirectoryRedirects({ tabs }, [
      page('guides/examples/webhook'), page('guides/examples/database'),
    ])
    expect(result.redirects).toEqual([
      { source: '/guides', destination: '/guides/examples/webhook', permanent: false },
      { source: '/guides/examples', destination: '/guides/examples/webhook', permanent: false },
    ])
  })
})

describe('Mintlify navigation projection', () => {
  it('defaults icons to Font Awesome like Mintlify, unless the source names a library', () => {
    const nav = { pages: ['introduction'] }
    expect(projectMintlifyNavigation({ navigation: nav }).docsConfig.icons).toEqual({ library: 'fontawesome' })
    expect(projectMintlifyNavigation({ navigation: nav, icons: { library: 'lucide' } }).docsConfig.icons).toEqual({ library: 'lucide' })
  })

  it('preserves interleaved root pages and nested groups in authored order', () => {
    const result = projectMintlifyNavigation({
      navigation: {
        pages: [
          'introduction',
          { group: 'Guides', pages: ['guides/start'] },
          'faq',
        ],
      },
    })

    expect(result.docsConfig.tabs[0]?.pages).toEqual([
      'introduction',
      { group: 'Guides', pages: ['guides/start'] },
      'faq',
    ])
  })

  it('rewrites bare wildcard redirects into Next.js catch-all syntax', () => {
    const result = projectMintlifyNavigation({
      navigation: { pages: ['introduction'] },
      redirects: [
        { source: '/api-reference/*', destination: '/api/*' },
        { source: '/old/*', destination: '/new', permanent: true },
      ],
    })

    expect(result.docsConfig.redirects).toEqual([
      { source: '/api-reference/:path*', destination: '/api/:path*' },
      { source: '/old/:path*', destination: '/new', permanent: true },
    ])
  })

  it('derives dropdown presentation only from the selected default container', () => {
    const result = projectMintlifyNavigation({
      navigation: {
        languages: [
          {
            locale: 'pt',
            default: true,
            tabs: [{ tab: 'Docs', groups: [{ group: 'Start', pages: ['introduction'] }] }],
          },
          {
            locale: 'fr',
            dropdowns: [{ dropdown: 'Documentation', groups: [{ group: 'Start', pages: ['introduction'] }] }],
          },
        ],
      },
    })

    expect(result.docsConfig.i18n?.defaultLocale).toBe('pt')
    expect(result.docsConfig.navigation).toBeUndefined()
    expect(result.docsConfig.tabs.map((tab) => tab.tab)).toEqual(['Docs'])
    expect(result.docsConfig.i18n?.navigation?.fr?.[0]).toMatchObject({
      tab: 'Documentation',
      groups: [{ group: 'Start', pages: ['introduction'] }],
    })
  })

  it('does not let an empty legacy dropdown array override active tabs', () => {
    const result = projectMintlifyNavigation({
      navigation: {
        tabs: [{ tab: 'Docs', groups: [{ group: 'Start', pages: ['introduction'] }] }],
        dropdowns: [],
      },
    })

    expect(result.docsConfig.navigation).toBeUndefined()
    expect(result.docsConfig.tabs.map((tab) => tab.tab)).toEqual(['Docs'])
  })

  it('honors default versions and inherits their presentation metadata', () => {
    const result = projectMintlifyNavigation({
      navigation: {
        versions: [
          {
            version: 'v1',
            href: '/v1',
            tabs: [
              { tab: 'Guides', groups: [{ group: 'Start', pages: ['v1/introduction'] }] },
              { tab: 'API', groups: [{ group: 'Reference', pages: ['v1/api'] }] },
            ],
          },
          {
            version: 'v2',
            default: true,
            description: 'Current documentation',
            icon: 'book-open',
            href: '/v2',
            tabs: [
              { tab: 'Guides', groups: [{ group: 'Start', pages: ['v2/introduction'] }] },
              { tab: 'API', groups: [{ group: 'Reference', pages: ['v2/api'] }] },
            ],
          },
        ],
      },
    })

    expect(result.docsConfig.tabs.map((tab) => tab.tab)).toEqual([
      'v2: Guides',
      'v2: API',
      'v1: Guides',
      'v1: API',
    ])
    expect(result.docsConfig.tabs.map((tab) => [tab.version, tab.displayLabel])).toEqual([
      ['v2', 'Guides'], ['v2', 'API'], ['v1', 'Guides'], ['v1', 'API'],
    ])
    expect(result.docsConfig.navigation?.versions).toEqual([
      { label: 'v2', prefix: 'v2', href: '/v2/introduction', default: true },
      { label: 'v1', prefix: 'v1', href: '/v1/introduction' },
    ])
    expect(result.docsConfig.tabs[0]).toMatchObject({
      description: 'Current documentation',
      icon: 'book-open',
      href: '/v2',
    })
    expect(result.docsConfig.tabs[1]).toMatchObject({
      description: 'Current documentation',
      icon: 'book-open',
    })
    expect(result.docsConfig.tabs[1]?.href).toBeUndefined()
    expect(result.docsConfig.tabs[2]?.href).toBe('/v1')
    expect(result.docsConfig.tabs[3]?.href).toBeUndefined()
  })

  it('keeps a version hidden flag so the switcher can omit it', () => {
    const result = projectMintlifyNavigation({
      navigation: {
        versions: [
          { version: 'v2', default: true, tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['v2/introduction'] }] }, { tab: 'API', groups: [{ group: 'Ref', pages: ['v2/api'] }] }] },
          { version: 'v1', hidden: true, tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['v1/introduction'] }] }, { tab: 'API', groups: [{ group: 'Ref', pages: ['v1/api'] }] }] },
        ],
      },
    })
    expect(result.docsConfig.navigation?.versions).toEqual([
      { label: 'v2', prefix: 'v2', href: '/v2/introduction', default: true },
      { label: 'v1', prefix: 'v1', href: '/v1/introduction', hidden: true },
    ])
  })

  it('projects global language anchors as sidebar shortcuts', () => {
    const result = projectMintlifyNavigation({ navigation: { languages: [{ language: 'en', default: true,
      global: { anchors: [{ anchor: 'Playground', href: 'https://example.com/play', icon: 'play' }] },
      tabs: [{ tab: 'Docs', pages: ['introduction'] }],
    }] } })
    expect(result.docsConfig.navigation?.shortcuts).toEqual([{ label: 'Playground', href: 'https://example.com/play', icon: 'play' }])
  })

  it('translates a trailing Mintlify wildcard redirect into a Next.js named catch-all', () => {
    const result = projectMintlifyNavigation({
      navigation: { pages: ['introduction'] },
      redirects: [
        { source: '/api-reference/*', destination: '/api/*' },
        { source: '/settings/auth/*', destination: '/deploy/auth-setup' },
        { source: '/api-playground/mdx/:slug*', destination: '/api-playground/mdx-setup' },
      ],
    })

    expect(result.docsConfig.redirects).toEqual([
      { source: '/api-reference/:path*', destination: '/api/:path*' },
      { source: '/settings/auth/:path*', destination: '/deploy/auth-setup' },
      { source: '/api-playground/mdx/:slug*', destination: '/api-playground/mdx-setup' },
    ])
  })

  it('drops a redirect whose wildcard Next.js cannot express and warns instead of crashing', () => {
    const result = projectMintlifyNavigation({
      navigation: { pages: ['introduction'] },
      redirects: [
        { source: '/foo/*/bar', destination: '/baz' },
        { source: '/only-dest-wildcard', destination: '/dest/*' },
        { source: '/kept', destination: '/still-kept' },
      ],
    })

    expect(result.docsConfig.redirects).toEqual([{ source: '/kept', destination: '/still-kept' }])
    expect(result.warnings.filter((warning) => warning.code === 'unsupported-config'
      && warning.message.includes('wildcard'))).toHaveLength(2)
  })

  it('drops a backslash-prefixed or percent-encoded browser-cross-origin redirect destination', () => {
    const result = projectMintlifyNavigation({
      navigation: { pages: ['introduction'] },
      redirects: [
        { source: '/legit', destination: '/\\evil.example' },
        { source: '/legit-2', destination: '/%5Cevil.example' },
        { source: '/kept', destination: '/still-kept' },
      ],
    })

    expect(result.docsConfig.redirects).toEqual([{ source: '/kept', destination: '/still-kept' }])
  })

  it('drops a redirect whose destination hides a browser-cross-origin `//` behind a stripped whitespace/control character', () => {
    const result = projectMintlifyNavigation({
      navigation: { pages: ['introduction'] },
      redirects: [
        { source: '/legit-tab', destination: '/\t/evil.example' },
        { source: '/legit-newline', destination: '/\n/evil.example' },
        { source: '/legit-cr', destination: '/\r/evil.example' },
        { source: '/legit-nul', destination: '/\x00/evil.example' },
        { source: '/kept', destination: '/still-kept' },
      ],
    })

    expect(result.docsConfig.redirects).toEqual([{ source: '/kept', destination: '/still-kept' }])
  })
})

describe('Fern redirect safety shares the Mintlify guard', () => {
  it('drops a backslash-prefixed or percent-encoded browser-cross-origin redirect destination', () => {
    const result = projectFernNavigation({
      config: {
        navigation: [{ page: 'Introduction', path: 'introduction.mdx' }],
        redirects: [
          { source: '/legit', destination: '/\\evil.example' },
          { source: '/legit-2', destination: '/%5Cevil.example' },
          { source: '/kept', destination: '/still-kept' },
        ],
      },
      fernRoot: '/tmp/fern-root-unused',
    })

    expect(result.docsConfig.redirects).toEqual([{ source: '/kept', destination: '/still-kept' }])
  })
})

describe('Fern external navigation links', () => {
  it('preserves safe nested links in the navbar alongside authored navbar links', () => {
    const result = projectFernNavigation({
      config: {
        'navbar-links': [{ type: 'github', value: 'https://github.com/NVIDIA/SkillEvaluator' }],
        navigation: [
          { page: 'Overview', path: '../docs/index.mdx' },
          { section: 'Reference', contents: [
            { page: 'CLI', path: '../docs/cli.mdx' },
            { link: 'NVIDIA Verified Skills', href: 'https://docs.nvidia.com/skills/' },
          ] },
        ],
      },
      fernRoot: '/tmp/fern-root-unused',
      repositoryRoot: '/tmp',
    })
    expect(result.docsConfig.navbar?.links).toEqual([
      { label: 'GitHub', href: 'https://github.com/NVIDIA/SkillEvaluator', type: 'github' },
      { label: 'NVIDIA Verified Skills', href: 'https://docs.nvidia.com/skills/' },
    ])
    expect(result.warnings.some((warning) => warning.message.includes('Fern navigation "link"'))).toBe(false)
  })

  it('drops unsafe external targets and hidden links', () => {
    const result = projectFernNavigation({
      config: { navigation: [
        { link: 'Unsafe', href: 'javascript:alert(1)' },
        { link: 'Credentials', href: 'https://user:pass@example.com/' },
        { link: 'Hidden', href: 'https://example.com/', hidden: true },
      ] },
      fernRoot: '/tmp/fern-root-unused',
    })
    expect(result.docsConfig.navbar).toBeUndefined()
    expect(result.warnings.filter((warning) => warning.message.includes('unsafe or invalid external URL'))).toHaveLength(2)
  })
})

describe('pruning navigation pages excluded after projection', () => {
  it('keeps a route once per sibling group after two files resolve to the same slug', () => {
    const config: MigrationDocsConfig = { tabs: [{ tab: 'Release Notes', groups: [
      { group: 'Latest', pages: ['changelog', 'changelog/release', 'changelog/release'] },
      { group: 'Archive', pages: ['changelog/release'] },
    ] }] }
    expect(pruneMissingNavigationPages(config, new Set(['changelog', 'changelog/release'])).tabs[0].groups).toEqual([
      { group: 'Latest', pages: ['changelog', 'changelog/release'] },
      { group: 'Archive', pages: ['changelog/release'] },
    ])
  })
  it('drops a page id that was excluded from import, and the group left empty by it', () => {
    const config: MigrationDocsConfig = {
      tabs: [{
        tab: 'Documentation',
        groups: [
          { group: 'Guides', pages: ['guides/intro', 'guides/excluded'] },
          { group: 'Assistant', pages: ['assistant/widget'] },
        ],
      }],
    }

    const pruned = pruneMissingNavigationPages(config, new Set(['guides/intro']))

    expect(pruned).toEqual({
      tabs: [{
        tab: 'Documentation',
        groups: [{ group: 'Guides', pages: ['guides/intro'] }],
      }],
    })
  })

  it('leaves an href-only or api-only tab untouched even though it has no pages', () => {
    const config: MigrationDocsConfig = {
      tabs: [
        { tab: 'Home', href: '/' },
        { tab: 'API Reference', api: { source: '/openapi.json' } },
      ],
    }

    const pruned = pruneMissingNavigationPages(config, new Set())

    expect(pruned.tabs).toEqual(config.tabs)
  })

  it('prunes nested groups and top-level tab pages, across every tab', () => {
    const config: MigrationDocsConfig = {
      tabs: [
        {
          tab: 'Docs',
          pages: ['kept', 'excluded', { group: 'Nested', pages: ['excluded/child', { group: 'Empty', pages: ['also-excluded'] }] }],
        },
        { tab: 'Empty tab', pages: ['excluded'] },
      ],
    }

    const pruned = pruneMissingNavigationPages(config, new Set(['kept']))

    expect(pruned.tabs).toEqual([{ tab: 'Docs', pages: ['kept'] }])
  })
})

describe('Mintlify tab menus', () => {
  const menuTab = {
    tab: 'Developer Tools',
    icon: 'square-terminal',
    menu: [
      { item: 'API reference', icon: 'rocket', groups: [{ group: 'Core endpoints', pages: ['api-reference/get', 'api-reference/post'] }] },
      { item: 'SDKs', icon: 'code', description: 'SDKs are used to interact with the API.', pages: ['sdk/fetch', 'sdk/create'] },
    ],
  }

  it('projects a tab menu as one tab with a group per item and keeps every page', () => {
    const result = projectMintlifyNavigation({ navigation: { tabs: [menuTab] } })

    expect(result.docsConfig.tabs).toEqual([{
      tab: 'Developer Tools',
      icon: 'square-terminal',
      groups: [
        { group: 'API reference', icon: 'rocket', pages: [{ group: 'Core endpoints', pages: ['api-reference/get', 'api-reference/post'] }] },
        { group: 'SDKs', icon: 'code', pages: ['sdk/fetch', 'sdk/create'] },
      ],
    }])
    expect(result.pageReferences.map((reference) => reference.navigationId)).toEqual([
      'api-reference/get', 'api-reference/post', 'sdk/fetch', 'sdk/create',
    ])
  })

  it('warns about a menu item description instead of dropping it silently', () => {
    const result = projectMintlifyNavigation({ navigation: { tabs: [menuTab] } })
    expect(result.warnings.map((warning) => warning.message).join('\n')).toContain('"SDKs" has a description')
  })

  it('warns about an href-only menu item and an empty item', () => {
    const result = projectMintlifyNavigation({ navigation: { tabs: [{
      tab: 'Tools',
      menu: [{ item: 'Blog', href: 'https://example.com/blog' }, { item: 'Docs', pages: ['a'] }],
    }] } })
    expect(result.docsConfig.tabs[0]?.groups).toEqual([{ group: 'Docs', pages: ['a'] }])
    const messages = result.warnings.map((warning) => warning.message).join('\n')
    expect(messages).toContain('"Blog" links to https://example.com/blog')
  })

  it('keeps sibling tabs without a menu and nests a menu under a dropdown or version', () => {
    const mixed = projectMintlifyNavigation({ navigation: { tabs: [
      { tab: 'Guides', pages: ['guides/start'] },
      menuTab,
    ] } })
    expect(mixed.docsConfig.tabs.map((tab) => tab.tab)).toEqual(['Guides', 'Developer Tools'])

    const nested = projectMintlifyNavigation({ navigation: { versions: [
      { version: 'v2', tabs: [menuTab] },
    ] } })
    expect(nested.docsConfig.tabs[0]?.tab).toBe('v2')
    expect(nested.pageReferences).toHaveLength(4)
  })

  it('binds a menu item openapi to the enclosing tab', () => {
    const references = mintlifyNavigationApiReferences({ navigation: { tabs: [{
      tab: 'Developer Tools',
      menu: [{ item: 'API reference', openapi: 'openapi.yaml' }],
    }] } })
    expect(references).toEqual([{ value: 'openapi.yaml', kind: 'openapi', tabLabel: 'Developer Tools' }])
  })

  it('labels menu API references to match the tabs migration creates', () => {
    const mixed = mintlifyNavigationApiReferences({ navigation: { tabs: [{
      tab: 'Docs',
      menu: [
        { item: 'Guide', pages: ['guide'] },
        { item: 'REST', openapi: 'rest.yaml' },
        { item: 'Admin', openapi: { source: 'admin.yaml', directory: 'admin' }, pages: ['admin/x'] },
      ],
    }] } })
    expect(mixed).toEqual([
      { value: 'rest.yaml', kind: 'openapi', tabLabel: 'Docs: REST', parentTab: 'Docs' },
      { value: 'admin.yaml', kind: 'openapi', tabLabel: 'Docs: Admin', parentTab: 'Docs', directory: 'admin' },
    ])
    const two = mintlifyNavigationApiReferences({ navigation: { tabs: [{
      tab: 'API',
      menu: [{ item: 'A', openapi: 'a.yaml' }, { item: 'B', openapi: 'b.yaml' }],
    }] } })
    expect(two.map((reference) => reference.tabLabel)).toEqual(['API: A', 'API: B'])
  })

  it('warns when a menu API item has no spec source', () => {
    const result = projectMintlifyNavigation({ navigation: { tabs: [{
      tab: 'Docs',
      menu: [{ item: 'Guide', pages: ['g'] }, { item: 'Broken', openapi: { directory: 'api' }, pages: ['b'] }],
    }] } })
    expect(result.warnings.map((warning) => warning.message).join('\n')).toContain('"Broken" has an openapi/asyncapi value without a "source"')
  })

  it('still honors the legacy plural menus container', () => {
    const result = projectMintlifyNavigation({ navigation: { menus: [{ menu: 'One', pages: ['one'] }] } })
    expect(result.docsConfig.tabs).toEqual([{ tab: 'One', pages: ['one'] }])
  })

  it('warns about an unrecognized container instead of dropping it silently', () => {
    const result = projectMintlifyNavigation({ navigation: {
      tabs: [{ tab: 'A', pages: ['a'] }],
      sections: [{ name: 'X', pages: ['x'] }],
    } })
    expect(result.warnings.map((warning) => warning.message).join('\n')).toContain('"sections"')
  })

  it('does not warn that productGroups is unsupported, since its products are projected', () => {
    const result = projectMintlifyNavigation({ navigation: { tabs: [{
      tab: 'Docs',
      productGroups: [{ group: 'P', products: [{ product: 'Redis', groups: [{ group: 'Overview', pages: ['redis/a'] }] }] }],
    }] } })
    expect(result.docsConfig.tabs[0]?.groups).toEqual([{ group: 'Overview', pages: ['redis/a'] }])
    expect(result.warnings.map((warning) => warning.message).join('\n')).not.toContain('productGroups')
  })

  it('leaves existing tab, anchor and dropdown output unchanged', () => {
    const tabs = projectMintlifyNavigation({ navigation: { tabs: [{ tab: 'T', groups: [{ group: 'G', pages: ['g/a'] }] }] } })
    expect(tabs.docsConfig.tabs).toEqual([{ tab: 'T', groups: [{ group: 'G', pages: ['g/a'] }] }])
    const anchors = projectMintlifyNavigation({ navigation: { anchors: [{ anchor: 'A', pages: ['a'] }] } })
    expect(anchors.docsConfig.tabs).toEqual([{ tab: 'A', pages: ['a'] }])
    const dropdowns = projectMintlifyNavigation({ navigation: { dropdowns: [{ dropdown: 'D', pages: ['d'] }] } })
    expect(dropdowns.docsConfig.tabs).toEqual([{ tab: 'D', pages: ['d'] }])
    expect(dropdowns.docsConfig.navigation).toEqual({ display: 'dropdown' })
    expect(tabs.warnings).toEqual([])
  })
})

describe('Mintlify productGroups wrapper (Upstash-shaped docs.json)', () => {
  const config = {
    navigation: {
      tabs: [{
        tab: 'Documentation',
        productGroups: [{
          group: 'Products',
          products: [{
            product: 'Redis',
            groups: [{ group: 'Overview', pages: ['redis/overview'] }],
          }],
        }],
      }],
    },
  }

  it('projects pages nested under tab.productGroups[].products, not just tab.products', () => {
    const result = projectMintlifyNavigation(config)
    expect(result.docsConfig.tabs).toEqual([{
      tab: 'Documentation',
      groups: [{ group: 'Overview', pages: ['redis/overview'] }],
    }])
  })

  it('still resolves an openapi/asyncapi reference nested under productGroups', () => {
    const nested = {
      navigation: {
        tabs: [{
          tab: 'Documentation',
          productGroups: [{
            group: 'Products',
            products: [{
              product: 'QStash',
              groups: [{ group: 'REST', pages: [{ group: 'API', openapi: 'qstash/openapi.yaml' }] }],
            }],
          }],
        }],
      },
    }
    const references = mintlifyNavigationApiReferences(nested)
    expect(references).toEqual([{ value: 'qstash/openapi.yaml', kind: 'openapi', tabLabel: 'QStash' }])
  })
})

describe('Mintlify openapi object-form reference', () => {
  it('recognizes { source, directory } in addition to a bare string, and reports the directory', () => {
    const config = {
      navigation: {
        tabs: [{
          tab: 'Documentation',
          groups: [{
            group: 'API',
            openapi: { source: 'qstash/openapi.yaml', directory: 'qstash/api-reference' },
          }],
        }],
      },
    }
    const references = mintlifyNavigationApiReferences(config)
    expect(references).toEqual([{
      value: 'qstash/openapi.yaml',
      kind: 'openapi',
      tabLabel: 'Documentation',
      directory: 'qstash/api-reference',
    }])
  })
})

describe('Mintlify directory reference with an explicit operation list', () => {
  it('reports the operations listed under each directory, nested groups included, in authored order', () => {
    const source = 'https://specs.example.com/openapi.json'
    const references = mintlifyNavigationApiReferences({
      navigation: {
        products: [
          {
            product: 'Compute',
            tabs: [{
              tab: 'API reference',
              openapi: { source, directory: 'compute/api-reference' },
              groups: [{ group: 'Projects', pages: ['POST /v2/projects.createProject', 'POST /v2/projects.getProject'] }],
            }],
          },
          {
            product: 'Platform',
            tabs: [{
              tab: 'API reference',
              openapi: { source, directory: 'platform/api-reference' },
              groups: [{ group: 'Compute', pages: [{ group: 'Apps', pages: ['POST /v2/apps.getApp', 'POST /v2/apps.createApp'] }] }],
            }],
          },
        ],
      },
    })
    expect(references).toEqual([
      { value: source, kind: 'openapi', tabLabel: 'API reference', directory: 'compute/api-reference', operations: ['POST /v2/projects.createProject', 'POST /v2/projects.getProject'] },
      { value: source, kind: 'openapi', tabLabel: 'API reference', directory: 'platform/api-reference', operations: ['POST /v2/apps.getApp', 'POST /v2/apps.createApp'] },
    ])
  })

  it('leaves a nested spec its own operations and reports none for a tab that lists no operation', () => {
    const references = mintlifyNavigationApiReferences({
      navigation: {
        tabs: [{
          tab: 'API',
          openapi: { source: 'a.yaml', directory: 'api' },
          groups: [
            { group: 'Guides', pages: ['guide'] },
            { group: 'Admin', openapi: 'admin.yaml', pages: ['GET /admin/users'] },
          ],
        }],
      },
    })
    expect(references).toEqual([
      { value: 'a.yaml', kind: 'openapi', tabLabel: 'API', directory: 'api' },
      { value: 'admin.yaml', kind: 'openapi', tabLabel: 'API' },
    ])
  })
})

describe('Mintlify manual OpenAPI operation listing', () => {
  it('drops "METHOD /path" navigation entries with one warning instead of a missing-page warning each', () => {
    const config = {
      navigation: {
        tabs: [{
          tab: 'API Reference',
          openapi: 'devops/openapi.yaml',
          groups: [{
            group: 'Redis',
            pages: ['GET /redis/databases', 'POST /redis/database', 'devops/introduction'],
          }],
        }],
      },
    }
    const result = projectMintlifyNavigation(config)
    expect(result.docsConfig.tabs).toEqual([{
      tab: 'API Reference',
      groups: [{ group: 'Redis', pages: ['devops/introduction'] }],
    }])
    const operationWarnings = result.warnings.filter((warning) => /hand-pick or reorder individual OpenAPI operations/.test(warning.message))
    expect(operationWarnings).toHaveLength(1)
    // Not registered as page references at all, so repository.ts's later
    // "did not resolve to a source page" pass never sees them, let alone
    // once per operation.
    expect(result.pageReferences.some((reference) => reference.ref.startsWith('GET ') || reference.ref.startsWith('POST '))).toBe(false)
  })
})

describe('Mintlify config size limit', () => {
  it('reads a docs.json larger than the old 2 MB page limit, up to the 20 MB config limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-config-'))
    try {
      // A large but realistic docs.json: many groups/pages, past 2 MB (the
      // page-content limit) but well under the 20 MB config limit.
      const groups = Array.from({ length: 40_000 }, (_, index) => ({
        group: `Group ${index}`,
        pages: [`guides/page-${index}`],
      }))
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { tabs: [{ tab: 'Guides', groups }] } }))
      const size = Buffer.byteLength(JSON.stringify({ navigation: { tabs: [{ tab: 'Guides', groups }] } }))
      expect(size).toBeGreaterThan(2_000_000)
      expect(size).toBeLessThan(20_000_000)
      const config = readMintlifyConfig(root)
      expect(config).not.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still rejects a docs.json past the 20 MB config limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-config-'))
    try {
      const groups = Array.from({ length: 400_000 }, (_, index) => ({
        group: `Group ${index}`,
        pages: [`guides/page-${index}`],
      }))
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { tabs: [{ tab: 'Guides', groups }] } }))
      expect(() => readMintlifyConfig(root)).toThrow(/exceeded 20 MB/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Mintlify sourceRef navigation nodes', () => {
  it('warns once per sourceRef with the repository and the group it sat in', () => {
    const result = projectMintlifyNavigation({
      navigation: {
        tabs: [{
          tab: 'Docs',
          groups: [
            { group: 'SDKs', pages: ['sdks/overview', { sourceRef: 'OpenRouterTeam/typescript-sdk' }, { sourceRef: 'OpenRouterTeam/python-sdk' }] },
            { group: 'Only remote', pages: [{ sourceRef: 'OpenRouterTeam/typescript-sdk' }] },
          ],
        }],
      },
    })
    const messages = result.warnings.map((warning) => warning.message).filter((message) => message.includes('sourceRef') || message.includes('OpenRouterTeam/'))
    expect(messages).toHaveLength(3)
    expect(messages.some((message) => message.includes('OpenRouterTeam/typescript-sdk') && message.includes('"SDKs"'))).toBe(true)
    expect(messages.some((message) => message.includes('OpenRouterTeam/python-sdk') && message.includes('"SDKs"'))).toBe(true)
    expect(messages.some((message) => message.includes('OpenRouterTeam/typescript-sdk') && message.includes('"Only remote"'))).toBe(true)
    expect(messages.every((message) => message.includes('not migrated') && message.includes('--source-ref OpenRouterTeam/'))).toBe(true)
  })

  it('splices the resolved navigation into the parent group and keeps its label and icon', () => {
    const resolved: Array<string> = []
    const result = projectMintlifyNavigation({
      navigation: {
        tabs: [{
          tab: 'SDKs',
          groups: [{ group: 'TypeScript SDK', icon: 'code', expanded: false, pages: [{ sourceRef: 'OpenRouterTeam/typescript-sdk' }] }],
        }],
      },
    }, {
      resolveSourceRef: (repo) => {
        resolved.push(repo)
        return ['client-sdks/typescript/overview', { group: 'Chat', pages: ['client-sdks/typescript/sdks/chat/README'] }]
      },
    })
    expect(resolved).toEqual(['OpenRouterTeam/typescript-sdk'])
    expect(result.warnings.filter((warning) => warning.message.includes('sourceRef'))).toHaveLength(0)
    expect(result.docsConfig.tabs[0].groups).toEqual([{
      group: 'TypeScript SDK',
      icon: 'code',
      pages: ['client-sdks/typescript/overview', { group: 'Chat', pages: ['client-sdks/typescript/sdks/chat/README'] }],
    }])
  })

})
