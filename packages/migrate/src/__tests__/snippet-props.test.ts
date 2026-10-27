/** A Mintlify snippet reads the props it is called with as variables, so inlining one must keep the content they select. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { compileSync } from '@mdx-js/mdx'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

import { migrateRepository } from '../index.js'
import { bindSnippetProps } from '../mdx.js'

function migrate(files: Record<string, string>, docsRoot = '') {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-props-'))
  const all = { 'docs.json': JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['home'] } }), ...files }
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, docsRoot, path)), { recursive: true })
    writeFileSync(join(root, docsRoot, path), body)
  }
  const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
  const body = bundle.pages.find((candidate) => candidate.id === 'home')!.body
  expect(() => compileSync(body, { format: 'mdx' }), body).not.toThrow()
  return { body, warnings: bundle.warnings }
}

const page = (usage: string) => `---\ntitle: Home\n---\n\nimport Role from '/snippets/role.mdx'\n\n${usage}\n`
const role = [
  'Create the role.',
  '',
  '{externalId === "required" && (',
  '  <Note>',
  '    Use the external ID **{externalId}**.',
  '  </Note>',
  ')}',
  '',
  '{externalId !== "required" && <span>No external ID</span>}',
  '',
].join('\n')

describe('a snippet that uses its props as variables', () => {
  it('keeps the content a prop selects, once per use and without a warning', () => {
    const { body, warnings } = migrate({
      'home.mdx': page('<Role externalId="required" />\n\n<Role externalId="optional" />'),
      'snippets/role.mdx': role,
    })
    // Each call keeps only the branch its prop selects, as content; nothing is left to evaluate.
    expect(body.match(/Use the external ID \*\*\{"required"\}\*\*\./g)).toHaveLength(1)
    expect(body.match(/<span>No external ID<\/span>/g)).toHaveLength(1)
    expect(body).not.toMatch(/&&|===|!==|\bexternalId\b/)
    expect(warnings.map((warning) => warning.message).join('\n')).not.toContain('Expressions that use')
  })

  it('binds the prop inside an attribute expression and a shorthand property', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': '<Card title={`Mode ${mode}`} />\n\n{JSON.stringify({ mode })}\n',
    })
    expect(body).toContain('title={`Mode ${"strict"}`}')
    expect(body).toContain('{JSON.stringify({ mode: "strict" })}')
  })

  it('leaves a name that the snippet declares or reads as a property alone', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': '{["a", "b"].map((mode) => <li key={mode + "!"}>{mode.toUpperCase()}</li>)}\n\n{Math.mode} {JSON.stringify({ mode: 1 })}\n',
    })
    expect(body).toContain('(mode) => <li key={mode + "!"}>{mode.toUpperCase()}</li>')
    expect(body).toContain('{Math.mode}')
    expect(body).toContain('{ mode: 1 }')
  })

  it('names an unresolved expression by its path inside the docs folder', () => {
    const { warnings } = migrate({
      'home.mdx': '---\ntitle: Home\n---\n\nShown: {missing === 1 && "yes"}\n',
    }, 'docs')
    expect(warnings.find((warning) => warning.message.startsWith('Expressions that use "missing"'))?.source).toBe('home.mdx')
  })
})

describe('a snippet prop is bound only where it is a free variable', () => {
  it('leaves a name the snippet declares at the top of its own module alone', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': 'export const mode = "local";\n\n{mode === "local" && <span>Keep this</span>}\n',
    })
    expect(body).toContain('{mode === "local" && <span>Keep this</span>}')
    expect(body).not.toContain('"strict"')
  })

  it('leaves a name the snippet declares by function, class or import alone', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" other="x" third="y" />'),
      'snippets/role.mdx': [
        'import { mode } from "/snippets/values.js"',
        'export function other() { return 1 }',
        'export class third {}',
        '',
        '{mode === 1 && other() && <span>Keep this</span>}',
        '',
      ].join('\n'),
      'snippets/values.js': 'export const mode = 1',
    })
    expect(body).toContain('{mode === 1 && other() && <span>Keep this</span>}')
  })

  it('still binds a prop the snippet only reads through props', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': 'export const label = props.mode;\n\n{mode === "strict" && <span>{label}</span>}\n',
    })
    expect(body).toContain('export const label = "strict";')
    expect(body).toContain('<span>{label}</span>')
    expect(body).not.toContain('&&')
  })

  it('binds an outer reference when a callback in the same expression declares the same name', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': '{mode === "strict" && ["a", "b"].map((mode) => <li key={mode + "!"}>{mode.toUpperCase()}</li>)}\n',
    })
    expect(body).toContain('{"strict" === "strict" && ["a", "b"].map((mode) => <li key={mode + "!"}>{mode.toUpperCase()}</li>)}')
  })

  it('shadows a name only inside the function or block that declares it', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': '{(() => { const mode = 1; return mode })() && mode === "strict" && (() => { { const mode = 2 } return mode })()}\n',
    })
    expect(body).toContain('{(() => { const mode = 1; return mode })() && "strict" === "strict" && (() => { { const mode = 2 } return "strict" })()}')
  })
})


describe('a snippet binds props.name only where props itself is the snippet argument', () => {
  it('leaves props.mode alone when the snippet declares props at the top of its own module', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': 'export const props = { mode: "local" };\n\n{props.mode === "local" && <span>Keep this</span>}\n',
    })
    expect(body).toContain('{props.mode === "local" && <span>Keep this</span>}')
    expect(body).not.toContain('"strict"')
  })

  it('leaves props.mode alone inside a block that declares props', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': '{(() => { const props = { mode: "local" }; return props.mode === "local" && <span>Keep this</span> })()}\n',
    })
    expect(body).toContain('const props = { mode: "local" }; return props.mode === "local" && <span>Keep this</span>')
    expect(body).not.toContain('"strict"')
  })

  it('still binds the free variables of a function whose parameter is named props', () => {
    const { body, warnings } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': '{["a"].map((props) => <span key={props}>{mode + props + props.mode}</span>)}\n',
    })
    expect(body).toContain('{["a"].map((props) => <span key={props}>{"strict" + props + props.mode}</span>)}')
    expect(warnings.map((warning) => warning.message).join('\n')).not.toContain('Expressions that use')
  })
})

describe('a snippet prop is never bound to a class member name', () => {
  it('keeps the name of a method, field, accessor and private member, and binds a computed key', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': [
        '{(() => { class X { mode() { return "local" } }; return new X().mode() })()}',
        '',
        '{(() => { class Y { mode = 1; static mode = 2; get mode2() { return this.#mode } #mode = 3; static get mode3() { return W.#mode } }; class W { static #mode = 4 }; return [new Y().mode, Y.mode] })()}',
        '',
        '{(() => { class Z { [mode]() { return 1 } }; return new Z() })()}',
        '',
      ].join('\n'),
    })
    expect(body).toContain('class X { mode() { return "local" } }; return new X().mode()')
    expect(body).toContain('class Y { mode = 1; static mode = 2; get mode2() { return this.#mode } #mode = 3; static get mode3() { return W.#mode } }; class W { static #mode = 4 }')
    expect(body).toContain('class Z { ["strict"]() { return 1 } }')
  })

  it('still binds the prop where a class method reads it as a variable', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': '{(() => { class X { mode() { return mode } }; return new X().mode() })()}\n',
    })
    expect(body).toContain('class X { mode() { return "strict" } }; return new X().mode()')
  })
})

describe('a lone {name} in a snippet is bound by the same scope rules as any other use', () => {
  it('leaves {name} alone inside a callback that declares the name', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': '{["a"].map((mode) => <span key={mode}>{mode}</span>)}\n',
    })
    expect(body).toContain('(mode) => <span key={mode}>{mode}</span>')
    expect(body).not.toContain('"strict"')
  })

  it('leaves {name} alone where the snippet declares the name at the top of its own module', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': 'export const mode = "local";\n\nValue: {mode}\n\n<Card title={mode} />\n',
    })
    expect(body).toContain('Value: {mode}')
    expect(body).toContain('<Card title={mode} />')
    expect(body).not.toContain('"strict"')
  })

  it('still replaces {name} in text, an attribute, a markdown snippet and inline code', () => {
    const jsx = migrate({
      'home.mdx': page('<Role mode="strict" />'),
      'snippets/role.mdx': 'Mode: {mode}\n\n<Card title={mode} />\n\nRun `deploy {mode}`.\n',
    })
    expect(jsx.body).toContain('Mode: {"strict"}')
    expect(jsx.body).toContain('<Card title={"strict"} />')
    expect(jsx.body).toContain('`deploy {"strict"}`')
    const markdown = migrate({
      'home.mdx': page('<Role mode="strict">Inner text</Role>'),
      'snippets/role.mdx': 'Mode: {mode}, then {children}.\n\n```js\n{mode}\n```\n',
    })
    expect(markdown.body).toContain('Mode: strict, then Inner text.')
    expect(markdown.body).toContain('```js\n{mode}\n```')
  })
})

describe('a snippet prop is bound where scope analysis says a reference is free', () => {
  const bind = (snippet: string, attributes = 'mode="strict"', children = '') => migrate({
    'home.mdx': page(children ? `<Role ${attributes}>${children}</Role>` : `<Role ${attributes} />`),
    'snippets/role.mdx': snippet,
  }).body

  it('binds children inside an expression a prop selects', () => {
    const body = bind('{mode === "strict" && <Note>{children}</Note>}\n', 'mode="strict"', 'Important instructions')
    expect(body).toBe('<Note>Important instructions</Note>')
  })

  it('does not turn a label into a string, and binds the reference after it', () => {
    const body = bind('{(() => { mode: for (;;) { break mode; } return mode; })()}\n')
    expect(body).toContain('mode: for (;;) { break mode; } return "strict";')
  })

  it('binds the outer name in a default parameter that a var of the body does not shadow', () => {
    const body = bind('{((x = mode) => { var mode = "local"; return x; })()}\n')
    expect(body).toContain('(x = "strict") => { var mode = "local"; return x; }')
  })

  it('does not let a var in a class static block shadow the enclosing function', () => {
    const body = bind('{(() => { class C { static { var mode = "local"; } }; return mode })()}\n')
    expect(body).toContain('static { var mode = "local"; } }; return "strict"')
  })
})

describe('a snippet fence closes the way CommonMark closes it', () => {
  it('keeps a shorter fence inside a longer one, and the text after the longer one is bound again', () => {
    const { body } = migrate({
      'home.mdx': page('<Role name="strict" />'),
      'snippets/role.mdx': ['Before {name}.', '', '````js', '```js', '{name}', '```', '{name}', '````', '', 'After {name}.', ''].join('\n'),
    })
    expect(body).toContain('````js\n```js\n{name}\n```\n{name}\n````')
    expect(body).toContain('Before strict.')
    expect(body).toContain('After strict.')
  })

  it('does not close a fence on a line that has an info string', () => {
    const { body } = migrate({
      'home.mdx': page('<Role name="strict" />'),
      'snippets/role.mdx': ['```', '{name}', '```js', '{name}', '```', '', 'After {name}.', ''].join('\n'),
    })
    expect(body).toContain('```\n{name}\n```js\n{name}\n```')
    expect(body).toContain('After strict.')
  })
})

describe('a condition the binding has made fully static is decided at migration time', () => {
  // The shape of Infisical's snippets/app-connections/aws/create-iam-role.mdx.
  const iamRole = [
    '<Step>',
    '    Select **Another AWS account**:',
    '',
    '    {externalId === "required" && (',
    '        <MDX>',
    '            <View title="Organization-level">',
    '                Enable **Require external ID**.',
    '            </View>',
    '',
    '            Infisical sends this ID every time it assumes the role.',
    '        </MDX>',
    '    )}',
    '',
    '    {externalId === "organization" && (',
    '        <MDX>',
    '            Use your Organization ID.',
    '        </MDX>',
    '    )}',
    '</Step>',
    '',
  ].join('\n')

  it('keeps the branch that holds as content and removes the others, whatever the prop is', () => {
    const run = (value: string) => migrate({
      'home.mdx': page(`<Role externalId="${value}" />`),
      'snippets/role.mdx': iamRole,
    }).body
    const required = run('required')
    expect(required).toContain('Enable **Require external ID**.')
    expect(required).toContain('<MDX>\n            <View title="Organization-level">')
    expect(required).not.toContain('Use your Organization ID.')
    const organization = run('organization')
    expect(organization).toContain('Use your Organization ID.')
    expect(organization).not.toContain('Enable **Require external ID**.')
    const skipped = run('skip')
    expect(skipped).not.toMatch(/Require external ID|Organization ID/)
    for (const body of [required, organization, skipped]) {
      expect(body).toContain('Select **Another AWS account**:')
      expect(body).not.toMatch(/&&|===|externalId/)
    }
  })

  it('decides ternaries, negation, || and nested conditions', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="cloud" other="x" />'),
      'snippets/role.mdx': [
        'Runs on {mode === "cloud" ? "Infisical Cloud" : "your own servers"}.',
        '',
        'Version {mode != "cloud" ? "self" : 2}',
        '',
        '{!(mode === "dedicated") && <b>not dedicated</b>}',
        '',
        '{mode === "dedicated" || other === "x" ? <i>either</i> : <u>neither</u>}',
        '',
        '{mode === "cloud" && (other === "y" || other === "x" && (<span>nested</span>))}',
        '',
        '{mode === "cloud" ? (other === "x" ? <em>one</em> : <u>two</u>) : <s>three</s>}',
        '',
        '{mode === "dedicated" && <u>never</u>}',
        '',
        '{mode === "cloud" ? "A & B" : "C"}',
        '',
      ].join('\n'),
    })
    expect(body.split('\n').filter(Boolean)).toEqual([
      'Runs on Infisical Cloud.',
      'Version {2}',
      '<b>not dedicated</b>',
      '<i>either</i>',
      '<span>nested</span>',
      '<em>one</em>',
      '{"A & B"}',
    ])
  })

  it('decides an attribute that selects a literal, and leaves one that selects JSX', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="cloud" />'),
      'snippets/role.mdx': '<Card title={mode === "cloud" ? "Cloud" : "Self"} icon={mode === "cloud" && <Icon />} />\n',
    })
    expect(body).toContain('<Card title={"Cloud"} icon={"cloud" === "cloud" && <Icon />} />')
  })

  it('leaves an expression with anything not static as written, bound', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="cloud" />'),
      'snippets/role.mdx': [
        'export const later = "yes"',
        'export const items = []',
        'export function check() { return true }',
        '',
        '{mode === "cloud" && later}',
        '',
        '{mode === "cloud" && check() && <b>call</b>}',
        '',
        '{mode === "cloud" && items.length > 0 && <b>compare</b>}',
        '',
        '{mode === "cloud" ?? <b>nullish</b>}',
        '',
        '{(mode === "cloud" && <b>seen</b>) || later}',
        '',
        '{mode === "cloud" ? [1, 2] : []}',
        '',
        '{mode + "!" === "cloud!" && <b>concat</b>}',
        '',
        '{mode === `cloud` && <b>template</b>}',
        '',
        '{mode === "cloud" && -1 === -1 && <b>negative</b>}',
        '',
      ].join('\n'),
    })
    expect(body).toContain('{"cloud" === "cloud" && later}')
    expect(body).toContain('{"cloud" === "cloud" && check() && <b>call</b>}')
    expect(body).toContain('{"cloud" === "cloud" && items.length > 0 && <b>compare</b>}')
    expect(body).toContain('{"cloud" === "cloud" ?? <b>nullish</b>}')
    expect(body).toContain('{("cloud" === "cloud" && <b>seen</b>) || later}')
    expect(body).toContain('{"cloud" === "cloud" ? [1, 2] : []}')
    expect(body).toContain('{"cloud" + "!" === "cloud!" && <b>concat</b>}')
    expect(body).toContain('{"cloud" === `cloud` && <b>template</b>}')
    expect(body).toContain('{"cloud" === "cloud" && -1 === -1 && <b>negative</b>}')
  })

  it('leaves a condition the page wrote static itself, and a fenced example, as written', () => {
    const { body } = migrate({
      'home.mdx': page('<Role mode="cloud" />'),
      'snippets/role.mdx': [
        '{true && <b>already static</b>}',
        '',
        '```jsx',
        '{mode === "cloud" && <b>example</b>}',
        '```',
        '',
        '{mode === "cloud" && <b>decided</b>}',
        '',
      ].join('\n'),
    })
    expect(body).toContain('{true && <b>already static</b>}')
    expect(body).toContain('```jsx\n{mode === "cloud" && <b>example</b>}\n```')
    expect(body).toContain('<b>decided</b>')
    expect(body).not.toContain('{"cloud" === "cloud"')
  })
})

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx)
type Node = { type: string; children?: Array<Node> }
/** The block structure MDX reads out of `text`: containers by name with their blocks, a paragraph as one block. */
const outline = (node: Node): string => ['root', 'blockquote', 'list', 'listItem', 'mdxJsxFlowElement'].includes(node.type)
  ? `${node.type}(${(node.children ?? []).map(outline).join(' ')})` : node.type
