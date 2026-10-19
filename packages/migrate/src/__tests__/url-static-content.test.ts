/** Synthetic publisher markup proves complete alternatives and passive assets. */
import { compile } from '@mdx-js/mdx'
import { load } from 'cheerio'
import { describe, expect, it, vi } from 'vitest'
import { defaultMigrationFetcher, htmlPage, migrateUrl, migrationHtmlArticle, sanitizeRemoteMarkdown } from '../url.js'
import { projectMigrationSvg } from '../url-static-content.js'
import { isPassiveSvg } from '../svg-policy.js'
import { readMigrationFlightDocument } from '../url-flight-content.js'

const document = (body: string) => ({ body, finalUrl: new URL('https://docs.example.test/guide'), contentType: 'text/html' })
const code = (text: string, language = 'ts') => `<pre data-language="${language}"><code>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>`
const tabs = (panels: string[], attributes = '', prefix = 'example') => `<div ${attributes}><div role="tablist">${panels.map((_value, index) => `<button role="tab" id="${prefix}-tab-${index}" aria-controls="${prefix}-panel-${index}">${['Standard', 'Compact'][index]}</button>`).join('')}</div>${panels.map((value, index) => `<div role="tabpanel" id="${prefix}-panel-${index}" aria-labelledby="${prefix}-tab-${index}"${index ? ' hidden' : ''}>${value}</div>`).join('')}</div>`

function flight(source: string, split = 0): string {
  const stream = `0:["$","$L10",null,{"children":["$","$L11",null,{"content":"$3"}]}]\n10:I[1,[],"PageArticle"]\n11:I[2,[],"CopyMarkdownButton"]\n3:T${Buffer.byteLength(source).toString(16)},${source}4:[]\n`
  const chunks = split ? [stream.slice(0, split), stream.slice(split)] : [stream]
  return chunks.map(chunk => `<script>self.__next_f.push(${JSON.stringify([1, chunk]).replace(/</g, '\\u003c')})</script>`).join('')
}

