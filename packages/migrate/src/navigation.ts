/**
 * Navigation projection for imported sites. Mintlify's schema is intentionally
 * more expressive than Thally's tab/group model, so complex containers are
 * flattened predictably while preserving page order and nested groups.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, extname, relative } from 'node:path'

import { descendNavigationAccess, hasNavigationRules, isNavigationRestricted, navigationAccess, navigationGateReason, OPEN_NAVIGATION_ACCESS, playgroundDisplay } from './mintlify-extras.js'
import type { NavigationAccess } from './mintlify-extras.js'
import { mintlifyLocalizedReference, pageIdFromReference, resolveWithin, trimEdgeSlashes } from './path.js'
import type {
  MigrationApiGroup,
  MigrationDocsConfig,
  MigrationNavigationGroup,
  MigrationNavigationTab,
  MigrationPage,
  MigrationWarning,
} from './types.js'

interface MintlifyPageReference {
  ref: string
  navigationId: string
  locale?: string
}

const MAX_MINTLIFY_CONFIG_BYTES = 20_000_000

/**
 * One appearance of a page reference in navigation, with the access rules of
 * every container above it. Thally reads access only from page frontmatter,
 * so these are pushed down into the frontmatter of the pages they cover.
 */
export interface MintlifyReferenceAccess {
  ref: string
  access: NavigationAccess
}

export interface MintlifyNavigationResult {
  docsConfig: MigrationDocsConfig
  pageReferences: Array<MintlifyPageReference>
  /**
   * Access imposed by navigation containers, one entry per appearance of a
   * page (open appearances included, so a page listed in several places can
   * be given the strictest rule). Restricted pages stay in `docsConfig`.
   */
  referenceAccess: Array<MintlifyReferenceAccess>
  /** `sourceRef` mounts under a restricted container; never resolved, so nothing of theirs is imported. */
  gatedSourceRefs: Array<string>
  warnings: Array<MigrationWarning>
}

export interface MintlifyProjectionOptions {
  /** Public URL migrations may expose page hrefs including the docs mount path. */
  pathPrefix?: string
  /**
   * Resolves a `sourceRef` repository (`owner/repo`) to the navigation entries
   * of its imported docs, already prefixed with their mount path. Returns null
   * when the repository was not mapped with `--source-ref`.
   */
  resolveSourceRef?: (repo: string) => Array<string | MigrationNavigationGroup> | null
  /**
   * Set by a caller that binds the authored operation lists (`mintlifyNavigationApiReferences`
   * `groups`) to their API tabs. Without it every "METHOD /path" entry is reported as not carried over.
   */
  operationGroups?: boolean
}

/** Preserve Mintlify's implicit `/section` route for section landing pages. */
export function addMintlifyDirectoryRedirects(
  config: MigrationDocsConfig,
  pages: Array<MigrationPage>,
): MigrationDocsConfig {
  // Compared in lower case: a server that ignores letter case would send a visit to a page, or to an authored redirect, from an address that differs only in case.
  const pageIds = new Set(pages.map((page) => page.id.toLowerCase()))
  const redirects = [...(config.redirects ?? [])]
  const redirectSources = new Set(redirects.map((redirect) => (redirect.source.replace(/\/$/, '') || '/').toLowerCase()))
  function hasAuthoredRedirect(source: string): boolean {
    const route = source.toLowerCase()
    if (redirectSources.has(route)) return true
    return (config.redirects ?? []).some((redirect) => {
      // A trailing catch-all also owns its empty suffix. Do not insert an
      // exact alias that competes with that authored directory behavior.
      const match = redirect.source.toLowerCase().match(/^(.*)\/:[a-z_][a-z0-9_]*\*\/?$/)
      return match ? route === match[1] || route.startsWith(`${match[1]}/`) : false
    })
  }
  for (const page of pages) {
    if (!/\/(?:overview|introduction)$/.test(page.navigationId)) continue
    const parent = page.id.replace(/\/(?:overview|introduction)$/, '')
    if (!parent || pageIds.has(parent.toLowerCase())) continue
    const source = `/${parent}`
    if (hasAuthoredRedirect(source)) continue
    redirects.push({ source, destination: `/${page.id}`, permanent: false })
    redirectSources.add(source.toLowerCase())
  }

  const navigationOrder: Array<string> = []
  function collectPages(nodes: Array<string | MigrationNavigationGroup>): void {
    for (const node of nodes) {
      if (typeof node === 'string') navigationOrder.push(node)
      else if (!node.hidden) collectPages(node.pages)
    }
  }
  for (const tab of config.tabs) {
    if (!tab.hidden) collectPages([...(tab.pages ?? []), ...(tab.groups ?? [])])
  }
  const pagesByNavigationId = new Map<string, Array<MigrationPage>>()
  for (const page of pages) {
    if (page.hidden) continue
    const variants = pagesByNavigationId.get(page.navigationId) ?? []
    variants.push(page)
    pagesByNavigationId.set(page.navigationId, variants)
  }
  const firstDescendantByDirectory = new Map<string, MigrationPage>()
  for (const navigationId of navigationOrder) {
    for (const page of pagesByNavigationId.get(navigationId) ?? []) {
      const segments = page.id.split('/')
      for (let length = 1; length < segments.length; length++) {
        const directory = segments.slice(0, length).join('/')
        if (!firstDescendantByDirectory.has(directory)) firstDescendantByDirectory.set(directory, page)
      }
    }
  }
  // Mintlify 307s *any* nav-shaped directory path with no page of its own to
  // its first descendant page in navigation order — not only ones an
  // overview/introduction page or an authored redirect already pointed at
  // (e.g. a `product`/`tab`/`group` container path like Upstash's `/redis`,
  // or a plain mid-tree directory like `/vector/sdks/py/example_calls`).
  // `firstDescendantByDirectory` already holds every such directory (built
  // from real page ids in navigation order above), so redirect all of them
  // in one pass; `hasAuthoredRedirect` skips any directory the overview/
  // introduction pass above, or the project's own `redirects:`, already
  // covers, and `pageIds.has(directory)` never overrides a real page.
  for (const [directory, landing] of firstDescendantByDirectory) {
    if (pageIds.has(directory.toLowerCase())) continue
    const source = `/${directory}`
    if (hasAuthoredRedirect(source)) continue
    // Match full stored ids, not locale-independent navigation ids: a French
    // directory must never be redirected to an English descendant.
    redirects.push({ source, destination: `/${landing.id}`, permanent: false })
    redirectSources.add(source.toLowerCase())
  }
  return redirects.length > 0 ? { ...config, redirects } : config
}

/**
 * Keep authored page URLs while resolving bare documentation roots to the
 * first visible navigation page. An unrelated `home.mdx` is not evidence that
 * Mintlify served it at `/`; explicit source redirects always take priority.
 */
export function addMintlifyHomepageRedirects(
  config: MigrationDocsConfig,
  pages: Array<MigrationPage>,
): MigrationDocsConfig {
  const defaultPages = new Set(pages
    .filter((page) => !page.locale || page.locale === config.i18n?.defaultLocale)
    .map((page) => page.navigationId))
  function firstPage(nodes: Array<string | MigrationNavigationGroup>): string | undefined {
    for (const node of nodes) {
      if (typeof node === 'string') {
        if (defaultPages.has(node)) return node
      } else if (!node.hidden) {
        const page = firstPage(node.pages)
        if (page) return page
      }
    }
  }
  const homepage = config.tabs.filter((tab) => !tab.hidden)
    .map((tab) => firstPage([...(tab.pages ?? []), ...(tab.groups ?? [])]))
    .find(Boolean)
  // Mintlify sends `/` to the first page even when that page is `introduction`, so the
  // renderer's root alias for it is not served and links, canonicals and the sitemap agree on one URL.
  if (!homepage) return config
  const redirects = [...(config.redirects ?? [])]
  const sources = new Set(redirects.map((redirect) => (redirect.source.replace(/\/$/, '') || '/').toLowerCase()))
  const roots = ['', ...(config.i18n?.locales ?? [])
    .filter((locale) => locale.code !== config.i18n?.defaultLocale)
    .filter((locale) => homepage !== 'introduction' || pages.some((page) => page.locale === locale.code && page.navigationId === homepage))
    .map((locale) => locale.code)]
  for (const locale of roots) {
    const source = locale ? `/${locale}` : '/'
    if (sources.has(source.toLowerCase())) continue
    redirects.push({ source, destination: `${locale ? `/${locale}` : ''}/${homepage}`, permanent: true })
  }
  return { ...config, redirects }
}

/** Native names, as Mintlify's language picker shows them. */
const LANGUAGE_LABELS: Record<string, string> = {
  ar: 'العربية',
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  'pt-BR': 'Português (BR)',
  ru: 'Русский',
  tr: 'Türkçe',
  uk: 'Українська',
  zh: '简体中文',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Some Mintlify sites (e.g. Upstash's docs.json) group `products` under an
 * extra `productGroups: [{ group, products }]` wrapper instead of a bare
 * `products` array directly on the tab. Flatten it into `products` so the
 * existing container handling picks the products up unchanged — otherwise
 * every page and `openapi`/`asyncapi` reference under it is silently
 * invisible to navigation projection and API-spec resolution alike.
 */
function withFlattenedProductGroups(container: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(container.productGroups)) return container
  const flattened = (container.productGroups as Array<unknown>).flatMap((entry) => {
    const group = objectValue(entry)
    return group && Array.isArray(group.products) ? group.products : []
  })
  if (flattened.length === 0) return container
  return {
    ...container,
    products: [...(Array.isArray(container.products) ? container.products : []), ...flattened],
  }
}

function projectedHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const href = value.trim()
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return undefined
  if (/^(?:javascript|data|vbscript|file):/i.test(href)) return undefined
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase()
  if (scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme)) return undefined
  return href
}

function labelFor(value: Record<string, unknown>, fallback: string): string {
  for (const key of ['tab', 'group', 'anchor', 'product', 'dropdown', 'version', 'menu', 'item', 'label', 'name', 'title']) {
    if (typeof value[key] === 'string' && value[key]) return String(value[key])
  }
  return fallback
}

function localReference(value: string): string {
  return value.split('#', 1)[0]
}

function jsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer || pointer === '#') return root
  const tokens = pointer.replace(/^#\/?/, '').split('/').filter(Boolean)
  return tokens.reduce<unknown>((current, token) => {
    if (Array.isArray(current)) {
      const index = Number(token)
      return Number.isSafeInteger(index) && index >= 0 ? current[index] : undefined
    }
    const object = objectValue(current)
    if (!object) return undefined
    return object[token.replace(/~1/g, '/').replace(/~0/g, '~')]
  }, root)
}

function readMintlifyJson(path: string, repositoryRoot: string): unknown {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`Mintlify config reference is not a regular file: ${relative(repositoryRoot, path)}`)
  }
  const realPath = realpathSync(path)
  const realRoot = realpathSync(repositoryRoot)
  resolveWithin(realRoot, relative(realRoot, realPath))
  if (lstatSync(realPath).size > MAX_MINTLIFY_CONFIG_BYTES) {
    throw new Error(`Mintlify config reference exceeded ${MAX_MINTLIFY_CONFIG_BYTES / 1_000_000} MB: ${relative(repositoryRoot, path)}`)
  }
  return JSON.parse(readFileSync(realPath, 'utf8')) as unknown
}

