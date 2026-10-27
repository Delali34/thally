/**
 * Mintlify-only helpers: page access rules, site-wide CSS/JS/font assets,
 * and appearance settings. Kept apart from the generic repository walk so the
 * rules that decide how restricted pages migrate (and what is quarantined)
 * are auditable in one place.
 *
 * Access invariant: a restricted page migrates with normalized `groups` /
 * `public` frontmatter that the Thally runtime enforces; anything ambiguous
 * (malformed values, group lists that share no group) fails closed and the
 * page is quarantined instead.
 */

import { extname } from 'node:path'

import { normalizeAssetPath } from './path.js'
import type { MigrationDocsConfig, MigrationWarning } from './types.js'

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Access rules read from one page's frontmatter or one navigation container,
 * normalized the way the Thally runtime reads page frontmatter.
 */
export interface MintlifyAccess {
  /** Trimmed, non-empty, de-duplicated group names; absent when none are named. */
  groups?: Array<string>
  /** `true` opens a page to anyone; `false` requires any signed-in reader. */
  isPublic?: boolean
  /** Set when a value cannot be read unambiguously: the page fails closed. */
  problem?: string
}

/** Access imposed by every navigation container above one appearance of a page. */
export interface NavigationAccess {
  /** Intersection of every container group list on the path. */
  groups?: Array<string>
  /** Some container on the path sets `public: false`. */
  hasPublicFalse: boolean
  /** Some container on the path sets `public: true` (Mintlify's documented group flag). */
  hasPublicTrue: boolean
  /** Set when a container value is malformed or nested group lists share no group. */
  problem?: string
}

/** Access frontmatter a migrated page is written with. */
export interface ResolvedPageAccess {
  groups?: Array<string>
  isPublic?: boolean
}

/** Either the access a page migrates with, or why it cannot migrate safely. */
export interface PageAccessVerdict {
  access?: ResolvedPageAccess
  problem?: string
}

export const OPEN_NAVIGATION_ACCESS: NavigationAccess = Object.freeze({ hasPublicFalse: false, hasPublicTrue: false })

// Mirrors `parsePublic` / `parseGroups` in src/lib/reader-auth/access.ts
// (duplicated because packages cannot import the app). The migration must
// write values the runtime reads identically, and treat as malformed exactly
// what the runtime would withhold from everyone.
const PUBLIC_FALSE_STRINGS = new Set(['false', 'no', 'off', '0'])
const PUBLIC_TRUE_STRINGS = new Set(['true'])

function parsePublic(value: unknown): { isPublic?: boolean; isMalformed: boolean } {
  if (value === undefined || value === null) return { isMalformed: false }
  if (value === true) return { isPublic: true, isMalformed: false }
  if (value === false || value === 0) return { isPublic: false, isMalformed: false }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (PUBLIC_TRUE_STRINGS.has(normalized)) return { isPublic: true, isMalformed: false }
    if (PUBLIC_FALSE_STRINGS.has(normalized)) return { isPublic: false, isMalformed: false }
  }
  return { isMalformed: true }
}

function parseGroups(value: unknown): { groups: Array<string>; isMalformed: boolean } {
  if (value === undefined || value === null || value === '' || value === false) return { groups: [], isMalformed: false }
  if (typeof value === 'string') {
    // A comma-separated string is a common hand-authored mistake for a list.
    const groups = value.split(',').map((group) => group.trim()).filter(Boolean)
    return { groups: [...new Set(groups)], isMalformed: groups.length === 0 }
  }
  if (Array.isArray(value)) {
    if (value.some((group) => typeof group !== 'string')) return { groups: [], isMalformed: true }
    const groups = value.map((group: string) => group.trim()).filter(Boolean)
    // `groups: [""]` names a group nobody can hold: malformed, never open.
    return { groups: [...new Set(groups)], isMalformed: value.length > 0 && groups.length === 0 }
  }
  return { groups: [], isMalformed: true }
}

