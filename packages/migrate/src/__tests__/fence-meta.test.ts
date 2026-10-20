/** Fence cleanup must affect only proven metadata tokens, never titles or examples. */
import { compileSync } from '@mdx-js/mdx'
import { describe, expect, it } from 'vitest'
import { normalizeMintlifyCodeFences } from '../fence-meta.js'


describe('Mintlify fence metadata normalization', () => {
  it('removes article-style theme/twoslash metadata while preserving title, highlight and example bytes', () => {
    const code = 'const theme = "theme={\\"system\\"} twoslash"\nconsole.log(theme)'
    const source = `\`\`\`typescript title="client.ts" theme={"system"} twoslash lines highlight={2}\n${code}\n\`\`\``
    const warnings: string[] = []
    const result = normalizeMintlifyCodeFences(source, (message) => warnings.push(message))
    expect(result).toBe(`\`\`\`typescript title="client.ts" lines highlight={2}\n${code}\n\`\`\``)
    expect(warnings).toEqual([expect.stringContaining('theme, twoslash')])
    expect(() => compileSync(result)).not.toThrow()
  })
  it('keeps quoted title text and unknown balanced option values intact', () => {
    const source = '```ts title="theme=literal twoslash" custom={"theme":"twoslash"} theme={"dark":{"value":"}"}} focus={1}\nconst value = 1\n```'
    const warnings: string[] = []
    const result = normalizeMintlifyCodeFences(source, (message) => warnings.push(message))
    expect(result).toContain('title="theme=literal twoslash" custom={"theme":"twoslash"} focus={1}')
    expect(warnings).toEqual([expect.stringContaining('Removed unsupported'), expect.stringContaining('custom')])
  })
  it('keeps nested example fences inside a Markdown code sample byte for byte', () => {
    const source = '````markdown\n```ts theme={"system"} twoslash\nconst value = 1\n```\n````'
    expect(normalizeMintlifyCodeFences(source)).toBe(source)
  })
})
