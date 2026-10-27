/** Public runtime integration: field anchors agree across the renderer, the core helper and the portable checker. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluate } from '@mdx-js/mdx'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import { describe, expect, it, vi } from 'vitest'

import { builtinMdxComponents } from '@/components/mdx/builtin-components'
import { PageSlotsProvider } from '@/components/mdx/page-slots'
import { componentIds as coreComponentIds, constantString as coreConstantString, fieldAnchorBase as coreBase, fieldAnchorName as coreName, numberFieldIds as coreNumber, numberHeadingIds as coreNumberHeadings, uniqueFieldId as coreUnique } from '../../packages/core/src/slugify'
import { extractHeadingAnchors, runCheck } from '../../packages/create-thally-docs/src/check'
import { componentIds, constantString, fieldAnchorBase, fieldAnchorName, numberFieldIds, numberHeadingIds, uniqueFieldId } from '../lib/field-anchor'
import { rehypePlugins } from './rehype'
import { remarkPlugins } from './remark'

async function brokenAnchorOutput(body: string, link: string): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-field-ids-'))
  mkdirSync(join(projectDir, 'src/content'), { recursive: true })
  writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Docs', pages: ['introduction'] }] }))
  writeFileSync(
    join(projectDir, 'src/content/introduction.mdx'),
    `---\ntitle: Intro\ndescription: Introduction page.\n---\n\n${body}\n\nThis page has enough prose to avoid the short body notice. [Jump](#${link})`,
  )
  const output: Array<string> = []
  const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
  try {
    await runCheck(projectDir, { fix: false, ci: true })
  } finally {
    log.mockRestore()
  }
  return output.join('\n')
}

/** Every `id` the renderer gives the compiled page, in document order. */
async function renderedIds(source: string): Promise<Array<string>> {
  const { compile } = await import('@mdx-js/mdx')
  const compiled = String(await compile(source, { rehypePlugins: [rehypePlugins[2]] }))
  return [...compiled.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1])
}

/** Every `id` in the HTML the page renders with the built-in components, in document order (a React-generated one reads `_R_0_`). */
async function renderedHtmlIds(source: string): Promise<Array<string>> {
  const { default: Content } = await evaluate(source, { ...jsxRuntime, remarkPlugins, rehypePlugins } as never)
  const html = renderToStaticMarkup(createElement(PageSlotsProvider, null, createElement(Content, { components: builtinMdxComponents })))
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
}

