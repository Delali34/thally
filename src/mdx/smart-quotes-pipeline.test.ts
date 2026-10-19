/** The docs.json `smartQuotes` setting through the real MDX pipeline: off changes nothing, on leaves ids alone. */

import { compile, evaluate } from '@mdx-js/mdx'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseMdxContent } from '../../packages/core/src/content/parse'
import { mdxToMarkdown } from '../../packages/core/src/content/to-markdown'
import { builtinMdxComponents } from '@/components/mdx/builtin-components'
import { PageSlotsProvider } from '@/components/mdx/page-slots'
import { resetDocsJsonConfigForTests } from '@/lib/docs-json-config'
import { interpretMDX } from '@/lib/mdx-interpret'
import { rehypePlugins } from './rehype'
import { remarkPlugins } from './remark'

function setSmartQuotes(value: unknown): void {
  vi.stubEnv('THALLY_DOCS_CONFIG', JSON.stringify({ tabs: [], smartQuotes: value }))
  resetDocsJsonConfigForTests()
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetDocsJsonConfigForTests()
})

const page = (content: ReactNode): string => renderToStaticMarkup(createElement(PageSlotsProvider, null, content))
/** React escapes straight quotes in markup; undo that so the assertions read as authored. */
const unescape = (html: string): string => html.replaceAll('&#x27;', '\'').replaceAll('&quot;', '"')

async function render(source: string, plugins = rehypePlugins): Promise<string> {
  const { default: Content } = await evaluate(source, { ...runtime, remarkPlugins, rehypePlugins: plugins } as never)
  return unescape(page(createElement(Content, { components: builtinMdxComponents })))
}

const source = [
  '## What\'s new in "v2"?',
  '',
  'It doesn\'t break: `it\'s "code"` stays, and "Investigate a failed deployment" reads well.',
  '',
  '```js',
  'const message = "it\'s"',
  '```',
  '',
  '[Don\'t panic](https://example.com/it\'s)',
  '',
  '<Card title="Don\'t panic">It\'s "fine"</Card>',
].join('\n')

describe('rehype smart quotes', () => {
  it('is the last plugin, so it runs after heading ids are assigned', () => {
    expect(rehypePlugins.map((plugin) => plugin.name)).toEqual([
      'rehypeParseCodeBlocks', 'rehypeShiki', 'rehypeUniqueHeadingIds', 'rehypeSmartQuotes',
    ])
  })

  it('changes nothing while the setting is off', async () => {
    const withoutStep = String(await compile(source, { remarkPlugins, rehypePlugins: rehypePlugins.slice(0, 3) }))
    expect(String(await compile(source, { remarkPlugins, rehypePlugins }))).toBe(withoutStep)
    for (const value of [false, 'true', 1, null]) {
      setSmartQuotes(value)
      expect(String(await compile(source, { remarkPlugins, rehypePlugins }))).toBe(withoutStep)
    }
  })

  it('converts prose, keeps code, links and attributes straight, and keeps ids when on', async () => {
    setSmartQuotes(true)
    const html = await render(source)
    expect(html).toContain('What’s new in “v2”?')
    expect(html).toContain('It doesn’t break:')
    expect(html).toContain('<code>it\'s "code"</code>')
    expect(html).toContain('“Investigate a failed deployment”')
    expect(html).toContain('>it\'s</span>')
    expect(html).toContain('href="https://example.com/it\'s"')
    expect(html).toContain('>Don’t panic</a>')
    expect(html).toContain('It’s “fine”')
    // `title` is a JSX attribute value: left as authored.
    expect(html).toContain('Don\'t panic')
    expect(html).not.toContain('Don’t panic</p>')
  })

  it('gives a heading containing a quote the id it has with the setting off', async () => {
    const ids = async (): Promise<Array<string>> =>
      [...(await render(source)).matchAll(/<h2[^>]*\bid="([^"]+)"/g)].map((match) => match[1])
    const before = await ids()
    expect(before).toEqual(['what-s-new-in-v2'])
    setSmartQuotes(true)
    expect(await ids()).toEqual(before)
  })

  it('numbers repeated quoted headings the same with the setting on or off', async () => {
    const repeated = '## It\'s here\n\n## It\'s here\n\n### "Quoted" title'
    const ids = async (): Promise<Array<string>> =>
      [...(await render(repeated)).matchAll(/<h[23][^>]*\bid="([^"]+)"/g)].map((match) => match[1])
    const before = await ids()
    expect(before).toEqual(['it-s-here', 'it-s-here-2', 'quoted-title'])
    setSmartQuotes(true)
    expect(await ids()).toEqual(before)
  })

  it('shows the curly heading in the table of contents label, which reads the rendered heading', async () => {
    const label = async (): Promise<string | undefined> =>
      (await render('## It\'s "here"')).match(/<h2[^>]*\bdata-heading="(.*?)" data-level/)?.[1]
    expect(await label()).toBe('It\'s "here"')
    setSmartQuotes(true)
    expect(await label()).toBe('It’s “here”')
  })

  it('keeps a step title and its id as authored', async () => {
    const steps = '<Steps titleSize="h3">\n<Step title="Don\'t stop">It\'s a step.</Step>\n</Steps>'
    const html = async (): Promise<string> => render(steps)
    const before = await html()
    setSmartQuotes(true)
    expect((await html()).replace('It’s a step.', 'It\'s a step.')).toBe(before)
    expect(before).toMatch(/<h3[^>]*\bid="don-t-stop"[^>]*>Don't stop<\/h3>/)
  })

  it('leaves the Markdown, outline and search text projections on the authored text', () => {
    const mdx = '## What\'s new in "v2"?\n\nIt doesn\'t "break".\n'
    const project = () => ({ markdown: mdxToMarkdown(mdx), parsed: parseMdxContent(mdx) })
    const before = project()
    setSmartQuotes(true)
    const after = project()
    expect(after).toEqual(before)
    expect(after.markdown).toContain('It doesn\'t "break".')
    expect(after.parsed.text).toContain('It doesn\'t "break".')
    expect(after.parsed.headings.map((heading) => [heading.id, heading.text])).toEqual([['what-s-new-in-v2', 'What\'s new in "v2"?']])
  })

  it('applies to the request-time interpreter, which runs the same plugins', async () => {
    const interpret = async (): Promise<string> => {
      const { content } = await interpretMDX({ source, components: builtinMdxComponents })
      return unescape(page(content))
    }
    expect(await interpret()).toContain('It doesn\'t break')
    setSmartQuotes(true)
    const html = await interpret()
    expect(html).toContain('It doesn’t break')
    expect(html).toMatch(/<h2[^>]*\bid="what-s-new-in-v2"/)
  })
})
