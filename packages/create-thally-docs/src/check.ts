/**
 * Validate authored navigation and links against the routes the runtime can
 * serve, including locale fallback and literal redirect chains. Validation is
 * read-only unless the caller explicitly enables orphan-navigation fixes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseFrontmatter } from './frontmatter.js'
import { parse as parseYaml } from 'yaml'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { readDocsJson, writeDocsJson, type DocsJsonConfig } from './docs-json.js'
import { API_GROUPS_MAX_DEPTH, groupKeyState, listedOperationKeys, pageState, parseDocReference, type CheckSpec, type DocReference } from './openapi-publication.js'
import { manualApiProblems } from './manual-api-check.js'
import { findPublicSpecs, shadowNote, specHasHiddenOperations } from './public-specs.js'
import { projectNavigationContract } from '@thallylabs/core/navigation'
import { slugify } from '@thallylabs/core/slugify'
import { validateIntegrations } from '@thallylabs/migrate'
import { checkExternalLinks, type ExternalLinkCheckOptions, type ExternalLinkReference } from './external-links.js'

export interface LintIssue {
  severity: 'error' | 'warning'
  message: string
  file?: string
  line?: number
}

export interface CheckOptions {
  fix: boolean
  ci: boolean
  /** Also HEAD-check external links on public hosts (network). Off by default for deterministic CI. */
  external?: boolean
  /** Test seam for the external-link checker's resolver, requester, and limits. */
  externalLinkOptions?: ExternalLinkCheckOptions
  /** Flag pages whose `sources` changed since their `verifiedCommit` (needs git history). */
  drift?: boolean
  /** Optional structured diagnostics sink used by migration reports. */
  onIssues?: (issues: Array<LintIssue>) => void
  /** Migration's terminal renderer owns diagnostics when running an inline step. */
  silent?: boolean
}

/** Run a git command in the project, returning success + trimmed stdout. */
function gitLocal(projectDir: string, args: Array<string>): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return { ok: true, out: out.trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

/**
 * Provenance drift: a page is stale when a file it declares in `sources` has
 * changed since the `verifiedCommit` it was last checked against. Deterministic,
 * zero-inference. Fails toward "can't tell" — a verifiedCommit missing from
 * history (e.g. a shallow CI clone) is flagged, never silently passed.
 */
function checkDrift(projectDir: string, file: string, data: Record<string, unknown>, issues: Array<LintIssue>): void {
  const sources = data.sources
  const verifiedCommit = data.verifiedCommit
  if (!Array.isArray(sources) || sources.length === 0 || typeof verifiedCommit !== 'string' || !verifiedCommit.trim()) {
    return
  }

  const commit = verifiedCommit.trim()
  // Is the verified commit even in this checkout? Shallow clones drop old history.
  if (!gitLocal(projectDir, ['cat-file', '-e', `${commit}^{commit}`]).ok) {
    issues.push({
      severity: 'warning',
      message: `Cannot verify freshness: verifiedCommit "${commit.slice(0, 8)}" is not in git history — run with a full clone (fetch-depth: 0).`,
      file,
    })
    return
  }

  for (const src of sources) {
    if (typeof src !== 'string' || !src.trim()) continue
    const colon = src.indexOf(':')
    let filePath = src
    if (colon > 0) {
      const alias = src.slice(0, colon)
      if (alias !== '.' && alias !== 'self') {
        issues.push({
          severity: 'warning',
          message: `Cross-repo source "${src}" — drift check skipped (needs the referenced repo; see multi-repo setup).`,
          file,
        })
        continue
      }
      filePath = src.slice(colon + 1)
    }
    filePath = filePath.replace(/^\.\//, '').replace(/#.*$/, '') // strip ./ and #fragment
    const changed = gitLocal(projectDir, ['log', '--format=%H', `${commit}..HEAD`, '--', filePath]).out
    if (changed) {
      const n = changed.split('\n').filter(Boolean).length
      issues.push({
        severity: 'warning',
        message: `Drift: source "${src}" changed in ${n} commit(s) since it was verified — this page may be stale.`,
        file,
      })
    }
  }
}

function scanMdx(dir: string, results: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    try {
      const stat = statSync(fullPath)
      if (stat.isDirectory()) scanMdx(fullPath, results)
      else if (extname(entry).toLowerCase() === '.mdx') results.push(fullPath)
    } catch {
      // skip
    }
  }
}

function addOrphanToNav(projectDir: string, pageId: string): void {
  const config = readDocsJson(projectDir)
  const tab = config.tabs.find((candidate) => !candidate.href && !candidate.api
    && (candidate.pages?.length || candidate.groups?.length))
  if (!tab) return
  if (tab.pages) {
    if (!tab.pages.includes(pageId)) {
      tab.pages.push(pageId)
      writeDocsJson(projectDir, config)
    }
    return
  }
  if (!tab.groups) return
  const lastGroup = tab.groups[tab.groups.length - 1]
  const existing = lastGroup.pages.filter((p): p is string => typeof p === 'string')
  if (!existing.includes(pageId)) {
    lastGroup.pages.push(pageId)
    writeDocsJson(projectDir, config)
  }
}

const EXPLICIT_ID_ATTRIBUTE = /\bid=(?:"([^"]*)"|'([^']*)'|\{["']([^"'}]*)["']\})/g
const NAMED_ANCHOR = /<a\b[^>]*\bname=(?:"([^"]*)"|'([^']*)')/g

