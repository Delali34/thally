/**
 * Passive navigation evidence for URL imports. Mintlify sends one expanded tab
 * in React Flight and entry-page placeholders for its siblings. Read only JSON
 * records, then merge observations without losing authored occurrence order.
 */
import { load } from 'cheerio'
import { inferUrlMigrationScope } from './url-scope.js'
import type { MigrationCapture, MigrationNavigationOccurrence } from './url-run-types.js'

interface SourceNode extends MigrationNavigationOccurrence {
  kind?: 'tab' | 'group' | 'page'
  locale?: string
  children?: Array<SourceNode>
}

const MAX_CAPTURE_BYTES = 8_000_000
const MAX_JSON_BYTES = 2_000_000
const MAX_NODES = 10_000
const MAX_DEPTH = 32
const MAX_STRING_LENGTH = 8_192

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH && value.trim()
    ? value.trim() : undefined
}

function target(value: unknown, base: URL): string | undefined {
  const reference = text(value)
  if (!reference) return undefined
  try {
    const url = new URL(reference, base)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString() : undefined
  } catch { return undefined }
}

/** Bound nesting before JSON.parse; remote data never becomes JavaScript. */
function readJson(value: string): unknown {
  if (Buffer.byteLength(value) > MAX_JSON_BYTES) return undefined
  let depth = 0
  let quoted = false
  let escaped = false
  for (const char of value) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '[' || char === '{') {
      if (++depth > 96) return undefined
    } else if (char === ']' || char === '}') depth--
  }
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function flightRecords(stream: string): Array<unknown> {
  const bytes = Buffer.from(stream)
  const records: Array<unknown> = []
  let cursor = 0
  while (cursor < bytes.length) {
    const colon = bytes.indexOf(58, cursor)
    // Hint records such as :HL[...] have an empty id and still occupy a line.
    if (colon < 0 || colon - cursor > 16 || !/^[a-f\d]*$/i.test(bytes.toString('utf8', cursor, colon))) break
    cursor = colon + 1
    if (bytes[cursor] === 84) {
      // Flight T records contain arbitrary UTF-8 article text, with a hex byte
      // length and no terminating newline. Skip their exact bytes, including any
      // navigation-looking example code; the next record may start immediately.
      const comma = bytes.indexOf(44, cursor + 1)
      const length = comma < 0 ? '' : bytes.toString('utf8', cursor + 1, comma)
      if (!/^[a-f\d]{1,8}$/i.test(length)) break
      const end = comma + 1 + Number.parseInt(length, 16)
      if (end > bytes.length) break
      cursor = end
      continue
    }
    const newline = bytes.indexOf(10, cursor)
    const end = newline < 0 ? bytes.length : newline
    if (bytes[cursor] === 91 || bytes[cursor] === 123) records.push(readJson(bytes.toString('utf8', cursor, end)))
    cursor = end + 1
  }
  return records
}