describe('the runtime helpers read a field as @thallylabs/core does', () => {
  it.each([
    'expiresInDays', 'data-attribution-model', 'GitHub', '--root-key', 'Workspace name', 'API ID', 'ratelimits[].name',
    'latency_p75', 'integrations.ga4', 'variables.[variableName]', '<custom>', 'userID', 'APIKey', 'IDs', 'a1B', 'café', 'Überblick', '日本語 API', '---', '',
  ])('names %j the same way', (name) => {
    expect(fieldAnchorBase(name)).toBe(coreBase(name))
  })

  it('numbers repeats and skips used ids the same way', () => {
    const bases = ['param-a', 'param-a', 'param-b', 'param-a', 'param-a-1', 'param-a']
    const runtime = new Set(['param-b-1'])
    const core = new Set(['param-b-1'])
    expect(bases.map((base) => uniqueFieldId(base, runtime))).toEqual(bases.map((base) => coreUnique(base, core)))
  })

  it('numbers headings the same way', () => {
    const targets = [
      { base: 'a', explicit: false }, { base: 'a', explicit: false }, { base: 'a-2', explicit: true }, { base: '', explicit: false },
      { base: 'b', explicit: true }, { base: 'b', explicit: true }, { base: 'a', explicit: false },
    ]
    expect(numberHeadingIds(targets)).toEqual(coreNumberHeadings(targets))
  })

  it('reserves authored ids before it numbers the fields the same way', () => {
    const bases = ['param-a', 'param-a', 'param-b', 'param-a']
    const authored = ['param-a-1', 'param-b']
    expect(numberFieldIds(bases, new Set(['param-a']), authored)).toEqual(coreNumber(bases, new Set(['param-a']), authored))
  })

  it.each([
    ['Accordion', { title: 'Param name' }],
    ['Accordion', { title: 'Run `init` first', id: 'mine' }],
    ['Accordion', { title: '日本語' }],
    ['Accordion', { title: null, id: null }],
    ['Accordion', {}],
    ['Update', { label: 'v1.0', date: '2024-01-01' }],
    ['Update', { label: '日本語', date: '2024-01-01' }],
    ['Update', { label: 'Param name', id: 'mine' }],
    ['Update', { label: null, date: null }],
    ['Card', { title: 'Param name', id: 'mine' }],
  ])('lists the ids %s %j renders the same way', (tag, values: Record<string, string | null>) => {
    expect(componentIds(tag, (name) => values[name])).toEqual(coreComponentIds(tag, (name) => values[name]))
  })

  it.each([
    ['a string literal', { data: { estree: { body: [{ type: 'ExpressionStatement', expression: { type: 'Literal', value: 'Param name' } }] } } }],
    ['a template literal with no expression', { data: { estree: { body: [{ type: 'ExpressionStatement', expression: { type: 'TemplateLiteral', expressions: [], quasis: [{ value: { cooked: 'Param name' } }] } }] } } }],
    ['a template literal with an expression', { data: { estree: { body: [{ type: 'ExpressionStatement', expression: { type: 'TemplateLiteral', expressions: [{ type: 'Identifier' }], quasis: [{ value: { cooked: 'a' } }, { value: { cooked: '' } }] } }] } } }],
    ['a number', { data: { estree: { body: [{ type: 'ExpressionStatement', expression: { type: 'Literal', value: 1 } }] } } }],
    ['a comment, which has no statement', { data: { estree: { body: [] } } }],
    ['a node with no syntax tree', {}],
    ['nothing', undefined],
  ])('reads %s as a constant string the same way', (_name, node) => {
    expect(constantString(node)).toBe(coreConstantString(node))
  })

  it('reads the same attribute of each tag', () => {
    const values: Record<string, string | null | undefined> = { name: 'n', body: 'b', path: null, query: '' }
    for (const tag of ['ParamField', 'ResponseField', 'Other']) {
      expect(fieldAnchorName(tag, (name) => values[name])).toBe(coreName(tag, (name) => values[name]))
    }
  })
})

