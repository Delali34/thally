// @vitest-environment happy-dom
/** Large collection navigation stays reachable, ordered and bounded in actual React DOM. */
import { act, createElement, type AnchorHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NavigationNode, NavigationSection } from '@/data/docs'
import { NavigationSections } from './navigation-tree'
import { NAVIGATION_WINDOW_SIZE, projectNavigationWindow, visibleNavigationRows } from './navigation-window'

vi.mock('./intent-prefetch-link', () => ({ IntentPrefetchLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props) }))
const page = (index: number): NavigationNode => ({ type: 'page', item: { id: `page-${index}`, title: `Page ${index}`, href: `/v2/fr/page-${index}` } })
const flat = (): Array<NavigationSection> => [{ title: 'Docs', items: [], nodes: Array.from({ length: 10_000 }, (_, index) => page(index)) }]
const groups = (): Array<NavigationSection> => [{ title: 'Docs', items: [], nodes: Array.from({ length: 100 }, (_, group) => ({ type: 'group', group: { id: `group-${group}`, title: `Group ${group}`, defaultOpen: true, nodes: Array.from({ length: 100 }, (_, index) => page(group * 100 + index)) } })) }]
const manySections = (): Array<NavigationSection> => Array.from({ length: 1000 }, (_, section) => ({ title: `Section ${section}`, items: [], nodes: Array.from({ length: 10 }, (_, index) => page(section * 10 + index)) }))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const links = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'))
const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
const paging = (direction: string) => buttons().find(button => button.textContent === `Show ${direction} entries`)!
const render = async (sections: Array<NavigationSection>, pathname = '/missing', mobile = false) => act(async () => root.render(<NavigationSections sections={sections} title="Docs" pathname={pathname} mobile={mobile} />))

// The selected window plus the retained ancestors of its rows (nesting depth <=64).
const MOUNTED_ROW_BOUND = NAVIGATION_WINDOW_SIZE + 65
const pages = (count: number): Array<NavigationSection> => [{ title: 'Docs', items: [], nodes: Array.from({ length: count }, (_, index) => page(index)) }]
const pagingText = () => container.textContent?.match(/Show (earlier|later) entries|Navigation entries/g) ?? []

it('shows every entry of a sidebar with a few hundred entries and no paging controls', async () => {
  // 600 pages plus their section title: a large but ordinary documentation sidebar.
  await render(pages(600))
  expect(links()).toHaveLength(600)
  expect(pagingText()).toEqual([])
  expect(container.querySelector('[role="status"]')).toBeNull()
  expect(container.querySelectorAll('[data-navigation-row]').length).toBe(601)
})

it('pages only once the visible entries exceed the window', async () => {
  // The section title counts as a row, so one page fewer than the window still fits.
  await render(pages(NAVIGATION_WINDOW_SIZE - 1))
  expect(pagingText()).toEqual([])
  await render(pages(NAVIGATION_WINDOW_SIZE))
  expect(pagingText()).toEqual(['Show earlier entries', 'Show later entries', 'Navigation entries'])
})

for (const [name, fixture] of [['flat 10k', flat], ['100 default-open groups', groups], ['1000 sections', manySections]] as const) {
  it(`${name}: finite paging reaches every authored page in order without growing mounted DOM`, async () => {
    const sections = fixture()
    const visible = visibleNavigationRows(sections, '/missing', {})
    const expected = visible.rows.flatMap(row => row.node?.type === 'page' ? [row.node.item.href] : [])
    const reached = new Set<string>()
    const ordered: Array<string> = []
    await render(sections)
    // Paging controls are stable across replacement windows; do not repeatedly
    // traverse every disclosure just to find the same button in this stress test.
    const later = paging('later')
    for (let step = 0; step < 120; step++) {
      expect(container.querySelectorAll('[data-navigation-row]').length).toBeLessThanOrEqual(MOUNTED_ROW_BOUND)
      for (const link of links()) {
        const href = link.getAttribute('href')!
        if (!reached.has(href)) { reached.add(href); ordered.push(href) }
      }
      if (later.disabled) break
      await act(async () => later.click())
    }
    expect(ordered).toEqual(expected)
    expect(reached.size).toBe(10_000)
    expect(later.disabled).toBe(true)
    expect(container.querySelectorAll('[role="tree"]')).toHaveLength(0)
    // This is 100–110 real React commits over 10,000 links, not a microbenchmark.
    // Shared Linux CI exceeded the default 5s even though every traversal is
    // finite (<=120 windows). Keep the larger budget local to these three cases.
  }, 30_000)
}