describe('complete captured tabs across documentation themes', () => {
  it.each(['class="fumadocs-tabs"', 'class="tabs-container"', 'class="tabs tab-container"', 'data-custom-docs-tabs'])('retains labeled code and prose variants for %s', async attributes => {
    const body = `<article><h1>Guide</h1>${tabs([`${code('const answer = 42;')}<p>Standard <strong>usage</strong>.</p>`, `${code('const answer = compact(42);', 'javascript')}<p>Compact <em>usage</em>.</p>`], attributes)}</article>`
    const normalized = migrationHtmlArticle(body)
    expect(normalized.root.find('[role="tab"]').length).toBe(0)
    expect(normalized.root.find('[data-thally-static-tab]').length).toBe(2)
    const page = htmlPage(document(body), 'guide', { preserveAnchors: true, omitDocumentHeading: true }).page!
    expect(page.body).toContain('<Tab title="Standard">')
    expect(page.body).toContain('<Tab title="Compact">')
    expect(page.body).toContain('Standard **usage**.')
    expect(page.body).toContain('Compact _usage_.')
    expect(page.body).toContain('```ts\nconst answer = 42;')
    expect(page.body).toContain('```javascript\nconst answer = compact(42);')
    expect(page.body).toContain('<a id="example-tab-1" />')
    expect(page.body).toContain('<a id="example-panel-1" />')
    expect(sanitizeRemoteMarkdown(page.body.replace(/^<a id="[^"<]*" \/>$/gm, ''))).not.toBeNull()
    await compile(page.body)
  })

  it.each([
    ['empty hidden panel', (body: string) => body.replace(code('compact()'), '')],
    ['busy panel itself', (body: string) => body.replace('id="example-panel-1"', 'aria-busy="true" id="example-panel-1"')],
    ['busy panel child', (body: string) => body.replace(code('compact()'), '<span role="progressbar"></span>')],
    ['empty code shell', (body: string) => body.replace(code('compact()'), '<pre><code></code></pre>')],
    ['duplicate panel ID', (body: string) => body.replace('</article>', '<div id="example-panel-1">Unrelated content</div></article>')],
    ['duplicate tab ID', (body: string) => body.replace('</article>', '<div id="example-tab-1">Unrelated control</div></article>')],
    ['wrong reciprocal label', (body: string) => body.replace('aria-labelledby="example-tab-1"', 'aria-labelledby="example-tab-0"')],
    ['reused panel', (body: string) => body.replace('aria-controls="example-panel-1"', 'aria-controls="example-panel-0"')],
    ['unclaimed panel', (body: string) => body.replace('</article>', '<div role="tabpanel">Unclaimed alternative</div></article>')],
  ])('keeps %s reviewable', (_name, change) => {
    const original = `<article><h1>Guide</h1>${tabs([code('standard()'), code('compact()')])}</article>`
    const { root } = migrationHtmlArticle(change(original))
    // An unrelated panel outside the exact group does not invalidate that group.
    if (_name === 'unclaimed panel') expect(root.find('[data-thally-static-tab]').length).toBe(2)
    else expect(root.find('[role="tab"]').length).toBe(2)
  })

  it('does not trust forged static projection markers', () => {
    const body = '<article><h1>Guide</h1><div data-thally-static-tabs><p>Required surrounding prose.</p><div data-thally-static-tab="forged">Payload</div></div></article>'
    const page = htmlPage(document(body), 'guide').page!
    expect(page.body).toContain('Required surrounding prose.')
    expect(page.body).toContain('Payload')
    expect(page.body).not.toContain('<Tabs>')
  })

  it('keeps authored sibling prose, links and examples in their original order', () => {
    const group = tabs([code('standard()'), code('compact()')])
      .replace('<div >', '<div ><p>Required warning before.</p><a href="/reference">Reference</a>')
      .replace(/<\/div>$/, `${code('afterword()', 'sh')}<p>Required afterword.</p></div>`)
    const body = `<article><h1>Guide</h1>${group}</article>`
    const { root } = migrationHtmlArticle(body)
    expect(root.find('[role="tab"]').length).toBe(0)
    const page = htmlPage(document(body), 'guide', { omitDocumentHeading: true }).page!
    expect(page.body).not.toContain('<Tabs>')
    const expected = ['Required warning before.', '[Reference](https://docs.example.test/reference)', '**Standard**', 'standard()', '**Compact**', 'compact()', 'afterword()', 'Required afterword.']
    const positions = expected.map(value => page.body.indexOf(value))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('preserves fully loaded closed disclosures and leaves empty disclosures visible', () => {
    const body = '<article><h1>Guide</h1><details><summary>Full details</summary><p>Full hidden content.</p></details><details><summary>Deferred details</summary></details></article>'
    const { root } = migrationHtmlArticle(body)
    expect(root.find('details').length).toBe(2)
    const page = htmlPage(document(body), 'guide').page!
    expect(page.body).toContain('Full details')
    expect(page.body).toContain('Full hidden content.')
    expect(page.body).toContain('Deferred details')
  })

  it('exposes a fully loaded ARIA disclosure while preserving its label and anchors', () => {
    const body = '<article><h1>Guide</h1><div><h3><button id="control" aria-expanded="false" aria-controls="region">Complete explanation</button></h3><div role="region" id="region" aria-labelledby="control" hidden><p>Required content.</p></div></div></article>'
    const { root } = migrationHtmlArticle(body)
    expect(root.find('button[aria-expanded]').length).toBe(0)
    expect(root.find('[id="region"]').attr('hidden')).toBeUndefined()
    const page = htmlPage(document(body), 'guide', { preserveAnchors: true }).page!
    expect(page.body).toContain('Complete explanation')
    expect(page.body).toContain('Required content.')
    expect(page.body).toContain('<a id="control" />')
  })

  it.each([
    '<div role="region" id="region" aria-labelledby="control"></div>',
    '<div role="region" id="region" aria-labelledby="other"><p>Wrong owner</p></div>',
    '<div role="region" id="region"><p>First</p></div><div id="region">Duplicate</div>',
    '<div role="region" id="region" aria-busy="true"><p>Loading</p></div>',
  ])('keeps unresolved native disclosure controls reviewable: %s', panel => {
    const { root } = migrationHtmlArticle(`<article><h1>Guide</h1><div><button id="control" aria-expanded="false" aria-controls="region">Details</button>${panel}</div></article>`)
    expect(root.find('button[aria-expanded]').length).toBe(1)
  })
})

describe('root-owned serialized article content', () => {
  const element = (name: string, props: Record<string, unknown>) => ['$', name, null, props]
  const block = (text: string, language?: string) => element('$L13', { ...(language ? { language } : {}), children: element('pre', { children: element('code', { children: text }) }) })
  const group = (compact: unknown = block('compact()', 'js')) => element('$L11', { items: ['Standard', 'Compact'], children: [element('$L12', { value: 'Standard', children: block('standard()', 'ts') }), element('$L12', { value: 'Compact', children: compact })] })
  const transport = (content: unknown[], root = true) => {
    const article = element('article', { children: [element('h1', { children: element('$90', { children: 'Guide' }) }), element('p', { children: 'Authored context.' }), ...content] })
    const stream = `${root ? '0' : '99'}:${JSON.stringify(article)}\n90:"$Sreact.fragment"\n11:I[1,[],"Tabs"]\n12:I[2,[],"Tab"]\n13:I[3,[],"CodeBlock"]\n14:I[4,[],"Accordion"]\n15:I[5,[],"UnknownWidget"]\n`
    return `<script>self.__next_f.push(${JSON.stringify([1, stream]).replace(/</g, '\\u003c')})</script>`
  }
  const body = `<article><h1>Guide</h1><p>Authored context.</p>${tabs([code('standard()', ''), ''])}</article>`

  it('recovers complete literal alternatives and explicit metadata from the rendered article tree', async () => {
    const html = body + transport([group()])
    const { root } = migrationHtmlArticle(html)
    expect(root.find('[role="tab"]').length).toBe(0)
    expect(root.find('pre').length).toBe(2)
    expect(root.find('pre').eq(0).attr('data-language')).toBe('ts')
    expect(root.find('pre').eq(1).attr('data-language')).toBe('js')
    const page = htmlPage(document(html), 'guide').page!
    expect(page.body).toContain('```js\ncompact()')
    await compile(page.body)
  })

  it.each([
    transport([group()], false),
    transport([group()]).replace('Authored context.', 'Unrelated context.'),
    transport([group(element('$L15', { children: block('compact()') }))]),
    transport([group(element('p', { children: 'Required prose around the example.' }))]),
  ])('keeps deferred tabs unresolved without a complete exact static proof', source => {
    const { root } = migrationHtmlArticle(body + source)
    expect(root.find('[role="tab"]').length).toBe(2)
    expect(root.find('pre').length).toBe(1)
  })

  it('recovers loaded disclosure prose and literal code without running component code', () => {
    const source = transport([element('$L14', { title: 'Details', children: [element('p', { children: 'Complete explanation.' }), block('literal <script>{payload}</script>', 'html')] })])
    const html = '<article><h1>Guide</h1><p>Authored context.</p><div><h3><button id="control" aria-expanded="false" aria-controls="region">Details</button></h3><div id="region" role="region" aria-labelledby="control" hidden></div></div></article>' + source
    const { root } = migrationHtmlArticle(html)
    expect(root.find('button[aria-expanded]').length).toBe(0)
    expect(root.find('pre').text()).toBe('literal <script>{payload}</script>')
    expect(root.find('script').length).toBe(0)
    const page = htmlPage(document(html), 'guide').page!
    expect(page.body).toContain('Complete explanation.')
    expect(page.body).toContain('literal <script>{payload}</script>')
  })

  it.each([
    { 'aria-busy': true },
    { options: ['unsupported'] },
    { dangerouslySetInnerHTML: { __html: 'Required content' } },
    { id: 'authored-code-anchor' },
  ])('keeps semantic code-only tab wrappers unresolved: %s', props => {
    for (const wrapper of ['div', 'figure']) {
      const source = transport([group(element(wrapper, { ...props, children: block('partialLoadingCode()') }))])
      const { root } = migrationHtmlArticle(body + source)
      expect(root.find('[role="tab"]').length).toBe(2)
      expect(root.find('pre').text()).not.toContain('partialLoadingCode()')
    }
  })

  it('keeps unknown, executable and foreign drawing disclosure children unresolved', () => {
    for (const content of [element('$L15', { children: 'Required unknown component.' }), element('script', { children: 'execute()' }), element('svg', { children: element('foreignObject', { children: element('p', { children: 'Foreign HTML' }) }) })]) {
      const source = transport([element('$L14', { title: 'Details', children: content })])
      const { root } = migrationHtmlArticle('<article><h1>Guide</h1><p>Authored context.</p><div><button id="control" aria-expanded="false" aria-controls="region">Details</button><div id="region" role="region" aria-labelledby="control" hidden></div></div></article>' + source)
      expect(root.find('button[aria-expanded]').length).toBe(1)
      expect(root.find('[id="region"]').text()).toBe('')
    }
  })

  it('rejects deeply nested frame JSON before parsing and bounds cyclic references', () => {
    const nested = '['.repeat(10_000) + '0' + ']'.repeat(10_000)
    const frame = `0:${nested}\n`
    const $ = load(`<script>self.__next_f.push(${JSON.stringify([1, frame])})</script>`)
    expect(readMigrationFlightDocument($)?.records.get('0')).toBeUndefined()
    const cyclic = transport([group('$91')]) + `<script>self.__next_f.push(${JSON.stringify([1, '91:"$92"\n92:"$91"\n'])})</script>`
    const { root } = migrationHtmlArticle(body + cyclic)
    expect(root.find('[role="tab"]').length).toBe(2)
  })

  it('binds every authored heading and visible code before recovering any alternative', () => {
    const html = body.replace('<div >', `<h2>Real topic</h2>${code('realVisibleCode()', '')}<div >`)
    for (const content of [
      [element('h2', { children: 'Wrong topic' }), block('realVisibleCode()'), group(block('poison()'))],
      [element('h2', { children: 'Real topic' }), block('wrongVisibleCode()'), group(block('poison()'))],
    ]) {
      const { root } = migrationHtmlArticle(html + transport(content))
      expect(root.find('[role="tab"]').length).toBe(2)
      expect(root.find('pre').text()).not.toContain('poison()')
    }
  })

  it('does not treat article-shaped tuples in metadata as rendered ownership', () => {
    const source = transport([group(block('poison()'))])
    const script = load(source)('script').text()
    const envelope = JSON.parse(script.slice('self.__next_f.push('.length, -1))
    const newline = envelope[1].indexOf('\n')
    const article = JSON.parse(envelope[1].slice(2, newline))
    envelope[1] = `0:${JSON.stringify({ options: article })}${envelope[1].slice(newline)}`
    const { root } = migrationHtmlArticle(body + `<script>self.__next_f.push(${JSON.stringify(envelope)})</script>`)
    expect(root.find('[role="tab"]').length).toBe(2)
    expect(root.find('pre').text()).not.toContain('poison()')
  })

  const disclosureHtml = '<article><h1>Guide</h1><p>Authored context.</p><div><h3><button id="control" aria-expanded="false" aria-controls="region">Details</button></h3><div id="region" role="region" aria-labelledby="control" hidden></div></div></article>'
  const extraFrame = (frame: string) => `<script>self.__next_f.push(${JSON.stringify([1, frame]).replace(/</g, '\\u003c')})</script>`

  it.each(['$99', '$91'])('keeps partial disclosure children unresolved for missing or cyclic reference %s', reference => {
    const content = element('$L14', { title: 'Details', children: [element('p', { children: 'Only the first fragment.' }), reference] })
    const { root } = migrationHtmlArticle(disclosureHtml + transport([content]) + extraFrame('91:"$92"\n92:"$91"\n'))
    expect(root.find('button[aria-expanded]').length).toBe(1)
    expect(root.find('[id="region"]').text()).toBe('')
  })

  it('preserves responsive image choices through the normal image pipeline', () => {
    const content = element('$L14', { title: 'Details', children: element('img', { src: '/small.png', srcSet: '/large.png 2x', sizes: '100vw', alt: 'Responsive diagram' }) })
    const { root } = migrationHtmlArticle(disclosureHtml + transport([content]))
    expect(root.find('[id="region"] img').attr('srcset')).toBe('/large.png 2x')
    expect(root.find('[id="region"] img').attr('sizes')).toBe('100vw')
    expect(root.find('button[aria-expanded]').length).toBe(0)
  })

  it.each([
    element('ol', { start: 3, children: element('li', { children: 'Third item' }) }),
    element('li', { value: 5, children: 'Fifth item' }),
    element('td', { colSpan: 2, children: 'Combined cells' }),
    element('$L13', { options: ['unsupported'], children: 'code()' }),
    element('$L11', { items: ['Standard', 'Compact'], options: ['unsupported'], children: [] }),
  ])('keeps unsupported meaningful native or component props reviewable', content => {
    const { root } = migrationHtmlArticle(disclosureHtml + transport([element('$L14', { title: 'Details', children: content })]))
    expect(root.find('button[aria-expanded]').length).toBe(1)
    expect(root.find('[id="region"]').text()).toBe('')
  })

  it('bounds repeated resolved text and attribute bytes before rendering', () => {
    for (const fragment of [element('p', { children: 'z'.repeat(16_000) }), element('img', { src: '/image.png', alt: 'z'.repeat(16_000) })]) {
      const source = transport([element('$L14', { title: 'Details', children: Array(1_000).fill('$20') })])
        + extraFrame(`20:${JSON.stringify(fragment)}\n`)
      const { root } = migrationHtmlArticle(disclosureHtml + source)
      expect(root.find('button[aria-expanded]').length).toBe(1)
      expect(root.find('[id="region"]').children().length).toBe(0)
    }
  })

  it('shares its output budget across all disclosure projections', () => {
    const count = 90
    const panels = Array.from({ length: count }, (_value, index) => `<div><button id="control-${index}" aria-expanded="false" aria-controls="region-${index}">Details ${index}</button><div id="region-${index}" role="region" aria-labelledby="control-${index}" hidden></div></div>`).join('')
    const source = transport(Array.from({ length: count }, (_value, index) => element('$L14', { title: `Details ${index}`, children: '$20' })))
      + extraFrame(`20:${JSON.stringify(element('img', { src: '/image.png', alt: 'z'.repeat(100_000) }))}\n`)
    const { root } = migrationHtmlArticle(`<article><h1>Guide</h1><p>Authored context.</p>${panels}</article>${source}`)
    expect(root.find('button[aria-expanded]').length).toBe(count)
    expect(root.find('img').length).toBe(0)
  })
})

describe('inert embedded article source', () => {
  const source = '# Guide\n\nimport { Tabs, Tab } from "publisher/tabs";\n\n## Examples\n\n<Tabs items={["Standard", "Compact"]}>\n<Tab value="Standard">\n```ts\nconst name = "résumé";\n```\n</Tab>\n<Tab value="Compact">\n```tsx\nconst name = "résumé";\n<Literal>{payload}</Literal>\n```\n</Tab>\n</Tabs>\n\n```json\n{"complete":true}\n```'
  const article = `<article><h1>Guide</h1><h2>Examples</h2>${tabs([code('const name = "résumé";', ''), ''])}${code('{"complete":true}', '')}</article>`

  it.each([0, 10, 120, 280])('recovers missing code and explicit languages across Flight split %i', async split => {
    const body = article + flight(source, split)
    const { root } = migrationHtmlArticle(body)
    expect(root.find('[role="tab"]').length).toBe(0)
    expect(root.find('pre').length).toBe(3)
    expect(root.find('pre[data-language]').length).toBe(3)
    const page = htmlPage(document(body), 'guide', { preserveAnchors: true, omitDocumentHeading: true }).page!
    expect(page.body).toContain('```ts\nconst name = "résumé";')
    expect(page.body).toContain('```tsx\nconst name = "résumé";\n<Literal>{payload}</Literal>')
    expect(page.body).toContain('```json\n{"complete":true}')
    expect(page.body).not.toContain('import { Tabs')
    expect(sanitizeRemoteMarkdown(page.body.replace(/^<a id="[^"<]*" \/>$/gm, ''))).not.toBeNull()
    await compile(page.body)
  })

  it.each([
    ['different heading', (value: string) => value.replace('# Guide', '# Other')],
    ['different visible payload', (value: string) => value.replace('const name = "résumé";', 'const changed = true;')],
    ['different tab label', (value: string) => value.replace('value="Compact"', 'value="Other"')],
    ['dynamic label', (value: string) => value.replace('value="Compact"', 'value={"Compact"}')],
    ['dynamic contents', (value: string) => value.replace('<Literal>{payload}</Literal>', '```\n{dangerous()}\n```tsx')],
    ['extra prose in alternative', (value: string) => value.replace('<Tab value="Compact">', '<Tab value="Compact">\nRequired description.\n')],
  ])('does not excuse missing alternatives with %s', (_name, transform) => {
    const { root } = migrationHtmlArticle(article + flight(transform(source)))
    expect(root.find('[role="tab"]').length).toBe(2)
    expect(root.find('pre').length).toBe(2)
  })

  it('rejects ambiguous article sources and nonliteral transport calls', () => {
    for (const transport of [flight(source) + flight(source.replace('```tsx', '```jsx')),
      flight(source).replace('self.__next_f.push(', 'globalThis.execute(); self.__next_f.push('),
      flight(source).replace(/3:T[a-f\d]+,/, '3:Tffffffff,')]) {
      const { root } = migrationHtmlArticle(article + transport)
      expect(root.find('[role="tab"]').length).toBe(2)
    }
  })

  it('rejects unreferenced text records, copy controls outside an article, and conflicting prose', () => {
    for (const transport of [
      flight(source).replace('$3', '$99'),
      flight(source).replace('PageArticle', 'UnrelatedCard'),
      flight(source.replace('## Examples', 'Unrelated prose from another article.\n\n## Examples')),
    ]) {
      const { root } = migrationHtmlArticle(article + transport)
      expect(root.find('[role="tab"]').length).toBe(2)
      expect(root.find('pre').length).toBe(2)
    }
  })

  it('uses exact Shiki blank-line placeholders for matching without rewriting visible code', () => {
    const visible = '<pre><code><span class="line">first()</span>\n<span class="line"> </span>\n<span class="line">last()</span></code></pre>'
    const source = '# Guide\n\n```js\nfirst()\n\nlast()\n```'
    const { $, root } = migrationHtmlArticle(`<article><h1>Guide</h1>${visible}</article>${flight(source)}`)
    expect(root.find('pre').attr('data-language')).toBe('js')
    expect($('pre').text()).toBe('first()\n \nlast()')
    const changed = migrationHtmlArticle(`<article><h1>Guide</h1>${visible.replace('<span class="line"> </span>', '<span class="line"><span> </span></span>')}</article>${flight(source)}`)
    expect(changed.root.find('pre').attr('data-language')).toBeUndefined()
  })

  it('leaves ambiguous language declarations unset for repeated identical payloads', () => {
    const source = '# Guide\n\n```js\nshared()\n```\n\n```ts\nshared()\n```'
    const { root } = migrationHtmlArticle(`<article><h1>Guide</h1>${code('shared()', '')}</article>${flight(source)}`)
    expect(root.find('pre').attr('data-language')).toBe('')
  })

  it('binds GFM tables, explicit heading IDs and Shiki editorial directives without changing visible code', () => {
    const source = '# Guide\n\n## Topic [#topic]\n\n| Name | Value |\n| --- | --- |\n| Mode | Strict |\n\n```ts\nconst mode = "strict"; // [!code ++]\n\n\n```'
    const html = '<article><h1>Guide</h1><h2 id="topic">Topic</h2><table><tr><th>Name</th><th>Value</th></tr><tr><td>Mode</td><td>Strict</td></tr></table><pre><code><span class="line diff add">const mode = "strict"; </span></code></pre></article>'
    const { root } = migrationHtmlArticle(html + flight(source))
    expect(root.find('pre').attr('data-language')).toBe('ts')
    expect(root.find('pre').text()).toBe('const mode = "strict"; ')
    for (const changed of [html.replace('id="topic"', 'id="other"'), html.replace('const mode = "strict";', 'const mode = "loose";')]) {
      expect(migrationHtmlArticle(changed + flight(source)).root.find('pre').attr('data-language')).toBeUndefined()
    }
  })

  it('selects owned text through framing even when unrelated records exceed 256', () => {
    const frames = Array.from({ length: 300 }, (_value, index) => `${(4096 + index).toString(16)}:T1,x`).join('')
    const transport = `<script>self.__next_f.push(${JSON.stringify([1, frames])})</script>`
    const { root } = migrationHtmlArticle(article + flight(source) + transport)
    expect(root.find('[role="tab"]').length).toBe(0)
    expect(root.find('pre').length).toBe(3)
  })
})

describe('passive inline SVG projection', () => {
  const svg = '<svg viewBox="0 0 200 80" role="img" aria-labelledby="diagram-title"><title id="diagram-title">System overview</title><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path fill="url(#paint)" d="M0 0h200v80z"/><text x="10" y="20">Client → API</text></svg>'

  it('copies complete static drawings with accessible labels and source anchors', () => {
    const { root, assets } = migrationHtmlArticle(`<article><h1>Guide</h1>${svg}</article>`)
    expect(root.find('svg').length).toBe(0)
    expect(root.find('img').attr('alt')).toBe('System overview')
    expect(assets).toHaveLength(1)
    expect(assets[0].path).toMatch(/^migration-assets\/[a-f\d]{64}\.svg$/)
    expect(isPassiveSvg(assets[0].content)).toBe(true)
    expect(load(Buffer.from(assets[0].content).toString(), { xmlMode: true })('text').text()).toBe('Client → API')
    expect(Buffer.from(assets[0].content).toString()).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it.each([
    '<script>alert(1)</script><path d="M0 0"/>',
    '<path onclick="alert(1)" d="M0 0"/>',
    '<foreignObject><div>HTML diagram</div></foreignObject>',
    '<style>@import "https://external.test/x.css"</style><path d="M0 0"/>',
    '<use href="https://external.test/drawing.svg#icon"/>',
    '<path fill="url(https://external.test/drawing.svg#paint)" d="M0 0"/>',
  ])('keeps unsupported or active SVG reviewable before cleanup: %s', unsafe => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg">${unsafe}</svg>`
    expect(projectMigrationSvg(source)).toBeNull()
    const { root, assets } = migrationHtmlArticle(`<article><h1>Guide</h1>${source}</article>`)
    expect(root.find('svg').length).toBe(1)
    expect(assets).toEqual([])
  })

  it('includes deduplicated SVG bytes in the direct URL bundle', async () => {
    const bundle = await migrateUrl({ sourceUrl: 'https://docs.example.test/guide', fetcher: async url => {
      if (url.pathname !== '/guide') throw Error('Absent')
      return document(`<article><h1>Guide</h1><p>Diagram description.</p>${svg}${svg}</article>`)
    } })
    expect(bundle.assets).toHaveLength(1)
    expect(bundle.pages[0].body).toContain(`](/${bundle.assets[0].path})`)
    expect(bundle.pages[0].body).not.toContain(`https://docs.example.test/${bundle.assets[0].path}`)
  })
})

describe('literal protected-email projection', () => {
  const encode = (email: string, key: number) => Buffer.from([key, ...Buffer.from(email).map(byte => byte ^ key)]).toString('hex')

  it('restores identical email text and destinations across randomized provider keys', () => {
    const normalized = [17, 203].map(key => migrationHtmlArticle(`<article><h1>Guide</h1><a href="/cdn-cgi/l/email-protection" data-cfemail="${encode('hello@example.test', key)}">[email&#160;protected]</a></article>`).root.html())
    expect(normalized[0]).toBe(normalized[1])
    expect(normalized[0]).toContain('href="mailto:hello@example.test"')
    expect(normalized[0]).toContain('>hello@example.test</a>')
  })

  it('preserves authored custom labels and nested protected spans', () => {
    const encoded = encode('hello@example.test', 31)
    const body = `<article><h1>Guide</h1><a href="/cdn-cgi/l/email-protection#${encoded}" data-cfemail="${encoded}">Contact support</a><a href="/cdn-cgi/l/email-protection"><span data-cfemail="${encoded}">[email protected]</span></a></article>`
    const { root } = migrationHtmlArticle(body)
    expect(root.find('a').toArray().map(node => root.find('a').filter((_index, element) => element === node).text())).toEqual(['Contact support', 'hello@example.test'])
    expect(root.find('a').eq(0).attr('href')).toBe('mailto:hello@example.test')
    expect(root.find('a').eq(1).attr('href')).toBe('mailto:hello@example.test')
  })

  it.each(['hello@example.test?subject=Injected', 'hello@example.test\r\nBcc:other@example.test', '<script>@example.test', 'hello@example'])('does not reinterpret malformed encoded destinations: %s', email => {
    const { root } = migrationHtmlArticle(`<article><h1>Guide</h1><a href="/cdn-cgi/l/email-protection" data-cfemail="${encode(email, 43)}">[email protected]</a></article>`)
    expect(root.find('a').attr('href')).toBe('/cdn-cgi/l/email-protection')
    expect(root.find('a').text()).toBe('[email protected]')
  })
})

describe('local documentation response bound', () => {
  it('reads long HTML through the same 8 MB bound as resumable captures', async () => {
    const response = new Response('x'.repeat(2_000_001), { headers: { 'Content-Type': 'text/html' } })
    Object.defineProperty(response, 'url', { value: 'https://docs.example.test/guide' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    try {
      const result = await defaultMigrationFetcher(new URL('https://docs.example.test/guide'), { accept: 'text/html' })
      expect(result.body).toHaveLength(2_000_001)
    } finally { fetch.mockRestore() }
  })

  it('rejects oversized streamed responses without trusting Content-Length', async () => {
    const response = new Response('x'.repeat(8_000_001))
    Object.defineProperty(response, 'url', { value: 'https://docs.example.test/guide' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    try {
      await expect(defaultMigrationFetcher(new URL('https://docs.example.test/guide'), { accept: 'text/html' })).rejects.toThrow('8 MB import limit')
    } finally { fetch.mockRestore() }
  })
})
