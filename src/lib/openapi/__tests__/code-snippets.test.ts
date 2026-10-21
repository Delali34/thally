/** Request-language examples must preserve data and never interpret reader-supplied values. */
import { describe, expect, it } from 'vitest'
import { buildRequestSnippet, buildSchemaResponseExample, DOCS_LANGUAGES, formatResponseExample, normalizeDocsLanguage, requestSnippetLineParameters } from '../code-snippets'
import { buildCodeSamples } from '../code-samples'
import type { PreparedRequest } from '@/components/api/use-try-it-controller'

const request: PreparedRequest = {
  url: 'https://api.example.com/pages?title=hello', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Trace': 'trace-1' },
  body: '{\n  "title": "Hello",\n  "draft": false\n}', isServerConfigured: true,
}

describe('request code snippets', () => {
  it('generates all six advertised languages from one prepared request', () => {
    for (const language of DOCS_LANGUAGES) {
      const code = buildRequestSnippet(request, language)
      expect(code).toContain('https://api.example.com/pages?title=hello')
      expect(code.toLowerCase()).toContain('post')
      expect(code).toContain('X-Trace')
      expect(code).toContain('trace-1')
      expect(code).toContain('title')
    }
  })

  it.each(DOCS_LANGUAGES)('keeps the canonical escaping and generator for %s', (language) => {
    const source = { ...request, url: `https://example.com/o'hare?value=\"#{danger}\"`, headers: { 'X-Value': `a'\"\\b #{danger}` }, body: '{"payload":"#{danger} $secret"}' }
    const canonical = buildCodeSamples(source).find((sample) => normalizeDocsLanguage(sample.label) === language)
    expect(buildRequestSnippet(source, language)).toBe(canonical?.source)
  })

  it('preserves authored samples and canonical multipart restrictions', () => {
    const custom = { label: 'Rust', source: 'client.send_request()' }
    expect(buildRequestSnippet(request, 'Rust', [custom])).toBe(custom.source)
    expect(buildRequestSnippet({ ...request, url: '', isServerConfigured: false }, 'Rust', [custom])).toBe(custom.source)
    const form = { ...request, body: undefined, form: [['file', '@upload.png']] as Array<[string, string]> }
    expect(buildRequestSnippet(form, 'cURL')).toContain('--form')
    expect(buildRequestSnippet(form, 'Python')).toBe(buildRequestSnippet(form, 'cURL'))
    expect(buildRequestSnippet(request, 'Java')).toContain('Unirest.post')
  })

  it('omits a body for read-only requests and states missing server configuration', () => {
    expect(buildRequestSnippet({ ...request, method: 'GET', body: undefined }, 'Node.js')).not.toContain('body:')
    expect(buildRequestSnippet({ ...request, url: '', isServerConfigured: false }, 'cURL')).toBe('Configure a server URL to preview this request.')
  })

  it('synchronizes conventional authored aliases and preserves arbitrary labels', () => {
    expect(normalizeDocsLanguage('bash')).toBe('cURL')
    expect(normalizeDocsLanguage('javascript')).toBe('Node.js')
    expect(normalizeDocsLanguage('Next.js')).toBe('Next.js')
  })
})

describe('documented response rendering', () => {
  it('preserves falsy explicit examples and formats JSON source', () => {
    expect(formatResponseExample(false)).toBe('false')
    expect(formatResponseExample(0)).toBe('0')
    expect(formatResponseExample('{"title":"Hello"}')).toBe('{\n  "title": "Hello"\n}')
  })

  it('builds placeholders only from the operation schema, preferring its examples', () => {
    expect(buildSchemaResponseExample({ type: 'object', properties: { title: { type: 'string', example: 'A page' }, count: { type: 'integer' }, draft: { type: 'boolean', default: false } } })).toEqual({ title: 'A page', count: 123, draft: false })
    expect(buildSchemaResponseExample()).toBeUndefined()
    expect(formatResponseExample(undefined)).toBe('No response example is documented.')
  })
})


describe('generated request source metadata', () => {
  const fields = [
    { name: 'id', group: 'path' as const },
    { name: 'limit', group: 'query' as const },
    { name: 'missing', group: 'query' as const },
    { name: 'X-Trace', group: 'header' as const },
    { name: 'title', group: 'body' as const },
  ]
  it.each(DOCS_LANGUAGES)('associates the resolved URL with actual fields for %s', (language) => {
    const prepared = { ...request, url: 'https://api.example.com/posts/123?limit=10' }
    const code = buildRequestSnippet(prepared, language)
    const metadata = requestSnippetLineParameters(code, prepared, fields)
    expect(Object.values(metadata)).toEqual([['id', 'limit']])
    const line = code.split('\n')[Number(Object.keys(metadata)[0])]
    expect(line).toContain('https://api.example.com/posts/123?limit=10')
  })
  it.each(DOCS_LANGUAGES)('uses exact escaped URL serialization for %s', (language) => {
    const prepared = { ...request, url: `https://api.example.com/posts/o'hare?limit=10&quote="yes"` }
    const code = buildRequestSnippet(prepared, language)
    expect(Object.values(requestSnippetLineParameters(code, prepared, fields))).toEqual([['id', 'limit']])
  })
  it('includes unfilled path placeholders, deduplicates fields, and omits absent queries', () => {
    const prepared = { ...request, url: 'https://api.example.com/posts/{id}' }
    const code = buildRequestSnippet(prepared, 'cURL')
    expect(Object.values(requestSnippetLineParameters(code, prepared, [...fields, fields[0]]))).toEqual([['id']])
  })
  it('never adds metadata to an unrelated authored URL or a missing request URL', () => {
    expect(requestSnippetLineParameters('curl "https://api.example.com/posts/123"', { url: 'https://api.example.com/posts/456' }, fields)).toEqual({})
    expect(requestSnippetLineParameters('Configure a server URL.', { url: '' }, fields)).toEqual({})
  })
})
