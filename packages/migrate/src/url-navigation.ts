/**
 * Passive navigation evidence for URL imports. Preserve semantic DOM groups,
 * accessible icon links, declared Mintlify collections and root-owned Fumadocs
 * sidebar menus. Inert Flight data is never executed, and article TOCs or
 * example data cannot supply global navigation. Merge authored occurrences in order.
 */
import { load } from 'cheerio'
import { inferUrlMigrationScope } from './url-scope.js'
import { readMigrationFlightDocument } from './url-flight-content.js'
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

/** Recover the literal collection menu only from the rendered sidebar's owned tree. */
function sidebarCollectionMenus($: ReturnType<typeof load>, root: ReturnType<ReturnType<typeof load>>, base: URL, existing: Array<SourceNode>): Array<SourceNode> {
  const document = readMigrationFlightDocument($)
  if (!document) return []
  const resolve = (input: unknown): unknown => {
    let value = input
    const seen = new Set<string>()
    for (let depth = 0; depth < 32 && typeof value === 'string'; depth++) {
      if (value === '$undefined') return undefined
      if (value.startsWith('$$')) return value.slice(1)
      const reference = /^\$L?([a-f\d]+)(?::(.+))?$/i.exec(value)
      if (!reference) return value
      if (seen.has(value) || !document.records.has(reference[1])) return undefined
      seen.add(value)
      value = document.records.get(reference[1])
      for (const key of reference[2]?.split(':') ?? []) {
        // Flight exposes React element properties by semantic name even
        // though its inert wire value is the four-item element tuple.
        if (key === 'props' && Array.isArray(value) && value[0] === '$') { value = value[3]; continue }
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
        value = (value as Record<string, unknown>)[key]
      }
    }
    return typeof value === 'string' && /^\$L?[a-f\d]+(?::|$)/i.test(value) ? undefined : value
  }
  const known = new Set<string>()
  const remember = (nodes: Array<SourceNode>): void => {
    for (const node of nodes) { if (node.url) known.add(node.url); remember(node.children ?? []) }
  }
  remember(existing)
  const result: Array<SourceNode> = []
  let visited = 0
  const active = new Set<unknown>()
  const visit = (input: unknown, inSidebar: boolean, inHeader: boolean, inArticle: boolean, depth: number): void => {
    if (++visited > 100_000 || depth > 96 || active.has(input)) return
    const value = resolve(input)
    if (!value || typeof value !== 'object') return
    active.add(input)
    if (Array.isArray(value)) {
      if (value[0] === '$' && object(value[3])) {
        const componentId = typeof value[1] === 'string' ? /^\$L([a-f\d]+)$/i.exec(value[1])?.[1] : undefined
        const component = componentId ? document.modules.get(componentId) : value[1]
        const article = inArticle || ['PageArticle', 'article', 'pre', 'code'].includes(String(component))
        const sidebar = !article && (inSidebar || component === 'Sidebar')
        const header = sidebar && (inHeader || component === 'SidebarHeader')
        if (header && component === 'RootToggle') {
          const options = resolve(value[3].options)
          if (Array.isArray(options) && options.length >= 2 && options.length <= 100) {
            const entries = options.map(resolve).map(option => object(option) ? { label: text(resolve(option.title)), url: target(resolve(option.url), base) } : {})
            const hasVisibleChoice = entries.some(entry => entry.label && root.find('button[aria-haspopup]').toArray().some(button => [button, ...$(button).find('*').toArray()].some(node => $(node).text().trim() === entry.label)))
            if (hasVisibleChoice && entries.every(entry => entry.label && entry.url)) for (const entry of entries) {
              // The active collection's landing page already occurs in the
              // sidebar. Keep additional menu destinations without inventing a
              // second title for that article or flattening its authored groups.
              if (!known.has(entry.url!)) { known.add(entry.url!); result.push({ label: entry.label!, url: entry.url! }) }
            }
          }
        }
        visit(value[3].children, sidebar, header, article, depth + 1)
      } else for (const child of value) visit(child, inSidebar, inHeader, inArticle, depth + 1)
    } else for (const child of Object.values(value)) visit(child, inSidebar, inHeader, inArticle, depth + 1)
    active.delete(input)
  }
  visit(document.records.get('0'), false, false, false, 0)
  return visited > 100_000 ? [] : result
}

