/**
 * Shared MDX presentation transforms for authored and release-backed content.
 *
 * Syntax grammars stay explicitly enumerated because a bundled Shiki registry
 * is duplicated across Next's server graphs and can exceed managed hosting's
 * bounded Worker upload contract. Unsupported fences remain readable text.
 */

import type { Element, ElementContent, Root } from 'hast'
import {
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor,
} from 'shiki/engine/javascript'
import { createHighlighterCore } from 'shiki/core'
import type { HighlighterCore, ThemedToken, ThemeRegistration } from 'shiki'
import langBash from 'shiki/langs/bash.mjs'
import langC from 'shiki/langs/c.mjs'
import langCpp from 'shiki/langs/cpp.mjs'
import langCsharp from 'shiki/langs/csharp.mjs'
import langCss from 'shiki/langs/css.mjs'
import langDiff from 'shiki/langs/diff.mjs'
import langDocker from 'shiki/langs/docker.mjs'
import langGo from 'shiki/langs/go.mjs'
import langGraphql from 'shiki/langs/graphql.mjs'
import langHcl from 'shiki/langs/hcl.mjs'
import langHtml from 'shiki/langs/html.mjs'
import langHttp from 'shiki/langs/http.mjs'
import langJavascript from 'shiki/langs/javascript.mjs'
import langJava from 'shiki/langs/java.mjs'
import langJson from 'shiki/langs/json.mjs'
import langJsonc from 'shiki/langs/jsonc.mjs'
import langJsx from 'shiki/langs/jsx.mjs'
import langKotlin from 'shiki/langs/kotlin.mjs'
import langMarkdown from 'shiki/langs/markdown.mjs'
import langMdx from 'shiki/langs/mdx.mjs'
import langPhp from 'shiki/langs/php.mjs'
import langPython from 'shiki/langs/python.mjs'
import langRuby from 'shiki/langs/ruby.mjs'
import langRust from 'shiki/langs/rust.mjs'
import langSql from 'shiki/langs/sql.mjs'
import langSvelte from 'shiki/langs/svelte.mjs'
import langSwift from 'shiki/langs/swift.mjs'
import langToml from 'shiki/langs/toml.mjs'
import langTsx from 'shiki/langs/tsx.mjs'
import langTypescript from 'shiki/langs/typescript.mjs'
import langVue from 'shiki/langs/vue.mjs'
import langYaml from 'shiki/langs/yaml.mjs'
import { visit } from 'unist-util-visit'
import { getDocsJsonConfig } from '../lib/docs-json-config'
import { plainInlineText } from '../lib/inline-code'
import { slugify } from '../lib/utils'
import type { DocsJsonConfig } from '../data/docs'
import { smartenTree } from './smart-quotes'

/**
 * A theme whose colors are CSS variables, so code blocks stay theme-aware via
 * the `--shiki-*` variables defined in globals.css. This replaces Shiki's old
 * built-in `css-variables` theme (removed in Shiki 1.0+) while keeping the exact
 * same variable contract, so no CSS changes are needed.
 */
const cssVariablesTheme: ThemeRegistration = {
  name: 'css-variables',
  type: 'dark',
  colors: {
    'editor.foreground': 'var(--shiki-color-text)',
    'editor.background': 'var(--shiki-color-background, transparent)',
  },
  fg: 'var(--shiki-color-text)',
  bg: 'var(--shiki-color-background, transparent)',
  settings: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--shiki-token-comment)' } },
    { scope: ['support.type.property-name.json', 'support.type.property-name.json.comments', 'meta.mapping.key'], settings: { foreground: 'var(--shiki-token-property)' } },
    { scope: ['string', 'constant.other.symbol'], settings: { foreground: 'var(--shiki-token-string)' } },
    { scope: ['constant.numeric', 'constant.language', 'constant', 'support.constant'], settings: { foreground: 'var(--shiki-token-constant)' } },
    { scope: ['keyword', 'storage.type', 'storage.modifier', 'keyword.control'], settings: { foreground: 'var(--shiki-token-keyword)' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: 'var(--shiki-token-function)' } },
    { scope: ['variable.parameter', 'variable', 'meta.definition.variable'], settings: { foreground: 'var(--shiki-token-parameter)' } },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: 'var(--shiki-token-punctuation)' } },
    { scope: ['meta.template.expression', 'string.template meta.embedded'], settings: { foreground: 'var(--shiki-token-string-expression)' } },
  ],
}