describe('field ids on a rendered page', () => {
  // Read from https://dub.co/docs/sdks/client-side/introduction: a field nested in an Expandable keeps its own id.
  it('gives a nested field the id Mintlify serves for it', async () => {
    const source = [
      '<ParamField body="data-cookie-options" type="JSON-stringified object">',
      '  Custom properties.',
      '',
      '  <Expandable title="properties">',
      '    <ParamField body="domain" type="string">The domain.</ParamField>',
      '    <ParamField body="expiresInDays" type="integer">Days.</ParamField>',
      '  </Expandable>',
      '</ParamField>',
    ].join('\n')
    expect(await renderedIds(source)).toEqual(['param-data-cookie-options', 'param-domain', 'param-expires-in-days'])
  })

  // Read from https://www.unkey.com/docs/api-management/keys/looking-up-keys: the repeat is `-1`, and a ResponseField shares the numbering.
  it('numbers a repeated name -1, -2 across ParamField and ResponseField', async () => {
    const source = [
      '<ParamField body="keyId" type="string">One.</ParamField>',
      '## Response fields',
      '<ResponseField name="keyId" type="string">Two.</ResponseField>',
      '<ResponseField name="key_id" type="string">Three.</ResponseField>',
      '<ParamField path="Workspace name">Four.</ParamField>',
      '<ResponseField name="pagination.hasMore">Five.</ResponseField>',
    ].join('\n\n')
    expect(await renderedIds(source)).toEqual([
      'param-key-id', 'response-fields', 'param-key-id-1', 'param-key-id-2', 'param-workspace-name', 'param-pagination-has-more',
    ])
  })

  it('leaves a heading its own id when a field would take the same one, wherever each sits on the page', async () => {
    const heading = '## Param name\n\nText.'
    const field = '<ParamField body="name" type="string">The name.</ParamField>'
    expect(await renderedIds(`${heading}\n\n${field}`)).toEqual(['param-name', 'param-name-1'])
    expect(await renderedIds(`${field}\n\n${heading}`)).toEqual(['param-name-1', 'param-name'])
  })

  it('keeps an id the author gave a field, which the other fields skip, and shifts no heading', async () => {
    const source = [
      '<ParamField body="x" id="param-y">One.</ParamField>',
      '<ParamField body="y">Two.</ParamField>',
      '## Mine',
    ].join('\n\n')
    expect(await renderedIds(source)).toEqual(['param-y', 'param-y-1', 'mine'])
  })

  it('keeps an id the author gave a field as written, even when a heading has it, and shifts no heading', async () => {
    const source = '## Param name\n\n<ParamField body="x" id="param-name">One.</ParamField>\n\n<ParamField body="name">Two.</ParamField>'
    expect(await renderedIds(source)).toEqual(['param-name', 'param-name', 'param-name-1'])
  })

  it('skips the id of a plain-text Step, which renders no heading', async () => {
    const source = [
      '<Steps titleSize="p">',
      '  <Step title="One" id="param-name">Text.</Step>',
      '</Steps>',
      '',
      '<ParamField body="name" type="string">The name.</ParamField>',
    ].join('\n')
    expect(await renderedIds(source)).toEqual(['param-name', 'param-name-1'])
  })

  it('skips an id authored on any other element, whether it comes before or after the field', async () => {
    const card = '<Card title="Card" id="param-name">Text.</Card>'
    const div = '<div id="param-name-1">Text.</div>'
    const field = '<ParamField body="name" type="string">The name.</ParamField>'
    expect(await renderedIds(`${field}\n\n${card}\n\n${div}`)).toEqual(['param-name-2', 'param-name', 'param-name-1'])
  })

  it('shifts no heading when an id is authored elsewhere on the page', async () => {
    const source = '<Card title="Card" id="mine" />\n\n## Mine\n\n<ParamField body="mine">Own.</ParamField>'
    expect(await renderedIds(source)).toEqual(['mine', 'mine', 'param-mine'])
  })

  it('gives none to a field with no literal name', async () => {
    const source = [
      '<ParamField type="string">No name.</ParamField>',
      '<ParamField body={name}>Expression.</ParamField>',
      '<ResponseField name="">Empty.</ResponseField>',
    ].join('\n\n')
    expect(await renderedIds(source)).toEqual([])
  })
})

