/**
 * Typographic ("smart") quotes for rendered prose, behind the docs.json
 * `smartQuotes` setting.
 *
 * This module is self-contained on purpose: it has no dependencies, so sites
 * that receive runtime updates without a `package.json` change keep building.
 *
 * The transform runs on the final hast tree, after code highlighting and after
 * heading ids are assigned, so ids and the structured content projections
 * (Markdown, `llms.txt`, search text), which read the MDX source and never this
 * tree, keep their straight quotes. Only text nodes are rewritten; element
 * properties and JSX attribute values are never visited.
 */

const RIGHT_SINGLE = '’'
const LEFT_SINGLE = '‘'
const LEFT_DOUBLE = '“'
const RIGHT_DOUBLE = '”'

/** A quote after one of these (or at the start of a block) opens; after anything else it closes. */
const OPENING_CONTEXT = /^[-\s([{–—‘“]$/u

/** `'90`, `'90s`: an apostrophe for dropped digits, not an opening quote. `'42'` is a quoted number. */
const DECADE = /\d{2}s?(?![\p{L}\p{N}'])/uy

/**
 * Convert straight quotes in one run of prose, following SmartyPants rules.
 *
 * @param text - The text to convert.
 * @param previous - The character that precedes `text` in the same block of
 *   prose (`''` at its start). Quotes after whitespace, the start, an opening
 *   bracket, a dash or another opening quote open; every other quote closes.
 *   Apostrophes inside words and decades such as `'90s` take the right single
 *   quote. Dashes and ellipses are left alone.
 */
export function smartenQuotes(text: string, previous = ''): string {
  if (!text.includes("'") && !text.includes('"')) return text
  let result = ''
  let before = previous
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character !== "'" && character !== '"') {
      result += character
      before = character
      continue
    }
    const opens = before === '' || OPENING_CONTEXT.test(before)
    let converted: string
    if (character === '"') {
      converted = opens ? LEFT_DOUBLE : RIGHT_DOUBLE
    } else {
      DECADE.lastIndex = index + 1
      converted = !DECADE.test(text) && opens ? LEFT_SINGLE : RIGHT_SINGLE
    }
    result += converted
    before = converted
  }
  return result
}

/** The slice of a hast or MDX node this walker reads. */
interface QuoteNode {
  type: string
  value?: string
  tagName?: string
  name?: string | null
  properties?: Record<string, unknown>
  attributes?: Array<{ type: string; name?: string }>
  children?: Array<QuoteNode>
}

/**
 * Elements and components whose text is code, math or copyable source. They
 * are named for both forms MDX can produce: a hast element (a Markdown span or
 * fence) and a lowercase JSX tag, which MDX leaves as a JSX node.
 */
const VERBATIM = new Set([
  'code', 'pre', 'kbd', 'samp', 'script', 'style', 'math', 'textarea',
  'Latex', 'Mermaid', 'Terminal', 'TerminalInput', 'TerminalOutput',
  'Prompt', 'PromptUser', 'PromptAssistant', 'AgentPrompt', 'CodeBlock', 'CodeGroup',
])

/** Verbatim elements that sit inside a line of prose, so the text after them continues it. */
const INLINE_VERBATIM = new Set(['code', 'kbd', 'samp', 'math'])

/** Elements that continue a line of prose. Every other element starts a new block. */
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'data', 'del', 'dfn', 'em', 'i', 'img',
  'ins', 'label', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'wbr',
])

function nodeName(node: QuoteNode): string | undefined {
  return node.tagName ?? node.name ?? undefined
}

function isElement(node: QuoteNode): boolean {
  return node.type === 'element' || node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement'
}

/** A code-block role: a hast `data-language` property or the same attribute on a JSX element. */
function hasCodeRole(node: QuoteNode): boolean {
  return node.properties?.dataLanguage !== undefined
    || node.properties?.['data-language'] !== undefined
    || Boolean(node.attributes?.some((attribute) => attribute.name === 'data-language'))
}

/**
 * Convert straight quotes in every prose text node of a hast tree, in place.
 *
 * Context carries across inline elements, so the closing quote in
 * `"<em>word</em>"` closes, and resets at block boundaries. Text inside code,
 * math, scripts, styles, code-block components and elements with a
 * `data-language` role is left as written.
 */
export function smartenTree(tree: { children: Array<unknown> }): void {
  let previous = ''
  const walk = (node: QuoteNode): void => {
    for (const child of node.children ?? []) {
      if (child.type === 'text' && typeof child.value === 'string') {
        child.value = smartenQuotes(child.value, previous)
        if (child.value) previous = child.value[child.value.length - 1]
      } else if (isElement(child)) {
        const name = nodeName(child)
        const inline = (name !== undefined && (INLINE.has(name) || INLINE_VERBATIM.has(name))) || child.type === 'mdxJsxTextElement'
        if ((name !== undefined && VERBATIM.has(name)) || hasCodeRole(child)) {
          previous = inline ? 'x' : ''
          continue
        }
        if (!inline) previous = ''
        walk(child)
        if (!inline) previous = ''
      } else if (child.type.startsWith('mdx')) {
        // An expression such as `{name}` stands for words between the quotes.
        previous = 'x'
      }
    }
  }
  walk(tree as QuoteNode)
}
