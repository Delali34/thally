/** Generated page descriptions contain readable prose, never component syntax. */

import { compileSync } from '@mdx-js/mdx'
import { describe, expect, it } from 'vitest'

import { mintlifyHeadingSlug, escapeFernLiteralBraces, escapeUnmatchedClosingTags, functionDeclaredNames, hasClientBoundaryFunctionProp, normalizeHtmlComments, normalizeMdx, parseMarkdownPage, removeUndefinedExpressions, normalizeExplicitHeadingIds, protectMathBlocks, replaceLinkWithAnchor, replaceOutsideCodeAndComments, replaceUnknownComponents, rewriteFernRelativePageLinks } from '../mdx.js'

describe('maskCode placeholder safety (via normalizeMdx)', () => {
  it('strips a literal NUL from the source so it cannot collide with a placeholder marker', () => {
    const withNul = 'before\u0000 <!-- comment --> after'
    expect(normalizeMdx(withNul)).toBe('before {/* comment */} after')
  })

  it('still converts a 4-space-indented `<!-- -->` comment, since MDX disables CommonMark indented code blocks', () => {
    // mdx-js disables CommonMark indented code blocks, so this 4-space
    // indented text is ordinary prose to @mdx-js/mdx, not a code block, and
    // must still be rewritten (consistent with how @mdx-js/mdx parses it).
    expect(normalizeMdx('    <!-- a\n    b -->')).toBe('    {/* a\n    b */}')
  })
})

function description(raw: string): string | undefined {
  return parseMarkdownPage({ id: 'faq', raw, source: 'https://example.com/faq' })?.description
}

describe('migration description fallback', () => {
  it('extracts the first paragraph inside an accordion without its JSX wrappers', () => {
    expect(description(`---\ntitle: Questions\n---\n\n<Accordion title="Where can I learn more?">\n  See the [API documentation](/api) for details.\n</Accordion>`))
      .toBe('See the API documentation for details.')
  })

  it('skips code examples and expressions while preserving inline prose formatting', () => {
    expect(description(`import Widget from './widget.jsx'\n\n# Questions\n\n<Accordion title="How?">\n\n\`\`\`http\nGET /example\n\`\`\`\n\nUse **settings** with <code>enabled</code> and <a href="/help">the guide</a>.\n</Accordion>`))
      .toBe('Use settings with enabled and the guide.')
  })

  it('preserves authored descriptions exactly', () => {
    expect(description('---\ntitle: Questions\ndescription: "Authored description."\n---\n\nDifferent paragraph.'))
      .toBe('Authored description.')
  })

  it('does not invent description text for code-only pages', () => {
    expect(description('```jsx\n<Widget />\n```')).toBe('')
  })

  it('does not turn a GFM table into a visible page summary', () => {
    const raw = '---\ntitle: Comparison\n---\n\n| Feature | Result |\n| --- | --- |\n| Cache | Yes |\n\nThe cache reuses packages.'
    expect(description(raw)).toBe('The cache reuses packages.')
  })

  it('keeps Docusaurus descriptions for metadata without adding a second visible paragraph', () => {
    const page = parseMarkdownPage({
      id: 'guide',
      platform: 'docusaurus',
      raw: '---\ntitle: Guide\ndescription: Introductory prose.\n---\n\nIntroductory prose.',
      source: 'docs/guide.md',
    })
    expect(page).toMatchObject({ description: 'Introductory prose.', descriptionPlacement: 'body' })
  })

  it('takes a leading Markdown H1 as the page title and removes its duplicate body heading', () => {
    const page = parseMarkdownPage({
      id: 'api/docusaurus-config',
      platform: 'docusaurus',
      raw: '---\ndescription: Configuration reference.\n---\n\nimport Widget from "./widget"\n\n# `docusaurus.config.js`\n\nConfiguration details.',
      source: 'docs/api/docusaurus.config.js.mdx',
    })
    expect(page?.title).toBe('docusaurus.config.js')
    expect(page?.body).not.toContain('# `docusaurus.config.js`')
    expect(page?.body).toContain('Configuration details.')
  })
})

