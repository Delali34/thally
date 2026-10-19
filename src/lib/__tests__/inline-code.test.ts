/** The runtime's inline-code helpers read titles exactly as the content parser and `thally check` do. */

import { describe, expect, it } from 'vitest'
import { inlineCodeParts as coreParts, plainInlineText as corePlain } from '@thallylabs/core/slugify'
import { inlineCodeParts, plainInlineText } from '../inline-code'

describe('inline code helpers', () => {
  it.each([
    'Run the CLI `init` command',
    'Don\'t use this in parallel, e.g. with `Promise.all()`',
    '`a`b',
    '`one` and `two`',
    'Use the ` key',
    'Empty `` pair',
    '**bold** and `x`',
    'Create a project',
    '',
  ])('matches @thallylabs/core for %j', (title) => {
    expect(inlineCodeParts(title)).toEqual(coreParts(title))
    expect(plainInlineText(title)).toBe(corePlain(title))
  })

  it('reads the plain text of the code runs it splits out', () => {
    for (const title of ['Run the CLI `init` command', '`a`b', 'Create a project']) {
      expect(inlineCodeParts(title).map((part) => part.text).join('')).toBe(plainInlineText(title))
    }
  })
})
