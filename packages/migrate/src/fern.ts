/**
 * Static Fern (`fern/docs.yml`) repository projection. Fern navigation and
 * generator config are plain YAML data files, so this adapter only ever
 * parses them with `yaml` and never imports or executes JavaScript.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, relative } from 'node:path'

import { load } from 'cheerio'
import { parse as parseYaml } from 'yaml'

import { isRedirectPathSafe, translateRedirectWildcards } from './navigation.js'
import { skippedRedirectsWarning } from './redirects.js'
import { isPathEscapeError, resolveWithin, resolveWithinRoot, withinRealRoot } from './path.js'
import type {
  MigrationDocsConfig,
  MigrationNavigationGroup,
  MigrationNavigationTab,
  MigrationWarning,
} from './types.js'

const MAX_CONFIG_BYTES = 20_000_000

/** Retain safe Fern announcement links without emitting source-controlled HTML. */
export function announcementMarkdown(message: string): string {
  const document = load(message)
  document('script, style, iframe, object, embed, svg, math').remove()
  const escapeText = (value: string): string => value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_\[\]{}()!])/g, '\\$1')
  const links = new Map<string, string>()
  document('a').each((index, element) => {
    const marker = `THALLYANNOUNCEMENTLINK${index}TOKEN`
    const label = document(element).text().trim()
    const rawHref = document(element).attr('href')?.trim() ?? ''
    let href: string | undefined
    if (/^https?:\/\//i.test(rawHref)) {
      try { href = new URL(rawHref).toString() } catch { /* invalid source link becomes text */ }
    } else if (rawHref.startsWith('/') && !rawHref.startsWith('//') && !/[\\<>\s]/.test(rawHref)) {
      href = rawHref
    }
    const destination = href?.replace(/\(/g, '%28').replace(/\)/g, '%29')
    links.set(marker, destination && label ? `[${escapeText(label)}](${destination})` : escapeText(label))
    document(element).replaceWith(marker)
  })
  let text = escapeText(document('body').text())
  for (const [marker, link] of links) text = text.replaceAll(marker, link)
  return text.trim()
}

export interface FernPageDescriptor {
  /** Path to the referenced page file, relative to the Fern root. */
  sourcePath: string
  navigationId: string
  /** Fern's sidebar label can intentionally differ from the page title. */
  navTitle?: string
  /** Keep routable pages excluded by Fern's `hidden` navigation flag. */
  hidden?: boolean
  /** Listed under a docs.yml node that sets `viewers` or `authed`: Fern shows it only to signed-in roles. */
  restricted?: boolean
}

/** One `api:` navigation node, resolved to the name/tab Thally needs to bind its spec. */
export interface FernApiSection {
  /** The node's own value (a display name or, in multi-API repos, a `fern/apis/<name>` identifier). */
  name: string
  /** True when `name` came from an explicit `api-name` field rather than falling back to the `api:` display title. */
  nameExplicit: boolean
  /** Label of the tab that owns this node, if that tab also has other content and survived projection. */
  tabLabel?: string
  /**
   * Route segments (section slugs) leading to this node, used only to
   * disambiguate two `api:` nodes that land on the same `tabLabel` — a
   * "Production API Reference" and "Testnet API Reference" section both
   * nested under one tab both want that tab's label; without this, the
   * second one silently overwrites the first tab's binding instead of
   * getting its own tab.
   */
  routeSegments: Array<string>
}