function accessFrom(groupsValue: unknown, publicValue: unknown, where: string): MintlifyAccess {
  const groups = parseGroups(groupsValue)
  const visibility = parsePublic(publicValue)
  const problem = groups.isMalformed
    ? `${where} \`groups\` is not a list of group names`
    : visibility.isMalformed ? `${where} \`public\` is neither true nor false` : undefined
  return {
    ...(groups.groups.length > 0 ? { groups: groups.groups } : {}),
    ...(visibility.isPublic !== undefined ? { isPublic: visibility.isPublic } : {}),
    ...(problem ? { problem } : {}),
  }
}

/**
 * A page's own access frontmatter (Mintlify semantics, which Thally shares):
 * `groups` limits the page to those groups, `public: true` opens it,
 * `public: false` requires a signed-in reader. Key casing (`Groups:`) is not
 * read, as on Mintlify.
 */
export function frontmatterAccess(data: Record<string, unknown>): MintlifyAccess {
  return accessFrom(data.groups, data.public, 'frontmatter')
}

/** Whether access limits who may read a page (anything but open or `public: true`). */
export function isRestrictedAccess(access: { groups?: Array<string>; isPublic?: boolean; problem?: string }): boolean {
  return Boolean(access.problem) || (access.groups?.length ?? 0) > 0 || access.isPublic === false
}

const NAVIGATION_CONTAINER_KEYS = ['group', 'pages', 'tab', 'groups', 'page', 'root', 'menu', 'href']

/**
 * The access signals on a navigation group/tab, or undefined when it sets
 * none. Mintlify documents only `"public": true` on a group; `groups` (a list
 * of strings, never the nested navigation-group objects a tab also calls
 * `groups`) and `public: false` are honored as well so an authored
 * restriction is never published.
 */
export function navigationAccess(node: Record<string, unknown>): MintlifyAccess | undefined {
  const isContainer = (entry: unknown): boolean => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && NAVIGATION_CONTAINER_KEYS.some((key) => key in entry)
  // A tab also calls its nested navigation group objects `groups`, so an array
  // made only of such containers is navigation, not an access list. A mix of
  // containers and anything else is ambiguous and fails closed.
  const groups = Array.isArray(node.groups) && node.groups.length > 0 && node.groups.every(isContainer) ? undefined : node.groups
  const access = accessFrom(groups, node.public, 'its navigation container\'s')
  return Object.keys(access).length > 0 ? access : undefined
}

/** Why a navigation container restricts the pages below it, or undefined (never for `public: true` alone). */
export function navigationGateReason(node: Record<string, unknown>): string | undefined {
  const access = navigationAccess(node)
  if (!access || !isRestrictedAccess(access)) return undefined
  return access.problem ?? (access.groups ? 'its navigation container sets `groups`' : 'its navigation container sets `public: false`')
}

function intersect(left: Array<string> | undefined, right: Array<string> | undefined): Array<string> | undefined {
  if (!left) return right
  if (!right) return left
  return left.filter((group) => right.includes(group))
}

/**
 * Access one level deeper in navigation. Nested containers combine into the
 * strictest rule: the intersection of every group list (empty means nobody
 * qualifies, so it fails closed) and `public: false` anywhere on the path.
 */
export function descendNavigationAccess(outer: NavigationAccess, container: MintlifyAccess | undefined): NavigationAccess {
  if (!container) return outer
  const groups = intersect(outer.groups, container.groups)
  const problem = outer.problem ?? container.problem
    ?? (groups && groups.length === 0 ? 'nested navigation containers set `groups` that share no group' : undefined)
  return {
    ...(groups ? { groups } : {}),
    hasPublicFalse: outer.hasPublicFalse || container.isPublic === false,
    hasPublicTrue: outer.hasPublicTrue || container.isPublic === true,
    ...(problem ? { problem } : {}),
  }
}

/**
 * One page listed in several navigation places gets the strictest of them
 * (as the runtime merges the access of files serving one response): group
 * lists intersect, `public: false` anywhere wins, and `public: true` holds
 * only when every appearance is under a `public: true` container.
 */
