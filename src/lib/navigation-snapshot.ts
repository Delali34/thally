/**
 * Portable navigation snapshots. Large trees travel once through a pull-driven
 * JSON projection instead of every article's Flight payload. The canonical
 * reader-filtered tree remains authoritative; transport never invents links.
 */
import type { NavigationNode, NavigationSection, SidebarCollection } from '@/data/docs'

export const MAX_INLINE_NAVIGATION_NODES = 256
export const MAX_INLINE_NAVIGATION_BYTES = 128 * 1024
/** Explicit browser transfer ceiling; oversized responses fail rather than install a partial tree. */
export const MAX_NAVIGATION_RESPONSE_BYTES = 32 * 1024 * 1024
const JSON_STRING_SLICE = 1024

export interface NavigationSnapshot {
  schemaVersion: 1
  scope: string
  /** Several logical API store scopes share the default canonical projection. */
  dataScope: string
  viewKey: string
  snapshotId: string
  mode: 'inline' | 'deferred'
  /** Full inline tree, or bounded collection headers for deferred navigation. */
  collections: Array<SidebarCollection>
  endpoint?: string
}

/** Validate a logical scope without interpreting it as a path or external URL. */
export function isNavigationScope(scope: string): boolean {
  if (scope === 'default') return true
  if (scope.startsWith('locale:')) return /^locale:[A-Za-z0-9-]{2,64}$/.test(scope)
  return scope.startsWith('api:') && scope.length > 4 && scope.length <= 260 && !/[\u0000-\u0020/\\?#]/.test(scope.slice(4))
}

/** API logical scopes currently share precisely the default tree, not a separate data cache. */
export function navigationDataScope(scope: string): string { return scope.startsWith('api:') ? 'default' : scope }

/** Emit JSON strings incrementally, including lone-surrogate/control escaping. */
function* jsonString(value: string): Generator<string> {
  yield '"'
  // JSON.stringify handles control characters and lone surrogates correctly.
  // Splitting a pair at the boundary yields two valid JSON surrogate escapes,
  // which decode to the same original pair without a whole-string allocation.
  for (let offset = 0; offset < value.length; offset += JSON_STRING_SLICE) yield JSON.stringify(value.slice(offset, offset + JSON_STRING_SLICE)).slice(1, -1)
  yield '"'
}

/** Serialize JSON-safe data without a whole-tree string or encoded buffer. */
export function* navigationJson(value: unknown): Generator<string> {
  if (typeof value === 'string') { yield* jsonString(value); return }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') { yield JSON.stringify(value); return }
  if (Array.isArray(value)) {
    yield '['
    for (let index = 0; index < value.length; index += 1) {
      if (index) yield ','
      yield* navigationJson(value[index] ?? null)
    }
    yield ']'
    return
  }
  if (value && typeof value === 'object') {
    yield '{'
    let hasEntry = false
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) continue
      if (hasEntry) yield ','
      hasEntry = true
      yield* jsonString(key)
      yield ':'
      yield* navigationJson(item)
    }
    yield '}'
    return
  }
  throw new Error('Navigation contains non-JSON data')
}

/** Stop measurement at the limit; deciding to defer must itself remain bounded. */
export function canInlineNavigation(collections: Array<SidebarCollection>): boolean {
  let nodes = 0
  const visit = (items: Array<NavigationNode>): boolean => {
    for (const node of items) {
      if (++nodes > MAX_INLINE_NAVIGATION_NODES) return false
      if (node.type === 'group' && !visit(node.group.nodes)) return false
    }
    return true
  }
  for (const collection of collections) for (const section of collection.sections) {
    if (section.nodes ? !visit(section.nodes) : (nodes += section.items.length) > MAX_INLINE_NAVIGATION_NODES) return false
  }
  let bytes = 0
  const encoder = new TextEncoder()
  for (const chunk of navigationJson(collections)) {
    bytes += encoder.encode(chunk).byteLength
    if (bytes > MAX_INLINE_NAVIGATION_BYTES) return false
  }
  return true
}

