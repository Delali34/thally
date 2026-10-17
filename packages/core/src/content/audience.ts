/** Audience-aware MDX projection shared by structured and Markdown outputs. */

import type { Root, RootContent } from 'mdast'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type ContentAudience = 'humans' | 'agents' | 'all'

interface SourceEdit {
  start: number
  end: number
}

const processor = unified().use(remarkParse).use(remarkMdx)

function visibilityAudience(node: RootContent): Exclude<ContentAudience, 'all'> | null {
  if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return null
  if (node.name === 'Human') return 'humans'
  if (node.name === 'Agent') return 'agents'
  if (node.name !== 'Visibility') return null

  const attribute = node.attributes.find(
    (candidate) => candidate.type === 'mdxJsxAttribute' && candidate.name === 'for',
  )
  if (!attribute || attribute.type !== 'mdxJsxAttribute' || typeof attribute.value !== 'string') return null
  return attribute.value === 'humans' || attribute.value === 'agents' ? attribute.value : null
}

function collectExcludedRanges(nodes: Array<RootContent>, audience: Exclude<ContentAudience, 'all'>, edits: Array<SourceEdit>): void {
  for (const node of nodes) {
    const visibility = visibilityAudience(node)
    if (visibility && visibility !== audience && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      edits.push({ start: node.position.start.offset, end: node.position.end.offset })
      continue
    }
    if ('children' in node && Array.isArray(node.children)) {
      collectExcludedRanges(node.children as Array<RootContent>, audience, edits)
    }
  }
}

/** Remove content explicitly addressed to the other audience without evaluating MDX. */
export function projectMdxAudience(source: string, audience: ContentAudience = 'all'): string {
  if (audience === 'all') return source
  // Most documents contain no audience wrappers. Parsing those here and again
  // for the canonical content graph doubles cold-corpus work. These literal
  // prefixes cover every wrapper recognized below; false positives (including
  // examples inside code) deliberately retain the ordinary parser path.
  if (!source.includes('<Human') && !source.includes('<Agent') && !source.includes('<Visibility')) return source
  let tree: Root
  try {
    tree = processor.parse(source) as Root
  } catch {
    return source
  }

  const edits: Array<SourceEdit> = []
  collectExcludedRanges(tree.children, audience, edits)
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce((result, edit) => result.slice(0, edit.start) + result.slice(edit.end), source)
}
