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
  it('keeps accessible icon destinations without assigning a logo title to an existing page', () => {
    const body = '<aside><a href="/"><img alt="Site logo"></a><a href="/">Intro</a><a href="/guide">Guide</a><a href="https://code.example.test/project" aria-label="Repository"><svg></svg></a><a href="https://status.example.test/" title="Service status"><svg></svg></a><a href="https://support.example.test/"><img alt="Support"></a></aside>'
    expect(extractSourceNavigation({ finalUrl: new URL('https://docs.example.test/guide'), contentType: 'text/html', body })).toEqual([
      { label: 'Intro', url: 'https://docs.example.test/' }, { label: 'Guide', url: 'https://docs.example.test/guide' },
      { label: 'Repository', url: 'https://code.example.test/project' }, { label: 'Service status', url: 'https://status.example.test/' }, { label: 'Support', url: 'https://support.example.test/' },
    ])
  })

  it('ignores an external-only author aside containing metadata prose', () => {
    const body = '<article><h1>Post</h1></article><aside><p>Published yesterday</p><p>Author</p><a href="https://social.example.test/author">Author name</a></aside>'
    expect(extractSourceNavigation({ finalUrl: new URL('https://docs.example.test/post'), contentType: 'text/html', body })).toEqual([])
  })

  it.each([false, true])('reads only the root-owned sidebar collection menu (article fake=%s)', fakeArticle => {
    const options = [{ title: 'Current', description: 'Current collection', url: '/' }, { title: 'Previous', description: 'Maintained collection', url: 'https://previous.example.test/' }]
    const element = ['$', '$L1', null, { children: ['$', '$L2', null, { children: ['$', '$L3', null, { options: '$5:props:options' }] }] }]
    const tree = fakeArticle ? ['$', '$L4', null, { children: element }] : element
    const stream = `1:I["module",[],"Sidebar"]\n2:I["module",[],"SidebarHeader"]\n3:I["module",[],"RootToggle"]\n4:I["module",[],"PageArticle"]\n0:${JSON.stringify(tree)}\n5:${JSON.stringify(['$', 'div', null, { options }])}\n6:${JSON.stringify({ options: [{ title: 'Poison', url: 'https://poison.example.test/' }] })}\n`
    const body = `<aside><button aria-haspopup="dialog"><span>Current</span></button><a href="/">Intro</a><a href="/guide">Guide</a></aside>${envelope(stream)}`
    const result = extractSourceNavigation({ finalUrl: new URL('https://docs.example.test/guide'), contentType: 'text/html', body })
    expect(result.map(node => node.label)).toEqual(fakeArticle ? ['Intro', 'Guide'] : ['Intro', 'Guide', 'Previous'])
    expect(leaves(result)).not.toContain('https://poison.example.test/')
  })

  it('does not borrow sidebar menu options from an unreferenced record or unmatched visible trigger', () => {
    const options = [{ title: 'Current', url: '/' }, { title: 'Previous', url: 'https://previous.example.test/' }]
    for (const root of [['$', 'main', null, { children: 'Article' }], ['$', '$L1', null, { children: ['$', '$L2', null, { children: ['$', '$L3', null, { options }] }] }]]) {
      const stream = `1:I["module",[],"Sidebar"]\n2:I["module",[],"SidebarHeader"]\n3:I["module",[],"RootToggle"]\n0:${JSON.stringify(root)}\nf:${JSON.stringify(['$', '$L1', null, { children: ['$', '$L2', null, { children: ['$', '$L3', null, { options }] }] }])}\n`
      const body = `<aside><button aria-haspopup="dialog"><span>Unrelated action</span></button><a href="/">Intro</a><a href="/guide">Guide</a></aside>${envelope(stream)}`
      expect(leaves(extractSourceNavigation({ finalUrl: new URL('https://docs.example.test/guide'), contentType: 'text/html', body }))).not.toContain('https://previous.example.test/')
    }
  })

  it.each(['p', 'span'])('preserves repeated plain %s group labels and adjacent link order without platform classes', (tag) => {
    const body = `<aside><div><button>Search</button></div><div><div></div><${tag}>Guides</${tag}><a href="/second">Second</a><a href="/first">First</a><${tag}>Packages</${tag}><div><a href="/runtime">Runtime</a></div><${tag}>More</${tag}><a href="/news">News</a></div></aside>`
    expect(extractSourceNavigation({ finalUrl: new URL('https://docs.example.test/first'), contentType: 'text/html', body })).toEqual([
      { kind: 'group', label: 'Guides', children: [{ label: 'Second', url: 'https://docs.example.test/second' }, { label: 'First', url: 'https://docs.example.test/first' }] },
      { kind: 'group', label: 'Packages', children: [{ label: 'Runtime', url: 'https://docs.example.test/runtime' }] },
      { kind: 'group', label: 'More', children: [{ label: 'News', url: 'https://docs.example.test/news' }] },
    ])
  })

  it.each([
    '<p>Search</p><form><input name="query"></form><a href="/guide">Guide</a><p>More</p><a href="/next">Next</a>',
    '<p>Updates</p><div><p>Opaque promotion copy.</p><a href="/guide">Guide</a></div><p>More</p><a href="/next">Next</a>',
    '<p>One isolated paragraph</p><a href="/guide">Guide</a><a href="/next">Next</a>',
  ])('does not infer groups from search controls, opaque marketing wrappers or an isolated paragraph', (contents) => {
    const navigation = extractSourceNavigation({ finalUrl: new URL('https://docs.example.test/guide'), contentType: 'text/html', body: `<aside>${contents}</aside>` })
    expect(navigation.some(node => node.kind === 'group')).toBe(false)
    expect(leaves(navigation)).toEqual(['https://docs.example.test/guide', 'https://docs.example.test/next'])
  })

  it.each(['', '?section=example'])('does not treat article breadcrumbs or a sibling author/TOC aside as site navigation (query=%s)', query => {
    const body = '<main><article><nav aria-label="Breadcrumb"><a href="/blog">Blog</a></nav><h1>Article</h1></article><aside><a href="https://social.example.test/author">Author</a><nav><a href="#example">Example</a><a href="/post#other">Other section</a></nav></aside></main>'
    expect(extractSourceNavigation({ finalUrl: new URL(`https://docs.example.test/post${query}`), contentType: 'text/html', body })).toEqual([])
  })

  it('retains exact query-selected page targets in a real sidebar', () => {
    const body = '<main><aside aria-label="Sidebar"><a href="?version=one">One</a><a href="?version=two">Two</a></aside><article><h1>Guide</h1></article></main>'
    expect(leaves(extractSourceNavigation({ finalUrl: new URL('https://docs.example.test/guide?version=one'), contentType: 'text/html', body }))).toEqual(['https://docs.example.test/guide?version=one', 'https://docs.example.test/guide?version=two'])
  })

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
