/** Navigation keys Thally has no counterpart for are reported once, never dropped without a word. */

import { describe, expect, it } from 'vitest'

import { projectMintlifyNavigation } from '../index.js'

const messages = (navigation: unknown): Array<string> => projectMintlifyNavigation({ navigation } as Record<string, unknown>).warnings.map((warning) => warning.message)

describe('Mintlify navigation tag and boost', () => {
  const navigation = {
    tabs: [{
      tab: 'Docs',
      menu: [
        { item: 'Preview features', tag: 'PREVIEW', pages: ['a'] },
        { item: 'Guides', pages: ['b', { group: 'Old', tag: 'RECOMMENDED', boost: 0.25, pages: ['c', { group: 'Deeper', boost: 0.25, pages: ['d'] }] }] },
      ],
    }],
  }

  it('reports the dropped tags in one summary line', () => {
    const tags = messages(navigation).filter((message) => message.includes('tag'))
    expect(tags).toHaveLength(1)
    expect(tags[0]).toContain('2 entries')
    expect(tags[0]).toContain('"PREVIEW"')
    expect(tags[0]).toContain('"RECOMMENDED"')
    expect(tags[0]).toContain('`badge`')
  })

  it('reports the dropped boost values in one summary line', () => {
    const boosts = messages(navigation).filter((message) => message.includes('boost'))
    expect(boosts).toHaveLength(1)
    expect(boosts[0]).toContain('2 entries')
  })

  it('says nothing when navigation has neither key', () => {
    expect(messages({ tabs: [{ tab: 'Docs', pages: ['a'] }] }).filter((message) => /tag|boost/.test(message))).toEqual([])
  })

  it('counts an entry of a single-entry list once and uses the singular', () => {
    const [tags] = messages({ tabs: [{ tab: 'Docs', groups: [{ group: 'G', tag: 'NEW', pages: ['a'] }] }] }).filter((message) => message.includes('tag'))
    expect(tags).toContain('1 entry')
  })
})
