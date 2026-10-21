/** Keep manual endpoint controls above the responsive authored parameter/code grid. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DocEntry } from '@/data/docs'

vi.mock('next/navigation', () => ({ usePathname: () => '/create-page' }))
vi.mock('@/data/docs', () => ({
  getBreadcrumbs: () => [], getBreadcrumbsEnabled: () => true, getEyebrowMode: () => 'group', getNavGroupPath: () => ['Pages'], getContextualOptions: () => ({}), getNavCategory: () => 'Pages',
  getPrevNextLinks: () => ({ prev: null, next: null }), getFeedbackConfig: () => ({}),
}))
vi.mock('@/lib/cloud-link/client', () => ({ getManagedSiteConfigSnapshot: () => null }))
vi.mock('@/lib/cloud-link/content-controls', () => ({ getBuildContentControls: () => ({}) }))
vi.mock('@/lib/site-config', () => ({ resolveBuildSiteConfig: () => ({}) }))
vi.mock('@/components/docs/copy-page-button', () => ({ CopyPageButton: () => null }))
vi.mock('@/components/docs/feedback', () => ({ Feedback: () => null }))
import { DocLayout } from './doc-layout'

const page: DocEntry = {
  id: 'create-page', title: 'Create page', description: '', slug: ['create-page'],
  href: '/create-page', group: 'Pages', keywords: [], component: () => null,
  timeEstimate: '1 min', lastUpdated: '2026-10-21',
}

describe('authored API layout', () => {
  it('renders the endpoint once above the grid without duplicating authored content', () => {
    const doc = { ...page, manualApi: { id: 'create' } as DocEntry['manualApi'] }
    const html = renderToStaticMarkup(<DocLayout doc={doc} endpoint={<div>Endpoint controls</div>}><p>Authored parameters</p></DocLayout>)
    expect(html.match(/Endpoint controls/g)).toHaveLength(1)
    expect(html.match(/Authored parameters/g)).toHaveLength(1)
    expect(html.indexOf('Endpoint controls')).toBeLessThan(html.indexOf('thally-authored-endpoint-grid'))
    expect(html).toContain('aria-label="Code examples"')
  })

  it('keeps ordinary documentation on its existing layout', () => {
    const html = renderToStaticMarkup(<DocLayout doc={page}><p>Ordinary document</p></DocLayout>)
    expect(html).not.toContain('thally-authored-endpoint-grid')
    expect(html).toContain('Ordinary document')
  })
})
