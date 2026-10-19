/**
 * Recover literal code alternatives from a publisher's embedded article source.
 * React Flight is a byte-framed data transport here: scripts, imports and MDX
 * expressions are never evaluated. Source must agree with the rendered article
 * before it can supply missing code or explicit code-language metadata.
 */
import { createHash } from 'node:crypto'
import { type CheerioAPI } from 'cheerio'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { unified } from 'unified'
import { isPassiveSvg } from './svg-policy.js'

type Selection = ReturnType<CheerioAPI>
interface SourceNode {
  type: string
  name?: string
  value?: string
  lang?: string | null
  depth?: number
  children?: SourceNode[]
  attributes?: Array<{ type: string; name?: string; value?: unknown }>
}
interface SourceTab { label: string; code: SourceNode[] }
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx)
const MAX_SOURCE_BYTES = 8_000_000
// Callers independently request links, assets, code, conversion and identity.
// Reuse only immutable source ASTs, never mutable Cheerio documents. This small
// LRU is bounded by both text bytes and entries and holds no capture authority.
const sourceTrees = new Map<string, { bytes: number; nodes: SourceNode[] }>()
let cachedSourceBytes = 0
const MAX_CACHED_SOURCE_BYTES = 1_000_000
const UNRESOLVED_FLIGHT_VALUE = Symbol('unresolved-flight-value')
interface ExpansionBudget { visited: number; bytes: number; exceeded: boolean }
const expansionBudget = (): ExpansionBudget => ({ visited: 0, bytes: 0, exceeded: false })

function chargeExpansion(budget: ExpansionBudget, value: string): boolean {
  if (budget.exceeded) return false
  budget.bytes += Buffer.byteLength(value)
  if (budget.bytes > MAX_SOURCE_BYTES) budget.exceeded = true
  return !budget.exceeded
}

function chargeProjectedText(budget: ExpansionBudget, value: string): boolean {
  if (budget.exceeded) return false
  let bytes = Buffer.byteLength(value)
  for (const character of value) bytes += character === '&' ? 4 : character === '<' || character === '>' ? 3 : character === '"' ? 5 : 0
  budget.bytes += bytes + 128
  if (budget.bytes > MAX_SOURCE_BYTES) budget.exceeded = true
  return !budget.exceeded
}
interface FlightDocument {
  texts: Map<string, string>
  modules: Map<string, string>
  records: Map<string, unknown>
  sources: string[]
}
const flightDocuments = new WeakMap<CheerioAPI, FlightDocument>()

function renderedRouteSlot(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'children')) return undefined
  const child = (value as Record<string, unknown>).children
  if (!Array.isArray(child) || child.length < 2) return undefined
  const segment = child[0], payload = child[1]
  if (!(typeof segment === 'string' || (Array.isArray(segment) && segment.every(part => typeof part === 'string')))) return undefined
  return (Array.isArray(payload) && payload[0] === '$') || (typeof payload === 'string' && /^\$L?[a-f\d]+$/i.test(payload)) ? child : undefined
}

/** Read bounded inert Flight frames; callers must never mutate their maps. */
export function readMigrationFlightDocument($: CheerioAPI): FlightDocument | undefined {
  flightTextRecords($)
  return flightDocuments.get($)
}

function literalJson(value: string): unknown {
  if (Buffer.byteLength(value) > MAX_SOURCE_BYTES) return undefined
  let depth = 0, quoted = false, escaped = false
  for (const character of value) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === '[' || character === '{') { if (++depth > 96) return undefined }
    else if (character === ']' || character === '}') { if (--depth < 0) return undefined }
  }
  if (depth !== 0 || quoted) return undefined
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

