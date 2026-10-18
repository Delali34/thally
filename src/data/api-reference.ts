import { cache } from 'react'
import { apiReferenceConfig } from '@/config/api-reference'
import { getSpecConfig, loadAuthoredSpecDocument, loadSpec } from '@/lib/openapi/fetch'
import { buildOperationKey, normalizeSpec } from '@/lib/openapi/normalize'
import { API_GROUPS_MAX_DEPTH, operationKeyFromRef } from '@/lib/openapi/operation-keys'
import type { DocsJsonApiGroup, NavigationGroup, NavigationItem, NavigationNode, NavigationSection, SidebarCollection } from '@/data/docs'
import type { NormalizedOperation, NormalizedSpec } from '@/lib/openapi/types'
import { findSpecForRef, type OpenApiFrontmatterRef } from '@/lib/openapi/page-frontmatter'
import { pageReferenceState } from '@/lib/openapi/publication'
import type { SupplementalSearchRecord } from '@thallylabs/core/search'

export interface ApiNavigationItem {
  id: string
  title: string
  href: string
  slug: Array<string>
  method: string
  path: string
  isWebhook: boolean
  badge?: string
}

export interface ApiNavigationGroup {
  title: string
  items: Array<ApiNavigationItem>
}

export interface ApiOperationNode {
  operation: NormalizedOperation
  slug: Array<string>
  href: string
}

function resolveSpecId(specId?: string) {
  if (!specId) {
    return apiReferenceConfig.defaultSpecId
  }
  return apiReferenceConfig.specs.some((spec) => spec.id === specId) ? specId : apiReferenceConfig.defaultSpecId
}

/**
 * Normalization is pure in (spec config, raw document), and `React.cache` does
 * not memoize outside a render (the Try It relay, route handlers), so keep the
 * result per spec. It is tied to the raw document the spec cache handed out:
 * whenever that cache serves a new document, the old result is not reused.
 */
const normalizedSpecs = new WeakMap<object, { document: unknown; spec: NormalizedSpec }>()

const getNormalizedSpec = cache(async (specId?: string): Promise<NormalizedSpec> => {
  if (apiReferenceConfig.specs.length === 0) return { operations: [], config: {} as NormalizedSpec['config'], servers: [] }
  const resolvedSpecId = resolveSpecId(specId)
  const config = getSpecConfig(apiReferenceConfig, resolvedSpecId)
  const resolved = await loadSpec(config)
  const hit = normalizedSpecs.get(config)
  if (hit && hit.document === resolved.document) return hit.spec
  const spec = normalizeSpec(resolved)
  normalizedSpecs.set(config, { document: resolved.document, spec })
  return spec
})

/** Every operation of one spec, including a page-only spec's, for frontmatter and Try It lookups. */
const getSpecOperationNodes = cache(async (specId?: string): Promise<Array<ApiOperationNode>> => {
  const spec = await getNormalizedSpec(specId)
  return spec.operations
    .filter((operation) => !operation.hidden)
    .map((operation) => {
      const slug = [operation.specId, ...(operation.slug ?? [])]
      return {
        operation,
        slug,
        href: `/api/${slug.join('/')}`,
      }
    })
})

const isPageOnlySpec = (specId?: string) =>
  apiReferenceConfig.specs.find((spec) => spec.id === resolveSpecId(specId))?.pageOnly === true

/** Operations that get their own `/api/<spec>/...` page: none for a page-only spec. */
export const getApiOperationNodes = cache(async (specId?: string): Promise<Array<ApiOperationNode>> =>
  isPageOnlySpec(specId) ? [] : getSpecOperationNodes(specId))

export const getAllApiOperationNodes = cache(async (): Promise<Array<ApiOperationNode>> => {
  const nodesPerSpec = await Promise.all(apiReferenceConfig.specs.map((spec) => getApiOperationNodes(spec.id)))
  return nodesPerSpec.flat()
})

const getEveryOperationNode = cache(async (): Promise<Array<ApiOperationNode>> =>
  (await Promise.all(apiReferenceConfig.specs.map((spec) => getSpecOperationNodes(spec.id)))).flat())

