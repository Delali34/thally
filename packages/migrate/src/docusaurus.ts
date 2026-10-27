/**
 * Static Docusaurus repository projection. Sidebar modules are attacker-owned
 * source files, so this adapter reads only JSON5-compatible object literals and
 * never imports, evaluates, or executes JavaScript/TypeScript configuration.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { extname, posix } from 'node:path'

import postcss from 'postcss'
import { cssColorToHex } from './css-colors.js'
import { announcementMarkdown } from './fern.js'
import JSON5 from 'json5'
import ts from 'typescript'
import { parse as parseYaml } from 'yaml'

import type { MarkdownPageIdentity } from './mdx.js'
import { isRedirectPathSafe, translateRedirectWildcards } from './navigation.js'
import { skippedRedirectsWarning } from './redirects.js'
import { pageIdFromReference, resolveWithin, slugifySegment, withinRealRoot } from './path.js'
import type {
  MigrationDocsConfig,
  MigrationNavigationGroup,
  MigrationPage,
  MigrationWarning,
} from './types.js'

const MAX_CONFIG_BYTES = 20_000_000
const CATEGORY_FILENAMES = ['_category_.json', '_category_.yml', '_category_.yaml']
const SIDEBAR_FILENAMES = [
  'sidebars.json',
  'sidebars.js',
  'sidebars.cjs',
  'sidebars.mjs',
  'sidebars.ts',
]

export interface DocusaurusPageDescriptor {
  sourcePath: string
  docId: string
  navigationId: string
  sidebarPosition?: number
  /** Frontmatter `unlisted`: the page is served but never shown in a sidebar. */
  unlisted?: boolean
  title: string
}

export interface DocusaurusSidebars {
  config: Record<string, unknown>
  sourcePath: string
}

export interface DocusaurusNavigationResult {
  docsConfig: MigrationDocsConfig
  generatedPages: Array<MigrationPage>
  referencedNavigationIds: Set<string>
  warnings: Array<MigrationWarning>
}

interface ProjectionContext {
  contentRoot: string
  descriptors: Array<DocusaurusPageDescriptor>
  descriptorByDocId: Map<string, DocusaurusPageDescriptor>
  generatedPages: Array<MigrationPage>
  generatedIds: Set<string>
  referencedNavigationIds: Set<string>
  sourceUrl: string
  routePrefix: string
  sidebarSource: string
  warnings: Array<MigrationWarning>
}

interface CategoryMetadata {
  label?: string
  position?: number
  link?: unknown
}

/** Identifiers may contain `$`, which is an anchor in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stripNumberPrefix(value: string): string {
  return value.replace(/^\d+[-_]+/, '')
}

function normalizeDocId(value: string): string {
  return value
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.(?:mdx?)$/i, '')
    .split('/')
    .filter(Boolean)
    .map(stripNumberPrefix)
    .join('/')
}

function docusaurusSlugifySegment(value: string): string {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // Malformed escapes remain literal input and are normalized safely below.
  }
  const slug = decoded
    .replace(/\.(?:html?|mdx?)$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/(^-|-$)/g, '')
  // A dot segment (also spelled `%2e%2e`) must never reach a page id or file path.
  return slug === '.' || slug === '..' ? '' : slug
}

function docusaurusRouteId(value: string): string | null {
  const segments = normalizeDocId(value)
    .split('/')
    .map(docusaurusSlugifySegment)
    .filter(Boolean)
  return segments.join('/') || 'introduction'
}

function defaultDocusaurusRouteId(value: string): string | null {
  const segments = normalizeDocId(value).split('/').filter(Boolean)
  if (/^(?:index|readme)$/i.test(segments.at(-1) ?? '')) segments.pop()
  const normalized = segments.map(docusaurusSlugifySegment).filter(Boolean)
  return normalized.join('/') || 'introduction'
}

function storageIdForRoute(routeId: string): string {
  return /(?:^|\/)(?:index|readme)$/i.test(routeId) ? `${routeId}/index` : routeId
}

function titleCase(value: string): string {
  return stripNumberPrefix(value)
    .replace(/sidebar$/i, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => ['api', 'cli', 'sdk', 'ui'].includes(word.toLowerCase())
      ? word.toUpperCase()
      : word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function routeFromSlug(slug: string, fallback: string, sourceDirectory?: string): string | null {
  if (slug === '/') return 'introduction'
  if (slug.startsWith('/')) return docusaurusRouteId(slug)
  const fallbackDirectory = sourceDirectory ?? (fallback === 'introduction' ? '' : posix.dirname(fallback))
  const resolved = posix.normalize(posix.join(fallbackDirectory, slug))
  if (resolved === '..' || resolved.startsWith('../')) return null
  return docusaurusRouteId(resolved)
}

/** Resolve Docusaurus `id`, `slug`, and numeric-prefix semantics once. */
export function resolveDocusaurusPageIdentity(
  sourcePath: string,
  frontmatter: Record<string, unknown>,
  fallback: MarkdownPageIdentity,
): { identity: MarkdownPageIdentity; descriptor: Omit<DocusaurusPageDescriptor, 'title'> } {
  const sourceDocId = normalizeDocId(sourcePath)
  const sourceDirectory = posix.dirname(sourceDocId)
  const configuredId = typeof frontmatter.id === 'string' && frontmatter.id.trim()
    ? stripNumberPrefix(frontmatter.id.trim())
    : null
  const docId = configuredId
    ? normalizeDocId(sourceDirectory === '.' ? configuredId : posix.join(sourceDirectory, configuredId))
    : sourceDocId
  // Docusaurus collapses a source `index` document by default, but an explicit
  // `slug: index` remains a literal route. Keep those two cases distinct.
  const defaultNavigationId = defaultDocusaurusRouteId(docId) ?? fallback.navigationId
  const configuredSlug = typeof frontmatter.slug === 'string' ? frontmatter.slug.trim() : ''
  const navigationId = configuredSlug
    ? routeFromSlug(
        configuredSlug,
        defaultNavigationId,
        sourceDirectory === '.' ? '' : sourceDirectory,
      ) ?? defaultNavigationId
    : defaultNavigationId
  const position = typeof frontmatter.sidebar_position === 'number'
    && Number.isFinite(frontmatter.sidebar_position)
    ? frontmatter.sidebar_position
    : undefined
  return {
    identity: { id: storageIdForRoute(navigationId), navigationId },
    descriptor: {
      sourcePath: sourcePath.replace(/\\/g, '/'),
      docId,
      navigationId,
      ...(position === undefined ? {} : { sidebarPosition: position }),
      ...(isUnlisted(frontmatter.unlisted) ? { unlisted: true } : {}),
    },
  }
}

/** Anything but an explicit false counts as unlisted; hiding a page from navigation is the safe reading. */
function isUnlisted(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false
    && !(typeof value === 'string' && ['', 'false'].includes(value.trim().toLowerCase()))
}

function sourceReferenceKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.(?:mdx?)$/i, '').replace(/\/$/, '')
}

interface SourceHeading {
  index: number
  level: number
  id: string | null
}