/** Visit rendered prose lines while respecting the opening fence's marker and length. */
function forEachNonFencedLine(content: string, visit: (line: string, lineNumber: number) => void): void {
  let fence: string | undefined
  for (const [index, line] of content.split('\n').entries()) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
        && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined
      continue
    }
    if (!fence) visit(line, index + 1)
  }
}

/**
 * Headings and explicit anchor targets a rendered page actually exposes.
 * CommonMark still parses a heading marker indented up to 3 spaces (only 4+
 * turns it into a code block), including inside JSX children, so markdown
 * headings authored with light indentation must count too. Any JSX/HTML
 * element carrying a literal `id` attribute is also a valid link target,
 * independent of headings.
 */
function renderedHeadingText(source: string): string {
  let visible = ''
  let inTag = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (!inTag) {
      if (character === '<') inTag = true
      else visible += character
      continue
    }
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      inTag = false
    }
  }
  return visible
}

const mdxParser = unified().use(remarkParse).use(remarkMdx)

/** A node of the MDX syntax tree, the one the renderer and the content parser read; JSX elements carry their tag name and attributes. */
interface MdxNode {
  type: string
  name?: string | null
  attributes?: Array<{ type: string; name?: string; value?: unknown }>
  children?: Array<MdxNode>
  position?: { start: { line: number } }
}

/** A literal string attribute, as MDX decodes it; `null` for an expression, `undefined` when the attribute is absent. */
function stringAttribute(node: MdxNode, name: string): string | null | undefined {
  const attribute = node.attributes?.find((item) => item.type === 'mdxJsxAttribute' && item.name === name)
  if (!attribute) return undefined
  return typeof attribute.value === 'string' ? attribute.value : null
}

/**
 * Titles of the `<Step>`s that render as headings: `titleSize` h2, h3 or h4 on
 * the step or, failing that, on the `<Steps>` around it. Only literal strings
 * count, as in the runtime. Each carries the line its tag starts on. The steps
 * are read from the MDX syntax tree, so a tag written inside inline code or a
 * comment is not one; a page MDX cannot read has none, as for the content parser.
 */
function extractStepHeadings(content: string): Array<{ line: number; base: string; explicit: boolean }> {
  // Parsing costs milliseconds per page; skip it on the many pages with no step.
  if (!content.includes('<Step')) return []
  let tree: MdxNode
  try {
    tree = mdxParser.parse(content) as unknown as MdxNode
  } catch {
    return []
  }
  const steps: Array<{ line: number; base: string; explicit: boolean }> = []
  const visit = (node: MdxNode, stepSize: string | undefined): void => {
    let childSize = stepSize
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      // `<Steps>` hands its size to every step below it, set or not (a React context).
      if (node.name === 'Steps') childSize = stringAttribute(node, 'titleSize') ?? undefined
      if (node.name === 'Step') {
        const own = stringAttribute(node, 'titleSize')
        const size = own === undefined ? stepSize : own
        const title = stringAttribute(node, 'title')?.trim()
        if (title && size && ['h2', 'h3', 'h4'].includes(size)) {
          const id = stringAttribute(node, 'id')?.trim()
          steps.push({ line: node.position?.start.line ?? 0, base: id || slugify(title), explicit: !!id })
        }
      }
    }
    for (const child of node.children ?? []) visit(child, childSize)
  }
  visit(tree, undefined)
  return steps
}

function extractHeadingAnchors(content: string): Set<string> {
  const anchors = new Set<string>()
  const headings: Array<{ base: string; explicit: boolean; line: number }> = []
  forEachNonFencedLine(content, (line, lineNumber) => {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      // The runtime hashes rendered heading text. JSX badges and inline
      // anchors contribute their visible children, never their tag/props.
      // A trailing `{/* #id */}` is the id the runtime uses instead of the text's slug.
      const explicit = /\{\/\*\s*#(\S+?)\s*\*\/\}$/.exec(heading[1])
      headings.push({ base: explicit?.[1] ?? slugify(renderedHeadingText(heading[1])), explicit: !!explicit, line: lineNumber })
    }
    for (const idMatch of line.matchAll(EXPLICIT_ID_ATTRIBUTE)) {
      const id = idMatch[1] ?? idMatch[2] ?? idMatch[3]
      if (id) anchors.add(id)
    }
    // Legacy Markdown exports and notebook conversions commonly use
    // `<a name="section">`; browsers resolve fragments to those too.
    for (const nameMatch of line.matchAll(NAMED_ANCHOR)) {
      const name = nameMatch[1] ?? nameMatch[2]
      if (name) anchors.add(name)
    }
  })
  // Same numbering as the runtime and the content parser: `foo`, `foo-2`, `foo-3`;
  // an explicit id reserves its id, so generated ids skip it.
  headings.push(...extractStepHeadings(content))
  headings.sort((left, right) => left.line - right.line)
  const reserved = new Set(headings.filter((heading) => heading.explicit).map((heading) => heading.base))
  const used = new Set<string>()
  const occurrences = new Map<string, number>()
  for (const { base, explicit } of headings) {
    let id = base
    let n = 1
    if (explicit) {
      while (used.has(id)) id = `${base}-${++n}`
    } else {
      n = occurrences.get(base) ?? 0
      do id = ++n === 1 ? base : `${base}-${n}`
      while (used.has(id) || reserved.has(id))
      occurrences.set(base, n)
    }
    used.add(id)
    anchors.add(id)
  }
  return anchors
}

