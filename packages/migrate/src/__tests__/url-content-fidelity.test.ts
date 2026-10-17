/** Reduced source fixtures cover content fidelity without trusting remote MDX. */

import { readFileSync } from 'node:fs'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

import { htmlPage, migrationHtmlArticle, sanitizeRemoteMarkdown } from '../url.js'

const fixture = readFileSync(new URL('./fixtures/mintlify-article-chrome.html', import.meta.url), 'utf8')

describe('rendered documentation content boundaries', () => {
  it('shares the article boundary across conversion and technical evidence', () => {
    const { $, root } = migrationHtmlArticle(fixture)
    expect(root.find('pre').toArray().map((node) => $(node).text())).toEqual([
      'curl --request GET \\\n  --url https://li.quest/v1/status',
      '/v1/advanced/stepTransaction?skipSimulation=true\n\n/v1/quote?skipSimulation=true&...\n',
    ])
    expect(root.find('textarea,nav,[aria-label="Navigate to header"]').length).toBe(0)
    expect(root.find('img').length).toBe(0)
    expect(root.find('a[href]').toArray().map((node) => $(node).attr('href'))).toEqual(['/guides/latency'])
  })

  it('keeps heading text, inline formatting, source anchors, tables and examples', () => {
    const { page } = htmlPage({ body: fixture, finalUrl: new URL('https://docs.li.fi/guides/latency'), contentType: 'text/html' }, 'latency', {
      preserveAnchors: true, omitDocumentHeading: true,
    })
    expect(page?.title).toBe('Latency')
    expect(page?.body).toContain('<a id="optimizing-response-timing" />\n\n## Optimizing Response Timing')
    expect(page?.body).toContain('### Choosing Between `/quote` and `/advanced/routes`')
    expect(page?.body).toContain('[timing strategies](https://docs.li.fi/guides/latency)')
    expect(page?.body).toContain('| status | enum&lt;string&gt; |')
    expect(page?.body).toContain('curl --request GET \\\n  --url https://li.quest/v1/status')
    expect(page?.body).not.toMatch(/^#{1,6}\s*$/m)
    expect(page?.body).not.toMatch(/Assistant|\u200b|Navigate to header/)
    const content = page!.body.replace(/<a id="[^"]*" \/>/g, '')
    const tree = unified().use(remarkParse).use(remarkMdx).parse(content)
    expect(tree.children.filter((node) => node.type === 'heading').map((node) => node.depth)).toEqual([2, 3])
    expect(sanitizeRemoteMarkdown(content)).not.toBeNull()
  })

  it('prefers nested article content and keeps unknown article controls reviewable', () => {
    const { root } = migrationHtmlArticle('<main><p>Outside chrome</p><article><h1>API</h1><textarea id="payload">API input</textarea><select><option>JSON</option></select><input name="token"><p>Article description.</p></article></main>')
    expect(root.is('article')).toBe(true)
    expect(root.text()).not.toContain('Outside chrome')
    expect(root.find('textarea,select,input').length).toBe(3)
  })

  it('keeps authored additional H1 sections beneath the frontmatter document title', () => {
    const document = {
      body: '<article><h1 id="title">API key security</h1><p>Overview remains.</p><h1 id="protect"><em>Protect</em> your API key</h1><p>Keep your key private.</p><h1 id="rotate">Rotate <code>apiKey</code></h1><p>Replace compromised credentials.</p></article>',
      finalUrl: new URL('https://docs.li.fi/api-key-security'), contentType: 'text/html',
    }
    const imported = htmlPage(document, 'security', { omitDocumentHeading: true, preserveAnchors: true }).page!
    expect(imported.title).toBe('API key security')
    expect(imported.body).toContain('<a id="title" />')
    expect(imported.body).toContain('<a id="protect" />\n\n## _Protect_ your API key')
    expect(imported.body).toContain('<a id="rotate" />\n\n## Rotate `apiKey`')
    expect(imported.body).toContain('Overview remains.')
    expect(imported.body).toContain('Keep your key private.')
    expect(imported.body).toContain('Replace compromised credentials.')
    expect(imported.body).not.toMatch(/^# /m)
    const ordinary = htmlPage(document, 'security').page!
    expect(ordinary.body.match(/^# /gm)).toHaveLength(3)
  })

  it('projects known API server options once and keeps unknown controls and diagrams reviewable', () => {
    const body = '<article><h1>API</h1><select id="servers" aria-label="Select base URL"><option value="0" selected>https://li.quest</option><option value="1">https://staging.li.quest</option></select><svg class="lucide lucide-chevrons-up-down"></svg><div id="parameter-key"><a href="#parameter-key" aria-label="Navigate to header">​<svg></svg></a>API key</div><details><summary data-component-part="expandable-button"><svg data-component-part="icon-svg"></svg>Show attributes</summary><p>Nested fields.</p></details><svg id="architecture-diagram"><text>Architecture</text></svg><select aria-label="Format"><option>JSON</option></select></article>'
    const { $, root } = migrationHtmlArticle(body)
    expect(root.find('select').toArray().map((node) => $(node).attr('aria-label'))).toEqual(['Format'])
    expect(root.find('svg').toArray().map((node) => $(node).attr('id'))).toEqual(['architecture-diagram'])
    expect(root.find('[id="parameter-key"]').text()).toBe('API key')
    expect(root.find('a[href]').toArray().map((node) => $(node).attr('href'))).toEqual(['https://li.quest/', 'https://staging.li.quest/'])
    const page = htmlPage({ body, finalUrl: new URL('https://docs.li.fi/'), contentType: 'text/html' }, 'api', { omitDocumentHeading: true }).page!
    expect(page.body).toContain('Select base URL')
    expect(page.body).toContain('[https://li.quest](https://li.quest/) (selected)')
    expect(page.body).toContain('[https://staging.li.quest](https://staging.li.quest/)')
  })

  it('recognizes observed Chinese API controls while keeping their labels and anchor IDs', () => {
    const body = '<article><h1>API</h1><select aria-label="选择基础URL"><option value="0" selected>https://li.quest</option><option value="1">https://staging.li.quest</option></select><div id="parameter-key"><a href="#parameter-key" aria-label="导航到标题">​<svg></svg></a>API key</div></article>'
    const { $, root } = migrationHtmlArticle(body)
    expect(root.find('select,svg').length).toBe(0)
    expect(root.find('[id="parameter-key"]').text()).toBe('API key')
    expect(root.find('a').toArray().map((node) => $(node).text())).toEqual(['https://li.quest', 'https://staging.li.quest'])
    const page = htmlPage({ body, finalUrl: new URL('https://docs.li.fi/'), contentType: 'text/html' }, 'api', { omitDocumentHeading: true, preserveAnchors: true }).page!
    expect(page.body).toContain('选择基础URL')
    expect(page.body).toContain('<a id="parameter-key" />')
  })

  it.each(['javascript:alert(1)', 'http://plain.test', 'https://user:pass@example.test', 'https://good.test Label', 'https://good.test/a b', 'https:good.test', 'https://good.\ntest'])('keeps unvalidated base URL options reviewable: %s', (option) => {
    const { root } = migrationHtmlArticle(`<article><select aria-label="Select base URL"><option>https://safe.test</option><option>${option}</option></select></article>`)
    expect(root.find('select').length).toBe(1)
    expect(root.find('[data-thally-static-base-urls]').length).toBe(0)
  })
})

describe('remote Markdown syntax classification', () => {
  it('preserves escaped generic types and tag-shaped code as inert text', () => {
    const body = 'The response has type enum\\<string> and literal \\<Unknown />.\n\n`<script>alert(1)</script>`\n\n```html\n<script>alert(1)</script>\n```'
    expect(sanitizeRemoteMarkdown(body)).toBe(body)
  })

  it.each([
    'enum\\<string>\n\n<Unknown />',
    'enum\\<string>\n\n<Note.Component />',
    'enum\\<string>\n\n<script>alert(1)</script>',
    'enum\\<string>\n\n<>fragment</>',
    'enum\\<string>\n\n{globalThis.process.exit()}',
    'enum\\<string>\n\n<Note {...props} />',
    'enum\\<string>\n\n<Note title={globalThis.process.exit()} />',
    'enum\\<string>\n\n<Card href="javascript:alert(1)">Bad URL</Card>',
    'enum\\<string>\n\nexport const execute = () => alert(1)',
  ])('rejects executable or unsupported AST syntax alongside escaped prose: %s', (body) => {
    expect(sanitizeRemoteMarkdown(body)).toBeNull()
  })

  it('continues removing event handlers and unsafe encoded destinations', () => {
    const body = '<Card title="API" href="/api" onClick={() => alert(1)}>Docs</Card>\n\n[bad](java&#x73;cript:alert%281%29)'
    const result = sanitizeRemoteMarkdown(body)
    expect(result).toContain('<Card title="API" href="/api">Docs</Card>')
    expect(result).not.toMatch(/onClick|alert|javascript|&#x73;/)
  })
})

describe('HTML table inline fidelity', () => {
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx)

  it('preserves authored linked code, code spans and emphasis in real reference tables', () => {
    const body = readFileSync(new URL('./fixtures/mintlify-inline-tables.html', import.meta.url), 'utf8')
    const page = htmlPage({ body, finalUrl: new URL('https://docs.li.fi/'), contentType: 'text/html' }, 'tables', { omitDocumentHeading: true }).page!
    expect(page.body).toContain('| `fromChain` | number | Yes | Source chain ID (e.g., `1` for Ethereum, `8453` for Base) |')
    expect(page.body).toContain('**Vault/staking/deposit token address.** This is what triggers Composer.')
    expect(page.body).toContain('[`fetch`](https://developer.mozilla.org/en-US/docs/Web/API/fetch) options to pass to the request.')
    const tree = parser.parse(page.body)
    expect(tree.children.filter((node) => node.type === 'table').map((node) => node.children.length)).toEqual([4, 2])
    expect(sanitizeRemoteMarkdown(page.body)).toBe(page.body)
  })

  it('keeps table delimiters, multiline copy and hostile-looking text inert', () => {
    const body = '<article><h1>Types</h1><table><tr><th>Value</th><th>Description</th></tr><tr><td><code>a|b  &lt;string&gt;</code></td><td><em>Use either</em><br><strong>Keep both.</strong> &lt;script&gt;alert(1)&lt;/script&gt; {globalThis.process.exit()} <a href="javascript:alert(1)">unsafe link</a> <img src="data:image/svg+xml,bad" alt="Unsafe image"></td></tr></table></article>'
    const page = htmlPage({ body, finalUrl: new URL('https://docs.test/'), contentType: 'text/html' }, 'types', { omitDocumentHeading: true }).page!
    const tree = parser.parse(page.body)
    const table = tree.children.find((node) => node.type === 'table')!
    expect(table.children.map((row) => row.children.length)).toEqual([2, 2])
    expect(table.children[1].children[0].children).toContainEqual(expect.objectContaining({ type: 'inlineCode', value: 'a|b  <string>' }))
    expect(page.body).toContain('_Use either_')
    expect(page.body).toContain('**Keep both.**')
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &#123;globalThis.process.exit()&#125;')
    expect(page.body).not.toMatch(/javascript:|data:image/)
    expect(sanitizeRemoteMarkdown(page.body)).toBe(page.body)
  })
})

describe('static source task lists', () => {
  it('keeps disabled task checkbox states in both shared evidence and GFM output', () => {
    const original = readFileSync(new URL('./fixtures/mintlify-task-list.html', import.meta.url), 'utf8')
    const body = original.replace('type="checkbox" disabled=""', 'type="checkbox" disabled="" checked=""')
    const { $, root } = migrationHtmlArticle(body)
    expect(root.find('input').length).toBe(0)
    expect(root.find('[data-thally-static-task-checkbox]').toArray().map((node) => $(node).text())).toEqual(['[x] ', '[ ] ', '[ ] ', '[ ] ', '[ ] ', '[ ] '])
    const page = htmlPage({ body, finalUrl: new URL('https://docs.li.fi/agents/workflows/approvals'), contentType: 'text/html' }, 'approvals', { omitDocumentHeading: true }).page!
    const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMdx).parse(page.body)
    const list = tree.children.find((node) => node.type === 'list')!
    expect(list.children.map((node) => node.checked)).toEqual([true, false, false, false, false, false])
    expect(page.body).toContain('`fromToken.address` is NOT `0x0000...0000` (native token)')
    expect(sanitizeRemoteMarkdown(page.body)).toBe(page.body)
  })

  it('retains enabled or non-task inputs for explicit review', () => {
    const { root } = migrationHtmlArticle('<article><ul><li class="task-list-item"><input type="checkbox">Enabled input</li><li><input type="checkbox" disabled>Unknown input</li></ul></article>')
    expect(root.find('input').length).toBe(2)
  })
})
