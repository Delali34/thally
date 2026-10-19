/** Regression tests for code-fence metadata shared by authored and migrated docs. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { Element, ElementContent, Root, Text } from 'hast'

import { codeInnerHtml } from './__tests__/test-html'
import {
  applyCodeNotation,
  measureHighlightableCode,
  parseCodeFenceMeta,
  rehypePlugins,
  reserveSyntaxHighlightOutput,
  scheduleSyntaxHighlight,
  type SyntaxHighlightBudget,
} from './rehype'

function codeBlock(value: string, language = 'txt'): Element {
  return {
    type: 'element',
    tagName: 'pre',
    properties: { language },
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: {},
        children: [{ type: 'text', value }],
      },
    ],
  }
}

async function transformCodeBlocks(blocks: Array<Element>): Promise<void> {
  const transform = rehypePlugins[1]() as (tree: Root) => Promise<void>
  await transform({ type: 'root', children: blocks })
}

function codeText(block: Element): Text {
  return ((block.children[0] as Element).children[0] as Text)
}

function renderedCodeText(block: Element): string {
  const text = (node: ElementContent): string => node.type === 'text' ? node.value
    : node.type === 'element' ? node.children.map(text).join('') : ''
  return (block.children[0] as Element).children.map(text).join('')
}

describe('code-fence parsing', () => {
  it('does not stamp a language on the parent of inline code', () => {
    const paragraph: Element = {
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: '/parse' }] }],
    }
    const fence: Element = {
      type: 'element',
      tagName: 'pre',
      properties: {},
      children: [{ type: 'element', tagName: 'code', properties: { className: ['language-js'] }, children: [{ type: 'text', value: 'x' }] }],
    }
    ;(rehypePlugins[0]() as (tree: Root) => void)({ type: 'root', children: [paragraph, fence] })
    expect(paragraph.properties).toEqual({})
    expect(fence.properties?.language).toBe('js')
  })
})

describe('code-fence metadata', () => {
  it('does not display renderer presentation props as code titles', () => {
    expect(parseCodeFenceMeta('theme={"system"}')).toEqual({})
    expect(parseCodeFenceMeta('api-client.ts theme={"system"}')).toEqual({ title: 'api-client.ts' })
  })

  it('keeps explicit filenames and portable display options', () => {
    expect(parseCodeFenceMeta('filename="client.ts" wrap {2,4-5}')).toEqual({
      title: 'client.ts',
      wrap: true,
      highlight: [2, 4, 5],
    })
  })

  it('keeps framework tags separate from the syntax grammar and filename', () => {
    expect(
      parseCodeFenceMeta('framework="Next.js" filename="app/page.tsx"'),
    ).toEqual({
      tag: 'Next.js',
      title: 'app/page.tsx',
    })
  })

  it('keeps syntax grammars fine-grained for managed Worker bundles', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./rehype.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain("from 'shiki/core'")
    expect(source).toContain("from 'shiki/langs/typescript.mjs'")
    expect(source).not.toContain("from '@shikijs/langs/")
    expect(source).not.toContain('createHighlighter,')
    expect(source).not.toContain('.loadLanguage(')
    expect(source).toContain('MAX_HIGHLIGHTED_CODE_BLOCK_BYTES')
    expect(source).toContain('MAX_HIGHLIGHTED_PAGE_BYTES')
    expect(source).toContain('measureHighlightableCode(code)')
  })

  it('bounds authored highlight ranges before allocating them', () => {
    const parsed = parseCodeFenceMeta('{1-4000000000}')
    expect(parsed.highlight).toHaveLength(1_000)
    expect(parsed.highlight?.at(-1)).toBe(1_000)
  })

  it('keeps oversized or exceptionally tall fences out of syntax highlighting', () => {
    expect(measureHighlightableCode('a'.repeat(64 * 1024))).toBe(64 * 1024)
    expect(measureHighlightableCode('a'.repeat(64 * 1024 + 1))).toBeNull()
    expect(measureHighlightableCode('😀'.repeat(16_384))).toBe(64 * 1024)
    expect(measureHighlightableCode('😀'.repeat(16_385))).toBeNull()
    expect(measureHighlightableCode('😀'.repeat(20_000))).toBeNull()
    expect(measureHighlightableCode('line\n'.repeat(2_000))).toBeNull()
    expect(measureHighlightableCode('line\n'.repeat(1_999))).not.toBeNull()
  })

  it('stops measuring fences after the aggregate page budget is exhausted', () => {
    const budget: SyntaxHighlightBudget = {
      scheduledBlocks: 0,
      scheduledBytes: 0,
      scheduledWork: 0,
      isExhausted: false,
    }
    for (let block = 0; block < 4; block += 1) {
      expect(scheduleSyntaxHighlight('a'.repeat(64 * 1024), budget)).toBe(true)
    }
    expect(budget.isExhausted).toBe(true)
    expect(scheduleSyntaxHighlight('later fence', budget)).toBe(false)
    expect(budget).toMatchObject({ scheduledBlocks: 4, scheduledBytes: 256 * 1024 })
  })

  it('leaves oversized plaintext as a raw text node (React escapes it)', async () => {
    const payload = '<img src=x onerror=alert(1)>' + 'a'.repeat(64 * 1024)
    const block = codeBlock(payload)
    await transformCodeBlocks([block])
    expect(codeText(block).value).toBe(payload)
  })

  it.each([65, 271])('highlights every one of %i small examples and preserves rendered/copy text', async count => {
    const blocks = Array.from({ length: count }, (_value, index) => codeBlock(`const value${index} = ${index}`, 'ts'))
    await transformCodeBlocks(blocks)
    for (const [index, block] of blocks.entries()) {
      expect(codeInnerHtml(block)).toContain('var(--shiki-token-keyword)')
      expect(renderedCodeText(block)).toBe(`const value${index} = ${index}`)
      expect(block.properties?.code).toBe(`const value${index} = ${index}`)
    }
  })

  it('bounds tiny and empty fences by fixed work even when their bytes are negligible', () => {
    const budget: SyntaxHighlightBudget = { scheduledBlocks: 0, scheduledBytes: 0, scheduledWork: 0, isExhausted: false }
    for (let index = 0; index < 1_024; index++) expect(scheduleSyntaxHighlight('', budget)).toBe(true)
    expect(scheduleSyntaxHighlight('x', budget)).toBe(false)
    expect(budget).toMatchObject({ scheduledBlocks: 1_024, scheduledBytes: 0, scheduledWork: 256 * 1024, isExhausted: true })
  })

  it('keeps content after the tiny-fence work limit as escaped plaintext', async () => {
    const blocks = Array.from({ length: 1_024 }, () => codeBlock('', 'ts'))
    const overflow = codeBlock('<script>literal()</script>', 'ts')
    await transformCodeBlocks([...blocks, overflow])
    expect((blocks.at(-1)!.children[0] as Element).children[0].type).toBe('element')
    expect(codeText(overflow).value).toBe('<script>literal()</script>')
    expect(codeInnerHtml(overflow)).toContain('&#60;script&#62;literal()&#60;/script&#62;')
    expect(overflow.properties?.code).toBe('<script>literal()</script>')
  })

  it('bounds raw notation source before stripping it or tokenizing its smaller result', async () => {
    const payload = '// [!code highlight]\n'.repeat(4_000)
    const block = codeBlock(payload, 'ts')
    await transformCodeBlocks([block])
    expect(codeText(block).value).toBe(payload)
    expect(block.properties?.code).toBe(payload)
  })

  it('rejects oversized fences without consuming capacity needed by a later small block', () => {
    const budget: SyntaxHighlightBudget = { scheduledBlocks: 0, scheduledBytes: 0, scheduledWork: 0, isExhausted: false }
    expect(scheduleSyntaxHighlight('😀'.repeat(16_385), budget)).toBe(false)
    expect(scheduleSyntaxHighlight('const ok = true', budget)).toBe(true)
    expect(budget.scheduledBlocks).toBe(1)
  })

  it('reserves output atomically and shares node/escaped-byte limits between blocks', () => {
    const token = { content: '<&"\'', color: 'var(--shiki-token-string)', offset: 0 }
    const budget = { nodes: 99_997, bytes: 0, isExhausted: false }
    expect(reserveSyntaxHighlightOutput([[token]], budget)).toBe(true)
    expect(budget.nodes).toBe(100_000)
    const reservedBytes = budget.bytes
    expect(reserveSyntaxHighlightOutput([[token]], budget)).toBe(false)
    expect(budget).toMatchObject({ nodes: 100_000, bytes: reservedBytes, isExhausted: true })
    const bytes = { nodes: 0, bytes: 8 * 1024 * 1024 - 300, isExhausted: false }
    expect(reserveSyntaxHighlightOutput([[{ ...token, content: '&'.repeat(10) }]], bytes)).toBe(false)
    expect(bytes.nodes).toBe(0)
    expect(bytes.bytes).toBe(8 * 1024 * 1024 - 300)
  })

  it('stops expanding shared output and preserves overflow as escaped plaintext', async () => {
    const payload = 'const value = "text";\n'.repeat(1_000)
    const blocks = Array.from({ length: 8 }, () => codeBlock(payload, 'ts'))
    const overflow = codeBlock('<img src=x onerror=alert(1)>', 'ts')
    await transformCodeBlocks([...blocks, overflow])
    const highlighted = blocks.filter(block => (block.children[0] as Element).children[0].type === 'element')
    expect(highlighted.length).toBeGreaterThan(0)
    expect(highlighted.length).toBeLessThan(blocks.length)
    expect(codeText(overflow).value).toBe('<img src=x onerror=alert(1)>')
    expect(codeInnerHtml(overflow)).toContain('&#60;img src=x onerror=alert(1)&#62;')
    expect(renderedCodeText(overflow)).toBe('<img src=x onerror=alert(1)>')
    expect(overflow.properties?.code).toBe('<img src=x onerror=alert(1)>')
  })

  it('preserves Mermaid source for the strict diagram renderer', async () => {
    const block = codeBlock('flowchart LR\nA[Client] --> B[API]', 'mermaid')
    await transformCodeBlocks([block])

    expect(block.properties?.code).toBe('flowchart LR\nA[Client] --> B[API]')
    expect(codeText(block).value).toBe('flowchart LR\nA[Client] --> B[API]')
  })

  it('ignores reversed and wholly out-of-bounds highlight ranges', () => {
    expect(parseCodeFenceMeta('{5-2}').highlight).toEqual([])
    expect(parseCodeFenceMeta('{100001-100002}').highlight).toEqual([])
  })
})

describe('heading anchors', () => {
  it('gives repeated headings distinct IDs in document order', () => {
    const headings: Array<Element> = ['Key Features', 'Key Features', 'Next'].map((value) => ({
      type: 'element', tagName: 'h3', properties: {}, children: [{ type: 'text', value }],
    }))
    const transform = rehypePlugins[2]() as (tree: Root) => void
    transform({ type: 'root', children: headings })
    expect(headings.map((heading) => heading.properties?.id)).toEqual([
      'key-features', 'key-features-2', 'next',
    ])
  })

  it('avoids a generated suffix colliding with an authored heading ID', () => {
    const headings: Array<Element> = [
      { type: 'element', tagName: 'h2', properties: { id: 'key-features-2' }, children: [{ type: 'text', value: 'Custom' }] },
      { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Key Features' }] },
      { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Key Features' }] },
    ]
    const transform = rehypePlugins[2]() as (tree: Root) => void
    transform({ type: 'root', children: headings })
    expect(headings.map((heading) => heading.properties?.id)).toEqual(['key-features-2', 'key-features', 'key-features-3'])
  })

  it('uses a trailing {/* #id */} comment as the heading id and removes the comment', () => {
    const marker = (value: string) => ({ type: 'mdxTextExpression', value }) as unknown as Element['children'][number]
    const headings: Array<Element> = [
      { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Scrape + Interact ' }, marker('/* #scrape-+-interact */')] },
      { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Primeros pasos ' }, marker('/* #get-started */')] },
      { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Get started' }] },
      { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Otra ' }, marker('/* #get-started */')] },
    ]
    const transform = rehypePlugins[2]() as (tree: Root) => void
    transform({ type: 'root', children: headings })
    expect(headings.map((heading) => heading.properties?.id)).toEqual([
      'scrape-+-interact', 'get-started', 'get-started-2', 'get-started-3',
    ])
    expect(headings[0].children).toEqual([{ type: 'text', value: 'Scrape + Interact' }])
  })

  it('reserves an explicit comment id so generated duplicates skip it', () => {
    const marker = (value: string) => ({ type: 'mdxTextExpression', value }) as unknown as Element['children'][number]
    const plain = (): Element => ({ type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Foo' }] })
    const headings: Array<Element> = [
      plain(), plain(),
      { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Foo ' }, marker('/* #foo-2 */')] },
    ]
    const transform = rehypePlugins[2]() as (tree: Root) => void
    transform({ type: 'root', children: headings })
    expect(headings.map((heading) => heading.properties?.id)).toEqual(['foo', 'foo-3', 'foo-2'])
  })

  it('applies the comment id in a real MDX compile', async () => {
    const { compile } = await import('@mdx-js/mdx')
    const compiled = String(await compile('## Scrape + Interact {/* #scrape-+-interact */}\n\n## Scrape + Interact', {
      rehypePlugins: [rehypePlugins[2]],
    }))
    expect(compiled).toContain('id: "scrape-+-interact"')
    expect(compiled).toContain('id: "scrape-interact"')
    expect(compiled).not.toContain('#scrape-+-interact */')
  })

  it('keeps the @, slashes, doubled dashes and typographic quotes of a comment id', async () => {
    const { compile } = await import('@mdx-js/mdx')
    const compiled = String(await compile([
      '## `@trigger.dev/sdk/v3` {/* #@trigger-dev/sdk/v3 */}',
      '## `out.writer({ execute })` {/* #out-writer--execute- */}',
      '## \u201cStream is deleted\u201d {/* #\u201dstream-is-deleted\u201d */}',
    ].join('\n\n'), { rehypePlugins: [rehypePlugins[2]] }))
    expect(compiled).toContain('id: "@trigger-dev/sdk/v3"')
    expect(compiled).toContain('id: "out-writer--execute-"')
    expect(compiled).toContain('id: "\u201dstream-is-deleted\u201d"')
  })

  it('preserves Unicode heading IDs and suffixes repeated translated headings', () => {
    const headings: Array<Element> = ['Überblick', 'Überblick', '日本語 API'].map((value) => ({
      type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value }],
    }))
    const transform = rehypePlugins[2]() as (tree: Root) => void
    transform({ type: 'root', children: headings })
    expect(headings.map((heading) => heading.properties?.id)).toEqual([
      'überblick', 'überblick-2', '日本語-api',
    ])
  })
})

describe('step title heading ids', () => {
  /** Every `id` the compiled page carries, in document order. */
  async function ids(source: string): Promise<Array<string>> {
    const { compile } = await import('@mdx-js/mdx')
    const compiled = String(await compile(source, { rehypePlugins: [rehypePlugins[2]] }))
    return [...compiled.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1])
  }

  it('numbers step titles with the page headings in document order', async () => {
    expect(await ids([
      '## Deploy', '',
      '<Steps titleSize="h3">', '<Step title="Create a project">', 'Body', '</Step>', '<Step title="Deploy">', 'Body', '</Step>', '</Steps>', '',
      '## Deploy',
    ].join('\n'))).toEqual(['deploy', 'create-a-project', 'deploy-2', 'deploy-3'])
  })

  it.each([
    ['no titleSize', '<Steps>\n<Step title="One">x</Step>\n</Steps>'],
    ['titleSize="p"', '<Steps titleSize="p">\n<Step title="One">x</Step>\n</Steps>'],
    ['a Step with titleSize="p"', '<Steps titleSize="h3">\n<Step title="One" titleSize="p">x</Step>\n</Steps>'],
    ['a titleSize expression', '<Steps titleSize={size}>\n<Step title="One">x</Step>\n</Steps>'],
    ['a title expression', '<Steps titleSize="h3">\n<Step title={"One"}>x</Step>\n</Steps>'],
    ['an empty title', '<Steps titleSize="h3">\n<Step title="">x</Step>\n</Steps>'],
  ])('leaves a step title that is not a heading alone: %s', async (_name, source) => {
    expect(await ids(source)).toEqual([])
  })

  it('lets a Step keep its own size over its Steps, including inside a wrapper', async () => {
    expect(await ids([
      '<Steps titleSize="p">', '<Step title="A" titleSize="h4">x</Step>', '<Step title="B">x</Step>', '</Steps>', '',
      '<Steps titleSize="h2">', '<div>', '<Step title="C">x</Step>', '</div>', '</Steps>',
    ].join('\n'))).toEqual(['a', 'c'])
  })

  it('numbers repeated step titles, such as one set per View, so each keeps its own id', async () => {
    const steps = '<Steps titleSize="h3">\n<Step title="Create a key">x</Step>\n<Step title="Verify the key">x</Step>\n</Steps>'
    expect(await ids(['curl', 'Go'].map((title) => `<View title="${title}">\n${steps}\n</View>`).join('\n\n')))
      .toEqual(['create-a-key', 'verify-the-key', 'create-a-key-2', 'verify-the-key-2'])
  })

  it('does not let a generated step id take an id a heading reserves', async () => {
    expect(await ids('<Steps titleSize="h3">\n<Step title="Deploy">x</Step>\n</Steps>\n\n## Other {/* #deploy */}'))
      .toEqual(['deploy-2', 'deploy'])
  })
})