export interface FernNavigationResult {
  /** A bounded walk skipped nodes whose access rules and API bindings are unknown. */
  navigationIncomplete: boolean
  docsConfig: MigrationDocsConfig
  descriptors: Array<FernPageDescriptor>
  warnings: Array<MigrationWarning>
  /** Every `api:` node found in navigation, in document order. A repo can declare several (e.g. a REST and a WebSocket API in separate tabs). */
  apiSections: Array<FernApiSection>
  /** `api:` nodes under a restricted node; their specs must not be published. */
  restrictedApiSections: Array<FernApiSection>
  /** Fern changelog tabs render their entries as a feed at the bare route. */
  changelogIndexes: Array<{ route: string; entries: Array<string> }>
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => ['api', 'cli', 'sdk', 'ui'].includes(word.toLowerCase())
      ? word.toUpperCase()
      : word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function readBoundedYaml(path: string): unknown {
  if (lstatSync(path).size > MAX_CONFIG_BYTES) {
    throw new Error('The Fern config is larger than 20 MB and could not be imported.')
  }
  return parseYaml(readFileSync(path, 'utf8'))
}

/** Read `fern/docs.yml` without executing anything. */
export function readFernConfig(fernRoot: string): { config: Record<string, unknown>; sourcePath: string } | null {
  const sourcePath = 'docs.yml'
  const path = resolveWithin(fernRoot, sourcePath)
  if (!existsSync(path) || !lstatSync(path).isFile()) return null
  const config = objectValue(readBoundedYaml(path))
  if (!config) throw new Error('fern/docs.yml must contain an object.')
  return { config, sourcePath }
}

interface WalkContext {
  /** Shared across scoped context copies; bound alias expansion and recursion. */
  navigationWalk: { active: Set<Record<string, unknown>>; visits: number; incomplete: boolean }
  fernRoot: string
  repositoryRoot: string
  descriptors: Array<FernPageDescriptor>
  seenNavigationIds: Set<string>
  /** Every `api:` node seen so far, in document order; `tabLabel` is filled in once its owning tab finishes walking. */
  apiSections: Array<FernApiSection>
  /** `api:` nodes under a node that sets `viewers`: never published, and their specs stay out of public/. */
  restrictedApiSections: Array<FernApiSection>
  changelogIndexes: Array<{ route: string; entries: Array<string> }>
  warnings: Array<MigrationWarning>
  warningKeys: Set<string>
  /** External navigation leaves cannot live inside Thally groups; keep them as navbar links. */
  externalLinks: Array<{ label: string; href: string }>
  /** Bare tab/section routes with no page of their own, soft-redirected to their first descendant. */
  bareRouteRedirects: Array<{ source: string; destination: string }>
  /** Slugified segment -> the literal explicit `slug` it was derived from, when the two differ (e.g. `baml-client` -> `baml_client`). */
  segmentAliases: Map<string, string>
  /**
   * Directory, relative to `fernRoot` (posix, no trailing slash, '' at the
   * root), that a page's `path` is actually relative to. A product's own
   * config lives under `fern/products/<name>/`, so its pages resolve there
   * rather than at the Fern root, even though the product's *route* segment
   * is unrelated and handled separately via `parentSegments`.
   */
  pathPrefix: string
  hiddenInherited?: boolean
  /** Set while resolving a default version whose entry sets `viewers`. */
  versionRestricted?: boolean
  /**
   * The navigation id that actually owns a page's content, keyed by
   * `sourcePath` — the first nav location a file is registered at. A file
   * registered again at a second nav location (e.g. a Fern page listed
   * under both a guide section and a `slug: baml_client` reference section)
   * gets its own position-derived id recorded in `descriptors` (so a
   * redirect from it can still be built), but the navigation tree itself
   * points that second location at this id, since `repository.ts` creates
   * exactly one page per physical file and the second id never becomes one.
   */
  sourcePathToNavigationId: Map<string, string>
}

function warnOnce(context: WalkContext, key: string, message: string): void {
  if (context.warningKeys.has(key)) return
  context.warningKeys.add(key)
  context.warnings.push({ code: 'unsupported-config', message })
}

function firstLeafId(nodes: Array<string | MigrationNavigationGroup>): string | undefined {
  for (const node of nodes) {
    if (typeof node === 'string') return node
    const nested = firstLeafId(node.pages)
    if (nested) return nested
  }
  return undefined
}

/** A tab or section with no page of its own still has a public URL that Fern resolves to its first descendant. */
function addBareRouteRedirect(
  segments: Array<string>,
  pages: Array<string | MigrationNavigationGroup>,
  context: WalkContext,
): void {
  if (segments.length === 0) return
  const destination = firstLeafId(pages)
  const source = segments.join('/')
  if (destination && destination !== source) {
    context.bareRouteRedirects.push({ source: `/${source}`, destination: `/${destination}` })
  }
}

/** A literal explicit `slug` value is only trusted as a redirect segment when it's already plain URL-safe text. */
const FERN_SEGMENT_ALIAS = /^[\w.-]+$/

/**
 * Fern's own slugifier treats any non-alphanumeric run (including `.`, which
 * Thally's shared `slugifySegment` deliberately preserves for other
 * platforms) as a separator, so Fern gets its own minimal one here.
 */
function fernBasicSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

/**
 * Fern derives a default slug from a display name by lowercasing, replacing
 * non-alphanumeric runs with hyphens, dropping parentheses, and splitting
 * camelCase/acronym boundaries (`OpenAI` -> `open-ai`, `SDKs` -> `sd-ks`) —
 * confirmed against buildwithfern.com's own "Configuring slugs" doc and a
 * live site's sitemap. Only the label fallback needs this; an authored
 * `slug` is used as literal, already-intended path text.
 */
function fernLabelSlug(label: string): string {
  const decamelized = label
    .replace(/[()]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
  return fernBasicSlug(decamelized)
}

/**
 * A Fern tab, section, or page contributes its slugified label as a URL
 * segment by default (confirmed against a live Fern site's sitemap: nested
 * sections with no `slug` field still nest their descendants by title).
 * `slug` overrides the label; `skip-slug: true` omits the segment entirely.
 *
 * An author-written `slug` is intentional URL text (e.g. BAML's `slug:
 * baml_client`, matching its own `baml_client/` folder name) — Fern serves
 * it literally, underscore and all. `fernBasicSlug` still squashes it into
 * Thally's usual hyphenated route (kept as the canonical route: changing it
 * would be a wider behavior change than this warrants), but when the two
 * differ, the literal form is recorded as a segment alias so
 * `fernUnderscoreAliasRedirects` can add a redirect from the original
 * folder-name-shaped link to the route Thally actually uses.
 */
function segmentFor(value: Record<string, unknown>, label: string, context?: WalkContext): string | null {
  if (value['skip-slug'] === true) return null
  // Fern uses an authored empty slug to put a tab at the site root.
  if (typeof value.slug !== 'string') return fernLabelSlug(label) || null
  const explicit = value.slug.trim()
  if (!explicit) return null
  const slugified = fernBasicSlug(explicit)
  if (context && explicit !== slugified && FERN_SEGMENT_ALIAS.test(explicit)) {
    context.segmentAliases.set(slugified, explicit)
  }
  return slugified || null
}

function uniqueNavigationId(base: string, context: WalkContext): string {
  if (!context.seenNavigationIds.has(base)) return base
  let index = 2
  while (context.seenNavigationIds.has(`${base}-${index}`)) index++
  return `${base}-${index}`
}

function registerPageAt(rawPath: string, base: string, context: WalkContext, navTitle?: string, hidden = false): string {
  let sourcePath: string
  try {
    const absolute = withinRealRoot(resolveWithinRoot(
      context.pathPrefix ? resolveWithinRoot(context.fernRoot, context.pathPrefix, context.repositoryRoot) : context.fernRoot,
      rawPath.trim(),
      context.repositoryRoot,
    ), context.repositoryRoot)
    sourcePath = relative(context.fernRoot, absolute).replace(/\\/g, '/')
  } catch {
    warnOnce(context, `fern-unsafe-page-${rawPath}`, `Skipped the Fern page "${rawPath}" because it points outside the repository (symlink or ..).`)
    return ''
  }
  const navigationId = uniqueNavigationId(base || 'introduction', context)
  context.seenNavigationIds.add(navigationId)
  const isHidden = hidden || context.hiddenInherited === true
  context.descriptors.push({ sourcePath, navigationId, ...(navTitle ? { navTitle } : {}), ...(isHidden ? { hidden: true } : {}) })
  // `repository.ts` creates exactly one page per physical file, keyed off
  // the first nav location that registers it — a file listed at a second
  // nav location (Fern allows the same page under several sections) must
  // not point the tree at this position's own id, which will never become
  // a page. Point it at the id that actually owns the content instead;
  // `fernUnderscoreAliasRedirects` still adds a redirect from this
  // position's own derived route to that kept id, for any old/external
  // link built from it.
  const kept = context.sourcePathToNavigationId.get(sourcePath)
  if (kept) {
    if (!isHidden) {
      const owner = context.descriptors.find((descriptor) => descriptor.navigationId === kept)
      if (owner) owner.hidden = false
    }
    return kept
  }
  context.sourcePathToNavigationId.set(sourcePath, navigationId)
  return navigationId
}

/** Expand Fern's folder shorthand from actual Markdown files in document order. */
function registerFolder(
  object: Record<string, unknown>,
  parentSegments: Array<string>,
  context: WalkContext,
): MigrationNavigationGroup | null {
  const rawPath = String(object.folder).trim()
  let folder: string
  try {
    folder = withinRealRoot(resolveWithinRoot(
      context.pathPrefix ? resolveWithinRoot(context.fernRoot, context.pathPrefix, context.repositoryRoot) : context.fernRoot,
      rawPath,
      context.repositoryRoot,
    ), context.repositoryRoot)
  } catch {
    warnOnce(context, `fern-unsafe-folder-${rawPath}`, `Skipped the Fern folder "${rawPath}" because it points outside the repository (symlink or ..). None of its pages were imported.`)
    return null
  }
  if (!existsSync(folder) || !lstatSync(folder).isDirectory()) {
    warnOnce(context, `fern-missing-folder-${rawPath}`, `Fern folder "${rawPath}" does not exist and was skipped.`)
    return null
  }
  const label = typeof object.title === 'string' && object.title.trim() ? object.title.trim() : titleCase(basename(folder))
  // Folder titles are navigation labels. Fern keeps the directory name in
  // the route unless a slug override is authored.
  const segment = typeof object.slug === 'string' || object['skip-slug'] === true
    ? segmentFor(object, label, context)
    : fernBasicSlug(basename(folder))
  const segments = segment ? [...parentSegments, segment] : parentSegments
  const visit = (directory: string, routeSegments: Array<string>, depth: number): Array<string | MigrationNavigationGroup> => {
    if (depth > 12 || context.descriptors.length >= 5_000) {
      context.navigationWalk.incomplete = true
      warnOnce(context, 'fern-folder-limit', 'Fern folder navigation exceeded its depth or page budget; remaining access rules could not be classified.')
      return []
    }
    const pages: Array<string | MigrationNavigationGroup> = []
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink())
      .sort((left, right) => Number(left.name !== 'index.mdx' && left.name !== 'index.md')
        - Number(right.name !== 'index.mdx' && right.name !== 'index.md') || left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = resolveWithin(directory, entry.name)
      if (entry.isDirectory()) {
        const nested = visit(path, [...routeSegments, fernBasicSlug(entry.name)], depth + 1)
        if (nested.length) pages.push({ group: titleCase(entry.name), pages: nested })
      } else if (entry.isFile() && ['.md', '.mdx'].includes(extname(entry.name).toLowerCase())) {
        const stem = basename(entry.name, extname(entry.name))
        const pageSegment = stem.toLowerCase() === 'index' ? null : fernBasicSlug(stem)
        const route = [...routeSegments, ...(pageSegment ? [pageSegment] : [])].join('/')
        const source = lstatSync(path).size <= MAX_CONFIG_BYTES ? readFileSync(path, 'utf8') : ''
        const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ''
        const hidden = /^hidden:\s*true\s*$/m.test(frontmatter)
        const registered = registerPageAt(relative(context.fernRoot, path), route, { ...context, pathPrefix: '' }, undefined, hidden)
        if (registered && !hidden && !context.hiddenInherited) pages.push(registered)
      }
    }
    return pages
  }
  const pages = visit(folder, segments, 0)
  if (!pages.length) return null
  addBareRouteRedirect(segments, pages, context)
  return { group: label, pages }
}

function registerPage(
  object: Record<string, unknown>,
  parentSegments: Array<string>,
  context: WalkContext,
): string | null {
  if (typeof object.path !== 'string' || !object.path.trim()) return null
  const label = typeof object.page === 'string' && object.page.trim() ? object.page.trim() : 'Untitled'
  const segment = segmentFor(object, label, context)
  const base = [...parentSegments, segment].filter(Boolean).join('/')
  return registerPageAt(object.path, base, context, label, object.hidden === true) || null
}

/** Fern role-based access: any non-empty `viewers`, or a truthy `authed`, on a navigation node. Ambiguity counts as restricted. */
function isRestrictedNode(object: Record<string, unknown>): boolean {
  const viewers = object.viewers
  if (Array.isArray(viewers) ? viewers.length > 0
    : typeof viewers === 'string' ? viewers.trim() !== ''
      : viewers !== undefined && viewers !== null && viewers !== false) return true
  const authed = object.authed
  return authed !== undefined && authed !== null && authed !== false
    && !(typeof authed === 'string' && ['', 'false'].includes(authed.trim().toLowerCase()))
}

interface RestrictionMark { descriptors: number; apis: number }

function restrictionMark(context: WalkContext): RestrictionMark {
  return { descriptors: context.descriptors.length, apis: context.apiSections.length }
}

/**
 * Mark every page and `api:` node registered since `mark` as restricted; the
 * caller leaves them out of navigation. Their specs are kept out of public/.
 */
function markRestricted(context: WalkContext, mark: RestrictionMark): void {
  for (const descriptor of context.descriptors.slice(mark.descriptors)) descriptor.restricted = true
  context.restrictedApiSections.push(...context.apiSections.splice(mark.apis))
}

/** A `section`/`page`/`link`/`api`/`changelog` node from `layout` or `contents`. */
function convertNode(
  node: unknown,
  parentSegments: Array<string>,
  context: WalkContext,
): string | MigrationNavigationGroup | null {
  const object = objectValue(node)
  if (!object) return null
  const walk = context.navigationWalk
  const reason = walk.active.has(object) ? 'cyclic section'
    : walk.active.size >= 64 ? 'section depth exceeds 64'
      : walk.visits >= 5_000 ? 'node budget exceeds 5000' : undefined
  if (reason) {
    walk.incomplete = true
    warnOnce(context, `navigation-${reason}`, `Fern navigation was skipped: ${reason}.`)
    return null
  }
  walk.visits++
  walk.active.add(object)
  try {
    if (isRestrictedNode(object)) {
      const before = restrictionMark(context)
      convertNodeContents({ ...object, viewers: undefined, authed: undefined }, parentSegments, context)
      markRestricted(context, before)
      return null
    }
    return convertNodeContents(object, parentSegments, context)
  } finally {
    walk.active.delete(object)
  }
}

function convertNodeContents(
  object: Record<string, unknown>,
  parentSegments: Array<string>,
  context: WalkContext,
): string | MigrationNavigationGroup | null {

  if (typeof object.page === 'string') {
    const page = registerPage(object, parentSegments, context)
    return object.hidden === true || context.hiddenInherited ? null : page
  }

  if (typeof object.folder === 'string') {
    const folder = registerFolder(object, parentSegments, object.hidden === true ? { ...context, hiddenInherited: true } : context)
    return object.hidden === true || context.hiddenInherited ? null : folder
  }

  if (typeof object.section === 'string') {
    const label = object.section
    const segment = segmentFor(object, label, context)
    const segments = segment ? [...parentSegments, segment] : parentSegments
    const contents = Array.isArray(object.contents) ? object.contents : []
    const pages: Array<string | MigrationNavigationGroup> = []
    // A section can also carry its own `path`, making the section itself a
    // clickable landing page hosted at the section's own segment (not a
    // further-nested page segment).
    const hasOwnPath = typeof object.path === 'string' && object.path.trim().length > 0
    if (hasOwnPath) {
      const registered = registerPageAt(object.path as string, segments.join('/'), context, label, object.hidden === true)
      if (registered) pages.push(registered)
    }
    for (const child of contents) {
      const converted = convertNode(child, segments, object.hidden === true ? { ...context, hiddenInherited: true } : context)
      if (converted) pages.push(converted)
    }
    if (pages.length === 0) return null
    // A section without its own `path` still has a public URL at its segment;
    // Fern resolves that bare route to the section's first descendant page.
    if (!hasOwnPath && segment) addBareRouteRedirect(segments, pages, context)
    if (object.hidden === true || context.hiddenInherited) return null
    return {
      group: label,
      ...(['open-by-default', 'closed-by-default', true, false].includes(object.collapsed as string | boolean)
        ? { defaultOpen: object.collapsed === 'open-by-default' || object.collapsed === false } : {}),
      ...(typeof object.icon === 'string' ? { icon: object.icon } : {}),
      ...(object.hidden === true ? { hidden: true } : {}),
      pages,
    }
  }

  if (typeof object.link === 'string') {
    const label = object.link.trim()
    const rawHref = typeof object.href === 'string' ? object.href.trim() : ''
    // Fern links may appear within a section, while Thally's group schema
    // accepts page ids only. Only absolute web URLs belong in the navbar;
    // canonicalizing through URL also rejects malformed or deceptive hosts.
    let href: string | undefined
    if (/^https?:\/\//i.test(rawHref) && !/[\\\u0000-\u0020\u007f]/.test(rawHref)) {
      try {
        const url = new URL(rawHref)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) href = url.toString()
      } catch { /* An invalid authored link is reported below. */ }
    }
    if (label && href && object.hidden !== true && !context.hiddenInherited) {
      if (!context.externalLinks.some((link) => link.label === label && link.href === href)) {
        context.externalLinks.push({ label, href })
      }
    } else if (!href && object.hidden !== true && !context.hiddenInherited) {
      warnOnce(context, `fern-link-${rawHref}`, `Fern navigation link "${label}" has an unsafe or invalid external URL and was skipped.`)
    }
    return null
  }

