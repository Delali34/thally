// @vitest-environment happy-dom
/** The tab with the most specific claim owns a page; a parent tab's broader item never takes nested pages. */

import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarCollection } from '@/data/docs'

const mocks = vi.hoisted(() => ({ pathname: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('./sidebar-store', () => ({
  useSidebarCollectionsStore: (selector: (state: { collectionsByScope: Record<string, never>; navigationByScope: Record<string, never>; viewKey: null }) => unknown) => selector({ collectionsByScope: {}, navigationByScope: {}, viewKey: null }),
}))
vi.mock('@/components/layout/top-bar', () => ({
  TopBar: ({ activeCollectionId, collections, onCollectionChange }: { activeCollectionId: string; collections: Array<SidebarCollection>; onCollectionChange: (id: string) => void }) => createElement(
    'nav',
    { 'data-active': activeCollectionId, 'data-visible': collections.map((item) => item.id).join(',') },
    collections.map((item) => createElement('button', { key: item.id, 'data-tab': item.id, onClick: () => onCollectionChange(item.id) })),
  ),
}))
vi.mock('@/components/navigation/sidebar', () => ({
  Sidebar: ({ activeCollectionId, sections }: { activeCollectionId: string; sections: SidebarCollection['sections'] }) => createElement('aside', {
    'data-active': activeCollectionId,
    'data-hrefs': sections.flatMap((section) => section.items.map((item) => item.href)).join(','),
  }),
}))
vi.mock('@/components/layout/footer', () => ({ Footer: () => null }))
vi.mock('@/components/layout/sections', () => ({ PageContainer: ({ children }: { children: ReactNode }) => children }))

import { SiteShell } from './site-shell'

type Versions = Array<{ label: string; prefix: string; href: string; default?: boolean }>

function tab(id: string, ...hrefs: Array<string>): SidebarCollection {
  return { id, label: id, sections: [{ title: id, items: hrefs.map((href) => ({ id: href, title: href, href })) }] }
}

function shell(collections: Array<SidebarCollection>, navigationVersions?: Versions) {
  return (
    <SiteShell
      initialCollections={collections}
      navigationPresentation={{ display: 'tabs' }}
      navigationVersions={navigationVersions}
      identity={{ name: 'Documentation', description: '', repoUrl: '', links: [] }}
    >
      Page
    </SiteShell>
  )
}

/** The highlighted tab and the sidebar's collection for a request path. */
function owners(pathname: string, collections: Array<SidebarCollection>, navigationVersions?: Versions) {
  mocks.pathname = pathname
  const markup = renderToStaticMarkup(shell(collections, navigationVersions))
  return {
    tab: markup.match(/<nav data-active="([^"]*)"/)?.[1],
    sidebar: markup.match(/<aside data-active="([^"]*)"/)?.[1],
    visible: markup.match(/data-visible="([^"]*)"/)?.[1],
    hrefs: markup.match(/data-hrefs="([^"]*)"/)?.[1],
  }
}

