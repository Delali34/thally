/** The package's frontmatter parser must not be a code-execution sink. */

import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from '../frontmatter.js'
import { parseMarkdownPage } from '../mdx.js'

describe('parseFrontmatter', () => {
  it('does not execute javascript frontmatter', () => {
    const marker = '__migrate_frontmatter_probe__'
    const globals = globalThis as unknown as Record<string, unknown>
    delete globals[marker]

    const parsed = parseFrontmatter(
      `---js\n{ title: ((globalThis['${marker}'] = 'executed'), 'Hi') }\n---\n\nBody.`,
    )

    expect(globals[marker]).toBeUndefined()
    expect(parsed.data.title).toBeUndefined()
  })

  it('still parses the documented yaml frontmatter', () => {
    const parsed = parseFrontmatter('---\ntitle: Hello\n---\n\nBody.')
    expect(parsed.data.title).toBe('Hello')
    expect(parsed.content.trim()).toBe('Body.')
  })

  it('salvages readable fields and reports an error instead of throwing on invalid yaml', () => {
    // A bare backtick is a reserved YAML indicator; this mirrors crewAI's
    // ragtool.mdx frontmatter that previously aborted the whole migration.
    const parsed = parseFrontmatter(
      '---\ntitle: RagTool\ndescription: `RagTool` is great\n---\n\nBody.',
    )
    expect(parsed.error).toBeDefined()
    expect(parsed.data.title).toBe('RagTool')
    expect(parsed.data.description).toBeUndefined()
    expect(parsed.content.trim()).toBe('Body.')
  })
})

describe('parseMarkdownPage', () => {
  it.each(['', '{/* Removed unsupported component */}\n\n'])('separates Docusaurus display heading and sidebar label from the metadata title after %s', (prefix) => {
    const page = parseMarkdownPage({ id: 'guide', platform: 'docusaurus', source: 'guide.mdx',
      raw: `---\ntitle: Long SEO title\nsidebar_label: Short sidebar label\n---\n\n${prefix}# Display title\n\nBody.`,
    })
    expect(page?.title).toBe('Long SEO title')
    expect(page?.headingTitle).toBe('Display title')
    expect(page?.navTitle).toBe('Short sidebar label')
    expect(page?.body).not.toContain('# Display title')
  })

  it.each(['mintlify', 'fern', 'docusaurus'] as const)('reports cyclic metadata safely for %s', (platform) => {
    const warnings: string[] = []
    const page = parseMarkdownPage({
      id: 'cyclic', platform, source: 'cyclic.mdx', warn: (message) => warnings.push(message),
      raw: '---\nauthMethod: &loop [*loop]\nplayground: *loop\n---\nBody.',
    })
    expect(page?.authMethod).toBeUndefined()
    expect(page?.playground).toBeUndefined()
    expect(warnings).toHaveLength(2)
    expect(warnings.join(' ')).toContain('authMethod')
    expect(warnings.join(' ')).toContain('playground')
  })

  it.each(['mintlify', 'fern', 'docusaurus'] as const)('drops non-string icon variants for %s', (platform) => {
    for (const value of ['{toString: null}', '[solid]', 'null', '42', 'true']) {
      const page = parseMarkdownPage({
        id: 'typed', platform, source: 'typed.mdx',
        raw: `---\nicon: book\niconType: ${value}\n---\nBody.`,
      })
      expect(page?.icon).toBe('book')
      expect(page?.iconType).toBeUndefined()
    }
    for (const value of ['regular', 'solid', 'outline', 'brands']) {
      expect(parseMarkdownPage({
        id: 'typed', platform, source: 'typed.mdx',
        raw: `---\nicon: book\niconType: ${value}\n---\nBody.`,
      })?.iconType).toBe(value)
    }
  })

  it('does not execute javascript frontmatter in scraped pages', () => {
    const marker = '__migrate_page_frontmatter_probe__'
    const globals = globalThis as unknown as Record<string, unknown>
    delete globals[marker]

    parseMarkdownPage({
      id: 'scraped',
      raw: `---js\n{ title: ((globalThis['${marker}'] = 'executed'), 'Hi') }\n---\n\nBody.`,
      source: 'https://example.com/scraped',
    })

    expect(globals[marker]).toBeUndefined()
  })

  it('keeps the page and flags frontmatterError instead of aborting on invalid yaml', () => {
    const page = parseMarkdownPage({
      id: 'ragtool',
      raw: '---\ntitle: RagTool\ndescription: `RagTool` is great\n---\n\nBody text.',
      source: 'docs/ragtool.mdx',
    })

    expect(page).not.toBeNull()
    expect(page?.title).toBe('RagTool')
    expect(page?.frontmatterError).toBeDefined()
    expect(page?.description).toContain('Body text.')
  })
})

describe('parseMarkdownPage description', () => {
  const parse = (frontmatter: string) =>
    parseMarkdownPage({ id: 'p', raw: `---\ntitle: P\n${frontmatter}---\n\nFirst paragraph of the body.\n`, source: 'p.mdx' })

  it('derives a description from the body for ordinary pages', () => {
    expect(parse('')?.description).toBe('First paragraph of the body.')
  })

  it('does not derive one from the body for an openapi page, but keeps an authored one', () => {
    expect(parse('openapi: "openapi.json POST /scrape"\n')?.description).toBe('')
    expect(parse('openapi: "openapi.json POST /scrape"\ndescription: Authored\n')?.description).toBe('Authored')
  })
})

describe('Mintlify metadata compatibility', () => {
  it('reports omitted platform fields while preserving display and visibility metadata', () => {
    const warnings: string[] = []
    const page = parseMarkdownPage({ id: 'guide', platform: 'mintlify', source: 'guide.mdx', warn: (message) => warnings.push(message), raw: '---\ntitle: Guide\nsidebarTitle: Short\nhidden: true\nnoindex: true\nmode: frame\nlayout: custom-vendor-layout\n---\nBody.' })
    expect(page).toMatchObject({ title: 'Guide', navTitle: 'Short', hidden: true, noindex: true, mode: 'wide' })
    expect(warnings).toEqual([expect.stringContaining('layout')])
  })
})