export async function getApiOperationBySlug(slugSegments?: Array<string>): Promise<ApiOperationNode | null> {
  if (!slugSegments?.length) {
    return null
  }

  const [maybeSpecId, ...rest] = slugSegments
  const specExists = apiReferenceConfig.specs.some((spec) => spec.id === maybeSpecId)

  const specId = specExists ? maybeSpecId : apiReferenceConfig.defaultSpecId
  const operationSlug = specExists ? rest : slugSegments

  const nodes = await getApiOperationNodes(specId)
  const targetSlug = operationSlug.join('/')

  return nodes.find((node) => node.slug.slice(1).join('/') === targetSlug) ?? null
}

export async function getApiOperationByKey(
  method: string,
  path: string,
  specId?: string,
): Promise<ApiOperationNode | null> {
  if (!method || !path) {
    return null
  }

  const normalizedMethod = method.toUpperCase()
  const key = buildOperationKey(normalizedMethod, path)

  if (specId) {
    const nodes = await getSpecOperationNodes(specId)
    return nodes.find((node) => node.operation.key === key) ?? null
  }

  const allNodes = await getEveryOperationNode()
  return allNodes.find((node) => node.operation.key === key) ?? null
}

export async function getApiWebhookByName(name: string, specId?: string): Promise<ApiOperationNode | null> {
  if (!name) return null
  const nodes = specId ? await getSpecOperationNodes(specId) : await getEveryOperationNode()
  return nodes.find((node) => node.operation.isWebhook && node.operation.path === name) ?? null
}

/**
 * Resolve a page's `openapi:` frontmatter. A spec prefix selects that spec
 * (unknown spec: no match). Without one the default spec is tried first, so
 * existing pages resolve exactly as before, then the remaining specs in
 * configured order; a repeat match there resolves to the first with a warning.
 */
export async function getApiOperationForFrontmatter(ref: OpenApiFrontmatterRef): Promise<ApiOperationNode | null> {
  const lookup = (specId: string) => ref.webhook
    ? getApiWebhookByName(ref.path, specId)
    : getApiOperationByKey(ref.method, ref.path, specId)
  if (ref.specRef) {
    const spec = findSpecForRef(apiReferenceConfig.specs, ref.specRef)
    return spec ? lookup(spec.id) : null
  }
  const inDefault = await lookup(ref.specId)
  if (inDefault) return inDefault
  const matches: Array<ApiOperationNode> = []
  for (const spec of apiReferenceConfig.specs) {
    if (spec.id === ref.specId) continue
    try {
      const node = await lookup(spec.id)
      if (node) matches.push(node)
    } catch {
      // A broken secondary spec must not take down a page that never named it.
    }
  }
  if (matches.length > 1) {
    console.warn(`[thally] openapi frontmatter "${ref.method} ${ref.path}" matches ${matches.length} specs; using the first. Prefix the spec file to disambiguate.`)
  }
  return matches[0] ?? null
}

/**
 * `withheld`: the operation exists but is hidden or excluded on purpose, so its
 * page is not published. `unresolved`: no spec or operation matches (a missing
 * file, a typo, a spec this build cannot read); the page keeps its authored body.
 */
export type FrontmatterOperationLookup =
  | { node: ApiOperationNode }
  | { node: null; reason: 'withheld' | 'unresolved' }

/** Like `getApiOperationForFrontmatter`, but says why nothing was found. */
export async function lookupApiOperationForFrontmatter(ref: OpenApiFrontmatterRef): Promise<FrontmatterOperationLookup> {
  const node = await getApiOperationForFrontmatter(ref)
  if (node) return { node }
  // Default spec first, as the route resolves a bare reference.
  const configs = [...apiReferenceConfig.specs].sort((a, b) => Number(b.id === apiReferenceConfig.defaultSpecId) - Number(a.id === apiReferenceConfig.defaultSpecId))
  const specs = await Promise.all(configs.map(async (config) => ({
    config,
    document: await loadAuthoredSpecDocument(config).catch(() => undefined),
  })))
  const state = pageReferenceState(ref, specs)
  return { node: null, reason: state === 'hidden' || state === 'excluded' ? 'withheld' : 'unresolved' }
}

