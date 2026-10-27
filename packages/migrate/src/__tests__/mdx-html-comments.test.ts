/** An MDX comment that holds only an HTML comment keeps its text; every other HTML comment is converted as it always was. */

import { compileSync } from '@mdx-js/mdx'
import { describe, expect, it } from 'vitest'

import { mdxComment, normalizeHtmlComments, normalizeMdx, parseMarkdownPage, replaceOutsideCode } from '../mdx.js'

const compiles = (source: string): void => {
  expect(() => compileSync(source, { format: 'mdx' })).not.toThrow()
}

/** The conversion before an MDX comment was ever looked at: every `<!-- ... -->` outside code, wherever it sits. */
const oracle = (body: string): string => replaceOutsideCode(body, (whole) => whole.replace(/<!--([\s\S]*?)-->/g, (_match, comment: string) => mdxComment(comment)))

describe('an MDX comment whose whole content is one HTML comment', () => {
  const singleLine = 'Before.\n\n{/* <!-- Suggested diagram --> */}\n\nAfter.'
  const multiLine = 'Before.\n\n{/* <!--\nSuggested diagram: "Cold start"\n- Boxes: App -> Local DB\n--> */}\n\nAfter.'

  it.each([
    ['single-line', singleLine, 'Before.\n\n{/* Suggested diagram */}\n\nAfter.'],
    ['multi-line', multiLine, 'Before.\n\n{/*\nSuggested diagram: "Cold start"\n- Boxes: App -> Local DB\n*/}\n\nAfter.'],
  ])('becomes an MDX comment with that text (%s)', (_name, body, expected) => {
    expect(normalizeMdx(body)).toBe(expected)
    expect(normalizeHtmlComments(body)).toBe(expected)
    compiles(expected)
  })

  it('does not leave the closing of the outer comment as visible text', () => {
    const page = parseMarkdownPage({ id: 'sync/partial', raw: `---\ntitle: Partial sync\n---\n\n${multiLine}\n`, source: 'sync/partial.mdx', platform: 'mintlify' })
    expect(page?.body).toBe('Before.\n\n{/*\nSuggested diagram: "Cold start"\n- Boxes: App -> Local DB\n*/}\n\nAfter.')
    expect(page?.body).not.toContain('{/* {/*')
  })

  it.each([
    ['spaced braces', '{ /* <!-- note --> */ }', '{/* note */}'],
    ['no space after the marker', '{/*<!--note-->*/}', '{/*note*/}'],
    ['two in a row and text around them', 'a {/* <!-- one --> */} b {/*\n<!-- two -->\n*/} c', 'a {/* one */} b {/* two */} c'],
    ['an ordinary HTML comment between them', '{/* <!-- one --> */}\n\n<!-- two -->\n\n{/* <!-- three --> */}', '{/* one */}\n\n{/* two */}\n\n{/* three */}'],
  ])('is read with %s', (_name, body, expected) => {
    expect(normalizeHtmlComments(body)).toBe(expected)
    expect(normalizeMdx(body)).toBe(expected)
    compiles(expected)
  })

  it('is left alone in a code fence and in inline code', () => {
    const body = '```mdx\n{/* <!-- note --> */}\n```\n\nUse `{/* <!-- note --> */}` here.'
    expect(normalizeMdx(body)).toBe(body)
    expect(normalizeHtmlComments(body)).toBe(body)
  })

  it('is found among thousands of unfinished openers in a bounded time', () => {
    const body = `${'{/*<!--'.repeat(20_000)} -->\n\n{/* <!-- note --> */}`
    const startedAt = performance.now()
    expect(normalizeHtmlComments(body)).toBe(oracle(body.replace('{/* <!-- note --> */}', '{/* note */}')))
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })
})

describe('every other HTML comment', () => {
  // [name, source]. Each must convert exactly as it did before, and the result must compile.
  const cases: Array<[string, string]> = [
    ['an ordinary comment', '<!-- prettier-ignore -->'],
    ['a multi-line comment', 'Before.\n\n<!--\nline one\nline two\n-->\n\nAfter.'],
    ['a `{/*` in a double-quoted value (the repro that excluded a page)', '<span title="{/*">x</span>\n\n<!-- note -->\n\n{/* later */}'],
    ['a `{/*` in a single-quoted value', "<span title='{/*'>x</span>\n\n<!-- note -->\n\n{/* later */}"],
    ['a `-->` in a value', '<span title="-->">x</span>\n\n<!-- note -->'],
    ['a `*/}` in a value', '<span title="*/}">x</span>\n\n{/* c */}\n\n<!-- note -->'],
    ['a `<!--` in a value', '<span title="a <!-- b --> c">x</span>\n\n<!-- note -->'],
    ['a `{/*` inside an expression value', '<Foo bar={{ a: "{/*" }}>x</Foo>\n\n<!-- note -->\n\n{/* later */}'],
    ['a `>` inside an expression value', '<Foo n={1 > 0} />\n\n<!-- note -->'],
    ['nested tags', '<Card title="{/*"><Tab title="a">x</Tab></Card>\n\n<!-- note -->\n\n{/* later */}'],
    ['a self-closing tag', '<Icon name="{/*" />\n\n<!-- note -->\n\n{/* later */}'],
    ['a `<` that is not a tag', 'a < b and c > d\n\n<!-- note -->\n\n{/* later */}'],
    ['a tag in a fenced block', '```mdx\n<span title="{/*">\n<!-- keep -->\n```\n\n<!-- note -->\n\n{/* later */}'],
    ['a `{/*` in inline code', 'Use `{/*` to open.\n\n<!-- note -->\n\n{/* later */}'],
    ['a tag inside an MDX comment', '{/* <span title="x"> */}\n\n<!-- note -->'],
    ['a tag inside an HTML comment', '<!-- <span title="x"> -->\n\n{/* later */}'],
    ['an HTML comment that holds an MDX comment', '<!-- a {/* b */} c -->\n\n{/* later */}'],
    ['an MDX comment with no HTML comment in it', '{/* just a note */}\n\n<!-- note -->'],
  ]

  it.each(cases)('converts %s as before', (_name, source) => {
    expect(normalizeHtmlComments(source)).toBe(oracle(source))
    compiles(normalizeHtmlComments(source))
    compiles(normalizeMdx(source))
  })

  it.each([
    ['text beside the HTML comment', '{/* see <!-- a --> here */}'],
    ['text before the HTML comment', '{/* see <!-- a --> */}'],
    ['a `*/` in the HTML comment', '{/* <!-- a */ b --> */}'],
    ['a second `-->` after the first', '{/* <!-- a --> b --> */}'],
  ])('still converts an HTML comment that shares an MDX comment with other text (%s) as before', (_name, source) => {
    expect(normalizeHtmlComments(source)).toBe(oracle(source))
  })
})
