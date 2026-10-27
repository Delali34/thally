/** The container the stylesheet import confines its rules to is the one the Thally runtime renders page content in, and the shell is never inside it. */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { CONTENT_CONTAINER } from '../source-styles.js'

const src = join(fileURLToPath(new URL('../../../../', import.meta.url)), 'src')
// The runtime's navbar, sidebar, table of contents, breadcrumbs, pagination, search and footer.
const SHELL = new Set(['TopBar', 'MobileNav', 'Sidebar', 'TableOfContents', 'DocBreadcrumbs', 'DocPagination', 'CommandSearch', 'Footer'])

const tags = (node: ts.Node, into: Array<string> = []): Array<string> => {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) into.push(node.tagName.getText())
  ts.forEachChild(node, (child) => { tags(child, into) })
  return into
}

describe('the page content container', () => {
  it('is the class the runtime\'s Prose gives the element that holds a page\'s content', () => {
    const prose = readFileSync(join(src, 'components/mdx/prose.tsx'), 'utf8')
    expect(prose).toMatch(new RegExp(`['"\`][^'"\`]*(?<![\\w-])${CONTENT_CONTAINER.slice(1)}(?![\\w-])`))
  })

  it('never holds the navbar, sidebar, table of contents, breadcrumbs, pagination, search or footer', () => {
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
    const withProse = files.filter((file) => /<Prose[\s>]/.test(readFileSync(join(src, file), 'utf8'))).sort()
    // A new use of Prose has to be looked at here: what it wraps is what a site's rules can reach.
    expect(withProse).toEqual(['components/api/operation-panel.tsx', 'components/docs/doc-layout.tsx'])
    for (const file of withProse) {
      const source = ts.createSourceFile(file, readFileSync(join(src, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const inside: Array<string> = []
      const visit = (node: ts.Node): void => {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'Prose') inside.push(...tags(node))
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(inside, file).toContain('Prose')
      expect(inside.filter((tag) => SHELL.has(tag)), file).toEqual([])
    }
  })
})
