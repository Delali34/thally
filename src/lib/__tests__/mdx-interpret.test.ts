/**
 * Interpreter tests: the eval-free MDX renderer must produce the same
 * observable output as the compiled path for documentation-shaped content —
 * component resolution, literal attribute expressions, Shiki-highlighted
 * fences, frontmatter — while degrading dynamic expressions to nothing
 * instead of crashing (Workers forbid code generation, so there is no
 * compiled fallback at request time).
 */

import { Children, cloneElement, createElement, isValidElement, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ prefetch: vi.fn() }),
}))

import { interpretMDX } from '@/lib/mdx-interpret'
import { node, oneOf, propContractOf, requiredText, text, textList, textOrList, withPropContract } from '@/lib/mdx-prop-contract'
import { Code, Pre } from '@/components/mdx/code-blocks'
import { useMDXComponents } from '@/components/mdx/mdx-components'

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(function Wrapper() {
    return node
  }))
}

const Note: ComponentType<Record<string, unknown>> = ({ title, children }) =>
  createElement('aside', { 'data-note': true, 'data-title': title as string }, children as ReactNode)

const Steps: ComponentType<Record<string, unknown>> = ({ children }) =>
  createElement('ol', { 'data-steps': true }, children as ReactNode)

describe('interpretMDX', () => {
  it('renders markdown through the standard pipeline', async () => {
    const { content } = await interpretMDX({
      source: '# Hello\n\nSome **bold** text.',
      components: {},
    })
    const html = render(content)
    expect(html).toContain('Hello')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('resolves capitalized JSX tags through the components map', async () => {
    // Regression: hast-util-to-jsx-runtime routes capitalized names through
    // the evaluater as estree Identifiers, never through its `components`
    // option. Without identifier resolution every custom component rendered
    // as `undefined` and the page 500ed.
    const { content } = await interpretMDX({
      source: '<Note title="Heads up">Careful now.</Note>',
      components: { Note },
    })
    const html = render(content)
    expect(html).toContain('data-note')
    expect(html).toContain('data-title="Heads up"')
    expect(html).toContain('Careful now.')
  })

  it('resolves member-expression component names', async () => {
    const Group = Object.assign(Steps, { Item: Note })
    const { content } = await interpretMDX({
      source: '<Group.Item title="nested">inner</Group.Item>',
      components: { Group },
    })
    expect(render(content)).toContain('data-title="nested"')
  })

  it('evaluates literal attribute expressions statically', async () => {
    const Probe: ComponentType<Record<string, unknown>> = (props) =>
      createElement('div', { 'data-cols': String(props.cols), 'data-flag': String(props.flag) })
    const { content } = await interpretMDX({
      source: '<Probe cols={2} flag={!false} />',
      components: { Probe },
    })
    const html = render(content)
    expect(html).toContain('data-cols="2"')
    expect(html).toContain('data-flag="true"')
  })

  it('keeps string expression attributes used by imported file trees', async () => {
    const Folder: ComponentType<Record<string, unknown>> = ({ name }) =>
      createElement('div', { 'data-name': name as string })
    const { content } = await interpretMDX({
      source: '<Folder name={"my-skill/"} />',
      components: { Folder },
    })
    expect(render(content)).toContain('data-name="my-skill/"')
  })

  it('evaluates expression-free template literals in component children', async () => {
    const Probe: ComponentType<Record<string, unknown>> = ({ children }) =>
      createElement('div', { 'data-definition': children as string })
    const { content } = await interpretMDX({
      source: '<Probe>{`flowchart LR\nA --> B`}</Probe>',
      components: { Probe },
    })

    expect(render(content)).toContain('data-definition="flowchart LR\nA --&gt; B"')
  })

  it('renders dynamic expressions as nothing instead of failing the page', async () => {
    const { content } = await interpretMDX({
      source: 'Before {process.env.SECRET} after.',
      components: {},
    })
    const html = render(content)
    expect(html).toContain('Before')
    expect(html).toContain('after.')
    expect(html).not.toContain('SECRET')
  })

  it('parses frontmatter when asked and strips it from output', async () => {
    const { content, frontmatter } = await interpretMDX({
      source: '---\ntitle: My Page\n---\n\nBody text.',
      components: {},
      parseFrontmatter: true,
    })
    expect(frontmatter.title).toBe('My Page')
    const html = render(content)
    expect(html).toContain('Body text.')
    expect(html).not.toContain('My Page')
  })

  it('highlights code fences with Shiki css-variable tokens', async () => {
    const { content } = await interpretMDX({
      source: '```ts\nconst x = 1\n```',
      components: {},
    })
    expect(render(content)).toContain('--shiki')
  })

  it('renders unsupported code fences as plaintext without failing the page', async () => {
    const { content } = await interpretMDX({
      source: '```brainfuck\n++[>++<-]\n```',
      components: {},
    })
    expect(render(content)).toContain('++[&gt;++&lt;-]')
  })

  it.each(['java', 'graphql', 'ruby', 'php', 'csharp', 'vue'])(
    'highlights the supported %s grammar',
    async (language) => {
      const { content } = await interpretMDX({
        source: `\`\`\`${language}\nconst greeting = "hello"\n\`\`\``,
        components: {},
      })
      expect(render(content)).toContain('--shiki')
    },
  )

  it('ignores leftover export statements without throwing', async () => {
    const { content } = await interpretMDX({
      source: 'export const meta = { a: 1 }\n\nStill renders.',
      components: {},
    })
    expect(render(content)).toContain('Still renders.')
  })

  it('renders MDX comments as nothing', async () => {
    // Regression: an expression-free `{/* … */}` parses to an empty estree
    // Program, and hast-util-to-jsx-runtime reads body[0].type unguarded.
    const { content } = await interpretMDX({
      source: '{/* a note to editors */}\n\nVisible text.\n\nInline {/* here */} too.',
      components: {},
    })
    const html = render(content)
    expect(html).toContain('Visible text.')
    expect(html).toContain('too.')
    expect(html).not.toContain('note to editors')
  })

  it('refuses inherited property lookups on components', async () => {
    // `<Note.constructor/>` would otherwise resolve to Function, which React
    // calls with an attacker-influenced string — code generation by proxy.
    const { content } = await interpretMDX({
      source: '<Note.constructor />\n\nAfter.',
      components: { Note },
    })
    const html = render(content)
    expect(html).toContain('After.')
    expect(html).not.toContain('function')
  })

  it('refuses inherited identifier lookups', async () => {
    const { content } = await interpretMDX({
      source: 'Value {constructor} here.',
      components: {},
    })
    expect(render(content)).toContain('Value')
  })

  it('does not execute javascript frontmatter', async () => {
    const marker = '__interpreter_frontmatter_probe__'
    const globals = globalThis as unknown as Record<string, unknown>
    delete globals[marker]
    const { frontmatter } = await interpretMDX({
      source: `---js\n{ title: ((globalThis['${marker}'] = 'executed'), 'Hi') }\n---\n\nBody.`,
      components: {},
      parseFrontmatter: true,
    })
    expect(globals[marker]).toBeUndefined()
    expect(frontmatter.title).not.toBe('Hi')
  })

  it('returns a fresh frontmatter object per call', async () => {
    const source = '---\ntitle: Shared\n---\n\nBody.'
    const first = await interpretMDX({ source, components: {}, parseFrontmatter: true })
    first.frontmatter.title = 'Mutated'
    const second = await interpretMDX({ source, components: {}, parseFrontmatter: true })
    expect(second.frontmatter.title).toBe('Shared')
  })

  it('degrades computed object keys instead of fabricating props', async () => {
    const Probe: ComponentType<Record<string, unknown>> = (props) =>
      createElement('div', { 'data-value': JSON.stringify(props.data ?? null) })
    const { content } = await interpretMDX({
      source: '<Probe data={{[someName]: 1}} />',
      components: { Probe },
    })
    expect(render(content)).not.toContain('someName')
  })

  it('renders object expressions in child position as nothing', async () => {
    const { content } = await interpretMDX({
      source: 'Before {{ a: 1 }} after.',
      components: {},
    })
    const html = render(content)
    expect(html).toContain('Before')
    expect(html).toContain('after.')
  })

  it('renders unknown components as their children instead of failing', async () => {
    const { content } = await interpretMDX({
      source: '<Nope>inner text</Nope>',
      components: {},
    })
    expect(render(content)).toContain('inner text')
  })

  it('drops HTML-style string style attributes', async () => {
    const { content } = await interpretMDX({
      source: '<div style="color:red">styled</div>',
      components: {},
    })
    expect(render(content)).toContain('styled')
  })
})

describe('object-valued JSX attributes', () => {
  it('keeps a style object on HTML and SVG elements', async () => {
    const { content } = await interpretMDX({
      source: '<div id="viz" style={{ padding: \'1rem 0.5rem\' }}>\n  <svg viewBox="0 0 10 10" style={{ width: \'100%\', maxWidth: \'620px\' }}>\n    <g id="s1" style={{ transition: \'opacity 0.3s\' }} />\n  </svg>\n</div>',
      components: {},
    })
    const html = render(content)
    expect(html).toContain('<div id="viz" style="padding:1rem 0.5rem">')
    expect(html).toContain('<svg viewBox="0 0 10 10" style="width:100%;max-width:620px">')
    expect(html).toContain('<g id="s1" style="transition:opacity 0.3s"></g>')
  })

  it('keeps a style object and plain data on a component prop', async () => {
    const Probe: ComponentType<Record<string, unknown>> = (props) =>
      createElement('div', {
        style: props.style as never,
        'data-config': JSON.stringify(props.config ?? null),
        'data-items': JSON.stringify(props.items ?? null),
      })
    const { content } = await interpretMDX({
      source: "<Probe style={{ color: 'red' }} config={{ cols: 2 }} items={[1, 'two']} />",
      components: { Probe },
    })
    expect(render(content)).toBe(
      '<div style="color:red" data-config="{&quot;cols&quot;:2}" data-items="[1,&quot;two&quot;]"></div>',
    )
  })

  it('spreads an object literal into the element props', async () => {
    const { content } = await interpretMDX({
      source: '<div {...{ id: \'spread\', style: { color: \'red\' } }}>x</div>',
      components: {},
    })
    expect(render(content)).toContain('<div id="spread" style="color:red">x</div>')
  })

  it('never lets an authored object inject raw HTML', async () => {
    const { content } = await interpretMDX({
      source: '<div dangerouslySetInnerHTML={{ __html: \'<img src=x onerror=alert(1)>\' }} />',
      components: {},
    })
    expect(render(content)).not.toContain('<img')
  })
})

describe('JSX elements as attribute values', () => {
  const Card: ComponentType<Record<string, unknown>> = ({ title, icon }) =>
    createElement('div', { 'data-card': true }, createElement('span', { 'data-icon': true }, icon as ReactNode), title as string)

  it('renders an inline svg passed as a prop, as the compiled page does', async () => {
    const source = [
      '<Card',
      '  title="Android"',
      '  icon={',
      '    <svg enable-background="new 0 0 24 24" viewBox="0 0 24 24" fill="#1ebca1">',
      '      <path d="m0 0v12" />',
      '      <path d="m1 1" strokeWidth={2} style={{ color: \'red\' }}>',
      '        label',
      '      </path>',
      '    </svg>',
      '  }',
      '/>',
    ].join('\n')
    const { content } = await interpretMDX({ source, components: { Card } })
    expect(render(content)).toBe(
      '<div data-card="true"><span data-icon="true"><svg enable-background="new 0 0 24 24" viewBox="0 0 24 24" fill="#1ebca1"><path d="m0 0v12"></path><path d="m1 1" stroke-width="2" style="color:red">label</path></svg></span>Android</div>',
    )
  })

  it('resolves a capitalized element in the value through the components map', async () => {
    const Badge: ComponentType<Record<string, unknown>> = ({ children }) =>
      createElement('b', null, children as ReactNode)
    const { content } = await interpretMDX({
      source: '<Card title="T" icon={<Badge>new</Badge>} />',
      components: { Card, Badge },
    })
    expect(render(content)).toContain('<span data-icon="true"><b>new</b></span>')
  })

  it('renders an unknown component in the value as its children', async () => {
    const { content } = await interpretMDX({
      source: '<Card title="T" icon={<Nope>inner</Nope>} />',
      components: { Card },
    })
    expect(render(content)).toContain('<span data-icon="true">inner</span>')
  })
})

describe('paragraphs that hold only JSX', () => {
  it('does not wrap a lone inline element in a paragraph', async () => {
    const Badge: ComponentType<Record<string, unknown>> = ({ children }) =>
      createElement('span', { 'data-badge': true }, children as ReactNode)
    const { content } = await interpretMDX({
      source: '<Badge>New</Badge>\n\nText with <Badge>inline</Badge> stays in a paragraph.',
      components: { Badge },
    })
    expect(render(content)).toBe(
      '<span data-badge="true">New</span>\n<p>Text with <span data-badge="true">inline</span> stays in a paragraph.</p>',
    )
  })

  it('keeps a block-level component out of a paragraph', async () => {
    // `<p><aside>` is re-parented by the HTML parser before React hydrates,
    // which fails hydration (React error 418) on every page with such a callout.
    const { content } = await interpretMDX({
      source: '<Note title="One">Careful now.</Note>\n\nBody text.\n\n<Note title="Two">Also careful.</Note>',
      components: { Note },
    })
    const html = render(content)
    expect(html).not.toContain('<p><aside')
    expect(html).toBe(
      '<aside data-note="true" data-title="One">Careful now.</aside>\n<p>Body text.</p>\n<aside data-note="true" data-title="Two">Also careful.</aside>',
    )
  })

  it('keeps SVG children as direct children when lines mix elements, text and comments', async () => {
    // A line such as `<text x="1">label</text>` carries text, so remark-mdx reads
    // it as inline JSX inside a paragraph. Left wrapped, the `<p>` makes the
    // browser close the surrounding <svg>, which then renders blank.
    const source = [
      '<svg viewBox="0 0 10 10">',
      '  {/* State 1 */}',
      '  <g id="s1">',
      '    <text x="1" y="2">label</text>',
      '    {/* Row 1 */}',
      '    <g><rect x="1"/><text x="2">1</text></g>',
      '',
      '    <g><rect x="3"/><text x="4">2</text></g>',
      '  </g>',
      '',
      '  {/* Arrow */}',
      '  <g id="arrow"><line x1="1"/></g>',
      '</svg>',
    ].join('\n')
    const { content } = await interpretMDX({ source, components: {} })
    expect(render(content)).toBe(
      '<svg viewBox="0 0 10 10"><g id="s1"><text x="1" y="2">label</text><g><rect x="1"></rect><text x="2">1</text></g><g><rect x="3"></rect><text x="4">2</text></g></g><g id="arrow"><line x1="1"></line></g></svg>',
    )
  })
})

describe('props that would crash React', () => {
  const Card: ComponentType<Record<string, unknown>> = ({ title, icon }) =>
    createElement('div', null, createElement('span', null, icon as ReactNode), title as string)

  it('renders a card whose icon is an object literal', async () => {
    const { content } = await interpretMDX({ source: '<Card title="T" icon={{ a: 1 }} />', components: { Card } })
    expect(render(content)).toBe('<div><span></span>T</div>')
  })

  it('drops a spread children that is not a valid node and keeps one that is', async () => {
    const { content } = await interpretMDX({
      source: "<div {...{ children: { a: 1 } }} />\n\n<p {...{ children: ['A', 'B'] }} />\n\n<b {...{ children: 'ok' }} />",
      components: {},
    })
    expect(render(content)).toBe('<div></div>\n<p>AB</p>\n<b>ok</b>')
  })

  it('renders an object that forges the React element marker as nothing', async () => {
    const { content } = await interpretMDX({
      source: 'Before {{ "$$typeof": 1 }} after <Card title="T" icon={{ "$$typeof": 1 }} />',
      components: { Card },
    })
    expect(render(content)).toContain('Before')
  })

  it('renders an array of valid nodes in child position', async () => {
    const { content } = await interpretMDX({ source: "<b>{['A', 'B', 3]}</b>", components: {} })
    expect(render(content)).toBe('<b>AB3</b>')
  })
})

describe('JSX elements inside attribute values keep spreads and arrays', () => {
  const Card: ComponentType<Record<string, unknown>> = ({ icon }) =>
    createElement('span', { 'data-icon': true }, icon as ReactNode)

  it('applies a spread attribute on a nested element', async () => {
    const { content } = await interpretMDX({
      source: "<Card icon={<svg><path {...{ d: 'M0 0L10 10', stroke: 'red', style: { fill: 'none' } }} /></svg>} />",
      components: { Card },
    })
    expect(render(content)).toBe(
      '<span data-icon="true"><svg><path d="M0 0L10 10" stroke="red" style="fill:none"></path></svg></span>',
    )
  })

  it('renders an array of strings and elements as the children of a nested element', async () => {
    const { content } = await interpretMDX({
      source: "<Card icon={<span>{['A', 'B', <i key=\"c\">C</i>]}</span>} />",
      components: { Card },
    })
    expect(render(content)).toBe('<span data-icon="true"><span>AB<i>C</i></span></span>')
  })

  it('drops an array that holds a plain object', async () => {
    const { content } = await interpretMDX({
      source: "<Card icon={<span>x{['A', { a: 1 }]}</span>} />",
      components: { Card },
    })
    expect(render(content)).toBe('<span data-icon="true"><span>x</span></span>')
  })
})

describe('markup that remote content must not be able to create', () => {
  const Card: ComponentType<Record<string, unknown>> = ({ icon }) =>
    createElement('span', null, icon as ReactNode)
  const run = async (source: string) =>
    render((await interpretMDX({ source, components: { Card } })).content)

  it.each([
    ["<iframe srcDoc={'<script>alert(1)</script>'} />", '<iframe></iframe>'],
    ['<iframe srcdoc="<b>x</b>" />', '<iframe></iframe>'],
    ['<iframe SRCDOC="<b>x</b>" />', '<iframe></iframe>'],
    ["<iframe {...{ srcDoc: '<b>x</b>' }} />", '<iframe></iframe>'],
    ["<Card icon={<iframe srcDoc={'<b>x</b>'} />} />", '<span><iframe></iframe></span>'],
  ])('strips srcDoc from %s', async (source, expected) => {
    expect(await run(source)).toBe(expected)
  })

  it('strips srcDoc from a component prop', async () => {
    const Probe: ComponentType<Record<string, unknown>> = (props) =>
      createElement('div', { 'data-src-doc': String(props.srcDoc), 'data-srcdoc': String(props.srcdoc) })
    const { content } = await interpretMDX({ source: '<Probe srcDoc="<b>x</b>" srcdoc="<b>y</b>" />', components: { Probe } })
    expect(render(content)).toBe('<div data-src-doc="undefined" data-srcdoc="undefined"></div>')
  })

  it('strips raw HTML props from nested elements too', async () => {
    expect(await run("<Card icon={<b dangerouslySetInnerHTML={{ __html: '<img src=x>' }} />} />")).toBe('<span><b></b></span>')
  })

  it('keeps an ordinary embedded iframe', async () => {
    const html = await run('<iframe src="https://www.youtube.com/embed/abc" title="Video" frameBorder="0" allow="autoplay; encrypted-media" allowFullScreen />')
    expect(html).toBe('<iframe src="https://www.youtube.com/embed/abc" title="Video" frameBorder="0" allow="autoplay; encrypted-media" allowFullScreen=""></iframe>')
  })

  it('drops string event handlers and javascript: URLs', async () => {
    const html = await run(
      [
        '<div onClick="alert(1)" onclick="alert(2)" ONCLICK="alert(3)">x</div>',
        '<img src="x" onError="alert(4)" />',
        '<a href="javascript:alert(5)">a</a>',
        '<a href={\' jav\\tascript:alert(6)\'}>b</a>',
        '<iframe src="javascript:alert(7)" />',
        '<form action="javascript:alert(8)"><button formAction="javascript:alert(9)">b</button></form>',
        '<svg><a xlinkHref="javascript:alert(10)"><text>t</text></a></svg>',
      ].join('\n\n'),
    )
    expect(html).not.toMatch(/\bon(click|error)=/i)
    expect(html).not.toMatch(/javascript:/i)
  })

  it.each([
    ['href', '<a href="vbscript:msgbox(1)">a</a>', '<a>a</a>'],
    ['href', '<a href="data:text/html,<script>alert(1)</script>">a</a>', '<a>a</a>'],
    ['href', '<a href=" DaTa:\ntext/html;base64,PHNjcmlwdD4=">a</a>', '<a>a</a>'],
    ['src', '<iframe src="data:text/html,<b>x</b>" />', '<iframe></iframe>'],
    ['data', '<object data="data:text/html,<b>x</b>" type="text/html" />', '<object type="text/html"></object>'],
    ['xlinkHref', '<svg><a xlinkHref="vbscript:x"><text>t</text></a></svg>', '<svg><a><text>t</text></a></svg>'],
    ['action', '<form action="VBScript:x"></form>', '<form></form>'],
    ['formAction', '<button formAction="data:text/html,x">b</button>', '<button>b</button>'],
  ])('drops an unsafe scheme from %s', async (_name, source, expected) => {
    expect(await run(source)).toBe(expected)
  })

  it('keeps data images and ordinary links', async () => {
    const html = await run('<a href="https://example.com/a?b=c">a</a>\n\n<img src="data:image/png;base64,AAAA" alt="" />')
    expect(html).toContain('<a href="https://example.com/a?b=c">a</a>')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
  })

  it.each([
    '<script>alert(1)</script>',
    '<script src="https://evil.test/x.js"></script>',
    '<sCript>alert(1)</sCript>',
    '<svg><script>alert(1)</script></svg>',
    '<base href="https://evil.test/" />',
    '<meta httpEquiv="refresh" content="0;url=https://evil.test" />',
    '<meta http-equiv="refresh" content="0;url=https://evil.test" />',
    '<Card icon={<script>alert(1)</script>} />',
  ])('renders nothing for %s', async (source) => {
    const html = await run(source)
    expect(html).not.toMatch(/<(script|base|meta)/i)
    expect(html).not.toContain('alert(1)')
  })

  it('keeps an ordinary meta element', async () => {
    expect(await run('<meta name="description" content="ok" />')).toContain('name="description"')
  })

  it('stops an SVG animation from retargeting a link or an event attribute', async () => {
    const html = await run(
      '<svg><a><animate attributeName="href" values="javascript:alert(1)" /><text>t</text></a><set attributeName="onmouseover" to="alert(2)" /><animate attributeName="opacity" values="0;1" /></svg>',
    )
    expect(html).not.toMatch(/attributeName="(href|onmouseover)"/)
    expect(html).toContain('attributeName="opacity"')
  })
})

describe('the gate does not depend on attribute case, entities or element kind', () => {
  const Card: ComponentType<Record<string, unknown>> = ({ icon }) =>
    createElement('span', null, icon as ReactNode)
  const Note: ComponentType<Record<string, unknown>> = () => createElement('aside')
  const run = async (source: string) =>
    render((await interpretMDX({ source, components: { Card, Note } })).content)

  it.each([
    ['<iframe SRC="javascript:alert(1)" />', '<iframe></iframe>'],
    ['<iframe sRc="javascript:alert(1)" />', '<iframe></iframe>'],
    ['<iframe src="  &#x09;JaVaScRiPt:alert(1)" />', '<iframe></iframe>'],
    ["<iframe {...{ SRC: 'javascript:alert(1)' }} />", '<iframe></iframe>'],
    ['<iframe src="vbscript:x" />', '<iframe></iframe>'],
    ['<a HREF="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a Href="java&#x09;script:alert(1)">x</a>', '<a>x</a>'],
    ['<a HREF="  &#x09;javascript:alert(1)" target="_self">x</a>', '<a target="_self">x</a>'],
    ['<form ACTION="javascript:alert(1)"><button>x</button></form>', '<form><button>x</button></form>'],
    ['<form><button formaction="javascript:alert(1)">x</button></form>', '<form><button>x</button></form>'],
    ['<form><button FORMACTION="javascript:alert(1)">x</button></form>', '<form><button>x</button></form>'],
    ['<form><input type="submit" formaction="javascript:alert(1)" /></form>', '<form><input type="submit"/></form>'],
    ['<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>', '<svg><a><text>x</text></a></svg>'],
    ['<svg><a XLINK:HREF="javascript:alert(1)"><text>x</text></a></svg>', '<svg><a><text>x</text></a></svg>'],
    ['<svg><a xlink:href="java&#x09;script:alert(1)"><text>x</text></a></svg>', '<svg><a><text>x</text></a></svg>'],
    ['<svg><a HREF="javascript:alert(1)"><text>x</text></a></svg>', '<svg><a><text>x</text></a></svg>'],
    ['<map><area HREF="javascript:alert(1)" /></map>', '<map><area/></map>'],
    ['<math><mi HREF="javascript:alert(1)">x</mi></math>', '<math><mi>x</mi></math>'],
    ['<object DATA="data:text/html,x" />', '<object></object>'],
  ])('drops an unsafe URL under any key case: %s', async (source, expected) => {
    expect(await run(source)).toBe(expected)
  })

  it.each([
    '<x-a onfocus="alert(1)" tabindex="0" autofocus>x</x-a>',
    '<x-a onclick="alert(1)">x</x-a>',
    '<x-a ONCLICK="alert(1)">x</x-a>',
    "<x-a {...{ onclick: 'alert(1)' }}>x</x-a>",
    '<Card icon={<x-a onclick="alert(1)">i</x-a>} />',
    '<Card icon={<iframe SRC="javascript:alert(1)" />} />',
    '<Card onclick="alert(1)" HREF="javascript:alert(1)" />',
  ])('keeps event handlers and unsafe URLs out of %s', async (source) => {
    expect(await run(source)).not.toMatch(/\bon[a-z]+=|javascript:/i)
  })

  it('keeps the safe attributes of an element whose handler was dropped', async () => {
    expect(await run('<x-a onfocus="alert(1)" tabindex="0">x</x-a>')).toBe('<x-a tabindex="0">x</x-a>')
  })

  it('hands a component an empty string where it expected a URL, so it renders as before', async () => {
    const Probe: ComponentType<Record<string, unknown>> = (props) =>
      createElement('code', null, String((props.src as string).length))
    const { content } = await interpretMDX({ source: '<Probe src="data:text/html,x" />', components: { Probe } })
    expect(render(content)).toBe('<code>0</code>')
  })

  it.each([
    ['<Embed src="data:text/html,x" />', ''],
    ['<Embed src="vbscript:x" />', ''],
    ['<Video src="data:text/html,x" />', '<code></code>'],
    ['<Video src="vbscript:x" />', '<code></code>'],
  ])('renders the builtin %s without failing the page', async (source, expected) => {
    const { content } = await interpretMDX({ source, components: useMDXComponents({}) as never })
    expect(render(content)).toBe(expected)
  })

  it('keeps display text that merely starts like a scheme', async () => {
    const html = await run('<a href="/x" title="JavaScript: the language">x</a>\n\n<Card title="data:text/html in docs" />')
    expect(html).toContain('title="JavaScript: the language"')
  })

  it('keeps only string and number values in a style object', async () => {
    expect(await run("<div style={{ color: Note, width: 5, height: '1px', margin: { a: 1 } }}>x</div>")).toBe(
      '<div style="width:5px;height:1px">x</div>',
    )
  })

  it.each(['<plaintext>x</plaintext>', '<svg><svg:script>alert(1)</svg:script></svg>'])('renders nothing for %s', async (source) => {
    expect(await run(source)).not.toMatch(/plaintext|script/i)
  })
})

describe('data props of components', () => {
  const builtin = useMDXComponents({}) as never
  const html = async (source: string, components: Record<string, unknown> = builtin) =>
    render((await interpretMDX({ source, components: components as never })).content)

  it('keeps the tags of an Update', async () => {
    const out = await html('<Update label="v1" description="d" tags={["Added", "Fixed"]}>x</Update>')
    expect(out).toContain('Added')
    expect(out).toContain('Fixed')
  })

  it('keeps the light and dark values of a Color.Item', async () => {
    const out = await html('<Color.Item name="n" value={{ light: "#fff", dark: "#000" }} />')
    expect(out).toContain('background-color:#fff')
    expect(out).toContain('background-color:#000')
  })

  it('keeps the open state of an AccordionGroup', async () => {
    const out = await html(
      '<AccordionGroup defaultValue={["a"]}><Accordion title="a">A</Accordion><Accordion title="b">B</Accordion></AccordionGroup>',
    )
    expect(out).toMatch(/<details id="a"[^>]* open=""/)
    expect(out).not.toMatch(/<details id="b"[^>]* open=""/)
  })

  const Probe: ComponentType<Record<string, unknown>> = (props) =>
    createElement('div', { 'data-props': JSON.stringify(props) })

  it('passes nested plain data to the props that carry data', async () => {
    const out = await html(
      "<Probe tags={['a', 'JavaScript: tips']} pre={['p']} post={['q']} defaultValue={['d']} value={{ light: '#fff', n: [1, true, null] }} actions={[{ label: 'go', href: '/x' }]} />",
      { Probe },
    )
    expect(out).toContain(
      '{&quot;tags&quot;:[&quot;a&quot;,&quot;JavaScript: tips&quot;],&quot;pre&quot;:[&quot;p&quot;],&quot;post&quot;:[&quot;q&quot;],&quot;defaultValue&quot;:[&quot;d&quot;],&quot;value&quot;:{&quot;light&quot;:&quot;#fff&quot;,&quot;n&quot;:[1,true,null]},&quot;actions&quot;:[{&quot;label&quot;:&quot;go&quot;,&quot;href&quot;:&quot;/x&quot;}]}',
    )
  })

  it.each([
    ['an element', "tags={[<b>x</b>]}"],
    ['a function', 'tags={[Probe]}'],
    ['a constructor key', 'value={{ constructor: 1 }}'],
    ['an unsafe URL', "actions={[{ label: 'go', href: 'data:text/html,x' }]}"],
    ['an unevaluated entry', 'tags={["a", unknown]}'],
  ])('drops a data prop that holds %s', async (_name, attribute) => {
    expect(await html(`<Probe ${attribute} />`, { Probe })).toBe('<div data-props="{}"></div>')
  })

  it('keeps data only on components, and not under a prop the builtins read as text', async () => {
    expect(
      await html(
        "<Probe config={{ a: 1 }} items={['a']} href={{ a: 1 }} src={['a']} name={{ a: 1 }} /><div tags={['a']} value={{ a: 1 }} data-x={{ a: 1 }}>x</div>",
        { Probe },
      ),
    ).toBe(
      '<div data-props="{&quot;config&quot;:{&quot;a&quot;:1},&quot;items&quot;:[&quot;a&quot;]}"></div>\n<div>x</div>',
    )
  })

  it('keeps the image list of a custom carousel component', async () => {
    const Carousel: ComponentType<Record<string, unknown>> = ({ images }) =>
      createElement(
        'div',
        null,
        ((images ?? []) as Array<{ src: string; alt: string }>).map((image) =>
          createElement('img', { key: image.src, src: image.src, alt: image.alt }),
        ),
      )
    expect(
      await html(
        "<Carousel images={[{ src: '/a.png', alt: 'A' }, { src: 'https://assets.test/b.png', alt: 'B' }]} />",
        { Carousel },
      ),
    ).toContain('<img src="/a.png" alt="A"/><img src="https://assets.test/b.png" alt="B"/>')
  })

  it('accepts only renderable values where a component draws the prop as a node', async () => {
    const Card: ComponentType<Record<string, unknown>> = ({ icon, title }) =>
      createElement('p', null, icon as ReactNode, title as ReactNode)
    expect(await html("<Card icon={['a', 'b']} title={5} />", { Card })).toBe('<p>ab5</p>')
    expect(await html('<Card icon={{ a: 1 }} title={{ b: 2 }} />', { Card })).toBe('<p></p>')
  })
})

describe('void elements', () => {
  it.each(['<br>text</br>', '<img src="/x.png">text</img>', '<input>text</input>', '<hr>text</hr>'])(
    'render without their children instead of failing the page: %s',
    async (source) => {
      const html = render((await interpretMDX({ source, components: {} })).content)
      expect(html).not.toContain('text')
      expect(html).toMatch(/<(br|img|input|hr)\b/)
    },
  )
})

/** Mirrors a site `Template`: rewrites `{{KEY}}` in every string child, recursively. */
function substitute(node: ReactNode, value: string): ReactNode {
  if (typeof node === 'string') return node.replaceAll('{{KEY}}', value)
  if (!isValidElement(node)) return node
  const el = node as ReactElement<{ children?: ReactNode }>
  return cloneElement(el, undefined, ...Children.map(el.props.children, (c) => substitute(c, value)) ?? [])
}

function Template({ value, children }: { value: string; children?: ReactNode }) {
  return createElement('div', null, substitute(children, value))
}

const fence = '<Template>\n\n```bash\ncurl -H "Authorization: Bearer {{KEY}}"\n```\n\n</Template>'

async function renderFence(value: string, source = fence): Promise<string> {
  const Tpl = (props: Record<string, unknown>) => createElement(Template, { ...props, value } as never)
  const { content } = await interpretMDX({ source, components: { Template: Tpl, pre: Pre, code: Code } as never })
  return render(content)
}

describe('highlighted code is real elements', () => {
  it('a component substituting <X> into a fence shows it as text, not an element', async () => {
    const html = await renderFence('<OPENROUTER_API_KEY>')
    expect(html).toContain('Bearer &lt;OPENROUTER_API_KEY&gt;')
    expect(html).not.toMatch(/<openrouter_api_key/i)
  })

  it('renders a hostile substituted string as text', async () => {
    const html = await renderFence('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('keeps token spans and line classes for normal code', async () => {
    const { content } = await interpretMDX({
      source: '```ts\nconst a = 1 // [!code ++]\nconst b = 2\n```',
      components: { pre: Pre, code: Code } as never,
    })
    const html = render(content)
    expect(html).toMatch(/<span class="thally-line-add"><span style="color:[^"]+">const<\/span>/)
    expect(html).toMatch(/<\/span>\n<span><span style=/)
  })
})

describe('props a component reads as text', () => {
  const components = useMDXComponents({}) as never
  const html = async (source: string, map: Record<string, unknown> = components) =>
    render((await interpretMDX({ source, components: map as never })).content)

  it('does not hand GitHub.Repo a JSX title, which it trims', async () => {
    const out = await html('<GitHub.Repo repo="acme/docs" title={<span>Docs</span>} />')
    expect(out).toMatch(/<strong[^>]*>acme\/docs<\/strong>/)
    expect(out).not.toContain('Docs')
  })

  it.each([
    ['a number', 'title={5}'],
    ['a boolean', 'title'],
    ['a list', "title={['a']}"],
    ['an object', 'title={{ a: 1 }}'],
  ])('falls back to the repository name when the GitHub title is %s', async (_name, attribute) => {
    expect(await html(`<GitHub repo="acme/docs" ${attribute} />`)).toMatch(/<strong[^>]*>acme\/docs<\/strong>/)
  })

  it('renders nothing for a GitHub repository that is not text', async () => {
    expect(await html('<GitHub.Repo repo={<b>acme/docs</b>} title="T" />')).toBe('')
  })

  it.each(['Info', 'Warning', 'Check', 'Danger', 'Error', 'Note', 'Tip', 'Callout'])(
    'keeps a %s that was given a JSX icon and numeric colours',
    async (name) => {
      expect(await html(`<${name} icon={<svg />} color={5} colorDark>Careful</${name}>`)).toContain('Careful')
    },
  )

  // One case per other component whose props are read as text: each crashed the page
  // when an author passed JSX, a number, a bare attribute or an object.
  it.each<[string, string, string | RegExp]>([
    ['CodeBlock', '<CodeBlock language={5} icon={<b>i</b>}>{`const x = 1`}</CodeBlock>', 'const x = 1'],
    ['CodeGroup', '<CodeGroup icon={<b>i</b>} language={5} code>echo hi</CodeGroup>', 'echo hi'],
    ['pre', '<pre icon={5} language={<b>i</b>} code>echo hi</pre>', 'echo hi'],
    ['Card', '<Card title="T" href={<b>x</b>} img={5}>body</Card>', 'body'],
    ['Tile', '<Tile title="T" href img={<b>x</b>}>body</Tile>', 'body'],
    ['Hero', '<Hero title="T" primaryHref={5} primaryLabel={{ a: 1 }} secondaryHref secondaryLabel={{ b: 2 }} />', '>T<'],
    ['Video source', '<Video src={<b>x</b>} />', '<code></code>'],
    ['Video poster', '<Video src="/a.mp4" poster={5} />', '<video'],
    ['Accordion', '<Accordion title={<b>JSX</b>} icon={5}>body</Accordion>', 'body'],
    ['Tooltip', '<Tooltip tip="t" cta="Go" href={5}>word</Tooltip>', 'word'],
    ['Icon', '<Icon icon={<svg />} src={5} />', /^$/],
    ['Step', '<Step title={<b>x</b>} titleSize={5}>body</Step>', 'body'],
    ['Step with a tag name', '<Step title="Go" titleSize="br">body</Step>', '<h3'],
    ['Update', '<Update label={<b>v</b>} date={5} tags={5}>body</Update>', 'body'],
    ['ResponseField', '<ResponseField name="n" pre={5} post>body</ResponseField>', 'body'],
    ['Prompt', '<Prompt description="d" icon={5} actions={5}>text</Prompt>', '>d<'],
    ['Embed', '<Embed src={5} />', /^$/],
    ['LegacyView', '<LegacyView src />', /^$/],
    ['Banner', '<Banner content={{ a: 1 }} />', 'Site banner preview'],
    ['Color.Item', '<Color.Item hex={{ a: 1 }} name="brand" />', 'brand'],
  ])('renders %s when a text prop holds something else', async (_name, source, expected) => {
    const out = await html(source)
    if (typeof expected === 'string') expect(out).toContain(expected)
    else expect(out).toMatch(expected)
  })

  it('never lets a step title size pick the element', async () => {
    const out = await html('<Steps titleSize="iframe"><Step title="Go">body</Step></Steps>')
    expect(out).not.toContain('<iframe')
    expect(out).toContain('<h3')
  })

  it('keeps JSX where the component draws the prop as a node', async () => {
    expect(await html('<Card title={<em>Docs</em>} />')).toContain('<em>Docs</em>')
    expect(await html('<Update label="v1" title={<em>Docs</em>}>x</Update>')).toContain('<em>Docs</em>')
    expect(await html('<Hero title="T" subtitle={<em>sub</em>} />')).toContain('<em>sub</em>')
    expect(await html('<Tooltip tip={<em>tip</em>} headline={<b>H</b>}>w</Tooltip>')).toMatch(/<b>H<\/b>[\s\S]*<em>tip<\/em>/)
    expect(await html('<Badge icon={<svg data-icon />}>b</Badge>')).toContain('<svg data-icon="true">')
  })

  it('keeps valid text and valid titles', async () => {
    expect(await html('<GitHub.Repo repo="acme/docs" title="Docs" />')).toMatch(/<strong[^>]*>Docs<\/strong>/)
    expect(await html('<Step title="Go" titleSize="h2">body</Step>')).toContain('<h2')
  })

  describe('a declared contract', () => {
    const show = (props: Record<string, unknown>) =>
      createElement('div', { 'data-props': JSON.stringify(props, (_key, value) => (isValidElement(value) ? '<element>' : value)) })
    const Probe = withPropContract(show, {
      title: text, repo: requiredText, tags: textOrList, items: textList, size: oneOf('a', 'b'), label: node,
    })

    it('drops what a rule rejects, keeps the rest, and fills in a required prop', async () => {
      expect(
        await html(
          "<Probe title={<b>x</b>} repo={5} tags={5} items={['a', 1]} size=\"c\" label={{ a: 1 }} other={<i>y</i>} constructor={1} />",
          { Probe },
        ),
      ).toBe('<div data-props="{&quot;repo&quot;:&quot;&quot;,&quot;other&quot;:&quot;&lt;element&gt;&quot;,&quot;constructor&quot;:1}"></div>')
    })

    it('keeps what every rule accepts', async () => {
      expect(
        await html("<Probe title=\"T\" repo=\"a/b\" tags=\"x, y\" items={['p']} size=\"a\" label={<b>x</b>} />", { Probe }),
      ).toBe(
        '<div data-props="{&quot;title&quot;:&quot;T&quot;,&quot;repo&quot;:&quot;a/b&quot;,&quot;tags&quot;:&quot;x, y&quot;,&quot;items&quot;:[&quot;p&quot;],&quot;size&quot;:&quot;a&quot;,&quot;label&quot;:&quot;&lt;element&gt;&quot;}"></div>',
      )
    })

    it('applies to a spread attribute and to an element nested in a prop', async () => {
      const Wrap: ComponentType<Record<string, unknown>> = ({ icon }) => createElement('section', null, icon as ReactNode)
      expect(await html('<Probe {...{ title: 5 }} />', { Probe })).toBe('<div data-props="{}"></div>')
      expect(await html('<Wrap icon={<Probe title={<b>x</b>} />} />', { Wrap, Probe })).toBe(
        '<section><div data-props="{}"></div></section>',
      )
    })

    it('is declared on the registry entries whose props only run after hydration', () => {
      expect(Object.keys(propContractOf((components as Record<string, unknown>).View) ?? {})).toEqual(['icon'])
    })
  })

  it('does not apply a built-in contract to a component of the same name that the site registers', async () => {
    const Own: ComponentType<Record<string, unknown>> = ({ title }) =>
      createElement('p', null, title as ReactNode)
    expect(await html('<GitHub title={<span>Docs</span>} />', { GitHub: Own })).toBe('<p><span>Docs</span></p>')
  })
})

describe('metadata a code panel reads from the code it holds', () => {
  const components = useMDXComponents({}) as never
  const html = async (source: string) => render((await interpretMDX({ source, components })).content)

  it.each([
    ['a CodeBlock whose source prop is JSX', '<CodeBlock code={<b>x</b>}><code>x</code></CodeBlock>'],
    ['a CodeBlock whose source prop is a number', '<CodeBlock code={5}><code>x</code></CodeBlock>'],
    ['a code element whose source prop is JSX', '<pre><code code={<b>x</b>}>x</code></pre>'],
    ['a code element whose source prop is a bare attribute', '<pre><code code>x</code></pre>'],
    ['a code element whose language is JSX', '<pre><code language={<b>ts</b>}>x</code></pre>'],
    ['a code element whose icon is a number', '<pre><code icon={5}>x</code></pre>'],
    ['code inside a CodeGroup', '<CodeGroup><code code={<b>x</b>} language={5} icon>x</code></CodeGroup>'],
    ['code inside a CodeBlock', '<CodeBlock language="ts"><code code={5}>x</code></CodeBlock>'],
    ['a request example', '<RequestExample><CodeBlock code={<b>x</b>}><code>x</code></CodeBlock></RequestExample>'],
  ])('renders %s', async (_name, source) => {
    expect(await html(source)).toContain('x')
  })

  it('keeps the metadata of an ordinary code element', async () => {
    const out = await html('<pre><code language="ts" code="const a = 1">const a = 1</code></pre>')
    expect(out).toContain('const a = 1')
    expect(out).toContain('TypeScript')
  })
})

describe('parents that read the props of their children', () => {
  const components = useMDXComponents({}) as never
  const html = async (source: string) => render((await interpretMDX({ source, components })).content)

  it.each([
    ['a JSX title', '<CodeGroup><CodeBlock title={<b>JS</b>}>x</CodeBlock></CodeGroup>'],
    ['a numeric tag', '<CodeGroup><CodeBlock tag={5}>x</CodeBlock></CodeGroup>'],
    ['a bare title on a pre', '<CodeGroup><pre title><code>x</code></pre></CodeGroup>'],
    ['a JSX tag on a code element', '<CodeGroup><code tag={<b>t</b>}>x</code></CodeGroup>'],
    ['a JSX title among several samples', '<CodeGroup><CodeBlock title={<b>JS</b>}>x</CodeBlock><CodeBlock title="Python">y</CodeBlock></CodeGroup>'],
    ['a numeric class name on a code element', '<pre><code className={5}>x</code></pre>'],
    ['a bare class name on a CodeBlock', '<CodeGroup><CodeBlock className>x</CodeBlock></CodeGroup>'],
    ['a numeric class name in a request example', '<RequestExample><CodeBlock className={5}>x</CodeBlock></RequestExample>'],
    ['a class name that is JSX in a response example', '<ResponseExample><pre className={<b>c</b>}><code>x</code></pre></ResponseExample>'],
    ['source, language and icon on a plain element', '<pre><span code={<b>x</b>} language={5} icon>x</span></pre>'],
    ['source on a plain element in a request example', '<RequestExample><pre><span code={<b>x</b>}>x</span></pre></RequestExample>'],
    ['source, language and icon on an element in a group', '<CodeGroup><span code={5} language={<b>ts</b>} icon={5}>x</span></CodeGroup>'],
  ])('renders a code group holding %s', async (_name, source) => {
    expect(await html(source)).toContain('x')
  })

  it('still lists each sample under its text title', async () => {
    const out = await html('<CodeGroup><CodeBlock title="JavaScript">a</CodeBlock><CodeBlock title="Python">b</CodeBlock></CodeGroup>')
    expect(out).toContain('JavaScript')
    expect(out).toContain('Python')
  })

  it('still shows a JSX title where a lone pre renders it', async () => {
    expect(await html('<pre title={<b>JS</b>}><code>x</code></pre>')).toContain('<b>JS</b>')
  })

  it('draws a JSX title on a tab, a card and a step', async () => {
    expect(await html('<Tabs><Tab title={<b>One</b>}>x</Tab></Tabs>')).toContain('<b>One</b>')
    expect(await html('<CardGroup><Card title={<b>Two</b>}>x</Card></CardGroup>')).toContain('<b>Two</b>')
  })
})