describe('field ids when an attribute is a string written in braces', () => {
  const field = '<ParamField body="name" type="string">The name.</ParamField>'

  it('reads a field name written in braces as the string it is', async () => {
    const source = [
      '<ParamField body={"expiresInDays"}>One.</ParamField>',
      '<ParamField query={`utm_source`}>Two.</ParamField>',
      '<ResponseField name={"pagination.hasMore"}>Three.</ResponseField>',
      '<ParamField path={"a"} body={name}>Four.</ParamField>',
    ].join('\n\n')
    expect(await renderedIds(source)).toEqual(['param-expires-in-days', 'param-utm-source', 'param-pagination-has-more', 'param-a'])
  })

  it('takes the id an Accordion or an Update made from a title or label written in braces', async () => {
    const accordion = '<Accordion title={"Param name"}>\n\nText.\n\n</Accordion>'
    expect(await renderedHtmlIds(`${accordion}\n\n${field}`)).toEqual(['param-name', 'param-name-accordion-children', 'param-name-1'])
    const template = '<Accordion title={`Param name`}>\n\nText.\n\n</Accordion>'
    expect(await renderedHtmlIds(`${field}\n\n${template}`)).toEqual(['param-name-1', 'param-name', 'param-name-accordion-children'])
    const update = '<Update label={"Param name"} date={"2024-01-01"}>Text.</Update>'
    expect(await renderedHtmlIds(`${update}\n\n${field}`)).toEqual(['param-name', 'param-name-1'])
    const own = '<Accordion title="Other" id={"param-name"}>\n\nText.\n\n</Accordion>'
    expect(await renderedHtmlIds(`${own}\n\n${field}`)).toEqual(['param-name', 'param-name-accordion-children', 'param-name-1'])
  })

  it('keeps an id written in braces as it is, and skips it for the other fields', async () => {
    expect(await renderedHtmlIds('<ParamField body="x" id={"mine"} />')).toEqual(['mine'])
    expect(await renderedHtmlIds('<ParamField body="x" id={`mine`} />\n\n<ParamField body="mine" />')).toEqual(['mine', 'param-mine'])
    expect(await renderedHtmlIds('<ParamField body="x" id={"param-y"} />\n\n<ParamField body="y" />')).toEqual(['param-y', 'param-y-1'])
    expect(await renderedHtmlIds('<ResponseField name="x" id={"mine"} />')).toEqual(['mine'])
  })

  it('keeps an id that is not a constant, and gives that field none of its own', async () => {
    // The id is whatever the expression holds when the page renders, so the pass cannot know it: it leaves the attribute alone.
    const { compile } = await import('@mdx-js/mdx')
    for (const id of ['{someId}', '{"a" + b}', '{`p-${n}`}']) {
      const compiled = String(await compile(`<ParamField body="x" id=${id} />\n\n<ParamField body="y" />`, { rehypePlugins: [rehypePlugins[2]] }))
      expect(compiled, id).not.toContain('param-x')
      expect(compiled, id).toContain('id: "param-y"')
    }
  })

  it('does not overwrite an id on a Step either', async () => {
    const { compile } = await import('@mdx-js/mdx')
    const compiled = String(await compile('<Steps titleSize="h3">\n<Step title="Install" id={someId}>x</Step>\n</Steps>', { rehypePlugins: [rehypePlugins[2]] }))
    expect(compiled).toContain('id: someId')
    expect(compiled).not.toContain('id: "install"')
  })

  it('reads a Step id in braces as the string it is, as it reads one in quotes', async () => {
    for (const id of ['"install-cli"', '`install-cli`']) {
      const source = `<Steps titleSize="h3">\n<Step title="Install" id={${id}}>Run npm install.</Step>\n</Steps>\n\n## Install`
      expect(await renderedHtmlIds(source), id).toEqual(['install-cli', 'install'])
      expect([...extractHeadingAnchors(source)].sort(), id).toEqual(['install', 'install-cli'])
      expect(await brokenAnchorOutput(source, 'install'), id).not.toContain('Broken anchor')
      expect(await brokenAnchorOutput(source, 'install-2'), id).toContain('Broken anchor')
    }
  })

  it('gives a heading no id from a Step whose id is not a constant, and shifts nothing', async () => {
    for (const id of ['{someId}', '{b + "-a"}', '{`p-${n}`}']) {
      const source = `<Steps titleSize="h3">\n<Step title="Install" id=${id}>Run npm install.</Step>\n</Steps>\n\n## Install`
      expect(await renderedIds(source), id).toEqual(['install'])
      expect([...extractHeadingAnchors(source)], id).toEqual(['install'])
      expect(await brokenAnchorOutput(source, 'install-2'), id).toContain('Broken anchor')
    }
  })
})

