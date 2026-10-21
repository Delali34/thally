/** Code lines preserve untrusted text, expose field links, and keep numbering outside source. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/components/docs/code-actions-provider', () => ({ useDocsCodeActions: () => ({ hasAssistantEntryPoint: false }) }))
import { CodeCard, CodeLines, LanguageMenu, parameterForCodeLine, parametersForCodeLine, resolveDocsLanguage } from './code-card'

describe('code-card rendering', () => {
  it('uses the latest compatible choice from the existing shared language history', () => {
    expect(resolveDocsLanguage(['cURL', 'Python'], ['Python', 'Go'])).toBe('Python')
    expect(resolveDocsLanguage(['cURL', 'Node.js'], ['JavaScript'])).toBe('Node.js')
    expect(resolveDocsLanguage(['cURL', 'Rust'], ['Rust', 'Python'])).toBe('Rust')
    expect(resolveDocsLanguage(undefined, ['Rust', 'Python'])).toBe('Python')
  })
  it('tags JSON keys and escapes HTML in response/request values', () => {
    const html = renderToStaticMarkup(<CodeCard title="Response"><CodeLines code={'{\n  "title": "<img onerror=alert(1)>",\n  "count": 12\n}'} /></CodeCard>)
    expect(html).toContain('data-p="title"')
    expect(html).toContain('data-p="count"')
    expect(html).toContain('sx-p')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('data-line-number')
  })
  it('renders a menu trigger instead of language tabs without accessing browser APIs on the server', () => {
    const html = renderToStaticMarkup(<LanguageMenu value="Python" onChange={() => {}} />)
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('Python')
    expect(html).not.toContain('role="tab"')
  })
  it('links every field represented by a serialized request body line', () => {
    const line = '    data="{\\"title\\":\\"Hello\\",\\"userId\\":23}"'
    expect(parametersForCodeLine(line, ['title', 'userId'])).toEqual(['title', 'userId'])
    const html = renderToStaticMarkup(<CodeLines code={line} parameters={['title', 'userId']} />)
    expect(html).toContain('data-parameters="[&quot;title&quot;,&quot;userId&quot;]"')
  })
  it('merges explicit resolved-URL associations without changing the source', () => {
    const code = ['curl', "  --url 'https://example.com/posts/123?limit=10'"].join('\n')
    const html = renderToStaticMarkup(<CodeLines code={code} parameters={['id', 'limit']} lineParameters={{ 1: ['id', 'limit'] }} />)
    expect(html).toContain('data-parameters="[&quot;limit&quot;,&quot;id&quot;]"')
    expect(html).toContain('https://example.com/posts/123?limit=10')
  })
  it('matches parameter names literally including regex metacharacters', () => {
    expect(parametersForCodeLine('  "message": "title is missing"', ['title'])).toEqual(['message'])
    expect(parameterForCodeLine('  --header \'X-Trace: abc\'', ['X-Trace'])).toBe('X-Trace')
    expect(parameterForCodeLine('  --url "https://example.com?a.b=one"', ['a.b'])).toBe('a.b')
    expect(parameterForCodeLine('  --url "https://example.com?axb=one"', ['a.b'])).toBeUndefined()
  })
})