function sourceHeadings(body: string): Array<SourceHeading> {
  const headings: Array<SourceHeading> = []
  const lines = body.split('\n')
  let fence: string | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
        && /^\s*$/.test(line.slice(marker[0].length))) fence = null
      continue
    }
    if (fence) continue
    const heading = line.match(/^ {0,3}(#{2,6})\s+(.+?)\s*#*\s*$/)
    if (!heading) continue
    const preceding = lines[index - 1]?.match(/^<a id="([\p{L}\p{N}_.:$-]{1,120})"><\/a>$/u)
    // The runtime extracts rendered heading text from MDX elements. Only
    // plain text can be mapped reliably without evaluating authored MDX.
    const plainText = !/[<>{}\[\]`*_]/.test(heading[2])
    const generatedId = plainText
      ? heading[2].normalize('NFC').toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/(^-|-$)/g, '')
      : null
    headings.push({ index, level: heading[1].length, id: preceding?.[1] ?? generatedId })
  }
  return headings
}

/**
 * Preserve original-language fragments in translated Docusaurus pages when
 * their heading outlines are identical. An inserted alias never replaces an
 * explicit translated ID, and ambiguous or edited outlines are left alone.
 */
export function addDocusaurusTranslatedHeadingAliases(pages: Array<MigrationPage>): void {
  const byRoute = new Map(pages.map((page) => [page.navigationId, page]))
  for (const page of pages) {
    const locale = page.source.match(/(?:^|[/#])i18n\/([A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*)\/docusaurus-plugin-content-docs\//)?.[1]
    if (!locale) continue
    const originalRoute = page.navigationId === locale ? 'introduction'
      : page.navigationId.startsWith(`${locale}/`) ? page.navigationId.slice(locale.length + 1) : null
    if (!originalRoute) continue
    const original = byRoute.get(originalRoute)
    if (!original) continue
    const originalHeadings = sourceHeadings(original.body)
    const translatedHeadings = sourceHeadings(page.body)
    if (!originalHeadings.length || originalHeadings.length !== translatedHeadings.length
      || originalHeadings.some((heading, index) => heading.level !== translatedHeadings[index].level)) continue

    const occupied = new Set(translatedHeadings.map((heading) => heading.id).filter((id): id is string => !!id))
    for (const match of page.body.matchAll(/<a\s+id="([^"]+)"/g)) occupied.add(match[1])
    const originalIdCounts = new Map<string, number>()
    for (const heading of originalHeadings) {
      if (heading.id) originalIdCounts.set(heading.id, (originalIdCounts.get(heading.id) ?? 0) + 1)
    }
    const aliases = new Map<number, string>()
    for (let index = 0; index < originalHeadings.length; index++) {
      const id = originalHeadings[index].id
      if (!id || occupied.has(id) || originalIdCounts.get(id) !== 1) continue
      aliases.set(translatedHeadings[index].index, id)
      occupied.add(id)
    }
    if (aliases.size) page.body = page.body.split('\n').flatMap((line, index) => {
      const alias = aliases.get(index)
      return alias ? [`<a id="${alias}"></a>`, line] : [line]
    }).join('\n')
  }
}

/** Fill Docusaurus category card lists from the sidebar tree they summarize. */
export function expandDocusaurusDocCardLists(
  pages: Array<MigrationPage>,
  config: MigrationDocsConfig,
  sourceRoutes: ReadonlySet<string>,
): void {
  const pageByRoute = new Map(pages.map((page) => [page.navigationId, page]))
  const containsRoute = (items: Array<string | MigrationNavigationGroup>, route: string): boolean =>
    items.some((item) => typeof item === 'string'
      ? item === route
      : containsRoute(item.pages, route))
  const findGroup = (items: Array<string | MigrationNavigationGroup>, route: string): MigrationNavigationGroup | undefined => {
    for (const item of items) {
      if (typeof item === 'string' || !containsRoute(item.pages, route)) continue
      return findGroup(item.pages, route) ?? item
    }
    return undefined
  }
  const firstRoute = (items: Array<string | MigrationNavigationGroup>): string | undefined => {
    for (const item of items) {
      if (typeof item === 'string') return item
      const candidate = firstRoute(item.pages)
      if (candidate) return candidate
    }
    return undefined
  }
  for (const page of pages) {
    if (!sourceRoutes.has(page.navigationId)) continue
    const group = config.tabs.map((tab) => findGroup([
      ...(tab.pages ?? []),
      ...(tab.groups ?? []),
    ], page.navigationId)).find(Boolean)
    if (!group) {
      page.body = page.body.replace(/<div data-thally-doc-card-list=""\s*\/>/g, '')
      continue
    }
    const cards = group.pages.flatMap((item) => {
      if (typeof item === 'string') {
        if (item === page.navigationId) return []
        const target = pageByRoute.get(item)
        return [{ title: target?.title ?? item.split('/').at(-1) ?? item, route: item }]
      }
      const slug = slugifySegment(item.group)
      const routes = [...item.pages].flatMap((child) => typeof child === 'string' ? [child] : [])
      const route = routes.find((candidate) => candidate === slug || candidate.endsWith(`/${slug}`))
        ?? firstRoute(item.pages)
      return route ? [{ title: item.group, route }] : []
    })
    const markup = cards.length
      ? `<CardGroup>\n${cards.map(({ title, route }) => `  <Card title={${JSON.stringify(title)}} href={${JSON.stringify(`/${route === 'introduction' ? '' : route}`)}} />`).join('\n')}\n</CardGroup>`
      : ''
    page.body = page.body.replace(/<div data-thally-doc-card-list=""\s*\/>/g, markup)
    if (markup && !page.body.includes(markup)) page.body = [page.body.trim(), markup].filter(Boolean).join('\n\n')
  }
}

/**
 * Rewrite Docusaurus file/doc-id links after every final slug is known. This is
 * deliberately line based so examples inside fenced code remain byte-for-byte
 * source content. A link whose `#fragment` uses a case-preserved heading id
 * (live Docusaurus keeps case intact; Thally always lowercases its auto-slug)
 * is left as-is here — `preserveDocusaurusLinkedAnchors` (repository.ts)
 * repairs those afterward by adding an explicit anchor matching the literal
 * fragment, which also covers repeated table-field ids that this
 * path-only resolver has no visibility into.
 */
export function rewriteDocusaurusLinks(
  body: string,
  current: DocusaurusPageDescriptor,
  descriptors: Array<DocusaurusPageDescriptor>,
  options: {
    sourceOrigin?: string
    onExternalLink?: (target: string) => void
    /** Copy destinations, without a leading slash, after asset budgeting. */
    assetPaths?: ReadonlySet<string>
  } = {},
): string {
  const routes = new Map<string, string>()
  for (const descriptor of descriptors) {
    const sourceKey = sourceReferenceKey(descriptor.sourcePath)
    routes.set(sourceKey, descriptor.navigationId)
    routes.set(sourceReferenceKey(descriptor.docId), descriptor.navigationId)
    routes.set(sourceReferenceKey(descriptor.navigationId), descriptor.navigationId)
    const sourceRoute = pageIdFromReference(sourceKey)
    if (sourceRoute) routes.set(sourceRoute, descriptor.navigationId)
  }
  const currentDirectory = posix.dirname(sourceReferenceKey(current.sourcePath))

  function copiedAssetTarget(target: string): string | null {
    if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return null
    const suffixIndex = target.search(/[?#]/)
    const path = suffixIndex >= 0 ? target.slice(0, suffixIndex) : target
    const suffix = suffixIndex >= 0 ? target.slice(suffixIndex) : ''
    if (path.startsWith('/docs/') && options.assetPaths?.has(path.slice('/docs/'.length))) {
      return `/${path.slice('/docs/'.length)}${suffix}`
    }
    return options.assetPaths?.has(path.slice(1)) ? target : null
  }

  function rewriteTarget(target: string): string {
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return target
    if (target.startsWith('#')) return target
    const suffixIndex = target.search(/[?#]/)
    const path = suffixIndex >= 0 ? target.slice(0, suffixIndex) : target
    const suffix = suffixIndex >= 0 ? target.slice(suffixIndex) : ''
    // Docusaurus sites often publish `static/img/foo` as `/img/foo` while
    // authors refer to it as `/docs/img/foo`. Strip the docs mount only after
    // the copy pass proves the resulting asset exists.
    const copiedAsset = copiedAssetTarget(target)
    if (copiedAsset) return copiedAsset
    const candidates = path.startsWith('/')
      ? [
          sourceReferenceKey(path),
          sourceReferenceKey(path).replace(/^docs\//, ''),
          sourceReferenceKey(path).replace(/^docs\/(?:next|current|latest)\//, ''),
        ]
      : [
          sourceReferenceKey(posix.normalize(posix.join(currentDirectory, path))),
          sourceReferenceKey(path),
        ]
    const route = candidates.map((candidate) => routes.get(candidate)).find(Boolean)
    if (!route) {
      if (path.startsWith('/') && path !== '/' && options.sourceOrigin) {
        options.onExternalLink?.(target)
        return new URL(target, options.sourceOrigin).toString()
      }
      return target
    }
    return `${route === 'introduction' ? '/' : `/${route}`}${suffix}`
  }

  let codeFence: string | null = null
  return body.split('\n').map((line) => {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (!codeFence) codeFence = fence[1]
      else if (fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length
        && /^\s*$/.test(line.slice(fence[0].length))) codeFence = null
      return line
    }
    if (codeFence) return line
    return line
      .replace(/(\]\()([^\s)]+)(?=[\s)]|$)/g, (_match, prefix: string, target: string) => `${prefix}${rewriteTarget(target)}`)
      .replace(/(\bhref=")([^"]+)(")/g, (_match, prefix: string, target: string, suffix: string) => `${prefix}${rewriteTarget(target)}${suffix}`)
      .replace(/(\bsrc=")([^"]+)(")/g, (_match, prefix: string, target: string, suffix: string) => `${prefix}${copiedAssetTarget(target) ?? target}${suffix}`)
      // Markdown reference links carry their destination in a later
      // definition line. Docusaurus resolves `[label]` through that line, so
      // rewriting only inline links leaves an apparently working link in the
      // content whose click still goes to `/page.md` and 404s on Thally.
      .replace(/^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]+>|\S+)/, (_match, prefix: string, destination: string) => {
        const bracketed = destination.startsWith('<') && destination.endsWith('>')
        const target = bracketed ? destination.slice(1, -1) : destination
        const rewritten = rewriteTarget(target)
        return `${prefix}${bracketed ? `<${rewritten}>` : rewritten}`
      })
  }).join('\n')
}

/** Read a static Docusaurus site origin for links outside imported docs. */
export function readDocusaurusSiteOrigin(repositoryRoot: string): string | undefined {
  const configPath = findDocusaurusConfigPath(repositoryRoot)
  if (!configPath) return undefined
  const address = readBoundedText(configPath).match(/\burl['"]?\s*:\s*(['"])(https?:\/\/[^'"]+)\1/)?.[2]
  if (!address) return undefined
  try {
    return new URL(address).origin
  } catch {
    return undefined
  }
}

function readBoundedText(path: string): string {
  if (lstatSync(path).size > MAX_CONFIG_BYTES) {
    throw new Error('The Docusaurus sidebar config is larger than 20 MB and could not be imported.')
  }
  return readFileSync(path, 'utf8')
}

/**
 * Index object and block braces with TypeScript's parser, without evaluating
 * source. Regex literals and template strings need JavaScript lexical context;
 * a character scanner can mistake their quotes for an unterminated string.
 * Parsing once and walking the syntax tree once keeps candidate lookups linear
 * in total. Bare object fragments parse as blocks, so index those as well.
 */
function braceTable(source: string): Map<number, number> {
  const table = new Map<number, number>()
  try {
    const tree = ts.createSourceFile('config.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
    const pending: Array<ts.Node> = [tree]
    while (pending.length > 0) {
      const node = pending.pop()!
      if (ts.isObjectLiteralExpression(node) || ts.isBlock(node)) {
        const start = node.getStart(tree)
        const end = node.end - 1
        // Recovery nodes can have a synthetic closing brace; only real source
        // delimiters may become configuration passed to JSON5.
        if (source[start] === '{' && source[end] === '}') table.set(start, end)
      }
      ts.forEachChild(node, (child) => { pending.push(child) })
    }
  } catch {
    // Excessively nested or malformed syntax is unsupported configuration.
  }
  return table
}

let lastBraceSource: string | undefined
let lastBraceTable = new Map<number, number>()

/** The object literal starting at `start` (after whitespace and comments), or null when none starts there or it never closes. */
function matchingObjectLiteral(source: string, start: number): string | null {
  let index = start
  while (index < source.length) {
    if (/\s/.test(source[index])) index++
    else if (source.startsWith('//', index)) { const end = source.indexOf('\n', index); index = end < 0 ? source.length : end + 1 }
    else if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2 }
    else break
  }
  if (source[index] !== '{') return null
  if (lastBraceSource !== source) {
    lastBraceSource = source
    lastBraceTable = braceTable(source)
  }
  const end = lastBraceTable.get(index)
  return end === undefined ? null : source.slice(index, end + 1)
}

function parseStaticSidebarModule(source: string): Record<string, unknown> {
  const bindings = new Map<string, Record<string, unknown>>()
  const normalizedSource = replaceExternalFbContent(source)
  const parseFailures: Array<string> = []
  const assignmentPatterns = [
    /\bmodule\.exports\s*=\s*/g,
    /\bexport\s+default\s*/g,
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:\s*(?:(?!\b(?:const|let|var)\b)[^=;])+)?\s*=\s*/g,
  ]
  const candidates = assignmentPatterns.flatMap((pattern) => [...normalizedSource.matchAll(pattern)])
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))

  for (const candidate of candidates) {
    const literal = matchingObjectLiteral(normalizedSource, (candidate.index ?? 0) + candidate[0].length)
    if (!literal) continue
    try {
      const substituted = [...bindings].reduce(
        (value, [name, binding]) => value.replace(
          new RegExp(`(:\\s*)${escapeRegExp(name)}(?![\\w$])`, 'g'),
          (_match, prefix: string) => `${prefix}${JSON.stringify(binding)}`,
        ),
        literal,
      )
      const parsed = JSON5.parse(substituted) as unknown
      const object = objectValue(parsed)
      if (!object) continue
      const bindingName = candidate[0].match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)?.[1]
      if (bindingName) {
        bindings.set(bindingName, object)
        continue
      }
      return object
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const line = Number(message.match(/at (\d+):/)?.[1] ?? 0)
      const context = line > 0 ? literal.split('\n').slice(Math.max(0, line - 2), line + 1).join(' ') : ''
      parseFailures.push(`${message}${context ? ` near ${context}` : ''}`)
      // Try the next assignment. Expressions and function calls are rejected.
    }
  }
  const exportedBinding = normalizedSource.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/)?.[1]
    ?? normalizedSource.match(/\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\b/)?.[1]
  if (exportedBinding && bindings.has(exportedBinding)) return bindings.get(exportedBinding)!
  throw new Error(`Sidebar config is executable or outside the supported data-only syntax.${parseFailures[0] ? ` ${parseFailures[0]}` : ''}`)
}