function resolveJsonReferences(
  value: unknown,
  currentFile: string,
  repositoryRoot: string,
  stack: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveJsonReferences(entry, currentFile, repositoryRoot, stack))
  }
  const object = objectValue(value)
  if (!object) return value
  if (typeof object.$ref === 'string') {
    const [filePart, pointer = ''] = object.$ref.split('#', 2)
    const referencedFile = filePart
      ? resolveWithin(dirname(currentFile), filePart)
      : currentFile
    const relativePath = relative(repositoryRoot, referencedFile)
    resolveWithin(repositoryRoot, relativePath)
    const stackKey = `${referencedFile}#${pointer}`
    if (stack.has(stackKey)) throw new Error(`Circular Mintlify $ref: ${object.$ref}`)
    stack.add(stackKey)
    const referencedRoot = readMintlifyJson(referencedFile, repositoryRoot)
    const referenced = jsonPointer(referencedRoot, pointer ? `#${pointer}` : '')
    const resolved = resolveJsonReferences(referenced, referencedFile, repositoryRoot, stack)
    stack.delete(stackKey)
    const siblings = Object.fromEntries(
      Object.entries(object)
        .filter(([key]) => key !== '$ref')
        .map(([key, entry]) => [
          key,
          resolveJsonReferences(entry, currentFile, repositoryRoot, stack),
        ]),
    )
    // Mintlify merges sibling keys over object-valued references. Retaining
    // this behavior matters for split navigation files that override one
    // label, link, or visibility flag at the reference site.
    return objectValue(resolved) ? { ...resolved as Record<string, unknown>, ...siblings } : resolved
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [
      key,
      resolveJsonReferences(entry, currentFile, repositoryRoot, stack),
    ]),
  )
}

/** Read `docs.json`/`mint.json`, including bounded local JSON references. */
export function readMintlifyConfig(repositoryRoot: string): Record<string, unknown> | null {
  const configPath = ['docs.json', 'mint.json']
    .map((filename) => resolveWithin(repositoryRoot, filename))
    .find(existsSync)
  if (!configPath) return null
  const raw = readMintlifyJson(configPath, repositoryRoot)
  return resolveJsonReferences(raw, configPath, repositoryRoot, new Set()) as Record<string, unknown>
}

/** One `openapi`/`asyncapi` value found anywhere in Mintlify's navigation tree. */
export interface MintlifyApiSpecReference {
  /** The field's raw value: a repository-relative path, or an `http(s)://` URL. */
  value: string
  kind: 'openapi' | 'asyncapi'
  /** Label of the tab the resolved spec binds to (created if the source tab was dropped). Undefined at the navigation root. */
  tabLabel?: string
  /** Set when `tabLabel` is a per-item sibling tab (`<Tab>: <Item>`): the tab it should be placed after. */
  parentTab?: string
  /** Menu-item presentation carried onto its sibling tab. */
  icon?: string
  hidden?: boolean
  /** Mintlify's `{ source, directory }` output folder, which Thally does not use (endpoints live under `/api/`). */
  directory?: string
  /** `METHOD /path` operations the navigation under this reference lists, in authored order; absent when it lists none. */
  operations?: Array<string>
  /** The authored group tree of those operations (nesting and order kept); absent when it lists none, or when every one is hidden, under access rules or nested too deep. */
  groups?: Array<MigrationApiGroup>
  /**
   * The container lists operations, but every one is hidden or under access rules (or the container sits under a hidden group): no groups, yet not a container
   * that lists nothing. Operations dropped only for nesting too deep are not withheld: that is Thally's limit, not the author's intent, so such a container counts as listing nothing.
   */
  operationsWithheld?: boolean
  /** The container sits under a language other than the default: the default language's navigation owns the root tab, so it contributes no groups and decides nothing. */
  otherLanguage?: boolean
}

/** `openapi`/`asyncapi` is a path/URL string, or Mintlify's `{ source, directory }` object. */
function specSource(value: unknown): string | undefined {
  const source = typeof value === 'string' ? value : objectValue(value)?.source
  return typeof source === 'string' && source.trim() ? source.trim() : undefined
}

/**
 * The operations a navigation container lists by name ("POST /users"), in
 * authored order. A nested container that binds a spec of its own lists that
 * spec's operations, not this one's.
 */
function listedOperations(container: Record<string, unknown>): Array<string> {
  const operations: Array<string> = []
  const visit = (entry: unknown, depth: number): void => {
    if (typeof entry === 'string') {
      if (OPENAPI_OPERATION_REF.test(entry)) operations.push(entry.trim())
      return
    }
    const object = objectValue(entry)
    if (!object || depth > SWEEP_DEPTH_LIMIT || (depth > 0 && (specSource(object.openapi) || specSource(object.asyncapi)))) return
    for (const key of ['groups', 'pages'] as const) {
      if (Array.isArray(object[key])) (object[key] as Array<unknown>).forEach((child) => visit(child, depth + 1))
    }
  }
  visit(container, 0)
  return operations
}

/** Whether a navigation container binds an OpenAPI/AsyncAPI spec of its own. */
const bindsSpec = (node: Record<string, unknown>): boolean => Boolean(specSource(node.openapi) || specSource(node.asyncapi))

/** A navigation object `operationGroups` reads as a group: it names itself or lists `pages`. */
const hasGroupShape = (node: Record<string, unknown>): boolean => 'group' in node || Array.isArray(node.pages)

/**
 * How many levels of nested groups an API tab's `api.groups` may have: the renderer skips a group nested deeper.
 * Mirrors `API_GROUPS_MAX_DEPTH` in src/lib/openapi/operation-keys.ts, which this package cannot import; a test keeps the two equal.
 */
export const API_GROUPS_MAX_DEPTH = 32

/** An operation entry as the renderer matches it: trimmed, one space after the method. */
const operationKey = (entry: string): string => entry.trim().replace(/^(\S+)\s+/, '$1 ')

/**
 * The group tree of the operations a binding container lists, in authored
 * order. A container that is itself a group is the tree's only root; any other
 * container contributes its `groups` and `pages` in authored order (operations
 * listed straight under it form a group named after the container, since an
 * API group needs a title: each uninterrupted run of them is its own group, at
 * the run's position, so a group authored before them stays before them). Page entries are not part of the tree, and neither are
 * groups that end up empty, hidden groups (Mintlify keeps them out of the
 * sidebar), access-restricted groups, groups nested deeper than
 * `maxLevel` levels (the renderer would skip them), or a nested
 * container that binds a spec of its own (it lists that spec's operations).
 */
function operationGroups(container: Record<string, unknown>, maxLevel = API_GROUPS_MAX_DEPTH): Array<MigrationApiGroup> {
  // `level` is the nesting level of the groups `node` holds: 1 for a tree's outermost groups.
  const entries = (node: Record<string, unknown>, level: number): Array<string | MigrationApiGroup> =>
    (['groups', 'pages'] as const).flatMap((key) => (Array.isArray(node[key]) ? node[key] as Array<unknown> : []).flatMap<string | MigrationApiGroup>((entry) => {
      if (typeof entry === 'string') return OPENAPI_OPERATION_REF.test(entry) ? [operationKey(entry)] : []
      const object = objectValue(entry)
      const group = object && !bindsSpec(object) ? groupOf(object, level + 1) : undefined
      return group ? [group] : []
    }))
  const groupOf = (node: Record<string, unknown>, level: number): MigrationApiGroup | undefined => {
    if (level > maxLevel || node.hidden === true || navigationGateReason(node)) return undefined
    if (!hasGroupShape(node)) return undefined
    const pages = entries(node, level)
    const icon = iconName(node.icon)
    return pages.length > 0 ? { group: labelFor(node, 'Documentation'), ...(icon ? { icon } : {}), pages } : undefined
  }
  if (typeof container.group === 'string') {
    const group = groupOf(container, 1)
    return group ? [group] : []
  }
  const label = labelFor(container, 'API reference')
  const groups: Array<MigrationApiGroup> = []
  let run: Array<string> | undefined
  for (const entry of entries(container, 0)) {
    if (typeof entry !== 'string') {
      groups.push(entry)
      run = undefined
    } else if (run) {
      run.push(entry)
    } else {
      run = [entry]
      groups.push({ group: label, pages: run })
    }
  }
  return groups
}

/** Every operation key of a group tree, nested groups included. */
const groupOperationKeys = (groups: ReadonlyArray<MigrationApiGroup>): Array<string> =>
  groups.flatMap(({ pages }) => pages.flatMap((page) => typeof page === 'string' ? [page] : groupOperationKeys([page])))

/**
 * Append the groups of another reference bound to the same tab: authored order
 * is kept, an operation already listed earlier (method case-insensitive, path
 * exact) is dropped, and a group left empty disappears.
 */
export function mergeApiGroups(
  existing: ReadonlyArray<MigrationApiGroup> | undefined,
  incoming: ReadonlyArray<MigrationApiGroup> | undefined,
): Array<MigrationApiGroup> | undefined {
  const identity = (key: string): string => key.replace(/^(\S+)/, (method) => method.toLowerCase())
  const seen = new Set(groupOperationKeys(existing ?? []).map(identity))
  const unseen = (groups: ReadonlyArray<MigrationApiGroup>): Array<MigrationApiGroup> => groups.flatMap((group) => {
    const pages = group.pages.flatMap<string | MigrationApiGroup>((page) => {
      if (typeof page !== 'string') return unseen([page])
      if (seen.has(identity(page))) return []
      seen.add(identity(page))
      return [page]
    })
    return pages.length > 0 ? [{ ...group, pages }] : []
  })
  const merged = [...(existing ?? []), ...unseen(incoming ?? [])]
  return merged.length > 0 ? merged : undefined
}

const hasNavigationChildren = (node: Record<string, unknown>): boolean =>
  ['groups', 'pages'].some((key) => Array.isArray(node[key]) && (node[key] as Array<unknown>).length > 0)

/**
 * Mintlify lets `openapi`/`asyncapi` appear not just at the top-level `api`
 * key but on any navigation container (most commonly a tab:
 * `navigation.tabs[].openapi`, but the same field is honored on an anchor,
 * dropdown, product, version or group too) — Mintlify binds the resulting
 * API reference to whichever tab that container renders under. This walks
 * the whole raw navigation tree (the same shape `convertContainerToTabs`
 * projects) collecting every occurrence, so the caller can resolve and bind
 * each one instead of only ever seeing the single top-level `api` field.
 *
 * A tab `menu` item with `openapi` cannot become a group (Thally groups hold
 * pages, and the generated endpoints live in an API-bound tab). It becomes a
 * sibling tab `<Tab>: <Item>` bound to its own spec, or binds to the tab
 * itself when it is the tab's only content.
 */