describe('field ids next to a heading that is made of components', () => {
  const field = '<ParamField body="name" type="string">The name.</ParamField>'

  // The heading component slugs a heading the pass gave no id from its rendered text, so the pass has to reserve that id.
  it('gives a heading with only a component its id, and the field the next one', async () => {
    for (const heading of ['## <Badge>Param name</Badge>', '## <Badge><Badge>Param</Badge> name</Badge>', '## ?? <Badge>Param name</Badge>']) {
      expect(await renderedHtmlIds(`${heading}\n\n${field}`), heading).toEqual(['param-name', 'param-name-1'])
      expect(await renderedHtmlIds(`${field}\n\n${heading}`), heading).toEqual(['param-name-1', 'param-name'])
      expect(await renderedIds(`${heading}\n\n${field}`), heading).toEqual(['param-name', 'param-name-1'])
    }
  })

  it('numbers repeated headings made of components, as it does the others', async () => {
    const source = '## <Badge>Same</Badge>\n\n## <Badge>Same</Badge>\n\n## Same\n\n<ParamField body="same" />'
    expect(await renderedHtmlIds(source)).toEqual(['same', 'same-2', 'same-3', 'param-same'])
  })

  it('reads a string in braces as the text it renders', async () => {
    expect(await renderedHtmlIds(`## {"Param name"}\n\n## <Badge>{\`Param name\`}</Badge>\n\n${field}`)).toEqual(['param-name', 'param-name-2', 'param-name-1'])
  })

  it('keeps the id of a heading that has text of its own, and of one with nothing to spell', async () => {
    expect(await renderedHtmlIds('## Initialize instance <Badge>Enterprise</Badge>\n\n## <Badge>???</Badge>\n\n## ???')).toEqual(['initialize-instance'])
  })
})

describe('field ids next to a component that gives itself an id', () => {
  const field = '<ParamField body="name" type="string">The name.</ParamField>'
  const paramIds = (ids: Array<string>) => ids.filter((id) => id.startsWith('param-'))

  it('takes the id an Accordion made from its title, and the one of its body', async () => {
    const accordion = '<Accordion title="Param name">\n\nText.\n\n</Accordion>'
    const named = '<ParamField body="name accordion children">Field text.</ParamField>'
    expect(await renderedHtmlIds(`${accordion}\n\n${field}\n\n${named}`)).toEqual([
      'param-name', 'param-name-accordion-children', 'param-name-1', 'param-name-accordion-children-1',
    ])
    expect(await renderedHtmlIds(`${field}\n\n${accordion}`)).toEqual(['param-name-1', 'param-name', 'param-name-accordion-children'])
  })

  it('takes the body id of an Accordion that has an id of its own, whatever its title says', async () => {
    const accordion = '<Accordion title="Other" id="param-name">\n\nText.\n\n</Accordion>'
    const named = '<ParamField body="name accordion children">Field text.</ParamField>'
    expect(await renderedHtmlIds(`${accordion}\n\n${field}\n\n${named}`)).toEqual([
      'param-name', 'param-name-accordion-children', 'param-name-1', 'param-name-accordion-children-1',
    ])
  })

  it('takes the id an Update made from its label', async () => {
    const update = '<Update label="Param name" date="2024-01-01">Text.</Update>'
    expect(await renderedHtmlIds(`${update}\n\n${field}`)).toEqual(['param-name', 'param-name-1'])
  })

  it('reserves no id for a component whose id is a React one or has no literal title', async () => {
    const page = '<Accordion title="日本語">\n\nText.\n\n</Accordion>\n\n<Tabs><Tab title="Param name">x</Tab></Tabs>\n\n<Expandable title="Param name">x</Expandable>'
    expect(paramIds(await renderedHtmlIds(`${page}\n\n${field}`))).toEqual(['param-name'])
  })

  it('leaves every heading id where it was', async () => {
    const accordion = '<Accordion title="Param name">\n\nText.\n\n</Accordion>'
    const source = `## Param name\n\n${accordion}\n\n## Param name\n\n${field}`
    expect(await renderedHtmlIds(source)).toEqual(['param-name', 'param-name', 'param-name-accordion-children', 'param-name-2', 'param-name-1'])
  })
})

