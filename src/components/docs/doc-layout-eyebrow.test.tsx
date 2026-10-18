/** The layout shows the nearest group above the title, or the whole group path (a labelled list, not a landmark) when docs.json sets `eyebrow: "path"`. */

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocEntry } from '@/data/docs'

const state = vi.hoisted(() => ({ mode: 'group' as 'group' | 'path' }))

vi.mock('next/navigation', () => ({ usePathname: () => '/errors/capacity' }))
vi.mock('@/data/docs', () => ({
  getBreadcrumbs: () => [],
  getBreadcrumbsEnabled: () => false,
  getEyebrowMode: () => state.mode,
  getNavCategory: () => 'Capacity (fallback)',
  getNavGroupPath: () => ['Errors', 'Capacity (fallback)'],
  getPrevNextLinks: () => ({ prev: null, next: null }),
  getFeedbackConfig: () => ({}),
}))
vi.mock('@/components/docs/doc-breadcrumbs', () => ({ DocBreadcrumbs: () => null }))
vi.mock('@/components/docs/doc-pagination', () => ({ DocPagination: () => null }))
vi.mock('@/components/docs/edit-on-github', () => ({ EditOnGithub: () => null }))
vi.mock('@/components/docs/feedback', () => ({ Feedback: () => null }))
vi.mock('@/components/docs/report-an-issue', () => ({ ReportAnIssue: () => null }))
vi.mock('@/components/docs/table-of-contents', () => ({ TableOfContents: () => null }))
vi.mock('@/lib/cloud-link/client', () => ({ getManagedSiteConfigSnapshot: () => null }))
vi.mock('@/lib/cloud-link/content-controls', () => ({
  getBuildContentControls: () => ({ showBreadcrumbs: false, showCopyPage: false, showTableOfContents: false }),
}))
vi.mock('@/lib/site-config', () => ({ resolveBuildSiteConfig: () => ({ repoUrl: null }) }))

import { DocLayout } from '@/components/docs/doc-layout'

const navigation = {
  prev: null,
  next: null,
  breadcrumb: [],
  group: 'Capacity',
  groupPath: ['Errors', 'Frontline errors', 'Capacity'],
}

function render(props: { navigation?: typeof navigation; mode?: DocEntry['mode'] }) {
  const doc = { id: 'errors/capacity', href: '/errors/capacity', title: 'Capacity', mode: props.mode } as DocEntry
  return renderToStaticMarkup(<DocLayout doc={doc} navigation={props.navigation}>body</DocLayout>)
}

/** The eyebrow's visible parts: the list items of the path, or the single group paragraph. */
function eyebrow(props: { navigation?: typeof navigation; mode?: DocEntry['mode'] }) {
  const html = render(props)
  const list = /<ol aria-label="Section path"[^>]*>(.*?)<\/ol>/.exec(html)
  if (list) return Array.from(list[1].matchAll(/<li[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/li>/g), (match) => match[1])
  return /<p class="thally-docs-eyebrow[^"]*">([^<]*)<\/p>/.exec(html)?.[1] ?? null
}

describe('DocLayout eyebrow', () => {
  beforeEach(() => { state.mode = 'group' })

  it('shows the nearest group by default, exactly as before', () => {
    expect(eyebrow({ navigation })).toBe('Capacity')
    expect(eyebrow({})).toBe('Capacity (fallback)')
    expect(render({ navigation })).not.toMatch(/<ol|<nav|aria-current/)
  })

  it('shows the whole group path in path mode, in every layout mode, as a list and not a landmark', () => {
    state.mode = 'path'
    for (const mode of [undefined, 'wide', 'center'] as const) {
      expect(eyebrow({ navigation, mode })).toEqual(['Errors', 'Frontline errors', 'Capacity'])
      expect(eyebrow({ mode })).toEqual(['Errors', 'Capacity (fallback)'])
      const html = render({ navigation, mode })
      expect(html).toContain('<ol aria-label="Section path"')
      expect(html).not.toMatch(/<nav|aria-current/)
    }
  })

  it('shows no eyebrow in path mode for a page outside any group', () => {
    state.mode = 'path'
    expect(render({ navigation: { ...navigation, group: '', groupPath: [] } })).not.toContain('thally-docs-eyebrow')
  })
})