  if (typeof object.api === 'string') {
    // `api` is the display title shown in the nav; `api-name` (when
    // present) is the actual `fern/apis/<name>/` folder name. A repo with
    // `api: Plant API` / `api-name: plants` has no `apis/Plant API`
    // folder, so preferring `api-name` is required to find the spec. A repo
    // can declare several `api:` nodes (e.g. a REST API and a WebSocket API
    // in separate tabs) — each is tracked and resolved independently rather
    // than only ever importing the first one found.
    // Like a section or page, an `api:` node contributes its own slug to the
    // route unless `skip-slug: true` (confirmed against a live Fern site:
    // VapiAI's `api-reference` tab has one `api:` node with `skip-slug:
    // true` served directly at the tab's own route, and a second `Webhooks`
    // node — no skip-slug — served one level deeper, at
    // ".../api-reference/webhooks"). This is also this node's own auto-
    // generated operation page prefix, used to rewrite in-content links to
    // those pages onto Thally's route.
    const ownSegment = segmentFor(object, object.api, context)
    context.apiSections.push({
      name: typeof object['api-name'] === 'string' ? object['api-name'] : object.api,
      nameExplicit: typeof object['api-name'] === 'string',
      routeSegments: ownSegment ? [...parentSegments, ownSegment] : parentSegments,
    })
    return null
  }