export function mintlifyNavigationApiReferences(config: Record<string, unknown>): Array<MintlifyApiSpecReference> {
  const navigation = objectValue(config.navigation) ?? config
  const references: Array<MintlifyApiSpecReference> = []
  // The language the projection treats as the default, found by the same rule.
  const defaultLanguage = pickDefaultLanguage(
    (Array.isArray(navigation.languages) ? navigation.languages : []).flatMap((value) => {
      const language = objectValue(value)
      return language && withLanguageCode(language) ? [language] : []
    }),
  )
  const containerKeys = ['tabs', 'anchors', 'products', 'dropdowns', 'versions', 'menus', 'languages'] as const
  const nestedKeys = ['groups', 'pages'] as const

  // `gated` is set under a container with access rules: its operations stay out of the authored API groups, as they stay out of the kept operations.
  // `otherLanguage` is set under a language other than the default: the default language's navigation owns the root tab.
  // `hidden` is set under a `hidden` group (a hidden tab or menu item only leaves the tab bar, its sidebar stays): whatever binds a spec there is hidden with it.
  function collect(node: Record<string, unknown>, tabLabel: string | undefined, gated: boolean, otherLanguage: boolean, hidden: boolean, sibling?: Pick<MintlifyApiSpecReference, 'parentTab' | 'icon' | 'hidden'>): void {
    for (const kind of ['openapi', 'asyncapi'] as const) {
      const value = specSource(node[kind])
      const directory = objectValue(node[kind])?.directory
      if (value) {
        const listed = listedOperations(node)
        const operations = typeof directory === 'string' && directory.trim() ? listed : []
        const groups = gated || otherLanguage || hidden ? [] : operationGroups(node)
        // Judged from the raw entries, hidden and restricted ones included: a binding whose operations are all withheld still lists operations.
        // Under a hidden group, even a binding that lists none is withheld: Mintlify hides the operations it generates there too.
        // Entries dropped only for nesting too deep are Thally's limit, not the author's choice: with no hidden or restricted entry beside them
        // (every listed entry is in the tree when the depth limit is lifted), the binding counts as listing nothing.
        const tooDeepOnly = groups.length === 0 && listed.length > 0 && !gated && !hidden
          && groupOperationKeys(operationGroups(node, SWEEP_DEPTH_LIMIT)).length === listed.length
        const operationsWithheld = !otherLanguage && (hidden || (groups.length === 0 && listed.length > 0 && !tooDeepOnly))
        references.push({
          value, kind, tabLabel, ...sibling,
          ...(typeof directory === 'string' && directory.trim() ? { directory: directory.trim() } : {}),
          ...(operations.length > 0 ? { operations } : {}),
          ...(groups.length > 0 ? { groups } : {}),
          ...(operationsWithheld ? { operationsWithheld: true } : {}),
          ...(otherLanguage ? { otherLanguage: true } : {}),
        })
      }
    }
  }

  // Two menu items can share a label (the same item name under two versions):
  // keep both tabs instead of letting the later spec replace the earlier one.
  const siblingSources = new Map<string, string>()
  function uniqueSiblingLabel(label: string, source: string): string {
    let candidate = label
    for (let n = 2; siblingSources.has(candidate) && siblingSources.get(candidate) !== source; n++) candidate = `${label} (${n})`
    siblingSources.set(candidate, source)
    return candidate
  }

  function visitChildren(rawNode: Record<string, unknown>, tabLabel: string | undefined, gated: boolean, otherLanguage: boolean, hidden: boolean): void {
    const node = withFlattenedProductGroups(rawNode)
    for (const key of containerKeys) {
      const entries = node[key]
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const object = objectValue(entry)
        if (!object) continue
        // A nested container becomes the new binding tab only at the outer
        // level (Mintlify tabs aren't themselves nested inside other tabs in
        // practice, but anchors/dropdowns can sit inside a tab) — reuse the
        // enclosing tab's label unless this container names its own.
        visit(object, labelFor(object, tabLabel ?? 'Documentation'), gated, otherLanguage || (key === 'languages' && rawNode === navigation && object !== defaultLanguage), hidden)
      }
    }
    for (const key of nestedKeys) {
      const entries = node[key]
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (typeof entry === 'string') continue
        const object = objectValue(entry)
        if (object) visit(object, tabLabel, gated, otherLanguage, hidden || object.hidden === true)
      }
    }
    if (Array.isArray(node.menu)) {
      const tab = tabLabel ?? 'Documentation'
      const items = node.menu.flatMap((entry): Array<Record<string, unknown>> => {
        const object = objectValue(entry)
        return object ? [object] : []
      })
      const apiItems = items.filter((item) => specSource(item.openapi) || specSource(item.asyncapi))
      const soleContent = apiItems.length === 1 && !hasNavigationChildren(node) && !items.some(hasNavigationChildren)
      items.forEach((item, index) => {
        const itemGated = gated || Boolean(navigationGateReason(item))
        if (soleContent && apiItems[0] === item) collect(item, tab, itemGated, otherLanguage, hidden)
        else if (apiItems.includes(item)) {
          const label = uniqueSiblingLabel(
            `${tab}: ${labelFor(item, `Menu item ${index + 1}`)}`,
            `${specSource(item.openapi) ?? ''}|${specSource(item.asyncapi) ?? ''}`,
          )
          const icon = iconName(item.icon)
          collect(item, label, itemGated, otherLanguage, hidden, { parentTab: tab, ...(icon ? { icon } : {}), ...(item.hidden === true ? { hidden: true } : {}) })
        }
        visitChildren(item, tabLabel, itemGated, otherLanguage, hidden)
      })
    }
  }

  function visit(node: Record<string, unknown>, tabLabel: string | undefined, outerGated: boolean, otherLanguage: boolean, hidden: boolean): void {
    const gated = outerGated || Boolean(navigationGateReason(node))
    collect(node, tabLabel, gated, otherLanguage, hidden)
    visitChildren(node, tabLabel, gated, otherLanguage, hidden)
  }
  visit(navigation, undefined, false, false, false)
  return references
}

/** Add an API-bound tab, right after `parentTab` (and its earlier per-item siblings) when given, else at the end. */
export function insertApiTab<T extends { tab: string }>(tabs: Array<T>, tab: T, parentTab?: string): Array<T> {
  let index = -1
  if (parentTab) {
    tabs.forEach((candidate, position) => {
      if (candidate.tab === parentTab || candidate.tab.startsWith(`${parentTab}: `)) index = position
    })
  }
  tabs.splice(index === -1 ? tabs.length : index + 1, 0, tab)
  return tabs
}

