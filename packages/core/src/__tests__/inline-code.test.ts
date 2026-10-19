/** Title strings read inline code the way Mintlify renders it: the text between backticks is code, the backticks are markup. */

import { describe, expect, it } from 'vitest'
import { inlineCodeParts, plainInlineText } from '@thallylabs/core/slugify'

describe('inlineCodeParts', () => {
  it('splits a title into text and code runs in order', () => {
    expect(inlineCodeParts('Don\'t use this in parallel, e.g. with `Promise.all()`')).toEqual([
      { text: 'Don\'t use this in parallel, e.g. with ', code: false },
      { text: 'Promise.all()', code: true },
    ])
    expect(inlineCodeParts('Run the CLI `init` command')).toEqual([
      { text: 'Run the CLI ', code: false },
      { text: 'init', code: true },
      { text: ' command', code: false },
    ])
  })

  it('returns a title without code as one text run, and nothing for an empty title', () => {
    expect(inlineCodeParts('Create a project')).toEqual([{ text: 'Create a project', code: false }])
    expect(inlineCodeParts('')).toEqual([])
  })

  it('leaves an unpaired backtick and an empty pair as text', () => {
    expect(inlineCodeParts('Use the ` key')).toEqual([{ text: 'Use the ` key', code: false }])
    expect(inlineCodeParts('Empty `` pair')).toEqual([{ text: 'Empty `` pair', code: false }])
  })

  it('keeps other Markdown characters as text', () => {
    expect(inlineCodeParts('**bold** and `x`')).toEqual([
      { text: '**bold** and ', code: false },
      { text: 'x', code: true },
    ])
  })
})

describe('plainInlineText', () => {
  it.each([
    ['Run the CLI `init` command', 'Run the CLI init command'],
    ['Create an `actions.ts` file', 'Create an actions.ts file'],
    ['Create a project', 'Create a project'],
    ['Use the ` key', 'Use the ` key'],
  ])('reads %s as %s', (input, expected) => {
    expect(plainInlineText(input)).toBe(expected)
  })
})