  if (typeof object.changelog === 'string') {
    return registerFolder({ folder: object.changelog, title: 'Changelog', 'skip-slug': true }, parentSegments, context)
  }

  return null
}

function convertNodes(
  nodes: Array<unknown>,
  parentSegments: Array<string>,
  context: WalkContext,
): Array<string | MigrationNavigationGroup> {
  return nodes.flatMap((node) => {
    const converted = convertNode(node, parentSegments, context)
    return converted ? [converted] : []
  })
}

function groupsFromConverted(
  converted: Array<string | MigrationNavigationGroup>,
): Array<MigrationNavigationGroup> {
  const loosePages = converted.filter((entry): entry is string => typeof entry === 'string')
  const groups = converted.filter((entry): entry is MigrationNavigationGroup => typeof entry !== 'string')
  return loosePages.length > 0 ? [{ group: 'Overview', pages: loosePages }, ...groups] : groups
}

/**
 * Resolve the default Fern version's navigation when no top-level nav
 * exists. `configDir` is the directory `chosen.path` is conventionally
 * relative to (the Fern root for a top-level docs.yml, or a product's own
 * directory for a product config); `context.repositoryRoot` (the whole
 * repository checkout) is the security boundary. A version file is a
 * legitimate Fern layout even when it lives outside `fern/` (e.g. a sibling
 * `docs/` directory referenced as `../docs/index.yml`), so it may resolve
 * anywhere inside the repository, not just under the Fern root — escapes
 * from the repository itself are still rejected. Once a version file loads,
 * its own `path:` entries are relative to *its* directory, not the Fern
 * root, so `pathPrefix` is shifted there for the rest of this config's walk.
 */
