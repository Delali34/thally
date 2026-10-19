/** An OpenAPI description is CommonMark; a page's meta tags carry it as one line of plain text, as Mintlify's do. */

import { describe, expect, it } from 'vitest'
import { markdownToPlainText } from '../plain-text.js'

describe('markdownToPlainText', () => {
  // [description as the spec writes it, the meta description trigger.dev serves]
  it.each([
    ['Without a `filter[createdAt]` value, only runs created in the last 7 days are returned. See [runs.list() best practices](/runs/list-best-practices).',
      'Without a filter[createdAt] value, only runs created in the last 7 days are returned. See runs.list() best practices.'],
    ['**Private beta:** [request access](https://trigger.dev/webhooks-beta) to use webhooks. Its status becomes `inactive` and its URL responds with `404`.',
      'Private beta: request access to use webhooks. Its status becomes inactive and its URL responds with 404.'],
    ['Send a JSON body (use `{}` when you have no fields to set).', 'Send a JSON body (use {} when you have no fields to set).'],
    ['Phase 1 of the batch API.\nCreates a batch record.\n\nStream items next.', 'Phase 1 of the batch API. Creates a batch record. Stream items next.'],
  ])('reads %j as one plain line', (markdown, expected) => {
    expect(markdownToPlainText(markdown)).toBe(expected)
  })

  it('keeps the text of URL and email autolinks', () => {
    expect(markdownToPlainText('Contact <support@example.com> or <https://example.com>.'))
      .toBe('Contact support@example.com or https://example.com.')
  })

  it('keeps the words of a link and drops its destination', () => {
    expect(markdownToPlainText('See [the guide](/guide "Guide") and [again][ref].\n\n[ref]: /other'))
      .toBe('See the guide and again.')
  })

  it('keeps inline code text, including markup characters inside it', () => {
    expect(markdownToPlainText('Set `retries` to `**3**`, not `null`.')).toBe('Set retries to **3**, not null.')
  })

  it('strips emphasis and images, and keeps identifiers with underscores and stars intact', () => {
    expect(markdownToPlainText('Use *either* _form_ or __both__, see ![diagram](/x.png) and the batch_scrape.started event, 2 * 3 * 4.'))
      .toBe('Use either form or both, see diagram and the batch_scrape.started event, 2 * 3 * 4.')
  })

  it('drops raw HTML tags and comments but keeps the text between them', () => {
    expect(markdownToPlainText('Use it <b>now</b>, <br/>then <!-- internal -->wait.\n\n<div>\nBlock <em>text</em>\n</div>'))
      .toBe('Use it now, then wait. Block text')
  })

  it('keeps braces and angle brackets that are not markup', () => {
    expect(markdownToPlainText('Fetch /runs/{runId} when 1 < 2 and a<b.')).toBe('Fetch /runs/{runId} when 1 < 2 and a<b.')
  })

  it('keeps a backslash-escaped character as written', () => {
    expect(markdownToPlainText('Escaped \\*stars\\* and \\<tag\\>.')).toBe('Escaped *stars* and <tag>.')
  })

  it('separates paragraphs, list items, hard breaks and table cells with a space', () => {
    expect(markdownToPlainText('First paragraph.\n\nSecond paragraph.')).toBe('First paragraph. Second paragraph.')
    expect(markdownToPlainText('- one\n- two\n\nline  \nbreak')).toBe('one two line break')
    expect(markdownToPlainText('| a | b |\n| - | - |\n| c | d |')).toBe('a b c d')
  })

  it('returns an empty line for nothing', () => {
    expect(markdownToPlainText('  \n ')).toBe('')
  })
})
