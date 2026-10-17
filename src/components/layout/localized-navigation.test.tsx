/** Locale navigation keeps the current collection before and after its snapshot hydrates. */

import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarCollection } from '@/data/docs'
import type { NavigationSnapshot } from '@/lib/navigation-snapshot'

const mocks = vi.hoisted(() => ({
  pathname: '/zh-Hans/guides/fees-monetization/faq',
  snapshots: {} as Record<string, Array<SidebarCollection>>,
  loadCollections: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname, useRouter: () => ({ refresh: () => undefined }) }))
vi.mock('@/data/docs', () => ({ loadSidebarCollections: mocks.loadCollections }))
vi.mock('@/data/api-reference', () => ({ withApiNavigation: async (collections: unknown) => collections }))
vi.mock('@/lib/i18n/request', () => ({ getEffectiveI18nConfig: async () => ({ defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'zh-Hans' }] }) }))
vi.mock('./sidebar-store', () => ({
  useSidebarCollectionsStore: (selector: (state: { collectionsByScope: typeof mocks.snapshots; navigationByScope: Record<string, never>; viewKey: null }) => unknown) => selector({ collectionsByScope: mocks.snapshots, navigationByScope: {}, viewKey: null }),
}))
vi.mock('./sidebar-hydrator', () => ({ SidebarCollectionsHydrator: () => null }))
vi.mock('@/components/layout/top-bar', () => ({
  TopBar: ({ activeCollectionId, collections }: { activeCollectionId: string; collections: Array<SidebarCollection> }) => createElement('nav', { 'data-active': activeCollectionId, 'data-visible': collections.map((item) => item.id).join(',') }),
}))
vi.mock('@/components/navigation/sidebar', () => ({
  Sidebar: ({ activeCollectionId, sections }: { activeCollectionId: string; sections: SidebarCollection['sections'] }) => createElement('aside', {
    'data-active': activeCollectionId,
    'data-hrefs': sections.flatMap((section) => section.items.map((item) => item.href)).join(','),
  }),
}))
vi.mock('@/components/layout/footer', () => ({ Footer: () => null }))
vi.mock('@/components/layout/sections', () => ({ PageContainer: ({ children }: { children: ReactNode }) => children }))

import { LocalizedSidebarHydrator } from './localized-sidebar-hydrator'
import { SiteShell } from './site-shell'

function collections(prefix = ''): Array<SidebarCollection> {
  return [
    { id: 'overview', label: 'Overview', sections: [{ title: 'Overview', items: [
      { id: 'introduction/introduction', title: 'Introduction', href: `${prefix}/introduction/introduction` },
    ] }] },
    { id: 'guides', label: 'Guides', sections: [{ title: 'Guides', items: [
      { id: 'guides/fees-monetization/faq', title: 'FAQ', href: `${prefix}/guides/fees-monetization/faq` },
    ] }] },
  ]
}

function shellMarkup(initialCollections = collections(), navigationVersions?: Array<{ label: string; prefix: string; href: string; default?: boolean }>, navigationSnapshot?: NavigationSnapshot) {
  return renderToStaticMarkup(
    <SiteShell
      initialCollections={initialCollections}
      navigationSnapshot={navigationSnapshot}
      navigationPresentation={{ display: 'tabs' }}
      navigationVersions={navigationVersions}
      i18nConfig={{ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'zh-Hans', label: 'Chinese' }] }}
      identity={{ name: 'Documentation', description: '', repoUrl: '', links: [] }}
    >
      Page
    </SiteShell>,
  )
}

