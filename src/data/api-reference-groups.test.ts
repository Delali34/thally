/** `api.groups`: the sidebar of an API tab from authored operation keys, and the tag-grouped sidebar it replaces. */

import { describe, expect, it, vi } from 'vitest'
import type { DocsJsonApiGroup, NavigationNode, SidebarCollection } from '@/data/docs'

const ok = { responses: { 200: { description: 'ok' } } }
const documents: Record<string, unknown> = {
  default: {
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1' },
    paths: {
      '/pets': { get: { summary: 'List pets', tags: ['Pets'], ...ok }, post: { summary: 'Add pet', tags: ['Pets'], ...ok } },
      '/pets/{id}': { delete: { summary: 'Remove pet', tags: ['Pets'], ...ok } },
      '/stores': { get: { summary: 'List stores', tags: ['Stores'], ...ok } },
      '/hidden': { get: { summary: 'Hidden op', 'x-hidden': true, ...ok } },
      '/excluded': { get: { summary: 'Excluded op', 'x-excluded': true, ...ok } },
    },
    webhooks: { petAdopted: { post: { summary: 'Pet adopted', ...ok } } },
  },
}

vi.mock('@/config/api-reference', () => ({
  apiReferenceConfig: {
    defaultSpecId: 'default',
    specs: [{ id: 'default', label: 'API', source: { type: 'inline', document: {} }, tagsOrder: ['Stores', 'Pets'] }],
  },
}))
vi.mock('@/lib/openapi/fetch', () => ({
  getSpecConfig: (config: { specs: Array<{ id: string }> }, id: string) => config.specs.find((spec) => spec.id === id),
  loadSpec: async (config: { id: string }) => ({ config, document: documents[config.id] }),
}))

import { getAllApiOperationNodes, getApiOperationBySlug, withApiNavigation } from '@/data/api-reference'
import { API_GROUPS_MAX_DEPTH } from '@/lib/openapi/operation-keys'

const tab = (api: Partial<NonNullable<SidebarCollection['api']>>, prefix = ''): Promise<SidebarCollection> =>
  withApiNavigation([{ id: 'docs-api', label: 'API', sections: [], api: { source: 'openapi.json', ...api } }], prefix).then(([entry]) => entry)

const titles = (nodes: Array<NavigationNode> = []): Array<unknown> => nodes.map((node) =>
  node.type === 'page' ? node.item.title : { [node.group.title]: titles(node.group.nodes) })

