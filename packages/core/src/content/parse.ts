import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import { toString as mdastToString } from 'mdast-util-to-string'
import type { Root, RootContent } from 'mdast'
import { plainInlineText, slugify, updateAnchorId } from '../slugify.js'
import type {
  ContentCodeBlock,
  ContentUpdate,
  ContentHeading,
  ContentLink,
  ContentSection,
  ContentTocItem,
  ParsedContent,
} from './types.js'
import { projectMdxAudience, type ContentAudience } from './audience.js'
import { mdxToMarkdown } from './to-markdown.js'

// Single shared MDX → mdast parser. This is the one place content is parsed;
// every structured projection below is derived from the same tree.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMdx)

function parseToTree(markdown: string): Root {
  try {
    return processor.parse(markdown) as Root
  } catch {
    // Fall back to plain markdown parsing if MDX-specific syntax fails.
    return unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root
  }
}

/**
 * Heading ids, numbered `foo`, `foo-2`, `foo-3` exactly as the renderer and
 * `thally check` do. An explicit `{/* #id *\/}` reserves its id for the whole
 * page, so a generated id never takes it, wherever the heading sits.
 */
interface HeadingIds {
  reserved: Set<string>
  used: Set<string>
  occurrences: Map<string, number>
}

function ensureUniqueId(base: string, explicit: boolean, ids: HeadingIds): string {
  const slug = base || 'section'
  let id = slug
  let n = 1
  if (explicit) {
    while (ids.used.has(id)) id = `${slug}-${++n}`
  } else {
    n = ids.occurrences.get(slug) ?? 0
    do id = ++n === 1 ? slug : `${slug}-${n}`
    while (ids.used.has(id) || ids.reserved.has(id))
    ids.occurrences.set(slug, n)
  }
  ids.used.add(id)
  return id
}

function collectExplicitIds(nodes: ReadonlyArray<RootContent>, into: Set<string>, stepSize?: string) {
  for (const node of nodes) {
    if (node.type === 'heading') {
      const { explicitId } = headingTextAndId(node)
      if (explicitId) into.add(explicitId)
    }
    let childSize = stepSize
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      if (node.name === 'Steps') childSize = titleSizeOf(node) ?? undefined
      if (node.name === 'Step') {
        const own = titleSizeOf(node)
        const depth = STEP_HEADING_DEPTH.get((own === undefined ? stepSize : own) ?? '')
        const id = stringAttribute(node, 'id')?.trim() || undefined
        // Reserve only titles the heading pass will number, so plain steps cannot shift anchors.
        if (depth && stringAttribute(node, 'title')?.trim() && id) into.add(id)
      }
    }
    if ('children' in node) collectExplicitIds(node.children as Array<RootContent>, into, childSize)
  }
}

function cleanText(value: string): string {
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'listItem',
  'blockquote',
  'tableRow',
  'tableCell',
])

interface WalkState {
  /** Audience-projected source the tree was parsed from; entry bodies are sliced from it. */
  source: string
  updates: Array<ContentUpdate>
  headings: Array<ContentHeading>
  codeBlocks: Array<ContentCodeBlock>
  links: Array<ContentLink>
  sections: Array<ContentSection>
  textParts: Array<string>
  sectionTextParts: Array<string>
  current: ContentSection
  stack: Array<{ depth: number; text: string }>
  ids: HeadingIds
  codeIndex: number
}

const HEADING_ID_MARKER = /^\s*\/\*\s*#(\S+?)\s*\*\/\s*$/

/** A heading may end with a JSX comment holding `#id`; the renderer uses that id instead of slugging the text. */
function headingTextAndId(node: Extract<RootContent, { type: 'heading' }>): { text: string; explicitId?: string } {
  const children = node.children as Array<{ type: string; value?: string }>
  const marker = children.findIndex((child) => child.type === 'mdxTextExpression' && HEADING_ID_MARKER.test(child.value ?? ''))
  if (marker < 0) return { text: mdastToString(node).trim() }
  const rest = { ...node, children: node.children.filter((_, index) => index !== marker) }
  return { text: mdastToString(rest).trim(), explicitId: HEADING_ID_MARKER.exec(children[marker].value ?? '')![1] }
}

function startSection(state: WalkState, depth: number, text: string, explicitId?: string) {
  // Flush the previous section's accumulated text.
  state.current.text = cleanText(state.sectionTextParts.join(' '))
  state.sectionTextParts = []

  while (state.stack.length > 0 && state.stack[state.stack.length - 1].depth >= depth) {
    state.stack.pop()
  }
  const headingPath = [...state.stack.map((s) => s.text), text]
  state.stack.push({ depth, text })

  const id = ensureUniqueId(explicitId ?? slugify(text), explicitId !== undefined, state.ids)
  state.headings.push({ depth, text, id })

  const section: ContentSection = { id, title: text, depth, headingPath, text: '', code: [] }
  state.sections.push(section)
  state.current = section
}