function resolveVersionedNavigation(
  config: Record<string, unknown>,
  configDir: string,
  fernRoot: string,
  context: WalkContext,
): Record<string, unknown> {
  if (Array.isArray(config.navigation)) return config
  if (Array.isArray(config.products)) {
    warnOnce(context, 'fern-products', 'Nested Fern multi-product docs are not supported; only this docs.yml was imported.')
    return config
  }
  if (!Array.isArray(config.versions)) return config
  const versions = config.versions.flatMap((entry) => {
    const version = objectValue(entry)
    return version ? [version] : []
  })
  const chosen = versions.find((version) => version.default === true) ?? versions[0]
  if (chosen && isRestrictedNode(chosen)) context.versionRestricted = true
  const skipped = versions.filter((version) => version !== chosen)
    .map((version) => (typeof version.version === 'string' ? version.version : undefined))
    .filter((name): name is string => Boolean(name))
  if (skipped.length > 0) {
    warnOnce(
      context,
      'fern-versions',
      `Only the default Fern version was imported; other versions were skipped: ${skipped.join(', ')}.`,
    )
  }
  if (!chosen || typeof chosen.path !== 'string') return config
  try {
    const versionPath = resolveWithinRoot(configDir, chosen.path, context.repositoryRoot)
    if (!existsSync(versionPath) || !lstatSync(versionPath).isFile()) {
      warnOnce(context, 'fern-version-not-file', `Fern version file "${chosen.path}" is not a regular file and was skipped.`)
      return config
    }
    withinRealRoot(versionPath, context.repositoryRoot)
    const versionConfig = objectValue(readBoundedYaml(versionPath))
    if (!versionConfig) return config
    context.pathPrefix = relative(fernRoot, dirname(versionPath)).replace(/\\/g, '/')
    return { ...config, navigation: versionConfig.navigation, tabs: versionConfig.tabs ?? config.tabs }
  } catch (error) {
    warnOnce(
      context,
      'fern-version-read-failed',
      isPathEscapeError(error)
        ? `Skipped the Fern version file "${chosen.path}" because it points outside the repository (symlink or ..).`
        : `Fern version file "${chosen.path}" could not be read (${error instanceof Error ? error.message : String(error)}) and was skipped.`,
    )
    return config
  }
}

/**
 * Build tabs for one docs config (the top-level docs.yml, or one product's
 * own config), rooted at `routePrefix`. Shared by the plain top-level path
 * and by `projectFernProducts` so both get identical tabbed/flat-navigation
 * and version-resolution handling.
 */
function buildTabsFromConfig(
  rawConfig: Record<string, unknown>,
  configDir: string,
  fernRoot: string,
  routePrefix: Array<string>,
  fallbackTabLabel: string,
  context: WalkContext,
): Array<MigrationNavigationTab> {
  const before = restrictionMark(context)
  let tabs: Array<MigrationNavigationTab>
  let restricted: boolean
  try {
    tabs = buildUnrestrictedTabs(rawConfig, configDir, fernRoot, routePrefix, fallbackTabLabel, context)
    restricted = context.versionRestricted === true
  } finally {
    context.versionRestricted = false
  }
  if (!restricted) return tabs
  markRestricted(context, before)
  return []
}