/** Keep a bounded, honest shell while the complete tree is loading. */
export function navigationHeaders(collections: Array<SidebarCollection>): Array<SidebarCollection> {
  const result: Array<SidebarCollection> = []
  let bytes = 2 // Array delimiters count toward the same transfer bound.
  for (const collection of collections) {
    if (result.length >= MAX_INLINE_NAVIGATION_NODES) break
    const header: SidebarCollection = {
      id: collection.id, label: collection.label, version: collection.version,
      icon: collection.icon, href: collection.href,
      ...(collection.api ? { api: { source: '', navigation: collection.api.navigation } } : {}),
      sections: [],
    }
    // Headers are small normal metadata; a pathological individual label must
    // not bypass the same byte limit used for an inline complete snapshot.
    let headerBytes = result.length ? 1 : 0 // Comma between retained headers.
    for (const chunk of navigationJson(header)) {
      headerBytes += new TextEncoder().encode(chunk).byteLength
      if (bytes + headerBytes > MAX_INLINE_NAVIGATION_BYTES) break
    }
    if (bytes + headerBytes > MAX_INLINE_NAVIGATION_BYTES) break
    bytes += headerBytes
    result.push(header)
  }
  return result
}

/** Tree-only wire projection; flattened compatibility lists are rebuilt in the browser. */
export function* navigationWire(collections: Array<SidebarCollection>): Generator<string> {
  yield '['
  for (let index = 0; index < collections.length; index += 1) {
    if (index) yield ','
    const { sections, ...metadata } = collections[index]
    yield '{'
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined) continue
      yield* navigationJson(key); yield ':'; yield* navigationJson(value); yield ','
    }
    yield '"sections":['
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      if (sectionIndex) yield ','
      const { items, nodes, ...section } = sections[sectionIndex]
      yield '{'
      for (const [key, value] of Object.entries(section)) {
        if (value === undefined) continue
        yield* navigationJson(key); yield ':'; yield* navigationJson(value); yield ','
      }
      yield '"nodes":'
      if (nodes) yield* navigationJson(nodes)
      else {
        yield '['
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          if (itemIndex) yield ','
          yield '{"type":"page","item":'; yield* navigationJson(items[itemIndex]); yield '}'
        }
        yield ']'
      }
      yield '}'
    }
    yield ']}'
  }
  yield ']'
}

/** Validate the response before it can replace a reader's navigation state. */
export function decodeNavigationWire(value: unknown): Array<SidebarCollection> {
  if (!Array.isArray(value)) throw new Error('Invalid navigation collections')
  let count = 0
  const readNodes = (nodes: unknown, depth: number): Array<NavigationNode> => {
    if (!Array.isArray(nodes) || depth > 64) throw new Error('Invalid navigation tree')
    return nodes.map((node: unknown) => {
      if (++count > 100_000 || !node || typeof node !== 'object') throw new Error('Navigation exceeds its safety bound')
      const candidate = node as NavigationNode
      if (candidate.type === 'page' && candidate.item && typeof candidate.item === 'object'
        && typeof candidate.item.id === 'string' && typeof candidate.item.href === 'string' && typeof candidate.item.title === 'string') return candidate
      if (candidate.type === 'group' && candidate.group && typeof candidate.group.id === 'string' && typeof candidate.group.title === 'string') {
        return { ...candidate, group: { ...candidate.group, nodes: readNodes(candidate.group.nodes, depth + 1) } }
      }
      throw new Error('Invalid navigation node')
    })
  }
  const flatten = (nodes: Array<NavigationNode>): NavigationSection['items'] => nodes.flatMap(node => node.type === 'page' ? [node.item] : flatten(node.group.nodes))
  return value.map((collection: unknown) => {
    if (++count > 100_000 || !collection || typeof collection !== 'object') throw new Error('Invalid navigation collection')
    const candidate = collection as SidebarCollection
    if (typeof candidate.id !== 'string' || typeof candidate.label !== 'string' || !Array.isArray(candidate.sections)) throw new Error('Invalid navigation collection')
    return { ...candidate, sections: candidate.sections.map(section => {
      if (++count > 100_000 || !section || typeof section.title !== 'string') throw new Error('Invalid navigation section')
      const nodes = readNodes(section.nodes, 0)
      return { ...section, nodes, items: flatten(nodes) }
    }) }
  })
}

/** Read one bounded response; no partial or over-budget snapshot can enter the store. */
export async function readNavigationResponse(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > MAX_NAVIGATION_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('Navigation exceeds the supported response size')
  }
  if (!response.body) throw new Error('Navigation response is empty')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts: Array<string> = []
  let pending = ''
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_NAVIGATION_RESPONSE_BYTES) throw new Error('Navigation exceeds the supported response size')
      pending += decoder.decode(value, { stream: true })
      // Coalesce tiny transport chunks so bookkeeping is bounded by response
      // bytes too, rather than one retained entry per network fragment.
      if (pending.length >= 65536) { parts.push(pending); pending = '' }
    }
    parts.push(pending + decoder.decode())
    return JSON.parse(parts.join(''))
  } catch (error) { await reader.cancel().catch(() => undefined); throw error }
  finally { reader.releaseLock() }
}
