import { describe, expect, it, vi } from 'vitest'
import type { SidebarCollection } from '@/data/docs'

const ok = { responses: { 200: { description: 'ok' } } }
const documents: Record<string, unknown> = {
  default: { openapi: '3.1.0', info: { title: 'A', version: '1' }, paths: {
    '/rest': { get: { summary: 'REST op', ...ok } },
    '/hidden': { get: { summary: 'Hidden op', 'x-hidden': true, ...ok } },
    '/excluded': { get: { summary: 'Excluded op', 'x-excluded': true, ...ok } },
  } },
  'page-only': { openapi: '3.1.0', info: { title: 'C', version: '1' }, paths: { '/named': { get: { summary: 'Named op', ...ok } } } },
  'docs-admin': { openapi: '3.1.0', info: { title: 'B', version: '1' }, paths: { '/admin': { get: { summary: 'Admin op', ...ok } } } },
}

vi.mock('@/config/api-reference', () => ({
  apiReferenceConfig: {
    defaultSpecId: 'default',
    specs: [
      { id: 'default', label: 'API', source: { type: 'inline', document: {} } },
      { id: 'docs-admin', label: 'Admin', source: { type: 'inline', document: {} } },
      { id: 'page-only', label: 'Page only', source: { type: 'inline', document: {} }, pageOnly: true },
    ],
  },
}))
vi.mock('@/lib/openapi/fetch', () => ({
  getSpecConfig: (config: { specs: Array<{ id: string }> }, id: string) => config.specs.find((spec) => spec.id === id),
  loadSpec: async (config: { id: string }) => ({ config, document: documents[config.id] }),
}))

import {
  buildApiNavigation,
  getAllApiOperationNodes,
  getApiOperationByKey,
  getApiOperationBySlug,
  getApiOperationSearchIndex,
  withApiNavigation,
} from '@/data/api-reference'

const collection = (id: string, extra: Partial<SidebarCollection> = {}): SidebarCollection => ({ id, label: id, sections: [], ...extra })

describe('withApiNavigation', () => {
  it('gives each API collection the operations of its own spec, never another tab\'s', async () => {
    const result = await withApiNavigation([
      collection('docs'),
      collection('docs-api-reference', { api: { source: 'openapi/a.json' } }),
      collection('docs-admin', { api: { source: 'openapi/b.json' } }),
      collection('docs-manual', { api: { source: 'openapi/c.json', navigation: false } }),
    ])
    const hrefs = (id: string) => result.find((entry) => entry.id === id)?.sections.flatMap((section) => section.items.map((item) => item.href))
    expect(hrefs('docs')).toEqual([])
    expect(hrefs('docs-api-reference')).toEqual(['/api/default/rest/get'])
    expect(hrefs('docs-admin')).toEqual(['/api/docs-admin/admin/get'])
    expect(hrefs('docs-manual')).toEqual([])
  })

  it('prefixes generated links for a locale', async () => {
    const [entry] = await withApiNavigation([collection('docs-admin', { api: { source: 'b.json' } })], '/es')
    expect(entry.sections[0].items[0].href).toBe('/es/api/docs-admin/admin/get')
    expect(entry.sections[0].items[0].method).toBe('GET')
  })
})

describe('hidden and excluded operations reach no consumer', () => {
  // Every surface (nav, routes and static params, search, sitemap, docs-index, try-it relay
  // and MDX `openapi:` pages) reads operations through these accessors.
  it.each(['hidden', 'excluded'])('%s operations are absent from nodes, nav, search, lookups', async (name) => {
    const slug = ['default', name, 'get']
    expect((await getAllApiOperationNodes()).map((node) => node.href)).toEqual(['/api/default/rest/get', '/api/docs-admin/admin/get'])
    expect((await buildApiNavigation('default')).flatMap((group) => group.items.map((item) => item.path))).toEqual(['/rest'])
    expect((await getApiOperationSearchIndex()).map((entry) => entry.href)).not.toContain(`/api/${slug.join('/')}`)
    expect(await getApiOperationBySlug(slug)).toBeNull()
    expect(await getApiOperationByKey('GET', `/${name}`)).toBeNull()
    expect(await getApiOperationByKey('get', `/${name}`, 'default')).toBeNull()
  })
})

describe('specs bound to hidden page-only tabs', () => {
  it('resolve for pages that name them but get no operation pages, search entries or sitemap URLs', async () => {
    expect((await getAllApiOperationNodes()).map((node) => node.href)).not.toContain('/api/page-only/named/get')
    expect((await getApiOperationSearchIndex()).map((entry) => entry.href)).not.toContain('/api/page-only/named/get')
    expect(await getApiOperationBySlug(['page-only', 'named', 'get'])).toBeNull()
    expect((await getApiOperationByKey('GET', '/named', 'page-only'))?.operation.title).toBe('Named op')
  })
})