function normalizePageRef(value: string, pathPrefix = ''): string | null {
  if (/^(?:https?:)?\/\//i.test(value) || value.startsWith('#')) return null
  let ref = localReference(value).split('?', 1)[0].replace(/^\/+/, '')
  const prefix = trimEdgeSlashes(pathPrefix)
  if (prefix && (ref === prefix || ref.startsWith(`${prefix}/`))) {
    ref = ref === prefix ? 'introduction' : ref.slice(prefix.length + 1)
  }
  ref = ref.replace(/\.(?:mdx?|rst|txt)$/i, '')
  // Mintlify routes are case-sensitive and commonly use camelCase filenames
  // (for example `additionalFiles`). Lowercasing here breaks both authored
  // navigation and links even though the source site resolves them correctly.
  return pageIdFromReference(ref, true)
}

interface ProjectionContext {
  locale?: string
  defaultPageIds?: ReadonlySet<string>
  pathPrefix?: string
  resolveSourceRef?: MintlifyProjectionOptions['resolveSourceRef']
  references: Array<MintlifyPageReference>
  seenReferences: Set<string>
  warnings: Array<MigrationWarning>
  warningKeys: Set<string>
  appearances: Array<MintlifyReferenceAccess>
  /** Access accumulated from the containers above the node being walked. */
  access: NavigationAccess
  /** Where an operation entry ("GET /users") under the node being walked goes. */
  operations: OperationScope
  /** The caller binds authored operation lists, so the entries under a bound container are migrated, not reported. */
  operationGroups: boolean
  /** Set while walking a language other than the default: its operation lists are not bound, as the default language's tab owns them. */
  otherLanguage?: boolean
  gatedSourceRefs: Array<string>
  /** `sourceRef` nodes found under any restricted container, whichever container kind holds them. */
  gatedNodes: Map<object, string>
  /** Set when the navigation nests deeper than the access sweeps can follow; every mount and page is then withheld. */
  limits: { tooDeep: boolean }
  /** Label of the nearest enclosing navigation group, for warnings. */
  groupLabel?: string
}

/**
 * Where operation entries under a navigation node go: `bound` when a container
 * above them (reached through `groups`/`pages` only, as the reference collector
 * walks) binds a spec, so `mintlifyNavigationApiReferences` lists them in that
 * tab's API groups, unless `gated` access rules withhold them. A `hidden` ancestor
 * withholds them quietly (the author's intent), and a `level` past
 * `API_GROUPS_MAX_DEPTH` is reported. Both walks use these rules, so an entry is
 * either migrated or warned about, never both or neither (hidden counts as migrated).
 */
interface OperationScope {
  bound: boolean
  gated: boolean
  /** Under a `hidden` group, as `mintlifyNavigationApiReferences` sees it: the author hid these operations. */
  hidden: boolean
  /** Groups between the binding container and the node, the container itself counted when it is a group: how deep its operations nest in `api.groups`. */
  level: number
}

const UNBOUND_OPERATIONS: OperationScope = { bound: false, gated: false, hidden: false, level: 0 }

/** A container reached through a container key (`tabs`, `menu`, ...) starts over; a group or page inherits its parent's binding. */
function descendOperationScope(scope: OperationScope, node: Record<string, unknown>, nested: boolean): OperationScope {
  const binds = bindsSpec(node)
  return {
    bound: (!nested && scope.bound) || binds,
    gated: scope.gated || Boolean(navigationGateReason(node)),
    hidden: scope.hidden || (!nested && node.hidden === true),
    // A container that binds a spec roots a tree of its own, where it is the first level when it is a group (as `operationGroups` reads it).
    level: binds ? (typeof node.group === 'string' ? 1 : 0) : !nested && scope.bound && hasGroupShape(node) ? scope.level + 1 : scope.level,
  }
}

/** How deep the access sweeps follow the navigation; anything deeper is withheld rather than guessed at. */
const SWEEP_DEPTH_LIMIT = 256

/**
 * Container-agnostic sweep for `sourceRef` mounts under a restricted node of any kind, so a container
 * the projection does not special-case can never publish a mount. Runs before conversion.
 */
function collectGatedSourceRefs(node: unknown, gate: string | undefined, out: Map<object, string>, limits: { tooDeep: boolean }, depth = 0): void {
  if (depth > SWEEP_DEPTH_LIMIT) {
    limits.tooDeep = true
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectGatedSourceRefs(item, gate, out, limits, depth + 1)
    return
  }
  const object = objectValue(node)
  if (!object) return
  const reason = gate ?? navigationGateReason(object)
  if (reason && typeof object.sourceRef === 'string') out.set(object, reason)
  for (const value of Object.values(object)) collectGatedSourceRefs(value, reason, out, limits, depth + 1)
}

/**
 * Container-agnostic sweep for pages under a node that sets access rules. The
 * projection only walks container kinds it understands; a page under any
 * other one (a tab's `menu` items, say) would otherwise migrate without the
 * rules of the container that restricted it. Open appearances are left to the
 * projection, so a stray `href` elsewhere in the config never counts as one.
 */
function collectReferenceAccess(
  node: unknown,
  access: NavigationAccess,
  pathPrefix: string | undefined,
  out: Array<MintlifyReferenceAccess>,
  depth = 0,
): void {
  if (depth > SWEEP_DEPTH_LIMIT) return
  if (Array.isArray(node)) {
    for (const item of node) collectReferenceAccess(item, access, pathPrefix, out, depth + 1)
    return
  }
  const object = objectValue(node)
  if (!object) return
  const nested = descendNavigationAccess(access, navigationAccess(object))
  if (hasNavigationRules(nested)) {
    // `href` names a page too (`{ href: '/secret' }` under a group); external
    // links never normalize to a page reference.
    const refs = [object.page, object.root, object.href, ...(Array.isArray(object.pages) ? object.pages : [])]
    for (const ref of refs) {
      if (typeof ref === 'string' && normalizePageRef(ref, pathPrefix)) out.push({ ref, access: nested })
    }
  }
  for (const value of Object.values(object)) collectReferenceAccess(value, nested, pathPrefix, out, depth + 1)
}

/** Walk `walk` one container deeper, restoring the outer access afterwards. */
function withContainerAccess<T>(object: Record<string, unknown>, context: ProjectionContext, walk: () => T, nested = false): T {
  const outer = context.access
  context.access = descendNavigationAccess(outer, navigationAccess(object))
  try {
    return withOperationScope(object, context, nested, walk)
  } finally {
    context.access = outer
  }
}

/** Walk `walk` with the operation scope of `object`, restoring the outer scope afterwards. */
function withOperationScope<T>(object: Record<string, unknown>, context: ProjectionContext, nested: boolean, walk: () => T): T {
  const outer = context.operations
  context.operations = descendOperationScope(outer, object, nested)
  try {
    return walk()
  } finally {
    context.operations = outer
  }
}

function warnOnce(context: ProjectionContext, key: string, message: string): void {
  if (context.warningKeys.has(key)) return
  context.warningKeys.add(key)
  context.warnings.push({ code: 'unsupported-config', message })
}

function iconName(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  const icon = objectValue(value)
  return typeof icon?.name === 'string' && icon.name ? icon.name : undefined
}

function containerPresentation(value: Record<string, unknown>): {
  description?: string
  icon?: string
} {
  return {
    ...(typeof value.description === 'string' && value.description.trim()
      ? { description: value.description.trim() }
      : {}),
    ...(iconName(value.icon) ? { icon: iconName(value.icon) } : {}),
  }
}

function registerReference(value: string, context: ProjectionContext): string | null {
  if (context.limits.tooDeep) {
    // Access rules cannot be checked reliably: the page fails closed
    // (quarantined) and leaves the navigation.
    const problem = 'its navigation is too deeply nested to check access rules'
    if (normalizePageRef(value, context.pathPrefix)) context.appearances.push({ ref: value, access: { ...context.access, problem } })
    return null
  }
  // Every appearance is recorded, open ones included: a page listed under a
  // restricted and an open container gets the strictest rule, never the open one.
  if (normalizePageRef(value, context.pathPrefix)) context.appearances.push({ ref: value, access: context.access })
  const localizedValue = context.locale
    ? mintlifyLocalizedReference(value, context.locale, context.defaultPageIds)
    : value
  const navigationId = normalizePageRef(localizedValue, context.pathPrefix)
  if (!navigationId) return null
  const key = `${context.locale ?? ''}:${value}`
  if (!context.seenReferences.has(key)) {
    context.seenReferences.add(key)
    context.references.push({ ref: value, navigationId, locale: context.locale })
  }
  return navigationId
}

/**
 * Mintlify lets a `pages` entry name a single OpenAPI operation directly
 * (`"GET /users"`) to hand-pick or reorder which operations of an
 * already-`openapi`-scoped ancestor appear, instead of a page file
 * reference. These are not pages: under a container that binds a spec they
 * become that tab's `api.groups` (see `operationGroups`); anywhere else they
 * are dropped with one warning, not a "did not resolve to a source page"
 * warning per operation.
 */
const OPENAPI_OPERATION_REF = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S/

function convertPage(
  value: unknown,
  context: ProjectionContext,
): string | MigrationNavigationGroup | null {
  if (typeof value === 'string') {
    if (OPENAPI_OPERATION_REF.test(value)) {
      const { bound, gated, hidden, level } = context.operations
      if (!context.operationGroups || !bound) {
        warnOnce(
          context,
          'openapi-operation-list',
          'Navigation lists individual OpenAPI operations (e.g. "GET /users") that were not added to the API navigation: '
            + 'an operation list is carried over only from a tab or group that names an openapi spec in a migrated docs.json. '
            + 'The operations themselves still have pages in the API reference.',
        )
      } else if (gated) {
        warnOnce(
          context,
          'openapi-operation-list-gated',
          'Navigation lists individual OpenAPI operations (e.g. "GET /users") under access-restricted groups, '
            + 'so they were not added to the API navigation. The operations themselves still have pages in the API reference.',
        )
      } else if (context.otherLanguage) {
        warnOnce(
          context,
          'openapi-operation-list-language',
          'Navigation lists individual OpenAPI operations (e.g. "GET /users") under a language other than the default, '
            + 'so they were not added to the API navigation: the API tab follows the default language. '
            + 'The operations themselves still have pages in the API reference.',
        )
      } else if (!hidden && level > API_GROUPS_MAX_DEPTH) {
        warnOnce(
          context,
          'openapi-operation-list-depth',
          `Navigation lists individual OpenAPI operations (e.g. "GET /users") in groups nested more than ${API_GROUPS_MAX_DEPTH} levels deep, `
            + 'so they were not added to the API navigation: the API navigation follows no deeper groups. '
            + 'The operations themselves still have pages in the API reference.',
        )
      }
      return null
    }
    return registerReference(value, context)
  }
  const object = objectValue(value)
  if (!object) return null
  return withContainerAccess(object, context, () => convertPageObject(object, context))
}

/** A `sourceRef` mount under a restricted container is never resolved, so its pages, images and components stay out of the output. */
function gatedSourceRef(repo: string, context: ProjectionContext): null {
  if (!context.gatedSourceRefs.includes(repo)) context.gatedSourceRefs.push(repo)
  warnOnce(
    context,
    `source-ref-gated:${repo}`,
    `Navigation mounts the docs of the repository ${repo} (sourceRef) inside a restricted container. `
      + 'This restricted mount was left out of the navigation. To publish it, make the container public in docs.json, '
      + 'or mount the repository under a public section.',
  )
  return null
}

function convertPageObject(
  object: Record<string, unknown>,
  context: ProjectionContext,
): string | MigrationNavigationGroup | null {
  if (typeof object.page === 'string') return registerReference(object.page, context)
  const href = projectedHref(object.href)
  if (href && !object.pages && !object.groups) {
    const page = registerReference(href, context)
    if (page) return page
    warnOnce(
      context,
      'external-page-link',
      'External links nested inside a Mintlify sidebar cannot be represented as Thally pages and were omitted.',
    )
    return null
  }
  if (typeof object.sourceRef === 'string') {
    // `context.access` already includes this node's own rules (convertPage descends first).
    if (isNavigationRestricted(context.access) || context.gatedNodes.has(object) || context.limits.tooDeep) return gatedSourceRef(object.sourceRef, context)
    const imported = context.resolveSourceRef?.(object.sourceRef)
    // Directly inside a group the entries are spliced into it (see below);
    // anywhere else they get a group named after the repository.
    if (imported) return { group: object.sourceRef.split('/').pop() ?? object.sourceRef, pages: imported }
    const where = context.groupLabel ? `the "${context.groupLabel}" navigation group` : 'the navigation'
    warnOnce(
      context,
      `source-ref:${context.groupLabel ?? ''}:${object.sourceRef}`,
      `Navigation in ${where} mounts the docs of the repository ${object.sourceRef} (sourceRef). `
        + `Those pages were not migrated; pass --source-ref ${object.sourceRef}=<path> to import them.`,
    )
    return null
  }
  const pages = Array.isArray(object.pages) ? object.pages : []
  if ('group' in object || pages.length > 0) {
    const children: Array<string | MigrationNavigationGroup> = []
    const outerGroupLabel = context.groupLabel
    context.groupLabel = labelFor(object, 'Documentation')
    if (typeof object.root === 'string') {
      const root = registerReference(object.root, context)
      if (root) children.push(root)
    }
    try {
      for (const page of pages) {
        const pageObject = objectValue(page)
        const sourceRef = pageObject?.sourceRef
        // A restricted mount (its own rules or an enclosing container's) falls through to convertPage, which withholds it.
        const imported = typeof sourceRef === 'string' && !isNavigationRestricted(context.access) && !navigationGateReason(pageObject!) && !context.gatedNodes.has(pageObject!) && !context.limits.tooDeep
          ? context.resolveSourceRef?.(sourceRef)
          : null
        if (imported) {
          children.push(...imported)
          continue
        }
        const converted = convertPage(page, context)
        if (converted) children.push(converted)
      }
    } finally {
      context.groupLabel = outerGroupLabel
    }
    if (children.length === 0) return null
    return {
      group: labelFor(object, 'Documentation'),
      ...(iconName(object.icon) ? { icon: iconName(object.icon) } : {}),
      ...(object.hidden === true ? { hidden: true } : {}),
      pages: children,
    }
  }
  return null
}

const KNOWN_NAVIGATION_KEYS = new Set([
  'tabs', 'anchors', 'products', 'dropdowns', 'versions', 'menus', 'languages', 'productGroups',
  'groups', 'pages', 'menu', 'global',
])

/** A Mintlify tab `menu`: each item becomes a top-level group of the enclosing tab. */
function convertMenuItems(
  items: Array<unknown>,
  context: ProjectionContext,
): Array<MigrationNavigationGroup> {
  return items.flatMap((value, index) => {
    const item = objectValue(value)
    if (!item) return []
    const label = labelFor(item, `Menu item ${index + 1}`)
    if (typeof item.description === 'string' && item.description.trim()) {
      warnOnce(
        context,
        `menu-item-description:${label}`,
        `Mintlify menu item "${label}" has a description, which Thally groups cannot display; it was omitted.`,
      )
    }
    const hasUnsourcedSpec = Boolean(item.openapi || item.asyncapi) && !specSource(item.openapi) && !specSource(item.asyncapi)
    if (hasUnsourcedSpec) {
      warnOnce(
        context,
        `menu-item-spec:${label}`,
        `Mintlify menu item "${label}" has an openapi/asyncapi value without a "source", so its API reference was not migrated.`,
      )
    }
    const children = withOperationScope(item, context, true, () => convertNavigationValues([
      ...(Array.isArray(item.groups) ? item.groups : []),
      ...(Array.isArray(item.pages) ? item.pages : []),
    ], context))
    if (typeof item.href === 'string' && item.href) {
      warnOnce(
        context,
        `menu-item-href:${label}`,
        `Mintlify menu item "${label}" links to ${item.href}, which cannot be represented as a Thally group; the link was omitted.`,
      )
    }
    if (children.length === 0) {
      if (!specSource(item.openapi) && !specSource(item.asyncapi) && !hasUnsourcedSpec) {
        warnOnce(context, `menu-item-empty:${label}`, `Mintlify menu item "${label}" has no projectable pages and was omitted.`)
      }
      return []
    }
    return [{
      group: label,
      ...(iconName(item.icon) ? { icon: iconName(item.icon) } : {}),
      ...(item.hidden === true ? { hidden: true } : {}),
      pages: children,
    }]
  })
}

function convertNavigationValues(
  values: Array<unknown>,
  context: ProjectionContext,
): Array<string | MigrationNavigationGroup> {
  return values.flatMap<string | MigrationNavigationGroup>((value) => {
    const page = convertPage(value, context)
    return page ? [page] : []
  })
}

interface NavigationProjectionTrace {
  rootContainerKind?: 'tabs' | 'anchors' | 'products' | 'dropdowns' | 'versions' | 'menus'
}

function convertContainerToTabs(
  containerValue: unknown,
  context: ProjectionContext,
  fallbackTab: string,
  trace?: NavigationProjectionTrace,
  depth = 0,
): Array<MigrationNavigationTab> {
  const rawContainer = objectValue(containerValue)
  if (!rawContainer) return []
  const container = withFlattenedProductGroups(rawContainer)
  const containerKeys = ['tabs', 'anchors', 'products', 'dropdowns', 'versions', 'menus'] as const
  for (const key of Object.keys(container)) {
    if (KNOWN_NAVIGATION_KEYS.has(key)) continue
    const entries = container[key]
    if (Array.isArray(entries) && entries.some((entry) => objectValue(entry))) {
      warnOnce(context, `unknown-container:${key}`, `Mintlify navigation key "${key}" is not supported and its contents were not projected.`)
    }
  }
  for (const key of containerKeys) {
    if (!Array.isArray(container[key])) continue
    const entries = [...container[key] as Array<unknown>]
    if (key === 'versions') {
      entries.sort((left, right) => Number(objectValue(right)?.default === true) - Number(objectValue(left)?.default === true))
    }
    const tabs = entries.flatMap((value, index) => {
      const object = objectValue(value)
      if (!object) return []
      const tab = labelFor(object, `${fallbackTab} ${index + 1}`)
      const href = projectedHref(object.href)
      const hasNestedContainers = [...containerKeys, 'menu'].some((containerKey) => Array.isArray(object[containerKey]))
      if (href && !object.pages && !object.groups && !hasNestedContainers) {
        return [{
          tab,
          href,
          ...containerPresentation(object),
          ...(object.hidden === true ? { hidden: true } : {}),
        }]
      }
      const nested = withContainerAccess(object, context, () => convertContainerToTabs(object, context, tab, trace, depth + 1), true)
      if (nested.length > 0) {
        if (nested.length === 1) {
          return [{
            ...nested[0],
            tab,
            ...containerPresentation(object),
            ...(href ? { href } : {}),
            ...(object.hidden === true ? { hidden: true } : {}),
          }]
        }
        const presentation = containerPresentation(object)
        return nested.map((item, childIndex) => ({
          ...presentation,
          ...item,
          tab: `${tab}: ${item.tab}`,
          ...(childIndex === 0 && href && !item.href ? { href } : {}),
          ...(object.hidden === true ? { hidden: true } : {}),
        }))
      }
      return []
    })
    if (tabs.length > 0) {
      for (const sibling of ['groups', 'pages', 'menu'] as const) {
        if (Array.isArray(container[sibling]) && (container[sibling] as Array<unknown>).length > 0) {
          warnOnce(context, `container-sibling:${key}:${sibling}`, `Mintlify "${sibling}" next to "${key}" was not projected; only the "${key}" containers were kept.`)
        }
      }
      if (depth === 0 && trace) trace.rootContainerKind = key
      return tabs
    }
  }
  const rawGroups = Array.isArray(container.groups) ? container.groups : []
  const rawPages = Array.isArray(container.pages) ? container.pages : []
  const hasRootNodes = typeof container.root === 'string' || rawPages.length > 0
  const values = [
    ...(typeof container.root === 'string' ? [container.root] : []),
    ...rawGroups,
    ...rawPages,
  ]
  const children = [
    ...convertNavigationValues(values, context),
    ...(Array.isArray(container.menu) ? convertMenuItems(container.menu, context) : []),
  ]
  return children.length > 0
    ? [{
        tab: fallbackTab,
        ...(hasRootNodes
          ? { pages: children }
          : { groups: children as Array<MigrationNavigationGroup> }),
        ...containerPresentation(container),
        ...(projectedHref(container.href) ? { href: projectedHref(container.href) } : {}),
        ...(container.hidden === true ? { hidden: true } : {}),
      }]
    : []
}

function projectedTheme(value: unknown): MigrationDocsConfig['theme'] {
  // Aspen rounds its sidebar highlight (12px) and search box like Maple, not like Sharp's 3px corners.
  if (value === 'maple' || value === 'aspen') return 'maple'
  if (['luma', 'sequoia'].includes(String(value))) return 'sharp'
  if (['almond', 'palm'].includes(String(value))) return 'minimal'
  return typeof value === 'string' ? 'default' : undefined
}

/**
 * Mintlify `colors`: `primary` is the brand colour in light mode, `light` the
 * one used in dark mode and `dark` the button fill. Three-digit hex is
 * expanded because the renderer only accepts six digits.
 */
function projectedColors(value: unknown, warnings: Array<MigrationWarning>): MigrationDocsConfig['colors'] {
  const colors = objectValue(value)
  if (!colors) {
    if (value !== undefined) warnings.push({ code: 'unsupported-config', message: 'colors is not an object with a primary hex colour and was dropped.', source: 'docs.json' })
    return undefined
  }
  const hex = (entry: unknown, key: string): string | undefined => {
    const match = typeof entry === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(entry.trim()) : null
    if (!match) {
      if (entry !== undefined) warnings.push({ code: 'unsupported-config', message: `colors.${key} ${JSON.stringify(entry)} is not a 3- or 6-digit hex colour (for example #16a34a) and was dropped.`, source: 'docs.json' })
      return undefined
    }
    const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1]
    return `#${digits.toLowerCase()}`
  }
  const primary = hex(colors.primary, 'primary')
  const light = hex(colors.light, 'light') ?? primary
  const dark = hex(colors.dark, 'dark') ?? primary
  if (!primary) {
    if (colors.primary === undefined) warnings.push({ code: 'unsupported-config', message: 'colors has no primary hex colour, so none of its colours were migrated.', source: 'docs.json' })
    return undefined
  }
  return { light: { accent: primary, primary: dark ?? primary }, dark: { accent: light ?? primary, primary: light ?? primary } }
}