export function mergeNavigationAppearances(appearances: ReadonlyArray<NavigationAccess>): NavigationAccess {
  if (appearances.length === 0) return OPEN_NAVIGATION_ACCESS
  let groups: Array<string> | undefined
  for (const appearance of appearances) groups = intersect(groups, appearance.groups)
  const problem = appearances.find((appearance) => appearance.problem)?.problem
    ?? (groups && groups.length === 0 ? 'it is listed under navigation containers whose `groups` share no group' : undefined)
  return {
    ...(groups ? { groups } : {}),
    hasPublicFalse: appearances.some((appearance) => appearance.hasPublicFalse),
    hasPublicTrue: appearances.every((appearance) => appearance.hasPublicTrue),
    ...(problem ? { problem } : {}),
  }
}

/** Whether any container on the path sets an access rule, `public: true` included. */
export function hasNavigationRules(access: NavigationAccess): boolean {
  return isNavigationRestricted(access) || access.hasPublicTrue
}

/** Whether navigation restricts a page listed under it. */
export function isNavigationRestricted(access: NavigationAccess): boolean {
  return Boolean(access.problem) || (access.groups?.length ?? 0) > 0 || access.hasPublicFalse
}

/**
 * The access a page migrates with: its own frontmatter combined with the
 * containers above it. Groups intersect (an empty intersection fails closed);
 * `public: false` from either wins; a container's `public: true` is stamped
 * only on a page that names no groups and is not itself `public: false`.
 */
export function resolvePageAccess(own: MintlifyAccess, navigation: NavigationAccess): PageAccessVerdict {
  const problem = own.problem ?? navigation.problem
  if (problem) return { problem }
  const groups = intersect(own.groups, navigation.groups)
  if (groups && groups.length === 0) {
    return { problem: 'its frontmatter `groups` and its navigation container\'s `groups` share no group' }
  }
  const isPublic = own.isPublic === false || navigation.hasPublicFalse
    ? false
    : own.isPublic === true || (navigation.hasPublicTrue && !groups) ? true : undefined
  return { access: { ...(groups ? { groups } : {}), ...(isPublic !== undefined ? { isPublic } : {}) } }
}

const CONFIG_BASENAME = /(?:^|[.-])(?:config|rc)\.[cm]?js$|^(?:tailwind|postcss|next|eslint|prettier|babel|webpack|vite|vitest|jest|rollup|gulpfile|gruntfile|stylelint|commitlint|lint-staged|svgo|metro)[.-]/i
const BUILD_OUTPUT_SEGMENTS = new Set(['dist', 'build', 'coverage'])
const FONT_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.otf'])

/**
 * Mintlify serves every `.css` and `.js` file in the content directory
 * site-wide. Tooling config files and build output are not part of that, and
 * (unlike Mintlify) are never published.
 */
export function isMintlifyServedScriptOrStyle(relativePath: string): boolean {
  const extension = extname(relativePath).toLowerCase()
  if (extension !== '.css' && extension !== '.js') return false
  const segments = relativePath.split('/')
  if (segments.slice(0, -1).some((segment) => BUILD_OUTPUT_SEGMENTS.has(segment.toLowerCase()))) return false
  return extension === '.css' || !CONFIG_BASENAME.test(segments[segments.length - 1])
}

export interface MintlifyFontSource {
  family: string
  /** Value as authored. */
  source: string
  /** Content-relative path when the source is a local file, else null. */
  path: string | null
  remote: boolean
}

/** A font file served by Google Fonts itself: Thally loads that font by family, so its `source` changes nothing. */
const GOOGLE_FONT_SOURCE = /^https?:\/\/fonts\.(?:googleapis|gstatic)\.com\//i

/**
 * Whether docs.json `fonts` gives a font its own file (`source`, which Mintlify takes for a font hosted
 * elsewhere or kept in the docs folder), as opposed to a Google font named by family. Thally's `fonts`
 * setting is Google-only, so a family with such a source cannot be named there: Google has no font of that name.
 */
export function isSelfHostedFontSource(source: unknown): boolean {
  return typeof source === 'string' && source.trim() !== '' && !GOOGLE_FONT_SOURCE.test(source.trim())
}

/**
 * The one warning for a self-hosted font that was not applied, with `detail` for what became of its file.
 * Naming the family would make every page ask Google Fonts for it, which fails, so no family is set.
 */