it('SSR and route transitions center the exact deep active page, including the final page', async () => {
  const sections = groups()
  const html = renderToStaticMarkup(<NavigationSections sections={sections} pathname="/v2/fr/page-5000" />)
  expect((html.match(/data-navigation-row=/g) ?? []).length).toBeLessThanOrEqual(MOUNTED_ROW_BOUND)
  expect(html).toContain('href="/v2/fr/page-5000" aria-current="page"')
  await render(sections, '/v2/fr/page-5000')
  await act(async () => paging('earlier').click())
  expect(container.querySelector('[aria-current="page"]')).toBeNull()
  await render(sections, '/v2/fr/page-9999')
  expect(container.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/v2/fr/page-9999')
  expect(container.textContent).toContain('Group 99')
})

it('keeps nested ancestor context and manual disclosure state after paging, reopening on a new active route', async () => {
  let nested: NavigationNode = { type: 'group', group: { id: 'leaf', title: 'Leaf', nodes: [page(5000), page(5001)] } }
  for (let depth = 0; depth < 32; depth++) nested = { type: 'group', group: { id: `depth-${depth}`, title: `Depth ${depth}`, nodes: [nested] } }
  const sections: Array<NavigationSection> = [{ title: 'Nested', items: [], nodes: [nested, ...Array.from({ length: NAVIGATION_WINDOW_SIZE + 200 }, (_, index) => page(index))] }]
  await render(sections, '/v2/fr/page-5000')
  expect(buttons().filter(button => button.getAttribute('aria-expanded') === 'true')).toHaveLength(33)
  const leaf = () => buttons().find(button => button.textContent === 'Leaf')!
  await act(async () => leaf().click())
  expect(leaf().getAttribute('aria-expanded')).toBe('false')
  await act(async () => paging('later').click())
  await act(async () => paging('earlier').click())
  expect(leaf().getAttribute('aria-expanded')).toBe('false')
  await render(sections, '/v2/fr/page-5001')
  expect(leaf().getAttribute('aria-expanded')).toBe('true')
  expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('Page 5001')
})

it('uses native stable paging controls and transfers keyboard focus; mobile navigation preserves link actions', async () => {
  const sections = flat()
  const first = sections[0].nodes![0]
  if (first.type === 'page') { first.item.method = 'GET'; first.item.badge = 'New' }
  const onNavigate = vi.fn()
  await act(async () => root.render(<NavigationSections sections={sections} pathname="/missing" mobile onNavigate={onNavigate} />))
  expect(links()[0].textContent).toContain('GET')
  expect(links()[0].textContent).toContain('New')
  const later = paging('later')
  later.focus()
  await act(async () => later.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })))
  expect(paging('later')).toBe(later)
  expect(contentFocus()).toBe(true)
  await act(async () => links()[0].click())
  expect(onNavigate).toHaveBeenCalledOnce()
  expect(container.textContent).toContain(`Navigation entries ${NAVIGATION_WINDOW_SIZE + 1}–${NAVIGATION_WINDOW_SIZE * 2}`)
  expect(container.querySelectorAll('[data-navigation-row]').length).toBeLessThanOrEqual(MOUNTED_ROW_BOUND)
})
function contentFocus() { return links().includes(document.activeElement as HTMLAnchorElement) || buttons().some(button => button === document.activeElement && button.hasAttribute('aria-expanded')) }

it('bounds the worst supported ancestor context without losing the selected leaf hierarchy', () => {
  let node = page(9999)
  for (let depth = 0; depth < 64; depth++) node = { type: 'group', group: { id: `${depth}`, title: `${depth}`, nodes: [node, ...Array.from({ length: 100 }, (_, index) => page(index))] } }
  const source = visibleNavigationRows([{ title: 'Deep', items: [], nodes: [node] }], '/v2/fr/page-9999', {})
  const projected = projectNavigationWindow(source.rows, source.activeIndex)
  expect(projected.mountedRows).toBeLessThanOrEqual(MOUNTED_ROW_BOUND)
  expect(projected.roots[0].row.section?.title).toBe('Deep')
})


it('keeps a retained active ancestor focused and reachable after collapsing thousands of visible descendants', async () => {
  const sections: Array<NavigationSection> = [{ title: 'Docs', items: [], nodes: [page(-1), { type: 'group', group: { id: 'large', title: 'Large group', nodes: Array.from({ length: 10_000 }, (_, index) => page(index)) } }, page(10_001)] }]
  await render(sections, '/v2/fr/page-5000')
  const disclosure = buttons().find(button => button.textContent === 'Large group')!
  disclosure.focus()
  await act(async () => disclosure.click())
  expect(disclosure.isConnected).toBe(true)
  expect(document.activeElement).toBe(disclosure)
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  await act(async () => disclosure.click())
  expect(disclosure.isConnected).toBe(true)
  expect(document.activeElement).toBe(disclosure)
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  expect(links().some(link => link.textContent?.includes('Page 0'))).toBe(true)
})