function recordCode(state: WalkState, node: { lang?: string | null; meta?: string | null; value: string }) {
  const block: ContentCodeBlock = {
    language: node.lang || 'text',
    hasLanguageTag: Boolean(node.lang),
    title: node.meta?.trim() || undefined,
    source: node.value.trimEnd(),
    index: state.codeIndex++,
  }
  state.codeBlocks.push(block)
  state.current.code.push(block)
}

function appendText(state: WalkState, value: string) {
  if (!value) return
  state.textParts.push(value)
  state.sectionTextParts.push(value)
}

// JSX attributes that carry reader-visible prose (Card/Step/Tab titles, Frame
// captions, Update labels, image alt text, …). mdast text extraction only sees
// element *children*, so without lifting these attributes the sole mention of
// a topic can vanish from search and AI retrieval — e.g. a page whose only
// "navigation" text is <Card title="Shape the navigation">.
const PROSE_JSX_ATTRIBUTES = new Set(['title', 'description', 'label', 'caption', 'alt', 'tip', 'subtitle', 'summary'])

function jsxProseAttributes(node: RootContent): Array<string> {
  if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return []
  const values: Array<string> = []
  for (const attribute of node.attributes) {
    if (attribute.type !== 'mdxJsxAttribute') continue
    if (!PROSE_JSX_ATTRIBUTES.has(attribute.name)) continue
    // Only literal strings — expression values are code, not prose.
    if (typeof attribute.value === 'string' && attribute.value.trim()) values.push(attribute.value.trim())
  }
  return values
}

type JsxElement = Extract<RootContent, { type: 'mdxJsxFlowElement' | 'mdxJsxTextElement' }>

/** Minimal ESTree shape for reading literal array props such as `tags={["a", "b"]}`. */
interface EstreeNode {
  type: string
  expression?: EstreeNode
  elements?: Array<EstreeNode | null>
  value?: unknown
  body?: Array<EstreeNode>
}

function jsxAttribute(node: JsxElement, name: string) {
  return node.attributes.find((attribute) => attribute.type === 'mdxJsxAttribute' && attribute.name === name)
}

function stringAttribute(node: JsxElement, name: string): string | undefined {
  const attribute = jsxAttribute(node, name)
  if (attribute?.type !== 'mdxJsxAttribute' || typeof attribute.value !== 'string') return undefined
  return attribute.value.trim() || undefined
}

/**
 * Tags as authored: a comma string (`tags="a, b"`) or an array of string
 * literals (`tags={["a", "b"]}`). The expression is read from its parsed
 * ESTree, never evaluated; anything that is not a literal string is ignored.
 */
function tagsAttribute(node: JsxElement): Array<string> {
  const attribute = jsxAttribute(node, 'tags')
  if (attribute?.type !== 'mdxJsxAttribute' || attribute.value == null) return []
  if (typeof attribute.value === 'string') {
    return attribute.value.split(',').map((tag) => tag.trim()).filter(Boolean)
  }
  const program = (attribute.value.data as { estree?: EstreeNode } | undefined)?.estree
  const expression = program?.body?.[0]?.expression
  if (expression?.type !== 'ArrayExpression') return []
  return (expression.elements ?? []).flatMap((element) =>
    element?.type === 'Literal' && typeof element.value === 'string' && element.value.trim()
      ? [element.value.trim()]
      : [])
}

/**
 * The source text of an element's children, from the start of the first
 * child's line, with the common indentation removed — authors indent the body
 * of `<Update>`, and Markdown would read that indentation as nesting.
 */
function childrenSource(source: string, node: JsxElement): string {
  const first = node.children[0]?.position?.start.offset
  const last = node.children[node.children.length - 1]?.position?.end.offset
  if (first === undefined || last === undefined) return ''
  const lineStart = source.lastIndexOf('\n', first - 1) + 1
  const lines = source.slice(lineStart, last).split('\n')
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length))
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
}

function recordUpdate(state: WalkState, node: JsxElement) {
  const label = stringAttribute(node, 'label') ?? ''
  const date = stringAttribute(node, 'date')
  state.updates.push({
    id: updateAnchorId({ id: stringAttribute(node, 'id'), label, date }) ?? '',
    label,
    ...(stringAttribute(node, 'title') ? { title: stringAttribute(node, 'title') } : {}),
    ...(date ? { date } : {}),
    ...(stringAttribute(node, 'description') ? { description: stringAttribute(node, 'description') } : {}),
    tags: tagsAttribute(node),
    markdown: mdxToMarkdown(childrenSource(state.source, node), 'all'),
    text: cleanText(mdastToString({ type: 'root', children: node.children } as Root)),
  })
}