export function selfHostedFontWarning(family: string, detail: string): MigrationWarning {
  return {
    code: 'unsupported-config',
    message: `Self-hosted font "${family}" was not applied: Thally's docs.json fonts setting loads Google Fonts by family name, and a font you host yourself is not on Google Fonts, so naming it would make every page request a font that cannot load. No font family was set and the default font is used; ${detail}. To use it, add an @font-face rule for it to a stylesheet in public/, list that stylesheet under "stylesheets" in docs.json, and set --font-heading (headings) or --font-sans (body text) to its family. Thally Cloud site settings can also load a custom font file.`,
  }
}

/** Self-hosted font references from docs.json `fonts` (top level, `heading`, `body`). */
export function mintlifyFontSources(config: Record<string, unknown> | null): Array<MintlifyFontSource> {
  const fonts = objectValue(config?.fonts)
  if (!fonts) return []
  const found: Array<MintlifyFontSource> = []
  for (const entry of [fonts, objectValue(fonts.heading), objectValue(fonts.body)]) {
    if (!entry || !isSelfHostedFontSource(entry.source)) continue
    const source = (entry.source as string).trim()
    const family = typeof entry.family === 'string' ? entry.family : 'a font'
    const remote = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)
    // A leading slash is relative to the content root, as on Mintlify; the
    // path is only accepted when it stays traversal-free and is a font file.
    const path = remote || /^[a-z]:[\\/]/i.test(source) ? null : normalizeAssetPath(source)
    found.push({ family, source, path: path && FONT_EXTENSIONS.has(extname(path).toLowerCase()) ? path : null, remote })
  }
  return found
}

/**
 * `appearance.default` / `appearance.strict`, with legacy `modeToggle`
 * (`default`, `isHidden`) as fallback per field. docs.json wins when both
 * define a field; invalid values are skipped with a warning.
 */
export function mintlifyAppearance(
  config: Record<string, unknown>,
  warnings: Array<MigrationWarning>,
): NonNullable<MigrationDocsConfig['appearance']> {
  const appearance = objectValue(config.appearance)
  const legacy = objectValue(config.modeToggle)
  const result: NonNullable<MigrationDocsConfig['appearance']> = {}
  const isMode = (value: unknown): value is 'system' | 'light' | 'dark' =>
    value === 'system' || value === 'light' || value === 'dark'
  const skip = (field: string, value: unknown): void => {
    warnings.push({
      code: 'unsupported-config',
      message: `Ignored invalid ${field} value ${JSON.stringify(value)?.slice(0, 40)}; the appearance default was left unchanged.`,
    })
  }
  if (appearance?.default !== undefined) {
    if (isMode(appearance.default)) result.default = appearance.default
    else skip('appearance.default', appearance.default)
  } else if (legacy?.default !== undefined) {
    if (isMode(legacy.default)) result.default = legacy.default
    else skip('modeToggle.default', legacy.default)
  }
  if (appearance?.strict !== undefined) {
    if (typeof appearance.strict === 'boolean') {
      if (appearance.strict) result.showToggle = false
    } else skip('appearance.strict', appearance.strict)
  } else if (legacy?.isHidden !== undefined) {
    if (typeof legacy.isHidden === 'boolean') {
      if (legacy.isHidden) result.showToggle = false
    } else skip('modeToggle.isHidden', legacy.isHidden)
  }
  return result
}

/**
 * Mintlify's playground display mode. `auth` shows the playground only to signed-in
 * readers; Thally has no reader sign-in, so it is carried as `simple` (no playground).
 */
export function playgroundDisplay(value: unknown, where: string, warn?: (message: string) => void): 'interactive' | 'simple' | 'none' | undefined {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (mode === 'interactive' || mode === 'simple' || mode === 'none') return mode
  if (mode === 'auth') {
    warn?.(`${where} "auth" requires reader sign-in, which Thally does not support. Migrated as "simple" (no Try it). Set it to "interactive" to allow everyone.`)
    return 'simple'
  }
  warn?.(`${where} is not one of interactive, simple, none, auth and was dropped.`)
  return undefined
}
