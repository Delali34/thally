/** Regression coverage for release-bound docs.json configuration. */

import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import repositoryDocsConfig from '../../../docs.json'
import { getDocsJsonConfig, resetDocsJsonConfigForTests } from '@/lib/docs-json-config'
import {
  getBannerConfig,
  getBreadcrumbs,
  getContentIconTone,
  getIconLibrary,
  getNavCategory,
  getNavContext,
  getNavigablePageIds,
  getNavigationPresentation,
  getNavigationVersions,
  getNavigationShortcuts,
  getSidebarCollections,
  getStructuralTheme,
  getBreadcrumbsEnabled,
  getEyebrowMode,
  getStylesheetsConfig,
} from '@/data/docs'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetDocsJsonConfigForTests()
})

describe('release-bound docs.json', () => {
  it('accepts local version routes and rejects external or traversal destinations', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [], navigation: { versions: [
      { label: 'v2', prefix: '', href: '/introduction', default: true },
      { label: 'v1', prefix: 'v1', href: '/v1/introduction' },
      { label: 'bad', prefix: '..', href: '/other' },
      { label: 'remote', prefix: 'remote', href: 'https://example.com' },
    ] } }))
    resetDocsJsonConfigForTests()
    expect(getNavigationVersions().map((version) => version.label)).toEqual(['v2', 'v1'])
  })

  it('keeps hidden non-default version tabs available to the version picker', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      tabs: [
        { tab: 'v2: Docs', version: 'v2', displayLabel: 'Docs', groups: [{ group: 'Start', pages: ['introduction'] }] },
        { tab: 'v1: Docs', version: 'v1', displayLabel: 'Docs', hidden: true, groups: [{ group: 'Start', pages: ['v1/introduction'] }] },
        { tab: 'Internal', hidden: true, groups: [{ group: 'Start', pages: ['internal'] }] },
      ],
      navigation: { versions: [
        { label: 'v2', prefix: '', href: '/introduction', default: true },
        { label: 'v1', prefix: 'v1', href: '/v1/introduction' },
      ] },
    }))
    resetDocsJsonConfigForTests()
    expect(getSidebarCollections().map((collection) => collection.id)).toEqual(['v2-docs', 'v1-docs'])
  })

  it('keeps safe global sidebar links in source order', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [], navigation: { shortcuts: [
      { label: 'Playground', href: 'https://example.com/play', icon: 'play' },
      { label: 'Support', href: 'mailto:support@example.com' },
      { label: 'Unsafe', href: 'javascript:alert(1)' },
    ] } }))
    resetDocsJsonConfigForTests()
    expect(getNavigationShortcuts()).toEqual([
      { label: 'Playground', href: 'https://example.com/play', icon: 'play' },
      { label: 'Support', href: 'mailto:support@example.com' },
    ])
  })
  it('accepts only local CSS paths in imported stylesheet config', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [], stylesheets: [
      '/migrated/site/style.css', 'https://example.com/remote.css', '/a/../private.css', '//example.com/style.css', '/image.svg',
    ] }))
    resetDocsJsonConfigForTests()
    expect(getStylesheetsConfig()).toEqual(['/migrated/site/style.css'])
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [], stylesheets: { href: '/style.css' } }))
    resetDocsJsonConfigForTests()
    expect(getStylesheetsConfig()).toEqual([])
  })

  it('keeps breadcrumbs unless docs.json sets breadcrumbs to false', () => {
    resetDocsJsonConfigForTests()
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [] }))
    expect(getBreadcrumbsEnabled()).toBe(true)
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [], breadcrumbs: false }))
    resetDocsJsonConfigForTests()
    expect(getBreadcrumbsEnabled()).toBe(false)
  })

  it('shows the nearest group as the eyebrow unless docs.json sets eyebrow to path', () => {
    for (const [eyebrow, expected] of [[undefined, 'group'], ['group', 'group'], ['path', 'path'], ['breadcrumbs', 'group'], [true, 'group']] as const) {
      vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [], ...(eyebrow === undefined ? {} : { eyebrow }) }))
      resetDocsJsonConfigForTests()
      expect(getEyebrowMode(), String(eyebrow)).toBe(expected)
    }
  })

  it('uses accent content icons unless a site explicitly selects neutral icons', () => {
    expect(getContentIconTone()).toBe('accent')

    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      appearance: { contentIcons: 'neutral' },
      tabs: [{ tab: 'Documentation', groups: [] }],
    }))
    resetDocsJsonConfigForTests()

    expect(getContentIconTone()).toBe('neutral')
  })

  it('renders icon names through Lucide unless docs.json selects another library', () => {
    expect(getIconLibrary()).toBe('lucide')

    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      icons: { library: 'fontawesome' },
      tabs: [{ tab: 'Documentation', groups: [] }],
    }))
    resetDocsJsonConfigForTests()
    expect(getIconLibrary()).toBe('fontawesome')

    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      icons: { library: 'noto' },
      tabs: [{ tab: 'Documentation', groups: [] }],
    }))
    resetDocsJsonConfigForTests()
    expect(getIconLibrary()).toBe('lucide')
  })

  it('uses a valid managed binding for navigation and appearance', () => {
    vi.stubEnv(
      'THALLY_DOCS_CONFIG',
      JSON.stringify({
        tabs: [{ tab: 'Runtime navigation', groups: [] }],
        appearance: { contentIcons: 'accent' },
        theme: 'sharp',
      }),
    )

    expect(getSidebarCollections()[0]?.label).toBe('Runtime navigation')
    expect(getContentIconTone()).toBe('accent')
    expect(getStructuralTheme()).toBe('sharp')
  })

  it('reads navigation.groupHeadings only when it asks to keep every group heading', () => {
    const presentation = (navigation: Record<string, unknown>) => {
      vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ navigation, tabs: [] }))
      resetDocsJsonConfigForTests()
      return getNavigationPresentation()
    }
    expect(presentation({ display: 'dropdown', groupHeadings: 'all' })).toEqual({ display: 'dropdown', groupHeadings: 'all' })
    expect(presentation({ groupHeadings: 'all' })).toEqual({ display: 'tabs', groupHeadings: 'all' })
    for (const groupHeadings of ['distinct', 'none', true, undefined]) {
      expect(presentation({ display: 'dropdown', groupHeadings })).not.toHaveProperty('groupHeadings')
    }
  })

  it('preserves recursive groups without duplicate visual sections', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      navigation: { display: 'dropdown' },
      tabs: [{
        tab: 'Documentation',
        description: 'Resources for developers',
        icon: 'book-open',
        groups: [{
          group: 'Fundamentals',
          pages: [
            'triggering',
            { group: 'Tasks', pages: ['tasks/overview', 'tasks/scheduled'] },
            'runs',
          ],
        }],
      }],
    }))

    const [collection] = getSidebarCollections()
    expect(getNavigationPresentation()).toEqual({ display: 'dropdown' })
    expect(collection).toMatchObject({
      label: 'Documentation',
      description: 'Resources for developers',
      icon: 'book-open',
    })
    expect(collection.sections.map((section) => section.title)).toEqual(['Fundamentals'])
    expect(collection.sections[0]?.nodes).toMatchObject([
      { type: 'page', item: { id: 'triggering', groupPath: ['Fundamentals'] } },
      {
        type: 'group',
        group: {
          title: 'Tasks',
          nodes: [
            { type: 'page', item: { id: 'tasks-overview', groupPath: ['Fundamentals', 'Tasks'] } },
            { type: 'page', item: { id: 'tasks-scheduled', groupPath: ['Fundamentals', 'Tasks'] } },
          ],
        },
      },
      { type: 'page', item: { id: 'runs', groupPath: ['Fundamentals'] } },
    ])
    expect(collection.sections[0]?.items.map((item) => item.id)).toEqual([
      'triggering',
      'tasks-overview',
      'tasks-scheduled',
      'runs',
    ])
  })

  it('renders root page and group nodes without a synthetic section', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      tabs: [{
        tab: 'Documentation',
        pages: [
          'introduction',
          { group: 'Guides', pages: ['guides/install'] },
          'faq',
        ],
      }],
    }))

    const [section] = getSidebarCollections()[0]?.sections ?? []
    expect(section?.title).toBe('Documentation')
    expect(section?.nodes).toMatchObject([
      { type: 'page', item: { id: 'introduction' } },
      { type: 'group', group: { title: 'Guides' } },
      { type: 'page', item: { id: 'faq' } },
    ])
    expect(section?.items.map((item) => item.id)).toEqual([
      'introduction',
      'guides-install',
      'faq',
    ])
    expect([...getNavigablePageIds()]).toEqual([
      'introduction',
      'guides/install',
      'faq',
    ])
    expect(getNavCategory('/')).toBeNull()
    expect(getNavContext('introduction').group).toBe('')
    expect(getBreadcrumbs('/').map((crumb) => crumb.label)).toEqual([
      'Documentation',
      expect.any(String),
    ])
  })

  it('invalidates config-derived caches when the release binding changes', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [{ tab: 'First release', groups: [] }] }))
    expect(getSidebarCollections()[0]?.label).toBe('First release')

    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [{ tab: 'Second release', groups: [] }] }))
    expect(getSidebarCollections()[0]?.label).toBe('Second release')
  })

  it('falls back to the compiled file when the binding is malformed', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubEnv('THALLY_DOCS_CONFIG', '{"tabs":null}')

    expect(getDocsJsonConfig()).toEqual(repositoryDocsConfig)
    expect(warning).toHaveBeenCalledOnce()
  })

  it('accepts the legacy DOX binding when the Thally name is absent', () => {
    vi.stubEnv('DOX_DOCS_CONFIG', JSON.stringify({ tabs: [{ tab: 'Legacy release', groups: [] }] }))

    expect(getSidebarCollections()[0]?.label).toBe('Legacy release')
  })

  it('preserves localized banner copy for request-path selection', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      tabs: [],
      i18n: { defaultLocale: 'es', locales: [{ code: 'es', label: 'Español' }] },
      banner: { content: { en: 'Hello', es: 'Hola' }, variant: 'warning' },
    }))
    expect(getBannerConfig()).toMatchObject({ content: { en: 'Hello', es: 'Hola' }, type: 'warning' })
  })

  it('normalizes malformed nested banner settings without throwing', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      tabs: [],
      banner: { content: { en: 'Hello', bad: 42 }, type: 'javascript', dismissible: 'yes', color: { light: 12 } },
    }))
    expect(getBannerConfig()).toEqual({
      content: { en: 'Hello' },
      dismissible: undefined,
      id: undefined,
      revision: undefined,
      type: undefined,
      color: { light: undefined, dark: undefined },
    })
  })

  it('resolves presentation settings inside the request-time root layout', async () => {
    const source = await readFile('src/app/layout.tsx', 'utf8')
    const rootLayoutStart = source.indexOf('export default async function RootLayout')

    expect(rootLayoutStart).toBeGreaterThan(0)
    for (const call of [
      'resolveFontPresentation()',
      'getStructuralTheme()',
      'getContentIconTone()',
      'getBannerConfig()',
      'getCustomScriptsConfig()',
      'getIntegrationsConfig()',
    ]) {
      expect(source.indexOf(call, rootLayoutStart)).toBeGreaterThan(rootLayoutStart)
    }
  })
})