describe('most specific collection ownership', () => {
  const compute = [
    tab('guides', '/compute', '/compute/get-started/deploy-from-github'),
    tab('cli', '/compute/cli/projects/create-project'),
  ]

  it('gives a nested tab its own pages instead of the parent tab\'s broader item', () => {
    expect(owners('/compute/cli/projects/create-project', compute)).toMatchObject({
      tab: 'cli', sidebar: 'cli', hrefs: '/compute/cli/projects/create-project',
    })
    // The parent still owns its own pages, including the item that prefix-matches the nested tab.
    expect(owners('/compute/get-started/deploy-from-github', compute)).toMatchObject({ tab: 'guides', sidebar: 'guides' })
    expect(owners('/compute', compute)).toMatchObject({ tab: 'guides', sidebar: 'guides' })
  })

  it('lets an exact match in a later tab beat a prefix match in an earlier tab', () => {
    expect(owners('/docs/limits', [tab('docs', '/docs'), tab('limits', '/docs/limits')])).toMatchObject({ tab: 'limits', sidebar: 'limits' })
  })

  it('picks the longer href when two tabs only prefix-match, whatever the tab order', () => {
    const [docs, reference] = [tab('docs', '/docs'), tab('reference', '/docs/reference')]
    expect(owners('/docs/reference/unlisted', [docs, reference])).toMatchObject({ tab: 'reference', sidebar: 'reference' })
    expect(owners('/docs/reference/unlisted', [reference, docs])).toMatchObject({ tab: 'reference', sidebar: 'reference' })
  })

  it('keeps tab order when two tabs claim a path equally', () => {
    expect(owners('/docs/page', [tab('first', '/docs'), tab('second', '/docs')])).toMatchObject({ tab: 'first', sidebar: 'first' })
    expect(owners('/docs/page', [tab('first', '/docs/page'), tab('second', '/docs/page')])).toMatchObject({ tab: 'first', sidebar: 'first' })
  })

  it('falls back to the first tab with navigation when nothing claims the path', () => {
    const tabs = [{ id: 'changelog', label: 'Changelog', href: '/changelog', sections: [] }, tab('docs', '/docs'), tab('reference', '/reference')]
    expect(owners('/nowhere', tabs)).toMatchObject({ tab: 'docs', sidebar: 'docs' })
  })

  it('highlights the most specific href tab', () => {
    const tabs = [{ ...tab('guides', '/compute/overview'), href: '/compute' }, { ...tab('cli', '/compute/cli/overview'), href: '/compute/cli' }]
    expect(owners('/compute/cli/projects/create-project', tabs)).toMatchObject({ tab: 'cli', sidebar: 'cli' })
    expect(owners('/compute/overview', tabs)).toMatchObject({ tab: 'guides', sidebar: 'guides' })
  })

  it('keeps an exact page owner highlighted over another tab\'s longer href prefix', () => {
    const tabs = [
      { ...tab('guides', '/compute/cli/special'), href: '/compute' },
      { ...tab('cli', '/compute/cli/overview'), href: '/compute/cli' },
    ]
    expect(owners('/compute/cli/special', tabs)).toMatchObject({ tab: 'guides', sidebar: 'guides' })
  })

  it('highlights a standalone href tab without letting a broad href steal an exact page', () => {
    const tabs = [
      { id: 'compute', label: 'Compute', href: '/compute', sections: [] },
      { id: 'changelog', label: 'Changelog', href: '/changelog', sections: [] },
      tab('cli', '/compute/cli/overview'),
    ]
    expect(owners('/changelog', tabs)).toMatchObject({ tab: 'changelog', sidebar: 'cli' })
    expect(owners('/compute/cli/overview', tabs)).toMatchObject({ tab: 'cli', sidebar: 'cli' })
  })

  it('assigns a page to the version whose tab claims it most specifically', () => {
    const versions: Versions = [{ label: 'v2', prefix: '', href: '/introduction', default: true }, { label: 'v1', prefix: 'v1', href: '/v1/introduction' }]
    const collections: Array<SidebarCollection> = [
      { ...tab('v2-docs', '/api-reference'), version: 'v2' },
      { ...tab('v1-docs', '/api-reference/v1-endpoint/scrape'), version: 'v1' },
    ]
    expect(owners('/api-reference/v1-endpoint/scrape', collections, versions).visible).toBe('v1-docs')
    expect(owners('/api-reference', collections, versions).visible).toBe('v2-docs')
  })
})

describe('a picked tab', () => {
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // The site-name provider refreshes from this endpoint on mount; keep it off the network.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    container = document.createElement('div')
  })
  afterEach(() => vi.unstubAllGlobals())

  async function pickThenVisit(collections: Array<SidebarCollection>, from: string, picked: string, to: string) {
    const root = createRoot(container)
    mocks.pathname = from
    await act(async () => root.render(shell(collections)))
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-tab="${picked}"]`)!.click())
    mocks.pathname = to
    await act(async () => root.render(shell(collections)))
    const sidebar = container.querySelector('aside')?.getAttribute('data-active')
    await act(async () => root.unmount())
    return sidebar
  }

  it('is dropped once navigation reaches a page that a more specific tab owns', async () => {
    const collections = [tab('guides', '/compute', '/compute/get-started'), tab('cli', '/compute/cli/projects/create-project')]
    expect(await pickThenVisit(collections, '/compute/get-started', 'guides', '/compute/cli/projects/create-project')).toBe('cli')
  })

  it('stays when another tab claims the page equally', async () => {
    const collections = [tab('first', '/docs/shared'), tab('second', '/docs/shared')]
    expect(await pickThenVisit(collections, '/docs/shared', 'second', '/docs/shared')).toBe('second')
  })
})