/** Compare URL-encoded fragments with the IDs the browser resolves. */
function decodedFragment(fragment: string): string {
  try { return decodeURIComponent(fragment) } catch { return fragment }
}

interface FoundLink {
  target: string
  line: number
}

function extractLinks(content: string): FoundLink[] {
  const links: FoundLink[] = []
  forEachNonFencedLine(content, (rawLine, lineNumber) => {
    const line = rawLine.replace(/`[^`]*`/g, '') // strip inline code spans
    // Markdown links [text](target) and bare href="target"
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ target: m[1], line: lineNumber })
    }
    for (const m of line.matchAll(/href=["']([^"']+)["']/g)) {
      links.push({ target: m[1], line: lineNumber })
    }
  })
  return links
}

/** Local image references: markdown `![]()` images and `src="..."` attributes. */
function extractImageRefs(content: string): FoundLink[] {
  const refs: FoundLink[] = []
  forEachNonFencedLine(content, (rawLine, lineNumber) => {
    const line = rawLine.replace(/`[^`]*`/g, '')
    for (const m of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      refs.push({ target: m[1], line: lineNumber })
    }
    for (const m of line.matchAll(/\bsrc=["']([^"']+)["']/g)) {
      refs.push({ target: m[1], line: lineNumber })
    }
  })
  return refs
}

function localizedPage(
  pageId: string,
  secondaryLocales: Set<string>,
): { navPageId: string; locale?: string } {
  const [first, ...rest] = pageId.split('/')
  if (secondaryLocales.has(first) && rest.length > 0) {
    return { navPageId: rest.join('/'), locale: first }
  }
  return { navPageId: pageId }
}

function pageIdToPath(pageId: string, secondaryLocales: Set<string>): string {
  const { navPageId, locale } = localizedPage(pageId, secondaryLocales)
  const basePath = navPageId === 'introduction' ? '/' : `/${navPageId}`
  return locale ? `/${locale}${basePath === '/' ? '' : basePath}` : basePath
}

interface ResolvedLink {
  path: string
  anchor?: string
  external?: boolean
  cycle?: boolean
}

interface DynamicRedirect {
  regex: RegExp
  paramNames: Array<string>
  destination: string
}

/**
 * Compile a Next.js-style redirect source into a matcher, for a source that
 * contains a dynamic segment (`:param`, `:param*`, `:param+`, `:param?`) —
 * the same syntax `next.config.ts` passes straight to Next's own
 * `redirects()`. A purely literal source (no `:`) doesn't need this; it
 * stays in the exact-match map below. `*`/`+` consume the rest of the path
 * including further `/` segments, matching Next's own behavior.
 */
function compileDynamicRedirectSource(source: string, destination: string): DynamicRedirect | null {
  if (!source.includes(':')) return null
  const paramNames: Array<string> = []
  let pattern = ''
  source.split('/').forEach((segment, index) => {
    const match = segment.match(/^:([A-Za-z_][A-Za-z0-9_]*)([*+?]?)$/)
    const separator = index === 0 ? '' : '/'
    if (!match) {
      pattern += separator + segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return
    }
    const [, name, quantifier] = match
    paramNames.push(name)
    // `*` and `?` also match with the whole segment (and its `/`) absent.
    if (quantifier === '*') pattern += `(?:${separator}(.*))?`
    else if (quantifier === '?') pattern += `(?:${separator}([^/]+))?`
    else pattern += `${separator}(${quantifier === '+' ? '.+' : '[^/]+'})`
  })
  return { regex: new RegExp(`^${pattern}$`), paramNames, destination }
}

/** Substitute a dynamic redirect's matched params into its destination template. */
function resolveDynamicRedirectDestination(redirect: DynamicRedirect, match: RegExpMatchArray): string {
  return redirect.destination.replace(/:([A-Za-z_][A-Za-z0-9_]*)[*+?]?/g, (whole, name: string) => {
    const index = redirect.paramNames.indexOf(name)
    return index === -1 ? whole : (match[index + 1] ?? '')
  })
}

