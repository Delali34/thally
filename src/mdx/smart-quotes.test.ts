/** Typographic quote rules: the text rules and which parts of a tree they may touch. */

import { describe, expect, it } from 'vitest'

import { smartenQuotes, smartenTree } from './smart-quotes'

describe('smartenQuotes', () => {
  it.each([
    ['It doesn\'t', 'It doesn’t'],
    ['the users\' data', 'the users’ data'],
    ['"Investigate a failed deployment"', '“Investigate a failed deployment”'],
    ['\'quoted\' word', '‘quoted’ word'],
    ['He said "go" now', 'He said “go” now'],
    ['("quoted") and [\'this\'] and {"that"}', '(“quoted”) and [‘this’] and {“that”}'],
    ['a—"quoted"', 'a—“quoted”'],
    ['a–"quoted"', 'a–“quoted”'],
    ['non-"standard"', 'non-“standard”'],
    ['say "hi."', 'say “hi.”'],
  ])('converts %j', (input, expected) => {
    expect(smartenQuotes(input)).toBe(expected)
  })

  it('nests single quotes inside double quotes and the reverse', () => {
    expect(smartenQuotes('He said, "\'Quoted\' words in a larger quote."'))
      .toBe('He said, “‘Quoted’ words in a larger quote.”')
    expect(smartenQuotes('She said "he\'s \'fine\'"'))
      .toBe('She said “he’s ‘fine’”')
    expect(smartenQuotes('\'"Hello"\' she said')).toBe('‘“Hello”’ she said')
  })

  it('gives dropped-digit apostrophes the closing form and keeps quoted numbers as quotes', () => {
    expect(smartenQuotes('the \'90s and \'00s')).toBe('the ’90s and ’00s')
    expect(smartenQuotes('class of \'99.')).toBe('class of ’99.')
    expect(smartenQuotes('the value \'42\' here')).toBe('the value ‘42’ here')
    expect(smartenQuotes('\'1990s\'')).toBe('‘1990s’')
  })

  it('opens at the start of the text, or after the previous character when one is given', () => {
    expect(smartenQuotes('"x"')).toBe('“x”')
    expect(smartenQuotes('"', '')).toBe('“')
    expect(smartenQuotes('"', ' ')).toBe('“')
    expect(smartenQuotes('"', 'x')).toBe('”')
    expect(smartenQuotes('\'', '(')).toBe('‘')
    expect(smartenQuotes('\'', 'x')).toBe('’')
  })

  it('does not convert dashes or ellipses, and returns quote-free text untouched', () => {
    expect(smartenQuotes('a -- b --- c... d')).toBe('a -- b --- c... d')
    expect(smartenQuotes('"a -- b..."')).toBe('“a -- b...”')
    const plain = 'Nothing to change here.'
    expect(smartenQuotes(plain)).toBe(plain)
  })

  it('leaves existing typographic quotes alone', () => {
    expect(smartenQuotes('“Already” ‘done’')).toBe('“Already” ‘done’')
  })
})

type Child = Record<string, unknown>

const text = (value: string): Child => ({ type: 'text', value })
const element = (tagName: string, children: Array<Child>, properties: Record<string, unknown> = {}): Child =>
  ({ type: 'element', tagName, properties, children })
const jsx = (name: string, children: Array<Child>, attributes: Array<Child> = [], type = 'mdxJsxFlowElement'): Child =>
  ({ type, name, attributes, children })
const root = (...children: Array<Child>) => ({ type: 'root', children }) as { children: Array<unknown> }

/** The text of every text node, in document order. */
function texts(node: unknown): Array<string> {
  const { type, value, children } = node as { type: string; value?: string; children?: Array<unknown> }
  return type === 'text' ? [value ?? ''] : (children ?? []).flatMap(texts)
}

describe('smartenTree', () => {
  it('carries the quote context across inline elements', () => {
    const tree = root(element('p', [text('"'), element('em', [text('word')]), text('"')]))
    smartenTree(tree)
    expect(texts(tree)).toEqual(['“', 'word', '”'])
  })

  it('starts a new block with an opening quote', () => {
    const tree = root(element('p', [text('end')]), element('p', [text('"start"')]))
    smartenTree(tree)
    expect(texts(tree)).toEqual(['end', '“start”'])
  })

  it('leaves inline code straight and closes a quote that follows it', () => {
    const tree = root(element('p', [text('Run "'), element('code', [text('it\'s "x"')]), text('" now')]))
    smartenTree(tree)
    expect(texts(tree)).toEqual(['Run “', 'it\'s "x"', '” now'])
  })

  it.each(['kbd', 'samp', 'script', 'style', 'math', 'textarea'])('leaves <%s> text alone', (tagName) => {
    const tree = root(element('p', [element(tagName, [text('it\'s "x"')])]))
    smartenTree(tree)
    expect(texts(tree)).toEqual(['it\'s "x"'])
  })

  it('leaves a code fence alone, highlighted or not', () => {
    const fence = element('pre', [element('code', [element('span', [text('echo "it\'s"')])])], { language: 'bash' })
    const tree = root(fence, element('p', [text('It\'s')]))
    smartenTree(tree)
    expect(texts(tree)).toEqual(['echo "it\'s"', 'It’s'])
  })

  it('leaves an element with a data-language role alone', () => {
    const tree = root(
      element('div', [text('say "x"')], { dataLanguage: 'ts' }),
      jsx('section', [text('say "y"')], [{ type: 'mdxJsxAttribute', name: 'data-language', value: 'ts' }]),
    )
    smartenTree(tree)
    expect(texts(tree)).toEqual(['say "x"', 'say "y"'])
  })

  it('converts link text but not the href or other properties', () => {
    const link = element('a', [text('It\'s "here"')], { href: 'https://example.com/it\'s?q="x"', title: 'It\'s' })
    const tree = root(element('p', [link]))
    smartenTree(tree)
    expect(texts(tree)).toEqual(['It’s “here”'])
    expect(link.properties).toEqual({ href: 'https://example.com/it\'s?q="x"', title: 'It\'s' })
  })

  it('converts the children of a JSX component but not its attributes', () => {
    const attributes = [{ type: 'mdxJsxAttribute', name: 'title', value: 'Don\'t "panic"' }]
    const card = jsx('Card', [element('p', [text('It\'s "fine"')])], attributes)
    smartenTree(root(card))
    expect(texts(card)).toEqual(['It’s “fine”'])
    expect(attributes).toEqual([{ type: 'mdxJsxAttribute', name: 'title', value: 'Don\'t "panic"' }])
  })

  it('leaves code-like JSX components and lowercase code tags alone', () => {
    const source = 'A["it\'s"]'
    const names = ['Latex', 'Mermaid', 'Terminal', 'TerminalInput', 'TerminalOutput', 'Prompt', 'AgentPrompt', 'CodeBlock', 'code']
    const tree = root(...names.map((name) => jsx(name, [text(source)])))
    smartenTree(tree)
    expect(texts(tree)).toEqual(names.map(() => source))
  })

  it('treats a JSX expression as words between the quotes', () => {
    const tree = root(element('p', [text('"'), { type: 'mdxTextExpression', value: 'name' }, text('"')]))
    smartenTree(tree)
    expect(texts(tree)).toEqual(['“', '”'])
  })
})