function projectedNavbar(value: unknown): MigrationDocsConfig['navbar'] {
  const navbar = objectValue(value)
  if (!navbar) return undefined
  const links = Array.isArray(navbar.links)
    ? navbar.links.flatMap((entry) => {
        const link = objectValue(entry)
        const href = projectedHref(link?.href)
        if (!link || !href) return []
        const label = typeof link.label === 'string' ? link.label : typeof link.name === 'string' ? link.name : ''
        if (!label) return []
        return [{ label, href, ...(link.type === 'github' ? { type: 'github' as const } : {}) }]
      })
    : []
  const primaryValue = objectValue(navbar.primary)
  const primaryHref = projectedHref(primaryValue?.href)
  const primary = primaryValue && primaryHref
    ? {
        label: typeof primaryValue.label === 'string'
          ? primaryValue.label
          : primaryValue.type === 'github' ? 'GitHub' : 'Get started',
        href: primaryHref,
        ...(primaryValue.type === 'github' ? { type: 'github' as const } : {}),
      }
    : undefined
  return links.length > 0 || primary ? { ...(links.length > 0 ? { links } : {}), ...(primary ? { primary } : {}) } : undefined
}

/**
 * Legacy mint.json `topbarLinks` (`{ name, url }`) and `topbarCtaButton`
 * (`{ name, url }` or `{ type: 'github', url }`), reshaped as docs.json
 * `navbar` so both sources share `projectedNavbar`.
 */
function legacyTopbarNavbar(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const links = Array.isArray(config.topbarLinks)
    ? config.topbarLinks.flatMap((entry) => {
        const link = objectValue(entry)
        if (!link) return []
        return [{
          label: link.name ?? link.label ?? (link.type === 'github' ? 'GitHub' : undefined),
          href: link.url ?? link.href,
          ...(link.type === 'github' ? { type: 'github' } : {}),
        }]
      })
    : []
  const cta = objectValue(config.topbarCtaButton)
  const primary = cta ? { label: cta.name ?? cta.label, href: cta.url ?? cta.href, type: cta.type } : undefined
  return links.length > 0 || primary ? { ...(links.length > 0 ? { links } : {}), ...(primary ? { primary } : {}) } : undefined
}

function projectedGlobalNavigationLinks(
  value: unknown,
): NonNullable<NonNullable<MigrationDocsConfig['navbar']>['links']> {
  const global = objectValue(value)
  if (!global) return []
  const links: Array<{ label: string; href: string }> = []
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit)
      return
    }
    const item = objectValue(entry)
    if (!item) return
    const href = projectedHref(item.href)
    if (href) {
      const label = labelFor(item, '')
      if (label) links.push({ label, href })
    }
    for (const key of ['tabs', 'anchors', 'dropdowns', 'products', 'versions', 'languages', 'menus', 'menu']) {
      if (Array.isArray(item[key])) visit(item[key])
    }
  }
  visit(global)
  return links
}

function projectedFooter(value: unknown): MigrationDocsConfig['footer'] {
  const footer = objectValue(value)
  if (!footer) return undefined
  const socials = objectValue(footer.socials)
  const socialLinks = socials
    ? Object.fromEntries(Object.entries(socials).flatMap(([key, value]) => {
        const href = projectedHref(value)
        return href ? [[key, href]] : []
      }))
    : undefined
  const links = Array.isArray(footer.links)
    ? footer.links.flatMap((entry) => {
        const column = objectValue(entry)
        if (!column || !Array.isArray(column.items)) return []
        const heading = typeof column.heading === 'string'
          ? column.heading
          : typeof column.header === 'string' ? column.header : ''
        const items = column.items.flatMap((item) => {
          const link = objectValue(item)
          const href = projectedHref(link?.href)
          return link && typeof link.label === 'string' && href
            ? [{ label: link.label, href }]
            : []
        })
        return heading && items.length > 0 ? [{ heading, items }] : []
      })
    : []
  return (socialLinks && Object.keys(socialLinks).length > 0) || links.length > 0
    ? { ...(socialLinks && Object.keys(socialLinks).length > 0 ? { socials: socialLinks } : {}), ...(links.length > 0 ? { links } : {}) }
    : undefined
}

function projectedFont(value: unknown): { family: string; weight?: Array<string> } | undefined {
  if (typeof value === 'string' && value) return { family: value }
  const font = objectValue(value)
  if (!font) return undefined
  const family = typeof font.family === 'string'
    ? font.family
    : typeof font.name === 'string' ? font.name : undefined
  if (!family) return undefined
  const weight = Array.isArray(font.weight)
    ? font.weight.map(String)
    : Array.isArray(font.weights) ? font.weights.map(String) : undefined
  return { family, ...(weight && weight.length > 0 ? { weight } : {}) }
}