/**
 * The public path serving the spec a page's `openapi:` resolves to, or
 * undefined. Only the default spec is published (`/openapi.yaml`, sanitised);
 * other local specs and remote URLs have no public route, and a remote URL is
 * never echoed since it may be private. Unresolvable or hidden operations
 * have none either.
 */
export async function servedSpecPathForFrontmatter(ref: OpenApiFrontmatterRef): Promise<string | undefined> {
  try {
    const node = await getApiOperationForFrontmatter(ref)
    return node?.operation.specId === apiReferenceConfig.defaultSpecId ? '/openapi.yaml' : undefined
  } catch {
    return undefined
  }
}

function toNavigationItem({ operation, slug, href }: ApiOperationNode): ApiNavigationItem {
  return {
    id: operation.id,
    title: operation.title,
    href,
    slug,
    method: operation.method,
    path: operation.path,
    isWebhook: operation.isWebhook,
    badge: operation.badge,
  }
}

export async function buildApiNavigation(specId?: string): Promise<Array<ApiNavigationGroup>> {
  if (apiReferenceConfig.specs.length === 0) return []
  const spec = await getNormalizedSpec(specId)
  const nodes = await getApiOperationNodes(spec.config.id)
  const groupMap = new Map<string, Array<ApiNavigationItem>>()

  nodes.forEach((node) => {
    const title = node.operation.group
    const items = groupMap.get(title) ?? []
    items.push(toNavigationItem(node))
    groupMap.set(title, items)
  })

  const groups = Array.from(groupMap.entries()).map<ApiNavigationGroup>(([title, items]) => ({
    title,
    items: items.sort((a, b) => a.title.localeCompare(b.title)),
  }))

  return sortNavigationGroups(groups, spec)
}

/** The sidebar entry of an operation; `groupPath` is its authored group ancestry, when it has one. */
function toSidebarItem(item: ApiNavigationItem, hrefPrefix: string, groupPath?: Array<string>): NavigationItem {
  return {
    id: item.id,
    title: item.title,
    href: `${hrefPrefix}${item.href}`,
    badge: item.badge,
    method: item.isWebhook ? 'HOOK' : item.method.toUpperCase(),
    description: `${item.method} ${item.path}`,
    ...(groupPath?.length ? { groupPath } : {}),
  }
}

/** A group of `api.groups` as the sidebar can use it. Anything else (a null, a text `pages`, a non-text `group`) is skipped. */
function isApiGroup(value: unknown): value is DocsJsonApiGroup {
  if (typeof value !== 'object' || value === null) return false
  const { group, pages } = value as { group?: unknown; pages?: unknown }
  return Array.isArray(pages) && (group === undefined || typeof group === 'string')
}

const collectItems = (nodes: Array<NavigationNode>): Array<NavigationItem> =>
  nodes.flatMap((node) => node.type === 'page' ? [node.item] : collectItems(node.group.nodes))

/**
 * Sidebar sections from a tab's authored `api.groups`: authored order, nested
 * groups kept. A key matching no published operation is skipped, a group left
 * empty disappears, and an operation listed twice shows at its first position.
 * An entry that is not a group or a key, and a group nested deeper than
 * `API_GROUPS_MAX_DEPTH`, is skipped too, and a group `icon` that is not a
 * non-empty string is dropped (`thally check` reports all three).
 */
