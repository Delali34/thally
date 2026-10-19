import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes } from 'mdast'

// CommonMark with GFM, the grammar a description is rendered with. MDX is not
// used: in an API description `{id}` and `<tag>` are text, not code.
const processor = unified().use(remarkParse).use(remarkGfm)

/** Raw HTML the parser identified: tags and comments are markup, the text between tags is content. */
const HTML_MARKUP = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g

/** Parents whose children are blocks; a space keeps one block's last word from fusing with the next one's first. */
const BLOCK_PARENTS = new Set<string>(['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'footnoteDefinition'])

function textOf(node: Nodes): string {
  if (node.type === 'html') return node.value.replace(HTML_MARKUP, '')
  if (node.type === 'break') return ' '
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if ('children' in node) return (node.children as Array<Nodes>).map(textOf).join(BLOCK_PARENTS.has(node.type) ? ' ' : '')
  return 'value' in node ? node.value : ''
}

/**
 * CommonMark as one line of plain text, the way a page's meta description
 * carries an OpenAPI description. The words a reader sees stay: link and image
 * text, autolinked URLs and addresses, emphasis and code span text, escaped
 * characters. Raw HTML tags drop out, blocks and line breaks become spaces.
 * It reads the same mdast tree the content parser builds, so what counts as a
 * link, a tag or a code span is decided by the parser, not by a pattern.
 */
export function markdownToPlainText(markdown: string): string {
  return textOf(processor.parse(markdown)).replace(/\s+/g, ' ').trim()
}