/** Extract explicit capture navigation, passive Mintlify data, or a DOM sidebar. */
export function extractSourceNavigation(capture: MigrationCapture, selectedScope?: string): Array<MigrationNavigationOccurrence> {
  if (capture.navigation) return resolveNavigation(capture.navigation, capture.finalUrl)
  if (!/html/i.test(capture.contentType) || Buffer.byteLength(capture.body) > MAX_CAPTURE_BYTES) return []
  const mintlify = mintlifyNavigation(capture.body, capture.finalUrl, capture.locale, selectedScope)
  if (mintlify.length) return mintlify
  const $ = load(capture.body)
  const candidates = ['.theme-doc-sidebar-menu,[aria-label*="sidebar" i]', 'aside', '[role="navigation"],nav']
  const root = candidates.map((selector) => $(selector).filter((_index, node) => {
    const item = $(node)
    if (!item.find('a[href]').length || item.closest('header,article').length) return false
    const current = new URL(capture.finalUrl)
    const internal = item.find('a[href]').toArray().flatMap(link => {
      const reference = target($(link).attr('href'), capture.finalUrl)
      if (!reference) return []
      const url = new URL(reference)
      return url.origin === current.origin ? [url] : []
    })
    // An article's sibling TOC/author aside is not a site sidebar. Its same-
    // origin links all point back into this one article; breadcrumbs inside an
    // article were rejected above. Real query-selected page targets stay exact.
    if (!internal.length) {
      if (item.is('nav,[role="navigation"]')) return true
      const prose = item.clone(); prose.find('a,svg,img,script,style').remove()
      return !prose.text().trim()
    }
    return internal.every(url => !url.hash)
      || internal.some(url => url.pathname !== current.pathname || (!url.hash && url.search !== current.search))
  }).first()).find((candidate) => candidate.length)
  if (!root) return []
  let count = 0
  const labelOf = (item: ReturnType<typeof $>): string => {
    const visible = item.text().replace(/\s+/g, ' ').trim()
    if (visible) return visible
    if (item.is('a[href]')) {
      const url = target(item.attr('href'), capture.finalUrl)
      if (url && root.find('a[href]').toArray().some(node => node !== item[0] && $(node).text().trim() && target($(node).attr('href'), capture.finalUrl) === url)) return ''
    }
    return text(item.attr('aria-label')) || text(item.attr('title')) || text(item.find('img[alt]').first().attr('alt')) || ''
  }
  const walk = (element: Parameters<typeof $>[0], excluded?: unknown, depth = 0): Array<SourceNode> => {
    if (depth > MAX_DEPTH) throw new Error('Source navigation exceeds its safety bound.')
    const result: Array<SourceNode> = []
    const siblings = $(element).children().toArray().filter(node => node !== excluded)
    if (siblings.length > MAX_NODES) throw new Error('Source navigation exceeds its safety bound.')
    // Some sidebars use plain p/span labels in a single sibling stream. A
    // repeated label→links structure proves grouping; an isolated paragraph or
    // arbitrary wrapper text does not. Refuse ambiguous/search/marketing nodes
    // rather than letting a label absorb unrelated controls or prose.
    const marker = (node: typeof siblings[number]): boolean => {
      const item = $(node)
      return item.is('p,span') && Boolean(item.text().trim()) && item.text().length <= 512
        && item.find('*').toArray().every(child => $(child).is('span,strong,em,b,i,small,code,br'))
        && !item.find('a,button,input,textarea,select,form,div,p,section,article').length
        && !item.closest('form,[role="search"],[aria-hidden="true"]').length
    }
    const markerPositions = siblings.flatMap((node, index) => marker(node) ? [index] : [])
    const markers = markerPositions.map(index => siblings[index])
    const isLinkContainer = (node: typeof siblings[number]): boolean => {
      const item = $(node)
      if (item.is('a[href]')) return true
      if (!item.is('div,li,ul,ol,details')) return false
      if (!item.find('a[href]').length || item.find('form,input,textarea,select,[role="search"]').length) return false
      const remainder = item.clone()
      remainder.find('a[href],svg,img').remove()
      return !remainder.text().trim() && !remainder.find('button,form,input,textarea,select,section,article').length
    }
    const groupedMarkers = new Set<typeof siblings[number]>()
    if (markers.length >= 2 && markers.every(node => node.tagName === markers[0].tagName)) {
      let isComplete = true
      for (let index = 0; index < markers.length; index++) {
        const start = markerPositions[index] + 1
        const end = index + 1 < markers.length ? markerPositions[index + 1] : siblings.length
        const following = siblings.slice(start, end).filter(node => $(node).text().trim() || $(node).find('a[href],button,input,textarea,select,form,img').length)
        if (!following.length || !following.every(isLinkContainer)) { isComplete = false; break }
      }
      if (isComplete) markers.forEach(node => groupedMarkers.add(node))
    }
    let currentGroup: SourceNode | undefined
    const append = (nodes: Array<SourceNode>): void => {
      if (currentGroup) currentGroup.children!.push(...nodes)
      else result.push(...nodes)
    }
    $(element).children().each((_index, node) => {
      if (++count > MAX_NODES) throw new Error('Source navigation exceeds its safety bound.')
      if (node === excluded) return
      const item = $(node)
      if (groupedMarkers.has(node)) {
        currentGroup = { kind: 'group', label: item.text().replace(/\s+/g, ' ').trim(), children: [] }
        result.push(currentGroup)
      } else if (item.is('a[href]')) {
        const label = labelOf(item)
        const url = target(item.attr('href'), capture.finalUrl)
        if (label && url) append([{ label, url }])
      } else if (item.is('li,details') || item.attr('data-migration-group') !== undefined || item.children('h2,h3,h4,h5,h6').length > 0) {
        const directLink = item.children('a[href]').first()
        const direct = directLink.length ? directLink : item.children('div').children('a[href]').first()
        const label = labelOf(direct) || labelOf(item.children('summary,button,span,h2,h3,h4,h5,h6').first())
        const children = walk(node, direct[0], depth + 1)
        const url = target(direct.attr('href'), capture.finalUrl)
        if (label && (url || children.length)) append([{ label, ...(url ? { url } : {}), ...(children.length ? { children } : {}) }])
        else append(children)
      } else append(walk(node, excluded, depth + 1))
    })
    return result
  }
  try {
    const nodes = walk(root)
    return [...nodes, ...sidebarCollectionMenus($, root, capture.finalUrl, nodes)]
  } catch { return [] }
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
