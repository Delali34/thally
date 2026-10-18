/** Scope inference must honor evidence without expanding source network authority. */
import { describe, expect, it } from 'vitest'
import { inferUrlMigrationScope } from '../url-scope.js'
import { extractSourceNavigation } from '../url-navigation.js'
const capture = (body: string, path = '/docs/guides/deep/intro') => ({ body, contentType: 'text/html', finalUrl: new URL(`https://example.com${path}`) })
describe('documentation scope inference', () => {
  it('uses an explicit mounted index from deep articles', () => {
    expect(inferUrlMigrationScope(capture('<link rel="alternate" href="/docs/sitemap.xml"><a href="/docs/llms.txt">LLMs</a>')).scopePath).toBe('/docs')
  })
  it('preserves dedicated origin index roots', () => {
    expect(inferUrlMigrationScope(capture('<a href="/llms.txt">LLMs</a>', '/introduction/start')).scopePath).toBe('/')
  })
  it('rejects other origins, nonancestors and encoded separators', () => {
    expect(inferUrlMigrationScope(capture('<a href="https://evil.test/llms.txt">x</a><a href="/other/llms.txt">x</a><a href="/docs%2fguides/llms.txt">x</a>')).scopePath).toBe('/docs/guides/deep')
  })
  it('uses consistent sidebar evidence and otherwise the source parent', () => {
    expect(inferUrlMigrationScope(capture('<nav><a href="/docs/guides/deep/intro">Intro</a><a href="/docs/sdk/start">SDK</a></nav>')).scopePath).toBe('/docs')
    expect(inferUrlMigrationScope(capture('')).evidence).toBe('source-parent')
  })
  it.each([
    ['Docusaurus', '<aside class="theme-doc-sidebar-container"><nav><a href="/manual/tutorial/install">Install</a><a href="/manual/reference/start">Reference</a></nav></aside>', '/manual/tutorial/install', '/manual'],
    ['generic navigation', '<div role="navigation"><a href="/help/guides/start">Start</a><a href="/help/api/auth">Auth</a></div>', '/help/guides/start', '/help'],
    ['dedicated documentation host', '<aside><a href="/guides/start">Start</a><a href="/reference/auth">Auth</a></aside>', '/guides/start', '/'],
  ])('infers %s roots without host-specific rules', (_platform, body, path, expected) => {
    // These structures differ in renderer and mount; authority remains the
    // captured origin rather than a provider hostname or a hard-coded /docs.
    expect(inferUrlMigrationScope(capture(body, path)).scopePath).toBe(expected)
  })
  it('ignores global header and footer navigation when choosing a mount', () => {
    const body = '<header><nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav></header><nav><a href="/handbook/guide/start">Start</a><a href="/handbook/api/auth">API</a></nav><footer><nav><a href="/company">Company</a></nav></footer>'
    expect(inferUrlMigrationScope(capture(body, '/handbook/guide/start')).scopePath).toBe('/handbook')
  })
  it('resolves config page ids at the mount exactly once', () => {
    const body = '<a href="/docs/llms.txt">LLMs</a><script type="application/json">'+JSON.stringify({docsConfig:{navigation:{pages:['guides/start','/docs/sdk/start',{title:'API',href:'api/start'},{title:'External',href:'https://other.test/page'}]}}})+'</script>'
    expect(extractSourceNavigation(capture(body)).map(item => item.url)).toEqual(['https://example.com/docs/guides/start','https://example.com/docs/sdk/start','https://example.com/docs/api/start','https://other.test/page'])
  })
})