describe('thally check resolves the ids the renderer gives fields', () => {
  const source = [
    '## Param name',
    '<ParamField body="data-cookie-options" type="object">',
    '  <Expandable title="properties">',
    '    <ParamField body="expiresInDays" type="integer">Days.</ParamField>',
    '  </Expandable>',
    '</ParamField>',
    '<ParamField body="name" type="string">Name.</ParamField>',
    '<ResponseField name="name" type="string">Name.</ResponseField>',
    '<ParamField path="Workspace name">Four.</ParamField>',
    '<ResponseField name="pagination.hasMore">Five.</ResponseField>',
    '<ParamField body="x" id="param-workspace-name">Own id.</ParamField>',
  ].join('\n\n')

  it('accepts every id the page renders', async () => {
    const ids = await renderedIds(source)
    expect(ids).toEqual(expect.arrayContaining(['param-expires-in-days', 'param-name', 'param-name-1', 'param-name-2', 'param-workspace-name', 'param-workspace-name-1', 'param-pagination-has-more']))
    for (const id of ids) expect(await brokenAnchorOutput(source, id), id).not.toContain('Broken anchor')
  })

  // The renderer reserves every id an author wrote before it numbers the fields; `thally check` must reach the same ids.
  it('skips the id of a plain-text Step, which renders no heading', async () => {
    const step = '<Steps titleSize="p">\n  <Step title="One" id="param-name">Text.</Step>\n</Steps>'
    const page = `${step}\n\n<ParamField body="name" type="string">The name.</ParamField>`
    const ids = await renderedIds(page)
    expect(ids).toEqual(['param-name', 'param-name-1'])
    for (const id of ids) expect(await brokenAnchorOutput(page, id), id).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(page, 'param-name-2')).toContain('Broken anchor')
  })

  it('skips an id authored on any other element, whether it comes before or after the field', async () => {
    const page = [
      '<ParamField body="name" type="string">The name.</ParamField>',
      '<Card title="Card" id="param-name">Text.</Card>',
      '<div id="param-name-1">Text.</div>',
    ].join('\n\n')
    const ids = await renderedIds(page)
    expect(ids).toEqual(['param-name-2', 'param-name', 'param-name-1'])
    for (const id of ids) expect(await brokenAnchorOutput(page, id), id).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(page, 'param-name-3')).toContain('Broken anchor')
  })

  it('skips the ids an Accordion and an Update make, which the renderer gives no field', async () => {
    const accordion = '<Accordion title="Param name">\n\nText.\n\n</Accordion>'
    const update = '<Update label="Param other" date="2024-01-01">Text.</Update>'
    const named = '<ParamField body="name accordion children">Field text.</ParamField>'
    const other = '<ParamField body="other">Field text.</ParamField>'
    const page = `${accordion}\n\n${update}\n\n<ParamField body="name">Field text.</ParamField>\n\n${named}\n\n${other}`
    const ids = (await renderedHtmlIds(page)).filter((id) => id.startsWith('param-'))
    expect(ids).toEqual(['param-name', 'param-name-accordion-children', 'param-other', 'param-name-1', 'param-name-accordion-children-1', 'param-other-1'])
    for (const id of ['param-name-1', 'param-name-accordion-children-1', 'param-other-1']) expect(await brokenAnchorOutput(page, id), id).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(page, 'param-name-2')).toContain('Broken anchor')
  })

  it('does not reserve an id that only appears in prose', async () => {
    const page = 'Write `<Card id="param-name" />` to link a card.\n\n<ParamField body="name" type="string">The name.</ParamField>'
    const ids = await renderedIds(page)
    expect(ids).toEqual(['param-name'])
    expect(await brokenAnchorOutput(page, 'param-name')).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(page, 'param-name-1')).toContain('Broken anchor')
  })

  it('still reports a fragment no heading or field has', async () => {
    for (const id of ['param-name-3', 'param-expiresindays', 'param-x']) expect(await brokenAnchorOutput(source, id), id).toContain('Broken anchor')
  })
})