const FALLBACK_LANGUAGE = 'txt'

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      // Workers disallow runtime WebAssembly code generation. Shiki's
      // JavaScript regex engine preserves highlighting without Oniguruma WASM.
      engine: createJavaScriptRegexEngine({
        // The default lazily compiles long patterns with `new Function`, which
        // workerd forbids. Eager native RegExp construction is CSP-safe.
        regexConstructor: (pattern) =>
          defaultJavaScriptRegexConstructor(pattern, { lazyCompileLength: Infinity }),
      }),
      themes: [cssVariablesTheme],
      // Explicit imports keep the request Worker bounded. Unknown fences still
      // render as plaintext, while the common documentation languages retain
      // full grammar-aware highlighting.
      langs: [
        langBash,
        langC,
        langCpp,
        langCsharp,
        langCss,
        langDiff,
        langDocker,
        langGo,
        langGraphql,
        langHcl,
        langHtml,
        langHttp,
        langJava,
        langJavascript,
        langJson,
        langJsonc,
        langJsx,
        langKotlin,
        langMarkdown,
        langMdx,
        langPhp,
        langPython,
        langRuby,
        langRust,
        langSql,
        langSvelte,
        langSwift,
        langToml,
        langTsx,
        langTypescript,
        langVue,
        langYaml,
      ],
    })
  }
  return highlighterPromise
}

const languageAliases: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  curl: 'bash',
  gql: 'graphql',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  md: 'markdown',
  plaintext: 'txt',
  text: 'txt',
  yml: 'yaml',
}

// Fence metadata is authored input and may arrive through an untrusted pull
// request. Bound expansion before allocation so a range such as {1-4e9}
// cannot exhaust a build or Worker request.
const MAX_HIGHLIGHTED_LINES = 1_000
const MAX_HIGHLIGHTED_LINE_NUMBER = 100_000

// Syntax highlighting is a presentation enhancement, not a reason for an
// authored or imported page to exhaust a request Worker. Keep both individual
// fences and the aggregate page work bounded; fences outside the budget remain
// ordinary HAST text nodes and are therefore emitted as escaped plaintext.
const MAX_HIGHLIGHTED_CODE_BLOCK_BYTES = 64 * 1024
const MAX_HIGHLIGHTED_CODE_BLOCK_LINES = 2_000
const MAX_HIGHLIGHTED_PAGE_BYTES = 256 * 1024
// A byte-only limit permits arbitrarily many empty fences. Charge a small
// fixed amount of work per grammar invocation instead of stopping every page
// at the same block count. At most 1,024 tiny fences can enter Shiki.
const MIN_HIGHLIGHTED_CODE_BLOCK_WORK = 256
const MAX_HIGHLIGHTED_PAGE_WORK = 256 * 1024
// Input size does not bound the number of objects created by a grammar. These
// shared limits cap HAST expansion before allocating or mutating a code block.
const MAX_HIGHLIGHTED_PAGE_NODES = 100_000
const MAX_HIGHLIGHTED_PAGE_OUTPUT_BYTES = 8 * 1024 * 1024

/** Return a bounded UTF-8 cost, or null when a fence must remain plaintext. */
export function measureHighlightableCode(code: string): number | null {
  // UTF-16 length is a cheap lower bound for UTF-8 bytes. Reject before using
  // TextEncoder so even the measurement allocation stays bounded.
  if (code.length > MAX_HIGHLIGHTED_CODE_BLOCK_BYTES) return null

  let lineCount = 1
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 10) {
      lineCount += 1
      if (lineCount > MAX_HIGHLIGHTED_CODE_BLOCK_LINES) return null
    }
  }

  const byteLength = new TextEncoder().encode(code).byteLength
  return byteLength <= MAX_HIGHLIGHTED_CODE_BLOCK_BYTES ? byteLength : null
}

export interface SyntaxHighlightBudget {
  scheduledBlocks: number
  scheduledBytes: number
  scheduledWork: number
  isExhausted: boolean
}

/** Reserve bounded page capacity before sending a fence through Shiki. */
export function scheduleSyntaxHighlight(
  code: string,
  budget: SyntaxHighlightBudget,
): boolean {
  if (
    budget.isExhausted ||
    budget.scheduledWork >= MAX_HIGHLIGHTED_PAGE_WORK ||
    budget.scheduledBytes >= MAX_HIGHLIGHTED_PAGE_BYTES
  ) {
    budget.isExhausted = true
    return false
  }

  const codeBytes = measureHighlightableCode(code)
  if (codeBytes === null) return false
  const work = Math.max(codeBytes, MIN_HIGHLIGHTED_CODE_BLOCK_WORK)
  if (budget.scheduledBytes + codeBytes > MAX_HIGHLIGHTED_PAGE_BYTES
    || budget.scheduledWork + work > MAX_HIGHLIGHTED_PAGE_WORK) {
    budget.isExhausted = true
    return false
  }

  budget.scheduledBlocks += 1
  budget.scheduledBytes += codeBytes
  budget.scheduledWork += work
  budget.isExhausted =
    budget.scheduledWork >= MAX_HIGHLIGHTED_PAGE_WORK ||
    budget.scheduledBytes >= MAX_HIGHLIGHTED_PAGE_BYTES
  return true
}