describe('code-fence metadata tokenizer', () => {
  it('joins multi-word bare titles', () => {
    expect(parseCodeFenceMeta('Example title here')).toEqual({ title: 'Example title here' })
  })

  it('never turns boolean flags into titles, in any position', () => {
    expect(parseCodeFenceMeta('lines')).toEqual({ lines: true })
    expect(parseCodeFenceMeta('expandable nocopy twoslash')).toEqual({ expandable: true, nocopy: true })
    expect(parseCodeFenceMeta('My File lines expandable')).toEqual({ title: 'My File', lines: true, expandable: true })
    expect(parseCodeFenceMeta('twoslash app.ts')).toEqual({ title: 'app.ts' })
    expect(parseCodeFenceMeta('wrap Example lines')).toEqual({ title: 'Example', wrap: true, lines: true })
  })

  it('handles quoted titles containing spaces, equals signs and braces', () => {
    expect(parseCodeFenceMeta('title="a = {b} c d"')).toEqual({ title: 'a = {b} c d' })
    expect(parseCodeFenceMeta("title='It is done' wrap")).toEqual({ title: 'It is done', wrap: true })
    expect(parseCodeFenceMeta('filename="my file.ts"')).toEqual({ title: 'my file.ts' })
  })

  it('lets an explicit title override bare words', () => {
    expect(parseCodeFenceMeta('bare words title="Real"')).toEqual({ title: 'Real' })
    expect(parseCodeFenceMeta('title="Real" bare words')).toEqual({ title: 'Real' })
  })

  it('combines braces and highlight= with focus and caps', () => {
    expect(parseCodeFenceMeta('{1,3} highlight={5-6} focus={2,4-5}')).toEqual({
      highlight: [5, 6],
      focus: [2, 4, 5],
    })
    expect(parseCodeFenceMeta('focus={1-4000000000}').focus).toHaveLength(1_000)
    expect(parseCodeFenceMeta('focus={5-2}').focus).toEqual([])
  })

  it('reads icon with and without quotes and braces', () => {
    expect(parseCodeFenceMeta('icon="python"')).toEqual({ icon: 'python' })
    expect(parseCodeFenceMeta('icon=square-js Title')).toEqual({ icon: 'square-js', title: 'Title' })
    expect(parseCodeFenceMeta('icon={"python"}')).toEqual({ icon: 'python' })
  })

  it('supports nocopy="false" and ignores unknown keys and JSON-ish groups', () => {
    expect(parseCodeFenceMeta('nocopy="false"')).toEqual({ nocopy: false })
    expect(parseCodeFenceMeta('nocopy')).toEqual({ nocopy: true })
    expect(parseCodeFenceMeta('mystery=value other="two words" Title')).toEqual({ title: 'Title' })
    expect(parseCodeFenceMeta('theme={"system"} lines')).toEqual({ lines: true })
    expect(parseCodeFenceMeta('')).toEqual({})
    expect(parseCodeFenceMeta('   ')).toEqual({})
  })

  it('keeps Windows paths and dotted filenames as titles', () => {
    expect(parseCodeFenceMeta('C:\\src\\app.config.ts')).toEqual({ title: 'C:\\src\\app.config.ts' })
    expect(parseCodeFenceMeta('docker-compose.prod.yml lines')).toEqual({ title: 'docker-compose.prod.yml', lines: true })
  })

  it('tolerates unterminated quotes and groups', () => {
    expect(parseCodeFenceMeta('title="oops')).toEqual({ title: 'oops' })
    expect(parseCodeFenceMeta('{1,2')).toEqual({ highlight: [1, 2] })
  })
})