describe('localized collection selection', () => {
  beforeEach(() => {
    mocks.pathname = '/zh-Hans/guides/fees-monetization/faq'
    mocks.snapshots = {}
    mocks.loadCollections.mockResolvedValue(collections('/zh-Hans'))
  })

  it('selects Guides from primary hrefs before localized navigation arrives', () => {
    const markup = shellMarkup()
    expect(markup).toContain('<nav data-active="guides"')
    expect(markup).toContain('<aside data-active="guides"')
  })

  it('keeps server-rendered sidebar links inside the locale before the snapshot hydrates', () => {
    expect(shellMarkup()).toContain('data-hrefs="/zh-Hans/guides/fees-monetization/faq"')
    mocks.pathname = '/guides/fees-monetization/faq'
    expect(shellMarkup()).toContain('data-hrefs="/guides/fees-monetization/faq"')
  })

  it('shows only the active version tabs on default and deep version routes', () => {
    const versioned: Array<SidebarCollection> = [
      { id: 'v2-docs', label: 'Documentation', version: 'v2', sections: [{ title: 'Start', items: [{ id: 'introduction', title: 'Introduction', href: '/' }] }] },
      { id: 'v1-docs', label: 'Documentation', version: 'v1', sections: [{ title: 'Start', items: [{ id: 'v1/introduction', title: 'Introduction', href: '/v1/introduction' }] }] },
    ]
    const versions = [{ label: 'v2', prefix: '', href: '/introduction', default: true }, { label: 'v1', prefix: 'v1', href: '/v1/introduction' }]
    mocks.pathname = '/introduction'
    expect(shellMarkup(versioned, versions)).toContain('data-visible="v2-docs"')
    mocks.pathname = '/v1/introduction'
    expect(shellMarkup(versioned, versions)).toContain('data-visible="v1-docs"')
    versioned[1].sections[0].items.push({ id: 'v1/scrape', title: 'Scrape', href: '/api-reference/v1-endpoint/scrape' })
    mocks.pathname = '/api-reference/v1-endpoint/scrape'
    expect(shellMarkup(versioned, versions)).toContain('data-visible="v1-docs"')
  })

  it('keeps Guides selected after the localized snapshot arrives', async () => {
    const hydration = await LocalizedSidebarHydrator({ locale: 'zh-Hans' })
    expect(mocks.loadCollections).toHaveBeenCalledWith('zh-Hans', expect.objectContaining({ isAuthenticated: false }))
    expect(hydration.props.collections.find((collection: SidebarCollection) => collection.id === 'overview')?.href).toBeUndefined()
    mocks.snapshots['locale:zh-Hans'] = hydration.props.collections
    const markup = shellMarkup()
    expect(markup).toContain('<nav data-active="guides"')
    expect(markup).toContain('<aside data-active="guides"')
  })

  it('keeps the dedicated header row when localized collection counts change', () => {
    const initial = [...collections(), ...Array.from({ length: 4 }, (_, index) => ({
      id: `extra-${index}`, label: `Extra ${index}`, href: `/extra-${index}`, sections: [],
    }))]
    expect(shellMarkup(initial)).toContain('data-header-layout="stacked"')
    mocks.snapshots['locale:zh-Hans'] = [...initial, { id: 'seventh', label: 'Seventh', href: '/seventh', sections: [] }]
    expect(shellMarkup(initial)).toContain('data-header-layout="stacked"')
    mocks.snapshots['locale:zh-Hans'] = initial
    expect(shellMarkup(initial)).toContain('data-header-layout="stacked"')
  })

  it('localizes authored collection destinations without inventing new ones', async () => {
    mocks.loadCollections.mockResolvedValue([
      ...collections('/zh-Hans'),
      { id: 'changelog', label: 'Changelog', href: '/changelog', sections: [] },
      { id: 'external', label: 'External', href: 'https://example.com', sections: [] },
    ])
    const hydration = await LocalizedSidebarHydrator({ locale: 'zh-Hans' })
    expect(hydration.props.collections[2].href).toBe('/zh-Hans/changelog')
    expect(hydration.props.collections[3].href).toBe('https://example.com')
  })

  it.each(['collection', 'page'])('keeps an authored locale root %s from owning sibling collections', async (kind) => {
    const localized = collections('/zh-Hans')
    if (kind === 'collection') localized[0].href = '/'
    else localized[0].sections[0].items[0].href = '/zh-Hans'
    mocks.loadCollections.mockResolvedValue(localized)
    const hydration = await LocalizedSidebarHydrator({ locale: 'zh-Hans' })
    mocks.snapshots['locale:zh-Hans'] = hydration.props.collections
    expect(shellMarkup()).toContain('<nav data-active="guides"')
    expect(shellMarkup()).toContain('<aside data-active="guides"')

    // Root destinations still own the locale landing page itself.
    mocks.pathname = '/zh-Hans'
    expect(shellMarkup()).toContain('<nav data-active="overview"')
    expect(shellMarkup()).toContain('<aside data-active="overview"')
  })
})


it('keeps article content visible and declares loading until the actual locale/API descriptor hydrates', () => {
  const snapshot: NavigationSnapshot = { schemaVersion: 1, scope: 'default', dataScope: 'default', snapshotId: 'inline-default', viewKey: 'anonymous', mode: 'inline', collections: collections() }
  for (const pathname of ['/zh-Hans/guides/faq', '/api/reference/operation']) {
    mocks.pathname = pathname
    const html = shellMarkup(collections(), undefined, snapshot)
    expect(html).toContain('data-thally-navigation-state="loading"')
    expect(html).toContain('Loading navigation')
    expect(html).toContain('Page')
  }
})