function replaceExternalFbContent(source: string): string {
  const marker = '...fbContent('
  let output = ''
  let cursor = 0
  let searchFrom = 0
  while (true) {
    const start = source.indexOf(marker, searchFrom)
    if (start < 0) return `${output}${source.slice(cursor)}`.replace(/,\s*,/g, ',')
    const objectStart = source.indexOf('{', start + marker.length)
    if (objectStart < 0) return `${output}${source.slice(cursor)}`
    const objectLiteral = matchingObjectLiteral(source, objectStart)
    if (!objectLiteral) {
      searchFrom = start + marker.length
      continue
    }
    const close = source.indexOf(')', objectStart + objectLiteral.length)
    if (close < 0) return `${output}${source.slice(cursor)}`
    const externalMatch = /\bexternal\s*:\s*/g.exec(objectLiteral)
    let replacement = ''
    if (externalMatch) {
      const arrayStart = objectLiteral.indexOf('[', externalMatch.index + externalMatch[0].length)
      if (arrayStart >= 0) {
        const array = matchingArrayLiteral(objectLiteral, arrayStart)
        if (array) replacement = array.slice(1, -1)
      }
    }
    let replaceEnd = close + 1
    if (!replacement) {
      const trailingComma = /\s*,/y
      trailingComma.lastIndex = replaceEnd
      const found = trailingComma.exec(source)
      if (found) replaceEnd += found[0].length
    }
    output += `${source.slice(cursor, start)}${replacement}`
    cursor = replaceEnd
    searchFrom = replaceEnd
  }
}

function matchingArrayLiteral(source: string, start: number): string | null {
  let depth = 0
  let quote = ''
  let isEscaped = false
  for (let index = start; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (isEscaped) isEscaped = false
      else if (character === '\\') isEscaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      if (end < 0) return null
      index = end
      continue
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) return null
      index = end + 1
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '[') depth++
    if (character === ']' && --depth === 0) return source.slice(start, index + 1)
  }
  return null
}