function mintlifyNavigation(body: string, base: URL, locale?: string, selectedScope?: string): Array<SourceNode> {
  const $ = load(body)
  const scope = inferUrlMigrationScope({ body, contentType: 'text/html', finalUrl: base })
  const mount = scope.evidence === 'source-parent' ? selectedScope ?? '/' : scope.scopePath
  // Publisher navigation IDs and hrefs are documentation-relative. Actual DOM
  // hrefs below retain ordinary browser URL semantics.
  const configTarget = (value: unknown): string | undefined => {
    const reference = text(value)
    if (!reference) return undefined
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) return target(reference, base)
    const path = reference.replace(/^\/+/, '')
    const prefix = mount.replace(/^\/|\/$/g, '')
    return target(prefix && path !== prefix && !path.startsWith(`${prefix}/`) ? `${prefix}/${path}` : path, new URL('/', base))
  }
  let stream = ''
  const records: Array<unknown> = []
  $('script').each((_index, script) => {
    const source = $(script).text()
    // Refuse any surrounding statements or expressions: this is a data envelope,
    // not a script evaluator. JSON string escapes are decoded by JSON.parse only.
    const call = /^\s*self\.__next_f\.push\(\s*(\[[\s\S]*\])\s*\)\s*;?\s*$/.exec(source)
    if (call) {
      const value = readJson(call[1])
      if (Array.isArray(value) && value[0] === 1 && typeof value[1] === 'string') stream += value[1]
    } else if ($(script).attr('type') === 'application/json') {
      records.push(readJson(source))
    }
  })
  // Transport script boundaries are independent of Flight record boundaries.
  records.push(...flightRecords(stream))

  const candidates: Array<{ value: unknown; rank: number }> = []
  let visited = 0
  const visit = (value: unknown, depth = 0): void => {
    if (++visited > MAX_NODES * 5 || depth > 96) return
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1)
    } else if (object(value)) {
      for (const key of ['scopedNav', 'docsNavWithMetadata', 'anonymizedNav']) {
        if (object(value[key])) candidates.push({ value: value[key], rank: key === 'scopedNav' ? 3 : 2 })
      }
      if (object(value.docsConfig) && object(value.docsConfig.navigation)) {
        candidates.push({ value: value.docsConfig.navigation, rank: 1 })
      }
      for (const child of Object.values(value)) visit(child, depth + 1)
    }
  }
  records.forEach((record) => visit(record))

  const language = locale ?? text($('html').attr('lang'))
  for (const candidate of candidates.sort((a, b) => b.rank - a.rank)) {
    let count = 0
    const walk = (value: unknown, depth = 0, activeLocale?: string): Array<SourceNode> => {
      if (depth > MAX_DEPTH || ++count > MAX_NODES) throw new Error('Source navigation exceeds its safety bound.')
      if (typeof value === 'string') {
        // docs.json page ids are rooted at the documentation site, while
        // captured DOM hrefs retain ordinary relative-URL semantics below.
        const url = configTarget(value)
        return url ? [{ kind: 'page', label: value, url }] : []
      }
      if (Array.isArray(value)) return value.flatMap((child) => walk(child, depth + 1, activeLocale))
      if (!object(value)) return []
      if (Array.isArray(value.languages)) {
        const languages = value.languages.filter(object)
        // A site's HTML lang can be stale on legacy translated namespaces. The
        // publisher's scoped navigation still identifies that route's language
        // explicitly. Prefer the branch that actually contains this captured
        // article, with populated navigation breaking placeholder-only ties.
        const current = new URL(base); current.hash = ''
        const routeScore = (item: Record<string, unknown>): number => {
          let visited = 0
          let matches = false
          let populated = 0
          const scan = (node: unknown, depth = 0): void => {
            if (++visited > MAX_NODES || depth > MAX_DEPTH) return
            if (Array.isArray(node)) { for (const child of node) scan(child, depth + 1); return }
            if (!object(node)) return
            const href = configTarget(node.href)
            if (href) {
              populated++
              const url = new URL(href); url.hash = ''
              if (url.toString() === current.toString()) matches = true
            }
            for (const key of ['tabs', 'groups', 'pages', 'dropdowns', 'anchors', 'versions']) {
              if (Array.isArray(node[key])) scan(node[key], depth + 1)
            }
          }
          scan(item)
          return matches ? populated : 0
        }
        const matching = languages.map((item) => ({ item, score: routeScore(item) }))
          .filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score)
        const selected = matching[0]?.item
          ?? languages.find((item) => text(item.language)?.toLowerCase() === language?.toLowerCase())
          ?? languages.find((item) => text(item.language)?.toLowerCase() === 'en') ?? languages[0]
        return selected ? walk({ ...selected, languages: undefined }, depth + 1, text(selected.language)) : []
      }
      const label = text(value.tab) ?? text(value.dropdown) ?? text(value.group) ?? text(value.sidebarTitle) ?? text(value.title) ?? text(value.label)
      const kind = text(value.tab) || text(value.dropdown) ? 'tab' : text(value.group) ? 'group' : 'page'
      const children = ['tabs', 'groups', 'pages', 'dropdowns', 'anchors', 'versions']
        .flatMap((key) => Array.isArray(value[key]) ? walk(value[key], depth + 1, activeLocale) : [])
      const url = configTarget(value.href)
      if (!label) return children
      if (!url && !children.length) return []
      return [{ kind, label, ...(url ? { url } : {}), ...(children.length ? { children } : {}),
        ...(text(value.dropdown) ? { presentation: 'dropdown' as const } : {}),
        ...(kind === 'tab' && activeLocale ? { locale: activeLocale } : {}) }]
    }
    try {
      const nodes = walk(candidate.value)
      if (nodes.length) return nodes
    } catch { /* A malformed candidate must not hide valid DOM evidence. */ }
  }
  return []
}

function resolveNavigation(nodes: Array<SourceNode>, base: URL): Array<SourceNode> {
  let count = 0
  const walk = (items: Array<SourceNode>, depth = 0): Array<SourceNode> => {
    if (depth > MAX_DEPTH || !Array.isArray(items)) throw new Error('Invalid source navigation.')
    return items.flatMap((node) => {
      if (++count > MAX_NODES || !object(node)) throw new Error('Source navigation exceeds its safety bound.')
      const label = text(node.label)
      if (!label) return []
      const url = target(node.url, base)
      const children = node.children ? walk(node.children, depth + 1) : []
      return [{ label, ...(url ? { url } : {}), ...(children.length ? { children } : {}),
        ...(['tab', 'group', 'page'].includes(node.kind ?? '') ? { kind: node.kind } : {}),
        ...(node.presentation === 'dropdown' ? { presentation: 'dropdown' as const } : {}),
        ...(text(node.locale) ? { locale: text(node.locale) } : {}) }]
    })
  }
  return walk(nodes)
}