describe('thally check and the renderer give a page the same ids', () => {
  const pages: Array<[string, string]> = [
    ['an underlined heading, then a field', 'Param name\n----------\n\n<ParamField body="name" />'],
    ['an h1, then a field', '# Param name\n\n<ParamField body="name" />'],
    ['a field, then the heading', '<ParamField body="name" />\n\n## Param name\n\n<ResponseField name="name" />'],
    ['every heading level', '# One\n\n## A\n\n### B\n\n#### C\n\n##### D\n\n###### E'],
    ['an underlined h1 and h2', 'Title\n=====\n\nSub\n---'],
    ['an id comment in the middle of a heading', '## Before {/* #mine */} after\n\n## Mine'],
    ['an id comment that reserves its id', '## Foo\n\n## Foo\n\n## Foo {/* #foo-2 */}'],
    ['headings in a component, a quote, a list and a note', '<Accordion title="Setup">\n\n## Inside\n\n</Accordion>\n\n> ## Quoted\n\n- ## Listed\n\n<Note>\n\n### In a note\n\n</Note>'],
    ['headings in code fences', '```md\n## Fenced\n```\n\n~~~\n## Tilde\n~~~\n\n## Real'],
    ['an indented heading, since MDX has no indented code', 'Text.\n\n    ## Indented'],
    ['a JSX badge in a heading', '## Initialize instance <Badge title="1 > 0">Enterprise</Badge>'],
    ['inline code, emphasis and a link in a heading', '## Run `init` with *care* and [docs](/x)'],
    ['a heading with nothing to spell', '## ???\n\n## Next'],
    ['character references, escapes and a JSX expression in a heading', '## A &amp; B \\*c\\* {1 + 1} d <br/> e'],
    ['closing hashes and an empty heading', '## Foo ##\n\n##\n\n## After'],
    ['a heading in a component inside a component', '<Accordion title="One">\n\n<Accordion title="Two">\n\n### Deep\n\n</Accordion>\n\n</Accordion>'],
    ['repeated headings', '## Same\n\n## Same\n\n## Same'],
    ['step titles that are headings, and a plain-text step', '## Deploy\n\n<Steps titleSize="h3">\n<Step title="Deploy">x</Step>\n<Step title="Plain" titleSize="p" id="plain-id">y</Step>\n</Steps>'],
    ['plain-text steps', '<Steps titleSize="p">\n<Step title="One" id="one-id">x</Step>\n<Step title="Two">y</Step>\n</Steps>'],
    ['an Accordion, then a field', '<Accordion title="Param name">\n\nText.\n\n</Accordion>\n\n<ParamField body="name" />'],
    ['an Accordion with an id of its own', '<Accordion title="Other" id="mine">\n\nText.\n\n</Accordion>'],
    ['an Update, then a field', '<Update label="Param name" date="2024-01-01">Text.</Update>\n\n<ParamField body="name" />'],
    ['a heading with only a component, then a field', '## <Badge>Param name</Badge>\n\n<ParamField body="name" />'],
    ['a component with markup in it, then a field', '## <Badge>Param *name*</Badge>\n\n<ParamField body="name" />'],
    ['punctuation and a component, then a field', '## ?? <Badge>Param name</Badge>\n\n<ParamField body="name" />'],
    ['repeated headings made of components', '## <Badge>Same</Badge>\n\n## <Badge>Same</Badge>\n\n## Same'],
    ['an Accordion titled in braces, then a field', '<Accordion title={"Param name"}>\n\nText.\n\n</Accordion>\n\n<ParamField body="name" />'],
    ['an Accordion titled with a template, then a field', '<Accordion title={`Param name`}>\n\nText.\n\n</Accordion>\n\n<ParamField body="name" />'],
    ['an Update labelled in braces, then a field', '<Update label={"Param name"} date={"2024-01-01"}>Text.</Update>\n\n<ParamField body="name" />'],
    ['an Accordion with an id in braces', '<Accordion title="Other" id={"mine"}>\n\nText.\n\n</Accordion>\n\n<ParamField body="mine" />'],
    ['fields named in braces', '<ParamField body={"expiresInDays"} />\n\n<ResponseField name={`pagination.hasMore`} />\n\n<ParamField body={"expiresInDays"} />'],
    ['a Step with an id in braces, then the heading', '<Steps titleSize="h3">\n<Step title="Install" id={"install-cli"}>Run npm install.</Step>\n</Steps>\n\n## Install'],
    ['a Step with an id as a template, then the heading', '<Steps titleSize="h3">\n<Step title="Install" id={`install-cli`}>Run npm install.</Step>\n</Steps>\n\n## Install'],
    ['a field with an id in braces', '<ParamField body="x" id={"mine"} />\n\n<ParamField body="mine" />'],
    ['a field with an id that matches the next field', '<ParamField body="x" id={"param-y"} />\n\n<ParamField body="y" />'],
    ['a tight strikethrough in a heading, then a field', '## Param a~b~c\n\n<ParamField body="abc" />'],
    ['a strikethrough in a heading, then a field', '## Param ~~old~~ name\n\n## Param ~one~ two\n\n<ParamField body="param one two" />'],
    ['a tight strikethrough in a component in a heading', '## <Badge>Param a~b~c</Badge>\n\n<ParamField body="abc" />'],
    ['a tight strikethrough in an underlined heading', 'Param a~b~c\n-----------\n\n<ParamField body="abc" />'],
    ['strings in braces in a heading', '## {"Param name"}\n\n## <Badge>{`Param name`}</Badge>\n\n<ParamField body="name" />'],
  ]

  it.each(pages)('agrees on %s', async (_name, source) => {
    const rendered = [...new Set(await renderedHtmlIds(source))].sort()
    expect(rendered.filter((id) => /_R_|:/.test(id))).toEqual([])
    expect([...extractHeadingAnchors(source)].sort()).toEqual(rendered)
  })

  // The renderer adds the footnote list to the page (`footnote-label`, `user-content-fn-1`), which is no heading or field.
  it.each([
    ['a footnote reference in a heading', '## Param name[^1]\n\n<ParamField body="name1" />\n\n[^1]: The note.', ['param-name1', 'param-name1-1']],
    ['footnotes numbered in the order they are referenced', 'Text[^b].\n\n## Alpha[^a]\n\n## Beta[^b]\n\n[^a]: A.\n\n[^b]: B.', ['alpha2', 'beta1']],
    ['a footnote referenced twice', '## One[^a]\n\n## Two[^a]\n\n[^a]: A.', ['one1', 'two1']],
    ['a footnote reference in a component in a heading', '## <Badge>Name[^a]</Badge>\n\n[^a]: A.', ['name1']],
    ['a footnote reference with no note, which stays text', '## Param name[^1]\n\n<ParamField body="name-1" />', ['param-name-1', 'param-name-1-1']],
  ])('agrees on %s', async (_name, source, expected) => {
    const rendered = [...new Set(await renderedHtmlIds(source))].filter((id) => id !== 'footnote-label' && !id.startsWith('user-content-')).sort()
    expect(rendered).toEqual([...expected].sort())
    expect([...extractHeadingAnchors(source)].sort()).toEqual(rendered)
  })

  it('gives the ids the reviewed cases name', async () => {
    expect(await renderedHtmlIds(pages[0][1])).toEqual(['param-name', 'param-name-1'])
    expect(await renderedHtmlIds(pages[1][1])).toEqual(['param-name'])
    expect(await renderedHtmlIds(pages[10][1])).toEqual(['initialize-instance'])
    expect(await renderedHtmlIds('## Param a~b~c\n\n<ParamField body="abc" />')).toEqual(['param-abc', 'param-abc-1'])
  })
})