async function buildAuthoredSections(
  groups: Array<DocsJsonApiGroup>,
  specId: string,
  hrefPrefix: string,
): Promise<Array<NavigationSection>> {
  const operations = new Map((await getApiOperationNodes(specId)).map((node) =>
    [buildOperationKey(node.operation.method, node.operation.path, node.operation.isWebhook), node] as const))
  const listed = new Set<string>()

  const buildNodes = (pages: DocsJsonApiGroup['pages'], indexPath: Array<number>, ancestors: Array<string>): Array<NavigationNode> =>
    pages.flatMap<NavigationNode>((page, index) => {
      if (typeof page !== 'string') {
        const group = isApiGroup(page) ? buildGroup(page, [...indexPath, index], ancestors) : null
        return group ? [{ type: 'group', group }] : []
      }
      const key = operationKeyFromRef(page)
      const node = key ? operations.get(key) : undefined
      if (!key || !node || listed.has(key)) return []
      listed.add(key)
      return [{ type: 'page', item: toSidebarItem(toNavigationItem(node), hrefPrefix, ancestors) }]
    })

  const buildGroup = (group: DocsJsonApiGroup, indexPath: Array<number>, ancestors: Array<string>): NavigationGroup | null => {
    if (indexPath.length > API_GROUPS_MAX_DEPTH) return null
    const nodes = buildNodes(group.pages, indexPath, [...ancestors, group.group].filter(Boolean))
    // An icon that is not a non-empty string would crash the sidebar's icon renderer: drop it, keep the group.
    const icon = typeof group.icon === 'string' && group.icon ? group.icon : undefined
    return nodes.length === 0 ? null : { id: `openapi-group-${indexPath.join('-')}`, title: group.group || 'General', icon, nodes }
  }

  return groups.flatMap((group, index) => {
    const built = isApiGroup(group) ? buildGroup(group, [index], []) : null
    return built ? [{ id: `openapi-${index}`, title: built.title, icon: built.icon, items: collectItems(built.nodes), nodes: built.nodes }] : []
  })
}

/**
 * Append generated endpoint sections to every API collection. Each collection
 * lists the operations of its own spec (the first API tab is the `default`
 * spec, later ones are keyed by collection id), so several API tabs never show
 * one another's endpoints.
 */
export async function withApiNavigation(
  collections: Array<SidebarCollection>,
  hrefPrefix = '',
): Promise<Array<SidebarCollection>> {
  return Promise.all(
    collections.map(async (collection) => {
      if (!collection.api || collection.api.navigation === false) return collection
      const authored = collection.api.groups
      const apiSections: Array<NavigationSection> = Array.isArray(authored) && authored.length > 0
        ? await buildAuthoredSections(authored, collection.id, hrefPrefix)
        : (await buildApiNavigation(collection.id)).map((group, index) => ({
          id: `openapi-${index}`,
          title: group.title,
          items: group.items.map((item) => toSidebarItem(item, hrefPrefix)),
        }))
      return { ...collection, sections: [...(collection.sections ?? []), ...apiSections] }
    }),
  )
}

/**
 * Search records for every published operation, registered with the search
 * engine as supplemental records (see `src/lib/search/register-doc-source`),
 * so ⌘K, `/api/search` and MCP `search_docs` rank operations beside pages.
 * The id is the operation's slug path — the same id docs-index and MCP use.
 */
export async function getApiOperationSearchIndex(): Promise<Array<SupplementalSearchRecord>> {
  const nodes = await getAllApiOperationNodes()
  return nodes.map((node) => {
    const { operation } = node
    const parameterNames = (['path', 'query', 'header', 'cookie'] as const)
      .flatMap((location) => operation.parameters[location].map((param) => param.name))
    return {
      id: node.slug.join('/'),
      type: 'api_operation' as const,
      title: operation.title,
      description: operation.description ?? `${operation.method} ${operation.path}`,
      href: node.href,
      keywords: operation.tags,
      // The path, group and parameter names are searchable. The HTTP method is
      // not: with fuzzy matching, "GET"/"PUT" on every operation would match
      // ordinary question words ("set", "but") and crowd out pages.
      body: [operation.path, operation.group, ...parameterNames].filter(Boolean).join(' '),
      method: operation.method,
      path: operation.path,
    }
  })
}

function sortNavigationGroups(groups: Array<ApiNavigationGroup>, spec: NormalizedSpec) {
  const order = spec.config.tagsOrder?.map((tag) => tag.toLowerCase()) ?? []
  const webhookGroup = spec.config.webhookGroup

  const weight = (title: string) => {
    const normalized = title.toLowerCase()
    const index = order.indexOf(normalized)
    if (index >= 0) {
      return index
    }
    if (webhookGroup && title === webhookGroup) {
      return order.length + 0.5
    }
    return order.length + 1
  }

  return groups.sort((a, b) => {
    const diff = weight(a.title) - weight(b.title)
    if (diff !== 0) {
      return diff
    }
    return a.title.localeCompare(b.title)
  })
}

