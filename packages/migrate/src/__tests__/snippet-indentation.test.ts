/** An inlined multi-line snippet keeps the indentation of the tag it replaces, so it stays inside the element or list item that held the tag. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { compileSync } from '@mdx-js/mdx'
import { describe, expect, it } from 'vitest'

import { migrateRepository } from '../index.js'

function migrate(page: string, snippets: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-indent-'))
  writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['home'] } }))
  writeFileSync(join(root, 'home.mdx'), `---\ntitle: Home\n---\n\n${page}\n`)
  for (const [path, body] of Object.entries(snippets)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
  const body = bundle.pages.find((candidate) => candidate.id === 'home')!.body
  expect(() => compileSync(body, { format: 'mdx' }), body).not.toThrow()
  return body
}

const fields = '- **Name**: first\n- **Description**: second\n'
const step = (tag: string) => `<Steps>\n    <Step>\n        Fill out the form's fields:\n\n        ${tag}\n\n        Then, select **Connect**.\n    </Step>\n</Steps>`

describe('indentation of an inlined snippet', () => {
  it('keeps a list snippet used by component tag inside an indented Step', () => {
    const body = migrate(`import Fields from '/snippets/fields.mdx'\n\n${step('<Fields />')}`, { 'snippets/fields.mdx': fields })
    expect(body).toContain('        - **Name**: first\n        - **Description**: second\n')
  })

  it('keeps a list snippet used by <Snippet file> inside an indented Step', () => {
    const body = migrate(step('<Snippet file="fields.mdx" />'), { 'snippets/fields.mdx': fields })
    expect(body).toContain('        - **Name**: first\n        - **Description**: second\n')
  })

  it('keeps the code and blank lines of a snippet with a fenced block inside an indented Step', () => {
    const body = migrate(
      `import Run from '/snippets/run.mdx'\n\n${step('<Run />')}`,
      { 'snippets/run.mdx': 'Run it:\n\n```bash\nnpm start\n\n# done\n```\n' },
    )
    // The renderer's own pass moves a fence in a Step back to column 0; the code keeps its blank line.
    expect(body).toContain('        Run it:\n\n```bash\nnpm start\n\n# done\n```\n')
  })

  it('aligns a snippet that starts right after a list marker with the item text', () => {
    const body = migrate(`import Fields from '/snippets/fields.mdx'\n\n1. <Fields />\n2. Next`, { 'snippets/fields.mdx': fields })
    expect(body).toContain('1. - **Name**: first\n   - **Description**: second\n2. Next')
  })

  it('does not indent the lines of a multi-line template literal, which would change its text', () => {
    const body = migrate(
      `import Demo from '/snippets/demo.mdx'\n\n${step('<Demo />')}`,
      { 'snippets/demo.mdx': '<Card title={`attribute one\nattribute two`} />\n\n<Note>\n{`child one\nchild two`}\n</Note>\n\nAfter the code.\n' },
    )
    expect(body).toContain('        <Card title={`attribute one\nattribute two`} />\n\n        <Note>\n        {`child one\nchild two`}\n        </Note>\n\n        After the code.\n')
  })

  it('leaves a snippet used at the start of a line unchanged', () => {
    const body = migrate(`import Fields from '/snippets/fields.mdx'\n\n<Fields />`, { 'snippets/fields.mdx': fields })
    expect(body).toBe('- **Name**: first\n- **Description**: second')
  })

  describe('code fences', () => {
    const python = '```python\nprint("hello")\n```'
    const nested = '````md\n```js\nx()\n```\n````'
    const indented = '```python\ndef f():\n    return 1\n```'
    const demo = (snippet: string) => ({ 'snippets/demo.mdx': `${snippet}\n` })
    const use = (tag: string) => `import Demo from '/snippets/demo.mdx'\n\n${tag}`

    it('keeps the code of a fence in a list item exactly as written', () => {
      expect(migrate(use('- <Demo />'), demo(python))).toContain(`\n${python}`)
    })

    it('keeps a ~~~ fence in a list item exactly as written', () => {
      const tilde = '~~~python\nprint("hello")\n~~~'
      expect(migrate(use('- <Demo />'), demo(tilde))).toContain(`\n${tilde}`)
    })

    it('keeps a four-backtick fence, and the fence it holds, exactly as written', () => {
      expect(migrate(use('- <Demo />'), demo(nested))).toContain(`\n${nested}`)
    })

    it('keeps an indented line of code after a numbered item, and still aligns the text around it', () => {
      const body = migrate(use('1. <Demo />\n2. Next'), demo(`Do it:\n\n${indented}\n\nDone.`))
      expect(body).toContain(`\n${indented}\n`)
      expect(body).toContain('\n   Done.\n2. Next')
    })

    it('keeps the code of a fence inside an indented Step exactly as written', () => {
      expect(migrate(use(step('<Demo />')), demo(`Run it:\n\n${indented}\n\nDone.`))).toContain(`\n${indented}\n`)
    })

    it('keeps the code of a fence that opens the snippet inside an indented Step', () => {
      expect(migrate(use(step('<Demo />')), demo(indented))).toContain(`\n${indented}\n`)
    })

    it('keeps the code of a fence in a <Snippet file> used in a list item', () => {
      expect(migrate('- <Snippet file="demo.mdx" />', demo(python))).toContain(`\n${python}`)
    })
  })
})