const blocks = (text: string) => outline(parser.parse(text) as Node)

describe('a condition folded to content stays in the block it was in', () => {
  const bind = (snippet: string, props: Record<string, string> = { mode: 'x' }) => bindSnippetProps(snippet, new Map(Object.entries(props)))

  it('keeps a flow expression a block of its own when it folds to JSX', () => {
    const source = 'Before\n{mode === "x" && <span>yes</span>}\nAfter'
    expect(blocks(source)).toBe('root(paragraph mdxFlowExpression paragraph)')
    const folded = bind(source)
    expect(folded).toContain('<span>yes</span>')
    expect(blocks(folded)).toBe('root(paragraph paragraph paragraph)')
  })

  it('keeps it a block of its own when it folds to plain text or a string', () => {
    expect(blocks(bind('Before\n{mode === "x" ? "text" : "no"}\nAfter'))).toBe('root(paragraph paragraph paragraph)')
    // A string that is not plain text stays an expression of its own, which is a block as well.
    expect(blocks(bind('Before\n{mode === "x" ? "A & B" : "no"}\nAfter'))).toBe('root(paragraph mdxFlowExpression paragraph)')
  })

  it('does not join the paragraphs around a branch that leaves nothing', () => {
    const folded = bind('Before\n{mode === "y" && <span>yes</span>}\nAfter')
    expect(blocks(folded)).toBe('root(paragraph paragraph)')
    expect(folded).not.toContain('span')
    expect(blocks(bind('Before\n{mode === "y" && <span>yes</span>}\n\nAfter'))).toBe('root(paragraph paragraph)')
  })

  it('leaves the blank lines a block already had, and an inline expression inline', () => {
    expect(bind('Before\n\n{mode === "x" && <span>yes</span>}\n\nAfter')).toBe('Before\n\n<span>yes</span>\n\nAfter')
    const inline = bind('Text {mode === "x" && <b>inline</b>} more\nand {mode === "x" ? "this" : "that"} too')
    expect(inline).toBe('Text <b>inline</b> more\nand this too')
    expect(blocks(inline)).toBe('root(paragraph)')
  })

  it('keeps the block inside a quote, a list item and a JSX element', () => {
    const condition = '{mode === "x" && <span>yes</span>}'
    expect(blocks(bind(`> Before\n> ${condition}\n> After`))).toBe('root(blockquote(paragraph paragraph paragraph))')
    expect(blocks(bind(`- Before\n  ${condition}\n  After`))).toBe('root(list(listItem(paragraph paragraph paragraph)))')
    expect(blocks(bind(`- ${condition}\n  After`))).toBe('root(list(listItem(paragraph paragraph)))')
    expect(blocks(bind(`<Step>\n  Before\n  ${condition}\n  After\n</Step>`))).toBe('root(mdxJsxFlowElement(paragraph paragraph paragraph))')
  })

  it('keeps a lone {children} on its own line a block in a Markdown snippet', () => {
    const folded = bind('Before\n{children}\nAfter', { children: 'Inner text' })
    expect(folded).toContain('Inner text')
    expect(blocks(folded)).toBe('root(paragraph paragraph paragraph)')
  })
})

