import { describe, expect, it } from 'vitest'
import { parseMdxContent } from '../parse'
import { slugify } from '../../slugify'

const sample = `## Getting Started

Install the package and run the dev server.

\`\`\`bash Install
npm install thally
\`\`\`

### Configuration

Set your \`API_KEY\` in the environment.

<Steps>
<Step title="First step">

#### Nested heading

Some prose with a [link](https://example.com/docs).

\`\`\`ts
const x = 1
\`\`\`

</Step>
</Steps>

## Getting Started
`

describe('parseMdxContent', () => {
  const parsed = parseMdxContent(sample)

  it('extracts headings including nested ones inside JSX', () => {
    const texts = parsed.headings.map((h) => h.text)
    expect(texts).toContain('Getting Started')
    expect(texts).toContain('Configuration')
    expect(texts).toContain('Nested heading')
  })

  it('uses the renderer slugger and de-duplicates ids', () => {
    const ids = parsed.headings.filter((h) => h.text === 'Getting Started').map((h) => h.id)
    expect(ids[0]).toBe(slugify('Getting Started'))
    // The duplicate heading must get a unique id so anchors do not collide.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('extracts code blocks with language and fence title', () => {
    expect(parsed.codeBlocks).toHaveLength(2)
    expect(parsed.codeBlocks[0]).toMatchObject({ language: 'bash', title: 'Install', index: 0 })
    expect(parsed.codeBlocks[0].source).toBe('npm install thally')
    expect(parsed.codeBlocks[1]).toMatchObject({ language: 'ts', index: 1 })
    expect(parsed.codeBlocks.every((block) => block.hasLanguageTag)).toBe(true)
  })

  it('extracts prose text without fenced code', () => {
    expect(parsed.text).toContain('Install the package')
    expect(parsed.text).not.toContain('npm install thally')
    expect(parsed.text).not.toContain('const x = 1')
  })

  it('extracts links', () => {
    expect(parsed.links).toContainEqual({ url: 'https://example.com/docs', text: 'link' })
  })

  it('builds a nested table of contents', () => {
    const top = parsed.toc.find((item) => item.text === 'Getting Started')
    expect(top?.children?.some((c) => c.text === 'Configuration')).toBe(true)
  })

  it('produces heading-bounded sections anchored to heading ids', () => {
    const config = parsed.sections.find((s) => s.title === 'Configuration')
    expect(config).toBeDefined()
    expect(config?.id).toBe(slugify('Configuration'))
    expect(config?.text).toContain('Set your')
    expect(config?.headingPath).toEqual(['Getting Started', 'Configuration'])

    const nested = parsed.sections.find((s) => s.title === 'Nested heading')
    expect(nested?.code.some((c) => c.language === 'ts')).toBe(true)
  })
})

describe('parseMdxContent step titles', () => {
  const source = [
    '## Deploy', '',
    '<Steps titleSize="h3">',
    '<Step title="Create a project">', 'Pick a name.', '</Step>',
    '<Step title="Deploy">', 'Push the branch.', '</Step>',
    '</Steps>', '',
    '## Next steps', '',
    'Read more.',
  ].join('\n')

  it('lists step titles that render as headings, numbered with the rest of the page', () => {
    expect(parseMdxContent(source).headings).toEqual([
      { depth: 2, text: 'Deploy', id: 'deploy' },
      { depth: 3, text: 'Create a project', id: 'create-a-project' },
      { depth: 3, text: 'Deploy', id: 'deploy-2' },
      { depth: 2, text: 'Next steps', id: 'next-steps' },
    ])
  })

  it('nests them in the table of contents and gives each its own section', () => {
    const parsed = parseMdxContent(source)
    expect(parsed.toc[0].children?.map((item) => item.id)).toEqual(['create-a-project', 'deploy-2'])
    const deploy = parsed.sections.find((section) => section.id === 'deploy-2')
    expect(deploy?.headingPath).toEqual(['Deploy', 'Deploy'])
    expect(deploy?.text).toContain('Push the branch.')
    expect(deploy?.text).not.toContain('Pick a name.')
  })

  it('takes the size from the Step over its Steps, and from any wrapper in between', () => {
    const parsed = parseMdxContent([
      '<Steps titleSize="p">', '<Step title="A" titleSize="h4">x</Step>', '<Step title="B">x</Step>', '</Steps>', '',
      '<Steps titleSize="h2">', '<div>', '<Step title="C">x</Step>', '</div>', '</Steps>',
    ].join('\n'))
    expect(parsed.headings.map(({ depth, text }) => [depth, text])).toEqual([[4, 'A'], [2, 'C']])
  })

  it.each([
    ['no titleSize', '<Steps>\n<Step title="One">x</Step>\n</Steps>'],
    ['titleSize="p"', '<Steps titleSize="p">\n<Step title="One">x</Step>\n</Steps>'],
    ['a titleSize expression', '<Steps titleSize={size}>\n<Step title="One">x</Step>\n</Steps>'],
    ['a title expression', '<Steps titleSize="h3">\n<Step title={"One"}>x</Step>\n</Steps>'],
  ])('lists nothing for steps with %s', (_name, body) => {
    expect(parseMdxContent(body).headings).toEqual([])
  })

  it('keeps the step title in the page text', () => {
    expect(parseMdxContent(source).text).toContain('Create a project')
  })
})