function buildUnrestrictedTabs(
  rawConfig: Record<string, unknown>,
  configDir: string,
  fernRoot: string,
  routePrefix: Array<string>,
  fallbackTabLabel: string,
  context: WalkContext,
): Array<MigrationNavigationTab> {
  const config = resolveVersionedNavigation(rawConfig, configDir, fernRoot, context)
  const tabsMeta = objectValue(config.tabs) ?? {}
  const navigation = config.navigation

  const isTabbedNavigation = Array.isArray(navigation)
    && navigation.length > 0
    && navigation.every((entry) => typeof objectValue(entry)?.tab === 'string')

  if (isTabbedNavigation) {
    return (navigation as Array<Record<string, unknown>>).flatMap((entry): Array<MigrationNavigationTab> => {
      const id = String(entry.tab)
      const meta = objectValue(tabsMeta[id]) ?? {}
      const label = typeof meta['display-name'] === 'string' ? meta['display-name'] : titleCase(id)
      const tabSegment = segmentFor(meta, label, context)
      const segments = [...routePrefix, ...(tabSegment ? [tabSegment] : [])]
      const layout = Array.isArray(entry.layout) ? entry.layout : []
      const sectionsBefore = context.apiSections.length
      const descriptorsBefore = restrictionMark(context)
      const groups = groupsFromConverted(convertNodes(layout, segments, context))
      if (isRestrictedNode(entry) || isRestrictedNode(meta)) {
        markRestricted(context, descriptorsBefore)
        return []
      }
      for (let index = sectionsBefore; index < context.apiSections.length; index += 1) {
        context.apiSections[index].tabLabel ??= label
      }
      if (groups.length === 0 && typeof meta.href === 'string' && /^https?:\/\//i.test(meta.href)) {
        return [{ tab: label, href: meta.href }]
      }
      if (groups.length === 0 && typeof meta.changelog === 'string') {
        // A Fern changelog tab names a directory rather than explicit page
        // nodes. Keep every MDX entry, newest dated filename first.
        const changelog = registerFolder({ folder: meta.changelog, title: label, 'skip-slug': true }, segments, context)
        if (changelog) {
          const indexRoute = segments.join('/')
          const descriptors = new Map(context.descriptors.map((descriptor) => [descriptor.navigationId, descriptor]))
          const visiblePages = changelog.pages.filter((page): page is string => typeof page === 'string')
            .filter((page) => !descriptors.get(page)?.hidden)
          // Fern's feed is ordered by publication date, while a directory
          // listing is alphabetical. An overview file may publish at the tab
          // root via frontmatter `slug`, so recognize it before slug remapping.
          const index = visiblePages.find((page) => {
            const descriptor = descriptors.get(page)
            if (!descriptor) return false
            const stem = basename(descriptor.sourcePath, extname(descriptor.sourcePath))
            return page === indexRoute || stem === 'overview' || stem === 'index'
          })
          const entries = visiblePages.filter((page) => page !== index).sort((left, right) => {
            const date = (page: string): string => descriptors.get(page)?.sourcePath.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? ''
            return date(right).localeCompare(date(left)) || left.localeCompare(right)
          })
          // Fern renders the entries in the feed, not in its sidebar. Keep
          // each article routable for its permalink while showing only the
          // feed itself in the navigation tree.
          for (const entryId of entries) {
            const descriptor = descriptors.get(entryId)
            if (descriptor) descriptor.hidden = true
          }
          changelog.pages = [index ?? indexRoute]
          context.changelogIndexes.push({ route: indexRoute, entries })
          const latest = index ?? firstLeafId(changelog.pages)
          const bareRouteIndex = context.bareRouteRedirects.findIndex((redirect) => redirect.source === `/${indexRoute}`)
          const indexDescriptor = index ? descriptors.get(index) : undefined
          const indexSource = indexDescriptor && lstatSync(resolveWithinRoot(context.fernRoot, indexDescriptor.sourcePath, context.repositoryRoot)).size <= MAX_CONFIG_BYTES
            ? readFileSync(resolveWithinRoot(context.fernRoot, indexDescriptor.sourcePath, context.repositoryRoot), 'utf8') : ''
          const indexFrontmatter = indexSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ''
          const indexSlug = indexFrontmatter.match(/^slug:\s*["']?([^\s"']+)["']?\s*$/m)?.[1]?.replace(/^\/+|\/+$/g, '')
          const hasBarePage = index === indexRoute || indexSlug === indexRoute
          if (bareRouteIndex >= 0 && hasBarePage) context.bareRouteRedirects.splice(bareRouteIndex, 1)
          else if (latest && bareRouteIndex >= 0) context.bareRouteRedirects[bareRouteIndex].destination = `/${latest}`
          return [{ tab: label, groups: [changelog] }]
        }
      }
      if (groups.length === 0) return []
      if (segments.length > 0) addBareRouteRedirect(segments, groups, context)
      return [{
        tab: label,
        ...(typeof meta.icon === 'string' ? { icon: meta.icon } : {}),
        groups,
      }]
    })
  }
  if (Array.isArray(navigation)) {
    const sectionsBefore = context.apiSections.length
    const groups = groupsFromConverted(convertNodes(navigation, routePrefix, context))
    for (let index = sectionsBefore; index < context.apiSections.length; index += 1) {
      context.apiSections[index].tabLabel ??= fallbackTabLabel
    }
    if (groups.length > 0) {
      if (routePrefix.length > 0) addBareRouteRedirect(routePrefix, groups, context)
      return [{ tab: fallbackTabLabel, groups }]
    }
  }
  return []
}

/**
 * Project Fern's `products:` (a docs.yml that fans out into several
 * independently-navigable products, e.g. buildwithfern.com/learn) into one
 * top-level tab per product, each routed under its own `slug`/display-name
 * segment and reading its pages from its own `fern/products/<name>/`
 * directory.
 */