/** Step title sizes that render a heading, with the depth they render at; `p` is plain text. */
const STEP_HEADING_DEPTH = new Map([['h2', 2], ['h3', 3], ['h4', 4]])

/** `titleSize` as a literal string; `null` for an expression, `undefined` when absent. */
function titleSizeOf(node: JsxElement): string | null | undefined {
  const attribute = jsxAttribute(node, 'titleSize')
  if (!attribute) return undefined
  return attribute.type === 'mdxJsxAttribute' && typeof attribute.value === 'string' ? attribute.value : null
}

/**
 * `stepSize` is the title size the nearest `<Steps>` hands down. A step whose
 * title renders as a heading is a heading here too, numbered with the rest of
 * the page as the renderer does.
 */
function walk(state: WalkState, nodes: Array<RootContent>, stepSize?: string) {
  for (const node of nodes) {
    if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === 'Update') {
      recordUpdate(state, node)
      // fall through: the entry's prose still belongs to the page text and sections
    }
    let childSize = stepSize
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      // `<Steps>` hands its size to every step below it, set or not (a React context).
      if (node.name === 'Steps') childSize = titleSizeOf(node) ?? undefined
      if (node.name === 'Step') {
        const own = titleSizeOf(node)
        const title = stringAttribute(node, 'title')
        const depth = STEP_HEADING_DEPTH.get((own === undefined ? stepSize : own) ?? '')
        // fall through after: the title still reads as prose, and the body belongs to the new section
        if (title && depth) startSection(state, depth, plainInlineText(title), stringAttribute(node, 'id')?.trim() || undefined)
      }
    }
    if (node.type === 'heading') {
      const { text, explicitId } = headingTextAndId(node)
      startSection(state, node.depth, text, explicitId)
      continue
    }
    if (node.type === 'code') {
      recordCode(state, node)
      continue
    }
    if (node.type === 'link') {
      state.links.push({ url: node.url, text: mdastToString(node).trim() })
      // fall through to descend so the link's text joins the prose
    }
    if (node.type === 'text' || node.type === 'inlineCode') {
      if ('value' in node && node.value) appendText(state, node.value)
      continue
    }
    if ('children' in node && Array.isArray(node.children)) {
      // Surface prose attributes ahead of the element's children so a card
      // title reads before its body, the same order a reader sees.
      for (const value of jsxProseAttributes(node)) {
        appendText(state, value)
        if (node.type === 'mdxJsxFlowElement') appendText(state, '\n')
      }
      walk(state, node.children as Array<RootContent>, childSize)
      if (BLOCK_TYPES.has(node.type)) appendText(state, '\n')
    }
  }
}

function buildToc(headings: Array<ContentHeading>): Array<ContentTocItem> {
  const toc: Array<ContentTocItem> = []
  const stack: Array<ContentTocItem> = []

  for (const heading of headings) {
    const item: ContentTocItem = { depth: heading.depth, text: heading.text, id: heading.id }
    while (stack.length > 0 && stack[stack.length - 1].depth >= heading.depth) {
      stack.pop()
    }
    if (stack.length === 0) {
      toc.push(item)
    } else {
      const parent = stack[stack.length - 1]
      parent.children = parent.children ?? []
      parent.children.push(item)
    }
    stack.push(item)
  }

  return toc
}

/**
 * Parse an MDX body into the typed content graph. This is the single source of
 * truth for all structured representations of a document. One parse, one walk.
 */
export function parseMdxContent(markdown: string, audience: ContentAudience = 'all'): ParsedContent {
  const projectedMarkdown = projectMdxAudience(markdown, audience)
  const tree = parseToTree(projectedMarkdown)

  const preamble: ContentSection = { id: '', title: '', depth: 0, headingPath: [], text: '', code: [] }
  const state: WalkState = {
    source: projectedMarkdown,
    updates: [],
    headings: [],
    codeBlocks: [],
    links: [],
    sections: [preamble],
    textParts: [],
    sectionTextParts: [],
    current: preamble,
    stack: [],
    ids: { reserved: new Set(), used: new Set(), occurrences: new Map() },
    codeIndex: 0,
  }

  collectExplicitIds(tree.children, state.ids.reserved)
  walk(state, tree.children)
  // Flush the final section's text.
  state.current.text = cleanText(state.sectionTextParts.join(' '))

  // Drop the preamble if it carried no prose or code.
  const sections = state.sections.filter(
    (section, index) => index !== 0 || section.text.length > 0 || section.code.length > 0,
  )

  return {
    headings: state.headings,
    toc: buildToc(state.headings),
    codeBlocks: state.codeBlocks,
    sections,
    links: state.links,
    text: cleanText(state.textParts.join(' ')),
    markdown: mdxToMarkdown(projectedMarkdown, 'all'),
    updates: state.updates,
  }
}