describe('a condition inside the JSX a folded condition keeps is decided too', () => {
  const bind = (snippet: string, props: Record<string, string> = { mode: 'x' }) => bindSnippetProps(snippet, new Map(Object.entries(props)))

  it('decides a text expression in the children and one in an attribute', () => {
    expect(bind('{mode === "x" && <span>{mode === "x" ? "yes" : "no"}</span>}')).toBe('<span>yes</span>')
    expect(bind('{mode === "x" && <span title={mode === "x" ? "a" : "b"}>hi</span>}')).toBe('<span title={"a"}>hi</span>')
    expect(bind('{mode === "x" && <span>{mode === "y" && <b>no</b>}</span>}')).toBe('<span></span>')
  })

  it('decides it again in the JSX a nested condition selects, and keeps a text expression inline', () => {
    expect(bind('{mode === "x" && <p>Hi {mode === "x" && <b>there</b>}, {mode === "x" ? "friend" : "you"}.</p>}'))
      .toBe('<p>Hi <b>there</b>, friend.</p>')
    expect(bind('{mode === "x" && (<ul>{mode === "y" ? <li>a</li> : <li title={mode}>b</li>}</ul>)}')).toBe('<ul><li title={"x"}>b</li></ul>')
  })

  it('leaves what is not static, and what the page wrote static itself, as it is', () => {
    expect(bind('export const later = "l"\n\n{mode === "x" && <span>{mode === "x" && later}</span>}'))
      .toBe('export const later = "l"\n\n<span>{"x" === "x" && later}</span>')
    expect(bind('{mode === "x" && <span>{true ? "kept" : "no"}</span>}')).toBe('<span>{true ? "kept" : "no"}</span>')
    expect(bind('{mode === "x" && <Card icon={mode === "x" && <Icon />} />}')).toBe('<Card icon={"x" === "x" && <Icon />} />')
    expect(bind('{mode === "x" && <span>{["a"].map((m) => <b key={m}>{mode === "x" ? "y" : "n"}</b>)}</span>}'))
      .toBe('<span>{["a"].map((m) => <b key={m}>{"x" === "x" ? "y" : "n"}</b>)}</span>')
  })

  it('keeps a nested fold that is on a line of its own a block of its own', () => {
    const folded = bind([
      '{mode === "x" && (',
      '  <MDX>',
      '    Intro',
      '    {mode === "x" && <b>yes</b>}',
      '    More',
      '  </MDX>',
      ')}',
    ].join('\n'))
    expect(folded).toBe('<MDX>\n    Intro\n\n    <b>yes</b>\n\n    More\n  </MDX>')
  })
})