function projectedCompatibleConfig(config: Record<string, unknown>, warnings: Array<MigrationWarning>): Omit<MigrationDocsConfig, 'tabs' | 'i18n' | 'redirects'> {
  const banner = objectValue(config.banner)
  const bannerContent = banner && (typeof banner.content === 'string' || objectValue(banner.content))
    ? banner.content as string | Record<string, string>
    : undefined
  const bannerType = banner && ['info', 'warning', 'critical'].includes(String(banner.type ?? banner.variant))
    ? String(banner.type ?? banner.variant) as 'info' | 'warning' | 'critical'
    : undefined
  const bannerColor = objectValue(banner?.color)
  const bodyFont = projectedFont(objectValue(config.fonts)?.body ?? config.fonts)
  const headingFont = projectedFont(objectValue(config.fonts)?.heading)
  const feedback = objectValue(config.feedback)
  const seo = objectValue(config.seo)
  const contextualOptions = Array.isArray(objectValue(config.contextual)?.options) ? objectValue(config.contextual)!.options as Array<unknown> : []
  const projectedContextual = contextualOptions.filter((option): option is string => typeof option === 'string' && ['copy', 'view', 'chatgpt', 'claude', 'perplexity'].includes(option))
  const droppedContextual = contextualOptions.filter((option) => !projectedContextual.includes(option as string))
  if (droppedContextual.length > 0) {
    warnings.push({ code: 'unsupported-config', message: `contextual.options entries not supported by the page menu were dropped: ${droppedContextual.map((option) => typeof option === 'string' ? option : 'custom entry').join(', ')}.`, source: 'docs.json' })
  }
  const rawMetatags = Object.entries(objectValue(seo?.metatags) ?? {})
  // Same rules as the renderer's `validMetatags`: a plain name, a short string value, and no http-equiv directive.
  const httpEquivNames = new Set(['refresh', 'set-cookie', 'location', 'content-security-policy', 'content-security-policy-report-only', 'content-type', 'default-style', 'x-ua-compatible'])
  const validMetatag = (entry: [string, unknown]): entry is [string, string] => /^[\w:.-]+$/.test(entry[0])
    && !entry[0].toLowerCase().startsWith('http-equiv') && !httpEquivNames.has(entry[0].toLowerCase())
    && typeof entry[1] === 'string' && entry[1].length <= 1000 && ![...entry[1]].some((character) => character.charCodeAt(0) < 32)
  const metatagEntries = rawMetatags.filter(validMetatag)
  const droppedMetatags = rawMetatags.filter((entry) => !validMetatag(entry)).map(([key]) => key)
  if (droppedMetatags.length > 0) {
    warnings.push({ code: 'unsupported-config', message: `seo.metatags entries were dropped because the name is not a plain meta name, is an http-equiv directive, or the value is not a string of at most 1000 characters: ${droppedMetatags.join(', ')}.`, source: 'docs.json' })
  }
  const projectedMetatags = metatagEntries.length > 0 ? Object.fromEntries(metatagEntries) : undefined
  const projectedColorsValue = projectedColors(config.colors, warnings)
  const iconLibrary = objectValue(config.icons)?.library
  // Mintlify's default icon library is Font Awesome when docs.json names none.
  const projectedIconLibrary = iconLibrary === undefined
    ? 'fontawesome'
    : ['lucide', 'fontawesome', 'tabler'].includes(String(iconLibrary))
      ? String(iconLibrary) as 'lucide' | 'fontawesome' | 'tabler'
      : undefined
  const docsNavbar = projectedNavbar(config.navbar)
  const legacyRaw = legacyTopbarNavbar(config)
  const legacyNavbar = projectedNavbar(legacyRaw)
  const legacyLinkCount = Array.isArray(legacyRaw?.links) ? legacyRaw.links.length : 0
  if (legacyNavbar?.links && legacyNavbar.links.length < legacyLinkCount) {
    warnings.push({ code: 'unsupported-config', message: `${legacyLinkCount - legacyNavbar.links.length} mint.json topbarLinks entr${legacyLinkCount - legacyNavbar.links.length === 1 ? 'y' : 'ies'} without a valid name and url were skipped.` })
  }
  if (docsNavbar?.links && legacyNavbar?.links) {
    warnings.push({ code: 'unsupported-config', message: 'Both docs.json navbar.links and mint.json topbarLinks are set; the docs.json navbar.links were used and topbarLinks ignored.' })
  }
  if (docsNavbar?.primary && legacyNavbar?.primary) {
    warnings.push({ code: 'unsupported-config', message: 'Both docs.json navbar.primary and mint.json topbarCtaButton are set; navbar.primary was used and topbarCtaButton ignored.' })
  }
  if (legacyRaw?.primary && !legacyNavbar?.primary) {
    warnings.push({ code: 'unsupported-config', message: 'mint.json topbarCtaButton has no valid url and was skipped.' })
  }
  const navbar = docsNavbar || legacyNavbar
    ? {
        ...(docsNavbar?.links ?? legacyNavbar?.links ? { links: docsNavbar?.links ?? legacyNavbar?.links } : {}),
        ...(docsNavbar?.primary ?? legacyNavbar?.primary ? { primary: docsNavbar?.primary ?? legacyNavbar?.primary } : {}),
      }
    : undefined
  const globalLinks = projectedGlobalNavigationLinks(objectValue(config.navigation)?.global)
  const navbarLinks = [...new Map(
    [...(navbar?.links ?? []), ...globalLinks].map((link) => [`${link.label}:${link.href}`, link]),
  ).values()]
  const projectedNavigation = navbarLinks.length > 0 || navbar?.primary
    ? { ...(navbarLinks.length > 0 ? { links: navbarLinks } : {}), ...(navbar?.primary ? { primary: navbar.primary } : {}) }
    : undefined
  return {
    // Mintlify pages show a group eyebrow above the title and no breadcrumb trail.
    breadcrumbs: false,
    // `styling.eyebrows: "breadcrumbs"` shows the whole group path; "section" (the default) shows the nearest group.
    ...(objectValue(config.styling)?.eyebrows === 'breadcrumbs' ? { eyebrow: 'path' as const } : {}),
    ...(projectedTheme(config.theme) ? { theme: projectedTheme(config.theme) } : {}),
    ...(projectedContextual.length > 0 ? { contextual: { options: projectedContextual } } : {}),
    ...(projectedColorsValue ? { colors: projectedColorsValue } : {}),
    ...(projectedIconLibrary ? { icons: { library: projectedIconLibrary } } : {}),
    ...(bannerContent ? {
      banner: {
        content: bannerContent,
        ...(banner?.dismissible === false ? { dismissible: false } : {}),
        ...(typeof banner?.id === 'string' ? { id: banner.id } : {}),
        ...(typeof banner?.revision === 'string' ? { revision: banner.revision } : {}),
        ...(bannerType ? { type: bannerType } : {}),
        ...(bannerColor ? { color: {
          ...(typeof bannerColor.light === 'string' ? { light: bannerColor.light } : {}),
          ...(typeof bannerColor.dark === 'string' ? { dark: bannerColor.dark } : {}),
        } } : {}),
      },
    } : {}),
    ...(projectedNavigation ? { navbar: projectedNavigation } : {}),
    ...(projectedFooter(config.footer) ? { footer: projectedFooter(config.footer) } : {}),
    ...(bodyFont || headingFont ? { fonts: { ...(bodyFont ? { body: bodyFont } : {}), ...(headingFont ? { heading: headingFont } : {}) } } : {}),
    // Mintlify titles pages "<title> - <site name>" unless `og:title` overrides them,
    // and its sitemap lists navigation pages only.
    seo: { ...(seo?.indexing === 'all' ? { indexing: 'all' as const } : {}), titleSeparator: ' - ', sitemap: 'navigable', ...(projectedMetatags ? { metatags: projectedMetatags } : {}) },
    ...(typeof feedback?.thumbsRating === 'boolean' ? { feedback: { thumbsRating: feedback.thumbsRating } } : {}),
  }
}

/**
 * Mintlify's `api.mdx.server` / `api.mdx.auth` (defaults for manual `api:`
 * pages). Only well-formed values are kept; each dropped one is reported.
 */
function projectedApi(config: Record<string, unknown>, warnings: Array<MigrationWarning>): Pick<MigrationDocsConfig, 'api'> {
  const mdx = projectedApiMdx(config, warnings).api?.mdx
  const raw = objectValue(objectValue(config.api)?.playground)?.display
  const display = raw === undefined ? undefined : playgroundDisplay(raw, 'api.playground.display', (message) => warnings.push({ code: 'unsupported-config', message }))
  if (!mdx && !display) return {}
  return { api: { ...(mdx ? { mdx } : {}), ...(display ? { playground: { display } } : {}) } }
}