function configuredSidebarPath(repositoryRoot: string): string | null {
  for (const filename of ['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs']) {
    const path = resolveWithin(repositoryRoot, filename)
    if (!existsSync(path)) continue
    const source = readBoundedText(path)
    // A site can register other docs plugins before the classic preset. Their
    // sidebarPath belongs to a different content root (Docusaurus registers
    // its community plugin before the main docs preset, for example).
    for (const docs of source.matchAll(/\bdocs\s*:\s*/g)) {
      const object = matchingObjectLiteral(source, (docs.index ?? 0) + docs[0].length)
      const candidate = object && staticStringField(object, 'sidebarPath')?.replace(/^\.\//, '')
      if (candidate) {
        const resolved = withinRealRoot(resolveWithin(repositoryRoot, candidate), repositoryRoot)
        if (existsSync(resolved) && lstatSync(resolved).isFile()) return candidate
      }
    }
    const match = source.match(/\bsidebarPath\s*:\s*(?:require\.resolve\(\s*)?(['"])([^'"]+)\1/)
    if (!match) continue
    const candidate = match[2].replace(/^\.\//, '')
    const resolved = withinRealRoot(resolveWithin(repositoryRoot, candidate), repositoryRoot)
    if (existsSync(resolved) && lstatSync(resolved).isFile()) return candidate
  }
  return null
}

/** Read the configured/default sidebar without running the source module. */
export function readDocusaurusSidebars(repositoryRoot: string, versionedSidebarPath?: string): DocusaurusSidebars | null {
  // Archived versions carry their own sidebar file. Resolve it within the
  // project and parse it as data; never load source-controlled code.
  const configured = versionedSidebarPath ?? configuredSidebarPath(repositoryRoot)
  const sourcePath = [configured, ...(versionedSidebarPath ? [] : SIDEBAR_FILENAMES)]
    .filter((value): value is string => Boolean(value))
    .find((candidate) => {
      const path = withinRealRoot(resolveWithin(repositoryRoot, candidate), repositoryRoot)
      return existsSync(path) && lstatSync(path).isFile()
    })
  if (!sourcePath) return null
  const absolutePath = withinRealRoot(resolveWithin(repositoryRoot, sourcePath), repositoryRoot)
  const source = readBoundedText(absolutePath)
  const parsed = extname(sourcePath).toLowerCase() === '.json'
    ? objectValue(JSON5.parse(source))
    : parseStaticSidebarModule(source)
  if (!parsed) throw new Error('Docusaurus sidebar config must export an object.')
  return { config: parsed, sourcePath }
}

function namedExportObjectLiteralText(source: string, name: string): string | null {
  const normalizedSource = replaceExternalFbContent(source)
  const match = new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${escapeRegExp(name)}(?![\\w$])(?:\\s*:\\s*(?:(?!\\b(?:const|let|var)\\b)[^=;])+)?\\s*=\\s*`).exec(normalizedSource)
  if (!match) return null
  return matchingObjectLiteral(normalizedSource, match.index + match[0].length)
}

/**
 * Pluck just the `redirects: [...]` array out of a plugin options object's
 * literal text, rather than `JSON5.parse`-ing the whole object — the Oasis
 * shape (a real, reproduced example) has a sibling `createRedirects(...) {
 * ... }` method in the same object literal, which is not valid JSON5 and
 * would otherwise fail the whole object and lose the `redirects` array too.
 */
function redirectEntriesFromObjectLiteralText(
  objectLiteral: string,
  warnings: Array<MigrationWarning>,
): Array<{ source: string; destination: string }> {
  const match = /\bredirects\s*:\s*/.exec(objectLiteral)
  if (!match) return []
  const arrayStart = objectLiteral.indexOf('[', match.index + match[0].length)
  if (arrayStart < 0) return []
  const arrayLiteral = matchingArrayLiteral(objectLiteral, arrayStart)
  if (!arrayLiteral) return []
  let parsed: unknown
  try {
    parsed = JSON5.parse(arrayLiteral)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const entries: Array<{ source: string; destination: string }> = []
  const unsafeRedirects: Array<string> = []
  for (const raw of parsed) {
    const entry = objectValue(raw)
    if (!entry || typeof entry.to !== 'string') continue
    const froms = Array.isArray(entry.from) ? entry.from : [entry.from]
    for (const from of froms) {
      if (typeof from !== 'string') continue
      if (!isRedirectPathSafe(from, entry.to)) {
        unsafeRedirects.push(from)
        continue
      }
      const translated = translateRedirectWildcards(from, entry.to)
      if ('warning' in translated) {
        warnings.push({ code: 'unsupported-config', message: translated.warning })
        continue
      }
      entries.push(translated)
    }
  }
  const unsafeRedirectWarning = skippedRedirectsWarning(unsafeRedirects)
  if (unsafeRedirectWarning) warnings.push(unsafeRedirectWarning)
  return entries
}

/**
 * Parse a `@docusaurus/plugin-client-redirects` `Options` object: either an
 * object literal written inline in the plugin's config entry, or (Oasis's
 * shape) a named export in a separate module the config imports, e.g.
 * `redirects.ts` exporting `redirectsOptions`. Only a literal `redirects:
 * [{ from, to }]` array is understood — `from` may be a single path or an
 * array of paths, both valid per the plugin's own docs. Its `createRedirects`
 * function computes redirects dynamically and can't be evaluated statically,
 * so its presence is warned about rather than silently ignored.
 */
export function readDocusaurusRedirects(
  repositoryRoot: string,
  warnings: Array<MigrationWarning>,
): Array<{ source: string; destination: string }> {
  const configPath = findDocusaurusConfigPath(repositoryRoot)
  if (!configPath) return []
  const configSource = readBoundedText(configPath)
  const pluginMatch = /['"]@docusaurus\/plugin-client-redirects['"]\s*,\s*/.exec(configSource)
  if (!pluginMatch) return []
  const afterPlugin = configSource.slice(pluginMatch.index + pluginMatch[0].length)
  const warnAboutCreateRedirects = (source: string): void => {
    if (!/\bcreateRedirects\s*[:(]/.test(source)) return
    warnings.push({
      code: 'unsupported-config',
      message: "The redirects plugin's createRedirects function computes redirects dynamically and cannot be evaluated during migration; add its redirects manually.",
    })
  }
  warnAboutCreateRedirects(configSource)
  // Case 1: the plugin's options object is written inline.
  const inlineLiteral = matchingObjectLiteral(configSource, pluginMatch.index + pluginMatch[0].length)
  if (inlineLiteral) return redirectEntriesFromObjectLiteralText(inlineLiteral, warnings)
  // Case 2: the options are an identifier imported from another module.
  const identifier = afterPlugin.match(/^([A-Za-z_$][\w$]*)/)?.[1]
  if (!identifier) return []
  const importMatch = new RegExp(`import\\s*\\{[^}]*(?<![\\w$])${escapeRegExp(identifier)}(?![\\w$])[^}]*\\}\\s*from\\s*(['"])([^'"]+)\\1`).exec(configSource)
    ?? new RegExp(`import\\s+${escapeRegExp(identifier)}\\s+from\\s*(['"])([^'"]+)\\1`).exec(configSource)
  const modulePath = importMatch?.[2]
  if (!modulePath || !modulePath.startsWith('.')) return []
  let resolvedPath: string | undefined
  try {
    resolvedPath = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs']
      .map((extension) => withinRealRoot(resolveWithin(repositoryRoot, `${modulePath.replace(/^\.\//, '')}${extension}`), repositoryRoot))
      .find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile())
  } catch {
    return []
  }
  if (!resolvedPath) return []
  const moduleSource = readBoundedText(resolvedPath)
  warnAboutCreateRedirects(moduleSource)
  const literal = namedExportObjectLiteralText(moduleSource, identifier)
  return literal ? redirectEntriesFromObjectLiteralText(literal, warnings) : []
}

function readCategoryMetadata(contentRoot: string, directory: string): CategoryMetadata {
  for (const filename of CATEGORY_FILENAMES) {
    const path = resolveWithin(contentRoot, posix.join(directory, filename))
    try { withinRealRoot(path, contentRoot) } catch { continue }
    if (!existsSync(path) || !lstatSync(path).isFile()) continue
    try {
      const raw = readBoundedText(path)
      const parsed = filename.endsWith('.json') ? JSON5.parse(raw) : parseYaml(raw)
      const object = objectValue(parsed)
      if (!object) return {}
      return {
        ...(typeof object.label === 'string' ? { label: object.label } : {}),
        ...(typeof object.position === 'number' ? { position: object.position } : {}),
        ...('link' in object ? { link: object.link } : {}),
      }
    } catch {
      return {}
    }
  }
  return {}
}

function descriptorSort(left: DocusaurusPageDescriptor, right: DocusaurusPageDescriptor): number {
  const leftPosition = left.sidebarPosition ?? Number.MAX_SAFE_INTEGER
  const rightPosition = right.sidebarPosition ?? Number.MAX_SAFE_INTEGER
  if (leftPosition !== rightPosition) return leftPosition - rightPosition
  return left.sourcePath.localeCompare(right.sourcePath, undefined, { numeric: true })
}

function registerDoc(docId: string, context: ProjectionContext, sourceDirectory?: string): string | null {
  const key = normalizeDocId(docId)
  // Category metadata lives beside its page, and Docusaurus interprets a
  // bare `link.id` there in that directory. Resolve that local spelling
  // before the global sidebar spelling; otherwise a valid category landing
  // page is reported missing (once per version) and moved to Additional.
  const scopedKey = sourceDirectory && !docId.startsWith('/')
    ? normalizeDocId(posix.join(sourceDirectory, key)) : undefined
  const descriptor = (scopedKey ? context.descriptorByDocId.get(scopedKey) : undefined)
    ?? context.descriptorByDocId.get(key)
    ?? context.descriptors.find((page) => page.navigationId === docusaurusRouteId(key))
  if (!descriptor) {
    context.warnings.push({
      code: 'missing-page',
      message: 'A Docusaurus sidebar document did not resolve to an imported page.',
      source: docId,
    })
    return null
  }
  context.referencedNavigationIds.add(descriptor.navigationId)
  return descriptor.navigationId
}

function generatedIndexPage(
  label: string,
  linkValue: unknown,
  context: ProjectionContext,
  sourceDirectory?: string,
): string | null {
  const link = objectValue(linkValue)
  if (!link) return null
  if (link.type === 'doc' && typeof link.id === 'string') return registerDoc(link.id, context, sourceDirectory)
  if (link.type !== 'generated-index') return null
  const fallback = `category/${slugifySegment(label)}`
  const unprefixedNavigationId = typeof link.slug === 'string'
    ? routeFromSlug(link.slug, fallback) ?? fallback
    : fallback
  const navigationId = context.routePrefix
    && unprefixedNavigationId !== context.routePrefix
    && !unprefixedNavigationId.startsWith(`${context.routePrefix}/`)
    ? posix.join(context.routePrefix, unprefixedNavigationId)
    : unprefixedNavigationId
  if (!context.generatedIds.has(navigationId)
    && !context.descriptors.some((page) => page.navigationId === navigationId)) {
    const description = typeof link.description === 'string'
      ? link.description
      : `Browse the ${label} documentation.`
    context.generatedPages.push({
      id: storageIdForRoute(navigationId),
      navigationId,
      title: typeof link.title === 'string' ? link.title : label,
      description,
      keywords: Array.isArray(link.keywords)
        ? link.keywords.filter((value): value is string => typeof value === 'string')
        : [],
      body: description,
      source: `${context.sourceUrl}#${context.sidebarSource}`,
    })
    context.generatedIds.add(navigationId)
  }
  context.referencedNavigationIds.add(navigationId)
  return navigationId
}

const DOCUSAURUS_HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/

function findDocusaurusConfigPath(repositoryRoot: string): string | null {
  return ['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs']
    .map((filename) => resolveWithin(repositoryRoot, filename))
    .find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? null
}

/**
 * Extract a static `--ifm-color-primary` accent from the classic theme's
 * `customCss` file (Infima's own theming convention: a `:root` block for
 * light mode, an `html[data-theme='dark']` block for dark mode). Its
 * `light`/`dark` blocks are normal, like Fern's (unlike Mintlify's inverted
 * schema `site.colors` otherwise follows), so they're swapped the same way
 * `fernThemeColors` does to give downstream consumers one consistent
 * contract.
 */
export function readDocusaurusThemeColor(repositoryRoot: string): { light?: string; dark?: string } | undefined {
  const configPath = findDocusaurusConfigPath(repositoryRoot)
  if (!configPath) return undefined
  const configSource = readBoundedText(configPath)
  const cssRelativePath = configSource.match(/\bcustomCss\s*:\s*(?:\[\s*)?(?:require\.resolve\(\s*)?(['"])([^'"]+)\1/)?.[2]
  if (!cssRelativePath) return undefined
  let cssPath: string
  try {
    cssPath = withinRealRoot(resolveWithin(repositoryRoot, cssRelativePath.replace(/^\.\//, '')), repositoryRoot)
  } catch {
    return undefined
  }
  if (!existsSync(cssPath) || !lstatSync(cssPath).isFile()) return undefined
  const css = readBoundedText(cssPath)
  const pick = (block: string | undefined): string | undefined => {
    const value = block?.match(/--ifm-color-primary\s*:\s*([^;]+);/)?.[1]?.trim()
    return value && DOCUSAURUS_HEX_COLOR.test(value) ? value : undefined
  }
  const lightMode = pick(css.match(/:root\s*\{([^}]*)\}/)?.[1])
  const darkMode = pick(css.match(/\[data-theme=(['"])dark\1\]\s*\{([^}]*)\}/)?.[2])
  const colors: { light?: string; dark?: string } = {}
  if (darkMode) colors.light = darkMode
  if (lightMode) colors.dark = lightMode
  return Object.keys(colors).length > 0 ? colors : undefined
}

export interface DocusaurusSiteSettings {
  name?: string
  description?: string
  navbarTitle?: string
  defaultColorMode?: 'light' | 'dark'
  logo?: { light: string; dark?: string; showTitle?: boolean }
  favicon?: string
  /** Docusaurus serves the classic docs plugin below /docs unless configured otherwise. */
  docsRouteBasePath: string
  navbarLinks: Array<{ label: string; href?: string; docId?: string; sidebarId?: string; docsPluginId?: string }>
  footerLinks: NonNullable<MigrationDocsConfig['footer']>['links']
  copyright?: string
  banner?: MigrationDocsConfig['banner']
  /**
   * Identity properties the config declares but that only exist at build time.
   * The caller reports these so a project never acquires a placeholder name
   * without the migration saying why.
   */
  unresolvedIdentity?: Array<'title' | 'tagline' | 'navbarTitle'>
  /** Copyright tokens that only exist at build time and were removed. */
  unresolvedCopyright?: string[]
}

function propertyStart(source: string, name: string): number {
  // Only property positions count. A bare word in a comment or a value must
  // never become executable configuration during repository migration.
  // The lead-in is checked by scanning back from each hit: a `\s*` right
  // after a line-start alternation is quadratic on long runs of blank lines.
  const pattern = new RegExp(`["']?${name}["']?\\s*:\\s*`, 'g')
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let before = match.index - 1
    while (before >= 0 && (source[before] === ' ' || source[before] === '\t')) before--
    if (before < 0 || '\r\n,{'.includes(source[before])) return match.index + match[0].length
  }
  return -1
}

/**
 * Resolve a config-relative import to a readable module file. Package
 * specifiers are deliberately not followed: their contents belong to the
 * source's dependencies, and reading `node_modules` during a migration would
 * make the imported identity depend on whatever the checkout happened to
 * install.
 */
function staticModulePath(repositoryRoot: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  try {
    const relativePath = specifier.replace(/^\.\/+/, '')
    return ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.json']
      .map((extension) => withinRealRoot(resolveWithin(repositoryRoot, `${relativePath}${extension}`), repositoryRoot))
      .find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? null
  } catch {
    return null
  }
}

/**
 * Top-level string properties of a data-only object literal. JSON5 already
 * covers the shapes Docusaurus data files use (unquoted keys, single quotes,
 * trailing commas, comments). A literal holding functions, spreads, or computed
 * values cannot be represented without executing the module, so nothing from it
 * is reported rather than part of it.
 */
function staticObjectStrings(objectText: string): Map<string, string> {
  const fields = new Map<string, string>()
  try {
    const parsed = JSON5.parse(objectText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fields
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') fields.set(key, value)
    }
  } catch {
    return fields
  }
  return fields
}

/** The object literal behind `export default`, including `export default site`. */
function defaultExportObjectLiteralText(source: string): string | null {
  const exported = /\bexport\s+default\s+/.exec(source)
  if (!exported) return null
  const start = exported.index + exported[0].length
  const literal = matchingObjectLiteral(source, start)
  if (literal) return literal
  const identifier = source.slice(start).match(/^([A-Za-z_$][\w$]*)/)?.[1]
  if (!identifier) return null
  const declaration = new RegExp(
    `\\b(?:const|let|var)\\s+${identifier}\\b(?:\\s*:\\s*[^=;]+)?\\s*=\\s*`,
  ).exec(source)
  return declaration ? matchingObjectLiteral(source, declaration.index + declaration[0].length) : null
}

/** The string literal behind `export const NAME = '...'`. */
function namedExportStringText(source: string, name: string): string | undefined {
  const match = new RegExp(
    `\\bexport\\s+(?:const|let|var)\\s+${name}\\b(?:\\s*:\\s*[^=;]+)?\\s*=\\s*`,
  ).exec(source)
  if (!match) return undefined
  const quoted = source.slice(match.index + match[0].length)
    .match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)
  if (!quoted) return undefined
  try {
    const parsed = JSON5.parse(quoted[1]) as unknown
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * String values a config can name through a local import, flattened to the
 * reference a config would write for them. `import site from './site.json'`
 * exposes `site.title`; `import { SITE_NAME } from './constants'` exposes
 * `SITE_NAME`. Only plain data is read, and only strings are exposed.
 */
function staticImportBindings(source: string, repositoryRoot: string): Map<string, string> {
  const bindings = new Map<string, string>()
  const addObject = (local: string, specifier: string, exported: 'default' | string): void => {
    const modulePath = staticModulePath(repositoryRoot, specifier)
    if (!modulePath) return
    const moduleSource = readBoundedText(modulePath)
    const objectText = extname(modulePath).toLowerCase() === '.json'
      ? moduleSource
      : exported === 'default'
        ? defaultExportObjectLiteralText(moduleSource)
        : namedExportObjectLiteralText(moduleSource, exported)
    if (!objectText) return
    for (const [key, value] of staticObjectStrings(objectText)) {
      bindings.set(`${local}.${key}`, value)
    }
  }
  const addString = (local: string, specifier: string, exported: string): void => {
    const modulePath = staticModulePath(repositoryRoot, specifier)
    if (!modulePath || extname(modulePath).toLowerCase() === '.json') return
    const value = namedExportStringText(readBoundedText(modulePath), exported)
    if (value !== undefined) bindings.set(local, value)
  }
  // `import * as site` exposes every named export, with the default export
  // reachable as `site.default`. Reading only the default object would answer
  // `site.TITLE` with a default-object key instead of the named export.
  const addNamespace = (local: string, specifier: string): void => {
    const modulePath = staticModulePath(repositoryRoot, specifier)
    if (!modulePath) return
    const moduleSource = readBoundedText(modulePath)
    if (extname(modulePath).toLowerCase() === '.json') {
      // Bundlers synthesize named exports from a JSON module's top-level keys.
      for (const [key, value] of staticObjectStrings(moduleSource)) {
        bindings.set(`${local}.${key}`, value)
      }
      return
    }
    const defaultText = defaultExportObjectLiteralText(moduleSource)
    if (defaultText) {
      for (const [key, value] of staticObjectStrings(defaultText)) {
        bindings.set(`${local}.default.${key}`, value)
      }
    }
    for (const match of moduleSource.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g)) {
      const name = match[1]
      const value = namedExportStringText(moduleSource, name)
      if (value !== undefined) bindings.set(`${local}.${name}`, value)
      const objectText = namedExportObjectLiteralText(moduleSource, name)
      if (!objectText) continue
      for (const [key, objectValue] of staticObjectStrings(objectText)) {
        bindings.set(`${local}.${name}.${key}`, objectValue)
      }
    }
  }
  // `import site from './site.json'`, and the default half of a mixed import.
  for (const match of source.matchAll(
    /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s*(['"])([^'"]+)\2/g,
  )) {
    addObject(match[1], match[3], 'default')
  }
  // `import * as site from './site'`.
  for (const match of source.matchAll(
    /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2/g,
  )) {
    addNamespace(match[1], match[3])
  }
  // `import { site, SITE_NAME as heading } from './site'`.
  for (const match of source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    for (const entry of match[1].split(',')) {
      const [imported, alias] = entry.split(/\s+as\s+/).map((part) => part.trim())
      if (!imported || !/^[A-Za-z_$][\w$]*$/.test(imported)) continue
      const local = alias && /^[A-Za-z_$][\w$]*$/.test(alias) ? alias : imported
      addObject(local, match[3], imported)
      addString(local, match[3], imported)
    }
  }
  return bindings
}

function staticStringBindings(source: string, repositoryRoot?: string): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const match of source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))/g)) {
    try {
      const value = JSON5.parse(match[2]) as unknown
      if (typeof value === 'string') bindings.set(match[1], value)
    } catch {
      // Executable or malformed declarations cannot become imported links.
    }
  }
  if (repositoryRoot) {
    for (const [reference, value] of staticImportBindings(source, repositoryRoot)) {
      bindings.set(reference, value)
    }
  }
  return bindings
}

function staticArrayField(source: string, name: string): string | null {
  const start = propertyStart(source, name)
  return start < 0 ? null : matchingArrayLiteral(source, start)
}

function staticObjectEntries(array: string | null): Array<string> {
  if (!array) return []
  const entries: Array<string> = []
  let afterDelimiter = 1
  let quote = ''
  let lineComment = false
  let blockComment = false
  for (let index = 1; index < array.length - 1; index++) {
    const char = array[index]
    const next = array[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index++ }
      continue
    }
    if (quote) {
      if (char === '\\') { index++; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; index++; continue }
    if (char === '/' && next === '*') { blockComment = true; index++; continue }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === ',') { afterDelimiter = index + 1; continue }
    if (char !== '{') continue
    const literal = matchingObjectLiteral(array, index)
    if (!literal) continue
    const lead = array.slice(afterDelimiter, index)
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim()
    // `isDev && { ... }` is a conditional entry; never assume it appears in
    // production just because its object literal can be read statically.
    if (!lead) entries.push(literal)
    index += literal.length - 1
  }
  return entries
}

function staticStringField(source: string, name: string, bindings?: Map<string, string>): string | undefined {
  const start = propertyStart(source, name)
  if (start < 0) return undefined
  const quoted = source.slice(start).match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)
  if (!quoted) {
    // A config may name a constant (`SITE_TITLE`) or a property of an imported
    // data module (`site.title`). Both resolve through the static bindings map;
    // anything else stays undefined so the caller can report it.
    const reference = source.slice(start)
      .match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/)?.[1]
    return reference ? bindings?.get(reference) : undefined
  }
  try {
    const parsed = JSON5.parse(quoted[1]) as unknown
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The only build-time expression a migrated copyright can keep, as `{year}`. */
const COPYRIGHT_YEAR = /\$\{\s*new Date\(\)\s*\.\s*getFullYear\(\)\s*\}/g
const COPYRIGHT_TOKEN = /\$\{([^}]*)\}/g
/** Docusaurus' own footer credit, which advertises a framework the site no longer runs. */
const DOCUSAURUS_CREDIT = /\s*\bBuilt with Docusaurus\b[.!]*/gi

/**
 * Turn a footer copyright into text the scaffold can render. A resolved
 * `${...}` keeps the sentence readable, the build-time year becomes `{year}`,
 * and a token whose value only exists at build time is reported and removed
 * rather than shipped to readers as source code.
 */
function docusaurusCopyright(
  source: string,
  bindings: Map<string, string>,
  unresolved: Array<string>,
): string | undefined {
  const value = source
    .replace(COPYRIGHT_YEAR, '{year}')
    .replace(COPYRIGHT_TOKEN, (_match, expression: string) => {
      const reference = expression.trim()
      const resolved = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(reference)
        ? bindings.get(reference)
        : undefined
      if (resolved !== undefined) return resolved
      unresolved.push(reference)
      return ''
    })
    .replace(DOCUSAURUS_CREDIT, '')
    // Removing a token usually leaves a space before its punctuation.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;!?])/g, '$1')
    .trim()
  return value || undefined
}

/** Project Docusaurus' static site identity and footer without loading config code. */
export function readDocusaurusSiteSettings(repositoryRoot: string): DocusaurusSiteSettings {
  const empty: DocusaurusSiteSettings = { docsRouteBasePath: 'docs', defaultColorMode: 'light', navbarLinks: [], footerLinks: [] }
  const configPath = findDocusaurusConfigPath(repositoryRoot)
  if (!configPath) return empty
  const source = readBoundedText(configPath)
  const bindings = staticStringBindings(source, repositoryRoot)
  const presets = staticArrayField(source, 'presets')
  const classicDocs = presets && [...presets.matchAll(/["']?docs["']?\s*:\s*/g)]
    .map((match) => matchingObjectLiteral(presets, (match.index ?? 0) + match[0].length))
    .find((object): object is string => Boolean(object))
  const docsRouteBasePath = classicDocs && staticStringField(classicDocs, 'routeBasePath', bindings) || 'docs'
  const themeStart = propertyStart(source, 'themeConfig')
  const theme = themeStart < 0 ? null : matchingObjectLiteral(source, themeStart)
  const colorModeStart = theme ? propertyStart(theme, 'colorMode') : -1
  const colorMode = colorModeStart < 0 ? null : matchingObjectLiteral(theme!, colorModeStart)
  const configuredColorMode = colorMode ? staticStringField(colorMode, 'defaultMode') : undefined
  const defaultColorMode = configuredColorMode === 'dark' ? 'dark' : 'light'
  const navbarStart = theme ? propertyStart(theme, 'navbar') : -1
  const navbar = navbarStart < 0 ? null : matchingObjectLiteral(theme!, navbarStart)
  const logoStart = navbar ? propertyStart(navbar, 'logo') : -1
  const logo = logoStart < 0 ? null : matchingObjectLiteral(navbar!, logoStart)
  const footerStart = theme ? propertyStart(theme, 'footer') : -1
  const footer = footerStart < 0 ? null : matchingObjectLiteral(theme!, footerStart)
  const navbarLinks = navbar ? staticObjectEntries(staticArrayField(navbar, 'items')).flatMap((item) => {
    // A dropdown owns nested links but no single destination. Taking its
    // first child as the parent's href creates duplicate, misleading links.
    if (propertyStart(item, 'items') >= 0 || propertyStart(item, 'dropdownItemsAfter') >= 0) return []
    const docsPluginId = staticStringField(item, 'docsPluginId', bindings)
    const href = staticStringField(item, 'to', bindings)
      ?? staticStringField(item, 'href', bindings)
    const docId = staticStringField(item, 'docId', bindings)
    const sidebarId = staticStringField(item, 'sidebarId', bindings)
    const label = staticStringField(item, 'label', bindings) ?? staticStringField(item, 'aria-label', bindings)
    return label && (href || docId || sidebarId || docsPluginId)
      ? [{ label, ...(href ? { href } : {}), ...(docId ? { docId } : {}),
        ...(sidebarId ? { sidebarId } : {}), ...(docsPluginId ? { docsPluginId } : {}) }]
      : []
  }) : []
  const footerLinks = footer ? staticObjectEntries(staticArrayField(footer, 'links')).flatMap((column) => {
    const heading = staticStringField(column, 'title', bindings)
    if (!heading) return []
    const items = staticObjectEntries(staticArrayField(column, 'items')).flatMap((item) => {
      const href = staticStringField(item, 'to', bindings) ?? staticStringField(item, 'href', bindings)
      const label = staticStringField(item, 'label', bindings)
      return label && href
        ? [{ label, href }]
        : []
    })
    return items.length > 0 ? [{ heading, items }] : []
  }) : []
  // Copyright text is data, not behaviour: a quoted string, a bound constant,
  // or a template literal whose `${...}` values can be read statically.
  const copyrightStart = footer ? propertyStart(footer, 'copyright') : -1
  const copyrightSource = copyrightStart < 0 ? undefined
    : staticStringField(footer!, 'copyright', bindings)
      ?? footer!.slice(copyrightStart).match(/^`([^`]+)`/)?.[1]
  const unresolvedCopyright: Array<string> = []
  const copyright = copyrightSource === undefined
    ? undefined
    : docusaurusCopyright(copyrightSource, bindings, unresolvedCopyright)
  const announcementStart = theme ? propertyStart(theme, 'announcementBar') : -1
  const announcement = announcementStart < 0 ? null : matchingObjectLiteral(theme!, announcementStart)
  const announcementContent = announcement && staticStringField(announcement, 'content')
    || announcement?.slice(propertyStart(announcement, 'content')).match(/^`([^`]+)`/)?.[1]
  const bannerContent = announcementContent ? announcementMarkdown(announcementContent) : ''
  const name = staticStringField(source, 'title', bindings)
  const description = staticStringField(source, 'tagline', bindings)
  const navbarTitle = navbar ? staticStringField(navbar, 'title', bindings) : undefined
  // A property that exists but resolves to nothing only exists at build time.
  // Reporting it is what keeps a placeholder project name from looking intended.
  const unresolvedIdentity: NonNullable<DocusaurusSiteSettings['unresolvedIdentity']> = []
  if (!name && propertyStart(source, 'title') >= 0) unresolvedIdentity.push('title')
  if (!description && propertyStart(source, 'tagline') >= 0) unresolvedIdentity.push('tagline')
  if (!navbarTitle && navbar && propertyStart(navbar, 'title') >= 0) unresolvedIdentity.push('navbarTitle')
  return {
    ...(bannerContent ? { banner: { content: bannerContent, dismissible: !/isCloseable\s*:\s*false/.test(announcement!), ...(staticStringField(announcement!, 'id') ? { id: staticStringField(announcement!, 'id') } : {}) } } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(navbarTitle ? { navbarTitle } : {}),
    ...(unresolvedIdentity.length > 0 ? { unresolvedIdentity } : {}),
    ...(unresolvedCopyright.length > 0 ? { unresolvedCopyright } : {}),
    defaultColorMode,
    docsRouteBasePath,
    ...(logo && staticStringField(logo, 'src', bindings) ? {
      logo: {
        light: staticStringField(logo, 'src', bindings)!,
        ...(staticStringField(logo, 'srcDark', bindings) ? { dark: staticStringField(logo, 'srcDark', bindings) } : {}),
        showTitle: Boolean(navbarTitle),
      },
    } : {}),
    ...(staticStringField(source, 'favicon', bindings) ? { favicon: staticStringField(source, 'favicon', bindings) } : {}),
    navbarLinks,
    footerLinks,
    ...(copyright ? { copyright } : {}),
  }
}

function autogeneratedItems(dirName: string, context: ProjectionContext): Array<string | MigrationNavigationGroup> {
  // `dirName` and descriptor source paths are on-disk paths: number prefixes
  // (`02-guide/`) are only stripped from ids and routes, never from these.
  const normalizedDir = dirName === '.' ? '' : dirName.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const inDirectory = context.descriptors.filter((descriptor) => {
    const source = descriptor.sourcePath.replace(/\.(?:mdx?)$/i, '')
    return !normalizedDir || source === normalizedDir || source.startsWith(`${normalizedDir}/`)
  })
  const directPages: Array<DocusaurusPageDescriptor> = []
  const childDirectories = new Set<string>()
  for (const descriptor of inDirectory) {
    const source = descriptor.sourcePath.replace(/\.(?:mdx?)$/i, '')
    const relativePath = normalizedDir ? posix.relative(normalizedDir, source) : source
    const segments = relativePath.split('/').filter(Boolean)
    if (segments.length <= 1) directPages.push(descriptor)
    else childDirectories.add(segments[0])
  }

  const pages = directPages.map((descriptor) => ({
    // An index document is the category landing page in Docusaurus. Thally
    // renders it as a child link, so put it before the category's other docs.
    position: descriptor.sidebarPosition ?? (/(?:^|\/)(?:index|readme)\.mdx?$/i.test(descriptor.sourcePath)
      ? -1 : Number.MAX_SAFE_INTEGER),
    // Siblings sort by file or directory name, like the category entries below.
    sortKey: posix.basename(descriptor.sourcePath),
    item: descriptor.navigationId as string | MigrationNavigationGroup,
  }))
  const groups = [...childDirectories].map((segment) => {
    const directory = normalizedDir ? posix.join(normalizedDir, segment) : segment
    const metadata = readCategoryMetadata(context.contentRoot, directory)
    const pages = autogeneratedItems(directory, context)
    // A folder containing only its index document is a direct sidebar doc in
    // Docusaurus. Inventing a category here duplicates the link and moves it
    // after ordered siblings when the folder has no `_category_` metadata.
    if (pages.length === 1 && typeof pages[0] === 'string'
      && !metadata.label && metadata.position === undefined && !metadata.link) {
      const onlyPage = context.descriptors.find((descriptor) => descriptor.navigationId === pages[0])
      if (onlyPage && /(?:^|\/)(?:index|readme)\.mdx?$/i.test(onlyPage.sourcePath)) {
        return {
          position: onlyPage.sidebarPosition ?? Number.MAX_SAFE_INTEGER,
          sortKey: segment,
          item: pages[0],
        }
      }
    }
    const landing = generatedIndexPage(metadata.label ?? titleCase(segment), metadata.link, context, directory)
    if (landing && !pages.includes(landing)) pages.unshift(landing)
    return {
      position: metadata.position ?? Number.MAX_SAFE_INTEGER,
      sortKey: segment,
      item: {
        group: metadata.label ?? titleCase(segment),
        pages,
      } satisfies MigrationNavigationGroup,
    }
  })
  // Docusaurus sorts direct docs and child categories in one list. Sorting
  // them separately moves every category below every doc regardless of the
  // authored sidebar_position / _category_.json position.
  return [...pages, ...groups]
    .sort((left, right) => left.position - right.position
      || left.sortKey.localeCompare(right.sortKey, undefined, { numeric: true }))
    .map(({ item }) => {
      if (typeof item === 'string') context.referencedNavigationIds.add(item)
      return item
    })
}

function convertItems(value: unknown, context: ProjectionContext): Array<string | MigrationNavigationGroup> {
  if (typeof value === 'string') {
    const page = registerDoc(value, context)
    return page ? [page] : []
  }
  if (Array.isArray(value)) return value.flatMap((entry) => convertItems(entry, context))
  const object = objectValue(value)
  if (!object) return []

  if (object.type === 'doc' || object.type === 'ref') {
    const page = typeof object.id === 'string' ? registerDoc(object.id, context) : null
    return page ? [page] : []
  }
  if (object.type === 'autogenerated') {
    return autogeneratedItems(typeof object.dirName === 'string' ? object.dirName : '.', context)
  }
  if (object.type === 'category') {
    const label = typeof object.label === 'string' ? object.label : 'Documentation'
    const pages = convertItems(object.items, context)
    const landing = generatedIndexPage(label, object.link, context)
    if (landing && !pages.includes(landing)) pages.unshift(landing)
    return pages.length > 0 ? [{ group: label, pages }] : []
  }
  if (object.type === 'link' || object.type === 'html') return []

  // Docusaurus category shorthand and sidebar slices are ordinary objects.
  return Object.entries(object).flatMap(([label, items]) => {
    const pages = convertItems(items, context)
    return pages.length > 0 ? [{ group: label, pages }] : []
  })
}

/** Project explicit and autogenerated Docusaurus sidebars into Thally tabs. */
export function projectDocusaurusNavigation(input: {
  sidebars: DocusaurusSidebars | null
  descriptors: Array<DocusaurusPageDescriptor>
  contentRoot: string
  sourceUrl: string
  routePrefix?: string
}): DocusaurusNavigationResult {
  const warnings: Array<MigrationWarning> = []
  const descriptorByDocId = new Map(input.descriptors.map((page) => [page.docId, page]))
  const context: ProjectionContext = {
    contentRoot: input.contentRoot,
    descriptors: input.descriptors,
    descriptorByDocId,
    generatedPages: [],
    generatedIds: new Set(),
    referencedNavigationIds: new Set(),
    sourceUrl: input.sourceUrl,
    routePrefix: input.routePrefix ?? '',
    sidebarSource: input.sidebars?.sourcePath ?? 'autogenerated sidebar',
    warnings,
  }
  const sidebarEntries: Array<[string, unknown]> = input.sidebars ? Object.entries(input.sidebars.config) : [['docs', [
    { type: 'autogenerated', dirName: '.' },
  ]]]
  const tabs = sidebarEntries.flatMap(([sidebarId, value]) => {
    const converted = convertItems(value, context)
    if (converted.length === 0) return []
    return [{
      tab: sidebarEntries.length === 1 ? 'Documentation' : titleCase(sidebarId),
      // Docusaurus categories are disclosures, including at the sidebar
      // root. Keeping them as Thally root nodes preserves their collapsed
      // state and the authored interleaving of documents and categories.
      pages: converted,
    }]
  })

  // Unlisted pages stay routable, but no sidebar shows them, listed or not.
  const unlisted = new Set(input.descriptors.filter((page) => page.unlisted).map((page) => page.navigationId))
  const withoutUnlisted = (items: Array<string | MigrationNavigationGroup>): Array<string | MigrationNavigationGroup> =>
    items.flatMap((item): Array<string | MigrationNavigationGroup> => {
      if (typeof item === 'string') return unlisted.has(item) ? [] : [item]
      const pages = withoutUnlisted(item.pages)
      return pages.length > 0 ? [{ ...item, pages }] : []
    })
  if (unlisted.size > 0) {
    for (const tab of tabs) tab.pages = withoutUnlisted(tab.pages)
  }
  const unreferenced = input.descriptors
    .filter((page) => !unlisted.has(page.navigationId) && !context.referencedNavigationIds.has(page.navigationId))
    .sort(descriptorSort)
    .map((page) => page.navigationId)
  if (unreferenced.length > 0) {
    if (tabs.length === 0) tabs.push({ tab: 'Documentation', pages: [] })
    tabs[0].pages?.push({ group: 'Additional', pages: unreferenced })
  }
  return {
    docsConfig: { tabs },
    generatedPages: context.generatedPages,
    referencedNavigationIds: context.referencedNavigationIds,
    warnings,
  }
}


/** Project bounded native CSS tokens; compiled output resolves Sass/Tailwind values without executing source config. */
export function readDocusaurusPresentation(repositoryRoot: string): { css: string; headingFont?: string; colors?: { light?: string; dark?: string }; unresolved: boolean } | undefined {
  const configPath = findDocusaurusConfigPath(repositoryRoot)
  if (!configPath) return undefined
  const config = readBoundedText(configPath)
  const relative = config.match(/\bcustomCss\s*:\s*(?:\[\s*)?(?:require\.resolve\(\s*)?(['"])([^'"]+)\1/)?.[2]
  if (!relative) return undefined
  let css: string
  try {
    const path = withinRealRoot(resolveWithin(repositoryRoot, relative), repositoryRoot)
    if (!lstatSync(path).isFile()) return undefined
    css = readBoundedText(path)
    if (/\btheme\(/.test(css) || /\.s[ac]ss$/.test(relative)) {
      const candidateDirectory = resolveWithin(repositoryRoot, 'build/assets/css')
      if (existsSync(candidateDirectory)) {
        const directory = withinRealRoot(candidateDirectory, repositoryRoot)
        const compiled = readdirSync(directory).filter((name) => /^styles[.\w-]*\.css$/.test(name)).sort().slice(0, 8)
        let totalBytes = 0
        css = compiled.map((name) => {
          const path = withinRealRoot(resolveWithin(directory, name), repositoryRoot)
          const stat = lstatSync(path)
          if (!stat.isFile()) return ''
          totalBytes += stat.size
          if (totalBytes > MAX_CONFIG_BYTES) throw new Error('Compiled theme exceeds the config size limit.')
          return readBoundedText(path)
        }).join('\n') || css
      }
    }
  } catch { return undefined }
  const modes = { light: new Map<string, string>(), dark: new Map<string, string>() }
  const banners = { light: new Map<string, string>(), dark: new Map<string, string>() }
  try {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent?.type !== 'root') return
      for (const selector of rule.selector.split(',')) {
        const key = selector.trim()
        const target = key === ':root' || key === 'html' || /^(?:html)?\[data-theme=['"]?light['"]?\]$/.test(key) ? modes.light
          : /^(?:html)?\[data-theme=['"]?dark['"]?\]$/.test(key) || key === '.dark' ? modes.dark : undefined
        if (target) rule.walkDecls((decl) => { if (decl.prop.startsWith('--ifm-')) target.set(decl.prop, decl.value) })
        const banner = key === '.theme-announcement-bar' ? banners.light
          : /^(?:html)?\[data-theme=['"]?dark['"]?\] \.theme-announcement-bar$/.test(key) ? banners.dark : undefined
        if (banner) rule.walkDecls((decl) => { banner.set(decl.prop, decl.value) })
      }
    })
  } catch { return undefined }
  const value = (name: string, mode: 'light' | 'dark', active = new Set<string>()): string | undefined => {
    if (active.has(name) || active.size >= 16) return undefined
    active.add(name)
    const raw = modes[mode].get(name) ?? modes.light.get(name)
    const reference = raw && /^var\((--[\w-]+)\)$/.exec(raw.trim())?.[1]
    return reference ? value(reference, mode, active) : raw
  }
  const color = (name: string, mode: 'light' | 'dark') => {
    const raw = value(name, mode)
    return raw ? cssColorToHex(raw) : undefined
  }
  const mapped = { '--docs-bg': '--ifm-background-color', '--docs-ink': '--ifm-font-color-base', '--docs-ink-2': '--ifm-font-color-base', '--docs-accent': '--ifm-link-color' }
  const declarations = (mode: 'light' | 'dark') => Object.entries(mapped).flatMap(([target, source]) => { const hex = color(source, mode); return hex ? [`${target}:${hex}`] : [] }).join(';')
  const heading = value('--ifm-heading-font-family', 'light')?.trim()
  const headingFont = heading && /^[\w -]{1,80}$/.test(heading) ? heading : undefined
  const dimension = (name: string, fallback: string) => { const raw = value(name, 'light'); return raw && /^\d+(?:\.\d+)?(?:px|rem)$/.test(raw) ? raw : fallback }
  const bodyFont = value('--ifm-font-family-base', 'light')
  const safeBodyFont = bodyFont && /^[\w\s,'"._-]{1,250}$/.test(bodyFont) ? bodyFont : 'ui-sans-serif,system-ui,sans-serif'
  const bannerCss = (mode: 'light' | 'dark') => {
    const styles: Array<string> = []
    for (const [property, raw] of banners[mode]) {
      const reference = /^var\((--[\w-]+)\)$/.exec(raw)?.[1]
      const resolved = reference ? value(reference, mode) : raw
      if (!resolved) continue
      const hex = ['background-color', 'color'].includes(property) ? cssColorToHex(resolved) : undefined
      if (hex) styles.push(`${property}:${hex}`)
      else if (property === 'font-family' && /^[\w\s,'"._-]{1,250}$/.test(resolved)
        || ['font-size', 'padding'].includes(property) && /^(?:\d*\.?\d+(?:px|rem)?\s*){1,4}$/.test(resolved)
        || property === 'font-weight' && /^(?:[1-9]00|bold|normal)$/.test(resolved)) styles.push(`${property}:${resolved}`)
    }
    return styles.join(';')
  }
  let tokens = ''
  const prismStart = propertyStart(config, 'prism')
  const prism = prismStart < 0 ? null : matchingObjectLiteral(config, prismStart)
  const themeStart = prism ? propertyStart(prism, 'theme') : -1
  const themeExpression = themeStart < 0 ? '' : prism!.slice(themeStart)
  const identifier = /^([\w$]+)/.exec(themeExpression)?.[1]
  const binding = identifier && config.match(new RegExp(`(?:const|let|var)\\s+${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(require\\([^\\n]+)`))?.[1]
  const themePath = (themeExpression || '').match(/^require\(\s*['"]([^'"]+)['"]/)?.[1]
    ?? binding?.match(/^require\(\s*['"]([^'"]+)['"]/)?.[1]
  if (themePath) try {
    const base = resolveWithin(repositoryRoot, themePath)
    const path = [base, `${base}.js`, `${base}/index.js`, `${base}/index.cjs.js`].find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile())
    if (path) {
      const source = readBoundedText(withinRealRoot(path, repositoryRoot))
      const start = source.search(/(?:module\.exports|(?:const|let|var)\s+\w+)\s*=/)
      const literal = start < 0 ? null : matchingObjectLiteral(source, source.indexOf('=', start) + 1)
      const theme = literal ? JSON5.parse(literal) as { plain?: { color?: string; backgroundColor?: string }; styles?: Array<{ types?: Array<string>; style?: { color?: string } }> } : null
      const tokenNames: Record<string, string> = { keyword: 'keyword', string: 'string', comment: 'comment', function: 'function', property: 'property', constant: 'constant', punctuation: 'punctuation', parameter: 'parameter' }
      const colors = new Map<string, string>()
      for (const [target, raw] of [['--shiki-color-text', theme?.plain?.color], ['--docs-code-bg', theme?.plain?.backgroundColor]]) { const hex = typeof raw === 'string' ? cssColorToHex(raw) : undefined; if (hex && target) colors.set(target, hex) }
      for (const style of theme?.styles ?? []) for (const type of Array.isArray(style.types) ? style.types : []) {
        const hex = typeof style.style?.color === 'string' ? cssColorToHex(style.style.color) : undefined
        if (tokenNames[type] && hex) colors.set(`--shiki-token-${tokenNames[type]}`, hex)
      }
      tokens = [...colors].map(([name, hex]) => `${name}:${hex}`).join(';')
    }
  } catch { /* Executable or malformed themes cannot become styling. */ }
  const lightAccent = color('--ifm-color-primary', 'light')
  const darkAccent = color('--ifm-color-primary', 'dark')
  return { headingFont, colors: lightAccent || darkAccent ? { dark: lightAccent, light: darkAccent } : undefined, unresolved: /\btheme\(/.test(css), css: `
:root{${declarations('light')}}
:root.dark{${declarations('dark')}}
body{font-family:${safeBodyFont}}
.thally-docs-root,.thally-docs-sidebar{background:var(--docs-bg);color:var(--docs-ink)}
.thally-docs-topbar{background:var(--docs-bg);backdrop-filter:none}
.thally-docs-topbar-inner{height:${dimension('--ifm-navbar-height', '60px')};max-width:none;padding-inline:24px}
.thally-docs-collection-row{display:none}
.thally-docs-actions{flex:1}.thally-docs-navlinks{order:-1;margin-left:auto;margin-right:12px}
.thally-docs-topbar-link svg{display:none}
.thally-docs-search,.thally-docs-search>button:first-of-type{width:180px}
.thally-docs-search>button:first-of-type{border:1px solid var(--docs-line);border-radius:24px;background:var(--docs-bg)}
.thally-ink-banner{${bannerCss('light')}}
.dark .thally-ink-banner{${bannerCss('dark')}}
.thally-ink-banner-content{color:inherit;font-size:inherit;font-weight:inherit}
.thally-ink-banner-content a{color:var(--docs-accent)}
.thally-ink-banner-dot{display:none}
.thally-docs-eyebrow{display:none}
.thally-docs-header h1{font-size:${dimension('--ifm-h1-font-size', '2.5rem')};line-height:1.25;color:var(--docs-ink)}
.thally-docs-prose{line-height:1.5;color:var(--docs-ink)}
.thally-docs-prose p{margin-block:0 1rem}
.thally-docs-prose a{color:var(--docs-accent)}
.thally-docs-code{${tokens};background:var(--docs-code-bg)}
@media(min-width:1024px){
.thally-docs-shell{max-width:none;padding-inline:0}
.thally-docs-sidebar,.thally-docs-sidebar>div{width:300px}
.thally-docs-sidebar{border-right:1px solid var(--docs-line)}
.thally-docs-main{padding-top:50px}
.thally-docs-main>div{padding-inline:26px}
.thally-docs-article nav[aria-label=Breadcrumb]{display:none}
.thally-docs-sidebar nav{padding-inline:16px}
.thally-docs-sidebar a[aria-current=page]{background:transparent!important;text-shadow:none}
}
` }
}
