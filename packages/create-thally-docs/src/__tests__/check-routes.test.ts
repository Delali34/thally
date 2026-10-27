/** Reader-route validation must match locale fallback and configured redirects. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runCheck } from '../check.js'

async function checkLinks(
  links: string,
  redirects: Array<{ source: string; destination: string }> = [],
  translation?: string,
  extraPages: Record<string, string> = {},
): Promise<{ exit: number; output: string }> {
  const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-routes-'))
  writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({
    tabs: [{ tab: 'Docs', pages: ['introduction', 'api-reference/token'] }],
    i18n: { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'zh-Hans', label: 'Chinese' }] },
    redirects,
  }))
  const pages: Record<string, string> = {
    introduction: links,
    'api-reference/token': '## Response\n\nThis reference explains the complete response returned by the API.',
    ...(translation ? { 'zh-Hans/api-reference/token': translation } : {}),
    ...extraPages,
  }
  for (const [path, body] of Object.entries(pages)) {
    const file = join(projectDir, `src/content/${path}.mdx`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `---\ntitle: Reference\ndescription: Complete reference documentation.\n---\n\n${body}`)
  }
  const output: Array<string> = []
  const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
  try {
    const exit = await runCheck(projectDir, { fix: false, ci: true })
    return { exit, output: output.join('\n') }
  } finally {
    log.mockRestore()
  }
}

describe('thally check reader routes', () => {
  it('does not label a deliberately hidden page as an orphan', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-hidden-'))
    mkdirSync(join(projectDir, 'src', 'content'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Docs', pages: ['introduction'] }] }))
    writeFileSync(join(projectDir, 'src', 'content', 'introduction.mdx'), '---\ntitle: Intro\ndescription: Introduction page.\n---\n\nIntroduction content.')
    writeFileSync(join(projectDir, 'src', 'content', 'archived.mdx'), '---\ntitle: Archived\ndescription: Archived page.\nhidden: true\n---\n\nArchived content.')
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      expect(await runCheck(projectDir, { fix: false, ci: true })).toBe(0)
      expect(output.join('\n')).not.toContain('orphan')
    } finally {
      log.mockRestore()
    }
  })
  it('accepts locale fallback and both introduction URLs', async () => {
    const result = await checkLinks('[Reference](/zh-Hans/api-reference/token#response) [Home](/introduction) [Localized home](/zh-Hans/introduction)')
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken')
  })

  it('recognizes indented headings and explicit id attributes as real anchors', async () => {
    const result = await checkLinks([
      '<Tab title="Setup">',
      '  ## Install the CLI',
      '',
      '  Follow these steps.',
      '</Tab>',
      '',
      '<div id="explicit-target">Custom anchor</div>',
      '',
      '[Indented heading](#install-the-cli) [Explicit id](#explicit-target)',
    ].join('\n'))
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken anchor')
  })

  it('matches encoded fragments to explicit IDs', async () => {
    const result = await checkLinks('<a id="section-$ref"></a>\n\n[Settings](#section-%24ref)')
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken anchor')
  })

  it('accepts legacy named anchors in imported notebook pages', async () => {
    const result = await checkLinks('<a name="subscribe"></a>\n\n[Subscribe](#subscribe)')
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken anchor')
  })

  it('resolves a link to the id a heading carries in a trailing {/* #id */} comment', async () => {
    const result = await checkLinks([
      '## Primeros pasos {/* #get-started */}',
      '## Scrape + Interact {/* #scrape-+-interact */}',
      '[Start](#get-started) [Plus](#scrape-+-interact) [Slug](#primeros-pasos)',
    ].join('\n'))
    expect(result.output).not.toContain('"#get-started"')
    expect(result.output).not.toContain('"#scrape-+-interact"')
    expect(result.output).toContain('"#primeros-pasos"')
  })

  it('reads a heading as the renderer does, with no text from a JSX badge or anchor in it', async () => {
    const result = await checkLinks([
      '## Initialize instance <Badge title="1 > 0">Enterprise</Badge>',
      '### CLI <a id="-cli" />',
      '[Instance](#initialize-instance) [Enterprise](#initialize-instance-enterprise) [CLI](#cli)',
    ].join('\n'))
    expect(result.output).not.toContain('"#initialize-instance"')
    expect(result.output).toContain('"#initialize-instance-enterprise"')
    expect(result.output).not.toContain('"#cli"')
  })

  it('resolves an underlined heading, and only the h2 to h6 headings the renderer gives an id', async () => {
    const result = await checkLinks([
      'Param name',
      '----------',
      '',
      'Title',
      '=====',
      '',
      '# Intro',
      '',
      '###### Deep',
      '[Setext](#param-name) [Level one](#title) [Atx level one](#intro) [Deep](#deep)',
    ].join('\n'))
    expect(result.output).not.toContain('"#param-name"')
    expect(result.output).toContain('"#title"')
    expect(result.output).toContain('"#intro"')
    expect(result.output).not.toContain('"#deep"')
  })

  it('numbers a field after an h1 and an underlined heading as the renderer does', async () => {
    const field = '<ParamField body="name" type="string">The name.</ParamField>'
    const h1 = await checkLinks(`# Param name\n\n${field}\n\n[Field](#param-name) [Numbered](#param-name-1)`)
    expect(h1.output).not.toContain('"#param-name"')
    expect(h1.output).toContain('"#param-name-1"')
    const setext = await checkLinks(`Param name\n----------\n\n${field}\n\n[Heading](#param-name) [Field](#param-name-1)`)
    expect(setext.output).not.toContain('"#param-name"')
    expect(setext.output).not.toContain('"#param-name-1"')
  })

  it('finds a heading inside a component, a quote and a list, and none in a code fence', async () => {
    const result = await checkLinks([
      '<Accordion title="Setup">',
      '',
      '## Inside',
      '',
      '</Accordion>',
      '',
      '> ## Quoted',
      '',
      '- ## Listed',
      '',
      '```md',
      '## Fenced',
      '```',
      '',
      '',
      '[Inside](#inside) [Quoted](#quoted) [Listed](#listed) [Accordion](#setup) [Body](#setup-accordion-children)',
      '',
      '[Fenced](#fenced)',
    ].join('\n'))
    for (const found of ['inside', 'quoted', 'listed', 'setup', 'setup-accordion-children']) expect(result.output, found).not.toContain(`"#${found}"`)
    expect(result.output).toContain('"#fenced"')
  })

  it('reads an indented heading as a heading, since MDX has no indented code', async () => {
    const result = await checkLinks('Text.\n\n    ## Indented\n\n[Indented](#indented)')
    expect(result.output).not.toContain('"#indented"')
  })

  it('takes the id of a {/* #id */} comment anywhere in the heading', async () => {
    const result = await checkLinks('## Before {/* #mine */} after\n\n[Mine](#mine) [Slug](#before-after)')
    expect(result.output).not.toContain('"#mine"')
    expect(result.output).toContain('"#before-after"')
  })

  it('accepts the second occurrence of a repeated heading', async () => {
    const result = await checkLinks('## Key Features\n\nFirst.\n\n## Key Features\n\nSecond.\n\n[Second](#key-features-2)')
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken anchor')
  })

  it('lets an explicit id reserve its id so a generated duplicate skips it', async () => {
    const result = await checkLinks('## Foo\n\n## Foo\n\n## Foo {/* #foo-2 */}\n\n[Second](#foo-3) [Explicit](#foo-2) [Gone](#foo-4)')
    expect(result.output).not.toContain('"#foo-3"')
    expect(result.output).not.toContain('"#foo-2"')
    expect(result.output).toContain('"#foo-4"')
  })

  it('resolves a link to a step title that renders as a heading, numbered with the other headings', async () => {
    const result = await checkLinks([
      '## Deploy',
      '<Steps titleSize="h3">',
      '<Step title="Create a project">',
      'Body.',
      '</Step>',
      '<Step',
      '  title="Deploy"',
      '>',
      'Body.',
      '</Step>',
      '</Steps>',
      '## Deploy',
      '[Step](#create-a-project) [Second](#deploy-2) [Third](#deploy-3) [Gone](#deploy-4)',
    ].join('\n'))
    expect(result.output).not.toContain('"#create-a-project"')
    expect(result.output).not.toContain('"#deploy-2"')
    expect(result.output).not.toContain('"#deploy-3"')
    expect(result.output).toContain('"#deploy-4"')
  })

  it.each([
    ['no titleSize', '<Steps>\n<Step title="One">x</Step>\n</Steps>'],
    ['titleSize="p"', '<Steps titleSize="p">\n<Step title="One">x</Step>\n</Steps>'],
    ['a Step with titleSize="p"', '<Steps titleSize="h3">\n<Step title="One" titleSize="p">x</Step>\n</Steps>'],
    ['a step shown in a code fence', '```mdx\n<Steps titleSize="h3">\n<Step title="One">x</Step>\n</Steps>\n```'],
    ['a Step with no title', '<Steps titleSize="h3">\n<Step>x</Step>\n</Steps>'],
    ['a Step with a blank title', '<Steps titleSize="h3">\n<Step title="   ">x</Step>\n</Steps>'],
  ])('does not take a step title as an anchor: %s', async (_name, steps) => {
    const result = await checkLinks(`${steps}\n\n[Step](#one)`)
    expect(result.output).toContain('"#one"')
  })

  it('reads a step title from a tag whose other props hold an object', async () => {
    const result = await checkLinks('<Steps titleSize="h3">\n<Step title="Styled" style={{ color: "red" }}>x</Step>\n<Step title="After">x</Step>\n</Steps>\n\n[One](#styled) [Two](#after)')
    expect(result.output).not.toContain('"#styled"')
    expect(result.output).not.toContain('"#after"')
  })

  it.each([
    ['an element holding an object', '<Step title="Deep" icon={<Icon style={{ color: "red" }} />}>x</Step>'],
    ['objects nested three deep', '<Step title="Deep" data={{ a: { b: { c: 1 } } }}>x</Step>'],
    ['several lines and three levels', '<Step\n  title="Deep"\n  data={{\n    a: { b: 1 },\n  }}\n>x</Step>'],
    ['a ">" in an expression and in a string', '<Step title="Deep" onClick={() => go({ a: 1 })} note="a > b">x</Step>'],
  ])('reads a step title from a tag with %s', async (_name, step) => {
    const result = await checkLinks(`<Steps titleSize="h3">\n${step}\n</Steps>\n\n[Deep](#deep)`)
    expect(result.output).not.toContain('"#deep"')
  })

  it('takes the size from the Step over its Steps', async () => {
    const result = await checkLinks('<Steps titleSize="p">\n<Step title="One" titleSize="h4">x</Step>\n<Step title="Two">x</Step>\n</Steps>\n\n[One](#one) [Two](#two)')
    expect(result.output).not.toContain('"#one"')
    expect(result.output).toContain('"#two"')
  })

  it('ignores links, images, and headings inside nested code fences', async () => {
    const result = await checkLinks([
      '````mdx',
      '```tsx',
      '<a href="/missing">Example</a>',
      '<img src="/missing.png" />',
      '### code-only-heading',
      '```',
      '````',
      '',
      '[Real link](/api-reference/token#response)',
      '[Not a real heading](#code-only-heading)',
    ].join('\n'))
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken link: "/missing"')
    expect(result.output).not.toContain('Broken image')
    expect(result.output).toContain('Broken anchor: "#code-only-heading"')
  })

  it('uses actual translated anchors when a translation exists', async () => {
    const result = await checkLinks('[Reference](/zh-Hans/api-reference/token#response)', [], '## Localized heading\n\nThe translated document has a different heading.')
    expect(result.exit).toBe(0)
    expect(result.output).toContain('Broken anchor')
  })

  it('follows redirect chains and destination fragments before checking anchors', async () => {
    const result = await checkLinks('[Old reference](/old#outdated)', [
      { source: '/old', destination: '/older?source=docs' },
      { source: '/older', destination: '/api-reference/token?source=old#response' },
    ])
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken')
  })

  it('resolves a link through a Next.js-style wildcard/param redirect source the same way the runtime matches it', async () => {
    const result = await checkLinks('[Old reference](/old/api-reference/token)', [
      { source: '/old/:slug*', destination: '/:slug*' },
    ])
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken')
  })

  it('still reports a broken link when a wildcard/param redirect resolves to a page that does not exist', async () => {
    const result = await checkLinks('[Missing](/old/nowhere)', [
      { source: '/old/:slug*', destination: '/:slug*' },
    ])
    expect(result.exit).toBe(1)
    expect(result.output).toContain('Broken link: "/old/nowhere"')
  })

  it('matches a redirect source ignoring letter case, and reads a regular expression for a parameter', async () => {
    const result = await checkLinks('[Old](/OLD) [Param](/legacy/api-reference/token)', [
      { source: '/old', destination: '/introduction' },
      { source: '/legacy/:path(.*)', destination: '/:path' },
    ])
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken')
  })

  it('reports a link that a regular-expression parameter does not match, and none once a source Next.js refuses might move it', async () => {
    const result = await checkLinks('[Other](/legacy/c)', [
      { source: '/legacy/:path(a|b)', destination: '/introduction' },
    ])
    expect(result.output).toContain('Broken link: "/legacy/c"')
    const unread = await checkLinks('[Unread](/unread/a-x) [Missing](/missing)', [
      { source: '/unread/(a(b))', destination: '/introduction' },
    ])
    expect(unread.output).not.toContain('Broken link')
  })

  it('splits a path on a literal dash the way Next.js does', async () => {
    // Next.js reads `/:section-:slug` on `/docs-v1-token` as section `docs-v1` and slug `token`, not `docs` and `v1-token`.
    const result = await checkLinks('[Token](/docs-v1-token)', [
      { source: '/:section-:slug', destination: '/:section/:slug' },
    ], undefined, { 'docs-v1/token': 'The token page, written to be long enough that the check does not call it empty.' })
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken')
  })

  it('reads an escaped character after an optional or repeated parameter, so a link through it resolves', async () => {
    for (const modifier of ['?', '*', '+']) {
      // `?` takes one segment and `*` or `+` any number; `+` needs one.
      const result = await checkLinks('[None](/legacy-x) [One](/legacy/a-x) [Two](/legacy/a/b-x) [Elsewhere](/legacyx)', [
        { source: `/legacy/:slug${modifier}\\-x`, destination: '/introduction' },
      ])
      const broken = ['/legacy-x', '/legacy/a-x', '/legacy/a/b-x', '/legacyx'].filter((link) => result.output.includes(`Broken link: "${link}"`))
      expect(broken, modifier).toEqual(modifier === '?' ? ['/legacy/a/b-x', '/legacyx'] : modifier === '*' ? ['/legacyx'] : ['/legacy-x', '/legacyx'])
    }
  })

  it('terminates on a wildcard redirect whose destination keeps matching its own source', async () => {
    const result = await checkLinks('[Docs](/docs/intro)', [
      { source: '/docs/:slug*', destination: '/docs/v2/:slug*' },
    ])
    expect(result.exit).toBe(1)
  })

  it('matches a trailing :param* with zero segments, like Next.js', async () => {
    const result = await checkLinks('[Old](/old)', [
      { source: '/old/:slug*', destination: '/introduction/:slug*' },
    ])
    expect(result.exit).toBe(0)
  })

  it('reports a link to a page whose own trailing :param* redirect sends it to itself', async () => {
    const result = await checkLinks('[Token](/api-reference/token)', [
      { source: '/api-reference/token/:path*', destination: '/api-reference/token' },
    ])
    expect(result.exit).toBe(1)
    expect(result.output).toContain('Broken link: "/api-reference/token"')
  })

  it('reaches the page itself, and follows deeper paths to it, through a trailing :param+ redirect', async () => {
    const result = await checkLinks('[Token](/api-reference/token#response) [Deeper](/api-reference/token/overview#response)', [
      { source: '/api-reference/token/:path+', destination: '/api-reference/token' },
    ])
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken')
  })

  it('accepts a link to a path that redirects to an address outside the site', async () => {
    const result = await checkLinks('[Examples](/docs/examples) [Zapier](/docs/integrations/zapier#setup)', [
      { source: '/docs/examples', destination: 'https://github.com/dubinc/examples' },
      { source: '/docs/integrations/zapier', destination: 'https://dub.co/integrations/zapier' },
    ])
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken')
  })

  it('follows a wildcard redirect to an address outside the site without reading its scheme as a parameter', async () => {
    const result = await checkLinks('[Old](/old/a/b)', [
      { source: '/old/:path*', destination: 'https://example.com:8080/new/:path*' },
    ])
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain('Broken')
  })

  it('substitutes params by exact name when one name prefixes another', async () => {
    const result = await checkLinks('[Old](/x/1/token)', [
      { source: '/x/:a/:abc', destination: '/api-reference/:abc' },
    ])
    expect(result.exit).toBe(0)
  })

  it('keeps missing locale targets, missing changelog content, and redirect cycles as errors', async () => {
    const result = await checkLinks('[Missing](/zh-Hans/quickstart) [Changes](/changelog) [Cycle](/loop)', [
      { source: '/loop', destination: '/other' },
      { source: '/other', destination: '/loop' },
    ])
    expect(result.exit).toBe(1)
    expect(result.output).toContain('3 error(s)')
    expect(result.output).toContain('Broken link: "/zh-Hans/quickstart"')
    expect(result.output).toContain('Broken link: "/changelog"')
    expect(result.output).toContain('Broken link: "/loop"')
  })
})
