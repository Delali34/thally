/** Passive Flight fixtures retain public navigation shape without deployment metadata. */
import { describe, expect, it } from 'vitest'
import { extractSourceNavigation, mergeSourceNavigation } from '../url-navigation.js'
import type { MigrationCapture, MigrationNavigationOccurrence } from '../url-run-types.js'

const tabs = [
  ['Overview', '/introduction/introduction'], ['Enterprise (New)', '/enterprise/overview'],
  ['API Reference', '/api-reference/introduction'], ['SDK', '/sdk/overview'], ['Widget', '/widget/overview'],
  ['Composer', '/composer/overview'], ['Earn', '/earn/overview'], ['Perps', '/perps/overview'],
  ['Intents & Solvers', '/lifi-intents/introduction'], ['For Agents', '/agents/overview'],
  ['Widget Playground', 'https://playground.li.fi/'], ['Bigmi', '/bigmi/overview'],
  ['Guides', '/guides/gas-options'], ['FAQs', '/faqs/fees-monetization'],
] as const

function envelope(value: string): string {
  return `<script>self.__next_f.push(${JSON.stringify([1, value])})</script>`
}

function capture(active = 'Overview'): MigrationCapture {
  // Reduced authentic Mintlify scopedNav: all sibling tabs are present, but only
  // the selected tab expands. The other language is also only an entry page.
  const scopedNav = { global: null, languages: [{ language: 'en', tabs: tabs.map(([tab, href]) => {
    if (tab === 'Widget Playground') return { tab, href }
    if (tab !== active) return { tab, pages: [{ title: tab, href }] }
    if (tab === 'Overview') return { tab, groups: [
      { group: 'Learn About LI.FI', pages: [{ title: 'Universal Market Access for Digital Assets', href }] },
      { group: 'LI.FI Architecture', pages: [{ title: 'API latency and optimization', href: '/guides/latency' }] },
      { group: 'Learn More', pages: [{ group: 'How to get integrated by LI.FI', pages: [
        { title: 'Getting Integrated by LI.FI', href: '/introduction/learn-more/getting-integrated-by-lifi' },
        { title: 'For Bridges', href: '/introduction/learn-more/for-bridges' },
      ] }] },
    ] }
    return { tab, groups: [{ group: tab === 'Guides' ? 'General Guides' : `${tab} Guides`, pages: [
      { title: tab, href }, { title: 'API latency and optimization', href: '/guides/latency' },
    ] }] }
  }) }, { language: 'zh-Hans', pages: [{ title: 'zh-Hans', href: '/zh-Hans/introduction/introduction' }] }] }
  const stream = `:HL["/style.css","style"]\n1a:${JSON.stringify(['$', '$L2b', null, { value: {
    docsConfig: { navigation: { languages: [{ language: 'en', href: 'introduction/introduction' }] } },
    docsNavWithMetadata: '$undefined', anonymizedNav: '$undefined', hasFullNav: false,
  } }])}\n4f:T${Buffer.byteLength('中文 article text').toString(16)},中文 article text1b:${JSON.stringify(['$', '$L44', null, { scopedNav, children: '$L45' }])}\n`
  const path = tabs.find(([tab]) => tab === active)![1]
  return { finalUrl: new URL(path, 'https://docs.li.fi'), contentType: 'text/html',
    // Split inside a row to prove Flight transport boundaries are not rows.
    body: `<html lang="en"><body><aside><a href="/wrong">Wrong DOM fallback</a></aside>${envelope(stream.slice(0, 130))}${envelope(stream.slice(130))}</body></html>` }
}

function leaves(nodes: Array<MigrationNavigationOccurrence>): Array<string> {
  return nodes.flatMap((node) => [...(node.url ? [node.url] : []), ...leaves(node.children ?? [])])
}

