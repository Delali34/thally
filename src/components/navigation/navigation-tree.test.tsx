/** Sidebar page selection remains unique when a landing page has child routes. */

import { createElement, type AnchorHTMLAttributes } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { NavigationNode } from '@/data/docs'

vi.mock('./intent-prefetch-link', () => ({
  IntentPrefetchLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props),
}))

import { NavigationTree } from './navigation-tree'

describe('sidebar current page', () => {
  it('selects the home document on its introduction alias', () => {
    const nodes = [
      { type: 'page', item: { id: 'introduction', title: 'Introduction', href: '/' } },
      { type: 'page', item: { id: 'other', title: 'Other', href: '/other' } },
    ] as Array<NavigationNode>
    const html = renderToStaticMarkup(<NavigationTree nodes={nodes} pathname="/introduction" />)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('href="/" aria-current="page"')
  })

  it('selects the child route without also selecting its parent landing page', () => {
    const nodes = [
      { type: 'page', item: { id: 'pnpr', title: 'Introduction', href: '/pnpr' } },
      { type: 'page', item: { id: 'config', title: 'Configuration', href: '/pnpr/configuration' } },
    ] as Array<NavigationNode>
    const html = renderToStaticMarkup(<NavigationTree nodes={nodes} pathname="/pnpr/configuration" />)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('href="/pnpr/configuration" aria-current="page"')
    expect(html).not.toContain('href="/pnpr" aria-current="page"')
  })

  it('shows a page icon from frontmatter beside its sidebar label', () => {
    const nodes = [
      { type: 'page', item: { id: 'research', title: 'Research Index', href: '/research', icon: 'book-open' } },
    ] as Array<NavigationNode>
    const html = renderToStaticMarkup(<NavigationTree nodes={nodes} pathname="/" />)
    expect(html).toContain('data-icon-name="book-open"')
  })
})

describe('sidebar API method pills', () => {
  it('prefixes operation pages with their complete HTTP method', () => {
    const nodes = [
      { type: 'page', item: { id: 'a', title: 'Scrape', href: '/scrape', method: 'POST' } },
      { type: 'page', item: { id: 'b', title: 'Cancel Crawl', href: '/cancel', method: 'DELETE' } },
      { type: 'page', item: { id: 'c', title: 'Errors', href: '/errors' } },
    ] as Array<NavigationNode>
    const html = renderToStaticMarkup(<NavigationTree nodes={nodes} pathname="/" />)
    expect(html).toMatch(/>POST<\/span><span[^>]*>Scrape</)
    expect(html).toMatch(/>DELETE<\/span><span[^>]*>Cancel Crawl</)
    expect(html.match(/thally-method-tag/g)).toHaveLength(2)
  })
})


it('renders an authored open group even when no descendant is active', () => {
  const nodes = [{ type: 'group', group: { id: 'examples', title: 'Examples', defaultOpen: true, nodes: [{ type: 'page', item: { id: 'example', title: 'Example', href: '/example' } }] } }] as Array<NavigationNode>
  const html = renderToStaticMarkup(<NavigationTree nodes={nodes} pathname="/other" />)
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('href="/example"')
})

/** Metadata remains distinct from labels, including labels beginning with a verb. */
describe('API method tags', () => {
  it('renders structured methods without guessing from a page title', () => {
    const nodes: Array<NavigationNode> = [
      { type: 'page', item: { id: 'api', title: 'Create page', href: '/api/pages', method: 'POST' } },
      { type: 'page', item: { id: 'guide', title: 'GET started', href: '/guide' } },
    ]
    const html = renderToStaticMarkup(<NavigationTree nodes={nodes} pathname="/api/pages" mobile />)
    expect(html).toContain('data-method="post"')
    expect(html).toContain('thally-method-tag">POST</span>')
    expect(html.match(/thally-method-tag/g)).toHaveLength(1)
    expect(html).toContain('GET started')
  })
})
