/**
 * Collection-wide navigation projection. Windows replace consecutive visible
 * DFS rows; retained ancestor references preserve authored nesting without
 * mounting every default-open group or every section in a large collection.
 */
import type { NavigationGroup, NavigationNode, NavigationSection } from '@/data/docs'

/**
 * Visible rows mounted at once. Large enough that an ordinary documentation
 * sidebar (a few hundred entries) renders completely and never shows paging
 * controls, yet still a hard bound on mounted DOM for collections of thousands
 * of entries. The payload bound lives elsewhere: trees over
 * `MAX_INLINE_NAVIGATION_NODES` stream separately from the article.
 */
export const NAVIGATION_WINDOW_SIZE = 1000

export interface NavigationDisclosure {
  isOpen: boolean
  /** Closing an active ancestor applies to this route, not later descendants. */
  closedPath?: string
}

export interface NavigationRow {
  key: string
  parent?: NavigationRow
  section?: NavigationSection
  node?: NavigationNode
  isOpen?: boolean
  hasActivePath?: boolean
}

export interface NavigationWindowRow {
  row: NavigationRow
  children: Array<NavigationWindowRow>
}

/** Exact selection, including the existing home-document introduction alias. */
export function matchesNavigationPath(href: string, pathname: string): boolean {
  if (!href || /^https?:\/\//i.test(href)) return false
  const normalize = (value: string) => value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value || '/'
  return normalize(href) === normalize(pathname) || (normalize(href) === '/' && normalize(pathname) === '/introduction')
}

/** Build one visible order across sections, using one active-ancestor traversal. */
export function visibleNavigationRows(
  sections: Array<NavigationSection>,
  pathname: string,
  disclosures: Readonly<Record<string, NavigationDisclosure>>,
): { rows: Array<NavigationRow>; activeIndex: number } {
  const activeGroups = new Set<NavigationGroup>()
  function findActive(nodes: Array<NavigationNode>): boolean {
    let contains = false
    for (const node of nodes) {
      if (node.type === 'page') contains = matchesNavigationPath(node.item.href, pathname) || contains
      else if (findActive(node.group.nodes)) { activeGroups.add(node.group); contains = true }
    }
    return contains
  }
  const sectionNodes = sections.map(section => section.nodes ?? section.items.map(item => ({ type: 'page' as const, item })))
  for (const nodes of sectionNodes) findActive(nodes)
  const rows: Array<NavigationRow> = []
  let activeIndex = -1
  function append(nodes: Array<NavigationNode>, parent: NavigationRow) {
    nodes.forEach((node, index) => {
      const key = `${parent.key}/${index}`
      const row: NavigationRow = { key, parent, node }
      if (node.type === 'group') {
        row.hasActivePath = activeGroups.has(node.group)
        const disclosure = disclosures[key]
        row.isOpen = disclosure?.isOpen ?? node.group.defaultOpen === true
        if (row.hasActivePath && disclosure?.closedPath !== pathname) row.isOpen = true
      } else if (matchesNavigationPath(node.item.href, pathname) && activeIndex < 0) activeIndex = rows.length
      rows.push(row)
      if (node.type === 'group' && row.isOpen) append(node.group.nodes, row)
    })
  }
  sections.forEach((section, index) => {
    const row: NavigationRow = { key: `section/${index}`, section }
    rows.push(row)
    append(sectionNodes[index], row)
  })
  return { rows, activeIndex }
}

/**
 * Reconstruct only selected rows and their ancestors. For supported deferred
 * trees (depth <=64), at most NAVIGATION_WINDOW_SIZE + 65 rows mount: the
 * selected window plus ancestor context.
 * Small inline trees contain <=256 nodes before reaching this renderer.
 */
export function projectNavigationWindow(rows: Array<NavigationRow>, requestedStart: number, size = NAVIGATION_WINDOW_SIZE) {
  const start = Math.min(Math.max(0, requestedStart), Math.max(0, rows.length - size))
  const end = Math.min(rows.length, start + size)
  const roots: Array<NavigationWindowRow> = []
  const retained = new Map<string, NavigationWindowRow>()
  function retain(row: NavigationRow): NavigationWindowRow {
    const existing = retained.get(row.key)
    if (existing) return existing
    const projection: NavigationWindowRow = { row, children: [] }
    const siblings = row.parent ? retain(row.parent).children : roots
    siblings.push(projection)
    retained.set(row.key, projection)
    return projection
  }
  for (let index = start; index < end; index++) retain(rows[index])
  return { roots, start, end, total: rows.length, mountedRows: retained.size }
}