function projectFernProducts(
  rawProducts: Array<unknown>,
  fernRoot: string,
  context: WalkContext,
): Array<MigrationNavigationTab> {
  return rawProducts.flatMap((entry) => {
    const product = objectValue(entry)
    const rawPath = typeof product?.path === 'string' ? product.path.trim() : ''
    if (!product || !rawPath) return []
    const label = typeof product['display-name'] === 'string' && product['display-name'].trim()
      ? product['display-name'].trim()
      : 'Product'
    let productPath: string
    try {
      productPath = withinRealRoot(resolveWithin(fernRoot, rawPath), context.repositoryRoot)
    } catch {
      warnOnce(context, `fern-product-unsafe-${rawPath}`, `Skipped the Fern product "${label}" because "${rawPath}" points outside the repository (symlink or ..).`)
      return []
    }
    if (!existsSync(productPath) || !lstatSync(productPath).isFile()) {
      warnOnce(context, `fern-product-missing-${rawPath}`, `Fern product "${label}" path "${rawPath}" does not exist and was skipped.`)
      return []
    }
    let productConfig: Record<string, unknown> | null
    try {
      productConfig = objectValue(readBoundedYaml(productPath))
    } catch (error) {
      warnOnce(
        context,
        `fern-product-read-failed-${rawPath}`,
        `Fern product "${label}" could not be read (${error instanceof Error ? error.message : String(error)}) and was skipped.`,
      )
      return []
    }
    if (!productConfig) return []
    const productDir = dirname(productPath)
    const routeSegment = segmentFor(product, label, context)
    const priorPrefix = context.pathPrefix
    context.pathPrefix = relative(fernRoot, productDir).replace(/\\/g, '/')
    const before = restrictionMark(context)
    try {
      const tabs = buildTabsFromConfig(
        productConfig,
        productDir,
        fernRoot,
        routeSegment ? [routeSegment] : [],
        label,
        context,
      )
      if (!isRestrictedNode(product)) return tabs
      markRestricted(context, before)
      return []
    } finally {
      context.pathPrefix = priorPrefix
    }
  })
}