/** Read article-bound UTF-8 text records, including records split across scripts. */
function flightTextRecords($: CheerioAPI): string[] {
  const cached = flightDocuments.get($)
  if (cached) return cached.sources
  const chunks: string[] = []
  let size = 0
  $('script').each((_index, node) => {
    const match = /^\s*self\.__next_f\.push\(\s*(\[[\s\S]*\])\s*\)\s*;?\s*$/.exec($(node).text())
    if (!match) return
    const envelope = literalJson(match[1])
    if (Array.isArray(envelope) && envelope.length === 2 && envelope[0] === 1 && typeof envelope[1] === 'string') {
      size += Buffer.byteLength(envelope[1])
      if (size <= MAX_SOURCE_BYTES) chunks.push(envelope[1])
    }
  })
  if (size > MAX_SOURCE_BYTES) return []
  const bytes = Buffer.from(chunks.join(''))
  const texts = new Map<string, string>()
  const modules = new Map<string, string>()
  const records = new Map<string, unknown>()
  let cursor = 0
  while (cursor < bytes.length && texts.size + modules.size + records.size <= 10_000) {
    const colon = bytes.indexOf(58, cursor)
    if (colon < 0 || colon - cursor > 16 || !/^[a-f\d]*$/i.test(bytes.toString('utf8', cursor, colon))) break
    const id = bytes.toString('utf8', cursor, colon)
    cursor = colon + 1
    if (bytes[cursor] === 84) {
      const comma = bytes.indexOf(44, cursor + 1)
      const length = comma < 0 ? '' : bytes.toString('utf8', cursor + 1, comma)
      if (!/^[a-f\d]{1,8}$/i.test(length)) break
      const end = comma + 1 + Number.parseInt(length, 16)
      if (end > bytes.length) break
      const text = bytes.toString('utf8', comma + 1, end)
      if (text.includes('\uFFFD')) return []
      if (texts.has(id) || records.has(id) || modules.has(id)) return []
      texts.set(id, text)
      cursor = end
    } else {
      const newline = bytes.indexOf(10, cursor)
      const end = newline < 0 ? bytes.length : newline
      const line = bytes.toString('utf8', cursor, end)
      if (id && (texts.has(id) || records.has(id) || modules.has(id))) return []
      if (line.startsWith('I[')) {
        const moduleRecord = literalJson(line.slice(1))
        if (id && Array.isArray(moduleRecord) && typeof moduleRecord[2] === 'string') modules.set(id, moduleRecord[2])
      } else if (id && /^[\[{"\d-]|^(?:true|false|null)$/.test(line)) records.set(id, literalJson(line))
      cursor = end + 1
    }
  }
  if (texts.size + modules.size + records.size > 10_000) return []
  // This explicit Fumadocs contract is evidence of publisher-owned article
  // source. An unreferenced T record, even one with plausible examples, is not
  // article authority. Resolve only data references, never module JavaScript.
  const selected = new Set<string>()
  let visited = 0
  let hasIncompleteSourceTree = false
  const active = new Set<string>()
  const seenReferences = new Set<string>()
  const visit = (value: unknown, inArticle: boolean, depth: number): void => {
    if (depth > 96 || ++visited > 100_000) { hasIncompleteSourceTree = true; return }
    if (typeof value === 'string') {
      const reference = /^\$L?([a-f\d]+)$/i.exec(value)?.[1]
      if (reference && active.has(reference)) hasIncompleteSourceTree = true
      const identity = `${reference}:${inArticle}`
      if (reference && records.has(reference) && !active.has(reference) && !seenReferences.has(identity)) {
        seenReferences.add(identity)
        active.add(reference); visit(records.get(reference), inArticle, depth + 1); active.delete(reference)
      }
      return
    }
    if (Array.isArray(value)) {
      const moduleId = value[0] === '$' && typeof value[1] === 'string' ? /^\$L([a-f\d]+)$/i.exec(value[1])?.[1] : undefined
      const component = moduleId ? modules.get(moduleId) : undefined
      const isArticle = inArticle || component === 'PageArticle'
      const props = value[3]
      if (isArticle && component === 'CopyMarkdownButton' && props && typeof props === 'object' && !Array.isArray(props)) {
        const reference = /^\$([a-f\d]+)$/i.exec(String((props as Record<string, unknown>).content ?? ''))?.[1]
        if (reference && texts.has(reference)) selected.add(texts.get(reference)!)
      }
      if (value[0] === '$' && props && typeof props === 'object' && !Array.isArray(props)) {
        visit((props as Record<string, unknown>).children, isArticle, depth + 1)
        return
      }
      for (const child of value) visit(child, isArticle, depth + 1)
    } else if (depth === 0 && value && typeof value === 'object'
      && Array.isArray((value as Record<string, unknown>).f)) {
      // Only the documented rendered route slot grants article ownership.
      // Tuples hidden in options/examples/component registries are metadata.
      visit((value as Record<string, unknown>).f, inArticle, depth + 1)
    } else {
      const slot = renderedRouteSlot(value)
      if (slot) visit(slot, inArticle, depth + 1)
    }
  }
  visit(records.get('0'), false, 0)
  const sources = visited > 100_000 || hasIncompleteSourceTree ? [] : [...selected]
  flightDocuments.set($, { texts, modules, records, sources })
  return sources
}

function descendants(root: SourceNode): SourceNode[] {
  const result: SourceNode[] = []
  let exceeded = false
  const visit = (node: SourceNode, depth: number) => {
    if (depth > 96 || result.length >= 100_000) { exceeded = true; return }
    result.push(node)
    for (const child of node.children ?? []) visit(child, depth + 1)
  }
  visit(root, 0)
  return exceeded ? [] : result
}

function sourceText(node: SourceNode): string {
  if (['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression'].includes(node.type)) return ''
  return node.value ?? (node.children ?? []).map(sourceText).join('')
}

function sourceNodes(source: string): SourceNode[] {
  const key = createHash('sha256').update(source).digest('hex')
  const cached = sourceTrees.get(key)
  if (cached) {
    sourceTrees.delete(key); sourceTrees.set(key, cached)
    return cached.nodes
  }
  let nodes: SourceNode[]
  try { nodes = descendants(parser.parse(source) as SourceNode) } catch { nodes = [] }
  const bytes = Buffer.byteLength(source)
  if (bytes <= MAX_CACHED_SOURCE_BYTES) {
    while (sourceTrees.size >= 4 || cachedSourceBytes + bytes > MAX_CACHED_SOURCE_BYTES) {
      const oldest = sourceTrees.keys().next().value
      if (oldest === undefined) break
      cachedSourceBytes -= sourceTrees.get(oldest)!.bytes
      sourceTrees.delete(oldest)
    }
    sourceTrees.set(key, { bytes, nodes })
    cachedSourceBytes += bytes
  }
  return nodes
}
// Renderers trim final empty display lines. This is a comparison key only;
// captured and recovered code payloads are never rewritten through this key.
function codeText(value: string): string { return value.replace(/\n+$/, '') }
function labelText(value: string): string { return value.trim().replace(/\s+/g, ' ') }

function renderedCode($: CheerioAPI, node: Parameters<CheerioAPI>[0]): string {
  const copy = $(node).clone()
  // Shiki's empty .line spans can contain one layout placeholder space. Use
  // that exact leaf shape only for source matching; preserve the captured
  // visible code unchanged, including every non-placeholder whitespace byte.
  copy.find('code > span.line').each((_index, line) => {
    if (!$(line).children().length && $(line).text() === ' ') $(line).text('')
  })
  return codeText(copy.text())
}

function isOrderedSubsequence(values: string[], source: string[]): boolean {
  let cursor = 0
  for (const value of values) {
    while (cursor < source.length && source[cursor] !== value) cursor += 1
    if (cursor === source.length) return false
    cursor += 1
  }
  return true
}

function matchesSourceCode(rendered: string, source: string): boolean {
  const actual = codeText(rendered).split('\n'), declared = codeText(source).split('\n')
  if (actual.length !== declared.length) return false
  return declared.every((line, index) => {
    // Shiki consumes these exact editorial directives before token rendering.
    // Only the directive-bearing line's trailing layout space is immaterial;
    // every other code byte (including whitespace in literals) remains exact.
    const directive = /\/\/\s*\[!code (?:\+\+|--|highlight|focus|error|warning)(?::\d+)?\]\s*$/.exec(line)
    return directive ? line.slice(0, directive.index).replace(/[\t ]+$/, '') === actual[index].replace(/[\t ]+$/, '')
      : line === actual[index]
  })
}

function matchesSourceCodeSequence(rendered: string[], source: SourceNode[]): boolean {
  let cursor = 0
  for (const value of rendered) {
    while (cursor < source.length && !matchesSourceCode(value, source[cursor].value ?? '')) cursor += 1
    if (cursor === source.length) return false
    cursor += 1
  }
  return true
}

interface FlightElement { kind: string; props: Record<string, unknown> }
interface LiteralCode { value: string; language?: string }

function hasStaticProps(document: FlightDocument, element: FlightElement, allowed: string[]): boolean {
  // These layout/bookkeeping props intentionally do not author static content.
  // Every other semantic prop must be represented by the exact adapter below.
  const common = new Set(['children', 'className', 'style', 'id', ...allowed])
  return Object.entries(element.props).every(([key, value]) => key === 'ref'
    ? flightValue(document, value) === undefined : common.has(key))
}

function flightValue(document: FlightDocument, value: unknown): unknown {
  const seen = new Set<string>()
  for (let depth = 0; depth < 32 && typeof value === 'string'; depth += 1) {
    if (value.startsWith('$$')) return value.slice(1)
    const reference = /^\$L?([a-f\d]+)(?::(.+))?$/i.exec(value)
    if (!reference) return value === '$undefined' ? undefined : value.startsWith('$') ? UNRESOLVED_FLIGHT_VALUE : value
    if (seen.has(value)) return UNRESOLVED_FLIGHT_VALUE
    seen.add(value)
    if (document.texts.has(reference[1])) return reference[2] ? UNRESOLVED_FLIGHT_VALUE : document.texts.get(reference[1])
    if (!document.records.has(reference[1]) || document.records.get(reference[1]) === undefined) return UNRESOLVED_FLIGHT_VALUE
    value = document.records.get(reference[1])
    if (reference[2]) for (const key of reference[2].split(':')) {
      // Flight property references address the decoded React element's props,
      // while its inert wire representation stores those props in tuple slot 3.
      if (key === 'props' && Array.isArray(value) && value[0] === '$'
        && typeof value[1] === 'string' && value[3] && typeof value[3] === 'object'
        && !Array.isArray(value[3])) { value = value[3]; continue }
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return UNRESOLVED_FLIGHT_VALUE
      value = (value as Record<string, unknown>)[key]
    }
  }
  return typeof value === 'string' && /^\$L?[a-f\d]+(?::|$)/i.test(value) ? UNRESOLVED_FLIGHT_VALUE : value
}

export interface MigrationFlightValue {
  resolved: boolean
  value: unknown
}

/**
 * Shared transport decoding for passive publisher adapters. Missing, cyclic or
 * unsupported references differ from a legitimate undefined value; callers must
 * reject their proof when resolved is false. Registered plain JSON stays opaque
 * and must never be passed through this Flight-only decoder.
 */
export function resolveMigrationFlightValue(document: FlightDocument, input: unknown): MigrationFlightValue {
  const value = flightValue(document, input)
  return value === UNRESOLVED_FLIGHT_VALUE ? { resolved: false, value: undefined } : { resolved: true, value }
}

function flightElement(document: FlightDocument, value: unknown): FlightElement | undefined {
  const node = flightValue(document, value)
  if (!Array.isArray(node) || node[0] !== '$' || typeof node[1] !== 'string'
    || !node[3] || typeof node[3] !== 'object' || Array.isArray(node[3])) return undefined
  const moduleId = /^\$L?([a-f\d]+)$/i.exec(node[1])?.[1]
  const symbol = moduleId ? document.records.get(moduleId) : undefined
  const kind = moduleId ? document.modules.get(moduleId)
    ?? (symbol === '$Sreact.fragment' ? 'Fragment' : symbol === '$Sreact.suspense' ? 'Suspense' : undefined) : node[1]
  return kind ? { kind, props: node[3] as Record<string, unknown> } : undefined
}

function visitFlightTree(document: FlightDocument, root: unknown, visit: (element: FlightElement, raw: unknown, budget: ExpansionBudget) => boolean | void, skipUnresolvedBranches = false): boolean {
  const budget = expansionBudget()
  let hasUnresolvedValue = false
  const walk = (raw: unknown, depth: number): void => {
    if (budget.exceeded) return
    if (depth > 96 || ++budget.visited > 100_000) { budget.exceeded = true; return }
    const value = flightValue(document, raw)
    if (value === UNRESOLVED_FLIGHT_VALUE) { hasUnresolvedValue = true; return }
    if (typeof value === 'string' && !chargeExpansion(budget, value)) return
    const element = flightElement(document, value)
    if (element) {
      if (visit(element, value, budget) !== false) walk(element.props.children, depth + 1)
    } else if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1)
    } else if (depth === 0 && value && typeof value === 'object'
      && Array.isArray((value as Record<string, unknown>).f)) {
      walk((value as Record<string, unknown>).f, depth + 1)
    } else {
      const slot = renderedRouteSlot(value)
      if (slot) walk(slot, depth + 1)
    }
  }
  walk(root, 0)
  return !budget.exceeded && (skipUnresolvedBranches || !hasUnresolvedValue)
}

function flightLiteralText(document: FlightDocument, raw: unknown, depth = 0, code = false, budget = expansionBudget()): string | null {
  if (budget.exceeded || depth > 96 || ++budget.visited > 100_000) { budget.exceeded = true; return null }
  const value = flightValue(document, raw)
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'string' || typeof value === 'number') return chargeExpansion(budget, String(value)) ? String(value) : null
  const element = flightElement(document, value)
  if (element) {
    if (['script', 'style'].includes(element.kind) || element.props.dangerouslySetInnerHTML !== undefined) return null
    if (code && element.kind === 'span' && element.props.className === 'line' && element.props.children === ' ') return ''
    return flightLiteralText(document, element.props.children, depth + 1, code, budget)
  }
  if (!Array.isArray(value)) return null
  let text = ''
  for (const child of value) {
    const literal = flightLiteralText(document, child, depth + 1, code, budget)
    if (literal === null) return null
    text += literal
  }
  return text
}

function flightCode(document: FlightDocument, element: FlightElement, budget = expansionBudget()): LiteralCode | null {
  if (!['CodeBlock', 'Pre', 'pre'].includes(element.kind)) return null
  if (!hasStaticProps(document, element, ['language', 'lang', 'data-language', 'tabIndex', 'icon'])) return null
  const value = flightLiteralText(document, element.props.children, 0, true, budget)
  if (value === null) return null
  const language = [element.props.language, element.props.lang, element.props['data-language']]
    .find(value => typeof value === 'string' && /^[A-Za-z0-9_+-]{1,64}$/.test(value))
  return { value, ...(typeof language === 'string' ? { language } : {}) }
}

function flightTabCode(document: FlightDocument, raw: unknown, depth = 0, budget = expansionBudget()): LiteralCode[] | null {
  if (budget.exceeded || depth > 96 || ++budget.visited > 100_000) { budget.exceeded = true; return null }
  const value = flightValue(document, raw)
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return []
  const element = flightElement(document, value)
  if (element) {
    const code = flightCode(document, element, budget)
    if (code) return [code]
    // This code-only adapter removes its transparent wrapper. Any semantic
    // attribute (including an authored anchor) therefore needs a fuller
    // renderer; loading state must never certify a complete alternative.
    if (!['div', 'figure'].includes(element.kind) || !hasStaticProps(document, element, [])
      || element.props.id !== undefined) return null
    return flightTabCode(document, element.props.children, depth + 1, budget)
  }
  if (!Array.isArray(value)) return null
  const result: LiteralCode[] = []
  for (const child of value) {
    const code = flightTabCode(document, child, depth + 1, budget)
    if (code === null) return null
    result.push(...code)
  }
  return result
}

function htmlLiteral(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A fixed static renderer for loaded publisher disclosure children, never MDX. */
function flightStaticHtml(document: FlightDocument, source: unknown, prefix: string, budget = expansionBudget()): string | null {
  let visited = 0
  const reserve = (bytes: number): void => {
    budget.bytes += bytes
    if (budget.bytes > MAX_SOURCE_BYTES) budget.exceeded = true
  }
  const literal = (value: string): string => {
    if (budget.exceeded) return ''
    let bytes = Buffer.byteLength(value)
    for (const character of value) bytes += character === '&' ? 4 : character === '<' || character === '>' ? 3 : character === '\"' ? 5 : 0
    reserve(bytes)
    return budget.exceeded ? '' : htmlLiteral(value)
  }
  let tabIndex = 0
  const render = (raw: unknown, depth: number): string | null => {
    if (budget.exceeded || depth > 96 || ++visited > 100_000) return null
    const value = flightValue(document, raw)
    if (value === null || value === undefined || typeof value === 'boolean') return ''
    if (typeof value === 'string' || typeof value === 'number') return literal(String(value))
    const element = flightElement(document, value)
    if (!element) {
      if (!Array.isArray(value)) return null
      const children = value.map(child => render(child, depth + 1))
      return children.some(child => child === null) ? null : children.join('')
    }
    reserve(128)
    if (budget.exceeded) return null
    const code = flightCode(document, element, budget)
    if (code) return `<pre${code.language ? ` data-language="${literal(code.language)}"` : ''}><code>${literal(code.value)}</code></pre>`
    if (element.kind === 'svg') {
      const svg = (raw: unknown, depth: number): string | null => {
        if (budget.exceeded || depth > 96 || ++visited > 100_000) return null
        const value = flightValue(document, raw)
        if (value === null || value === undefined || typeof value === 'boolean') return ''
        if (typeof value === 'string' || typeof value === 'number') return literal(String(value))
        const node = flightElement(document, value)
        if (!node) {
          if (!Array.isArray(value)) return null
          const children = value.map(child => svg(child, depth + 1))
          return children.some(child => child === null) ? null : children.join('')
        }
        // React's element representation is serialized into XML, then the
        // existing parsed allowlist decides every drawing primitive/attribute.
        if (!/^[a-z][a-zA-Z\d]*$/.test(node.kind)) return null
        const attributes: string[] = []
        for (const [rawName, rawValue] of Object.entries(node.props)) {
          if (rawName === 'children') continue
          const value = flightValue(document, rawValue)
          if (value === undefined) continue
          if (!['string', 'number', 'boolean'].includes(typeof value)) return null
          const spellings: Record<string, string> = {
            className: 'class', strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap',
            strokeLinejoin: 'stroke-linejoin', strokeMiterlimit: 'stroke-miterlimit',
            strokeDasharray: 'stroke-dasharray', strokeDashoffset: 'stroke-dashoffset',
            fillRule: 'fill-rule', clipRule: 'clip-rule', fillOpacity: 'fill-opacity',
            strokeOpacity: 'stroke-opacity', clipPath: 'clip-path', fontSize: 'font-size',
          }
          const name = spellings[rawName] ?? rawName
          if (!/^[a-zA-Z][a-zA-Z\d:._-]*$/.test(name)) return null
          reserve(name.length + 4)
          if (budget.exceeded) return null
          attributes.push(` ${name}="${literal(String(value))}"`)
        }
        const children = svg(node.props.children, depth + 1)
        return children === null ? null : `<${node.kind}${attributes.join('')}>${children}</${node.kind}>`
      }
      const html = svg(value, depth + 1)
      return html !== null && isPassiveSvg(Buffer.from(html)) ? html : null
    }
    if (element.kind === 'ThemedImage') {
      if (Object.keys(element.props).some(key => !['lightSrc', 'darkSrc', 'alt', 'caption'].includes(key))) return null
      const light = flightValue(document, element.props.lightSrc), dark = flightValue(document, element.props.darkSrc)
      const alt = flightValue(document, element.props.alt)
      if (typeof light !== 'string' || typeof dark !== 'string' || typeof alt !== 'string') return null
      const caption = render(element.props.caption, depth + 1)
      if (caption === null) return null
      return `<figure><picture><source media="(prefers-color-scheme: dark)" srcset="${literal(dark)}"><img src="${literal(light)}" alt="${literal(alt)}"></picture>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`
    }
    if (element.kind === 'Tabs') {
      if (!hasStaticProps(document, element, ['items', 'defaultIndex', 'groupId', 'persist'])) return null
      const children = flightValue(document, element.props.children)
      const tabs = flightElement(document, children) ? [children] : Array.isArray(children) ? children : []
      const labels = flightValue(document, element.props.items)
      const group = tabIndex++
      const choices: Array<{ label: string; html: string; id: string }> = []
      for (const [index, rawTab] of tabs.entries()) {
        const tab = flightElement(document, rawTab)
        const label = tab?.props.value ?? tab?.props.title
        if (tab?.kind !== 'Tab' || !hasStaticProps(document, tab, ['value', 'title']) || typeof label !== 'string' || !label.trim()) return null
        const html = render(tab.props.children, depth + 1)
        if (html === null) return null
        choices.push({ label, html, id: `${prefix}-${group}-${index}` })
      }
      if (!choices.length || (labels !== undefined && (!Array.isArray(labels)
        || JSON.stringify(labels) !== JSON.stringify(choices.map(choice => choice.label))))) return null
      return `<div><div role="tablist">${choices.map(choice => `<button role="tab" id="${choice.id}-tab" aria-controls="${choice.id}-panel">${literal(choice.label)}</button>`).join('')}</div>${choices.map(choice => `<div role="tabpanel" id="${choice.id}-panel" aria-labelledby="${choice.id}-tab">${choice.html}</div>`).join('')}</div>`
    }
    const children = render(element.props.children, depth + 1)
    if (children === null) return null
    if (['Fragment', 'Suspense', 'Accordions'].includes(element.kind)) return hasStaticProps(document, element, ['type', 'defaultValue', 'collapsible']) ? children : null
    if (element.kind === 'Accordion') {
      if (!hasStaticProps(document, element, ['title', 'defaultOpen', 'value'])) return null
      const title = flightLiteralText(document, element.props.title)
      return title === null ? null : `<details open><summary>${literal(title)}</summary>${children}</details>`
    }
    if (element.kind === 'Callout') {
      if (!hasStaticProps(document, element, ['title', 'type', 'icon'])) return null
      const title = element.props.title === undefined ? '' : flightLiteralText(document, element.props.title)
      return title === null ? null : `<blockquote>${title ? `<p><strong>${literal(title)}</strong></p>` : ''}${children}</blockquote>`
    }
    const isStaticLink = element.kind === 'default' && typeof element.props.href === 'string'
      && Object.keys(element.props).every(key => ['href', 'children', 'ref', 'prefetch', 'replace', 'scroll', 'className', 'target', 'rel'].includes(key))
      && ['ref', 'prefetch', 'replace', 'scroll'].every(key => flightValue(document, element.props[key]) === undefined)
    const tag = element.kind === 'Heading' ? element.props.as ?? 'h2'
      : element.kind === 'Link' || isStaticLink ? 'a' : element.kind
    if (typeof tag !== 'string' || !/^(?:p|div|section|span|em|strong|a|ul|ol|li|blockquote|table|thead|tbody|tr|td|th|code|h[1-6]|br|hr|img|picture|source|figure|figcaption|sup|sub|details|summary)$/.test(tag)
      || element.props.dangerouslySetInnerHTML !== undefined) return null
    const semanticAttributes = tag === 'a' ? ['href', 'title', 'target', 'rel']
      : tag === 'img' ? ['src', 'alt', 'width', 'height', 'srcSet', 'srcset', 'sizes', 'title', 'loading', 'decoding']
        : tag === 'source' ? ['srcSet', 'srcset', 'sizes', 'media', 'type', 'width', 'height']
          : tag === 'details' ? ['open'] : []
    if (!isStaticLink && !hasStaticProps(document, element, [...semanticAttributes, ...(element.kind === 'Heading' ? ['as'] : [])])) return null
    const attributes: string[] = []
    for (const name of ['id', ...semanticAttributes]) {
      if (element.props[name] === undefined) continue
      const attribute = flightValue(document, element.props[name])
      if (name === 'open' && typeof attribute === 'boolean') { if (attribute) attributes.push(' open'); continue }
      if (typeof attribute !== 'string' && typeof attribute !== 'number') return null
      reserve(name.length + 4)
      if (budget.exceeded) return null
      attributes.push(` ${name === 'srcSet' ? 'srcset' : name}="${literal(String(attribute))}"`)
    }
    if (['br', 'hr', 'img', 'source'].includes(tag)) return `<${tag}${attributes.join('')}>`
    return `<${tag}${attributes.join('')}>${children}</${tag}>`
  }
  const result = render(source, 0)
  return budget.exceeded ? null : result
}

function recoverFlightDisclosures($: CheerioAPI, root: Selection, document: FlightDocument, article: unknown, projectionBudget: ExpansionBudget): void {
  const disclosures: FlightElement[] = []
  if (!visitFlightTree(document, article, element => {
    if (element.kind === 'Accordion') { disclosures.push(element); return false }
  })) return
  const controls = root.find('button[aria-expanded][aria-controls]').toArray()
  if (controls.length !== disclosures.length) return
  const projections: Array<{ control: typeof controls[number]; panel: Selection; html?: string }> = []
  for (const [index, control] of controls.entries()) {
    const button = $(control), source = disclosures[index]
    if (!hasStaticProps(document, source, ['title', 'defaultOpen', 'value'])) continue
    const title = flightLiteralText(document, source.props.title)
    const id = button.attr('id'), target = button.attr('aria-controls')
    const panel = root.find('[id]').filter((_index, node) => $(node).attr('id') === target)
    if (!id || !target || title === null || labelText(title) !== labelText(button.text())
      || panel.length !== 1 || panel.attr('role') !== 'region' || panel.attr('aria-labelledby') !== id
      || root.find('[id]').filter((_index, node) => $(node).attr('id') === id).length !== 1
      || panel.is('[aria-busy="true"]') || panel.find('[aria-busy="true"],[role="progressbar"]').length) continue
    let html: string | undefined
    if (!panel.text().trim() && !panel.children().length) {
      const prefix = `thally-flight-${createHash('sha256').update(target).digest('hex').slice(0, 16)}`
      const rendered = flightStaticHtml(document, source.props.children, prefix, projectionBudget)
      if (rendered === null || !rendered.trim()) continue
      html = rendered
    }
    projections.push({ control, panel, html })
  }
  if (projectionBudget.exceeded) return
  for (const { control, panel, html } of projections) {
    const button = $(control)
    if (html !== undefined) panel.html(html)
    // Preserve the disclosure's label and anchors while exposing the complete
    // loaded content. Unknown or failed source renderings keep their controls.
    control.name = 'span'
    button.removeAttr('aria-expanded aria-controls role type')
    panel.removeAttr('hidden aria-hidden')
    button.parent('h1,h2,h3,h4,h5,h6').attr('data-thally-static-disclosure-heading', '')
  }
}

/** Recover known literal serialized Tab children from the actual article tree. */
function recoverFlightTreeTabs($: CheerioAPI, root: Selection, projectionBudget: ExpansionBudget): void {
  flightTextRecords($)
  const document = flightDocuments.get($)
  if (!document) return
  const articles: unknown[] = []
  if (!visitFlightTree(document, document.records.get('0'), (element, raw) => {
    if (element.kind === 'PageArticle' || element.kind === 'article') { articles.push(raw); return false }
    // Other application slots may contain unresolved promises. They cannot
    // grant article ownership; each discovered article is checked in full below.
  }, true)) return
  const title = labelText(root.find('h1').first().text())
  const authored = root.children('.prose').length === 1 ? root.children('.prose') : root
  const renderedParagraphs = authored.find('p').toArray().filter(node => !$(node).parents('pre,button,nav,aside,footer').length)
    .map(node => labelText($(node).text())).filter(Boolean)
  const visibleCode = root.find('pre').toArray().map(node => renderedCode($, node))
  const candidates = articles.filter(article => {
    const headings: string[] = [], paragraphs: string[] = [], code: string[] = [], disclosureLabels: string[] = []
    const complete = visitFlightTree(document, article, (element, _raw, budget) => {
      if (element.kind === 'Accordion') {
        const label = flightLiteralText(document, element.props.title, 0, false, budget)
        if (label !== null) disclosureLabels.push(labelText(label))
      }
      if (element.kind === 'p') paragraphs.push(labelText(flightLiteralText(document, element.props.children, 0, false, budget) ?? ''))
      const block = flightCode(document, element, budget)
      if (block) { code.push(codeText(block.value)); return false }
    })
    const completeHeadings = visitFlightTree(document, article, (element, _raw, budget) => {
      if (element.kind === 'Accordion' || ['CodeBlock', 'pre', 'Pre'].includes(element.kind)) return false
      const heading = /^h[1-6]$/.test(element.kind) ? element.kind : element.kind === 'Heading' ? element.props.as : undefined
      if (typeof heading === 'string' && /^h[1-6]$/.test(heading)) headings.push(`${heading}:${labelText(flightLiteralText(document, element.props.children, 0, false, budget) ?? '')}`)
    })
    const renderedHeadings = root.find('h1,h2,h3,h4,h5,h6').toArray().filter(node => {
      const control = $(node).children('button[aria-expanded][aria-controls]').first()
      if (!control.length || !disclosureLabels.includes(labelText(control.text()))) return true
      const copy = $(node).clone(); copy.find('button').remove()
      const id = control.attr('id'), target = control.attr('aria-controls')
      const panel = root.find('[id]').filter((_index, candidate) => $(candidate).attr('id') === target)
      return Boolean(copy.text().trim() || !id || panel.length !== 1 || panel.attr('aria-labelledby') !== id)
    }).map(node => `${node.name}:${labelText($(node).text())}`)
    return complete && completeHeadings && title && headings[0] === `h1:${title}`
      && headings.length === renderedHeadings.length && headings.every((heading, index) => heading === renderedHeadings[index])
      && isOrderedSubsequence(renderedParagraphs, paragraphs) && isOrderedSubsequence(visibleCode, code)
  })
  if (candidates.length !== 1) return
  recoverFlightDisclosures($, root, document, candidates[0], projectionBudget)
  const sourceGroups: Array<Array<{ label: string; code: LiteralCode[] }>> = []
  if (!visitFlightTree(document, candidates[0], (element, _raw, budget) => {
    if (element.kind !== 'Tabs') return
    if (!hasStaticProps(document, element, ['items', 'defaultIndex', 'groupId', 'persist'])) { sourceGroups.push([]); return false }
    const children = flightValue(document, element.props.children)
    const nodes = flightElement(document, children) ? [children] : Array.isArray(children) ? children : []
    const group: Array<{ label: string; code: LiteralCode[] }> = []
    for (const raw of nodes) {
      const tab = flightElement(document, raw)
      const label = tab?.props.value ?? tab?.props.title
      const code = tab?.kind === 'Tab' && hasStaticProps(document, tab, ['value', 'title']) ? flightTabCode(document, tab.props.children, 0, budget) : null
      if (typeof label !== 'string' || !label.trim() || !code?.length) { sourceGroups.push([]); return false }
      group.push({ label: labelText(label), code })
    }
    const items = flightValue(document, element.props.items)
    if ((items !== undefined && (!Array.isArray(items) || JSON.stringify(items) !== JSON.stringify(group.map(tab => tab.label))))
      || (items === undefined && nodes.some(raw => typeof flightElement(document, raw)?.props.title !== 'string'))) sourceGroups.push([])
    else sourceGroups.push(group)
    return false
  })) return
  const groups = root.find('[role="tablist"]').toArray()
  if (sourceGroups.length !== groups.length) return
  groups.forEach((group, index) => {
    const tabs = $(group).find('[role="tab"]').toArray().filter(node => $(node).closest('[role="tablist"]')[0] === group)
    const source = sourceGroups[index]
    if (!tabs.length || source.length !== tabs.length) return
    const panels: Selection[] = []
    for (const [position, tab] of tabs.entries()) {
      const id = $(tab).attr('id'), target = $(tab).attr('aria-controls')
      const panel = root.find('[id]').filter((_index, node) => $(node).attr('id') === target)
      if (!id || !target || panel.length !== 1 || panel.attr('role') !== 'tabpanel'
        || panel.attr('aria-labelledby') !== id || !panel.parents().toArray().includes($(group).parent()[0])
        || labelText($(tab).text()) !== source[position].label
        || panel.is('[aria-busy="true"]') || panel.find('[aria-busy="true"],[role="progressbar"]').length) return
      if (panel.text().trim() || panel.children().length) {
        const copy = panel.clone(); copy.find('pre,button,style,script').remove()
        const blocks = panel.find('pre').toArray().map(node => renderedCode($, node))
        if (copy.text().trim() || blocks.length !== source[position].code.length
          || !blocks.every((block, index) => block === codeText(source[position].code[index].value))) return
      }
      panels.push(panel)
    }
    if (new Set(panels.map(panel => panel[0])).size !== panels.length) return
    panels.forEach((panel, position) => {
      if (panel.text().trim() || panel.children().length) return
      for (const block of source[position].code) {
        if (!chargeProjectedText(projectionBudget, block.value)) return
      }
      for (const block of source[position].code) {
        const pre = $('<pre></pre>').append($('<code></code>').text(block.value))
        if (block.language) pre.attr('data-language', block.language)
        panel.append(pre)
      }
    })
  })
  const declarations: LiteralCode[] = []
  if (!visitFlightTree(document, candidates[0], (element, _raw, budget) => {
    const code = flightCode(document, element, budget)
    if (code) { declarations.push(code); return false }
  })) return
  root.find('pre').each((_index, node) => {
    const payload = renderedCode($, node)
    const matches = declarations.filter(code => codeText(code.value) === payload)
    const languages = new Set(matches.map(code => code.language ?? ''))
    const language = matches[0]?.language
    if (languages.size !== 1 || !language || $(node).attr('language') || $(node).attr('data-language')
      || $(node).find('code[language],code[data-language],code[class*="language-"],code[class*="lang-"]').length
      || /(?:^|\s)(?:language-|lang-)/.test($(node).attr('class') ?? '')) return
    $(node).attr('data-language', language)
  })
}

function sourceTabs(nodes: SourceNode[]): SourceTab[][] {
  return nodes.filter(node => node.name === 'Tabs').map(group => {
    const result: SourceTab[] = []
    for (const tab of group.children ?? []) {
      if (tab.type === 'text' && !tab.value?.trim()) continue
      if (tab.name !== 'Tab') return []
      const label = tab.attributes?.find(attribute => attribute.type === 'mdxJsxAttribute' && attribute.name === 'value')?.value
      if (typeof label !== 'string' || !label.trim()
        || tab.attributes?.some(attribute => attribute.type !== 'mdxJsxAttribute'
          || !['value', 'title'].includes(attribute.name ?? '') || typeof attribute.value !== 'string')) return []
      const content = (tab.children ?? []).filter(child => child.type !== 'text' || child.value?.trim())
      // Rich or dynamic alternatives need a fuller static renderer. Do not
      // recover only their examples and silently lose surrounding prose.
      if (!content.length || content.some(child => child.type !== 'code')) return []
      result.push({ label: labelText(label), code: content })
    }
    return result
  })
}

/**
 * Supply missing literal code only from an unambiguous matching article source.
 * All headings and every existing code payload must agree; each recovered group
 * must additionally match its labels, order and complete visible alternatives.
 */
export function recoverFlightArticleCode($: CheerioAPI, root: Selection): void {
  root.find('[data-thally-static-disclosure-heading]').removeAttr('data-thally-static-disclosure-heading')
  if (root.find('[role="tablist"]').length > 256 || root.find('[role="tab"]').length > 1_024) return
  const projectionBudget = expansionBudget()
  recoverFlightTreeTabs($, root, projectionBudget)
  const renderedHeadings = root.find('h1,h2,h3,h4,h5,h6').toArray()
    .filter(node => $(node).attr('data-thally-static-disclosure-heading') === undefined)
  const headingText = renderedHeadings.map(node => labelText($(node).text()))
  const existingCode = root.find('pre').toArray().map(node => renderedCode($, node))
  if (!headingText.length || !existingCode.length) return
  const prose = root.clone()
  prose.find('pre,button,script,style,nav,footer,aside').remove()
  const renderedProse = labelText(prose.text())
  const candidates: Array<{ nodes: SourceNode[]; groups: SourceTab[][] }> = []
  for (const source of flightTextRecords($)) {
    // Most Flight strings are labels or metadata. Parse only article-shaped
    // source, and keep resource use proportional to the bounded capture.
    if (!/^#\s+\S/m.test(source) || !/^\s*`{3,}/m.test(source)) continue
    const nodes = sourceNodes(source)
    const headings = nodes.filter(node => node.type === 'heading').map((node, index) => {
      const text = labelText(sourceText(node))
      const anchor = /\s+\[#([A-Za-z\d_.:-]+)\]$/.exec(text)
      // Fumadocs' explicit source heading IDs are metadata only when the
      // rendered heading declares the very same ID; ordinary copy stays copy.
      return anchor && $(renderedHeadings[index]).attr('id') === anchor[1] ? text.slice(0, anchor.index) : text
    })
    if (JSON.stringify(headings) !== JSON.stringify(headingText)) continue
    let proseCursor = 0
    let hasMatchingProse = true
    for (const paragraph of nodes.filter(node => node.type === 'paragraph' || node.type === 'tableCell')) {
      const text = labelText(sourceText(paragraph))
      if (!text) continue
      const position = renderedProse.indexOf(text, proseCursor)
      if (position < 0) { hasMatchingProse = false; break }
      proseCursor = position + text.length
    }
    if (!hasMatchingProse) continue
    const sourceCode = nodes.filter(node => node.type === 'code')
    if (matchesSourceCodeSequence(existingCode, sourceCode)) candidates.push({ nodes, groups: sourceTabs(nodes) })
  }
  if (candidates.length !== 1) return
  const source = candidates[0]
  const groups = root.find('[role="tablist"]').toArray()
  if (groups.length === source.groups.length) groups.forEach((group, index) => {
    const tabs = $(group).find('[role="tab"]').toArray().filter(tab => $(tab).closest('[role="tablist"]')[0] === group)
    const sourceGroup = source.groups[index]
    if (!tabs.length || tabs.length !== sourceGroup.length) return
    const panels: Selection[] = []
    for (const [position, tab] of tabs.entries()) {
      const control = $(tab).attr('aria-controls')
      const tabId = $(tab).attr('id')
      const panel = root.find('[id]').filter((_index, node) => $(node).attr('id') === control)
      if (!control || panel.length !== 1 || !panel.is('[role="tabpanel"]')
        || !tabId || root.find('[id]').filter((_index, node) => $(node).attr('id') === tabId).length !== 1
        || panel.attr('aria-labelledby') !== tabId || !panel.parents().toArray().includes($(group).parent()[0])
        || labelText($(tab).text()) !== sourceGroup[position].label
        || panel.is('[aria-busy="true"]') || panel.find('[aria-busy="true"],[role="progressbar"]').length) return
      if (panel.text().trim() || panel.children().length) {
        const code = panel.find('pre').toArray().map(node => renderedCode($, node))
        const clone = panel.clone(); clone.find('pre,button,script,style').remove()
        const declared = sourceGroup[position].code
        if (clone.text().trim() || code.length !== declared.length || !code.every((value, index) => matchesSourceCode(value, declared[index].value ?? ''))) return
      }
      panels.push(panel)
    }
    if (new Set(panels.map(panel => panel[0])).size !== panels.length) return
    panels.forEach((panel, position) => {
      if (panel.text().trim() || panel.children().length) return
      for (const code of sourceGroup[position].code) if (!chargeProjectedText(projectionBudget, code.value ?? '')) return
      for (const code of sourceGroup[position].code) {
        const pre = $('<pre></pre>').append($('<code></code>').text(code.value ?? ''))
        if (code.lang && /^[A-Za-z0-9_+-]{1,64}$/.test(code.lang)) pre.attr('data-language', code.lang)
        panel.append(pre)
      }
    })
  })
  // Code-language restoration uses the same exact payload binding, including
  // restored alternatives. Conflicting metadata is left as the rendered source.
  const sourceCode = source.nodes.filter(node => node.type === 'code')
  let cursor = 0
  root.find('pre').each((_index, node) => {
    const payload = renderedCode($, node)
    while (cursor < sourceCode.length && !matchesSourceCode(payload, sourceCode[cursor].value ?? '')) cursor += 1
    const code = sourceCode[cursor++]
    if (!code?.lang || !/^[A-Za-z0-9_+-]{1,64}$/.test(code.lang)) return
    // Repeated identical examples can legitimately have different languages.
    // A subsequence cannot disambiguate those declarations by payload alone.
    const languages = new Set(sourceCode.filter(candidate => matchesSourceCode(payload, candidate.value ?? '')).map(candidate => candidate.lang ?? ''))
    if (languages.size !== 1) return
    if (!$(node).attr('language') && !$(node).attr('data-language')
      && !$(node).find('code[language],code[data-language],code[class*="language-"],code[class*="lang-"]').length
      && !/(?:^|\s)(?:language-|lang-)/.test($(node).attr('class') ?? '')) $(node).attr('data-language', code.lang)
  })
}
