/** Reduced source fixtures cover content fidelity without trusting remote MDX. */

import { readFileSync } from 'node:fs'
import { compile } from '@mdx-js/mdx'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

import { htmlPage, migrationHtmlArticle, sanitizeRemoteMarkdown } from '../url.js'

const fixture = readFileSync(new URL('./fixtures/mintlify-article-chrome.html', import.meta.url), 'utf8')

describe('HTML code language fidelity', () => {
  const blocks = (body: string) => {
    const page = htmlPage({ body: `<article><h1>Examples</h1>${body}</article>`, finalUrl: new URL('https://docs.test/examples'), contentType: 'text/html' }, 'examples').page!
    return unified().use(remarkParse).parse(page.body).children.filter((node) => node.type === 'code')
  }

  it('preserves Shiki language attributes and exact payloads across mixed examples', () => {
    // Reduced observed publisher markup: Shiki supplies language attributes
    // without language-* classes. Payload-based guessing would mislabel curl.
    const result = blocks('<pre class="shiki shiki-themes" language="shellscript"><code language="shellscript">npm install @lifi/perps-sdk</code></pre><pre class="shiki" language="typescript"><code language="typescript">import { createPerpsClient } from \'@lifi/perps-sdk\'\nconst client = createPerpsClient({ apiKey: process.env.LIFI_API_KEY! })</code></pre><pre language="text"><code language="text">curl --header \'x-lifi-api-key: YOUR_CUSTOM_KEY\'</code></pre>')
    expect(result.map(({ lang, value }) => ({ lang, value }))).toEqual([
      { lang: 'shellscript', value: 'npm install @lifi/perps-sdk' },
      { lang: 'typescript', value: "import { createPerpsClient } from '@lifi/perps-sdk'\nconst client = createPerpsClient({ apiKey: process.env.LIFI_API_KEY! })" },
      { lang: 'text', value: "curl --header 'x-lifi-api-key: YOUR_CUSTOM_KEY'" },
    ])
  })

  it.each([
    ['<pre><code language="typescript">value</code></pre>', 'typescript'],
    ['<pre language="javascript"><code>value</code></pre>', 'javascript'],
    ['<pre language="json">value</pre>', 'json'],
    ['<pre><code data-language="python">value</code></pre>', 'python'],
    ['<pre data-language="ruby"><code>value</code></pre>', 'ruby'],
    ['<pre><code class="highlight language-c++">value</code></pre>', 'c++'],
    ['<pre class="lang-bash"><code>value</code></pre>', 'bash'],
    ['<pre language="javascript"><code class="language-typescript">value</code></pre>', 'typescript'],
    ['<pre language="javascript"><code language="text" class="language-typescript">value</code></pre>', 'text'],
    ['<pre><code language="custom-language">value</code></pre>', 'custom-language'],
    ['<pre><code>value</code></pre>', null],
    ['<pre><code class="not-language-typescript">value</code></pre>', null],
    ['<pre><code language="typescript&#10;```&#10;{execute()}">value</code></pre>', null],
    ['<pre><code language="{execute()}">value</code></pre>', null],
    [`<pre language="${'a'.repeat(65)}"><code>value</code></pre>`, null],
  ])('reads only bounded explicit language metadata: %s', (html, language) => {
    expect(blocks(html)).toEqual([expect.objectContaining({ lang: language, value: 'value' })])
  })

  it('keeps token-line whitespace and embedded fences literal with a language attribute', async () => {
    const html = '<pre language="typescript"><code><span class="token-line">const value = ````literal````</span><span class="token-line">  &lt;script&gt;{inert}&lt;/script&gt;</span></code></pre>'
    const [block] = blocks(html)
    expect(block.lang).toBe('typescript')
    expect(block.value).toBe('const value = ````literal````\n  <script>{inert}</script>')
    await compile(`\n${'`'.repeat(5)}${block.lang}\n${block.value}\n${'`'.repeat(5)}\n`)
  })

  it('preserves explicit code-group payload divs in conversion and source evidence', async () => {
    const code = 'import { client } from "example";\n\n// Literal MDX-looking payload\nconst value = "```` <script>{unsafe}</script>";\n  client.execute(value);'
    const payload = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const body = `<article><h1>Examples</h1><div data-component-part="code-group-tab-content" data-language="typescript">${payload}</div><pre><div data-component-part="code-group-tab-content">Existing block</div></pre><div>Ordinary prose remains prose.</div></article>`
    const { $, root } = migrationHtmlArticle(body)
    expect(root.find('pre').toArray().map((node) => $(node).text())).toEqual([code, 'Existing block'])
    expect(root.find('pre pre').length).toBe(0)
    const page = htmlPage({ body, finalUrl: new URL('https://docs.test/examples'), contentType: 'text/html' }, 'examples').page!
    const tree = unified().use(remarkParse).use(remarkMdx).parse(page.body)
    expect(tree.children.filter((node) => node.type === 'code').map(({ value, lang }) => ({ value, lang }))).toEqual([
      { value: code, lang: 'typescript' }, { value: 'Existing block', lang: null },
    ])
    expect(page.body).toContain('Ordinary prose remains prose.')
    expect(sanitizeRemoteMarkdown(page.body)).toBe(page.body)
    await compile(page.body)
  })
})

