/** `thally check` reports a page whose MDX the renderer cannot parse, and only such a page. */

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import remarkGfm from 'remark-gfm'
import { describe, expect, it, vi } from 'vitest'

import { parseMdxPage, runCheck } from '../check.js'

const PROSE = 'This page has enough prose to avoid the short body notice for the check.'

/** Run `thally check --ci` on a site whose `introduction` page is `files['src/content/introduction.mdx']`, with the other files beside it. */
async function checkSite(files: Record<string, string>): Promise<{ code: number; output: string }> {
  const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-mdx-syntax-'))
  writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Docs', pages: ['introduction'] }] }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(projectDir, path)), { recursive: true })
    writeFileSync(join(projectDir, path), content)
  }
  const output: Array<string> = []
  const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
  try {
    return { code: await runCheck(projectDir, { fix: false, ci: true }), output: output.join('\n') }
  } finally {
    log.mockRestore()
  }
}

/** Run `thally check --ci` on a one-page site with this body under a valid frontmatter block. */
function checkPage(body: string): Promise<{ code: number; output: string }> {
  return checkSite({ 'src/content/introduction.mdx': `---\ntitle: Intro\ndescription: Introduction page.\n---\n${body}` })
}

describe('thally check MDX syntax', () => {
  it('reports a JSX attribute with escaped quotes at its line, with the parser reason, and fails --ci', async () => {
    const { code, output } = await checkPage(`\n${PROSE}\n\n<video src="/a.mp4" aria-label="typing \\"Firecrawl\\" here" />\n`)

    expect(code).toBe(1)
    // Frontmatter takes lines 1-4, so the tag is on line 8 of the file.
    expect(output).toMatch(/^::error file=src\/content\/introduction\.mdx,line=8::MDX syntax error: Unexpected character `\\` \(U\+005C\) in attribute name[^\n]*\. The page cannot render until this is fixed\.$/m)
    expect(output).toContain('1 error(s)')
  })

  it('accepts the same text written as an expression attribute', async () => {
    const { code, output } = await checkPage(`\n${PROSE}\n\n<video src="/a.mp4" aria-label={"typing \\"Firecrawl\\" here"} />\n`)

    expect(code).toBe(0)
    expect(output).not.toContain('MDX syntax error')
  })

  it('does not report a snippet import the renderer removes, and counts lines of the file, not of the parsed text', async () => {
    // MDX reads an import and the lines right after it as one block of
    // JavaScript, so this parses only because the renderer removes the import.
    const accepted = await checkPage(`\n${PROSE}\n\nimport { Intro } from '/snippets/intro.mdx'\n# Heading\n\n<Intro />\n`)
    expect(accepted.code).toBe(0)
    expect(accepted.output).not.toContain('MDX syntax error')

    // Three lines of the file are removed before the parser sees the tag; the report names its line in the file.
    const reported = await checkPage(`\n${PROSE}\n\nimport { Intro } from '/snippets/intro.mdx'\n\n\n\n<video aria-label="a \\"b\\"" />\n`)
    expect(reported.output).toMatch(/^::error file=src\/content\/introduction\.mdx,line=12::MDX syntax error/m)
  })

  it('passes a page with frontmatter and no body', async () => {
    const { code, output } = await checkPage('')

    expect(code).toBe(0)
    expect(output).not.toContain('MDX syntax error')
  })

  it('reads a page with GFM on, as the renderer does', async () => {
    // A URL is a link before `{id?}` can be an expression; a pipe splits a table row before a `{` can close.
    const link = await checkPage(`\n${PROSE}\n\nSee https://api.example.com/users/{id?} for one user.\n`)
    expect(link.code).toBe(0)
    expect(link.output).not.toContain('MDX syntax error')

    const table = await checkPage(`\n${PROSE}\n\n| Name | Value |\n| ---- | ----- |\n| {a || b} | c |\n`)
    expect(table.code).toBe(1)
    expect(table.output).toMatch(/line=10::MDX syntax error: Unexpected end of file in expression/)
  })

  it('reports each broken page once, whether or not it has a <Step>', async () => {
    const { output } = await checkPage(`\n${PROSE}\n\n<Steps titleSize="h3">\n<Step title="One">\n<img alt="a \\"b\\"" />\n</Step>\n</Steps>\n`)

    expect(output.match(/MDX syntax error/g)).toHaveLength(1)
  })
})