describe('a nested fold keeps its block boundaries with CRLF line endings and inside a quote', () => {
  const bind = (snippet: string) => bindSnippetProps(snippet, new Map([['mode', 'x']]))
  const one = ['{mode === "x" && <MDX>', '  Intro', '  {mode === "x" && <b>yes</b>}', '  More', '</MDX>}']
  const two = [
    '{mode === "x" && <MDX>', '  Outer', '  {mode === "x" && <MDX>', '    Inner', '    {mode === "x" && <b>deep</b>}', '    Tail', '  </MDX>}', '  End', '</MDX>}',
  ]
  const forms = (lines: Array<string>): Array<[string, string]> => [
    ['LF', lines.join('\n')],
    ['CRLF', lines.join('\r\n')],
    ['a quote', lines.map((line) => `> ${line}`).join('\n')],
    ['a quote with CRLF', lines.map((line) => `> ${line}`).join('\r\n')],
  ]

  for (const [name, lines] of [['one level', one], ['two levels', two]] as const) {
    it(`reads ${name} as the same blocks as the LF page, with CRLF and in a quote`, () => {
      const expected = blocks(bind(lines.join('\n')))
      // The fold leaves the paragraphs of the element apart: three blocks around the nested JSX, not one paragraph.
      expect(expected).toBe(name === 'one level'
        ? 'root(mdxJsxFlowElement(paragraph paragraph paragraph))'
        : 'root(mdxJsxFlowElement(paragraph mdxJsxFlowElement(paragraph paragraph paragraph) paragraph))')
      for (const [form, source] of forms(lines)) {
        const folded = bind(source)
        expect(blocks(folded), form).toBe(form.includes('quote') ? `root(blockquote(${expected.slice('root('.length, -1)}))` : expected)
        expect(folded, form).not.toMatch(/===|&&/)
      }
    })
  }

  it('keeps the page\'s own line ending in the break it adds', () => {
    expect(bind(one.join('\r\n'))).not.toMatch(/(?<!\r)\n/)
  })

  it('still sees a fenced example as code, so its {name} is left alone', () => {
    const lines = ['```js', 'const a = {mode}', '```', '', 'Mode {mode}']
    expect(bind(lines.join('\n'))).toBe('```js\nconst a = {mode}\n```\n\nMode x')
    expect(bind(lines.join('\r\n'))).toBe('```js\r\nconst a = {mode}\r\n```\r\n\r\nMode x')
  })
})