describe('authored paragraph semantics', () => {
  it('keeps explicit paragraph spans separate from pictures and following copy', async () => {
    const body = '<article><h1>Images</h1><span><picture><source srcset="/wide.png 2x"><img src="/small.png" alt="Literal {alt}"></picture></span><span data-as="p">Options after the picture:</span><span data-as="p">Keep <em>formatting</em> and <span>ordinary</span> inline spans.</span></article>'
    const page = htmlPage({ body, finalUrl: new URL('https://docs.test/images'), contentType: 'text/html' }, 'images', {
      preserveAnchors: true, preserveResponsiveImages: true, omitDocumentHeading: true,
    }).page!
    expect(page.body).toContain('</picture>\n\nOptions after the picture:\n\nKeep _formatting_ and ordinary inline spans.')
    const tree = unified().use(remarkParse).use(remarkMdx).parse(page.body)
    expect(tree.children.map((node) => node.type)).toEqual(['mdxJsxFlowElement', 'paragraph', 'paragraph'])
    expect(sanitizeRemoteMarkdown(page.body)).not.toBeNull()
    await compile(page.body)
  })

  it('keeps paragraph boundaries before anchored disclosures without changing fenced payloads', async () => {
    const body = '<article><h1>Upgrade</h1><span data-as="p">Read the prompt below.</span><details><summary><div><p id="prompt-title">Migration prompt</p></div></summary><div id="prompt-content"><pre><code language="markdown">import { example } from "example";\n\n&lt;picture&gt;\n&lt;/picture&gt; Literal text\n</code></pre></div></details></article>'
    const page = htmlPage({ body, finalUrl: new URL('https://docs.test/upgrade'), contentType: 'text/html' }, 'upgrade', {
      preserveAnchors: true, preserveResponsiveImages: true, omitDocumentHeading: true,
    }).page!
    expect(page.body).toContain('Read the prompt below.\n\n<a id="prompt-title" />')
    expect(page.body).toContain('<a id="prompt-content" />')
    const clean = page.body.replace(/^<a id="[^"<]*" \/>$/gm, '')
    expect(sanitizeRemoteMarkdown(clean)).toBe(clean)
    const tree = unified().use(remarkParse).use(remarkMdx).parse(page.body)
    expect(tree.children.filter((node) => node.type === 'code')).toEqual([
      expect.objectContaining({ lang: 'markdown', value: 'import { example } from "example";\n\n<picture>\n</picture> Literal text' }),
    ])
    await compile(page.body)
  })
})

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
  it.each(['import', 'export'])('keeps the standalone API route segment %s as inert paragraph copy', async (segment) => {
    const body = `/\n\napi\n\n/\n\n${segment}\n\nNext paragraph.`
    expect(sanitizeRemoteMarkdown(body)).toBe(body)
    await compile(body)
  })

  it.each([
    'import value from "module"',
    'import {\nvalue\n} from "module"',
    'export {\nvalue\n}',
    'export default "value"',
  ])('continues rejecting real ESM syntax: %s', (body) => {
    expect(sanitizeRemoteMarkdown(body)).toBeNull()
  })

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

  it.each([0, 1, 2, 3, 4, 5, 6])('round-trips %i literal backslashes before table pipes in prose, code and links', async (count) => {
    const value = `before${'\\'.repeat(count)}|after`
    const body = `<article><h1>Escaped pipes</h1><table><tr><th>Text</th><th>Code</th><th>Link</th></tr><tr><td>${value}</td><td><code>${value}</code></td><td><a href="https://safe.test/search?q=one|two">${value}</a></td></tr></table></article>`
    const page = htmlPage({ body, finalUrl: new URL('https://docs.test/'), contentType: 'text/html' }, 'pipes', { omitDocumentHeading: true }).page!
    const tree = parser.parse(page.body)
    const table = tree.children.find((node) => node.type === 'table')!
    expect(table.children.map((row) => row.children.length)).toEqual([3, 3])
    const [textCell, codeCell, linkCell] = table.children[1].children
    expect(textCell.children).toContainEqual(expect.objectContaining({ type: 'text', value }))
    if (count % 2 === 0) {
      expect(codeCell.children).toContainEqual(expect.objectContaining({ type: 'inlineCode', value }))
    } else {
      expect(codeCell.children).toContainEqual(expect.objectContaining({ type: 'mdxJsxTextElement', name: 'code', attributes: [], children: [expect.objectContaining({ type: 'text', value })] }))
    }
    expect(linkCell.children).toContainEqual(expect.objectContaining({ type: 'link', url: 'https://safe.test/search?q=one|two', children: [expect.objectContaining({ type: 'text', value })] }))
    expect(sanitizeRemoteMarkdown(page.body)).toBe(page.body)
    // Package tests prove grammar portability; the public app separately
    // verifies its own interpreter and Code component against this behavior.
    await compile(page.body, { remarkPlugins: [remarkGfm] })
  })

  it('keeps syntax-shaped odd-backslash code literal without admitting executable JSX', async () => {
    const value = '\\|</code><script>{globalThis.process.exit()}</script> & **literal** `ticks` [link](javascript:alert(1))'
    const body = `<article><h1>Code</h1><table><tr><th>Code</th></tr><tr><td><code>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></td></tr></table></article>`
    const page = htmlPage({ body, finalUrl: new URL('https://docs.test/'), contentType: 'text/html' }, 'literal', { omitDocumentHeading: true }).page!
    expect(sanitizeRemoteMarkdown(page.body)).toBe(page.body)
    const tree = parser.parse(page.body)
    const table = tree.children.find((node) => node.type === 'table')!
    expect(table.children[1].children[0].children).toEqual([
      expect.objectContaining({ type: 'mdxJsxTextElement', name: 'code', attributes: [], children: [expect.objectContaining({ type: 'text', value })] }),
    ])
    await compile(page.body, { remarkPlugins: [remarkGfm] })
    for (const unsafe of ['<code title="value">text</code>', '<code onclick="execute()">text</code>', '<code>{globalThis.process.exit()}</code>', '<code><Note>Nested component</Note></code>', '<code dangerouslySetInnerHTML={{"__html":"bad"}} />']) {
      expect(sanitizeRemoteMarkdown(unsafe)).toBeNull()
    }
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