describe('normalizeMdx', () => {
  it('pins Mintlify step titles to plain text unless the source sets titleSize', () => {
    expect(normalizeMdx('<Steps>\n<Step title="A">x</Step>\n</Steps>', 'mintlify')).toContain('<Steps titleSize="p">')
    expect(normalizeMdx('<Steps className="x">\n</Steps>', 'mintlify')).toContain('<Steps className="x" titleSize="p">')
    expect(normalizeMdx('<Steps titleSize="h3">\n</Steps>', 'mintlify')).toBe('<Steps titleSize="h3">\n</Steps>')
    for (const platform of ['fern', 'docusaurus'] as const) expect(normalizeMdx('<Steps>\n</Steps>', platform)).not.toContain('titleSize')
    expect(normalizeMdx('<Steps />', 'mintlify')).toBe('<Steps titleSize="p" />')
    expect(normalizeMdx('<Steps className="x"/>', 'mintlify')).toBe('<Steps className="x" titleSize="p" />')
    expect(normalizeMdx('<Steps />', 'mintlify')).not.toContain('/ titleSize')
    expect(normalizeMdx('<Steps className={a > b}>\n</Steps>', 'mintlify')).toContain('<Steps className={a > b} titleSize="p">')
    expect(normalizeMdx('<Steps titleSize="h2" />', 'mintlify')).toBe('<Steps titleSize="h2" />')
  })

  it('projects a static Docusaurus useBaseUrl require without changing code samples', () => {
    const body = "<a href={require('@docusaurus/useBaseUrl').default('showcase')}>Showcase</a>\n\n```jsx\n<a href={require('@docusaurus/useBaseUrl').default('showcase')} />\n```"
    const output = normalizeMdx(body, 'docusaurus')
    expect(output).toContain('<a href="/showcase">Showcase</a>')
    expect(output).toContain("```jsx\n<a href={require('@docusaurus/useBaseUrl').default('showcase')} />\n```")
  })

  it('does not rewrite a site-authored zoom component as a platform widget', () => {
    const output = normalizeMdx('<Zoom>\n\n![Diagram](/img/diagram.png)\n\n</Zoom>', 'docusaurus')
    expect(output).toContain('<Zoom>')
    expect(output).toContain('</Zoom>')
    expect(output).toContain('![Diagram](/img/diagram.png)')
  })

  it('keeps styled source paragraphs from hydrating as nested paragraphs', () => {
    const source = '<p className="source-callout">\n  Text with **emphasis**.\n</p>\n\n```mdx\n<p>Keep this example</p>\n```'
    const output = normalizeMdx(source, 'mintlify')
    expect(output).toContain('<div className="source-callout">\n  Text with **emphasis**.\n</div>')
    expect(output).toContain('```mdx\n<p>Keep this example</p>\n```')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('resolves Docusaurus emoji shortcodes in prose and tables without changing code', () => {
    const source = '| Result |\n| --- |\n| :white_check_mark: |\n\nUse :x: for no. `:x:`\n\n```md\n:x:\n```'
    const output = normalizeMdx(source, 'docusaurus')
    expect(output).toContain('| ✅ |')
    expect(output).toContain('Use ❌ for no. `:x:`')
    expect(output).toContain('```md\n:x:\n```')
  })

  it('reduces a presentational Mintlify Update label to static text', () => {
    const source = '<Update label={<><Icon icon="rocket" /><span>Quickstart</span></>} tags={["Guide"]}>Text</Update>'
    const output = normalizeMdx(source, 'mintlify')
    expect(output).toContain('<Update label={"Quickstart"} tags={["Guide"]}>')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('reads Update label text from parsed JSX without leaking attributes or expressions', () => {
    const staticLabel = '<Update label={<><Icon title="a > b" /><span>Quickstart</span></>}>Text</Update>'
    expect(normalizeMdx(staticLabel, 'mintlify')).toContain('<Update label={"Quickstart"}>')
    const dynamicLabel = '<Update label={<>{version}</>}>Text</Update>'
    expect(normalizeMdx(dynamicLabel, 'mintlify')).toContain('label={<>{version}</>}')
  })

  it('preserves an explicit heading anchor in a Mintlify page', () => {
    const output = normalizeMdx('## Install help {#smartscreen}', 'mintlify')
    expect(output).toBe('## Install help {/* #smartscreen */}')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('preserves numeric-leading Mintlify heading anchors', () => {
    const output = normalizeMdx('## Responses 429 {#429-responses}\n\n### Add Firecrawl {#1-add-firecrawl}', 'mintlify')
    expect(output).toContain('## Responses 429 {/* #429-responses */}')
    expect(output).toContain('### Add Firecrawl {/* #1-add-firecrawl */}')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('preserves Mintlify parameter anchors for settings headings and fields', () => {
    const body = [
      '### `icons`',
      '<ResponseField name="icons.library" type="string" />',
      '<ResponseField name="seo.paths" type="array" />',
      '```mdx',
      '<ResponseField name="example.only" />',
      '```',
    ].join('\n')
    const output = normalizeMdx(body, 'mintlify')
    expect(output).toContain('<a id="param-icons"></a>\n### `icons`')
    expect(output).toContain('<a id="param-icons-library"></a>\n<ResponseField name="icons.library"')
    expect(output).toContain('<a id="param-seo-paths"></a>\n<ResponseField name="seo.paths"')
    expect(output).not.toContain('id="param-example-only"')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('removes Docusaurus theme imports and unused tab data across shared import lines', () => {
    const body = "import Tabs from '@theme/Tabs'; import TabItem from '@theme/TabItem'; import constants from '@site/core/TabsConstants';\n\n<Tabs values={constants.languages} defaultValue={constants.defaultLanguage}><TabItem value=\"en\">Hello</TabItem></Tabs>"
    const output = normalizeMdx(body, 'docusaurus')
    expect(output).not.toContain('@theme/')
    expect(output).not.toContain('@site/')
    expect(output).not.toContain('constants.')
    expect(output).toContain('<Tab title="en">')
  })

  it('preserves explicit Docusaurus heading anchors without invalid MDX expressions', () => {
    const body = '### Hook name {#hook-name}\n### `getClientModules()` {/* #getClientModules */}\n\n```md\n### Example {#literal}\n### Example {/* #literalComment */}\n```'
    const output = normalizeMdx(body, 'docusaurus')
    expect(output).toContain('<a id="hook-name"></a>\n### Hook name')
    expect(output).toContain('<a id="getClientModules"></a>\n### `getClientModules()`')
    expect(output).toContain('### Example {#literal}')
    expect(output).toContain('### Example {/* #literalComment */}')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('handles a long heading with no valid explicit anchor without backtracking', () => {
    const body = `### Heading${' '.repeat(30_000)}{#unfinished`
    const startedAt = performance.now()
    expect(normalizeMdx(body, 'docusaurus')).toBe(body)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })
  it('renders Docusaurus mdx-code-block wrappers as live MDX around examples', () => {
    const body = [
      '[Jump to details](#node-env)',
      '```mdx-code-block',
      '<details id="node-env">',
      '<summary>Environment</summary>',
      '```',
      '',
      '```jsx',
      'const mode = "production"',
      '```',
      '',
      '```mdx-code-block',
      '</details>',
      '```',
      '',
      '````md',
      '```mdx-code-block',
      '<details id="example-only">',
      '```',
      '````',
    ].join('\n')
    const output = normalizeMdx(body, 'docusaurus')
    expect(output).toContain('<details id="node-env">')
    expect(output).toContain('</details>')
    expect(output).not.toContain('```mdx-code-block\n<details id="node-env">')
    expect(output).toContain('````md\n```mdx-code-block\n<details id="example-only">')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })
  it('keeps a Docusaurus mdx-code-block fenced when unwrapping would invalidate the page', () => {
    const body = '```mdx-code-block\nimport Source from "@site/sidebar.ts" with {type: "text"};\n```\n\nPage copy.'
    const output = normalizeMdx(body, 'docusaurus')
    expect(output).toContain('```mdx-code-block\nimport Source')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })
  it('does not expose theme imports from any mdx-code-block on a page', () => {
    const body = [
      '```mdx-code-block',
      "import Image from '@theme/ThemedImage';",
      '```',
      '```mdx-code-block',
      '<Image sources={{light: "/light.png", dark: "/dark.png"}} />',
      '```',
    ].join('\n')
    const output = normalizeMdx(body, 'docusaurus')
    expect(output).toBe(body)
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })
  it('keeps admonition examples inside a longer outer code fence inert', () => {
    const body = [
      '````mdx',
      ':::note',
      '```js',
      'example',
      '```',
      ':::',
      '````',
      '',
      ':::tip',
      'Real tip.',
      ':::',
    ].join('\n')
    const output = normalizeMdx(body, 'docusaurus')
    expect(output).toContain('````mdx\n:::note\n```js\nexample\n```\n:::\n````')
    expect(output).toContain('<Note>\nReal tip.\n</Note>')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })
  it('closes an archived Docusaurus admonition before the next heading', () => {
    const body = [
      ':::warning For pnpm users',
      'Install configuration:',
      '```json',
      '{"onlyBuiltDependencies":["fsevents"]}',
      '```',
      '## Configuration',
      'Available options.',
    ].join('\n')
    const output = normalizeMdx(body, 'docusaurus')
    expect(output).toContain('</Warning>\n## Configuration')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })
  it('leaves a bare Mintlify <Callout>...</Callout> closing tag untouched', () => {
    // Fern's `<Callout intent="...">` closing tags are rewritten to the tag
    // its matching opener chose. A generic Mintlify `<Callout>` (no `intent`)
    // never opens one of those tags, so its own closing tag must survive —
    // rewriting it to a mismatched tag breaks MDX compilation.
    const body = '<Callout icon="key" color="#FFC107">Custom callout</Callout>'
    expect(normalizeMdx(body)).toBe(body)
  })

  it('rewrites <FileTree> to Thally\'s <Tree> built-in', () => {
    expect(normalizeMdx('<FileTree>\n- docs/\n</FileTree>', 'mintlify')).toBe('<Tree>\n- docs/\n</Tree>')
  })

  it('converts Fern FileTree bullets into nested, initially visible Folder and File nodes', () => {
    const source = '<FileTree>\n- my-skill/\n  - SKILL.md\n  - scripts/\n    - requirements.txt\n  - evals/\n    - evals.json\n    - environment/\n      - Dockerfile\n</FileTree>'
    const output = normalizeMdx(source, 'fern')
    expect(output).toBe('<Tree>\n<Folder name={"my-skill/"} defaultOpen>\n<File name={"SKILL.md"} />\n<Folder name={"scripts/"} defaultOpen>\n<File name={"requirements.txt"} />\n</Folder>\n<Folder name={"evals/"} defaultOpen>\n<File name={"evals.json"} />\n<Folder name={"environment/"} defaultOpen>\n<File name={"Dockerfile"} />\n</Folder>\n</Folder>\n</Folder>\n</Tree>')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
    expect(normalizeMdx('```mdx\n<FileTree>\n- example/\n</FileTree>\n```', 'fern'))
      .toBe('```mdx\n<FileTree>\n- example/\n</FileTree>\n```')
  })

  it('keeps malformed Fern FileTree indentation for explicit migration validation', () => {
    const source = '<FileTree>\n- parent/\n    - skipped-level.txt\n</FileTree>'
    expect(normalizeMdx(source, 'fern')).toBe(source)
  })

  it('rewrites <Column> to a plain <div> so Columns lays it out without a registry entry', () => {
    expect(normalizeMdx('<Columns cols={2}>\n  <Column>Text</Column>\n</Columns>', 'mintlify'))
      .toBe('<Columns cols={2}>\n  <div>Text</div>\n</Columns>')
  })

  it("unwraps Fern's per-tab <CodeBlock> inside a <CodeBlocks> group, but preserves Mintlify's standalone <CodeBlock> component", () => {
    expect(normalizeMdx('<CodeBlocks>\n<CodeBlock title="npm">\n```bash\nnpm install acme\n```\n</CodeBlock>\n</CodeBlocks>', 'fern'))
      .toBe('<CodeGroup>\n\n```bash\nnpm install acme\n```\n\n</CodeGroup>')

    const standalone = 'export const Custom = ({ children, ...props }) => (\n  <CodeBlock {...props}>{children}</CodeBlock>\n);'
    expect(normalizeMdx(standalone)).toContain(standalone)
  })

  it('defines a standalone <CodeBlock> shim so a page-authored component referencing it does not throw ReferenceError at render', () => {
    const body = 'export const Custom = ({ children, ...props }) => (\n  <CodeBlock {...props}>{children}</CodeBlock>\n);'
    const result = normalizeMdx(body)
    expect(result).toMatch(/^export const CodeBlock = /)
    // Never double-declare when the page (or an earlier pass) already defines it.
    expect(normalizeMdx(result).match(/export const CodeBlock =/g)).toHaveLength(1)
  })

  it('imports Icon for a page-authored component that references it bare, but not for ordinary prose usage', () => {
    const body = 'export const Download = () => (\n  <a href="/x.pdf"><Icon icon="download" /></a>\n);\n\n<Download />'
    expect(normalizeMdx(body)).toContain("import { Icon } from '@/components/mdx/content-icon';")

    const prose = 'Click <Icon icon="rocket" /> to launch.'
    expect(normalizeMdx(prose)).toBe(prose)
  })

  it('rewrites <GitHub.Repo> to the registered <GitHub> repository card', () => {
    expect(normalizeMdx('<GitHub.Repo repo="mintlify/docs" variant="inset" />', 'mintlify'))
      .toBe('<GitHub repo="mintlify/docs" variant="inset" />')
  })

  it("maps a Docusaurus <TabItem>'s value to its <Tabs> values[] label, preferring the item's own label, and strips Docusaurus-only Tabs props", () => {
    const body = '<Tabs\n  defaultValue="native"\n  values={[\n    { label: \'Native\', value: \'native\' },\n    { label: \'React\', value: \'react\' },\n  ]}\n  groupId="framework">\n<TabItem value="native">Native body</TabItem>\n<TabItem value="react" label="Custom">React body</TabItem>\n</Tabs>'
    const result = normalizeMdx(body, 'docusaurus')
    expect(result).toContain('<Tab title="Native">')
    // The TabItem's own `label` wins over the Tabs `values[]` entry.
    expect(result).toContain('<Tab title="Custom">')
    expect(result).not.toContain('defaultValue')
    expect(result).not.toContain('values=')
    expect(result).not.toContain('groupId')
    expect(result).toMatch(/^<Tabs>/)
  })

  it('never rewrites a tag name mentioned inside an inline code span or fenced code block', () => {
    // Regression: a naive whole-body string replace corrupted prose like
    // "`<Tree>` and `<FileTree>` are aliases" into "`<Tree>` and `<Tree>`".
    const prose = '`<Tree>` and `<FileTree>` are aliases.'
    expect(normalizeMdx(prose)).toBe(prose)
    const fenced = '```mdx\n<FileTree>\n- docs/\n</FileTree>\n```'
    expect(normalizeMdx(fenced)).toBe(fenced)
  })

  it('wraps consecutive docusaurus-remark-plugin-tab-blocks fences in a <CodeGroup> and drops the tab keyword', () => {
    const body = '```bash tab title="npm"\nnpm install acme\n```\n```bash tab title="yarn"\nyarn add acme\n```'
    const result = normalizeMdx(body, 'docusaurus')
    expect(result).toBe('<CodeGroup>\n\n```bash title="npm"\nnpm install acme\n```\n\n```bash title="yarn"\nyarn add acme\n```\n</CodeGroup>')
  })

  it('leaves a single tab-marked fence unwrapped, only stripping the tab keyword', () => {
    const body = '```bash tab title="npm"\nnpm install acme\n```'
    expect(normalizeMdx(body, 'docusaurus')).toBe('```bash title="npm"\nnpm install acme\n```')
  })

  it('preserves the blank line after a tab-marked fence that is not followed by another tab fence', () => {
    const body = '```bash tab title="npm"\nnpm install acme\n```\n\nNext paragraph.'
    expect(normalizeMdx(body, 'docusaurus')).toBe('```bash title="npm"\nnpm install acme\n```\n\nNext paragraph.')
  })

  it('only applies a platform\'s own renames when a platform is given', () => {
    // <Success> is a Fern-only alias for <Tip>; it must not fire against a
    // Docusaurus or Mintlify source's own, unrelated <Success> component.
    const body = '<Success>Done</Success>'
    expect(normalizeMdx(body, 'docusaurus')).toBe(body)
    expect(normalizeMdx(body, 'mintlify')).toBe(body)
    expect(normalizeMdx(body, 'fern')).toBe('<Tip>Done</Tip>')
    // Omitting the platform applies no platform-specific renames at all — a
    // caller of unknown origin (the URL crawler when it can't detect one)
    // must not have another platform's renames corrupt its own components.
    expect(normalizeMdx(body)).toBe(body)
  })
})

describe('HTML style="..." attribute normalization (all platforms, including unspecified)', () => {
  it('does not mistake an info string inside a fence for its closing delimiter', () => {
    const body = '```markdown\n```python\ncode\n```\n\n<small style="color: #666;">License</small>'
    expect(normalizeMdx(body, 'mintlify')).toContain('<small style={{color: "#666"}}>')
  })
  it('converts a simple string style attribute into a JSX style object', () => {
    // A raw HTML `style="..."` string (common in Markdown pasted from a
    // rendered table, e.g. a pandas DataFrame) is invalid JSX — React's
    // `style` prop must be a mapping, and this throws at render rather than
    // silently doing nothing. This has no platform-specific semantics, so it
    // must run even when `platform` is omitted (unlike platform-gated renames).
    expect(normalizeMdx('<tr style="text-align: right;">')).toBe('<tr style={{textAlign: "right"}}>')
  })

  it('camelCases a kebab-case property and capitalizes vendor prefixes, with -ms- lowercase', () => {
    const body = '<div style="-webkit-transform: rotate(3deg); -ms-transform: scale(1); font-size: 12px;">x</div>'
    expect(normalizeMdx(body, 'fern')).toBe(
      '<div style={{WebkitTransform: "rotate(3deg)", msTransform: "scale(1)", fontSize: "12px"}}>x</div>',
    )
  })

  it('keeps a CSS custom property as a literal string key', () => {
    expect(normalizeMdx('<div style="--brand-color: #ff0000;">x</div>', 'fern'))
      .toBe('<div style={{"--brand-color": "#ff0000"}}>x</div>')
  })

  it('does not split a url() value containing a semicolon (a data URI)', () => {
    const body = '<div style="background: url(data:image/png;base64,AAAA==);">x</div>'
    expect(normalizeMdx(body, 'fern')).toBe('<div style={{background: "url(data:image/png;base64,AAAA==)"}}>x</div>')
  })

  it('drops !important, which a React style object cannot express', () => {
    expect(normalizeMdx('<p style="color: red !important;">x</p>', 'fern')).toBe('<p style={{color: "red"}}>x</p>')
  })

  it('converts an empty style attribute to an empty object', () => {
    expect(normalizeMdx('<span style="">x</span>', 'fern')).toBe('<span style={{}}>x</span>')
  })

  it('preserves other attributes and self-closing tags', () => {
    expect(normalizeMdx('<div className="x" style="color:red" id="y">x</div>', 'fern'))
      .toBe('<div className="x" style={{color: "red"}} id="y">x</div>')
    expect(normalizeMdx('<br style="color:red"/>', 'fern')).toBe('<br style={{color: "red"}} />')
  })

  it('converts a style attribute on its own line inside a multi-line tag', () => {
    // A copied HTML snippet often spreads each attribute onto its own
    // indented line (e.g. an <iframe>). The separator right before `style=`
    // is then a newline plus indentation — more than one whitespace
    // character — not the single space a same-line tag has. The original
    // layout is not preserved (attributes are reflowed onto one line, same
    // as the single-line case), but the string style attribute — which
    // would otherwise throw at render — is still converted to a valid JSX
    // style object.
    const body = [
      '<iframe',
      '    src="https://example.com/embed"',
      '    style="width: 100%; height: 500px; border: none; border-radius: 8px;"',
      '  ></iframe>',
    ].join('\n')
    const result = normalizeMdx(body, 'fern')
    expect(result).toBe(
      '<iframe\n    src="https://example.com/embed" style={{width: "100%", height: "500px", border: "none", borderRadius: "8px"}}></iframe>',
    )
    expect(result).not.toContain('style="')
  })

  it('converts a multi-line tag whose style attribute comes first, with no attribute before it', () => {
    const body = '<div\n  style="color: red;"\n  id="y"\n>x</div>'
    expect(normalizeMdx(body, 'fern')).toBe('<div style={{color: "red"}}\n  id="y">x</div>')
  })

  it('leaves an already-correct style expression and a component tag alone', () => {
    expect(normalizeMdx('<div style={{color: "red"}}>x</div>', 'fern')).toBe('<div style={{color: "red"}}>x</div>')
    // Uppercase-first is a component, never an intrinsic HTML element — its
    // own `style` prop (if it has one) may have entirely different semantics.
    expect(normalizeMdx('<Custom style="color:red" />', 'fern')).toBe('<Custom style="color:red" />')
  })

  it('never touches a style="..." string inside fenced or inline code', () => {
    const fenced = '```html\n<div style="color:red">code</div>\n```'
    expect(normalizeMdx(fenced, 'fern')).toBe(fenced)
    const inline = 'Use `<div style="color:red">` in HTML.'
    expect(normalizeMdx(inline, 'fern')).toBe(inline)
  })
})

describe('Docusaurus import normalization', () => {
  it('removes injected global component imports', () => {
    expect(normalizeMdx("import Tabs from '@theme/Tabs';\n\n<Tabs />", 'docusaurus'))
      .toBe('\n<Tabs />')
  })

  it('handles adversarial whitespace in linear time', () => {
    const source = `import${' '.repeat(100_000)}Widget from '@theme/Widget'`
    const startedAt = performance.now()

    expect(normalizeMdx(source, 'docusaurus')).toBe(source)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })
})

describe('inline component hook imports', () => {
  function body(raw: string): string | undefined {
    return parseMarkdownPage({ id: 'page', raw, source: 'https://example.com/page' })?.body
  }

  it('imports hooks a page-local inline component calls without an import', () => {
    const page = body('export const Counter = () => {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>{n}</button>\n}\n\n<Counter />')
    expect(page).toMatch(/^import \{ useState \} from 'react'/)
  })

  it('imports only the hooks actually called, in the documented order', () => {
    const page = body('export const X = () => {\n  useEffect(() => {}, [])\n  const [n] = useState(0)\n  return <div>{n}</div>\n}')
    expect(page).toMatch(/^import \{ useState, useEffect \} from 'react'/)
  })

  it('does not add an import when no hook is called', () => {
    const source = 'Just prose.'
    expect(body(source)).toBe(source)
  })

  it('does not duplicate an import the page already has', () => {
    const source = "import { useState } from 'react'\n\nexport const Counter = () => {\n  const [n] = useState(0)\n  return <div>{n}</div>\n}"
    expect(body(source)).toBe(source)
  })

  it('does not import a hook shown only in a documentation code sample', () => {
    // The import alone (unused or not) marks the compiled page a Client
    // Component and breaks the Server Component build — showing readers what
    // a hook call looks like must not trigger it.
    const source = '```mdx\nexport const Counter = () => {\n  const [n] = useState(0)\n}\n```'
    expect(body(source)).toBe(source)
  })
})

describe('nested code fence widening', () => {
  it('widens an outer fence so a same-length nested fence does not close it early', () => {
    const source = '```mdx\n<Tabs>\n  <Tab title="npm">\n    ```bash\n    npm install x\n    ```\n  </Tab>\n</Tabs>\n```'
    expect(normalizeMdx(source)).toBe(
      '````mdx\n<Tabs>\n  <Tab title="npm">\n    ```bash\n    npm install x\n    ```\n  </Tab>\n</Tabs>\n````',
    )
  })

  it('widens each ancestor enough for doubly nested fences of the same length', () => {
    const source = '```mdx\n```bash\n```diff\ncode\n```\n```\n```'
    expect(normalizeMdx(source)).toBe('`````mdx\n````bash\n```diff\ncode\n```\n````\n`````')
  })

  it('leaves ordinary, unnested code fences untouched', () => {
    const source = '```js\nconst x = 1\n```\n\nMore prose.\n\n```py\nx = 1\n```'
    expect(normalizeMdx(source)).toBe(source)
  })

  it('leaves unbalanced fences untouched rather than guessing', () => {
    const source = '```mdx\n```bash\nnpm install x'
    expect(normalizeMdx(source)).toBe(source)
  })
})

describe('orphan capitalized tag escaping', () => {
  it('escapes a bare placeholder tag that never closes or self-closes', () => {
    expect(normalizeMdx('Add a callout: "<Feature> requires a plan."'))
      .toBe('Add a callout: "&lt;Feature&gt; requires a plan."')
  })

  it('never rewrites tag-like text inside a string of a page that already compiles', () => {
    const source = "export const label = '<Feature>'\n\nUse {label}."
    expect(normalizeMdx(source)).toBe(source)
  })

  it('leaves a properly paired tag alone', () => {
    const source = '<Note>hello</Note>'
    expect(normalizeMdx(source)).toBe(source)
  })

  it('leaves a self-closing tag alone', () => {
    const source = '<Icon icon="download" />'
    expect(normalizeMdx(source)).toBe(source)
  })

  it('recognizes a self-closing tag whose last attribute value ends in a brace', () => {
    const source = '<Visits initial={4} />'
    expect(normalizeMdx(source)).toBe(source)
  })

  it('leaves a locally declared inline component alone', () => {
    const source = 'export const Counter = () => <div/>\n\n<Counter />'
    expect(normalizeMdx(source)).toBe(source)
  })

  it('leaves an imported component alone', () => {
    const source = "import { Widget } from '/snippets/widget.mdx'\n\n<Widget>"
    expect(normalizeMdx(source)).toBe(source)
  })

  it('does not touch tag-like text inside inline code or a fenced code block', () => {
    expect(normalizeMdx('Use `<Info>` for callouts.')).toBe('Use `<Info>` for callouts.')
    const fenced = '```mdx\n<Foo>\n```'
    expect(normalizeMdx(fenced)).toBe(fenced)
  })
})

describe("heading id preservation via normalizeMdx (an explicit `{#id}` anchor is unparsable MDX prose, and Thally's heading renderer can't take an explicit id prop)", () => {
  it("replaces a heading's explicit {#custom-id} suffix with a preceding anchor element carrying that id", () => {
    expect(normalizeMdx('### Timeouts {#Notes-Timeouts}', 'docusaurus')).toBe('<a id="Notes-Timeouts"></a>\n### Timeouts')
  })

  it('does the same with inline code and JSX before it on the same heading line', () => {
    const source = '### <Icon name="angle-right" /> `cypress-tap` sessions {#cypress-tap-sessions}'
    expect(normalizeMdx(source, 'docusaurus')).toBe('<a id="cypress-tap-sessions"></a>\n### <Icon name="angle-right" /> `cypress-tap` sessions')
  })

  it('leaves a heading with no explicit id unchanged', () => {
    expect(normalizeMdx('## Plain heading', 'docusaurus')).toBe('## Plain heading')
  })

  it('leaves a `{#...}`-shaped line inside a fenced code block untouched', () => {
    const body = '```md\n## Heading {#id}\n```'
    expect(normalizeMdx(body, 'docusaurus')).toBe(body)
  })

  it('runs for every platform, not just docusaurus — the syntax means the same thing everywhere (e.g. live crewAI/Mintlify docs)', () => {
    expect(normalizeMdx('### Timeouts {#Notes-Timeouts}', 'fern')).toBe('<a id="Notes-Timeouts"></a>\n### Timeouts')
    expect(normalizeMdx('### Timeouts {#Notes-Timeouts}')).toBe('<a id="Notes-Timeouts"></a>\n### Timeouts')
  })
})

describe('multi-line renames (fenced/inline code masked, whole body rewritten)', () => {
  it('converts a multi-line HTML comment to an MDX comment', () => {
    const body = 'Before.\n\n<!--\n  a note\n  spanning lines\n-->\n\nAfter.'
    expect(normalizeMdx(body)).toBe('Before.\n\n{/*\n  a note\n  spanning lines\n*/}\n\nAfter.')
  })

  it('renames a multi-line Docusaurus <Warn> and its closing tag', () => {
    const body = '<Warn\n  title="Careful">\nBody text.\n</Warn>'
    expect(normalizeMdx(body)).toBe('<Warning\n  title="Careful">\nBody text.\n</Warning>')
  })

  it('renames a multi-line Docusaurus <Link> to an anchor, opening and closing tags together', () => {
    const body = '<Link\n  to="/a">\n  x\n</Link>'
    expect(normalizeMdx(body, 'docusaurus')).toBe('<a\n  href="/a">\n  x\n</a>')
  })

  it('rewrites a multi-line Fern <Callout intent="..."> to the paired Thally tag', () => {
    const body = '<Callout\n  intent="warning">\nBack up first.\n</Callout>'
    expect(normalizeMdx(body, 'fern')).toBe('<Warning>\nBack up first.\n</Warning>')
  })

  it('pairs Fern callouts in source order, including nested and bare callouts', () => {
    const body = '<Callout intent="warning">A</Callout>\n<Callout intent="success" title="x > y"><Callout icon="key">B</Callout>C</Callout>'
    const output = normalizeMdx(body, 'fern')
    expect(output).toBe('<Warning>A</Warning>\n<Tip title="x > y"><Callout icon="key">B</Callout>C</Tip>')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('scans long malformed Fern callout tags without exponential backtracking', () => {
    const body = `<Callout intent="warning"${' '.repeat(30_000)}unfinished`
    const startedAt = performance.now()
    expect(normalizeMdx(body, 'fern')).toBe(body)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  it('still never rewrites a tag name mentioned inside an inline code span or fenced code block', () => {
    const prose = '`<Tree>` and `<FileTree>` are aliases.'
    expect(normalizeMdx(prose, 'mintlify')).toBe(prose)
    const fenced = '```mdx\n<FileTree>\n- docs/\n</FileTree>\n```'
    expect(normalizeMdx(fenced, 'mintlify')).toBe(fenced)
    // A comment-like fragment inside a fenced block must not be converted either.
    const fencedComment = '```html\n<!--\n  example comment\n-->\n```'
    expect(normalizeMdx(fencedComment)).toBe(fencedComment)
  })
})

describe('Mintlify heading ids', () => {
  // Pairs read from the ids docs.firecrawl.dev serves.
  it.each([
    ['Persistent Profiles with Scrape + Interact', 'persistent-profiles-with-scrape-+-interact'],
    ['Team management & roles', 'team-management-&-roles'],
    ['/scrape endpoint', '/scrape-endpoint'],
    ['1. /agent Endpoint', '1-/agent-endpoint'],
    ['Node.js (Playwright)', 'node-js-playwright'],
    ['X (x.com) billing', 'x-x-com-billing'],
    ['batch_scrape.started', 'batch_scrape-started'],
    ['Day 2 - FIRE-1 Agent', 'day-2-fire-1-agent'],
    ['Day 7 \u2013 Integration Day', 'day-7-\u2013-integration-day'],
    ['Migration: /extract \u2192 /agent', 'migration-/extract-\u2192-/agent'],
    ['Firecrawl search returns titles, and URLs \u2014 and more.', 'firecrawl-search-returns-titles-and-urls-\u2014-and-more'],
    ['What\u2019s Not Included', 'what\u2019s-not-included'],
    ['4. Done!', '4-done'],
    ['What can Firecrawl do?', 'what-can-firecrawl-do'],
    ['Introducing LLMs.txt Generator Endpoint (Alpha) \u{1F4C3}', 'introducing-llms-txt-generator-endpoint-alpha-'],
  ])('slugs %j as %s', (text, id) => {
    expect(mintlifyHeadingSlug(text)).toBe(id)
  })

  it('marks only the headings whose id differs from the one Thally would generate', () => {
    const output = normalizeMdx([
      '## Quick start',
      '## Scrape + Interact',
      '### Formats (`formats`)',
      '## Team **roles** & [links](/x)',
      '```md',
      '## Not + a heading',
      '```',
    ].join('\n'), 'mintlify')
    expect(output).toBe([
      '## Quick start',
      '## Scrape + Interact {/* #scrape-+-interact */}',
      '### Formats (`formats`)',
      '## Team **roles** & [links](/x) {/* #team-roles-&-links */}',
      '```md',
      '## Not + a heading',
      '```',
    ].join('\n'))
    expect(normalizeMdx(output, 'mintlify')).toBe(output)
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('ignores an authored MDX comment when computing the id, and never reads a non-# comment as one', () => {
    const output = normalizeMdx(['## Foo {/* note */} bar', '## Plain {/* note */}', '## Both {/* a */} ones {/* #custom */}'].join('\n'), 'mintlify')
    expect(output).toBe(['## Foo {/* note */} bar', '## Plain {/* note */}', '## Both {/* a */} ones {/* #custom */}'].join('\n'))
    // Thally's own slug of the rendered text already is `foo-bar`, so no marker is needed (it used to be `foo-/-note-/-bar`).
    expect(normalizeMdx(output, 'mintlify')).toBe(output)
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })

  it('says what is wrong with an unusable heading anchor', () => {
    const messages: Array<string> = []
    normalizeExplicitHeadingIds('## T {#a*/b}', (message) => messages.push(message), { headingMarkers: true })
    expect(messages).toEqual(['Heading anchor {#a*/b} contains whitespace or "*/" and was removed from "T".'])
  })

  it('typesets straight quotes in heading text and ids as Mintlify does', () => {
    const output = normalizeMdx([
      "## What's Not Included",
      '### Example: "Find the founders" and `it\'s`',
      "## Les cl\u00e9s d'API {#api-keys}",
    ].join('\n'), 'mintlify')
    expect(output).toBe([
      '## What\u2019s Not Included {/* #what\u2019s-not-included */}',
      '### Example: \u201cFind the founders\u201d and `it\'s` {/* #example-\u201cfind-the-founders\u201d-and-its */}',
      '## Les cl\u00e9s d\u2019API {/* #api-keys */}',
    ].join('\n'))
  })

  it('leaves other platforms alone', () => {
    expect(normalizeMdx('## Scrape + Interact', 'docusaurus')).toBe('## Scrape + Interact')
  })
})

describe('Mintlify heading ids from the live Trigger.dev docs', () => {
  /** The id a heading line ends up with: the marker the migrator writes, or the slug Thally gives the rendered text. */
  function effectiveId(line: string): string {
    const output = normalizeMdx(line, 'mintlify')
    const marker = /\{\/\* #(\S+) \*\/\}$/.exec(output)
    if (marker) return marker[1]
    return output.replace(/^#+ /, '').replace(/[`*\\]/g, '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/(^-|-$)/g, '')
  }

  // [heading as authored upstream, id docs trigger.dev serves]
  it.each([
    ['### @trigger.dev/sdk/v3', '@trigger-dev/sdk/v3'],
    ['### @effect/schema', '@effect/schema'],
    ['### `sessions.start(body, requestOptions?)`', 'sessions-start-body-requestoptions'],
    ['### `sessions.retrieve(idOrExternalId, requestOptions?)`', 'sessions-retrieve-idorexternalid-requestoptions'],
    ['### `sessions.update(idOrExternalId, body, requestOptions?)`', 'sessions-update-idorexternalid-body-requestoptions'],
    ['### `sessions.close(idOrExternalId, body?, requestOptions?)`', 'sessions-close-idorexternalid-body-requestoptions'],
    ['### `sessions.list(options?, requestOptions?)`', 'sessions-list-options-requestoptions'],
    ['### `sessions.open(idOrExternalId)`', 'sessions-open-idorexternalid'],
    ['### `out.append(value, options?)`', 'out-append-value-options'],
    ['### `out.pipe(stream, options?)`', 'out-pipe-stream-options'],
    ['### `out.writer({ execute, ... })`', 'out-writer--execute-'],
    ['### `out.read(options?)`', 'out-read-options'],
    ['### `out.writeControl(subtype, extraHeaders?)`', 'out-writecontrol-subtype-extraheaders'],
    ['### `out.trimTo(earliestSeqNum)`', 'out-trimto-earliestseqnum'],
    ['### `in.send(value, requestOptions?)`', 'in-send-value-requestoptions'],
    ['### `in.on(handler)`', 'in-on-handler'],
    ['### `in.once(options?)`', 'in-once-options'],
    ['### `in.wait(options?)`', 'in-wait-options'],
    ['### `in.waitWithIdleTimeout({ idleTimeoutInSeconds, timeout, ... })`', 'in-waitwithidletimeout--idletimeoutinseconds-timeout-'],
    ['### Backend: `chat.withUIMessage(...).agent(...)`', 'backend-chat-withuimessage-agent'],
    ['### `loadSkill({ name })`', 'loadskill--name-'],
    ['### `readFile({ skill, path })`', 'readfile--skill-path-'],
    ['### `bash({ skill, command })`', 'bash--skill-command-'],
    ['### mockChatAgent(agent, options?)', 'mockchatagent-agent-options'],
    ['## `chat.requestUpgrade()`: same call, faster handoff', 'chat-requestupgrade--same-call-faster-handoff'],
    ['## `transport.stopGeneration(chatId)`', 'transport-stopgeneration-chatid'],
    ['### "Module not found: @prisma/client/sql"', '\u201cmodule-not-found-@prisma/client/sql\u201d'],
    ['### Using \\*', 'using'],
    ['### `Error: @prisma/client did not initialize yet.`', 'error-@prisma/client-did-not-initialize-yet'],
    ['### Database package (`@repo/db`)', 'database-package-@repo/db'],
    ['### `No loader is configured for ".node" files`', 'no-loader-is-configured-for--node-files'],
    ['### `Failed to index deployment` with `Column must be greater than or equal to 0, got -1`', 'failed-to-index-deployment-with-column-must-be-greater-than-or-equal-to-0-got-1'],
  ])('gives %s the id %s', (line, id) => {
    expect(effectiveId(line)).toBe(id)
  })

  it('reads the ids Mintlify serves from the rendered heading text', () => {
    expect(mintlifyHeadingSlug('@trigger.dev/sdk/v3')).toBe('@trigger-dev/sdk/v3')
    expect(mintlifyHeadingSlug('sessions.start(body, requestOptions?)')).toBe('sessions-start-body-requestoptions')
    expect(mintlifyHeadingSlug('out.writer({ execute, ... })')).toBe('out-writer--execute-')
  })
})

describe('Mintlify callouts', () => {
  it('keeps <Check> as its own callout instead of turning it into a <Note>', () => {
    const source = '<Check>\n  All set.\n</Check>\n\n<Check title="Done">Finished.</Check>'
    for (const platform of ['mintlify', 'fern', 'docusaurus', undefined] as const) {
      expect(normalizeMdx(source, platform)).toBe(source)
    }
  })

  // Mintlify's <Callout> has no tone: a `type` prop is ignored and the box renders neutral.
  it.each([
    ['<Callout type="warning">\n  Not available.\n</Callout>', '<Callout type="info">\n  Not available.\n</Callout>'],
    ['<Callout type={"danger"} icon="key">Careful</Callout>', '<Callout type="info" icon="key">Careful</Callout>'],
    ['<Callout icon="key" type=\'tip\' />', '<Callout icon="key" type="info" />'],
  ])('renders a Mintlify <Callout> that sets a type as the neutral info callout: %s', (source, expected) => {
    expect(normalizeMdx(source, 'mintlify')).toBe(expected)
  })

  it('leaves a Mintlify <Callout> without a type, a coloured one and other platforms alone', () => {
    const plain = '<Callout icon="key" color="#C77DFF">Custom</Callout>'
    expect(normalizeMdx(plain, 'mintlify')).toBe(plain)
    expect(normalizeMdx('<Callout>Plain</Callout>', 'mintlify')).toBe('<Callout>Plain</Callout>')
    const typed = '<Callout type="warning">Docusaurus-style</Callout>'
    expect(normalizeMdx(typed, 'docusaurus')).toBe(typed)
  })

  it('does not rewrite a <Callout> shown in a code fence', () => {
    const fenced = '```mdx\n<Callout type="warning">x</Callout>\n```'
    expect(normalizeMdx(fenced, 'mintlify')).toBe(fenced)
  })
})

describe('Mintlify explicit heading ids stay on the heading', () => {
  it('keeps a translated heading\'s English id as the heading id, not as a separate anchor', () => {
    const output = normalizeMdx('## Primeros pasos {#get-started}\n\nTexto.', 'mintlify')
    expect(output).toBe('## Primeros pasos {/* #get-started */}\n\nTexto.')
    expect(output).not.toContain('<a id')
  })

  it('keeps the id on the heading when the page is normalized a second time', () => {
    const once = normalizeMdx('## Primeros pasos {#get-started}', 'mintlify')
    expect(normalizeMdx(once, 'mintlify')).toBe(once)
  })

  it('keeps ids with characters an HTML anchor would reject, and still compiles', () => {
    const output = normalizeMdx('## Team {#team-management-&-roles}\n\n## Plus {#scrape-+-interact}', 'mintlify')
    expect(output).toContain('## Team {/* #team-management-&-roles */}')
    expect(output).toContain('## Plus {/* #scrape-+-interact */}')
    expect(() => compileSync(output, { format: 'mdx' })).not.toThrow()
  })
})

describe('normalizeExplicitHeadingIds', () => {
  it('replaces a heading\'s trailing {#custom-id} with an <a id> element, keeping the heading text, and the result compiles', () => {
    // Real crewAI content: `{#memory-embedder-config}` makes @mdx-js/mdx fail
    // with "Could not parse expression with acorn" and excluded the whole page.
    const result = normalizeExplicitHeadingIds('### Memory & embedder config {#memory-embedder-config}\n\nSome prose.')
    expect(result).toBe('<a id="memory-embedder-config"></a>\n### Memory & embedder config\n\nSome prose.')
    expect(() => compileSync(result, { format: 'mdx' })).not.toThrow()
  })

  it('leaves a real fenced code block containing heading-shaped text untouched', () => {
    const body = ['```md', '### Not a real heading {#fake-id}', '```'].join('\n')
    expect(normalizeExplicitHeadingIds(body)).toBe(body)
  })

  it('leaves a heading with no custom id unchanged', () => {
    const body = '## Plain heading\n\nSome prose.'
    expect(normalizeExplicitHeadingIds(body)).toBe(body)
  })

  it('never touches the YAML frontmatter block', () => {
    const body = '---\ntitle: "{#not-a-heading}"\n---\n\n## Heading {#real-id}'
    expect(normalizeExplicitHeadingIds(body)).toBe('---\ntitle: "{#not-a-heading}"\n---\n\n<a id="real-id"></a>\n## Heading')
  })

  it('stays fast on a very long heading with no custom id', () => {
    const body = `# a${' '.repeat(60_000)}b`
    const started = Date.now()
    expect(normalizeExplicitHeadingIds(body)).toBe(body)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it.each(['1-add-firecrawl', '123', '429-responses', 'v1.2', 'a:b', 'café', '入门', '_x'])('keeps the valid HTML5 id %s', (id) => {
    const result = normalizeExplicitHeadingIds(`### 1. 获取 API 密钥 {#${id}}\n\nProse.`)
    expect(result).toBe(`<a id="${id}"></a>\n### 1. 获取 API 密钥\n\nProse.`)
    expect(() => compileSync(result, { format: 'mdx' })).not.toThrow()
  })

  it('keeps the same ids in the Docusaurus comment form', () => {
    for (const id of ['1-intro', 'café', 'v1.2']) {
      expect(normalizeExplicitHeadingIds(`## Intro {/* #${id} */}`)).toBe(`<a id="${id}"></a>\n## Intro`)
    }
  })

  it.each(['a b', 'a"b', "a'b", 'a<b', 'a>b', 'a`b', 'a&b', ''])('rejects the id %j but still compiles the page', (id) => {
    const warnings: Array<string> = []
    const result = normalizeExplicitHeadingIds(`## Title {#${id}}\n\nProse.`, (message) => warnings.push(message))
    expect(result).not.toContain('<a id')
    expect(result).not.toMatch(/\{#/)
    expect(result).toContain('## Title')
    expect(warnings).toHaveLength(1)
    expect(() => compileSync(result, { format: 'mdx' })).not.toThrow()
  })

  it('leaves a heading whose brace suffix is not a single anchor untouched, without a warning', () => {
    const warnings: Array<string> = []
    const body = '## Use {#if} blocks {x}'
    expect(normalizeExplicitHeadingIds(body, (message) => warnings.push(message))).toBe(body)
    expect(warnings).toEqual([])
  })

  it('keeps only the last of two anchors on a heading', () => {
    expect(normalizeExplicitHeadingIds('## A {#x} {#y}')).toBe('<a id="y"></a>\n## A {#x}')
  })

  it('leaves a non-id brace suffix that is not an anchor attempt alone', () => {
    expect(normalizeExplicitHeadingIds('## Uses {value}')).toBe('## Uses {value}')
  })

  it('stays fast on a 10k-character heading ending in a rejected id', () => {
    const body = `# ${'a {#'.repeat(2500)}}`
    const started = Date.now()
    normalizeExplicitHeadingIds(body)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('Fern relative page links', () => {
  const routes = new Map([
    ['../docs/tier1-validation.mdx', 'tier1-validation'],
    ['../docs/guides/install.mdx', 'get-started/install'],
  ])

  it('resolves sibling Card hrefs and Markdown links against source files, retaining suffixes', () => {
    const body = '<Card href="tier1-validation.mdx#checks" />\n<a href={"./guides/install.mdx?tab=uv#linux"}>Install</a>\n[Tier 1](tier1-validation.mdx)\n[Install](<guides/install.mdx#setup> "title")'
    expect(rewriteFernRelativePageLinks(body, '../docs/index.mdx', routes)).toBe(
      '<Card href="/tier1-validation#checks" />\n<a href={"/get-started/install?tab=uv#linux"}>Install</a>\n[Tier 1](/tier1-validation)\n[Install](</get-started/install#setup> "title")',
    )
  })

  it('leaves unknown files, external URLs, assets, and code examples unchanged', () => {
    const body = '<Card href="https://example.com/x.mdx" />\n<Card href="missing.mdx" />\n<a href="./assets/chart.svg" />\n`<Card href="tier1-validation.mdx" />`\n```mdx\n<Card href="tier1-validation.mdx" />\n```'
    expect(rewriteFernRelativePageLinks(body, '../docs/index.mdx', routes)).toBe(body)
  })
})

describe('protectMathBlocks', () => {
  it('renders a block $$...$$ with the native KaTeX component', () => {
    const body = [
      'Some prose before.',
      '',
      '$$',
      '\\begin{align*}',
      '\\small\\text{Account USDC Settlement Balance} = \\\\',
      '\\text{Account USDC Balance}',
      '\\end{align*}',
      '$$',
      '',
      'Some prose after.',
    ].join('\n')
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(true)
    expect(result.body).toContain('<Latex block>')
    expect(result.body).toContain('\\begin{align*}')
    expect(result.body).not.toMatch(/\n\$\$\n/)
    // The content actually compiles as MDX now (this exact construct is
    // what crashed the parser before math was protected).
    expect(() => compileSync(result.body, { format: 'mdx' })).not.toThrow()
  })

  it('converts an inline $$...$$ span to native KaTeX, preserving surrounding prose', () => {
    const body = "Therefore the Total Exchange USDC Balance is $$4'000$$ today."
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(true)
    expect(result.body).toBe('Therefore the Total Exchange USDC Balance is <Latex>{"4\'000"}</Latex> today.')
    expect(() => compileSync(result.body, { format: 'mdx' })).not.toThrow()
  })

  it('leaves a real fenced code block containing $$ untouched', () => {
    const body = ['```js', 'const x = $$(selector)', '```'].join('\n')
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('leaves prose with no $$ at all unchanged', () => {
    const body = 'Nothing special here.'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('never touches the frontmatter block', () => {
    const body = '---\ntitle: "$$weird$$"\n---\n\nBody with $$x=1$$ math.'
    const result = protectMathBlocks(body)
    expect(result.body).toContain('title: "$$weird$$"')
    expect(result.body).toContain('<Latex>{"x=1"}</Latex>')
  })

  it('converts single-$...$ inline math (the paradex-docs greeks.mdx repro)', () => {
    const body = 'Under Black-76, the forward is $F = S \\times e^{\\,f\\,T}$, so a move in $S$ matters.'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(true)
    expect(result.body).toBe(
      'Under Black-76, the forward is <Latex>{"F = S \\\\times e^{\\\\,f\\\\,T}"}</Latex>, so a move in <Latex>{"S"}</Latex> matters.',
    )
    expect(() => compileSync(result.body, { format: 'mdx' })).not.toThrow()
  })

  it('does not mistake two dollar amounts in prose for inline math', () => {
    const body = 'It costs $50 and $100 depending on the plan.'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('converts a block delimited by a bare $ alone on its own line (the paradex-docs maintenance-mode.mdx repro)', () => {
    const body = [
      'BTC with an External Fair Price of $100,000:',
      '',
      '$',
      '\\text{External Fair Price} = \\text{Spot Oracle Price} \\times (1 + \\text{External Basis Rate})',
      '$',
    ].join('\n')
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(true)
    // A bare dollar amount elsewhere in the prose is left alone.
    expect(result.body).toContain('$100,000:')
    expect(result.body).toContain('<Latex block>')
    expect(result.body).toContain('\\text{External Fair Price}')
    expect(() => compileSync(result.body, { format: 'mdx' })).not.toThrow()
  })

  it('does not treat an author-escaped \\$ as a math delimiter', () => {
    const body = 'A 1% move corresponds to \\$600 in this example.'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('leaves shell-variable-looking inline code spans untouched, even in pairs on one line', () => {
    const body = 'Compare `$FOO` and `$BAR` values.'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('leaves a JSX attribute value and adjacent text content untouched (not real math)', () => {
    const body = '<Badge color="$primary">$5</Badge>'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('leaves an inlined ESM component with template-literal interpolations untouched (mintlify/docs vercel-json-generator.mdx repro)', () => {
    const body = [
      'Some prose before.',
      '',
      'export const VercelJsonGenerator = () => {',
      "  const [subdomain, setSubdomain] = useState('[SUBDOMAIN]')",
      '  const vercelConfig = {',
      '    rewrites: [',
      '      {',
      '        source: `/${cleanSubpath}`,',
      '        destination: `https://${subdomain}.mintlify.site/${cleanSubpath}`',
      '      }',
      '    ]',
      '  }',
      '  return <div>{JSON.stringify(vercelConfig)}</div>',
      '}',
      '',
      '<VercelJsonGenerator />',
    ].join('\n')
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
    expect(() => compileSync(result.body, { format: 'mdx' })).not.toThrow()
  })

  it('leaves an inline code span with GitHub Actions matrix interpolation untouched (playwright.dev test-sharding repro)', () => {
    const body = 'Then run tests with the `--shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}` option.'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('never matches a template-literal interpolation (`${...}`) as a math delimiter, even unquoted', () => {
    const body = 'weird unquoted ${foo}+${bar} text'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('leaves a bare JSX expression container untouched, not mistaking its braces for math content', () => {
    const body = 'Price is {price} and the total is {total} today.'
    const result = protectMathBlocks(body)
    expect(result.converted).toBe(false)
    expect(result.body).toBe(body)
  })

  it('requires a TeX signal for single-$ inline math, so a bare non-digit token like $Pro$ is still left alone unless it also looks like TeX', () => {
    // No backslash/^/_/{, but also no digits/whitespace: still accepted,
    // matching the existing `$S$` convention (see the paradex repro test).
    const bareToken = protectMathBlocks('Upgrade to $Pro$ today.')
    expect(bareToken.converted).toBe(true)
    // A stronger prose case that could otherwise look like a pair of dollar
    // amounts (digits, no TeX signal) never converts.
    const dollarAmounts = protectMathBlocks('It costs $5 or $10, your choice.')
    expect(dollarAmounts.converted).toBe(false)
  })

  it('never returns a body that fails to compile when the original page compiled fine (compile guard invariant)', () => {
    for (const body of [
      'A stray $<Foo>$ that a converter could wrap wrong.',
      'See `code` and $x$ and an unterminated ` backtick here.',
      'Mixed content: $$4\'000$$ and a `$FOO` shell var and {jsxExpr} together.',
    ]) {
      const originalCompiles = (() => {
        try {
          compileSync(body, { format: 'mdx' })
          return true
        } catch {
          return false
        }
      })()
      const result = protectMathBlocks(body)
      if (originalCompiles) {
        expect(() => compileSync(result.body, { format: 'mdx' })).not.toThrow()
      }
    }
  })
})

describe('escapeFernLiteralBraces', () => {
  it('keeps issue lists and double-braced templates as literal prose', () => {
    const body = 'Dependencies: {V2-7, V2-8}. Prompt: {{business_name}}.'
    const escaped = escapeFernLiteralBraces(body)
    expect(escaped).toContain('\\{V2-7, V2-8\\}')
    expect(escaped).toContain('\\{\\{business_name\\}\\}')
    expect(() => compileSync(escaped, { format: 'mdx' })).not.toThrow()
  })
  it('leaves an ESM component whose JSX returns a real expression unchanged', () => {
    const body = 'export const Box = ({ children }) => <div>{children}</div>;'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves a destructuring assignment inside real page-authored code unchanged', () => {
    const body = [
      'export const Box = () => {',
      '  const {title} = x',
      '  return <div>{title}</div>;',
      '};',
    ].join('\n')
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('escapes a bare identifier in ordinary prose', () => {
    expect(escapeFernLiteralBraces('Connection to {vendor} failed.'))
      .toBe('Connection to \\{vendor\\} failed.')
  })

  it('escapes a bare dotted-path reference in prose', () => {
    expect(escapeFernLiteralBraces('Configure {http.Server} before starting.'))
      .toBe('Configure \\{http.Server\\} before starting.')
  })

  it('leaves a real component prop expression inside JSX unchanged', () => {
    const body = '<Foo bar={props.x}>Text</Foo>'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves a prose brace referencing an ESM import unchanged', () => {
    const body = "import { vendor } from './vendor.js';\n\nConnection to {vendor} failed."
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves fenced and inline code untouched', () => {
    const body = 'Use `{vendor}` inline, or:\n\n```js\nconst x = {vendor};\n```'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves an unparseable page unchanged instead of throwing', () => {
    const body = '<Unclosed'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('escapes a bare identifier inside a callout', () => {
    expect(escapeFernLiteralBraces('<Note>connection to {vendor} failed</Note>'))
      .toBe('<Note>connection to \\{vendor\\} failed</Note>')
  })

  it('escapes a bare identifier inside nested Tabs/Tab', () => {
    const body = '<Tabs>\n  <Tab title="x">See {vendor} below.</Tab>\n</Tabs>'
    const expected = '<Tabs>\n  <Tab title="x">See \\{vendor\\} below.</Tab>\n</Tabs>'
    expect(escapeFernLiteralBraces(body)).toBe(expected)
  })

  it('leaves props.title inside JSX unchanged', () => {
    const body = '<Note>{props.title}</Note>'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves a map() callback referencing its own parameter unchanged', () => {
    const body = '{items.map((item) => <li>{item}</li>)}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves prose referencing a multi-declarator export const unchanged (export const a = 1, b = 2)', () => {
    const body = 'export const a = 1, b = 2\n\nx {a} {b}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves prose referencing a nested destructured export const unchanged', () => {
    const body = 'export const {\n  a,\n  b: { c }\n} = obj\n\n{c}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves prose referencing a multi-line named import unchanged', () => {
    const body = 'import {\n  vendor,\n} from "./v"\n\n{vendor}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves prose referencing both a default and named import unchanged', () => {
    const body = 'import X, { Y } from "./v"\n\n{X} {Y}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves prose referencing an `export async function` unchanged', () => {
    const body = 'export async function load() {}\n\n{load}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves a dotted path on a pure JS built-in (and the undefined literal) unchanged', () => {
    const body = 'x {Math.PI} {Number.MAX_SAFE_INTEGER} {undefined}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('escapes bare globals and host-only global paths, which crash or vanish at render', () => {
    for (const name of ['window', 'document', 'navigator', 'process', 'console', 'Date', 'Error', 'fetch', 'Math', 'window.location', 'document.title', 'process.env']) {
      expect(escapeFernLiteralBraces(`x {${name}} y`)).toBe(`x \\{${name}\\} y`)
    }
    expect(escapeFernLiteralBraces('<Note>\n{window}\n</Note>')).toBe('<Note>\n\\{window\\}\n</Note>')
  })

  it('reads bindings from ESM that contains JSX', () => {
    const body = 'export const Badge = () => <b>new</b>\nexport const version = "1.2.3"\n\nCurrent version: {version}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('leaves a non-exported local const inside a client component body unchanged', () => {
    const body = 'export const x = 1\nconst inner = 2\n\n{inner}'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('escapes a Unicode identifier and a $-prefixed identifier the same as an ASCII one', () => {
    expect(escapeFernLiteralBraces('x {café} y')).toBe('x \\{café\\} y')
    expect(escapeFernLiteralBraces('x {$var} y {_x} z')).toBe('x \\{$var\\} y \\{_x\\} z')
  })

  it('does not bind a name from a re-export (`export { x } from "./y"`), since that never declares a local variable', () => {
    const body = 'export { vendor } from "./x"\n\nx {vendor}'
    expect(escapeFernLiteralBraces(body)).toBe('export { vendor } from "./x"\n\nx \\{vendor\\}')
  })

  it('never rewrites a YAML frontmatter block, even when its value contains a brace', () => {
    const body = '---\ntitle: "Style guide"\ndescription: "Use {x} for a placeholder"\n---\n\nConnection to {vendor} failed.'
    expect(escapeFernLiteralBraces(body)).toBe(
      '---\ntitle: "Style guide"\ndescription: "Use {x} for a placeholder"\n---\n\nConnection to \\{vendor\\} failed.',
    )
  })

  it('skips a leading UTF-8 BOM when locating the frontmatter block, matching parseFrontmatter', () => {
    const body = '﻿---\ndescription: "{x}"\n---\n\n{vendor}'
    expect(escapeFernLiteralBraces(body)).toBe('﻿---\ndescription: "{x}"\n---\n\n\\{vendor\\}')
  })

  it('leaves frontmatter alone with CRLF line endings', () => {
    const body = '---\r\ndescription: "{x}"\r\n---\r\n\r\n{vendor}'
    expect(escapeFernLiteralBraces(body)).toBe('---\r\ndescription: "{x}"\r\n---\r\n\r\n\\{vendor\\}')
  })

  it('round-trips a body with no frontmatter and no escapable braces unchanged', () => {
    const body = 'Just prose, no braces here.'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })

  it('escapes double-mustache template text (`{{now}}`) the same as single-brace text', () => {
    const body = 'Also remember to format {{now}} with your desired timezone.'
    expect(escapeFernLiteralBraces(body)).toBe('Also remember to format \\{\\{now\\}\\} with your desired timezone.')
  })

  it('leaves `{{name}}` alone when `name` is declared by the page\'s own ESM', () => {
    const body = 'import { now } from "./x"\n\nformat {{now}} for the user.'
    expect(escapeFernLiteralBraces(body)).toBe(body)
  })
})

describe('hasClientBoundaryFunctionProp', () => {
  it('flags a page-authored function passed as a bare JSX prop', () => {
    const body = 'export const CustomBlock = ({ children }) => <div>{children}</div>;\n\n'
      + '<Accordion title="x" RenderComponent={CustomBlock}>Body</Accordion>'
    expect(hasClientBoundaryFunctionProp(body)).toBe(true)
  })

  it('ignores the same shape when it only appears inside a fenced code sample', () => {
    const body = '```jsx\nexport const handleClick = () => {};\n<button onClick={handleClick} />\n```'
    expect(hasClientBoundaryFunctionProp(body)).toBe(false)
  })

  it('ignores a plain value whose initializer merely contains =>, not a function reference', () => {
    const body = 'export const items = list.map((x) => x);\n\n<Table rows={items} />'
    expect(hasClientBoundaryFunctionProp(body)).toBe(false)
  })

  it('ignores an unrelated export not passed anywhere as a prop', () => {
    const body = 'export const helper = () => 1;\n\nJust prose.'
    expect(hasClientBoundaryFunctionProp(body)).toBe(false)
  })
})

describe('functionDeclaredNames', () => {
  it('excludes a plain-value export const even when a function export exists on the same page', () => {
    // Reviewer's exact input: a string const feeds a client built-in
    // (`Mermaid chart={diagram}`) while a function feeds a different one
    // (`Steps render={Demo}`). Only `Demo` is a function.
    const body = "export const Demo = ({ children }) => <div>{children}</div>;\n"
      + "export const diagram = 'graph TD; A-->B';\n\n"
      + '<Steps render={Demo}>x</Steps>\n\n<Mermaid chart={diagram} />'
    expect(functionDeclaredNames(body)).toEqual(new Set(['Demo']))
  })

  it('includes classes, default and generator functions, and one-level aliases of a function', () => {
    const body = 'export class Box extends React.Component { render() { return null } }\n'
      + 'export default function Layout({ children }) { return children }\n'
      + 'export function* gen() {}\n'
      + 'export const Demo = () => null;\n'
      + 'export const Alias = Demo;\n'
      + 'export const load = async() => 1\n'
      + "export const functionList = ['map']\n"
      + "export const asyncMode = 'on'\n"
      + 'export const Label = functionList\n'
    expect(functionDeclaredNames(body)).toEqual(new Set(['Box', 'Layout', 'gen', 'Demo', 'Alias', 'load']))
  })

  it('includes export function and export async function declarations', () => {
    const body = 'export function Demo() { return null }\n'
      + 'export async function Load() { return 1 }\n'
      + "export const label = 'hi'\n"
    expect(functionDeclaredNames(body)).toEqual(new Set(['Demo', 'Load']))
  })
})

describe('replaceLinkWithAnchor', () => {
  it('renames a self-closing <Link> to <a>, keeping every attribute', () => {
    expect(replaceLinkWithAnchor('<Link href="/docs" target="_blank" />')).toBe('<a href="/docs" target="_blank" />')
  })

  it('renames a paired <Link> to <a>, keeping attributes and children exactly', () => {
    expect(replaceLinkWithAnchor('<Link href="/docs">Read the **docs**</Link>')).toBe('<a href="/docs">Read the **docs**</a>')
  })

  it('leaves a page-declared or imported Link untouched', () => {
    const body = "import Link from './link.jsx'\n\n<Link href=\"/x\">go</Link>"
    expect(replaceLinkWithAnchor(body)).toBe(body)
  })

  it('never touches frontmatter', () => {
    const body = '---\ntitle: "<Link>"\n---\n\n<Link href="/x">go</Link>'
    expect(replaceLinkWithAnchor(body)).toBe('---\ntitle: "<Link>"\n---\n\n<a href="/x">go</a>')
  })
})

describe('replaceUnknownComponents', () => {
  it('drops a self-closing unknown component and warns once', () => {
    const warned: Array<string> = []
    expect(replaceUnknownComponents('before <Snippet file="x.mdx" /> after', (name) => warned.push(name)))
      .toBe('before  after')
    expect(warned).toEqual(['Snippet'])
  })

  it('replaces a paired unknown component with a div, keeping its children', () => {
    const warned: Array<string> = []
    expect(replaceUnknownComponents('<Widget title="x">Hello <b>world</b></Widget>', (name) => warned.push(name)))
      .toBe('<div>Hello <b>world</b></div>')
    expect(warned).toEqual(['Widget'])
  })

  it('warns only once per distinct component name', () => {
    const warned: Array<string> = []
    replaceUnknownComponents('<Foo /> and <Foo /> and <Foo>x</Foo>', (name) => warned.push(name))
    expect(warned).toEqual(['Foo'])
  })

  it('does not touch a Thally builtin component', () => {
    const body = '<Card title="x">content</Card>'
    expect(replaceUnknownComponents(body, () => { throw new Error('should not warn') })).toBe(body)
  })

  it('does not touch a page-declared or imported component', () => {
    const body = "import Foo from './foo.jsx'\n\n<Foo>content</Foo>"
    expect(replaceUnknownComponents(body, () => { throw new Error('should not warn') })).toBe(body)
  })

  it('does not touch a componentMigrator-registered Migrated<hash> tag', () => {
    const body = '<Migrated0123456789ab title="x">content</Migrated0123456789ab>'
    expect(replaceUnknownComponents(body, () => { throw new Error('should not warn') })).toBe(body)
  })

  it('does not touch a lowercase HTML/JSX tag', () => {
    const body = '<iframe src="https://example.com" /> and <div>x</div>'
    expect(replaceUnknownComponents(body, () => { throw new Error('should not warn') })).toBe(body)
  })

  it('fixes a nested unknown component inside a known one', () => {
    const warned: Array<string> = []
    expect(replaceUnknownComponents('<Card><Gizmo>inner</Gizmo></Card>', (name) => warned.push(name)))
      .toBe('<Card><div>inner</div></Card>')
    expect(warned).toEqual(['Gizmo'])
  })

  it('never touches frontmatter, even when its value looks like an unknown tag', () => {
    const body = '---\ndescription: "<Widget />"\n---\n\n<Widget>x</Widget>'
    expect(replaceUnknownComponents(body, () => {})).toBe('---\ndescription: "<Widget />"\n---\n\n<div>x</div>')
  })

  // Regression: on fern-api/docs, a block-level unknown component (e.g.
  // Fern's <Template>) commonly wraps a fenced code block directly, with no
  // blank line before it — a real page's own author never needed one,
  // because the source component isn't rendered through MDX's block rules.
  // The fallback used to glue that content straight onto `<div>`, which
  // reads as inline text and desyncs the parser badly enough that the
  // reported error pointed at an unrelated `<div>` elsewhere on the page.
  it('separates a flow unknown component\'s block-level children (a fenced code block) with blank lines so the result still compiles', () => {
    const warned: Array<string> = []
    const body = [
      '<Template data={{ NAME: "x" }}>',
      '```bash',
      'echo hi',
      '```',
      '</Template>',
    ].join('\n')
    const out = replaceUnknownComponents(body, (name) => warned.push(name))
    expect(warned).toEqual(['Template'])
    expect(out).toContain('<div>\n\n```bash')
    expect(out).toContain('```\n\n</div>')
    expect(() => compileSync(out, { format: 'mdx' })).not.toThrow()
  })

  it('keeps an inline unknown component glued to its text-level children', () => {
    // A component used inline, mid-paragraph, never carries block content —
    // adding blank lines there would break the surrounding sentence instead
    // of fixing anything, so this case is untouched (matches the existing
    // "replaces a paired unknown component with a div" test above).
    const warned: Array<string> = []
    const body = 'See <Gizmo>new</Gizmo> for details.'
    const out = replaceUnknownComponents(body, (name) => warned.push(name))
    expect(warned).toEqual(['Gizmo'])
    expect(out).toBe('See <div>new</div> for details.')
  })

  it('compiles a flow unknown component nested inside another flow unknown component, each wrapping block content', () => {
    const body = [
      '<Steps>',
      '',
      '<Step title="One">',
      '',
      'Do the first thing.',
      '',
      '```bash',
      'echo one',
      '```',
      '',
      '</Step>',
      '',
      '</Steps>',
    ].join('\n')
    const out = replaceUnknownComponents(body, () => {})
    expect(() => compileSync(out, { format: 'mdx' })).not.toThrow()
  })

  it('compiles a self-closing unknown component nested directly inside a flow unknown component with no blank line', () => {
    // Mirrors the real fern-api/docs shape: <Steps><Markdown src="..."/> ...
    const body = '<Steps>\n<Markdown src="/x.mdx"/>\n<Step title="A">Body.</Step>\n</Steps>'
    const out = replaceUnknownComponents(body, () => {})
    expect(() => compileSync(out, { format: 'mdx' })).not.toThrow()
  })
})

describe('normalizeHtmlComments', () => {
  it('converts a single-line HTML comment to MDX comment syntax', () => {
    expect(normalizeHtmlComments('<!-- prettier-ignore -->')).toBe('{/* prettier-ignore */}')
  })

  it('converts a multi-line HTML comment', () => {
    expect(normalizeHtmlComments('<!--\nline one\nline two\n-->')).toBe('{/*\nline one\nline two\n*/}')
  })

  it('leaves an HTML comment inside a fenced code block untouched', () => {
    const body = '```html\n<!-- keep me -->\n```'
    expect(normalizeHtmlComments(body)).toBe(body)
  })

  it('leaves plain text with no comment unchanged', () => {
    const body = 'Just prose, no comments here.'
    expect(normalizeHtmlComments(body)).toBe(body)
  })
})

describe('removeUndefinedExpressions', () => {
  function run(body: string): { out: string; warnings: Array<string> } {
    const warnings: Array<string> = []
    return { out: removeUndefinedExpressions(body, (message) => warnings.push(message)), warnings }
  }

  it('removes an undefined text expression and warns once with the names', () => {
    const { out, warnings } = run('Owned by exactly one of {backfill, MV}. Also {other}.')
    expect(out).toBe('Owned by exactly one of . Also .')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"backfill"')
    expect(warnings[0]).toContain('"MV"')
    expect(warnings[0]).toContain('\\{ \\}')
    // Applies to every source platform, so it never names one.
    expect(warnings[0]).toBe('Expressions that use "backfill", "MV", "other" were removed so the page builds: the names are not defined on this page. Define the names or escape the braces as \\{ \\} to show the text.')
  })

  it('keeps expressions that use real runtime globals', () => {
    const body = '{crypto.randomUUID()} {new Blob([])} {escape(x)} {eval("1")} {WebAssembly.validate} {Iterator} {self} {screen.width} {new EventTarget()} {unescape("a")}'
    const { out, warnings } = run(body.replace(/x/g, '"x"'))
    expect(warnings).toEqual([])
    expect(out).toContain('crypto.randomUUID()')
  })

  it('removes an undefined flow expression and an undefined attribute expression', () => {
    const { out, warnings } = run('{missing}\n\n<Card title="x" href={base} />')
    expect(out).not.toContain('missing')
    expect(out).toBe('\n\n<Card title="x"  />')
    expect(warnings).toHaveLength(1)
  })

  it('keeps names the page exports or imports', () => {
    const body = "import { z } from './z'\n\nexport const x = 1\n\nValue {x} and {z}."
    const { out, warnings } = run(body)
    expect(out).toBe(body)
    expect(warnings).toEqual([])
  })

  it('keeps expression-local bindings and exported data', () => {
    const body = "export const items = [1, 2]\n\n{items.map(x => x * 2)}\n\n{items.map(function (y) { return y })}"
    expect(run(body).out).toBe(body)
  })

  it('keeps JS built-ins and props', () => {
    const body = '{Math.max(1, 2)} and {new Date().getFullYear()} and {props.title}'
    const { out, warnings } = run(body)
    expect(out).toBe(body)
    expect(warnings).toEqual([])
  })

  it('keeps comment-only expressions', () => {
    const body = '{/* note */}\n\ntext {/* a */}'
    expect(run(body).out).toBe(body)
  })

  it('does not touch code fences or inline code', () => {
    const body = 'Use `{backfill}`.\n\n```js\nconst a = {backfill}\n```'
    expect(run(body).out).toBe(body)
  })

  it('removes an undefined expression but keeps the inlined value', () => {
    const body = 'export const NAME = "x"\n\n{NAME} {gone}'
    expect(run(body).out).toBe('export const NAME = "x"\n\n{NAME} ')
  })

  it('keeps an identifier that is only the operand of typeof, which never throws', () => {
    const body = "{typeof zzz === 'undefined' ? 'a' : 'b'}"
    const { out, warnings } = run(body)
    expect(out).toBe(body)
    expect(warnings).toEqual([])
    expect(run('{typeof zzz.a}').out).toBe('')
  })

  it('keeps the own name of a class expression or a function expression used inside it', () => {
    const body = '{new (class Foo { m() { return Foo } })().m().name} {(function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) })(3)}'
    const { out, warnings } = run(body)
    expect(out).toBe(body)
    expect(warnings).toEqual([])
  })

  it('does not report `meta` for import.meta', () => {
    const { warnings } = run('{import.meta.url} {gone}')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"gone"')
    expect(warnings[0]).not.toContain('"meta"')
  })
})

describe('escapeUnmatchedClosingTags', () => {
  const compiles = (src: string) => { compileSync(src, { outputFormat: 'program' }) }

  it('repairs the real OpenRouter apikeys snippet (escaped opener, bare closer) and keeps its text', () => {
    const real = [
      '## update',
      '',
      'Update an existing API key. Authenticate with a [management key](/docs/guides/overview/auth/management-api-keys).',
      '',
      '\\<Warning>',
      "You can't change `workspace_id` through the API. The request body accepts only the fields listed below, and unrecognized fields are ignored.",
      '</Warning>',
      '',
      '### Example Usage: invalid_parameters',
      '',
    ].join('\n')
    expect(() => compiles(real)).toThrow(/Unexpected closing slash/)
    const out = escapeUnmatchedClosingTags(real)
    expect(out.lines).toEqual([7])
    expect(() => compiles(out.body)).not.toThrow()
    expect(out.body).toContain("You can't change `workspace_id` through the API.")
  })

  it('leaves balanced and nested same-name tags untouched', () => {
    const src = '<Note>\n<Note>\ninner\n</Note>\n</Note>\n'
    expect(escapeUnmatchedClosingTags(src)).toEqual({ body: src, lines: [] })
  })

  it('ignores closers inside code fences and inline code', () => {
    const src = '```html\n</Warning>\n```\n\nUse `</Warning>` here.\n'
    expect(escapeUnmatchedClosingTags(src)).toEqual({ body: src, lines: [] })
  })

  it('is linear on a long whitespace run inside an unfinished tag', () => {
    const src = `<a${' '.repeat(80_000)}x`
    const start = performance.now()
    expect(escapeUnmatchedClosingTags(src)).toEqual({ body: src, lines: [] })
    expect(performance.now() - start).toBeLessThan(200)
  })

  it('counts an opener whose brace attribute contains angle brackets', () => {
    const src = '<Card icon={<Icon />}>\nbody\n</Card>\n</Card>\n'
    const out = escapeUnmatchedClosingTags(src)
    expect(out.lines).toEqual([4])
    expect(out.body).toBe('<Card icon={<Icon />}>\nbody\n</Card>\n\\</Card>\n')
    expect(escapeUnmatchedClosingTags('<Card icon={<Icon />}>\nbody\n</Card>\n')).toEqual({ body: '<Card icon={<Icon />}>\nbody\n</Card>\n', lines: [] })
  })

  it('is linear on adversarial input', () => {
    const src = '<A '.repeat(50_000) + '</B>'.repeat(10_000) + '<A x'.repeat(10_000)
    const start = performance.now()
    escapeUnmatchedClosingTags(src)
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('is linear on repeated unterminated brace or quote openers', () => {
    for (const unit of ['<a {', '<a "']) {
      for (const run of [(s: string) => escapeUnmatchedClosingTags(s), (s: string) => normalizeMdx(s.replaceAll('<a', '<Steps'), 'mintlify')]) {
        const start = performance.now()
        run(unit.repeat(100_000))
        expect(performance.now() - start).toBeLessThan(200)
      }
    }
  })
})

describe('replaceOutsideCodeAndComments', () => {
  const upper = (text: string): string => text.toUpperCase()

  it('leaves closed comments alone and transforms the rest', () => {
    expect(replaceOutsideCodeAndComments('a {/* b */} c { /* d */ } e {/* f */ x} g {/* h */}', upper))
      .toBe('A {/* b */} C { /* d */ } E {/* f */ x} g {/* h */}')
    // an opener whose first `*/` is not followed by `}` runs on to the next closing `*/ }`
    expect(replaceOutsideCodeAndComments('a {/* b */ x} c {/* d */} e', upper)).toBe('A {/* b */ x} c {/* d */} E')
    expect(replaceOutsideCodeAndComments('a {/* open', upper)).toBe('A {/* OPEN')
  })

  it('stays linear on many unclosed or unmatched comment openers', () => {
    for (const body of ['{/*'.repeat(50_000), '{/*'.repeat(50_000) + '*/ x'.repeat(50_000), `${'{/*'.repeat(50_000)}*/ }`]) {
      const started = Date.now()
      replaceOutsideCodeAndComments(body, upper)
      expect(Date.now() - started).toBeLessThan(500)
    }
  })
})
