/** Public-app integration for portable migration output; shared package tests
 * must remain independent of this application's renderer and API registry. */

import { load } from 'cheerio'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { extractEmbeddedOpenApi, htmlPage, sanitizeRemoteMarkdown } from '../../../packages/migrate/src/url'
import { Code } from '@/components/mdx/code-blocks'
import { interpretMDX } from '@/lib/mdx-interpret'
import { findSpecForRef, parseOpenApiFrontmatter } from '@/lib/openapi/page-frontmatter'

describe('migrated content in the public runtime', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])('renders %i backslashes before table pipes without changing text, code or link destinations', async (count) => {
    const value = `before${'\\'.repeat(count)}|after`
    const body = `<article><h1>Escaped pipes</h1><table><tr><th>Text</th><th>Code</th><th>Link</th></tr><tr><td>${value}</td><td><code>${value}</code></td><td><a href="https://safe.test/search?q=one|two">${value}</a></td></tr></table></article>`
    const page = htmlPage({ body, finalUrl: new URL('https://docs.test/'), contentType: 'text/html' }, 'pipes', { omitDocumentHeading: true }).page!
    expect(sanitizeRemoteMarkdown(page.body)).toBe(page.body)
    const rendered = await interpretMDX({ source: page.body, components: { code: Code } })
    const $ = load(renderToStaticMarkup(rendered.content))
    expect($('tbody tr').children('td').toArray().map((node) => $(node).text())).toEqual([value, value, value])
    expect($('tbody code').text()).toBe(value)
    const destination = new URL($('tbody a').attr('href')!)
    expect(destination.origin).toBe('https://safe.test')
    expect(destination.searchParams.get('q')).toBe('one|two')
  })

  it('renders encoded code syntax literally without creating executable or formatted content', async () => {
    const value = '\\|</code><script>{globalThis.process.exit()}</script> & **literal** `ticks` [link](javascript:alert(1))'
    const body = `<article><h1>Code</h1><table><tr><th>Code</th></tr><tr><td><code>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></td></tr></table></article>`
    const page = htmlPage({ body, finalUrl: new URL('https://docs.test/'), contentType: 'text/html' }, 'literal', { omitDocumentHeading: true }).page!
    expect(sanitizeRemoteMarkdown(page.body)).toBe(page.body)
    const rendered = await interpretMDX({ source: page.body, components: { code: Code } })
    const $ = load(renderToStaticMarkup(rendered.content))
    expect($('tbody code').text()).toBe(value)
    expect($('tbody script,strong,a').length).toBe(0)
  })

  it('binds a migrated operation to its registered local page-only specification', () => {
    const result = extractEmbeddedOpenApi('```yaml ../../outside.yaml get /v1/chains/{chainId}\nopenapi: 3.0.2\npaths:\n  /v1/chains/{chainId}:\n    get:\n      responses: {}\n```')
    expect(result.fragment?.path).toBe('/v1/chains/{chainId}')
    const source = 'openapi/migration-1234.json'
    const reference = parseOpenApiFrontmatter(`${source} ${result.openapi}`)!
    expect(reference).toMatchObject({ specRef: source, method: 'GET', path: '/v1/chains/{chainId}' })
    expect(findSpecForRef([{ id: 'operation-1234', label: 'API', source: { type: 'file', path: source }, pageOnly: true }], reference.specRef!)?.id).toBe('operation-1234')
    expect(findSpecForRef([], reference.specRef!)).toBeNull()
  })
})