/** Project a Fern `docs.yml` navigation tree into Thally tabs/groups. */
export function projectFernNavigation(input: {
  config: Record<string, unknown>
  fernRoot: string
  /**
   * The whole repository checkout — the security boundary for anything a
   * config file references (e.g. a `versions:` file living outside
   * `fern/`). Defaults to `fernRoot` for callers with no wider repository
   * context (e.g. unit tests), which reproduces the previous fernRoot-only
   * confinement.
   */
  repositoryRoot?: string
}): FernNavigationResult {
  const context: WalkContext = {
    navigationWalk: { active: new Set(), visits: 0, incomplete: false },
    fernRoot: input.fernRoot,
    repositoryRoot: input.repositoryRoot ?? input.fernRoot,
    descriptors: [],
    seenNavigationIds: new Set(),
    apiSections: [],
    restrictedApiSections: [],
    changelogIndexes: [],
    warnings: [],
    warningKeys: new Set(),
    externalLinks: [],
    bareRouteRedirects: [],
    segmentAliases: new Map(),
    pathPrefix: '',
    sourcePathToNavigationId: new Map(),
  }
  const config = input.config
  const hasProducts = Array.isArray(config.products) && config.products.length > 0 && !Array.isArray(config.navigation)
  const tabs = hasProducts
    ? projectFernProducts(config.products as Array<unknown>, input.fernRoot, context)
    : buildTabsFromConfig(config, input.fernRoot, input.fernRoot, [], 'Documentation', context)

  if (tabs.length === 0) {
    context.warnings.push({
      code: 'unsupported-config',
      message: 'Fern navigation could not be projected; generated navigation will be used.',
    })
  }

  const navbarLinks = Array.isArray(config['navbar-links'])
    ? (config['navbar-links'] as Array<unknown>).flatMap((entry) => {
        const link = objectValue(entry)
        const href = typeof link?.url === 'string'
          ? link.url
          : typeof link?.href === 'string' ? link.href : typeof link?.value === 'string' ? link.value : undefined
        const label = typeof link?.text === 'string'
          ? link.text
          : typeof link?.label === 'string' ? link.label : link?.type === 'github' ? 'GitHub' : undefined
        return href && label ? [{ label, href, ...(link?.type === 'github' ? { type: 'github' as const } : {}) }] : []
      })
    : []
  for (const link of context.externalLinks) {
    if (!navbarLinks.some((existing) => existing.label === link.label && existing.href === link.href)) {
      navbarLinks.push(link)
    }
  }
  const announcement = objectValue(config.announcement)
  const announcementMessage = typeof announcement?.message === 'string'
    ? announcement.message.trim()
    : ''
  // Fern permits HTML announcements; reduce them to escaped text and vetted
  // links before the Markdown-capable Thally banner renders the result.
  const bannerContent = announcementMarkdown(announcementMessage)

  const unsafeRedirects: Array<string> = []
  const redirects = Array.isArray(config.redirects)
    ? (config.redirects as Array<unknown>).flatMap((value) => {
        const redirect = objectValue(value)
        if (!redirect || typeof redirect.source !== 'string' || typeof redirect.destination !== 'string') return []
        const rawSource = redirect.source.trim()
        const rawDestination = redirect.destination.trim()
        if (!isRedirectPathSafe(rawSource, rawDestination)) {
          unsafeRedirects.push(rawSource)
          return []
        }
        const translated = translateRedirectWildcards(rawSource, rawDestination)
        if ('warning' in translated) {
          warnOnce(context, `fern-redirect-wildcard-${rawSource}`, translated.warning)
          return []
        }
        return [{
          source: translated.source,
          destination: translated.destination,
          // Both platforms document `permanent` as defaulting to true (308); only an explicit `false` is temporary.
          permanent: typeof redirect.permanent === 'boolean' ? redirect.permanent : true,
        }]
      })
    : []
  const unsafeRedirectWarning = skippedRedirectsWarning(unsafeRedirects)
  if (unsafeRedirectWarning) context.warnings.push(unsafeRedirectWarning)

  const authoredSources = new Set(redirects.map((redirect) => redirect.source))
  const knownIds = new Set(context.descriptors.map((descriptor) => descriptor.navigationId))
  // The id that actually owns a descriptor's page content — itself, unless
  // the same source file was registered at an earlier nav location too, in
  // which case `registerPageAt` already pointed the tree at that earlier
  // id and this descriptor's own id never becomes a real page. Every
  // redirect destination must resolve through this, never a descriptor's
  // raw `navigationId`, or it targets a route that doesn't exist.
  const keptNavigationId = (descriptor: FernPageDescriptor): string => (
    context.sourcePathToNavigationId.get(descriptor.sourcePath) ?? descriptor.navigationId
  )
  // A page whose route includes a segment Fern derived from an explicit
  // `slug` that got hyphenated (see `segmentFor`) is also reachable on the
  // live Fern site at its literal, unslugified form (Fern's own routing is
  // file/slug-based and tolerates it) — e.g. BAML's `slug: baml_client`
  // means both `/ref/baml-client/...` (Thally's route) and
  // `/ref/baml_client/...` (in-body links, matching the folder name) are
  // live. Add one redirect per affected page so those in-body links keep
  // resolving instead of 404ing after migration.
  const segmentAliasRedirects = context.segmentAliases.size > 0
    ? context.descriptors.flatMap((descriptor) => {
        const segments = descriptor.navigationId.split('/')
        let changed = false
        const aliased = segments.map((segment) => {
          const literal = context.segmentAliases.get(segment)
          if (!literal) return segment
          changed = true
          return literal
        })
        if (!changed) return []
        const source = `/${aliased.join('/')}`
        const destination = `/${keptNavigationId(descriptor)}`
        if (source === destination || knownIds.has(aliased.join('/'))) return []
        return [{ source, destination }]
      })
    : []
  // A source file registered at more than one nav location (a Fern page
  // listed under both a guide section and a `slug: baml_client` reference
  // section, say) keeps exactly one page, at the first location's route —
  // Fern itself serves the content at every route it's registered under, so
  // every other location's own derived route redirects to the kept one
  // instead of 404ing.
  const duplicateNavRedirects = context.descriptors.flatMap((descriptor) => {
    const kept = keptNavigationId(descriptor)
    if (kept === descriptor.navigationId) return []
    return [{ source: `/${descriptor.navigationId}`, destination: `/${kept}` }]
  })
  const allRedirects = [
    ...redirects,
    ...context.bareRouteRedirects.filter((redirect) => !authoredSources.has(redirect.source)),
    ...segmentAliasRedirects.filter((redirect) => !authoredSources.has(redirect.source)),
    ...duplicateNavRedirects.filter((redirect) => !authoredSources.has(redirect.source)),
  ]

  // Two `api:` nodes both nested under the same top-level tab (e.g.
  // Paradex's "Production API Reference" and "Testnet API Reference"
  // sections, both inside a `portal` tab) get the same `tabLabel` from the
  // loop above — Thally's schema allows only one `.api` per tab, so the
  // second would otherwise silently overwrite the first tab's binding.
  // Disambiguate every collision after the fact (the first claimant keeps
  // the plain tab label) using the node's own section route, which is
  // exactly what differs between them.
  const claimedTabLabels = new Set<string>()
  const disambiguatedApiSections = context.apiSections.map((section) => {
    if (!section.tabLabel || !claimedTabLabels.has(section.tabLabel)) {
      if (section.tabLabel) claimedTabLabels.add(section.tabLabel)
      return section
    }
    const distinguishingSegment = section.routeSegments.at(-1)
    let tabLabel = distinguishingSegment ? `${section.tabLabel}: ${titleCase(distinguishingSegment)}` : section.tabLabel
    // The route segment can itself title-case back to the tab's own label
    // (e.g. a section nested under a route segment also called
    // "api-reference"), producing a redundant "API Reference: API
    // Reference" name, or the segment-based label can still collide with
    // another section's. Either way, fall back to a plain ordinal suffix
    // instead of shipping a confusing or still-colliding tab name.
    if (!tabLabel || tabLabel === `${section.tabLabel}: ${section.tabLabel}` || claimedTabLabels.has(tabLabel)) {
      let ordinal = 2
      let candidate = `${section.tabLabel} (${ordinal})`
      while (claimedTabLabels.has(candidate)) {
        ordinal += 1
        candidate = `${section.tabLabel} (${ordinal})`
      }
      tabLabel = candidate
    }
    claimedTabLabels.add(tabLabel)
    return { ...section, tabLabel }
  })

  return {
    navigationIncomplete: context.navigationWalk.incomplete,
    docsConfig: {
      tabs,
      ...(bannerContent ? { banner: { content: bannerContent, dismissible: true } } : {}),
      ...(navbarLinks.length > 0 ? { navbar: { links: navbarLinks } } : {}),
      ...(allRedirects.length > 0 ? { redirects: allRedirects } : {}),
    },
    descriptors: context.descriptors,
    warnings: context.warnings,
    apiSections: disambiguatedApiSections,
    restrictedApiSections: context.restrictedApiSections,
    changelogIndexes: context.changelogIndexes,
  }
}