describe('api.groups', () => {
  it('lists operations in the authored order, with no alphabetical or tag sort', async () => {
    const { sections } = await tab({ groups: [
      { group: 'Stores', pages: ['GET /stores'] },
      { group: 'Pets', pages: ['GET /pets', 'POST /pets'] },
    ] })
    expect(sections.map((section) => section.title)).toEqual(['Stores', 'Pets'])
    expect(sections[1].items.map((item) => item.title)).toEqual(['List pets', 'Add pet'])
    const reversed = await tab({ groups: [{ group: 'Pets', pages: ['POST /pets', 'GET /pets'] }, { group: 'Stores', pages: ['GET /stores'] }] })
    expect(reversed.sections.map((section) => section.title)).toEqual(['Pets', 'Stores'])
    expect(reversed.sections[0].items.map((item) => item.title)).toEqual(['Add pet', 'List pets'])
  })

  it('keeps nested groups as collapsible nodes and lists every descendant in items, in order', async () => {
    const groups: Array<DocsJsonApiGroup> = [{ group: 'Pets', icon: 'paw', pages: [
      'GET /pets',
      { group: 'Details', pages: ['DELETE /pets/{id}', { group: 'Deep', pages: ['POST /pets'] }] },
      'GET /stores',
    ] }]
    const { sections } = await tab({ groups })
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ id: 'openapi-0', title: 'Pets', icon: 'paw' })
    expect(titles(sections[0].nodes)).toEqual(['List pets', { Details: ['Remove pet', { Deep: ['Add pet'] }] }, 'List stores'])
    expect(sections[0].items.map((item) => item.title)).toEqual(['List pets', 'Remove pet', 'Add pet', 'List stores'])
    const details = sections[0].nodes?.[1]
    expect(details).toMatchObject({ type: 'group', group: { title: 'Details', id: 'openapi-group-0-1' } })
  })

  it('gives each item the authored group ancestry, the method pill and the usual fields', async () => {
    const { sections } = await tab({ groups: [{ group: 'Pets', pages: ['GET /pets', { group: 'Details', pages: ['DELETE /pets/{id}'] }] }] })
    const [list, remove] = sections[0].items
    expect(list).toMatchObject({ title: 'List pets', method: 'GET', description: 'GET /pets', href: '/api/default/pets/get', groupPath: ['Pets'] })
    expect(remove).toMatchObject({ title: 'Remove pet', method: 'DELETE', description: 'DELETE /pets/{id}', groupPath: ['Pets', 'Details'] })
  })

  it('prefixes links for a locale', async () => {
    const { sections } = await tab({ groups: [{ group: 'Pets', pages: ['GET /pets'] }] }, '/es')
    expect(sections[0].items[0].href).toBe('/es/api/default/pets/get')
  })

  it('skips keys that match nothing, hidden or excluded operations, and drops a group left empty', async () => {
    const { sections } = await tab({ groups: [
      { group: 'Typos', pages: ['GET /nope', 'FETCH /pets', 'GET', '', 'pets'] },
      { group: 'Hidden', pages: ['GET /hidden', 'GET /excluded', { group: 'Nested', pages: ['GET /missing'] }] },
      { group: 'Pets', pages: ['GET /missing', 'GET /pets', { group: 'Empty', pages: [] }] },
    ] })
    expect(sections.map((section) => section.title)).toEqual(['Pets'])
    expect(titles(sections[0].nodes)).toEqual(['List pets'])
    expect(sections[0].id).toBe('openapi-2')
  })

  it('shows a key listed twice in one tab once, at its first position', async () => {
    const { sections } = await tab({ groups: [
      { group: 'First', pages: ['GET /pets', 'GET /stores'] },
      { group: 'Second', pages: ['GET /pets'] },
      { group: 'Third', pages: [{ group: 'Inner', pages: ['GET /stores', 'POST /pets'] }, 'GET /pets'] },
    ] })
    expect(sections.map((section) => [section.title, section.items.map((item) => item.title)])).toEqual([
      ['First', ['List pets', 'List stores']],
      ['Third', ['Add pet']],
    ])
  })

  it('matches the method in any case and ignores extra spaces, but not a different path', async () => {
    const { sections } = await tab({ groups: [{ group: 'Pets', pages: [' get   /pets ', 'Post /pets', 'delete /pets/{id}', 'GET /Pets', 'GET /pets/'] }] })
    expect(sections[0].items.map((item) => item.title)).toEqual(['List pets', 'Add pet', 'Remove pet'])
  })

  it('lists webhooks by their WEBHOOK key, shown with the HOOK pill', async () => {
    const { sections } = await tab({ groups: [{ group: 'Events', pages: ['WEBHOOK POST petAdopted', 'webhook post petAdopted', 'POST petAdopted', 'WEBHOOK GET petAdopted'] }] })
    expect(sections[0].items).toHaveLength(1)
    expect(sections[0].items[0]).toMatchObject({ title: 'Pet adopted', method: 'HOOK', description: 'POST petAdopted', groupPath: ['Events'] })
  })

  it('never throws on malformed entries: skips them and keeps the valid ones', async () => {
    for (const groups of [[null], [{ group: 'X', pages: 'GET /pets' }], [{ group: 'X', pages: [null] }], [{ group: 'X' }], [{ group: 5, pages: ['GET /pets'] }], ['GET /pets']]) {
      expect((await tab({ groups: groups as never })).sections).toEqual([])
    }
    const { sections } = await tab({ groups: [
      null,
      { group: 'NoPages' },
      { group: 'Text', pages: 'GET /pets' },
      { group: 'Mixed', pages: [null, 7, ['GET /stores'], { group: 'Bad', pages: {} }, { group: 'Pets', pages: ['GET /pets'] }, 'GET /stores'] },
    ] as never })
    expect(sections.map((section) => section.title)).toEqual(['Mixed'])
    expect(titles(sections[0].nodes)).toEqual([{ Pets: ['List pets'] }, 'List stores'])
  })

  it('keeps a group icon only when it is a non-empty string, and still renders the group', async () => {
    const { sections } = await tab({ groups: [
      { group: 'Object', icon: { bad: true }, pages: ['GET /pets'] },
      { group: 'Number', icon: 5, pages: [{ group: 'Nested', icon: ['x'], pages: ['GET /stores'] }] },
      { group: 'Empty', icon: '', pages: ['POST /pets'] },
      { group: 'Named', icon: 'paw', pages: ['DELETE /pets/{id}'] },
    ] as never })
    expect(sections.map((section) => [section.title, section.icon])).toEqual([['Object', undefined], ['Number', undefined], ['Empty', undefined], ['Named', 'paw']])
    expect(sections[1].nodes?.[0]).toMatchObject({ type: 'group', group: { title: 'Nested', icon: undefined } })
  })

  it('stops at the shared depth limit: deeper groups are skipped and nothing overflows the stack', async () => {
    const nest = (levels: number, leaf: DocsJsonApiGroup['pages']): DocsJsonApiGroup => {
      let pages = leaf
      for (let level = levels; level >= 1; level--) pages = [{ group: `G${level}`, pages }]
      return pages[0] as DocsJsonApiGroup
    }
    const atLimit = await tab({ groups: [nest(API_GROUPS_MAX_DEPTH, ['GET /pets'])] })
    expect(atLimit.sections[0].items.map((item) => item.title)).toEqual(['List pets'])
    expect((await tab({ groups: [nest(API_GROUPS_MAX_DEPTH + 1, ['GET /pets'])] })).sections).toEqual([])
    const { sections } = await tab({ groups: [{ group: 'Pets', pages: ['GET /pets', nest(API_GROUPS_MAX_DEPTH, ['GET /stores'])] }] })
    expect(sections[0].items.map((item) => item.title)).toEqual(['List pets'])
    expect((await tab({ groups: [nest(3001, ['GET /pets'])] })).sections).toEqual([])
  })

  it('does not use an empty list, and navigation: false wins over a list', async () => {
    expect((await tab({ groups: [] })).sections.map((section) => section.title)).toEqual(['Stores', 'Pets', 'Webhooks'])
    const off = await tab({ navigation: false, groups: [{ group: 'Pets', pages: ['GET /pets'] }] })
    expect(off.sections).toEqual([])
  })

  it('leaves unlisted operations routable and in the operation list, only out of the sidebar', async () => {
    const { sections } = await tab({ groups: [{ group: 'Pets', pages: ['GET /pets'] }] })
    expect(sections.flatMap((section) => section.items.map((item) => item.href))).toEqual(['/api/default/pets/get'])
    const stores = await getApiOperationBySlug(['default', 'stores', 'get'])
    expect(stores?.operation.title).toBe('List stores')
    expect((await getAllApiOperationNodes()).map((node) => node.operation.title).sort())
      .toEqual(['Add pet', 'List pets', 'List stores', 'Pet adopted', 'Remove pet'])
  })
})

describe('tag-grouped sidebar without api.groups', () => {
  it('is unchanged: tags order, alphabetical items, no authored tree, now with the method pill', async () => {
    const { sections } = await tab({})
    expect(sections.map((section) => section.title)).toEqual(['Stores', 'Pets', 'Webhooks'])
    expect(sections.map((section) => section.id)).toEqual(['openapi-0', 'openapi-1', 'openapi-2'])
    expect(sections[1].items.map((item) => [item.title, item.method, item.description])).toEqual([
      ['Add pet', 'POST', 'POST /pets'],
      ['List pets', 'GET', 'GET /pets'],
      ['Remove pet', 'DELETE', 'DELETE /pets/{id}'],
    ])
    expect(sections[2].items[0]).toMatchObject({ title: 'Pet adopted', method: 'HOOK', description: 'POST petAdopted' })
    for (const section of sections) {
      expect(section).not.toHaveProperty('nodes')
      for (const item of section.items) expect(item).not.toHaveProperty('groupPath')
    }
  })
})