describe('passive source navigation', () => {
  it('reads the 14 ordered tabs, nested groups, and external link from scoped Flight JSON', () => {
    const navigation = extractSourceNavigation(capture())
    expect(navigation.map((node) => node.label)).toEqual(tabs.map(([label]) => label))
    expect(navigation[0]).toMatchObject({ kind: 'tab', locale: 'en', children: [
      { label: 'Learn About LI.FI', kind: 'group' }, { label: 'LI.FI Architecture', kind: 'group' },
      { label: 'Learn More', kind: 'group', children: [{ label: 'How to get integrated by LI.FI', kind: 'group', children: [
        { label: 'Getting Integrated by LI.FI' }, { label: 'For Bridges' },
      ] }] },
    ] })
    expect(navigation[10]).toMatchObject({ label: 'Widget Playground', url: 'https://playground.li.fi/', kind: 'tab' })
    expect(leaves(navigation)).not.toContain('https://docs.li.fi/wrong')
    expect(leaves(navigation)).not.toContain('https://docs.li.fi/zh-Hans/introduction/introduction')
  })

  it('enriches every tab without stale placeholders and preserves duplicate cross-tab placements', () => {
    let navigation = extractSourceNavigation(capture())
    const snapshots = tabs.filter(([label]) => label !== 'Widget Playground').map(([label]) => extractSourceNavigation(capture(label)))
    for (const snapshot of snapshots) navigation = mergeSourceNavigation(navigation, snapshot)
    expect(navigation.map((node) => node.label)).toEqual(tabs.map(([label]) => label))
    expect(navigation[0].children?.map((node) => node.label)).toEqual(['Learn About LI.FI', 'LI.FI Architecture', 'Learn More'])
    expect(navigation[12].children?.[0]).toMatchObject({ label: 'General Guides', kind: 'group' })
    expect(leaves(navigation[0].children ?? [])).toContain('https://docs.li.fi/guides/latency')
    expect(leaves(navigation[12].children ?? [])).toContain('https://docs.li.fi/guides/latency')
    expect(navigation.every((node) => node.label === 'Widget Playground' || node.children?.every((child) => child.label !== node.label))).toBe(true)
    expect(mergeSourceNavigation(navigation, snapshots[0])).toEqual(navigation)
    // Navigation journals are JSON; no out-of-band parser state may be needed.
    expect(mergeSourceNavigation(JSON.parse(JSON.stringify(navigation)), snapshots[1])).toEqual(navigation)
  })

  it('preserves repeated identical siblings and does not mutate source observations', () => {
    const node = { label: 'Guide', url: 'https://docs.test/guide' }
    const existing = [{ label: 'Start', children: [node, { ...node }] }]
    const before = JSON.stringify(existing)
    expect(mergeSourceNavigation(existing, existing)[0].children).toHaveLength(2)
    expect(JSON.stringify(existing)).toBe(before)
  })

  it('reads complete docsConfig navigation with site-root page ids', () => {
    const document = capture()
    document.body = envelope(`1:${JSON.stringify(['$', null, null, { docsConfig: {
      navigation: { tabs: [{ tab: 'Guides', pages: ['guides/overview', 'guides/install'] }] },
    }, hasFullNav: true }])}\n`)
    expect(extractSourceNavigation(document)).toEqual([{ kind: 'tab', label: 'Guides', children: [
      { kind: 'page', label: 'guides/overview', url: 'https://docs.li.fi/guides/overview' },
      { kind: 'page', label: 'guides/install', url: 'https://docs.li.fi/guides/install' },
    ] }])
  })

  it('uses the publisher language branch containing a legacy route despite stale HTML lang', () => {
    const document = capture()
    document.finalUrl = new URL('https://docs.li.fi/zh-hans-api-reference/introduction')
    document.body = '<html lang="en"><body>' + envelope(`1b:${JSON.stringify(['$', '$L44', null, { scopedNav: {
      global: null, languages: [
        { language: 'en', pages: [{ title: 'Overview', href: '/introduction/introduction' }] },
        { language: 'zh-Hans', tabs: [
          { tab: '概述', pages: [{ title: '概述', href: '/zh-Hans/introduction/introduction' }] },
          { tab: 'API 参考', groups: [{ group: '关于 API', pages: [
            { title: '概述', href: '/zh-hans-api-reference/introduction' },
            { title: 'API 密钥安全', href: '/zh-hans-api-reference/api-key-security' },
          ] }] },
        ] },
      ],
    }, children: '$L45' }])}\n`) + '</body></html>'
    const navigation = extractSourceNavigation(document)
    expect(navigation.map((node) => node.label)).toEqual(['概述', 'API 参考'])
    expect(navigation[1]).toMatchObject({ kind: 'tab', locale: 'zh-Hans', children: [
      { kind: 'group', label: '关于 API', children: [
        { label: '概述', url: 'https://docs.li.fi/zh-hans-api-reference/introduction' },
        { label: 'API 密钥安全', url: 'https://docs.li.fi/zh-hans-api-reference/api-key-security' },
      ] },
    ] })
  })

  it('uses explicit capture navigation first, resolving links and retaining structural kinds', () => {
    const document = capture()
    document.navigation = [{ label: 'Explicit', kind: 'tab', children: [{ label: 'Guide', url: '/guide' }] } as MigrationNavigationOccurrence]
    expect(extractSourceNavigation(document)).toEqual([{ label: 'Explicit', kind: 'tab', children: [{ label: 'Guide', url: 'https://docs.li.fi/guide' }] }])
  })

  it('falls back to nested DOM navigation and rejects executable or credentialed hrefs', () => {
    const document = capture()
    document.body = '<aside><ul><li><span>Learn</span><ul><li><a href="/safe">Safe</a></li><li><a href="javascript:alert(1)">Bad</a></li><li><a href="https://user:pass@example.com/">Bad</a></li></ul></li></ul></aside>'
    expect(extractSourceNavigation(document)).toEqual([{ label: 'Learn', children: [{ label: 'Safe', url: 'https://docs.li.fi/safe' }] }])
  })

  it('never executes JavaScript around an otherwise recognizable Flight envelope', () => {
    const document = capture()
    document.body = '<aside><a href="/safe">Safe</a></aside>' + envelope('1:["$",null,null,{"scopedNav":{"tabs":[{"tab":"Injected","href":"/injected"}]}}]\n').replace('</script>', ';globalThis.__navigationExecuted=true</script>')
    expect(extractSourceNavigation(document)).toEqual([{ label: 'Safe', url: 'https://docs.li.fi/safe' }])
    expect((globalThis as Record<string, unknown>).__navigationExecuted).toBeUndefined()
  })

  it('skips text-record bytes even when article examples resemble navigation records', () => {
    const document = capture()
    const example = '\n1:["$",null,null,{"scopedNav":{"tabs":[{"tab":"Article Example","href":"/wrong"}]}}]\n'
    document.body = '<aside><a href="/safe">Safe</a></aside>' + envelope(`f:T${Buffer.byteLength(example).toString(16)},${example}`)
    expect(extractSourceNavigation(document)).toEqual([{ label: 'Safe', url: 'https://docs.li.fi/safe' }])
  })

  it('ignores deeply nested or malformed structured data and rejects excessive explicit navigation', () => {
    const document = capture()
    document.body = '<aside><a href="/safe">Safe</a></aside>' + envelope(`1:${'['.repeat(120)}0${']'.repeat(120)}\n`) + '<script>self.__next_f.push([1, broken])</script>'
    expect(extractSourceNavigation(document)).toEqual([{ label: 'Safe', url: 'https://docs.li.fi/safe' }])
    let nodes: Array<MigrationNavigationOccurrence> = [{ label: 'Leaf', url: '/leaf' }]
    for (let depth = 0; depth < 40; depth++) nodes = [{ label: 'Group', children: nodes }]
    document.navigation = nodes
    expect(() => extractSourceNavigation(document)).toThrow('navigation')
  })
})
