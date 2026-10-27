/**
 * Step titles that render as headings reach the table of contents with the id
 * the page actually carries, and agree with the content parser's outline.
 */

import { evaluate } from '@mdx-js/mdx'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import { describe, expect, it } from 'vitest'

import { parseMdxContent } from '../../../packages/core/src/content/parse'
import { interpretMDX } from '@/lib/mdx-interpret'
import { rehypePlugins } from '@/mdx/rehype'
import { builtinMdxComponents } from './builtin-components'
import { PageSlotsProvider } from './page-slots'

interface TocEntry { id: string; text: string; level: number }

/** What the table of contents reads: every `[data-heading]` element of the rendered page. */
function headings(html: string): Array<TocEntry> {
  return [...html.matchAll(/<h[2-6]\b[^>]*>/g)].flatMap(([tag]) => {
    const attribute = (name: string): string | undefined => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
    const text = attribute('data-heading')
    return text === undefined ? [] : [{ id: attribute('id') ?? '', text, level: Number(attribute('data-level')) }]
  })
}

const page = (content: ReactNode): string => renderToStaticMarkup(createElement(PageSlotsProvider, null, content))

async function toc(source: string): Promise<Array<TocEntry>> {
  const { default: Content } = await evaluate(source, { ...runtime, rehypePlugins: [rehypePlugins[2]] } as never)
  return headings(page(createElement(Content, { components: builtinMdxComponents })))
}

const deploy = [
  '<Steps titleSize="h3">',
  '<Step title="Create a project">', 'Pick a name.', '</Step>',
  '<Step title="Deploy">', 'Push the branch.', '</Step>',
  '</Steps>', '',
  '## Next steps',
].join('\n')

describe('step titles in the table of contents', () => {
  it('lists h3 step titles, then the markdown headings that follow, in page order', async () => {
    expect(await toc(deploy)).toEqual([
      { id: 'create-a-project', text: 'Create a project', level: 3 },
      { id: 'deploy', text: 'Deploy', level: 3 },
      { id: 'next-steps', text: 'Next steps', level: 2 },
    ])
  })

  it('numbers a step title that repeats a markdown heading, so every id is unique', async () => {
    const entries = await toc(`## Deploy\n\n${deploy}\n\n## Deploy`)
    expect(entries.map((entry) => entry.id)).toEqual(['deploy', 'create-a-project', 'deploy-2', 'next-steps', 'deploy-3'])
  })

  it('carries the same ids and levels as the content parser outline', async () => {
    const source = `## Deploy\n\n${deploy}\n\n## Deploy\n\n<Steps titleSize="h2">\n<Step title="Deploy">x</Step>\n</Steps>`
    const outline = parseMdxContent(source).headings.map(({ id, text, depth }) => ({ id, text, level: depth }))
    expect(await toc(source)).toEqual(outline)
  })

  it('numbers and marks the same headings on the eval-free path', async () => {
    const source = `## Deploy\n\n${deploy}`
    const { content } = await interpretMDX({ source, components: builtinMdxComponents })
    expect(headings(page(content))).toEqual(await toc(source))
    expect(headings(page(content)).map((entry) => entry.id)).toEqual(['deploy', 'create-a-project', 'deploy-2', 'next-steps'])
  })

  it('renders a step with no title and lists no entry for it, on both compilation paths', async () => {
    const source = '<Steps titleSize="h3">\n<Step>Only content.</Step>\n<Step title="Deploy">x</Step>\n</Steps>\n\n## Deploy'
    const expected = [
      { id: 'deploy', text: 'Deploy', level: 3 },
      { id: 'deploy-2', text: 'Deploy', level: 2 },
    ]
    expect(await toc(source)).toEqual(expected)
    expect(parseMdxContent(source).headings.map(({ id, text, depth }) => ({ id, text, level: depth }))).toEqual(expected)
    const { content } = await interpretMDX({ source, components: builtinMdxComponents })
    expect(headings(page(content))).toEqual(expected)
    expect(page(content)).toContain('Only content.')
  })

  it('lists nothing for steps without a heading size, as before', async () => {
    expect(await toc('<Steps>\n<Step title="One">x</Step>\n</Steps>\n\n<Steps titleSize="p">\n<Step title="Two">x</Step>\n</Steps>')).toEqual([])
  })

  it('leaves the id an author gave a plain-text step on its container, out of the outline and the numbering', async () => {
    const source = '## Deploy\n\n<Steps titleSize="p">\n<Step title="Add a new direct debit method" id="add-new-direct-debit-method">x</Step>\n</Steps>\n\n## Deploy'
    const { default: Content } = await evaluate(source, { ...runtime, rehypePlugins: [rehypePlugins[2]] } as never)
    const html = page(createElement(Content, { components: builtinMdxComponents }))
    expect(html).toMatch(/<div id="add-new-direct-debit-method" class="thally-step /)
    expect(html.match(/id="add-new-direct-debit-method"/g)).toHaveLength(1)
    expect(headings(html).map((entry) => entry.id)).toEqual(['deploy', 'deploy-2'])
    expect(parseMdxContent(source).headings.map((heading) => heading.id)).toEqual(['deploy', 'deploy-2'])
  })

  it('numbers the steps a page repeats in every View, so each View carries its own ids', async () => {
    const steps = '<Steps titleSize="h3">\n<Step title="Create a key">x</Step>\n<Step title="Verify the key">x</Step>\n</Steps>'
    const entries = await toc(['curl', 'TypeScript', 'Go', 'Python'].map((title) => `<View title="${title}">\n${steps}\n</View>`).join('\n\n'))
    expect(entries).toHaveLength(8)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(8)
    expect(entries.slice(0, 2).map((entry) => entry.id)).toEqual(['create-a-key', 'verify-the-key'])
  })
})


it('renders authored step anchors on both compilation paths and reserves them for the outline', async () => {
  const source = '## Install\n\n<Steps titleSize="h3">\n<Step title="Deploy" id="install">Body.</Step>\n</Steps>'
  const expected = [
    { id: 'install-2', text: 'Install', level: 2 },
    { id: 'install', text: 'Deploy', level: 3 },
  ]
  expect(await toc(source)).toEqual(expected)
  const { content } = await interpretMDX({ source, components: builtinMdxComponents })
  expect(headings(page(content))).toEqual(expected)
  expect(parseMdxContent(source).headings.map(({ id, text, depth }) => ({ id, text, level: depth }))).toEqual(expected)
})

it('lists a step title with a code span by its plain text, under the id its words would get', async () => {
  const source = '<Steps titleSize="h3">\n<Step title="Run the CLI `init` command">x</Step>\n<Step title="Create an `actions.ts` file">x</Step>\n</Steps>'
  const expected = [
    { id: 'run-the-cli-init-command', text: 'Run the CLI init command', level: 3 },
    { id: 'create-an-actions-ts-file', text: 'Create an actions.ts file', level: 3 },
  ]
  expect(await toc(source)).toEqual(expected)
  expect(parseMdxContent(source).headings.map(({ id, text, depth }) => ({ id, text, level: depth }))).toEqual(expected)
  const { content } = await interpretMDX({ source, components: builtinMdxComponents })
  expect(headings(page(content))).toEqual(expected)
})
