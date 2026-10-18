/** A shared `?tags=` link must only filter where the layout renders the controls to undo it. */

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocEntry } from '@/data/docs'

vi.mock('next/navigation', () => ({ usePathname: () => '/changelog' }))
vi.mock('@/data/docs', () => ({
  getBreadcrumbs: () => [],
  getBreadcrumbsEnabled: () => false,
  getEyebrowMode: () => 'group',
  getNavCategory: () => '',
  getNavGroupPath: () => [],
  getPrevNextLinks: () => ({ prev: null, next: null }),
  getFeedbackConfig: () => ({}),
}))
vi.mock('@/components/docs/doc-breadcrumbs', () => ({ DocBreadcrumbs: () => null }))
vi.mock('@/components/docs/doc-header', () => ({ DocHeader: () => null }))
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
import { UpdateArticle } from '@/components/mdx/update-article'

const updates = () => (
  <>
    <UpdateArticle id="api" className="u" tags={['API']}>API update</UpdateArticle>
    <UpdateArticle id="sdk" className="u" tags={['SDK']}>SDK update</UpdateArticle>
  </>
)

let container: HTMLElement
let root: Root

beforeEach(() => {
  window.history.replaceState(null, '', '/changelog?tags=API')
  document.body.innerHTML = '<div id="root"></div>'
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.getElementById('root') as HTMLElement
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
})

async function render(mode: DocEntry['mode']): Promise<{ hidden: number; visible: number; chips: number; clear: boolean }> {
  const doc = { id: 'changelog', href: '/changelog', mode } as DocEntry
  await act(async () => { root.render(<DocLayout doc={doc}>{updates()}</DocLayout>) })
  const all = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector))
  const articles = all('article.u')
  return {
    hidden: articles.filter((el) => el.hidden).length,
    visible: articles.filter((el) => !el.hidden).length,
    chips: all('button[aria-pressed="true"]').length,
    clear: all('button').some((b) => b.textContent === 'Clear'),
  }
}

describe('?tags= restored after hydration', () => {
  for (const mode of ['home', 'custom'] as const) {
    it(`${mode} mode has no filter controls, so every update stays visible`, async () => {
      expect(await render(mode)).toEqual({ hidden: 0, visible: 2, chips: 0, clear: false })
    })
  }

  for (const mode of [undefined, 'default', 'wide', 'center'] as const) {
    it(`${mode ?? 'unset'} mode filters and shows an active chip with Clear`, async () => {
      const result = await render(mode)
      expect(result.hidden).toBe(1)
      expect(result.visible).toBe(1)
      expect(result.chips).toBeGreaterThanOrEqual(1)
      expect(result.clear).toBe(true)
    })
  }
})
