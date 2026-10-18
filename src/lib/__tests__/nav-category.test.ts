/**
 * The category eyebrow shown above every doc page title is derived from the
 * docs.json navigation model — never duplicated into page frontmatter. These
 * tests pin that derivation (nearest group wins, pages outside groups get
 * none) and the locale invariants it relies on: navigation labels are
 * single-sourced, so switching locale can change content but never the
 * navigation structure or appearance tokens around it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getNavCategory, getNavContext, getNavGroupPath, getSidebarCollections, loadNavContext } from '@/data/docs'

// Customer-owned navigation may have no groups, use a different home page, or
// contain direct links. Exercise the runtime contract with explicit fixtures.
beforeEach(() => {
  vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
    tabs: [{ tab: 'Documentation', groups: [{
      group: 'Guides',
      pages: ['introduction', { group: 'Advanced', pages: ['guides/advanced'] }],
    }] }],
  }))
})
afterEach(() => vi.unstubAllEnvs())

describe('getNavCategory', () => {
  it('returns the containing group for a grouped page', () => {
    const collections = getSidebarCollections()
    const section = collections.flatMap((c) => c.sections).find((s) => s.items.length > 0)
    expect(section).toBeDefined()
    const leaf = section!.items[0].groupPath?.at(-1) ?? section!.title
    expect(getNavCategory(section!.items[0].href)).toBe(leaf)
  })

  it('resolves the first group of the first tab for the home page', () => {
    expect(getNavCategory('/')).toBe('Guides')
  })

  it('does not invent a home-page category for navigation without an introduction', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      tabs: [{ tab: 'Documentation', groups: [{ group: 'Guides', pages: ['guides/advanced'] }] }],
    }))
    expect(getNavCategory('/')).toBeNull()
  })

  it('returns null for pages outside any navigation group', () => {
    expect(getNavCategory('/definitely-not-a-nav-page')).toBeNull()
  })

  it('matches the leaf group for every navigable page', () => {
    // Every grouped page must produce a non-empty category — the eyebrow can
    // never render blank text.
    for (const collection of getSidebarCollections()) {
      for (const section of collection.sections) {
        for (const item of section.items) {
          const category = getNavCategory(item.href)
          expect(category, `category for ${item.href}`).toBeTruthy()
          expect(category).toBe(item.groupPath?.at(-1) ?? section.title)
        }
      }
    }
  })
})

describe('group path (the path eyebrow)', () => {
  it('lists every group above a page, outermost first, and stays empty outside any group', () => {
    expect(getNavGroupPath('/guides/advanced')).toEqual(['Guides', 'Advanced'])
    expect(getNavGroupPath('/')).toEqual(['Guides'])
    expect(getNavGroupPath('/definitely-not-a-nav-page')).toEqual([])
  })

  it('ends in the category the group eyebrow shows', () => {
    expect(getNavCategory('/guides/advanced')).toBe('Advanced')
    expect(getNavGroupPath('/guides/advanced').at(-1)).toBe('Advanced')
  })

  it('is on the nav context beside the nearest group, sync and for managed releases', async () => {
    expect(getNavContext('guides/advanced')).toMatchObject({ group: 'Advanced', groupPath: ['Guides', 'Advanced'] })
    expect(await loadNavContext('guides/advanced')).toMatchObject({ group: 'Advanced', groupPath: ['Guides', 'Advanced'] })
    expect(getNavContext('not-in-navigation')).toMatchObject({ group: '', groupPath: [] })
  })

  it('is empty for root pages that sit outside any group', () => {
    vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({
      tabs: [{ tab: 'Documentation', pages: ['introduction', { group: 'Guides', pages: ['guides/advanced'] }] }],
    }))
    expect(getNavContext('introduction')).toMatchObject({ group: '', groupPath: [] })
    expect(getNavContext('guides/advanced').groupPath).toEqual(['Guides'])
  })
})

describe('locale switching keeps navigation structure and labels identical', () => {
  it('resolves the same tabs, groups and item order for en and es', () => {
    const en = getSidebarCollections()
    const es = getSidebarCollections('es')

    expect(es.map((c) => c.label)).toEqual(en.map((c) => c.label))
    for (let i = 0; i < en.length; i++) {
      expect(es[i].sections.map((s) => s.title)).toEqual(en[i].sections.map((s) => s.title))
      for (let j = 0; j < en[i].sections.length; j++) {
        expect(es[i].sections[j].items.map((it) => it.id)).toEqual(
          en[i].sections[j].items.map((it) => it.id),
        )
      }
    }
  })

  it('changes only the locale prefix on hrefs — never structure', () => {
    const en = getSidebarCollections()
    const es = getSidebarCollections('es')

    for (let i = 0; i < en.length; i++) {
      for (let j = 0; j < en[i].sections.length; j++) {
        for (let k = 0; k < en[i].sections[j].items.length; k++) {
          const enHref = en[i].sections[j].items[k].href
          const esHref = es[i].sections[j].items[k].href
          if (enHref.startsWith('http') || esHref.startsWith('http')) continue
          expect(esHref === enHref || esHref === `/es${enHref === '/' ? '' : enHref}`).toBe(true)
        }
      }
    }
  })
})
