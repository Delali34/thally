/** Public runtime integration: Step anchors agree across rendering, content projection and the portable checker. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { slugify } from '../../packages/core/src/slugify'
import { parseMdxContent } from '../../packages/core/src/content/parse'
import { rehypePlugins } from './rehype'
import { runCheck } from '../../packages/create-thally-docs/src/check'

async function brokenAnchorOutput(body: string, link: string): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-heading-ids-'))
  mkdirSync(join(projectDir, 'src/content'), { recursive: true })
  writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Docs', pages: ['introduction'] }] }))
  writeFileSync(
    join(projectDir, 'src/content/introduction.mdx'),
    `---\ntitle: Intro\ndescription: Introduction page.\n---\n\n${body}\n\nThis page has enough prose to avoid the short body notice. [Jump](#${link})`,
  )
  const output: Array<string> = []
  const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
  try {
    await runCheck(projectDir, { fix: false, ci: true })
  } finally {
    log.mockRestore()
  }
  return output.join('\n')
}

/** Every `id` the renderer gives the compiled page, in document order. */
async function renderedIds(source: string): Promise<Array<string>> {
  const { compile } = await import('@mdx-js/mdx')
  const compiled = String(await compile(source, { rehypePlugins: [rehypePlugins[2]] }))
  return [...compiled.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1])
}

describe('step title ids with character references', () => {
  it.each(['A &amp; B', 'A &#x26; B', 'A &#38; B', '&lt;tag&gt;', 'Caf&eacute;'])('gives the title %s one id in thally check, the renderer and the content parser', async (title) => {
    const source = `<Steps titleSize="h3">\n<Step title="${title}">\nBody.\n</Step>\n</Steps>`
    const [id] = await renderedIds(source)
    expect(parseMdxContent(source).headings.map((heading) => heading.id)).toEqual([id])
    expect(await brokenAnchorOutput(source, id)).not.toContain('Broken anchor')
    // The id the title would get from its source text, character references undecoded, is not an anchor.
    expect(await brokenAnchorOutput(source, slugify(title))).toContain('Broken anchor')
  })

  it('reads a titleSize written with a character reference as the renderer does', async () => {
    const source = '<Steps titleSize="h&#51;">\n<Step title="Deploy">\nBody.\n</Step>\n</Steps>'
    expect(await renderedIds(source)).toEqual(['deploy'])
    expect(await brokenAnchorOutput(source, 'deploy')).not.toContain('Broken anchor')
  })
})

describe('step tags that are not elements of the page', () => {
  const inlineCode = 'Write `<Steps titleSize="h3"><Step title="Deploy">` in the file.'
  const comment = '{/* <Steps titleSize="h3"><Step title="Deploy"></Step></Steps> */}'
  const fence = '```mdx\n<Steps titleSize="h3">\n<Step title="Deploy">x</Step>\n</Steps>\n```'
  const real = '## Deploy\n\n<Steps titleSize="h3">\n<Step title="Deploy">\nBody.\n</Step>\n</Steps>'

  it.each([
    ['inline code', inlineCode],
    ['an MDX comment', comment],
    ['a code fence', fence],
    ['all three', [inlineCode, comment, fence].join('\n\n')],
  ])('numbers the headings after %s as the renderer and the content parser do', async (_name, before) => {
    const source = `${before}\n\n${real}`
    const ids = await renderedIds(source)
    expect(ids).toEqual(['deploy', 'deploy-2'])
    expect(parseMdxContent(source).headings.map((heading) => heading.id)).toEqual(ids)
    for (const id of ids) expect(await brokenAnchorOutput(source, id)).not.toContain('Broken anchor')
    // A phantom step ahead of the heading would have pushed it to `deploy-3`.
    expect(await brokenAnchorOutput(source, 'deploy-3')).toContain('Broken anchor')
  })

  it('finds no step in a page MDX cannot read, as the content parser does, and does not fail', async () => {
    const source = '<Steps titleSize="h3">\n<Step title="One">x</Step>\n</Steps>\n\n{unclosed'
    expect(parseMdxContent(source).headings).toEqual([])
    expect(await brokenAnchorOutput(source, 'one')).toContain('Broken anchor')
  })
})


describe('authored step heading ids', () => {
  it.each([
    ['  install  ', 'install'],
    ['   ', 'deploy'],
    ['', 'deploy'],
  ])('normalizes the explicit id %j across all heading paths', async (authored, expected) => {
    const source = `<Steps titleSize="h3">\n<Step title="Deploy" id="${authored}">Body.</Step>\n</Steps>\n\n## ${expected}`
    const ids = await renderedIds(source)
    expect(ids).toEqual([expected, `${expected}-2`])
    expect(parseMdxContent(source).headings.map((heading) => heading.id)).toEqual(ids)
    for (const id of ids) expect(await brokenAnchorOutput(source, id)).not.toContain('Broken anchor')
  })

  it('preserves and reserves explicit ids across steps and Markdown headings', async () => {
    const source = [
      '## Install', '',
      '<Steps titleSize="h3">',
      '<Step title="Deploy" id="install">Body.</Step>',
      '<Step title="Repeat" id="install">Body.</Step>',
      '</Steps>', '',
      '## Install',
    ].join('\n')
    const ids = await renderedIds(source)
    expect(ids).toEqual(['install-2', 'install', 'install-3', 'install-4'])
    expect(parseMdxContent(source).headings.map((heading) => heading.id)).toEqual(ids)
    for (const id of ids) expect(await brokenAnchorOutput(source, id)).not.toContain('Broken anchor')
    for (const absent of ['deploy', 'repeat', 'install-5']) {
      expect(await brokenAnchorOutput(source, absent)).toContain('Broken anchor')
    }
  })
})

describe('step titles with inline code', () => {
  it.each([
    ['Run the CLI `init` command', 'run-the-cli-init-command'],
    ['Create an `actions.ts` file', 'create-an-actions-ts-file'],
    ['`a`b', 'ab'],
  ])('gives the title %s the id of its plain text in thally check, the renderer and the content parser', async (title, id) => {
    const source = `<Steps titleSize="h3">\n<Step title="${title}">\nBody.\n</Step>\n</Steps>`
    expect(await renderedIds(source)).toEqual([id])
    expect(parseMdxContent(source).headings.map((heading) => heading.id)).toEqual([id])
    expect(await brokenAnchorOutput(source, id)).not.toContain('Broken anchor')
    expect(parseMdxContent(source).headings.map((heading) => heading.text)).toEqual([title.replaceAll('`', '')])
  })
})