describe('thally check MDX syntax: which files', () => {
  const page = `---\ntitle: Intro\ndescription: Introduction page.\n---\n\n${PROSE}\n`

  it('ignores a file the build does not compile: another spelling of the extension, or a symbolic link', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'thally-check-mdx-outside-'))
    writeFileSync(join(outside, 'broken.mdx'), '<Note>unclosed')
    const { code, output } = await checkSite({
      'src/content/introduction.mdx': page,
      'src/content/archive.MDX': '---\ntitle: Archive\n---\n<Note>unclosed',
      'snippets/Upper.MDX': '<Note>unclosed',
      'snippets/notes.md': '<Note>unclosed',
    })
    expect(code).toBe(0)
    expect(output).not.toContain('MDX syntax error')

    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-mdx-link-'))
    mkdirSync(join(projectDir, 'src/content'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Docs', pages: ['introduction'] }] }))
    writeFileSync(join(projectDir, 'src/content/introduction.mdx'), page)
    symlinkSync(join(outside, 'broken.mdx'), join(projectDir, 'src/content/linked.mdx'))
    const lines: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => lines.push(String(value)))
    try {
      expect(await runCheck(projectDir, { fix: false, ci: true })).toBe(0)
    } finally {
      log.mockRestore()
    }
    expect(lines.join('\n')).not.toContain('MDX syntax error')
  })

  it('reports a snippet the build compiles, at its own path and line, in any folder under snippets/', async () => {
    const { code, output } = await checkSite({
      'src/content/introduction.mdx': page,
      'snippets/intro.mdx': '---\ntitle: Intro snippet\n---\nText\n\n<Note>unclosed',
      'snippets/nested/deep.mdx': '<video aria-label="a \\"b\\"" />',
      'snippets/imports.mdx': "import { A } from '/snippets/a.mdx'\n# Heading\n\n<A />",
    })

    expect(code).toBe(1)
    expect(output).toMatch(/^::error file=snippets\/intro\.mdx,line=6::MDX syntax error: Expected a closing tag for `<Note>`[^\n]*\. Pages that use this snippet cannot render until this is fixed\.$/m)
    expect(output).toMatch(/^::error file=snippets\/nested\/deep\.mdx,line=1::MDX syntax error: Unexpected character `\\`/m)
    expect(output).toContain('2 error(s)')
  })
})

describe('thally check MDX syntax: line numbers', () => {
  it.each([
    ['frontmatter that repeats the start of the body', '---\ntitle: "{1 +}"\n---\n{1 +}', 4],
    ['Windows line endings', '---\r\ntitle: Intro\r\n---\r\n\r\n{1 +}', 5],
    ['a byte order mark', '\ufeff---\ntitle: Intro\n---\n{1 +}', 4],
    ['no frontmatter', 'Intro\n\n{1 +}', 3],
    ['empty frontmatter', '---\n---\n{1 +}', 3],
    ['bare carriage returns', 'Text\r\r{1 +}', 3],
    ['bare carriage returns after frontmatter', '---\ntitle: Intro\n---\nText\r\r{1 +}', 6],
    ['a frontmatter block closed by bare carriage returns, which the renderer reads as body', '---\rtitle: Intro\r---\r{1 +}', 4],
  ])('reports the line in the file for %s', async (_name, raw, line) => {
    const { output } = await checkSite({ 'src/content/introduction.mdx': raw })

    expect(output).toContain(`::error file=src/content/introduction.mdx,line=${line}::MDX syntax error`)
  })

  it('finds the line of thousands of offsets without rescanning the page for each', () => {
    // One paragraph per line pair, so the offset and line of each are known.
    const starts: Array<number> = []
    let at = 0
    const paragraphs = Array.from({ length: 20_000 }, (_, index) => {
      starts.push(at)
      at += `Line ${index}`.length + 2
      return `Line ${index}`
    })
    const page = parseMdxPage(paragraphs.join('\n\n'))

    const started = performance.now()
    const wrong = starts.filter((start, index) => page.lineAt(start) !== 2 * index + 1)
    const elapsed = performance.now() - started

    expect(wrong).toEqual([])
    // Scanning the page for each offset takes tens of seconds here; this takes milliseconds.
    expect(elapsed).toBeLessThan(2_000)
  }, 30_000)
})

describe('thally check agrees with the MDX compiler the build uses', () => {
  // The renderer removes snippet imports with this pattern before it compiles.
  const script = readFileSync(fileURLToPath(new URL('../../../../scripts/build-runtime-sources.mts', import.meta.url)), 'utf8')
  const pattern = /const snippetImportPattern = (\/.+\/gm)$/m.exec(script)![1]
  const check = readFileSync(fileURLToPath(new URL('../check.ts', import.meta.url)), 'utf8')

  it('removes snippet imports with the pattern the build uses', () => {
    expect(check).toContain(`const SNIPPET_IMPORT = ${pattern}`)
  })

  it.each([
    ['an escaped quote in a JSX attribute', '<video aria-label="a \\"b\\"" />', true],
    ['an unclosed tag', '<Note>text', true],
    ['an invalid expression', 'Count: {1 +}', true],
    ['a snippet import above a heading', "import { A } from '/snippets/a.mdx'\n# Heading", false],
    ['a URL with braces', 'https://example.com/{id?}', false],
    ['a pipe inside an expression in a table', '| a | b |\n| - | - |\n| {x || y} | z |', true],
    ['an expression attribute with escaped quotes', '<video aria-label={"a \\"b\\""} />', false],
  ])('%s', async (_name, body, rejected) => {
    const { compile } = await import('@mdx-js/mdx')
    const compiles = await compile(body.replace(new RegExp(pattern.slice(1, -3), 'gm'), ''), { remarkPlugins: [remarkGfm] }).then(() => true, () => false)
    expect(compiles).toBe(!rejected)

    const { output } = await checkPage(`\n${PROSE}\n\n${body}\n`)
    expect(output.includes('MDX syntax error')).toBe(rejected)
  })
})