describe('code notation markers', () => {
  it('strips markers for several comment styles and marks lines', () => {
    const code = [
      'a // [!code ++]',
      'b # [!code --]',
      'c <!-- [!code highlight] -->',
      'd -- [!code focus]',
      'e /* [!code ++] */',
      'plain',
    ].join('\n')
    const result = applyCodeNotation(code)!
    expect(result.code).toBe('a\nb\nc\nd\ne\nplain')
    expect([...result.marks.add]).toEqual([1, 5])
    expect([...result.marks.remove]).toEqual([2])
    expect([...result.marks.highlight]).toEqual([3])
    expect([...result.marks.focus]).toEqual([4])
  })

  it('expands :N counts to the current and following lines', () => {
    const result = applyCodeNotation('a // [!code ++:3]\nb\nc\nd')!
    expect(result.code).toBe('a\nb\nc\nd')
    expect([...result.marks.add]).toEqual([1, 2, 3])
  })

  it('returns null for fences without markers', () => {
    expect(applyCodeNotation('const a = 1 // not a marker')).toBeNull()
  })

  it('leaves plain fences unchanged in rendered output and code prop', async () => {
    const block = codeBlock('const a = 1\nconst b = 2', 'typescript')
    await transformCodeBlocks([block])
    expect(block.properties?.code).toBe('const a = 1\nconst b = 2')
    expect(codeInnerHtml(block)).not.toContain('class=')
  })

  it('strips markers from rendered HTML and copied code, and adds line classes', async () => {
    const block = codeBlock('const a = 1 // [!code ++]\nconst b = 2 // [!code --]\nconst c = 3', 'typescript')
    await transformCodeBlocks([block])
    expect(block.properties?.code).toBe('const a = 1\nconst b = 2\nconst c = 3')
    const html = codeInnerHtml(block)
    expect(html).not.toContain('[!code')
    expect(html).toContain('thally-line-add')
    expect(html).toContain('thally-line-remove')
  })

  it('dims non-focused lines for focus= and focus markers', async () => {
    const block = codeBlock('one\ntwo // [!code focus]\nthree', 'txt')
    block.properties = { ...block.properties, focusLines: '3' }
    await transformCodeBlocks([block])
    const spans = codeInnerHtml(block).split('\n')
    expect(spans[0]).toContain('thally-line-dim')
    expect(spans[1]).not.toContain('thally-line-dim')
    expect(spans[2]).not.toContain('thally-line-dim')
  })

  it('does not touch mermaid fences', async () => {
    const source = 'graph TD\nA-->B // [!code ++]'
    const block = codeBlock(source, 'mermaid')
    await transformCodeBlocks([block])
    expect(block.properties?.code).toBe(source)
  })

  it('lifts new meta options onto the pre element', () => {
    const pre = codeBlock('x', 'txt')
    ;(pre.children[0] as Element).data = { meta: 'My Title lines expandable nocopy icon="python" focus={2}' } as never
    const parse = rehypePlugins[0]() as (tree: Root) => void
    parse({ type: 'root', children: [pre] })
    expect(pre.properties).toMatchObject({
      title: 'My Title',
      lines: '',
      expandable: '',
      nocopy: '',
      icon: 'python',
      focusLines: '2',
    })
  })
})

describe('placeholder tokens', () => {
  it('keeps a {{KEY}} placeholder in one highlighted token so children-walking templates can substitute it', async () => {
    const block = codeBlock('payload = {\n    "model": "{{MODEL}}",\n    "n": {{N}}\n}', 'python')
    await transformCodeBlocks([block])
    const html = codeInnerHtml(block)
    expect(html).toContain('>{{MODEL}}</span>')
    expect(html).toContain('>{{N}}</span>')
  })
})
