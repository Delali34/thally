/** Authored and generated code use the same conservative field-name associations. */
import { describe, expect, it } from 'vitest'
import { parametersForCodeLine } from './code-parameter-links'

describe('documented code parameter links', () => {
  it('links discoverable cURL path placeholders and query names', () => {
    expect(parametersForCodeLine('curl "https://example.com/projects/{project_id}?limit=10&after=page_1"', ['project_id', 'limit', 'after'])).toEqual(['project_id', 'limit', 'after'])
    expect(parametersForCodeLine('  --url "https://example.com/projects/%7Bproject_id%7D?limit=10"', ['project_id', 'limit'])).toEqual(['project_id', 'limit'])
  })
  it('links cURL header and query arguments by their documented names', () => {
    expect(parametersForCodeLine('  -H "X-Trace: abc"', ['X-Trace'])).toEqual(['X-Trace'])
    expect(parametersForCodeLine("  --header 'Authorization: Bearer $TOKEN'", ['Authorization'])).toEqual(['Authorization'])
    expect(parametersForCodeLine("  --data-urlencode 'title=Hello'", ['title'])).toEqual(['title'])
    expect(parametersForCodeLine("  --url-query 'limit=10'", ['limit'])).toEqual(['limit'])
  })
  it('never infers a parameter from opaque values or mentions inside a JSON string', () => {
    expect(parametersForCodeLine('curl "https://example.com/projects/123?search=title"', ['project_id', 'title'])).toEqual([])
    expect(parametersForCodeLine('  "message": "title is required"', ['title'])).toEqual(['message'])
    expect(parametersForCodeLine('  --header "X-Trace: title"', ['title'])).toEqual([])
  })
  it('keeps all exact JSON field associations in a serialized body', () => {
    expect(parametersForCodeLine('data="{\\"title\\":\\"Hello\\",\\"userId\\":23}"', ['title', 'userId'])).toEqual(['title', 'userId'])
  })
  it('escapes punctuation in documented names instead of treating it as regex', () => {
    expect(parametersForCodeLine('curl "https://example.com/?a.b=1"', ['a.b'])).toEqual(['a.b'])
    expect(parametersForCodeLine('curl "https://example.com/?axb=1"', ['a.b'])).toEqual([])
  })
})