function normalizeLanguage(language?: string) {
  if (!language) {
    return undefined
  }
  const normalized = language.toLowerCase()
  return languageAliases[normalized] ?? normalized
}

/**
 * Ensure a language grammar is loaded; fall back to plaintext for unknown or
 * unsupported languages so an exotic code fence never breaks the page.
 */
function resolveLanguage(highlighter: HighlighterCore, language: string): string {
  return highlighter.getLoadedLanguages().includes(language)
    ? language
    : FALLBACK_LANGUAGE
}

/** 1-based line numbers carrying presentation state inside one fence. */
interface LineMarks {
  highlight: Set<number>
  focus: Set<number>
  add: Set<number>
  remove: Set<number>
}

export interface SyntaxHighlightOutputBudget {
  nodes: number
  bytes: number
  isExhausted: boolean
}

/** A conservative serialized-text cost without constructing escaped markup. */
function escapedOutputBytes(value: string): number {
  if (value.length > MAX_HIGHLIGHTED_PAGE_OUTPUT_BYTES) return Infinity
  let bytes = new TextEncoder().encode(value).byteLength
  for (const character of value) {
    if (character === '&') bytes += 4
    else if (character === '<' || character === '>') bytes += 3
    else if (character === '"') bytes += 5
    else if (character === "'") bytes += 4
  }
  return bytes
}

/**
 * Reserve a whole block before building its HAST. Raw token counts are an
 * upper bound because joining placeholders can only remove token wrappers.
 * Fixed markup allowances include line classes, style syntax and newlines;
 * the separate node limit bounds object overhead beyond serialized bytes.
 */
export function reserveSyntaxHighlightOutput(
  lines: Array<Array<ThemedToken>>,
  budget: SyntaxHighlightOutputBudget,
): boolean {
  if (budget.isExhausted) return false
  let nodes = budget.nodes
  let bytes = budget.bytes
  for (const [index, tokens] of lines.entries()) {
    nodes += index === 0 ? 1 : 2
    bytes += 192 + (index === 0 ? 0 : 1)
    for (const token of tokens) {
      nodes += 2
      bytes += 64 + escapedOutputBytes(token.content) + escapedOutputBytes(token.color ?? 'inherit')
      if (nodes > MAX_HIGHLIGHTED_PAGE_NODES || bytes > MAX_HIGHLIGHTED_PAGE_OUTPUT_BYTES) {
        budget.isExhausted = true
        return false
      }
    }
    if (nodes > MAX_HIGHLIGHTED_PAGE_NODES || bytes > MAX_HIGHLIGHTED_PAGE_OUTPUT_BYTES) {
      budget.isExhausted = true
      return false
    }
  }
  budget.nodes = nodes
  budget.bytes = bytes
  return true
}

/**
 * Render themed tokens to the same inner HTML the old Shiki `renderToHtml`
 * produced for this pipeline: one `<span>` per line wrapping per-token color
 * spans, with no `<pre>`/`<code>` wrapper (those already exist in the tree).
 * Marked lines (1-based) get classes styled in globals.css. When a fence has
 * any focused line, every other line is dimmed.
 */
/**
 * Grammars split `{{KEY}}` across several tokens (`{{` · `KEY` · `}}`). Merge the
 * tokens a placeholder spans into one, so the highlighted HTML keeps it
 * contiguous and a component that rewrites `{{KEY}}` in its children (a site
 * `Template`) can find it.
 */
function joinPlaceholderTokens(tokens: Array<ThemedToken>): Array<ThemedToken> {
  const text = tokens.map((token) => token.content).join('')
  if (!text.includes('{{')) return tokens
  const placeholders = [...text.matchAll(/\{\{\w+\}\}/g)]
  const out: Array<ThemedToken> = []
  let offset = 0
  let previous: RegExpMatchArray | undefined
  let next = 0 // placeholders are ordered and disjoint, so one moving index replaces a search per token
  for (const token of tokens) {
    const start = offset
    offset += token.content.length
    while (next < placeholders.length && placeholders[next].index + placeholders[next][0].length <= start) next++
    const match = next < placeholders.length && placeholders[next].index < offset ? placeholders[next] : undefined
    const last = out.at(-1)
    if (match && match === previous && last) out[out.length - 1] = { ...last, content: last.content + token.content }
    else out.push(token)
    previous = match
  }
  return out
}