describe('the blank lines set around a folded block carry no trailing whitespace', () => {
  const props = new Map([['mode', 'x'], ['children', 'Inner text']])
  const bind = (snippet: string) => bindSnippetProps(snippet, props)
  const trailing = (text: string) => text.split(/\r?\n/).filter((line) => /[ \t]$/.test(line))
  // Each form is the lines of a page with the block (`{children}` or a condition that folds to JSX) between a line of text above and below.
  const forms: Array<[string, (block: string) => Array<string>, string]> = [
    ['a JSX element', (block) => ['<Expandable title="Event">', '  <Note>', '    Before', `    ${block}`, '    After', '  </Note>', '</Expandable>'], 'root(mdxJsxFlowElement(mdxJsxFlowElement(paragraph paragraph paragraph)))'],
    ['a JSX element, deep', (block) => ['<Expandable title="Event">', '  <Tab>', '    <Note>', '      <Step>', '        Before', `        ${block}`, '        After', '      </Step>', '    </Note>', '  </Tab>', '</Expandable>'], 'root(mdxJsxFlowElement(mdxJsxFlowElement(mdxJsxFlowElement(mdxJsxFlowElement(paragraph paragraph paragraph)))))'],
    ['a JSX element indented with a tab', (block) => ['<Step>', '\tBefore', `\t${block}`, '\tAfter', '</Step>'], 'root(mdxJsxFlowElement(paragraph paragraph paragraph))'],
    ['a list item', (block) => ['- Before', `  ${block}`, '  After'], 'root(list(listItem(paragraph paragraph paragraph)))'],
    ['a list item that starts with it', (block) => [`- ${block}`, '  After'], 'root(list(listItem(paragraph paragraph)))'],
    ['a quote', (block) => ['> Before', `> ${block}`, '> After'], 'root(blockquote(paragraph paragraph paragraph))'],
    ['a quote in a quote', (block) => ['> > Before', `> > ${block}`, '> > After'], 'root(blockquote(blockquote(paragraph paragraph paragraph)))'],
    ['a quote in a list item', (block) => ['- > Before', `  > ${block}`, '  > After'], 'root(list(listItem(blockquote(paragraph paragraph paragraph))))'],
    ['a list item in a quote', (block) => ['> - Before', `>   ${block}`, '>   After'], 'root(blockquote(list(listItem(paragraph paragraph paragraph))))'],
    ['no container', (block) => ['Before', block, 'After'], 'root(paragraph paragraph paragraph)'],
  ]

  for (const [name, lines, outline] of forms) {
    for (const [block, label] of [['{children}', 'a lone {children}'], ['{mode === "x" && <span>yes</span>}', 'a condition folded to JSX']] as const) {
      for (const [ending, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
        it(`${label} in ${name} (${ending})`, () => {
          const folded = bind(lines(block).join(eol))
          expect(trailing(folded), JSON.stringify(folded)).toEqual([])
          expect(blocks(folded.replaceAll('\r\n', '\n'))).toBe(outline)
          if (ending === 'CRLF') expect(folded).not.toMatch(/(?<!\r)\n/)
        })
      }
    }
  }

  it.each([
    ['a JSX element', ['<Note>', '  Before', '  {mode === "y" && <span>no</span>}', '  After', '</Note>'], 'root(mdxJsxFlowElement(paragraph paragraph))'],
    ['a list item', ['- Before', '  {mode === "y" && <span>no</span>}', '  After'], 'root(list(listItem(paragraph paragraph)))'],
    ['a quote', ['> Before', '> {mode === "y" && <span>no</span>}', '> After'], 'root(blockquote(paragraph paragraph))'],
  ])('a branch that leaves nothing leaves an empty line in %s', (_name, lines, outline) => {
    const folded = bind(lines.join('\n'))
    expect(trailing(folded), JSON.stringify(folded)).toEqual([])
    expect(folded).not.toContain('span')
    expect(blocks(folded)).toBe(outline)
  })
})
