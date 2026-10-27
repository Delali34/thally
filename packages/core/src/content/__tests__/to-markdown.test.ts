import { describe, expect, it } from 'vitest'
import { mdxToMarkdown } from '../to-markdown'

describe('mdxToMarkdown', () => {
  it('strips JSX wrappers but keeps their inner content', () => {
    const out = mdxToMarkdown('<Steps>\n\nFirst paragraph.\n\n</Steps>')
    expect(out).toContain('First paragraph.')
    expect(out).not.toMatch(/<\/?Steps/)
  })

  it('drops a heading id comment from the Markdown view', () => {
    expect(mdxToMarkdown('## Scrape + Interact {/* #scrape-+-interact */}\n\ntext')).toBe('## Scrape + Interact\n\ntext')
  })

  it('promotes title-bearing components to headings', () => {
    expect(mdxToMarkdown('<Step title="Create your project">\nbody\n</Step>')).toContain('#### Create your project')
    expect(mdxToMarkdown('<Card title="Quickstart" href="/quickstart">x</Card>')).toContain(
      '#### [Quickstart](/quickstart)',
    )
    expect(mdxToMarkdown("<Tab title='Node'>x</Tab>")).toContain('#### Node') // single quotes too
  })

  it('keeps the content of a Step with no title and adds no heading for it', () => {
    const out = mdxToMarkdown('<Steps>\n<Step>\nOnly content.\n</Step>\n</Steps>')
    expect(out).toBe('Only content.')
    expect(out).not.toContain('####')
  })

  it('turns callouts into labelled blockquotes and API fields into list items', () => {
    expect(mdxToMarkdown('<Note>Be careful.</Note>')).toContain('> **Note:** Be careful.')
    expect(mdxToMarkdown('<Warning title="Rotate first">Then deploy.</Warning>')).toContain('> **Rotate first:** Then deploy.')
    expect(mdxToMarkdown('<Callout icon="key" color="#C77DFF">Custom.</Callout>')).toContain('> **Note:** Custom.')
    expect(mdxToMarkdown('<Callout type="warning">Careful.</Callout>')).toContain('> **Warning:** Careful.')
    expect(mdxToMarkdown('<ParamField path="limit" type="integer">Max rows</ParamField>')).toContain(
      '- **limit** (integer): Max rows',
    )
  })

  it('never rewrites JSX inside fenced code (component-doc pages stay intact)', () => {
    const src = 'Use a card:\n\n```mdx\n<Card title="X" href="/y">Body</Card>\n```\n\nDone.'
    const out = mdxToMarkdown(src)
    expect(out).toContain('```mdx\n<Card title="X" href="/y">Body</Card>\n```') // preserved verbatim
    expect(out).toContain('Done.')
  })

  it('never rewrites JSX inside inline code', () => {
    const out = mdxToMarkdown('The `<Note>` component renders a callout.')
    expect(out).toBe('The `<Note>` component renders a callout.')
  })

  it('leaves plain Markdown and lowercase HTML untouched', () => {
    const src = '# Title\n\nA list:\n\n- one\n- two\n\n<https://example.com> and <br/> stay.'
    expect(mdxToMarkdown(src)).toBe(src)
  })

  it('does not corrupt prose containing bare numbers (sentinel safety)', () => {
    const out = mdxToMarkdown('There are `3` steps and step 1 of 3 is easy.')
    expect(out).toContain('step 1 of 3 is easy')
    expect(out).toContain('`3`')
  })

  it('projects visibility for agents while preserving authored examples in code', () => {
    const source = `<Human>Browser instructions.</Human>
<Agent>Machine instructions.</Agent>
<Visibility for="humans">Dashboard only.</Visibility>
<Visibility for="agents">API only.</Visibility>

\`\`\`mdx
<Human>Example remains literal.</Human>
\`\`\``
    const out = mdxToMarkdown(source)
    expect(out).toContain('Machine instructions.')
    expect(out).toContain('API only.')
    expect(out).not.toContain('Browser instructions.')
    expect(out).not.toContain('Dashboard only.')
    expect(out).toContain('<Human>Example remains literal.</Human>')
  })

  it('projects compound components and GitHub cards into clean Markdown', () => {
    const out = mdxToMarkdown('<Color><Color.Item name="Leaf" value="#b8ec36" /></Color>\n<GitHub repo="thallylabs/thally" />')
    expect(out).not.toContain('<Color')
    expect(out).toContain('[thallylabs/thally](https://github.com/thallylabs/thally)')
  })
})