const MAX_REDIRECT_HOPS = 20

/** Follow literal and Next.js-style dynamic site redirects without accepting cycles as reachable pages. */
function resolveLink(target: string, redirects: ReadonlyMap<string, string>, dynamicRedirects: ReadonlyArray<DynamicRedirect> = []): ResolvedLink {
  let current = target
  let anchor: string | undefined
  const seen = new Set<string>()
  while (true) {
    if (/^(?:https?:)?\/\//i.test(current)) return { path: current, external: true }
    const hash = current.indexOf('#')
    if (hash >= 0) anchor = current.slice(hash + 1)
    const beforeHash = hash >= 0 ? current.slice(0, hash) : current
    const path = beforeHash.split('?', 1)[0].replace(/\/$/, '') || '/'
    // A wildcard can keep matching its own destination (`/docs/:p*` -> `/docs/v2/:p*`), producing a new path every hop.
    if (seen.has(path) || seen.size >= MAX_REDIRECT_HOPS) return { path, anchor, cycle: true }
    seen.add(path)
    const literalRedirect = redirects.get(path)
    if (literalRedirect) {
      current = literalRedirect
      continue
    }
    const dynamicMatch = dynamicRedirects
      .map((redirect) => ({ redirect, match: path.match(redirect.regex) }))
      .find((candidate): candidate is { redirect: DynamicRedirect; match: RegExpMatchArray } => candidate.match !== null)
    if (!dynamicMatch) return { path, anchor }
    current = resolveDynamicRedirectDestination(dynamicMatch.redirect, dynamicMatch.match)
  }
}

/**
 * Specs under `public/` are served verbatim. Independently of docs.json (which
 * may already point at a migrated copy elsewhere), flag any that carry hidden or
 * excluded operations, or that are not the configured source.
 */
function checkPublicSpecs(projectDir: string, tabs: Array<{ api?: { source?: string } }>, issues: LintIssue[]): void {
  const configured = tabs.flatMap((tab) => (tab.api?.source ? [tab.api.source.replace(/^\.\//, '')] : []))
  const isConfigured = (spec: { path: string; urlPath: string }) =>
    configured.some((source) => source === `/${spec.urlPath}` || source === spec.path)
  const hasElsewhereSource = configured.some((source) => !/^https?:/i.test(source))
  const { specs, skipped } = findPublicSpecs(projectDir)
  for (const spec of specs) {
    if (isConfigured(spec)) continue // validateOpenApi already reports it
    if (!spec.hasHiddenOperations && !hasElsewhereSource) continue
    issues.push({
      severity: 'warning',
      file: spec.path,
      message: `${spec.path} is an OpenAPI file served publicly as /${spec.urlPath}${spec.hasHiddenOperations ? ' and it contains x-excluded/x-hidden operations, which are downloadable from it' : ' but is not the spec this site is configured with (an old copy?)'}.${shadowNote(spec.urlPath)} Re-running migration into an existing site does not remove old copies from public/: delete this file manually`,
    })
  }
  for (const path of skipped) {
    issues.push({ severity: 'warning', file: path, message: `${path} is too large to inspect; if it is an OpenAPI file with hidden operations it is served as-is from public/` })
  }
}

/** A tab's spec as the docs route serves it; no document when it is remote or cannot be read here. */
function loadCheckSpec(projectDir: string, source: string, overrides: unknown): CheckSpec {
  if (/^https?:/i.test(source)) return { source, overrides }
  const specPath = source.startsWith('/') ? join(projectDir, 'public', source.slice(1)) : join(projectDir, source)
  try {
    const raw = readFileSync(specPath, 'utf8')
    return { source, overrides, document: /\.json$/i.test(source) ? JSON.parse(raw) : parseYaml(raw) }
  } catch {
    return { source, overrides } // validateOpenApi reports a missing or invalid spec
  }
}

/**
 * A key in an API tab's `api.groups` that matches no published operation of its
 * spec is skipped by the sidebar (a typo, or a hidden or excluded operation), and
 * so is an entry that is not a group or a key, or a group nested too deep. A group
 * icon that is not text is dropped, and `groups` that is not a list is ignored (the
 * generated navigation shows instead). Remote and unreadable specs cannot be judged here.
 * Checks the root tabs and the tabs of every `i18n.navigation` locale, as the
 * sidebar renders them.
 */
export function checkApiGroupKeys(projectDir: string, config: DocsJsonConfig, issues: LintIssue[]): void {
  const versions = config.navigation?.versions
  const seen = new Set<unknown>()
  const scopes: Array<[locale: string | undefined, tabs: unknown]> = [[undefined, config.tabs], ...Object.entries(config.i18n?.navigation ?? {})]
  for (const [locale, tabs] of scopes) {
    for (const tab of (Array.isArray(tabs) ? tabs : []) as Array<ApiGroupsTab | null>) {
      if (!tab || typeof tab !== 'object' || seen.has(tab)) continue
      seen.add(tab)
      checkTabApiGroups(projectDir, tab, locale, versions, issues)
    }
  }
}

interface ApiGroupsTab {
  tab: string
  hidden?: boolean
  version?: string
  api?: { source?: string; navigation?: boolean; groups?: unknown }
}

function checkTabApiGroups(projectDir: string, tab: ApiGroupsTab, locale: string | undefined, versions: unknown, issues: LintIssue[]): void {
  const name = `API tab "${tab.tab}"${locale ? ` (locale ${locale})` : ''}`
  // The sidebar renders a hidden tab when its `version` is a `navigation.versions` label
  // (getSidebarCollections in src/data/docs.ts); every other hidden tab has no sidebar to check.
  // Malformed `navigation.versions` (not a list, null entries) registers no version.
  const rendered = !tab.hidden || Boolean(tab.version && Array.isArray(versions)
    && versions.some((version) => version !== null && typeof version === 'object' && version.label === tab.version))
  // `navigation: false` turns the generated sidebar off, so `api.groups` is unused there.
  if (!rendered || typeof tab.api?.source !== 'string' || tab.api.navigation === false) return
  if (tab.api.groups !== undefined && !Array.isArray(tab.api.groups)) {
    issues.push({
      severity: 'warning',
      file: 'docs.json',
      message: `${name}: api.groups must be a list of groups, so the tab shows the generated navigation. A list looks like [{ "group": "Name", "pages": ["GET /path"] }]`,
    })
  }
  const skipped = { malformed: 0, tooDeep: false, badIcon: 0 }
  const keys = listedOperationKeys(tab.api.groups, skipped)
  if (skipped.malformed > 0) {
    issues.push({
      severity: 'warning',
      file: 'docs.json',
      message: `${name}: api.groups has ${skipped.malformed} ${skipped.malformed === 1 ? 'entry that is' : 'entries that are'} not a group with a "pages" list or an operation key. ${skipped.malformed === 1 ? 'It is' : 'They are'} left out of the sidebar. A group looks like { "group": "Name", "pages": ["GET /path"] }`,
    })
  }
  if (skipped.badIcon > 0) {
    issues.push({
      severity: 'warning',
      file: 'docs.json',
      message: `${name}: api.groups has ${skipped.badIcon} ${skipped.badIcon === 1 ? 'group' : 'groups'} whose "icon" is not text. The icon is dropped and the group is still listed. Use an icon name or an image path`,
    })
  }
  if (skipped.tooDeep) {
    issues.push({
      severity: 'warning',
      file: 'docs.json',
      message: `${name}: api.groups nests groups deeper than ${API_GROUPS_MAX_DEPTH} levels. Groups beyond that level are left out of the sidebar`,
    })
  }
  if (keys.length === 0) return
  const spec = loadCheckSpec(projectDir, tab.api.source, (tab.api as { overrides?: unknown }).overrides)
  if (!spec.document || typeof spec.document !== 'object') return // remote, unreadable or empty: validateOpenApi reports it
  for (const key of keys) {
    const state = groupKeyState(spec.document, key, spec.overrides)
    if (state === 'published') continue
    issues.push({
      severity: 'warning',
      file: 'docs.json',
      message: `${name}: api.groups lists "${key}", which matches no published operation in ${spec.source}${state === 'unknown' ? '' : ` (it is ${state})`}. It is left out of the sidebar. Check the method and path, or publish the operation`,
    })
  }
}

/**
 * A page whose `openapi:` frontmatter names a hidden or excluded operation of
 * the site's default spec (the first visible API tab's, which is what the
 * route consults) 404s and is left out of every listing. Unknown operations
 * are not reported, and remote specs cannot be judged here.
 */
function checkUnpublishedOperationPages(
  projectDir: string,
  tabs: Array<{ hidden?: boolean; api?: { source?: string } }>,
  pages: Array<{ file: string; reference: DocReference }>,
  issues: LintIssue[],
): void {
  if (pages.length === 0) return
  // The specs the docs route serves, in its order: visible API tabs, the first being the default.
  const specs: Array<CheckSpec> = tabs
    .filter((tab) => !tab.hidden && typeof tab.api?.source === 'string')
    .map((tab) => loadCheckSpec(projectDir, tab.api!.source as string, (tab.api as { overrides?: unknown }).overrides))
  if (specs.length === 0) return
  for (const { file, reference } of pages) {
    const state = pageState(reference, specs)
    if (state === 'hidden' || state === 'excluded') {
      const operation = `${reference.specRef ? `${reference.specRef} ` : ''}${reference.method} ${reference.path}`
      issues.push({
        severity: 'warning',
        file,
        message: `page ${file} points at ${state} operation ${operation} and is not published: it returns 404 and is left out of navigation, search, sitemap and llms.txt. Publish the operation or point the page at another one`,
      })
    }
  }
}

function validateOpenApi(projectDir: string, source: string, issues: LintIssue[], overrides?: unknown): void {
  // Runtime URL-style sources are author-owned files below `public/`, while
  // relative sources are resolved from the project root.
  const specPath = source.startsWith('/')
    ? join(projectDir, 'public', source.slice(1))
    : join(projectDir, source)
  if (!existsSync(specPath)) {
    issues.push({ severity: 'error', message: `API reference points at "${source}" but the file does not exist`, file: source })
    return
  }
  let spec: unknown
  try {
    const raw = readFileSync(specPath, 'utf8')
    spec = source.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)
  } catch (err) {
    issues.push({ severity: 'error', message: `OpenAPI spec is not valid ${source.endsWith('.json') ? 'JSON' : 'YAML'}: ${(err as Error).message}`, file: source })
    return
  }
  const s = spec as Record<string, unknown>
  // Files under public/ are served verbatim by the host, bypassing the
  // publication filter that drops hidden/excluded operations.
  if (s && typeof s === 'object' && (source.startsWith('/') || source.replace(/^\.\//, '').startsWith('public/')) &&
    specHasHiddenOperations(s, overrides)) {
    issues.push({
      severity: 'warning',
      message: `OpenAPI spec "${source}" lives under public/ and contains x-excluded/x-hidden operations; public/ is served as-is, so those operations would be downloadable.${shadowNote(source.replace(/^\.?\/+/, '').replace(/^public\//, ''))} Move it to a project-root path such as "openapi/${source.split('/').pop()}", update docs.json, and delete the copy in public/ (re-running migration into an existing site does not remove old copies from public/)`,
      file: source,
    })
  }
  if (typeof s?.openapi !== 'string' && typeof s?.swagger !== 'string') {
    issues.push({ severity: 'error', message: 'OpenAPI spec is missing the "openapi" (or "swagger") version field', file: source })
  }
  if (typeof s?.info !== 'object' || s.info === null) {
    issues.push({ severity: 'error', message: 'OpenAPI spec is missing the "info" object', file: source })
  }
  const paths = s?.paths
  // OpenAPI 3.1 only needs one of paths, webhooks or components (a webhook-only spec is valid).
  const is31 = typeof s?.openapi === 'string' && s.openapi.startsWith('3.1')
  const hasOtherRoot = (key: string): boolean => typeof s?.[key] === 'object' && s[key] !== null
  if (typeof paths !== 'object' || paths === null) {
    if (!is31 || !(hasOtherRoot('webhooks') || hasOtherRoot('components'))) {
      issues.push({ severity: 'error', message: is31 ? 'OpenAPI spec needs a "paths", "webhooks" or "components" object' : 'OpenAPI spec is missing the "paths" object', file: source })
    }
  } else {
    const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'])
    for (const [p, ops] of Object.entries(paths as Record<string, unknown>)) {
      if (typeof ops !== 'object' || ops === null) {
        issues.push({ severity: 'error', message: `OpenAPI path "${p}" is not an object`, file: source })
        continue
      }
      const hasOp = Object.keys(ops as Record<string, unknown>).some((k) => methods.has(k.toLowerCase()))
      if (!hasOp && typeof (ops as Record<string, unknown>).$ref !== 'string') {
        issues.push({ severity: 'warning', message: `OpenAPI path "${p}" has no operations`, file: source })
      }
    }
  }
}

/** Check a site's content and return a CLI-compatible success or failure code. */
export async function runCheck(projectDir: string, options: CheckOptions): Promise<number> {
  const { fix, ci } = options

  if (!existsSync(join(projectDir, 'docs.json'))) {
    if (!options.silent) console.error(`\n  ❌ Not a Thally project: docs.json not found in ${projectDir}\n`)
    else options.onIssues?.([{ severity: 'error', message: `docs.json not found in ${projectDir}` }])
    return 1
  }

  const contentDir = join(projectDir, 'src', 'content')
  const issues: LintIssue[] = []
  const config = readDocsJson(projectDir)
  const secondaryLocales = new Set(
    (config.i18n?.locales ?? [])
      .map((locale) => locale.code)
      .filter((code) => code !== config.i18n?.defaultLocale),
  )
  const generatedApiPaths = new Set([
    '/api',
    ...Array.from(secondaryLocales, (locale) => `/${locale}/api`),
  ])
  const redirectDestinations = new Map(
    (config.redirects ?? [])
      .filter((redirect) => !redirect.source.includes(':'))
      .map((redirect) => [
        redirect.source.replace(/\/$/, '') || '/',
        redirect.destination,
      ]),
  )
  const dynamicRedirects = (config.redirects ?? []).flatMap((redirect) => {
    const compiled = compileDynamicRedirectSource(redirect.source, redirect.destination)
    return compiled ? [compiled] : []
  })

  for (const message of validateIntegrations((config as { integrations?: unknown }).integrations)) {
    issues.push({ severity: 'warning', message, file: 'docs.json' })
  }

  const navigation = projectNavigationContract(config)
  const navPageIds = new Set(navigation.authoredPageIds)
  for (const tab of navigation.emptyTabs) {
    issues.push({ severity: 'error', message: `Tab "${tab}" has no groups and no href — it will render empty` })
  }

  for (const dup of navigation.duplicatePageIds) {
    // Reusing one page in multiple sections is supported by both Mintlify and
    // Thally. Surface the editorial ambiguity without failing an otherwise
    // valid migration or CI run.
    issues.push({ severity: 'warning', message: `[duplicate] "${dup}" appears more than once in docs.json` })
  }

  for (const pageId of navPageIds) {
    const candidates = [join(contentDir, `${pageId}.mdx`), join(contentDir, `${pageId}/index.mdx`)]
    if (!candidates.some((c) => existsSync(c))) {
      issues.push({ severity: 'error', message: `"${pageId}" is in docs.json but has no MDX file`, file: `src/content/${pageId}.mdx` })
    }
  }

  const allFiles: string[] = []
  if (existsSync(contentDir)) scanMdx(contentDir, allFiles)

  const fixedOrphans: string[] = []
  const operationPages: Array<{ file: string; reference: DocReference }> = []
  const validPaths = new Set<string>(['/'])
  const anchorsByPath = new Map<string, Set<string>>()
  const linksByFile: Array<{ file: string; path: string; anchors: Set<string>; links: FoundLink[]; images: FoundLink[]; offset: number }> = []

  for (const filePath of allFiles) {
    const rel = filePath.slice(contentDir.length + 1).replace(/\.mdx$/, '').replace(/\\/g, '/')
    const pageId = rel.endsWith('/index') ? rel.slice(0, -6) : rel

    let data: Record<string, unknown> = {}
    let content = ''
    let lineOffset = 0
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = parseFrontmatter(raw)
      data = parsed.data
      content = parsed.content
      // Links/anchors are found in `content` (frontmatter stripped); offset the
      // reported line numbers back to the raw file so CI annotations land right.
      lineOffset = raw.slice(0, raw.indexOf(content)).split('\n').length - 1
    } catch {
      issues.push({ severity: 'error', message: `Could not parse frontmatter`, file: relative(projectDir, filePath) })
      continue
    }

    const { navPageId } = localizedPage(pageId, secondaryLocales)
    if (!navPageIds.has(navPageId) && data.hidden !== true) {
      if (fix) {
        addOrphanToNav(projectDir, pageId)
        fixedOrphans.push(pageId)
      } else {
        issues.push({ severity: 'warning', message: `"${pageId}" is not in docs.json nav (orphan)`, file: relative(projectDir, filePath) })
      }
    }

    const rel2 = relative(projectDir, filePath)
    if (!data.title) issues.push({ severity: 'warning', message: `Missing "title" in frontmatter`, file: rel2 })
    if (!data.description) issues.push({ severity: 'warning', message: `Missing "description" in frontmatter`, file: rel2 })
    if (typeof data.openapi !== 'string' && content.trim().length < 50) {
      issues.push({ severity: 'warning', message: `Very short body (${content.trim().length} chars) — page may be empty`, file: rel2 })
    }

    const reference = parseDocReference(data.openapi)
    if (reference) operationPages.push({ file: rel2, reference })
    for (const message of manualApiProblems(rel2, data, Boolean(reference), content, (config as { api?: unknown }).api)) {
      issues.push({ severity: 'warning', file: rel2, message })
    }

    if (options.drift) checkDrift(projectDir, rel2, data, issues)

    const path = pageIdToPath(pageId, secondaryLocales)
    const anchors = extractHeadingAnchors(content)
    validPaths.add(path)
    // The runtime accepts the explicit introduction slug as well as `/`.
    validPaths.add(`/${pageId}`)
    anchorsByPath.set(path, anchors)
    anchorsByPath.set(`/${pageId}`, anchors)
    linksByFile.push({ file: rel2, path, anchors, links: extractLinks(content), images: extractImageRefs(content), offset: lineOffset })
  }

  // Reader routes fall back to the primary document when no translated file
  // exists. Use its anchors only for those fallback paths; real translations
  // retain their own headings and may differ from the source language.
  for (const [path, anchors] of [...anchorsByPath]) {
    if (secondaryLocales.has(path.split('/')[1])) continue
    for (const locale of secondaryLocales) {
      const localized = `/${locale}${path === '/' ? '' : path}`
      if (validPaths.has(localized)) continue
      validPaths.add(localized)
      anchorsByPath.set(localized, anchors)
    }
  }

  // Broken internal link + anchor detection (after all valid paths are known).
  const externalLinks: Array<ExternalLinkReference> = []
  for (const { file, anchors, links, offset } of linksByFile) {
    for (const { target, line: contentLine } of links) {
      const line = contentLine + offset
      if (/^(https?:|mailto:|tel:)/i.test(target)) {
        // External — collected here and network-checked only with --external.
        if (/^https?:/i.test(target)) externalLinks.push({ url: target, file, line })
        continue
      }
      if (target.startsWith('#')) {
        const anchor = target.slice(1)
        if (anchor && !anchors.has(decodedFragment(anchor))) {
          issues.push({ severity: 'warning', message: `Broken anchor: "${target}" not found on this page`, file, line })
        }
        continue
      }
      if (!target.startsWith('/')) continue // relative/asset links — not validated
      const { path, anchor, cycle, external } = resolveLink(target, redirectDestinations, dynamicRedirects)
      if (external) continue
      const isGeneratedApiPath = Array.from(generatedApiPaths).some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      )
      if (!cycle && (isGeneratedApiPath || path.startsWith('/_next') || /\.[a-z0-9]+$/i.test(path))) continue // generated/assets
      if (cycle || !validPaths.has(path)) {
        issues.push({ severity: 'error', message: `Broken link: "${target}" — no page at "${path}"`, file, line })
      } else if (anchor && !anchorsByPath.get(path)?.has(decodedFragment(anchor))) {
        issues.push({ severity: 'warning', message: `Broken anchor: "${target}" — no heading "#${anchor}" on that page`, file, line })
      }
    }
  }

  // Local image existence: a broken `<img>`/`![]()` src doesn't fail `next
  // build` (Next.js just renders a broken image), so this is a warning, not
  // an error — unlike a broken internal link, which 404s. Only root-relative
  // paths are checked (asset copy always writes under `public/`); external
  // URLs, data URIs, and template-interpolated values are skipped.
  const publicDir = join(projectDir, 'public')
  for (const { file, images, offset } of linksByFile) {
    for (const { target, line: contentLine } of images) {
      const line = contentLine + offset
      if (/^(https?:|data:|\{)/i.test(target)) continue
      if (!target.startsWith('/')) continue
      const pathOnly = target.split(/[?#]/, 1)[0]
      let decoded: string
      try {
        decoded = decodeURIComponent(pathOnly)
      } catch {
        continue
      }
      if (!existsSync(join(publicDir, decoded))) {
        issues.push({ severity: 'warning', message: `Image not found: "${target}" has no file under public/`, file, line })
      }
    }
  }

  // OpenAPI validation for each API tab.
  for (const tab of config.tabs) {
    if (tab.api?.source) validateOpenApi(projectDir, tab.api.source, issues, (tab.api as { overrides?: unknown }).overrides)
  }

  checkPublicSpecs(projectDir, config.tabs, issues)
  checkUnpublishedOperationPages(projectDir, config.tabs, operationPages, issues)
  checkApiGroupKeys(projectDir, config, issues)

  if (options.external && externalLinks.length > 0) {
    issues.push(...await checkExternalLinks(externalLinks, options.externalLinkOptions))
  }

  const errors = issues.filter((i) => i.severity === 'error')
  options.onIssues?.(issues)
  const warnings = issues.filter((i) => i.severity === 'warning')

  if (options.silent) return errors.length > 0 ? 1 : 0

  if (ci) {
    // GitHub Actions annotations (::error / ::warning), then a compact summary.
    for (const issue of issues) {
      const loc = issue.file ? `file=${issue.file}${issue.line ? `,line=${issue.line}` : ''}` : ''
      console.log(`::${issue.severity} ${loc}::${issue.message}`)
    }
    console.log(`\nthally check: ${errors.length} error(s), ${warnings.length} warning(s)`)
    return errors.length > 0 ? 1 : 0
  }

  console.log(`\n  Linting ${projectDir}...\n`)
  if (errors.length === 0 && warnings.length === 0 && fixedOrphans.length === 0) {
    console.log('  ✅ No issues found.\n')
    return 0
  }
  console.log(`  ❌ ${errors.length} error${errors.length !== 1 ? 's' : ''}, ⚠️  ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}\n`)

  if (errors.length > 0) {
    console.log('  ERRORS:')
    for (const issue of errors) {
      console.log(`    ${issue.message}`)
      if (issue.file) console.log(`    → ${issue.file}${issue.line ? `:${issue.line}` : ''}`)
    }
    console.log('')
  }
  if (warnings.length > 0) {
    console.log('  WARNINGS:')
    for (const issue of warnings) {
      console.log(`    ${issue.message}`)
      if (issue.file) console.log(`    → ${issue.file}${issue.line ? `:${issue.line}` : ''}`)
    }
    console.log('')
  }
  if (fixedOrphans.length > 0) {
    console.log(`  ✅ Auto-fixed ${fixedOrphans.length} orphan page${fixedOrphans.length > 1 ? 's' : ''} (added to nav):`)
    for (const p of fixedOrphans) console.log(`    + ${p}`)
    console.log('')
  }
  if (!fix && warnings.some((w) => w.message.includes('orphan'))) {
    console.log('  Tip: run with --fix to auto-add orphan pages to navigation.\n')
  }

  return errors.length > 0 ? 1 : 0
}