function projectedApiMdx(config: Record<string, unknown>, warnings: Array<MigrationWarning>): Pick<MigrationDocsConfig, 'api'> {
  const mdx = objectValue(objectValue(config.api)?.mdx)
  if (!mdx) return {}
  const warn = (message: string) => warnings.push({ code: 'unsupported-config', message })
  const rawServers = mdx.server === undefined ? [] : Array.isArray(mdx.server) ? mdx.server : [mdx.server]
  const servers = rawServers.filter((entry): entry is string => {
    const valid = typeof entry === 'string' && /^https?:\/\/[^\s/@?#]+(?:\/[^\s?#]*)?$/i.test(entry.trim())
    if (!valid) warn(`api.mdx.server entry ${JSON.stringify(entry)} is not an absolute http(s) URL and was dropped.`)
    return valid
  }).map((entry) => entry.trim())
  const auth = objectValue(mdx.auth)
  const method = typeof auth?.method === 'string' ? auth.method.toLowerCase() : undefined
  const name = typeof auth?.name === 'string' && auth.name.trim() ? auth.name.trim() : undefined
  let projectedAuth: { method: 'bearer' | 'basic' | 'key'; name?: string } | undefined
  if (mdx.auth !== undefined && auth && method !== undefined) {
    if (method === 'bearer' || method === 'basic' || (method === 'key' && name)) {
      projectedAuth = { method, ...(name ? { name } : {}) }
    } else {
      warn(`api.mdx.auth method ${JSON.stringify(auth.method)} is not supported (bearer, basic, or key with a name) and was dropped.`)
    }
  } else if (mdx.auth !== undefined && !auth) {
    warn('api.mdx.auth is not an object and was dropped.')
  }
  if (servers.length === 0 && !projectedAuth) return {}
  return {
    api: {
      mdx: {
        ...(servers.length > 0 ? { server: servers.length === 1 && typeof mdx.server === 'string' ? servers[0] : servers } : {}),
        ...(projectedAuth ? { auth: projectedAuth } : {}),
      },
    },
  }
}

const NEXT_REDIRECT_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Next.js redirects compile through path-to-regexp and reject a bare `*`
 * segment (Mintlify and Fern's trailing wildcard syntax) with "Invalid
 * redirects found", crashing the whole build. Both platforms only document
 * `*` as a trailing catch-all segment, so it is translated to Next's named
 * catch-all (`/:path*`) here; a `*` anywhere else, or a syntax Next can't
 * express, is dropped rather than guessed at. Source text already written as
 * path-to-regexp (e.g. `:path*`) passes through unchanged: only a literal
 * `*` segment is rewritten, and the final `isValidNextRedirectPath` check
 * still accepts it.
 */
function translateRedirectWildcards(
  source: string,
  destination: string,
): { source: string; destination: string } | null {
  const sourceSegments = source.split('/')
  const destinationSegments = destination.split('/')
  const sourceWildcardIndex = sourceSegments.indexOf('*')
  if (sourceWildcardIndex !== -1 && sourceWildcardIndex !== sourceSegments.length - 1) return null
  if (sourceSegments.slice(0, -1).includes('*') || destinationSegments.slice(0, -1).includes('*')) return null

  const translatedSource = [...sourceSegments]
  if (sourceWildcardIndex !== -1) translatedSource[sourceWildcardIndex] = ':path*'

  const destinationHasWildcard = destinationSegments.at(-1) === '*'
  if (destinationHasWildcard && sourceWildcardIndex === -1) return null
  const translatedDestination = [...destinationSegments]
  if (destinationHasWildcard) translatedDestination[translatedDestination.length - 1] = ':path*'

  const finalSource = translatedSource.join('/')
  const finalDestination = translatedDestination.join('/')
  if (!isValidNextRedirectPath(finalSource) || !isValidNextRedirectPath(finalDestination)) return null
  return { source: finalSource, destination: finalDestination }
}

/** Conservative structural check for the path-to-regexp syntax Next.js redirects accept. */
function isValidNextRedirectPath(path: string): boolean {
  return path.split('/').every((segment) => {
    if (segment === '' || segment === '*') return segment === ''
    if (!segment.startsWith(':')) return !segment.includes('*') && !segment.includes(':')
    const name = segment.endsWith('*') ? segment.slice(1, -1) : segment.slice(1)
    return NEXT_REDIRECT_PARAM_NAME.test(name)
  })
}

/**
 * Shared redirect-safety check for Mintlify and Fern: both require a
 * site-relative, `/`-rooted source and destination (Mintlify's own redirect
 * docs give only rooted examples; neither documents an absolute-URL
 * destination), so a protocol-relative or absolute value (`//evil.example`
 * reads as same-scheme cross-origin to a browser and to Next.js) is rejected.
 */
// Matches every ASCII control character (incl. DEL, \x7f) and every Unicode
// whitespace character (`\s` already covers the line/paragraph separators
// U+2028/U+2029, along with tab, CR, LF, NBSP, etc).
const UNSAFE_REDIRECT_CHARS = /[\s\x00-\x1f\x7f]/

export function isRedirectPathSafe(rawSource: string, rawDestination: string): boolean {
  for (const value of [rawSource, rawDestination]) {
    if (!value.startsWith('/')) return false
    if (value.startsWith('//') || value.startsWith('/\\')) return false
    if (value.includes('\\')) return false
    // A browser strips whitespace/control characters (tab, CR, LF, ...) from
    // a URL before navigating, so a literal tab in `/\t/evil.example` passes
    // every check above yet reaches the browser as `//evil.example`. Reject
    // any such character anywhere in the raw value.
    if (UNSAFE_REDIRECT_CHARS.test(value)) return false
    // Browsers unescape a leading `%2f%2f`/`%5c` before treating it as `//`/`\`.
    const lower = value.toLowerCase()
    if (lower.startsWith('/%2f%2f') || lower.startsWith('/%5c')) return false
  }
  return true
}

/**
 * Translate a redirect's trailing wildcard for Next.js, once its source and
 * destination have already passed {@link isRedirectPathSafe}.
 */
export { translateRedirectWildcards }

/**
 * Mintlify's `versions` container authors every version's own page paths
 * with the version identifier as a literal leading segment (`v1.15.22/en/
 * introduction`), including the default version's — the live site still
 * serves that path, but also serves the same page with the segment
 * dropped (`/en/introduction` 307s to the versioned URL). Thally has no
 * multi-version content model of its own (each version becomes its own
 * tab, per existing behavior), so an in-repo link authored the second way
 * has nothing to resolve to. Collecting each `versions` container's
 * default identifier lets the repository scanner add a matching redirect
 * alongside the one it already adds for a page's literal source path.
 */
export function mintlifyDefaultVersionPrefixes(config: Record<string, unknown>): Set<string> {
  const navigation = objectValue(config.navigation) ?? config
  const prefixes = new Set<string>()
  function collect(container: Record<string, unknown>): void {
    if (Array.isArray(container.versions)) {
      const entries = container.versions
        .map((value) => objectValue(value))
        .filter((value): value is Record<string, unknown> => value !== null)
      const defaultEntry = entries.find((entry) => entry.default === true) ?? entries[0]
      if (defaultEntry && typeof defaultEntry.version === 'string' && defaultEntry.version.trim()) {
        prefixes.add(defaultEntry.version.trim())
      }
    }
    if (Array.isArray(container.languages)) {
      for (const value of container.languages) {
        const language = objectValue(value)
        if (language) collect(language)
      }
    }
  }
  collect(navigation)
  return prefixes
}

/**
 * Every version identifier declared across all `versions` containers (not
 * just the default one) — used to label which versions' pages were dropped
 * when a repository exceeds the source-file discovery budget.
 */
export function mintlifyAllVersionPrefixes(config: Record<string, unknown>): Set<string> {
  const navigation = objectValue(config.navigation) ?? config
  const prefixes = new Set<string>()
  function collect(container: Record<string, unknown>): void {
    if (Array.isArray(container.versions)) {
      for (const value of container.versions) {
        const entry = objectValue(value)
        if (entry && typeof entry.version === 'string' && entry.version.trim()) prefixes.add(entry.version.trim())
      }
    }
    if (Array.isArray(container.languages)) {
      for (const value of container.languages) {
        const language = objectValue(value)
        if (language) collect(language)
      }
    }
  }
  collect(navigation)
  return prefixes
}

/** A navigation language with its locale code canonicalized; undefined when the code is invalid, which is how the projection skips an entry. */
function withLanguageCode(language: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    return { ...language, language: Intl.getCanonicalLocales(String(language.language ?? language.locale ?? 'en'))[0] }
  } catch {
    return undefined
  }
}

/** The default language: the entry marked `default`, else the first. Shared by the projection and the API reference collector, so both agree on which language owns the root tabs. */
function pickDefaultLanguage<T extends Record<string, unknown>>(languages: ReadonlyArray<T>): T | undefined {
  return languages.find((entry) => entry.default === true) ?? languages[0]
}

/** Convert current and legacy Mintlify navigation into Thally's schema. */
export function projectMintlifyNavigation(
  config: Record<string, unknown>,
  options: MintlifyProjectionOptions = {},
): MintlifyNavigationResult {
  const warnings: Array<MigrationWarning> = []
  const references: Array<MintlifyPageReference> = []
  const seenReferences = new Set<string>()
  const warningKeys = new Set<string>()
  const appearances: Array<MintlifyReferenceAccess> = []
  const gatedSourceRefs: Array<string> = []
  const gatedNodes = new Map<object, string>()
  const navigation = objectValue(config.navigation) ?? config
  // Rules on the navigation root itself (and on a language, below) cover
  // every page under it, as the container-agnostic sweep sees them too.
  const rootAccess = descendNavigationAccess(OPEN_NAVIGATION_ACCESS, navigationAccess(navigation))
  const rootOperations = descendOperationScope(UNBOUND_OPERATIONS, navigation, true)
  const operationGroups = options.operationGroups === true
  const limits = { tooDeep: false }
  collectGatedSourceRefs(navigation, undefined, gatedNodes, limits)
  if (limits.tooDeep) {
    warnings.push({
      code: 'unsupported-config',
      message: 'The navigation is too deeply nested to check its access rules, so no pages or sourceRef mounts were published from it. Flatten the navigation nesting in docs.json.',
    })
  }
  const languages = Array.isArray(navigation.languages)
    ? navigation.languages.flatMap((value): Array<Record<string, unknown>> => {
        const language = objectValue(value)
        if (!language) return []
        const withCode = withLanguageCode(language)
        if (!withCode) warnings.push({ code: 'unsupported-config', message: 'A navigation language with an invalid locale code was skipped.' })
        return withCode ? [withCode] : []
      })
    : []
  const defaultLanguage = pickDefaultLanguage(languages)
  let tabs: Array<MigrationNavigationTab> = []
  let i18n: MigrationDocsConfig['i18n']
  const localizedNavigation: Record<string, Array<MigrationNavigationTab>> = {}
  const projectionTrace: NavigationProjectionTrace = {}

  if (defaultLanguage) {
    const defaultLocale = String(defaultLanguage.language)
    const locales = languages.map((entry) => {
      const code = String(entry.language)
      let label: string | undefined = LANGUAGE_LABELS[code]
      try {
        label ??= new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? undefined
      } catch {
        // Unknown extension tags remain readable as their normalized code.
      }
      return { code, label: label ?? code.toUpperCase() }
    })
    i18n = { defaultLocale, locales }
    const defaultPageIds = new Set<string>()
    // The default language supplies canonical page identities even when it
    // appears after translations in the authored language picker.
    for (const language of [defaultLanguage, ...languages.filter((entry) => entry !== defaultLanguage)]) {
      const locale = String(language.language)
      const context: ProjectionContext = {
        locale,
        defaultPageIds,
        pathPrefix: options.pathPrefix,
        resolveSourceRef: options.resolveSourceRef,
        references,
        seenReferences,
        warnings,
        warningKeys,
        appearances,
        access: descendNavigationAccess(rootAccess, navigationAccess(language)),
        operations: descendOperationScope(rootOperations, language, true),
        operationGroups,
        otherLanguage: language !== defaultLanguage,
        gatedSourceRefs,
        gatedNodes,
        limits,
      }
      const languageTabs = convertContainerToTabs(
        language,
        context,
        'Documentation',
        language === defaultLanguage ? projectionTrace : undefined,
      )
      if (language === defaultLanguage) {
        tabs = languageTabs
        for (const reference of references) defaultPageIds.add(reference.navigationId)
      } else if (languageTabs.length > 0) {
        localizedNavigation[locale] = languageTabs
      }
    }
    if (Object.keys(localizedNavigation).length > 0) i18n.navigation = localizedNavigation
  } else {
    const context: ProjectionContext = { references, seenReferences, warnings, warningKeys, appearances, access: rootAccess, operations: rootOperations, operationGroups, gatedSourceRefs, gatedNodes, limits, pathPrefix: options.pathPrefix, resolveSourceRef: options.resolveSourceRef }
    tabs = convertContainerToTabs(navigation, context, 'Documentation', projectionTrace)
    if (tabs.length === 0 && Array.isArray(config.navigation)) {
      // A bare list of groups (mint.json): the reference collector does not walk it, so no container binds the operations in it.
      context.operations = UNBOUND_OPERATIONS
      const children = convertNavigationValues(config.navigation, context)
      if (children.length > 0) {
        const hasRootPages = children.some((page) => typeof page === 'string')
        tabs = [{
          tab: 'Documentation',
          ...(hasRootPages
            ? { pages: children }
            : { groups: children as Array<MigrationNavigationGroup> }),
        }]
      }
    }
  }

  if (tabs.length === 0) {
    warnings.push({
      code: 'unsupported-config',
      message: 'Mintlify navigation could not be projected; generated navigation will be used.',
    })
  }
  // A version selector is a separate control from the sibling tabs. Keep
  // the source tab identity unique while giving Thally a clean visible label
  // and a route prefix for selecting the matching version on deep links.
  const versionOwner = defaultLanguage ?? navigation
  const globalNavigation = objectValue(versionOwner.global) ?? objectValue(navigation.global)
  const shortcuts = Array.isArray(globalNavigation?.anchors)
    ? globalNavigation.anchors.flatMap((value) => {
        const anchor = objectValue(value)
        const label = typeof anchor?.anchor === 'string' ? anchor.anchor.trim() : ''
        const href = projectedHref(anchor?.href)
        if (!label || !href) return []
        return [{ label, href, ...(iconName(anchor?.icon) ? { icon: iconName(anchor?.icon) } : {}) }]
      })
    : []
  const rawVersions = Array.isArray(versionOwner.versions)
    ? versionOwner.versions.map(objectValue).filter((value): value is Record<string, unknown> => value !== null)
      .sort((left, right) => Number(right.default === true) - Number(left.default === true))
    : []
  const versionNames = rawVersions
    .map((entry) => typeof entry.version === 'string' ? entry.version.trim() : '')
    .filter(Boolean)
  const annotateVersions = (items: Array<MigrationNavigationTab>): Array<MigrationNavigationTab> => items.map((item) => {
    const version = versionNames.find((name) => item.tab.startsWith(`${name}: `))
    return version ? { ...item, version, displayLabel: item.tab.slice(version.length + 2) } : item
  })
  const firstPage = (item: MigrationNavigationTab): string | undefined => {
    const visit = (entries: Array<string | MigrationNavigationGroup>): string | undefined => {
      for (const entry of entries) {
        if (typeof entry === 'string') return entry
        const nested = visit(entry.pages)
        if (nested) return nested
      }
      return undefined
    }
    return visit([...(item.pages ?? []), ...(item.groups ?? [])])
  }
  const defaultVersion = rawVersions.find((entry) => entry.default === true) ?? rawVersions[0]
  const versions = rawVersions.length > 1 ? rawVersions.flatMap((entry) => {
    const label = typeof entry.version === 'string' ? entry.version.trim() : ''
    if (!label) return []
    const candidates = tabs.filter((item) => item.tab.startsWith(`${label}: `))
      .map(firstPage).filter((page): page is string => Boolean(page))
    // Versions sometimes reuse unversioned guide pages but still own a
    // versioned API tab. Enter through an owned route when one exists.
    const landing = candidates.find((page) => page.startsWith(`${label}/`)) ?? candidates[0]
    if (!landing) return []
    const firstSegment = landing.split('/')[0]
    const prefix = firstSegment === label ? label : ''
    return [{ label, prefix, href: `/${landing}`, ...(entry === defaultVersion ? { default: true } : {}), ...(entry.hidden === true ? { hidden: true } : {}) }]
  }) : []
  if (versions.length > 1) {
    tabs = annotateVersions(tabs)
    for (const [locale, items] of Object.entries(localizedNavigation)) localizedNavigation[locale] = annotateVersions(items)
  }
  const redirects = Array.isArray(config.redirects)
    ? config.redirects.flatMap((value) => {
        const redirect = objectValue(value)
        if (!redirect || typeof redirect.source !== 'string' || typeof redirect.destination !== 'string') return []
        const rawSource = redirect.source.trim()
        const rawDestination = redirect.destination.trim()
        if (!isRedirectPathSafe(rawSource, rawDestination)) return []
        const translated = translateRedirectWildcards(rawSource, rawDestination)
        if (!translated) {
          warnings.push({
            code: 'unsupported-config',
            message: `Redirect from ${rawSource} uses a wildcard Next.js cannot express and was dropped.`,
          })
          return []
        }
        return [{
          source: translated.source,
          destination: translated.destination,
          ...(typeof redirect.permanent === 'boolean' ? { permanent: redirect.permanent } : {}),
        }]
      })
    : []
  collectReferenceAccess(navigation, OPEN_NAVIGATION_ACCESS, options.pathPrefix, appearances)
  return {
    docsConfig: {
      tabs,
      ...(projectionTrace.rootContainerKind === 'dropdowns' || versions.length > 1 || shortcuts.length > 0
        ? { navigation: {
          ...(projectionTrace.rootContainerKind === 'dropdowns' ? { display: 'dropdown' as const } : {}),
          ...(versions.length > 1 ? { versions } : {}),
          ...(shortcuts.length > 0 ? { shortcuts } : {}),
        } }
        : {}),
      ...projectedCompatibleConfig(config, warnings),
      ...projectedApi(config, warnings),
      ...(i18n ? { i18n } : {}),
      ...(redirects.length > 0 ? { redirects } : {}),
    },
    pageReferences: references,
    referenceAccess: appearances,
    gatedSourceRefs,
    warnings,
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => ['api', 'cli', 'sdk', 'ui'].includes(word.toLowerCase())
      ? word.toUpperCase()
      : word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

interface GeneratedNavigationOptions {
  /** Dedicated docs platforms expose their primary sections as top-level tabs. */
  topLevelTabs?: boolean
  /** Ordered tabs recovered from the source site's rendered navigation. */
  topLevelNavigation?: ReadonlyArray<{
    section: string
    label: string
    pageId: string
  }>
}

const TOP_LEVEL_LABELS: Record<string, string> = {
  'api-reference': 'API Reference',
  cli: 'CLI',
  faqs: 'FAQs',
  introduction: 'Overview',
  'mcp-server': 'MCP Server',
  sdk: 'SDK',
}

function topLevelLabel(segment: string): string {
  return TOP_LEVEL_LABELS[segment] ?? titleCase(segment)
}

function groupsWithinSection(
  section: string,
  pageIds: Array<string>,
  sectionLabel = topLevelLabel(section),
): Array<MigrationNavigationGroup> {
  const groups = new Map<string, Array<string>>()
  for (const id of pageIds) {
    const relative = id === 'introduction'
      ? ''
      : id.startsWith(`${section}/`)
        ? id.slice(section.length + 1)
        : id
    const nestedSegment = relative.includes('/') ? relative.split('/', 1)[0] : 'overview'
    const group = groups.get(nestedSegment) ?? []
    group.push(id)
    groups.set(nestedSegment, group)
  }
  return [...groups].map(([segment, pages]) => ({
    group: segment === 'overview' ? sectionLabel : titleCase(segment),
    pages,
  }))
}

function preferredLandingPage(
  section: string,
  pageIds: Array<string>,
): string | undefined {
  const candidates = [
    section === 'introduction' ? 'introduction' : undefined,
    `${section}/overview`,
    `${section}/introduction`,
    section,
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && pageIds.includes(candidate)))
}

/** Build deterministic fallback navigation from imported default-locale pages. */
export function buildNavigationFromPages(
  pages: Array<MigrationPage>,
  options: GeneratedNavigationOptions = {},
): MigrationDocsConfig {
  const ids = pages.filter((page) => !page.locale || page.locale === 'en').map((page) => page.navigationId)
  const ordered = [...new Set(ids)]
  if (options.topLevelTabs) {
    const sourceNavigation = (options.topLevelNavigation ?? []).flatMap((entry) => {
      const sectionPages = ordered.filter((id) => id === entry.section || id.startsWith(`${entry.section}/`))
      const pageId = ordered.includes(entry.pageId)
        ? entry.pageId
        : preferredLandingPage(entry.section, sectionPages) ?? sectionPages[0]
      return pageId ? [{ ...entry, pageId }] : []
    })
    if (sourceNavigation.length > 1) {
      const claimedIds = new Set<string>()
      const tabs = sourceNavigation.map((entry) => {
        const pageIds = ordered.filter((id) => {
          const matches = id === entry.pageId
            || id === entry.section
            || id.startsWith(`${entry.section}/`)
          if (matches) claimedIds.add(id)
          return matches
        })
        return { entry, pageIds }
      })
      // Mintlify's first tab is the documentation home and owns pages that do
      // not belong to another product tab (for example /create and /deploy).
      tabs[0].pageIds.push(...ordered.filter((id) => !claimedIds.has(id)))
      return {
        tabs: tabs.map(({ entry, pageIds }) => ({
          tab: entry.label,
          href: entry.pageId === 'introduction' ? '/' : `/${entry.pageId}`,
          groups: groupsWithinSection(entry.section, [...new Set(pageIds)], entry.label),
        })),
      }
    }
    const sectionNames = [...new Set(ordered
      .filter((id) => id.includes('/'))
      .map((id) => id.split('/', 1)[0]))]
    if (sectionNames.length > 1) {
      const defaultSection = sectionNames.includes('introduction')
        ? 'introduction'
        : sectionNames[0]
      const sections = new Map<string, Array<string>>()
      for (const id of ordered) {
        const section = id.includes('/') ? id.split('/', 1)[0] : defaultSection
        const bucket = sections.get(section) ?? []
        bucket.push(id)
        sections.set(section, bucket)
      }
      return {
        tabs: [...sections].map(([section, pageIds]) => {
          const label = topLevelLabel(section)
          const landingPage = preferredLandingPage(section, pageIds)
          return {
            tab: label,
            ...(landingPage
              ? { href: landingPage === 'introduction' ? '/' : `/${landingPage}` }
              : {}),
            groups: groupsWithinSection(section, pageIds),
          }
        }),
      }
    }
  }
  const buckets = new Map<string, Array<string>>()
  for (const id of ordered) {
    const segment = id.includes('/') ? id.split('/', 1)[0] : 'overview'
    const bucket = buckets.get(segment) ?? []
    bucket.push(id)
    buckets.set(segment, bucket)
  }
  const groups = [...buckets].map(([segment, pageIds]) => ({
    group: segment === 'overview' ? 'Overview' : titleCase(segment),
    pages: pageIds,
  }))
  return { tabs: [{ tab: 'Documentation', groups }] }
}

/** Exposed for repository discovery and focused unit tests. */
export function isDocumentationExtension(filename: string): boolean {
  return ['.md', '.mdx', '.rst', '.txt'].includes(extname(filename).toLowerCase())
}

/**
 * A source page can be excluded after navigation is projected (invalid MDX,
 * a client-boundary function prop, a duplicate id). Its reference still sits
 * in the projected tabs/groups at that point, across every tab, group, and
 * locale, since the nav tree and the page list are built from the same
 * source config independently. Drop those dangling references here so
 * `thally check` never reports a nav entry with no backing MDX file, and
 * drop any group left with no pages as a result. Shared by every platform's
 * navigation projection (Mintlify, Fern, Docusaurus).
 */
export function pruneMissingNavigationPages(
  config: MigrationDocsConfig,
  availableIds: ReadonlySet<string>,
): MigrationDocsConfig {
  const pruneNodes = (nodes: Array<string | MigrationNavigationGroup>): Array<string | MigrationNavigationGroup> => {
    const seenSiblings = new Set<string>()
    return nodes.flatMap((node): Array<string | MigrationNavigationGroup> => {
      if (typeof node === 'string') {
        // Distinct source files can resolve to one final frontmatter slug.
        // Showing that route twice in one sidebar group is misleading even
        // though both references passed the existence check.
        if (!availableIds.has(node) || seenSiblings.has(node)) return []
        seenSiblings.add(node)
        return [node]
      }
      const pages = pruneNodes(node.pages)
      return pages.length > 0 ? [{ ...node, pages }] : []
    })
  }
  const tabs = config.tabs.flatMap((tab) => {
    const hadPages = (tab.pages?.length ?? 0) > 0 || (tab.groups?.length ?? 0) > 0
    const pages = tab.pages ? pruneNodes(tab.pages) : undefined
    const groups = tab.groups ? (pruneNodes(tab.groups) as Array<MigrationNavigationGroup>) : undefined
    const hasPages = (pages?.length ?? 0) > 0 || (groups?.length ?? 0) > 0
    // A tab that never referenced pages/groups (href-only, api-only) is untouched.
    if (hadPages && !hasPages) return []
    return [{
      ...tab,
      ...(tab.pages ? { pages } : {}),
      ...(tab.groups ? { groups } : {}),
    }]
  })
  return { ...config, tabs }
}
