/** The pre-hydration shell of a translated route keeps every sidebar link inside the locale. */
import { describe, expect, it } from 'vitest'
import type { SidebarCollection } from '@/data/docs'
import { localizeCollectionHrefs } from './localize-collections'

describe('localizeCollectionHrefs', () => {
  it('prefixes the destination of a redirected page unless it leaves the site', () => {
    const items = [
      { id: 'agent', title: 'agent', href: '/cli/agent', redirectTo: '/cli/reference#agent' },
      { id: 'site', title: 'site', href: '/website', redirectTo: 'https://example.com/site' },
      { id: 'plain', title: 'plain', href: '/plain' },
    ]
    const source: Array<SidebarCollection> = [{ id: 'reference', label: 'Reference', sections: [{ title: 'CLI', items, nodes: items.map((item) => ({ type: 'page' as const, item })) }] }]
    const [{ sections: [section] }] = localizeCollectionHrefs(source, 'fr')
    expect(section.items).toEqual([
      { id: 'agent', title: 'agent', href: '/fr/cli/agent', redirectTo: '/fr/cli/reference#agent' },
      { id: 'site', title: 'site', href: '/fr/website', redirectTo: 'https://example.com/site' },
      { id: 'plain', title: 'plain', href: '/fr/plain' },
    ])
    expect(section.nodes?.map((node) => node.type === 'page' ? node.item.redirectTo : undefined)).toEqual(['/fr/cli/reference#agent', 'https://example.com/site', undefined])
  })
})