/** Extract explicit capture navigation, passive Mintlify data, or a DOM sidebar. */
export function extractSourceNavigation(capture: MigrationCapture, selectedScope?: string): Array<MigrationNavigationOccurrence> {
  if (capture.navigation) return resolveNavigation(capture.navigation, capture.finalUrl)
  if (!/html/i.test(capture.contentType) || Buffer.byteLength(capture.body) > MAX_CAPTURE_BYTES) return []
  const mintlify = mintlifyNavigation(capture.body, capture.finalUrl, capture.locale, selectedScope)
  if (mintlify.length) return mintlify
  const $ = load(capture.body)
  const candidates = ['.theme-doc-sidebar-menu,[aria-label*="sidebar" i]', 'aside', '[role="navigation"],nav']
  const root = candidates.map((selector) => $(selector).filter((_index, node) => $(node).find('a[href]').length > 0 && $(node).closest('header').length === 0).first()).find((candidate) => candidate.length)
  if (!root) return []
  let count = 0
  const walk = (element: Parameters<typeof $>[0], excluded?: unknown, depth = 0): Array<SourceNode> => {
    if (depth > MAX_DEPTH) throw new Error('Source navigation exceeds its safety bound.')
    const result: Array<SourceNode> = []
    $(element).children().each((_index, node) => {
      if (++count > MAX_NODES) throw new Error('Source navigation exceeds its safety bound.')
      if (node === excluded) return
      const item = $(node)
      if (item.is('a[href]')) {
        const label = item.text().replace(/\s+/g, ' ').trim()
        const url = target(item.attr('href'), capture.finalUrl)
        if (label && url) result.push({ label, url })
      } else if (item.is('li,details') || item.attr('data-migration-group') !== undefined || item.children('h2,h3,h4,h5,h6').length > 0) {
        const directLink = item.children('a[href]').first()
        const direct = directLink.length ? directLink : item.children('div').children('a[href]').first()
        const label = direct.text().trim() || item.children('summary,button,span,h2,h3,h4,h5,h6').first().text().trim()
        const children = walk(node, direct[0], depth + 1)
        const url = target(direct.attr('href'), capture.finalUrl)
        if (label && (url || children.length)) result.push({ label, ...(url ? { url } : {}), ...(children.length ? { children } : {}) })
        else result.push(...children)
      } else result.push(...walk(node, excluded, depth + 1))
    })
    return result
  }
  try { return walk(root) } catch { return [] }
}

function placeholder(node: SourceNode): boolean {
  const children = node.children ?? []
  return node.kind === 'tab' && children.length === 1 && children[0].kind === 'page'
    && children[0].label === node.label && !children[0].children?.length
}

/** Merge observed sibling occurrences; expanded tabs replace entry placeholders. */
export function mergeSourceNavigation(
  existing: Array<MigrationNavigationOccurrence>,
  incoming: Array<MigrationNavigationOccurrence>,
): Array<MigrationNavigationOccurrence> {
  let count = 0
  const merge = (left: Array<SourceNode>, right: Array<SourceNode>, depth = 0): Array<SourceNode> => {
    if (depth > MAX_DEPTH || (count += left.length + right.length) > MAX_NODES * 4) throw new Error('Source navigation exceeds its safety bound.')
    const result = left.map((node) => ({ ...node }))
    const identity = (node: SourceNode): string => JSON.stringify([
      node.kind, node.label, node.locale, node.kind === 'tab' || node.kind === 'group' ? undefined : node.url,
    ])
    const positions = new Map<string, Array<number>>()
    result.forEach((node, index) => {
      const key = identity(node)
      const siblings = positions.get(key) ?? []
      siblings.push(index)
      positions.set(key, siblings)
    })
    const offsets = new Map<string, number>()
    for (const next of right) {
      // Identity is local to siblings. A page repeated under another group or
      // repeated twice in one group remains a separate authored occurrence.
      const key = identity(next)
      const offset = offsets.get(key) ?? 0
      const index = positions.get(key)?.[offset]
      offsets.set(key, offset + 1)
      if (index === undefined) { result.push({ ...next }); continue }
      const previous = result[index]
      if (placeholder(previous) && !placeholder(next)) result[index] = { ...next }
      else if (!placeholder(previous) && placeholder(next)) continue
      else result[index] = { ...previous, ...next, ...(previous.children || next.children
        ? { children: merge(previous.children ?? [], next.children ?? [], depth + 1) } : {}) }
    }
    return result
  }
  return merge(existing, incoming)
}