describe('parseMdxContent JSX attribute prose', () => {
  it('lifts literal prose attributes into section text, in reader order', () => {
    const parsed = parseMdxContent(
      '## Cards\n\n<Card title="Shape the navigation" icon="book-open">\nOrganize pages into tabs.\n</Card>\n',
    )
    const section = parsed.sections.find((s) => s.title === 'Cards')
    expect(section?.text).toBe('Shape the navigation\nOrganize pages into tabs.')
  })

  it('lifts attributes from self-closing elements', () => {
    const parsed = parseMdxContent('## Media\n\n<Frame caption="Dashboard overview" />\n')
    expect(parsed.text).toContain('Dashboard overview')
  })

  it('lifts attributes from inline elements without gluing words', () => {
    const parsed = parseMdxContent('## Terms\n\nHover the <Tooltip tip="Service level agreement">SLA</Tooltip> badge.\n')
    expect(parsed.text).toContain('Service level agreement')
    expect(parsed.text).toContain('SLA')
  })

  it('ignores expression values, empty strings, and non-prose attributes', () => {
    const parsed = parseMdxContent(
      '## Edge\n\n<Card title={dynamicTitle} icon="party-horn" href="/quickstart">\nBody prose.\n</Card>\n\n<Card title="">\nMore prose.\n</Card>\n',
    )
    expect(parsed.text).toContain('Body prose.')
    expect(parsed.text).toContain('More prose.')
    expect(parsed.text).not.toContain('dynamicTitle')
    expect(parsed.text).not.toContain('party-horn')
    expect(parsed.text).not.toContain('/quickstart')
  })
})

describe('parseMdxContent audience projection', () => {
  const source = `## Shared

Visible to everyone.

<Visibility for="humans">

## Human setup

Use the dashboard.

</Visibility>

<Visibility for="agents">

## Agent setup

Use the API.

</Visibility>

<Human>Human shorthand.</Human>
<Agent>Agent shorthand.</Agent>`

  it('projects structured content for the agent audience', () => {
    const parsed = parseMdxContent(source, 'agents')
    expect(parsed.text).toContain('Visible to everyone.')
    expect(parsed.text).toContain('Use the API.')
    expect(parsed.text).toContain('Agent shorthand.')
    expect(parsed.text).not.toContain('Use the dashboard.')
    expect(parsed.text).not.toContain('Human shorthand.')
    expect(parsed.headings.map((heading) => heading.text)).toContain('Agent setup')
    expect(parsed.headings.map((heading) => heading.text)).not.toContain('Human setup')
  })

  it('preserves all authored audiences by default for API compatibility', () => {
    const parsed = parseMdxContent(source)
    expect(parsed.text).toContain('Use the dashboard.')
    expect(parsed.text).toContain('Use the API.')
  })

  it('can project the human audience without leaking agent-only content', () => {
    const parsed = parseMdxContent(source, 'humans')
    expect(parsed.text).toContain('Use the dashboard.')
    expect(parsed.text).toContain('Human shorthand.')
    expect(parsed.text).not.toContain('Use the API.')
    expect(parsed.text).not.toContain('Agent shorthand.')
  })
})

describe('heading id markers', () => {
  it('uses a trailing {/* #id */} comment as the heading id and keeps it out of the heading text', () => {
    const parsed = parseMdxContent('## Primeros pasos {/* #get-started */}\n\nTexto.\n\n## Scrape + Interact {/* #scrape-+-interact */}\n')
    expect(parsed.headings.map((heading) => [heading.text, heading.id])).toEqual([
      ['Primeros pasos', 'get-started'],
      ['Scrape + Interact', 'scrape-+-interact'],
    ])
  })
})

describe('duplicate heading ids', () => {
  const ids = (source: string) => parseMdxContent(source).headings.map((heading) => heading.id)

  it('numbers repeated headings foo, foo-2, foo-3', () => {
    expect(ids('## Foo\n\n## Foo\n\n## Foo\n')).toEqual(['foo', 'foo-2', 'foo-3'])
  })

  it('lets an explicit id reserve its id, so a generated id skips it', () => {
    expect(ids('## Foo\n\n## Foo\n\n## Foo {/* #foo-2 */}\n')).toEqual(['foo', 'foo-3', 'foo-2'])
    expect(ids('## Foo\n\n## Foo\n\n## Foo {/* #foo-1 */}\n')).toEqual(['foo', 'foo-2', 'foo-1'])
    expect(ids('## Bar\n\n## X {/* #bar */}\n')).toEqual(['bar-2', 'bar'])
  })

  it('numbers a repeated explicit id and never repeats an id', () => {
    const result = ids('## A {/* #x */}\n\n## B {/* #x */}\n\n## X\n')
    expect(result).toEqual(['x', 'x-2', 'x-3'])
    expect(new Set(result).size).toBe(result.length)
  })
})

describe('code fence language tags', () => {
  it('distinguishes an untagged fence from an explicit text fence', () => {
    const { codeBlocks } = parseMdxContent('```\nplain\n```\n\n```text\nexplicit\n```\n')
    expect(codeBlocks.map((block) => [block.language, block.hasLanguageTag])).toEqual([
      ['text', false],
      ['text', true],
    ])
  })
})