function tokensToHast(lines: Array<Array<ThemedToken>>, marks: LineMarks): Array<ElementContent> {
  const out: Array<ElementContent> = []
  lines.forEach((tokens, index) => {
    const n = index + 1
    const className: Array<string> = []
    if (marks.highlight.has(n)) className.push('thally-line-highlight')
    if (marks.add.has(n)) className.push('thally-line-add')
    if (marks.remove.has(n)) className.push('thally-line-remove')
    if (marks.focus.size > 0 && !marks.focus.has(n)) className.push('thally-line-dim')
    if (index > 0) out.push({ type: 'text', value: '\n' })
    out.push({
      type: 'element',
      tagName: 'span',
      properties: className.length ? { className } : {},
      children: joinPlaceholderTokens(tokens).map((token) => ({
        type: 'element',
        tagName: 'span',
        properties: { style: `color:${token.color ?? 'inherit'}` },
        children: [{ type: 'text', value: token.content }],
      })),
    })
  })
  return out
}

// Trailing notation comment: `// [!code ++]`, `# [!code --:3]`,
// `<!-- [!code highlight] -->`, `/* [!code focus] */`, `-- [!code ++]`, and the
// JSX form `{/* [!code ++] */}`.
// No leading or doubled `[ \t]*`: adjacent optional whitespace runs backtrack
// quadratically on a long run of spaces (authored input, bounded by nothing).
const CODE_NOTATION =
  /(?:\/\/|#|--|\/\*|<!--|\{[ \t]*\/\*)[ \t]*\[!code[ \t]+(\+\+|--|highlight|focus)(?::(\d+))?\](?:[ \t]*(?:\*\/[ \t]*\}|\*\/|-->))?[ \t]*(\r?)$/

/**
 * Strip notation comments from a fence and report which lines they mark.
 * Follows Shiki's notation rules: a marker after code marks that line (and,
 * with `:N`, the N-1 lines after it); a line that holds only a marker comment
 * is removed and marks the following line(s), counting `:N` from the next line.
 * Mark sets, and any `{n}` / `focus={n}` authored in the fence meta, refer to
 * the RENDERED lines, i.e. after marker-only lines are removed.
 * Returns null when the fence has no markers, leaving plain fences
 * byte-identical.
 */
export function applyCodeNotation(code: string): { code: string; marks: LineMarks } | null {
  if (!code.includes('[!code')) return null
  const marks = { highlight: new Set<number>(), focus: new Set<number>(), add: new Set<number>(), remove: new Set<number>() }
  const kinds = { '++': marks.add, '--': marks.remove, highlight: marks.highlight, focus: marks.focus } as const
  let found = false
  const out: Array<string> = []
  for (const line of code.split('\n')) {
    if (!line.includes('[!code')) {
      out.push(line)
      continue
    }
    // Strip every trailing marker (`a // [!code ++] // [!code focus]`).
    // The current rendered line number is `out.length + 1`; when the line is
    // marker-only it is dropped, so that same number is the next line's.
    let rest = line
    let carriageReturn = ''
    for (let match = CODE_NOTATION.exec(rest); match; match = CODE_NOTATION.exec(rest)) {
      found = true
      if (rest === line) carriageReturn = match[3]
      const count = Math.min(Number(match[2] ?? 1) || 1, MAX_HIGHLIGHTED_LINES)
      const target = kinds[match[1] as keyof typeof kinds]
      for (let offset = 0; offset < count; offset += 1) target.add(out.length + 1 + offset)
      let end = match.index
      while (end > 0 && (rest[end - 1] === ' ' || rest[end - 1] === '\t')) end -= 1
      rest = rest.slice(0, end)
    }
    if (rest === line) out.push(line)
    else if (rest !== '') out.push(rest + carriageReturn)
  }
  return found ? { code: out.join('\n'), marks } : null
}

// ---------------------------------------------------------------------------
// Fence meta parsing — supports (Mintlify-compatible):
//   ```ts api-client.ts          (bare words → title, multi-word allowed)
//   ```ts title="api-client.ts"  (explicit title/filename attribute)
//   ```tsx framework="Next.js"   (visible framework tag, TSX grammar)
//   ```ts {2,4-6}                (highlighted lines)
//   ```ts highlight={2,4-6}      (highlighted lines, explicit form)
//   ```ts focus={2,4-6}          (dim every other line)
//   ```ts icon="python"          (icon in the header)
//   ```bash wrap lines           (soft-wrap, line numbers)
//   ```ts expandable nocopy      (collapsible, no copy button)
// `twoslash` and unknown `key=value` options are accepted and ignored.
// ---------------------------------------------------------------------------

export interface CodeFenceMeta {
  title?: string
  tag?: string
  icon?: string
  wrap?: boolean
  lines?: boolean
  expandable?: boolean
  nocopy?: boolean
  highlight?: Array<number>
  focus?: Array<number>
}

function expandLineRanges(spec: string): Array<number> {
  const lines: Array<number> = []
  for (const part of spec.split(',')) {
    if (lines.length >= MAX_HIGHLIGHTED_LINES) break
    const trimmed = part.trim()
    if (!trimmed) continue
    const range = trimmed.match(/^(\d+)-(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Math.min(Number(range[2]), MAX_HIGHLIGHTED_LINE_NUMBER)
      if (start > MAX_HIGHLIGHTED_LINE_NUMBER || start > end) continue
      for (
        let line = start;
        line <= end && lines.length < MAX_HIGHLIGHTED_LINES;
        line += 1
      ) {
        lines.push(line)
      }
    } else if (/^\d+$/.test(trimmed)) {
      const line = Number(trimmed)
      if (line <= MAX_HIGHLIGHTED_LINE_NUMBER) lines.push(line)
    }
  }
  return lines
}

interface MetaToken {
  key?: string
  /** Value with surrounding quotes or braces removed. */
  value: string
  /** True when the value was a `{...}` group. */
  group: boolean
  /** True for a quoted string; a quoted word is never a boolean flag. */
  quoted?: boolean
}

/** End of a bare word: whitespace, or a `{1,2}` highlight group glued on (`file.ts{1,2}`). */
function wordEnd(meta: string, start: number): number {
  let j = start
  while (j < meta.length && !/\s/.test(meta[j])) {
    if (j > start && meta[j] === '{' && /^\{[\d,\s-]*\}/.test(meta.slice(j))) break
    j += 1
  }
  return j
}

/** Read one quoted string or balanced `{...}` group starting at `start`. */
function readDelimited(meta: string, start: number): { value: string; end: number; group: boolean; quoted?: boolean } | null {
  const open = meta[start]
  if (open === '"' || open === "'") {
    // `\"` (or `\'`) is an escaped quote; any other backslash is literal so
    // Windows paths survive.
    let close = start + 1
    while (close < meta.length && meta[close] !== open) close += meta[close] === '\\' && meta[close + 1] === open ? 2 : 1
    const raw = meta.slice(start + 1, close)
    return { value: raw.split(`\\${open}`).join(open), end: close < meta.length ? close + 1 : close, group: false, quoted: true }
  }
  if (open === '{') {
    let depth = 0
    let quote = ''
    for (let i = start; i < meta.length; i += 1) {
      const ch = meta[i]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '{') depth += 1
      else if (ch === '}' && --depth === 0) return { value: meta.slice(start + 1, i), end: i + 1, group: true }
    }
    return { value: meta.slice(start + 1), end: meta.length, group: true }
  }
  return null
}

function tokenizeMeta(meta: string): Array<MetaToken> {
  const tokens: Array<MetaToken> = []
  let i = 0
  while (i < meta.length) {
    if (/\s/.test(meta[i])) {
      i += 1
      continue
    }
    const delimited = readDelimited(meta, i)
    if (delimited) {
      tokens.push({ value: delimited.value, group: delimited.group, quoted: delimited.quoted })
      i = delimited.end
      continue
    }
    const key = /^([A-Za-z][\w-]*)=/.exec(meta.slice(i))
    if (key) {
      i += key[0].length
      const value = readDelimited(meta, i)
      if (value) {
        tokens.push({ key: key[1], value: value.value, group: value.group })
        i = value.end
      } else {
        const end = meta.slice(i).search(/\s/)
        const stop = end === -1 ? meta.length : i + end
        tokens.push({ key: key[1], value: meta.slice(i, stop), group: false })
        i = stop
      }
      continue
    }
    const stop = wordEnd(meta, i)
    tokens.push({ value: meta.slice(i, stop), group: false })
    i = stop
  }
  return tokens
}

const BOOLEAN_FLAGS = new Set(['wrap', 'lines', 'expandable', 'nocopy', 'twoslash'])

/** Parse portable code-fence metadata and ignore renderer-only props. */
export function parseCodeFenceMeta(meta: string): CodeFenceMeta {
  const result: CodeFenceMeta = {}
  const words: Array<string> = []
  let explicitTitle: string | undefined
  const setBoolean = (name: 'wrap' | 'lines' | 'expandable' | 'nocopy', value: string) => {
    result[name] = value.trim().toLowerCase() !== 'false'
  }
  for (const token of tokenizeMeta(meta)) {
    if (!token.key) {
      if (token.group) {
        if (/^[\d,\s-]+$/.test(token.value)) result.highlight = expandLineRanges(token.value)
      } else if (!token.quoted && BOOLEAN_FLAGS.has(token.value)) {
        // Flags are case-sensitive and recognised anywhere among bare words
        // (`Show lines of code` is a title of "Show of code" plus `lines`);
        // quote the word (`"lines"`) to keep it in a title.
        if (token.value !== 'twoslash') result[token.value as 'wrap'] = true
      } else if (token.value && !/^[{}]+$/.test(token.value)) {
        words.push(token.value)
      }
      continue
    }
    const key = token.key
    if (key === 'title' || key === 'filename') explicitTitle = token.value
    else if (key === 'framework' || key === 'tag') result.tag = token.value
    else if (key === 'icon') {
      const icon = token.value.replace(/^["']|["']$/g, '').trim()
      if (icon) result.icon = icon
    } else if (key === 'highlight' || key === 'focus') {
      const spec = token.value.replace(/^["']|["']$/g, '')
      if (/^[\d,\s-]+$/.test(spec)) result[key] = expandLineRanges(spec)
    } else if (key === 'wrap' || key === 'lines' || key === 'expandable' || key === 'nocopy') {
      setBoolean(key, token.value)
    }
    // Everything else (`theme={"system"}`, unknown keys) configures another
    // renderer and is not a human-facing filename.
  }
  // Duplicate keys: the last one wins. An empty explicit title falls back to
  // the bare words.
  const title = explicitTitle || words.join(' ')
  if (title) result.title = title
  return result
}

function rehypeParseCodeBlocks() {
  return (tree: Root) => {
    // @ts-expect-error -- unist-util-visit visitor types are stricter than needed
    visit(tree, 'element', (node: Element, _index: number | undefined, parent: Element | undefined) => {
      // Inline `code` inside a <p>/<td> is not a fence; only <pre><code> gets a language.
      if (!parent || parent.tagName !== 'pre' || node.tagName !== 'code') {
        return
      }

      const className = node.properties?.className
      const languageClass =
        Array.isArray(className) && className.length > 0
          ? (className[0] as string)
          : typeof className === 'string'
            ? className
            : ''
      const language = normalizeLanguage(languageClass.replace(/^language-/, '') || 'txt')

      // The fence meta string (everything after the language) survives on the
      // code node's data. Lift it onto the <pre> so the Pre/CodeGroup
      // components receive title/wrap as props and Shiki sees the highlights.
      const meta = (node.data as { meta?: string } | undefined)?.meta ?? ''
      const parsedMeta = meta ? parseCodeFenceMeta(meta) : {}

      parent.properties = {
        ...parent.properties,
        language,
        ...(parsedMeta.title ? { title: parsedMeta.title } : {}),
        ...(parsedMeta.tag ? { tag: parsedMeta.tag } : {}),
        ...(parsedMeta.wrap ? { wrap: '' } : {}),
        ...(parsedMeta.lines ? { lines: '' } : {}),
        ...(parsedMeta.expandable ? { expandable: '' } : {}),
        ...(parsedMeta.nocopy ? { nocopy: '' } : {}),
        ...(parsedMeta.icon ? { icon: parsedMeta.icon } : {}),
        ...(parsedMeta.focus?.length ? { focusLines: parsedMeta.focus.join(',') } : {}),
        ...(parsedMeta.highlight?.length
          ? { highlightLines: parsedMeta.highlight.join(',') }
          : {}),
      }
    })
  }
}

function rehypeShiki() {
  return async (tree: Root) => {
    // Scan before initializing Shiki. Most prose pages contain no fenced code,
    // so they should not pay the cold-start cost of constructing every grammar.
    const targets: Array<{
      node: Element
      code: string
      language: string
      codeNode: Element
      notation: ReturnType<typeof applyCodeNotation>
    }> = []
    const budget: SyntaxHighlightBudget = {
      scheduledBlocks: 0,
      scheduledBytes: 0,
      scheduledWork: 0,
      isExhausted: false,
    }

    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'pre') {
        return
      }

      const [codeNode] = node.children
      if (!codeNode || (codeNode as Element).tagName !== 'code') {
        return
      }

      const [textNode] = (codeNode as Element).children as Array<{ type: string; value: string }>
      if (!textNode || typeof textNode.value !== 'string') {
        return
      }

      const language = node.properties?.language as string | undefined
      // Notation comments are authoring syntax: strip them from what is
      // rendered and copied. Mermaid consumes the raw fence untouched.
      const originalCode = textNode.value
      // Bound notation's split/mark allocations as well as tokenization. Work
      // is charged against the original source, so directives cannot hide it.
      const notation = language && language !== 'mermaid' && measureHighlightableCode(originalCode) !== null
        ? applyCodeNotation(originalCode) : null
      if (notation) textNode.value = notation.code
      const code = textNode.value
      node.properties = {
        ...node.properties,
        code,
      }

      if (!language) {
        return
      }

      // Mermaid consumes the original fence payload directly in `Pre`.
      // Highlighting would only spend the bounded Shiki budget on HTML that
      // is never displayed.
      if (language === 'mermaid') return

      if (!scheduleSyntaxHighlight(originalCode, budget)) {
        return
      }

      targets.push({ node, code, language, codeNode: codeNode as Element, notation })
    })

    if (targets.length === 0) return

    const highlighter = await getHighlighter()
    const outputBudget: SyntaxHighlightOutputBudget = { nodes: 0, bytes: 0, isExhausted: false }

    // Shiki is synchronous: keep exactly one token result alive at a time.
    // Promise fan-out would add memory without bounding or interrupting CPU.
    for (const target of targets) {
      if (outputBudget.isExhausted) break
      const language = resolveLanguage(highlighter, target.language)
      const lines = highlighter.codeToTokensBase(target.code, {
        lang: language as Parameters<HighlighterCore['codeToTokensBase']>[1]['lang'],
        theme: cssVariablesTheme,
      })
      if (!reserveSyntaxHighlightOutput(lines, outputBudget)) break
      const highlightSpec = target.node.properties?.highlightLines as string | undefined
      const focusSpec = target.node.properties?.focusLines as string | undefined
      const marks: LineMarks = {
        highlight: new Set([...(highlightSpec ? expandLineRanges(highlightSpec) : []), ...(target.notation?.marks.highlight ?? [])]),
        // Only focus lines that exist: `focus={0}` or `focus={99}` on a short
        // block must not dim every line.
        focus: new Set(
          [...(focusSpec ? expandLineRanges(focusSpec) : []), ...(target.notation?.marks.focus ?? [])].filter(
            (n) => n >= 1 && n <= lines.length,
          ),
        ),
        add: target.notation?.marks.add ?? new Set(),
        remove: target.notation?.marks.remove ?? new Set(),
      }
      // Real elements, not an HTML string: text stays escaped, and a component
      // that rewrites string children (a site `Template`) cannot inject markup.
      target.codeNode.children = tokensToHast(lines, marks)
      // Lets `expandable` fences start expanded when a mark sits below the fold.
      const lastMarked = Math.max(
        0,
        ...[marks.highlight, marks.focus, marks.add, marks.remove].flatMap((set) => [...set].filter((n) => n <= lines.length)),
      )
      if (lastMarked > 0 && target.node.properties?.expandable !== undefined) target.node.properties = { ...target.node.properties, lastmarked: String(lastMarked) }
    }
  }
}

const HEADING_ID_MARKER = /^\s*\/\*\s*#(\S+?)\s*\*\/\s*$/

/**
 * A heading may end with a JSX comment holding `#id` to keep an id its text
 * would not slugify to (a migrated `{#id}`, or `+` and `&` in the heading).
 * The comment is consumed here so only the id remains.
 */
function takeHeadingIdMarker(node: Element): string | undefined {
  const values = node.children.map((child) => (child as { type: string }).type === 'mdxTextExpression'
    ? HEADING_ID_MARKER.exec((child as unknown as { value: string }).value)?.[1] : undefined)
  const index = values.findIndex((value) => value !== undefined)
  if (index < 0) return undefined
  node.children.splice(index, 1)
  const before = node.children[index - 1]
  if (before?.type === 'text') before.value = before.value.trimEnd()
  return values[index]
}

/** Step title sizes that render a heading (and so an id and a table-of-contents entry); `p` is plain text. */
const STEP_HEADING_SIZES = new Set(['h2', 'h3', 'h4'])

/** A JSX element as MDX leaves it in the hast tree. */
interface JsxNode {
  type: string
  name?: string | null
  attributes?: Array<{ type: string; name?: string; value?: unknown }>
  children?: Array<JsxNode | Element>
}

/** A literal string attribute; `null` for an expression, `undefined` when the attribute is absent. */
function jsxStringAttribute(node: JsxNode, name: string): string | null | undefined {
  const attribute = node.attributes?.find((item) => item.type === 'mdxJsxAttribute' && item.name === name)
  if (!attribute) return undefined
  return typeof attribute.value === 'string' ? attribute.value : null
}

interface HeadingTarget {
  text: string
  /** An id the author fixed (`id` attribute or `{/* #id *\/}` comment). */
  given?: string
  assign: (id: string) => void
}

/**
 * Give repeated headings distinct, stable fragments in document order:
 * `foo`, `foo-2`, `foo-3`. An explicit id (`{/* #id *\/}` or an `id` attribute)
 * reserves it for the whole page, so a generated id never takes it. The same
 * numbering is used by the content parser (search anchors) and `thally check`.
 *
 * A `<Step>` whose title renders as a heading (`titleSize` h2, h3 or h4, on the
 * step or its `<Steps>`) is numbered with the rest and given the `id` its title
 * is rendered with, so the table of contents scrolls to it.
 */
function rehypeUniqueHeadingIds() {
  return (tree: Root) => {
    const occurrences = new Map<string, number>()
    const usedIds = new Set<string>()
    const targets: Array<HeadingTarget> = []
    const text = (node: Element): string => node.children.map((child) =>
      child.type === 'text' ? child.value
        : child.type === 'element' ? text(child)
          : '').join('')
    const collect = (node: Element | JsxNode | Root, stepSize: string | undefined): void => {
      let childSize = stepSize
      if (node.type === 'element') {
        const element = node as Element
        if (/^h[2-6]$/.test(element.tagName)) {
          const given = typeof element.properties?.id === 'string' && element.properties.id
            ? element.properties.id : takeHeadingIdMarker(element)
          targets.push({
            text: text(element),
            given: given || undefined,
            assign: (id) => { element.properties = { ...element.properties, id } },
          })
        }
      } else if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
        const jsx = node as JsxNode
        // `<Steps>` hands its size to every step below it, set or not (a React context).
        if (jsx.name === 'Steps') childSize = jsxStringAttribute(jsx, 'titleSize') ?? undefined
        if (jsx.name === 'Step') {
          const own = jsxStringAttribute(jsx, 'titleSize')
          const size = own === undefined ? stepSize : own
          const title = jsxStringAttribute(jsx, 'title')?.trim()
          if (title && size && STEP_HEADING_SIZES.has(size)) {
            targets.push({
              text: plainInlineText(title),
              given: jsxStringAttribute(jsx, 'id')?.trim() || undefined,
              assign: (id) => {
                const attributes = (jsx.attributes ??= [])
                const existing = attributes.find((attribute) => attribute.type === 'mdxJsxAttribute' && attribute.name === 'id')
                if (existing) existing.value = id
                else attributes.push({ type: 'mdxJsxAttribute', name: 'id', value: id })
              },
            })
          }
        }
      }
      for (const child of (node as JsxNode).children ?? []) collect(child, childSize)
    }
    collect(tree, undefined)
    const reserved = new Set(targets.flatMap((target) => target.given ? [target.given] : []))
    for (const target of targets) {
      const base = target.given ?? slugify(target.text)
      if (!base) continue
      let id = base
      let occurrence = 1
      if (target.given) {
        while (usedIds.has(id)) id = `${base}-${++occurrence}`
      } else {
        occurrence = occurrences.get(base) ?? 0
        do id = ++occurrence === 1 ? base : `${base}-${occurrence}`
        while (usedIds.has(id) || reserved.has(id))
        occurrences.set(base, occurrence)
      }
      usedIds.add(id)
      target.assign(id)
    }
  }
}

/**
 * Typographic quotes in rendered prose, when docs.json sets `smartQuotes: true`.
 * It runs last so heading ids and step ids, which read the text before this step,
 * keep their straight-quote slugs. The setting is read per page rather than when
 * the plugin is created, so a release configuration binding applies to pages
 * that are compiled at request time.
 */
function rehypeSmartQuotes() {
  return (tree: Root) => {
    if (getDocsJsonConfig<Pick<DocsJsonConfig, 'smartQuotes'>>().smartQuotes === true) smartenTree(tree)
  }
}

export const rehypePlugins = [rehypeParseCodeBlocks, rehypeShiki, rehypeUniqueHeadingIds, rehypeSmartQuotes]
