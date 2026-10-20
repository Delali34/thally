/**
 * Repository adapter for the shared migration engine. Traversal is bounded;
 * `scanFiles` follows a symbolic link only when its resolved real path stays
 * inside the repository checkout (this covers a submodule mounted as a
 * symlink, e.g. Oasis's `docs/core -> ../external/oasis-core/docs`) and
 * guards against a cycle, but every other directory walk in this file still
 * skips symlinks outright. Git is always invoked with an argument array so
 * source-controlled branch names can never become shell commands.
 */

import { compileSync } from '@mdx-js/mdx'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, posix, relative, resolve as resolvePath, sep } from 'node:path'

import { parse as parseYaml } from 'yaml'
import * as ts from 'typescript'

import { isSelfContainedFunction, pageScopeNames } from './inline-extraction.js'
import { isThallyBuiltinComponent } from './builtin-components.js'
import { createComponentMigrator, declarationsReferenceBrowserGlobal, hasAnyFunctionValuedProp, normalizeIndentedFences, propsTargetExtractedClientComponent, unresolvedRelativeModuleSpecifiers } from './components.js'
import { navbarLinkButtons, projectAuthoredStyles } from './source-styles.js'

import {
  addDocusaurusTranslatedHeadingAliases,
  expandDocusaurusDocCardLists,
  projectDocusaurusNavigation,
  readDocusaurusRedirects,
  readDocusaurusSiteOrigin,
  readDocusaurusSiteSettings,
  readDocusaurusSidebars,
  readDocusaurusThemeColor,
  readDocusaurusPresentation,
  rewriteDocusaurusLinks,
  resolveDocusaurusPageIdentity,
  type DocusaurusPageDescriptor,
  type DocusaurusSidebars,
} from './docusaurus.js'
import type { FernApiSection } from './fern.js'
import { projectFernNavigation, readFernConfig } from './fern.js'
import { isRemoteSpecRef, namesSeveralSpecs, resolveSpecRef, specNamedByPage, type SpecCandidate, type SpecRefResolution } from './openapi-ref.js'
import { operationKey } from './spec-exclude.js'
import { splitOpenApiRef, specRefBaseName, withSpecRef } from './openapi-ref.js'
import { markExcluded, parseSpecDocument, sharedSpecMessage, specRefMatches, withheldOperationKeys, withoutByteOrderMark } from './spec-exclude.js'
import { parseFrontmatter } from './frontmatter.js'
import { mainSiteLinkTarget, prefixRootLinks, sourceRefMountCollides, stripControlCharacters, type RootLinkIndex, type SourceRefImport } from './source-refs.js'
import { canonicalSpecRef } from './openapi-ref.js'
import { type BrandVars, brandColorsFromVars, cssBrandVars, cssColorToHex } from './css-colors.js'
import {
  frontmatterAccess,
  isMintlifyServedScriptOrStyle,
  isNavigationRestricted,
  isRestrictedAccess,
  mergeNavigationAppearances,
  mintlifyAppearance,
  mintlifyFontSources,
  navigationGateReason,
  resolvePageAccess,
} from './mintlify-extras.js'
import type { MintlifyAccess, NavigationAccess, ResolvedPageAccess } from './mintlify-extras.js'
import { mdxVisibleText, resolvePageDisplayHeading, bindSnippetProps, closeOpenFence, escapeFernLiteralBraces, escapeUnmatchedClosingTags, functionDeclaredNames, mdxComment, parseMarkdownPage, normalizeExplicitHeadingIds, protectMathBlocks, replaceLinkWithAnchor, replaceOutsideCode, scanJsxOpeningTag, replaceOutsideCodeAndComments, replaceUnknownComponents, rewriteFernRelativePageLinks } from './mdx.js'
import {
  addMintlifyDirectoryRedirects,
  addMintlifyHomepageRedirects,
  buildNavigationFromPages,
  isDocumentationExtension,
  insertApiTab,
  mintlifyAllVersionPrefixes,
  mintlifyDefaultVersionPrefixes,
  mergeApiGroups,
  mintlifyNavigationApiReferences,
  projectMintlifyNavigation,
  pruneMissingNavigationPages,
  readMintlifyConfig,
  type MintlifyApiSpecReference,
  type MintlifyNavigationResult,
} from './navigation.js'
import { projectMintlifyIntegrations } from './analytics.js'
import {
  normalizeAssetPath,
  mintlifyLocalizedReference,
  pageIdFromReference,
  resolveWithin,
  resolveWithinRoot,
  trimEdgeSlashes,
  isPathEscapeError,
  trimTrailingSlashes,
  withinRealRoot,
} from './path.js'
import { dropConflictingRedirects, dropUnroutableRedirects, literalRoute, pageEntryRoutes, servedRoutes } from './redirects.js'
import type {
  MigrationApiGroup,
  MigrationAsset,
  MigrationBundle,
  MigrationDocsConfig,
  MigrationNavigationGroup,
  MigrationNavigationTab,
  MigrationPage,
  MigrationPlatform,
  MigrationWarning,
  EndpointPagesTarget,
  EndpointTabSlot,
  RemoteApiSpec,
  RenderedMigrationFile,
} from './types.js'

const MAX_SOURCE_FILES = 5_000
const MAX_PAGE_BYTES = 2_000_000
/** Window read to classify the access gate of an oversized page. */
const FRONTMATTER_HEAD_BYTES = 65_536
/** Largest withheld page still read to find the assets it uses; beyond this they are unknown and reported. */
const MAX_WITHHELD_SCAN_BYTES = MAX_PAGE_BYTES * 8
/** Per-page warnings for restricted pages the file budget dropped; the rest are counted in one more. */
const MAX_DROPPED_GATED_WARNINGS = 20
/** Per-site cap on generated Mintlify endpoint redirects, so a huge spec cannot flood the redirect table. */
const MAX_ENDPOINT_REDIRECTS = 2_000
const MAX_ASSET_BYTES = 25_000_000
// A referenced screenshot or animation is part of the page, not a spare
// repository asset. Allow a larger individual file while retaining a firm
// aggregate copy budget for untrusted repositories.
const MAX_REFERENCED_ASSET_BYTES = 100_000_000
const MAX_TOTAL_ASSET_BYTES = 500_000_000
/** A Git LFS pointer file's fixed opening line (the smudge filter replaces this with the real binary; skipping it during clone leaves this text in place). */
const GIT_LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1'

/** The first few paths of a skipped-asset list, with the remainder counted. */
function listAssetPaths(paths: Array<string>): string {
  const shown = paths.slice(0, 5).join(', ')
  return paths.length > 5 ? `${shown}, and ${paths.length - 5} more` : shown
}

/** A small text file starting with the fixed Git LFS pointer line, not real asset content. */
function isGitLfsPointer(content: Buffer): boolean {
  return content.length < 1024 && content.toString('utf8', 0, GIT_LFS_POINTER_PREFIX.length) === GIT_LFS_POINTER_PREFIX
}
const IGNORED_DIRECTORIES = new Set([
  '.git', '.github', '.next', '.turbo', '.vercel', '.vscode',
  'node_modules', 'dist', 'build', 'coverage',
])
// `dist`/`build`/`coverage` are build output when found while *looking for*
// a docs root (root-detection BFS below, which walks the whole repository
// checkout) — but once a docs content root is actually confirmed, a
// same-named subdirectory inside it is real content, not output (e.g.
// oasisprotocol/docs's `docs/build/`, a live section of the site).
// `scanFiles`'s own walk is always already confined to a confirmed content
// root, so it uses this narrower set instead of `IGNORED_DIRECTORIES`.
function isIgnoredContentDirectory(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}
/** Project-root directory for withheld restricted pages and assets; never read by the runtime. */
const QUARANTINE_DIRECTORY = 'migration-quarantine'
const ASSET_DIRECTORIES = new Set(['assets', 'images', 'img', 'media', 'public', 'static'])
const ASSET_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.m4a', '.mp3', '.mp4',
  '.ogg', '.pdf', '.png', '.svg', '.wav', '.webm', '.webp',
])
const REPOSITORY_ONLY_DOCUMENTS = new Set([
  'agents.md', 'claude.md', 'code_of_conduct.md', 'contributing.md',
  'license.md', 'readme.md', 'security.md',
])
const SNIPPET_DIRECTORIES = new Set(['snippets', '_snippets', 'partials', '_partials'])
// Matches a default import (`import Name from '...'`), a default-as-named
// import (`import { default as Name } from '...'`), and a plain named import
// (`import { Name } from '...'`) — Mintlify snippets can export either way.
const SNIPPET_IMPORT_PATTERN = /\bimport\s+(?:\{\s*(?:default\s+as\s+)?([A-Z][A-Za-z0-9_]*)\s*\}|([A-Z][A-Za-z0-9_]*))\s+from\s+['"]([^'"]+\.mdx?)['"]\s*;?/g
/** Empty stand-ins for the exports Docusaurus adds to every MDX document (its own TOC feeds are not used). */
const DOCUSAURUS_GENERATED_EXPORTS: Record<string, string | undefined> = Object.assign(Object.create(null) as Record<string, string>, {
  toc: '[]', frontMatter: '{}', metadata: '{}', assets: '{}', contentTitle: 'undefined',
})
const SNIPPET_VALUE_IMPORT_PATTERN = /\bimport\s*\{([^{}]+)\}\s*from\s+['"]([^'"]+\.mdx?)['"]\s*;?/g

/**
 * Mintlify's `<Snippet file="path.mdx" />` tag form: unlike the import form
 * above, this never needs a matching `import` statement — `file` is a path
 * relative to the project's `snippets/` directory (Mintlify's own
 * convention; see `resolveSnippetPath`'s sibling below for the actual
 * lookup). Both self-closing and paired spellings are matched; a paired
 * tag's own children (if any) are always discarded in favor of the
 * resolved snippet's real content, matching Mintlify's own renderer.
 */
const SNIPPET_TAG_PATTERN = /<Snippet\s+file=(?:"([^"]+)"|'([^']+)')\s*(?:\/>|>[\s\S]*?<\/Snippet>)/g
/** Fern's `<Markdown src="..." />` include. Only Fern treats it as a file include. */
const FERN_MARKDOWN_TAG_PATTERN = /<Markdown\s+src=(?:"([^"]+)"|'([^']+)')\s*(?:\/>|>[\s\S]*?<\/Markdown>)/g
const MINTIGNORE_FILENAME = '.mintignore'
interface IgnoreMatcher {
  add(patterns: string): IgnoreMatcher
  ignores(pathname: string): boolean
}
// `ignore`'s CJS default export is mistyped under NodeNext module resolution
// (the default import resolves to the whole module namespace); load it
// through `require` and type it locally instead of fighting the interop.
const createIgnoreMatcher = createRequire(import.meta.url)('ignore') as () => IgnoreMatcher

/** Dotfile directories (`.tooling`, `.vale`, tool/editor config, ...) never hold docs pages. */
function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name)
}

const OPENAPI_FILENAMES = new Set([
  'openapi.json', 'openapi.yaml', 'openapi.yml',
  'swagger.json', 'swagger.yaml', 'swagger.yml',
])

export interface GitHubRepositorySource {
  owner: string
  repo: string
  branch: string
  docsDir: string
  cloneUrl: string
}

export interface RepositoryMigrationOptions {
  repositoryDir: string
  sourceUrl: string
  docsDir?: string
  platform?: MigrationPlatform
  /** @internal Mount path of a sourceRef import; keeps its component files separate from any other copy of the same source. */
  componentNamespace?: string
  /** @internal Prefix used by additional Docusaurus docs-plugin instances. */
  docusaurusRoutePrefix?: string
  /** @internal Prevent recursive discovery while importing one plugin root. */
  docusaurusSkipPlugins?: boolean
  /** @internal Additional docs plugins default to autogenerated navigation. */
  docusaurusSkipSidebar?: boolean
  /** @internal A version's sidebar is parsed as static data. */
  docusaurusSidebarPath?: string
  /** @internal Static assets are shared across docs-plugin instances. */
  docusaurusSkipAssets?: boolean
  /** @internal Test seam: lowers the 5,000-file budget so budget behaviour can be exercised with small fixtures. */
  maxSourceFiles?: number
  /** @internal Redirects are global config, read once, not per plugin instance. */
  docusaurusSkipRedirects?: boolean
  /** Mintlify `sourceRef` repositories already fetched and prepared by `importSourceRef`. */
  sourceRefs?: ReadonlyArray<SourceRefImport>
}

interface DocusaurusPluginRoot {
  docsDir: string
  routePrefix: string
}

interface DocusaurusArchiveRoot extends DocusaurusPluginRoot {
  label: string
  sidebarPath?: string
}

const DOCUSAURUS_CONFIG_FILENAMES = [
  'docusaurus.config.js',
  'docusaurus.config.ts',
  'docusaurus.config.mjs',
]

function hasDocusaurusConfig(directory: string): boolean {
  return DOCUSAURUS_CONFIG_FILENAMES.some((filename) => {
    const path = resolveWithin(directory, filename)
    return existsSync(path) && lstatSync(path).isFile()
  })
}

function hasMintlifyConfig(directory: string): boolean {
  return ['docs.json', 'mint.json'].some((filename) => {
    const path = resolveWithin(directory, filename)
    if (!existsSync(path) || !lstatSync(path).isFile()) return false
    if (filename === 'mint.json') return true
    try {
      const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      return String(config.$schema ?? '').includes('mintlify') || 'navigation' in config
    } catch {
      return false
    }
  })
}

/**
 * Recursively counts `.md`/`.mdx` files under `directory` (skipping
 * ignored/symlinked directories, same as the root-finding BFS above), for
 * ranking two candidate project roots against each other. Bounded so a huge
 * false-positive candidate (e.g. `node_modules` slipping past
 * `isIgnoredDirectory`) can't make root detection itself slow.
 */
function countMarkdownPages(directory: string, limit = 20_000): number {
  let count = 0
  const stack: Array<string> = [directory]
  while (stack.length > 0 && count < limit) {
    const current = stack.pop()!
    let entries: Array<Dirent>
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(entry.name)) stack.push(resolveWithin(current, entry.name))
      } else if (/\.mdx?$/i.test(entry.name)) {
        count++
      }
    }
  }
  return count
}

/**
 * Multiple config files can each look like a valid project root in the same
 * repository (Infisical ships both a top-level `company/mint.json` handbook
 * and `docs/docs.json`, the real docs). Picking the first one a breadth-
 * first walk happens to reach silently imports the wrong, usually much
 * smaller, site. Rank every candidate instead: `docs.json` before
 * `mint.json` (Mintlify's own current format), then a directory literally
 * named `docs`, then whichever has the most actual content — and warn
 * whenever there was more than one candidate, so a wrong guess is visible
 * and `--docs-dir` is offered as the fix, even when the ranking picked the
 * one the caller actually wanted.
 */
function pickPreferredDocsRoot(
  candidates: Array<string>,
  repositoryDir: string,
  platformLabel: string,
  warnings: Array<MigrationWarning> | undefined,
  rank?: (directory: string) => number,
): string {
  const ranked = [...candidates].sort((left, right) => {
    const byRank = (rank?.(right) ?? 0) - (rank?.(left) ?? 0)
    if (byRank !== 0) return byRank
    const byName = (basename(right) === 'docs' ? 1 : 0) - (basename(left) === 'docs' ? 1 : 0)
    if (byName !== 0) return byName
    return countMarkdownPages(right) - countMarkdownPages(left)
  })
  const winner = ranked[0]
  if (candidates.length > 1 && warnings) {
    const relativePaths = candidates.map((candidate) => relative(repositoryDir, candidate) || '.')
    warnings.push({
      code: 'unsupported-config',
      message: `Multiple possible ${platformLabel} project roots were found (${relativePaths.join(', ')}); `
        + `${relative(repositoryDir, winner) || '.'} was picked. Pass --docs-dir to choose a different one if this is wrong.`,
      source: '.',
    })
  }
  return winner
}

function findMintlifyProjectRoot(repositoryDir: string, docsDir?: string, warnings?: Array<MigrationWarning>): string | null {
  if (docsDir !== undefined) {
    let candidate = trimTrailingSlashes(docsDir)
    while (true) {
      const path = resolveWithin(repositoryDir, candidate || '.')
      if (hasMintlifyConfig(path)) return path
      if (!candidate) break
      const parent = dirname(candidate)
      candidate = parent === '.' ? '' : parent
    }
  }
  const candidates: Array<string> = []
  const queue: Array<{ directory: string; depth: number }> = [{ directory: repositoryDir, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 500) {
    const current = queue.shift()!
    visited++
    if (hasMintlifyConfig(current.directory)) candidates.push(current.directory)
    if (current.depth >= 4) continue
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || isIgnoredDirectory(entry.name)) continue
      queue.push({ directory: resolveWithin(current.directory, entry.name), depth: current.depth + 1 })
    }
  }
  if (candidates.length === 0) return null
  return pickPreferredDocsRoot(candidates, repositoryDir, 'Mintlify', warnings, (directory) => (
    existsSync(resolveWithin(directory, 'docs.json')) ? 1 : 0
  ))
}

function hasFernConfig(directory: string): boolean {
  return ['docs.yml', 'fern.config.json'].every((filename) => {
    const path = resolveWithin(directory, filename)
    return existsSync(path) && lstatSync(path).isFile()
  })
}

function findFernProjectRoot(repositoryDir: string, docsDir?: string): string | null {
  if (docsDir !== undefined) {
    let candidate = trimTrailingSlashes(docsDir)
    while (true) {
      const path = resolveWithin(repositoryDir, candidate || '.')
      if (hasFernConfig(path)) return path
      if (!candidate) break
      const parent = dirname(candidate)
      candidate = parent === '.' ? '' : parent
    }
  }
  const queue: Array<{ directory: string; depth: number }> = [{ directory: repositoryDir, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 500) {
    const current = queue.shift()!
    visited++
    if (hasFernConfig(current.directory)) return current.directory
    if (current.depth >= 4) continue
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || isIgnoredDirectory(entry.name)) continue
      queue.push({ directory: resolveWithin(current.directory, entry.name), depth: current.depth + 1 })
    }
  }
  return null
}

function findDocusaurusProjectRoot(repositoryDir: string, docsDir?: string, warnings?: Array<MigrationWarning>): string | null {
  if (docsDir !== undefined) {
    let candidate = trimTrailingSlashes(docsDir)
    while (true) {
      const path = resolveWithin(repositoryDir, candidate || '.')
      if (hasDocusaurusConfig(path)) return path
      if (!candidate) break
      const parent = dirname(candidate)
      candidate = parent === '.' ? '' : parent
    }
  }

  const candidates: Array<string> = []
  const queue: Array<{ directory: string; depth: number }> = [{ directory: repositoryDir, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 500) {
    const current = queue.shift()!
    visited++
    if (hasDocusaurusConfig(current.directory)) candidates.push(current.directory)
    if (current.depth >= 4) continue
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || isIgnoredDirectory(entry.name)) continue
      queue.push({
        directory: resolveWithin(current.directory, entry.name),
        depth: current.depth + 1,
      })
    }
  }
  if (candidates.length === 0) return null
  return pickPreferredDocsRoot(candidates, repositoryDir, 'Docusaurus', warnings)
}

function readDocusaurusConfigSource(projectRoot: string): string {
  const path = DOCUSAURUS_CONFIG_FILENAMES
    .map((filename) => resolveWithin(projectRoot, filename))
    .find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile())
  if (!path || lstatSync(path).size > 1_000_000) return ''
  return readFileSync(path, 'utf8')
}

/**
 * Scans forward from a `{` for its matching `}`, skipping over string,
 * template, and comment contents so braces inside them don't throw off the
 * depth count. Returns -1 if the object is never closed.
 */
function matchingBraceIndex(source: string, openBraceIndex: number): number {
  let depth = 0
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i)
      i = newline === -1 ? source.length : newline
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Finds a `key: 'value'` or `key: "value"` pair at the top level of an object body (not nested inside a further `{`, `[`, or `(`). */
function topLevelStringProperty(objectBody: string, key: string): string | undefined {
  let depth = 0
  const keyPattern = new RegExp(`^${key}\\s*:\\s*(['"])`)
  for (let i = 0; i < objectBody.length; i++) {
    const ch = objectBody[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < objectBody.length && objectBody[i] !== quote) {
        if (objectBody[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '/' && objectBody[i + 1] === '/') {
      const newline = objectBody.indexOf('\n', i)
      i = newline === -1 ? objectBody.length : newline
      continue
    }
    if (ch === '/' && objectBody[i + 1] === '*') {
      const end = objectBody.indexOf('*/', i + 2)
      i = end === -1 ? objectBody.length : end + 1
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++
      continue
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      continue
    }
    if (depth === 0) {
      const match = keyPattern.exec(objectBody.slice(i))
      if (match) {
        const quote = match[1]
        const valueStart = i + match[0].length
        const valueEnd = objectBody.indexOf(quote, valueStart)
        if (valueEnd !== -1) return objectBody.slice(valueStart, valueEnd)
      }
    }
  }
  return undefined
}

function primaryDocusaurusDocsDirectory(projectRoot: string): string {
  const source = readDocusaurusConfigSource(projectRoot)
  // The classic preset's `docs: { ... }` object configures the primary docs
  // instance. Its `path` (when present) must come from directly inside that
  // object, not from a `path` belonging to a nested value (e.g. a versions
  // entry) or to an unrelated plugin's config further down the file — a
  // brace-blind regex can walk straight through the docs object's closing
  // brace into the next plugin's `path` (see the standalone content-docs
  // plugin case handled by `additionalDocusaurusPluginRoots`).
  const docsKeyMatch = source.match(/\bdocs\s*:\s*\{/)
  let configured: string | undefined
  if (docsKeyMatch?.index !== undefined) {
    const openBrace = docsKeyMatch.index + docsKeyMatch[0].length - 1
    const closeBrace = matchingBraceIndex(source, openBrace)
    if (closeBrace !== -1) {
      configured = topLevelStringProperty(source.slice(openBrace + 1, closeBrace), 'path')
    }
  }
  return trimTrailingSlashes(configured?.replace(/^\.\//, '') ?? '') || 'docs'
}

/** Discover archived docs and translations without evaluating project config. */
function docusaurusArchiveRoots(projectRoot: string, repositoryDir: string, warnings: Array<MigrationWarning>): Array<DocusaurusArchiveRoot> {
  const archives: Array<DocusaurusArchiveRoot> = []
  const relativeRoot = relative(repositoryDir, projectRoot).replace(/\\/g, '/')
  const directoryNames = (directory: string): Array<string> => {
    const path = resolveWithin(projectRoot, directory)
    if (!existsSync(path) || !lstatSync(path).isDirectory()) return []
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name).sort()
  }
  let versions = directoryNames('versioned_docs').filter((name) => /^version-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
  const versionsPath = resolveWithin(projectRoot, 'versions.json')
  if (existsSync(versionsPath) && lstatSync(versionsPath).isFile()) {
    try {
      if (lstatSync(versionsPath).size > 100_000) throw new Error('file exceeds the 100 KB limit')
      const declared: unknown = JSON.parse(readFileSync(versionsPath, 'utf8'))
      if (!Array.isArray(declared) || !declared.every((value) => typeof value === 'string')) throw new Error('expected an array of version names')
      const declaredOrder = declared.map((value) => `version-${value}`)
      versions = [...declaredOrder.filter((name) => versions.includes(name)), ...versions.filter((name) => !declaredOrder.includes(name))]
    } catch (error) {
      warnings.push({ code: 'unsupported-config', message: `Docusaurus versions.json could not be read safely: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  const sidebarPath = (version: string): string | undefined => {
    const candidates = ['json', 'js', 'cjs', 'mjs', 'ts'].map((extension) => `versioned_sidebars/${version}-sidebars.${extension}`)
    return candidates.find((candidate) => {
      const path = resolveWithin(projectRoot, candidate)
      return existsSync(path) && lstatSync(path).isFile()
    })
  }
  const add = (directory: string, routePrefix: string, label: string, sidebar?: string): void => {
    const docsDir = [relativeRoot, directory].filter(Boolean).join('/')
    archives.push({ docsDir, routePrefix, label, ...(sidebar ? { sidebarPath: sidebar } : {}) })
  }
  for (const version of versions) add(`versioned_docs/${version}`, version.slice('version-'.length), `Version ${version.slice('version-'.length)}`, sidebarPath(version))
  for (const locale of directoryNames('i18n').filter((name) => /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/.test(name))) {
    const localizedRoot = `i18n/${locale}/docusaurus-plugin-content-docs`
    const current = resolveWithin(projectRoot, `${localizedRoot}/current`)
    if (existsSync(current) && lstatSync(current).isDirectory()) add(`${localizedRoot}/current`, locale, `${locale} Documentation`)
    // A translation can exist for a version no longer present in the default
    // language's versioned_docs tree; discover its files independently.
    const localizedVersions = directoryNames(localizedRoot)
      .filter((name) => /^version-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    for (const version of localizedVersions) {
      const path = resolveWithin(projectRoot, `${localizedRoot}/${version}`)
      if (existsSync(path) && lstatSync(path).isDirectory()) add(`${localizedRoot}/${version}`, `${locale}/${version.slice('version-'.length)}`, `${locale} Version ${version.slice('version-'.length)}`)
    }
  }
  // Each recursive import has its own 5,000-file scan cap. Bound the number
  // of roots too, so a hostile checkout cannot multiply work indefinitely.
  if (archives.length > 48) warnings.push({ code: 'limit-reached', message: `Only the first 48 Docusaurus archived or localized docs roots were imported (${archives.length} found).` })
  return archives.slice(0, 48)
}

function additionalDocusaurusPluginRoots(
  repositoryDir: string,
  projectRoot: string,
  warnings: Array<MigrationWarning>,
): Array<DocusaurusPluginRoot> {
  const source = readDocusaurusConfigSource(projectRoot)
  const plugins: Array<DocusaurusPluginRoot> = []
  // Docusaurus resolves the bare shorthand ('content-docs') to the same
  // official plugin as the full package name, so both forms are matched.
  const matcher = /['"](?:@docusaurus\/plugin-)?content-docs['"][\s\S]{0,3000}?\bpath\s*:\s*(['"])([^'"]+)\1[\s\S]{0,1000}?\brouteBasePath\s*:\s*(['"])([^'"]+)\3/g
  for (const match of source.matchAll(matcher)) {
    const localPath = trimTrailingSlashes(match[2].replace(/^\.\//, ''))
    const routePrefix = trimEdgeSlashes(match[4])
    if (!localPath || !routePrefix) continue
    // Docusaurus resolves a content-docs instance's `path` relative to the
    // site directory (where `docusaurus.config` lives, `projectRoot` here).
    // Some monorepo sites build by copying that project root's contents up
    // into the repository root before running the generator (Playwright's
    // own `cp -r nodejs/* .` step is a real example — see the identical
    // fallback in components.ts's `resolveDependency`), so a `path` that
    // isn't found under `projectRoot` is retried directly under
    // `repositoryDir`, still confined to the repository.
    let docsDir: string | undefined
    for (const base of [projectRoot, repositoryDir]) {
      let absolute: string
      try {
        absolute = resolveWithin(base, localPath)
      } catch {
        continue
      }
      if (existsSync(absolute) && lstatSync(absolute).isDirectory()) {
        docsDir = relative(repositoryDir, absolute).replace(/\\/g, '/')
        break
      }
    }
    if (docsDir) {
      plugins.push({ docsDir, routePrefix })
    } else {
      warnings.push({
        code: 'unsupported-config',
        message: `The "${routePrefix}" docs plugin instance's path (${JSON.stringify(match[2])}) could not be found in the repository and was skipped.`,
      })
    }
  }
  return plugins
}

/** Parse and validate a public GitHub repository URL. */
export function parseGitHubRepositoryUrl(rawUrl: string): GitHubRepositorySource {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid GitHub URL: ${rawUrl}`)
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Repository migrations require an https://github.com URL.')
  }
  if (url.username || url.password || url.port) {
    throw new Error('GitHub repository URLs cannot include credentials or custom ports.')
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const [owner, rawRepo] = segments
  const repo = rawRepo?.replace(/\.git$/i, '')
  const safeName = /^[A-Za-z0-9_.-]+$/
  if (!owner || !repo || !safeName.test(owner) || !safeName.test(repo)) {
    throw new Error('GitHub URL must include a valid owner and repository name.')
  }
  let branch = 'HEAD'
  let docsDir = ''
  if (segments[2] === 'tree' && segments[3]) {
    branch = segments[3]
    docsDir = segments.slice(4).join('/')
  }
  return {
    owner,
    repo,
    branch,
    docsDir,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  }
}

const CLONE_RETRY_ATTEMPTS = 3
const CLONE_RETRY_DELAY_MS = 1_000
/** How long a git process may go without printing any progress before it is treated as stalled. */
const DEFAULT_CLONE_IDLE_TIMEOUT_MS = 2 * 60_000
/** Absolute ceiling for one git process, so a connection that trickles progress forever still ends. */
const MAX_GIT_PROCESS_MS = 60 * 60_000
const HARD_TIMEOUT_REASON = `still running after ${MAX_GIT_PROCESS_MS / 60_000} minutes`
/** After git exits, how long to wait for its stderr to close before settling anyway (a helper such as git-remote-https can hold the pipe open). */
const GIT_EXIT_DRAIN_MS = 2_000

/** Transient network-class git failures a retry can plausibly recover from. Also covers this module's own timeout error below. */
const RETRYABLE_CLONE_ERROR = /RPC failed|Recv failure|early EOF|curl \d+|Could not resolve host|Connection (?:reset|refused|timed out)|The remote end hung up|SSL[_ ]?(?:read|connect|write) error|timed out|network is unreachable/i

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * How long a git subprocess may stay silent (no progress output) before it's
 * killed and treated as a (retryable) stall. Configurable for an unusually
 * slow link. A slow but progressing clone is never killed by this — only a
 * stalled one.
 */
function gitIdleTimeoutMs(): number {
  const raw = process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLONE_IDLE_TIMEOUT_MS
}

/** The last few meaningful stderr lines, without git's `Receiving objects:  42%` progress noise. */
function gitErrorTail(stderr: string): string {
  return stderr.split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:remote: )?[A-Za-z][A-Za-z ]*:\s+\d+%/.test(line))
    .slice(-5)
    .join('\n')
}

/**
 * Run one git subprocess without a shell, with a stall timeout (a hung
 * clone/fetch otherwise waits forever — there is no `timeout` binary to rely
 * on; callers pass `--progress` so a healthy transfer keeps resetting it) and
 * per-process env overrides (never touching global git/npm config, per this
 * package's own rule).
 */
function runGit(args: Array<string>, options: { cwd?: string; env?: Record<string, string>; label: string }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env },
    })
    let stderr = ''
    let timeoutReason = ''
    let settled = false
    // `undefined` until git's own process exits; `close` can come much later,
    // or never, when a helper (git-remote-https) keeps the stderr pipe open.
    let exitCode: number | null | undefined
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const idleMs = gitIdleTimeoutMs()
    const idleMessage = `no progress for ${idleMs < 1000 ? `${idleMs}ms` : `${Math.round(idleMs / 1000)}s`}`
    const clearTimers = () => {
      clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      clearTimeout(drainTimer)
    }
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimers()
      child.stderr.destroy()
      if (code === 0) resolve()
      else if (timeoutReason) {
        const hint = timeoutReason === HARD_TIMEOUT_REASON ? '' : '; on a very slow link, raise THALLY_MIGRATE_CLONE_TIMEOUT_MS (milliseconds of allowed silence)'
        reject(new Error(`${options.label}: timed out (${timeoutReason}) and was killed. Check your network connection and try again${hint}.`))
      } else reject(new Error(`${options.label}: ${gitErrorTail(stderr) || `git exited ${code}`}`))
    }
    const kill = (reason: string) => {
      // Git already exited: there is nothing left to kill, so finish with its
      // own exit code rather than waiting on whatever holds the pipe.
      if (exitCode !== undefined) {
        finish(exitCode)
        return
      }
      timeoutReason = reason
      child.kill('SIGKILL')
    }
    let idleTimer = setTimeout(() => { kill(idleMessage) }, idleMs)
    const hardTimer = setTimeout(() => { kill(HARD_TIMEOUT_REASON) }, MAX_GIT_PROCESS_MS)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000)
      if (exitCode !== undefined || settled) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { kill(idleMessage) }, idleMs)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    })
    child.on('close', finish)
    // Don't depend on the order of `exit`, `close` and the timers. Once git
    // has exited, stop the stall timers (a helper's output is not git
    // progress), give stderr a short drain for the last error lines, then
    // settle even if the pipe never closes. A process we killed settles now.
    child.on('exit', (code) => {
      exitCode = code
      clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      if (timeoutReason) finish(code)
      else drainTimer = setTimeout(() => { finish(code) }, GIT_EXIT_DRAIN_MS)
    })
  })
}

/**
 * Neutralize the `filter.lfs.*` smudge/clean/process filter driver for one
 * git process only — never the user's global git config — so a repository
 * tracked with Git LFS still clones when the host has no `git-lfs` binary.
 * `GIT_LFS_SKIP_SMUDGE=1` alone isn't enough: if this host ever had
 * `git lfs install` run and then had the `git-lfs` binary removed (as here),
 * `filter.lfs.smudge`/`.process` are still registered in the *global* git
 * config pointing at a command that no longer exists, and
 * `GIT_LFS_SKIP_SMUDGE` is only ever read by that (missing) binary — git
 * itself still fails outright trying to invoke it. `GIT_CONFIG_COUNT`/
 * `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env pairs are the one config
 * source with higher precedence than the user's global config, so they can
 * override it per-process: `smudge`/`clean` become `cat` (pass the LFS
 * pointer text straight through — real content was never fetched anyway)
 * and `process` is cleared so git falls back to them; `filter.lfs.required
 * = false` keeps a filter hiccup on one path (an oversized fixture, say)
 * from failing the whole checkout. The result is the repository's own
 * files, with an LFS-tracked asset left as its pointer text — the
 * asset-copying step below warns when a copied file turns out to be one.
 */
const LFS_FILTER_OVERRIDE_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'filter.lfs.smudge',
  GIT_CONFIG_VALUE_0: 'cat',
  GIT_CONFIG_KEY_1: 'filter.lfs.clean',
  GIT_CONFIG_VALUE_1: 'cat',
  GIT_CONFIG_KEY_2: 'filter.lfs.process',
  GIT_CONFIG_VALUE_2: '',
  GIT_CONFIG_KEY_3: 'filter.lfs.required',
  GIT_CONFIG_VALUE_3: 'false',
}

function cloneOnce(source: GitHubRepositorySource, targetDir: string): Promise<void> {
  // Submodules are deliberately not recursed here: `--recurse-submodules`
  // fails the *entire* clone if any one submodule can't be fetched (a
  // private or since-deleted submodule shouldn't take the whole migration
  // down). `initSubmodules`, run after a successful plain clone, is the
  // equivalent of `--recurse-submodules --shallow-submodules` (`--depth 1`
  // per submodule) but fault-tolerant per submodule.
  const args = ['clone', '--progress', '--depth', '1', '--single-branch']
  if (source.branch !== 'HEAD') args.push('--branch', source.branch)
  args.push('--', source.cloneUrl, targetDir)
  return runGit(args, {
    label: `Failed to clone ${source.owner}/${source.repo}`,
    env: LFS_FILTER_OVERRIDE_ENV,
  })
}

/** Every submodule path declared in a cloned repository's `.gitmodules`, in file order. */
export function gitmodulePaths(targetDir: string): Array<string> {
  const gitmodulesPath = resolvePath(targetDir, '.gitmodules')
  if (!existsSync(gitmodulesPath) || !lstatSync(gitmodulesPath).isFile()) return []
  let content: string
  try {
    content = readFileSync(gitmodulesPath, 'utf8')
  } catch {
    return []
  }
  return [...content.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((match) => match[1]).filter(Boolean)
}

/**
 * Every submodule `url` in a cloned repository's `.gitmodules`, in the same
 * file order as `gitmodulePaths` (each `[submodule "..."]` block declares
 * `path` and `url` once, so index `i` here corresponds to index `i` there).
 */
function gitmoduleUrls(targetDir: string): Array<string> {
  const gitmodulesPath = resolvePath(targetDir, '.gitmodules')
  if (!existsSync(gitmodulesPath) || !lstatSync(gitmodulesPath).isFile()) return []
  let content: string
  try {
    content = readFileSync(gitmodulesPath, 'utf8')
  } catch {
    return []
  }
  return [...content.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].map((match) => match[1]).filter(Boolean)
}

/**
 * `--recurse-submodules` on the main clone (above) fails the *entire* clone
 * if any one submodule can't be fetched, which is worse than not having
 * that submodule's content at all. So the main clone omits it and this
 * best-effort pass follows, per submodule path, so one broken/private
 * submodule doesn't take down the whole migration — it's just missing,
 * and named in a warning instead of silently absent.
 */
async function initSubmodules(targetDir: string, warnings: Array<MigrationWarning>): Promise<void> {
  const paths = gitmodulePaths(targetDir)
  if (paths.length === 0) return
  const urls = gitmoduleUrls(targetDir)
  const failed: Array<string> = []
  for (const [index, path] of paths.entries()) {
    // A path or url beginning with `-` would be read as a git option
    // rather than a pathspec/URL once it reaches argv (even after `--`,
    // git's own pathspec parser treats a leading `-` as a flag), and
    // `.gitmodules` is attacker-controlled content from the cloned repo.
    if (path.startsWith('-') || (urls[index]?.startsWith('-') ?? false)) {
      failed.push(path)
      continue
    }
    try {
      await runGit([
        '-c', 'protocol.file.allow=never',
        '-c', 'protocol.ext.allow=never',
        'submodule', 'update', '--init', '--progress', '--depth', '1', '--', path,
      ], {
        cwd: targetDir,
        env: LFS_FILTER_OVERRIDE_ENV,
        label: `Failed to initialize submodule ${path}`,
      })
    } catch {
      failed.push(path)
    }
  }
  if (failed.length > 0) {
    warnings.push({
      code: 'fetch-failed',
      message: `${failed.length} git submodule${failed.length === 1 ? '' : 's'} could not be fetched and ${failed.length === 1 ? 'is' : 'are'} missing from the migrated content: ${failed.join(', ')}.`,
    })
  }
}

/**
 * Clone a repository without a shell; callers own and remove `targetDir`. A
 * large repository on a flaky connection can drop mid-clone (`RPC failed`,
 * `Recv failure`, a `curl 56`, …) — retry a network-class failure a couple
 * of times with backoff instead of surfacing a hard failure on the first
 * blip. A partial checkout from the failed attempt is removed first, or
 * `git clone` refuses to reuse the (now non-empty) target directory. A
 * stalled clone/submodule-init is killed by `runGit`'s own timeout, which
 * surfaces as a retryable error. `warnings`, if given, collects a
 * submodule-fetch-failure warning (this function otherwise returns exactly
 * as before, so existing callers are unaffected).
 */
export async function cloneGitHubRepository(
  source: GitHubRepositorySource,
  targetDir: string,
  warnings?: Array<MigrationWarning>,
  /** Untrusted referenced repositories: never follow their `.gitmodules` to further remotes. */
  options: { skipSubmodules?: boolean } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= CLONE_RETRY_ATTEMPTS; attempt++) {
    try {
      await cloneOnce(source, targetDir)
      if (!options.skipSubmodules) await initSubmodules(targetDir, warnings ?? [])
      return
    } catch (error) {
      const retryable = error instanceof Error && RETRYABLE_CLONE_ERROR.test(error.message)
      if (!retryable || attempt === CLONE_RETRY_ATTEMPTS) throw error
      rmSync(targetDir, { recursive: true, force: true })
      await delay(CLONE_RETRY_DELAY_MS * attempt)
    }
  }
}

/** Detect a supported repository docs platform from unambiguous config files. */
export function detectRepositoryPlatform(repositoryDir: string, docsDir?: string): MigrationPlatform {
  if (findMintlifyProjectRoot(repositoryDir, docsDir)) return 'mintlify'
  if (findFernProjectRoot(repositoryDir, docsDir)) return 'fern'
  const selectedRoot = docsDir === undefined ? repositoryDir : resolveWithin(repositoryDir, docsDir || '.')
  const docsJson = resolveWithin(selectedRoot, 'docs.json')
  if (existsSync(docsJson)) {
    try {
      const config = JSON.parse(readFileSync(docsJson, 'utf8')) as Record<string, unknown>
      if (Array.isArray(config.tabs)) return 'thally'
    } catch {
      // A malformed source config is reported later; platform detection falls through.
    }
  }
  if (['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs']
    .some((name) => existsSync(resolveWithin(repositoryDir, name)))) return 'docusaurus'
  if (findDocusaurusProjectRoot(repositoryDir)) return 'docusaurus'
  if (existsSync(resolveWithin(repositoryDir, 'SUMMARY.md'))) return 'gitbook'
  if (existsSync(resolveWithin(repositoryDir, '.vitepress'))) return 'vitepress'
  if (['astro.config.mjs', 'astro.config.ts']
    .some((name) => existsSync(resolveWithin(repositoryDir, name)))) return 'starlight'
  if (['pages/_meta.json', '_meta.json']
    .some((name) => existsSync(resolveWithin(repositoryDir, name)))) return 'nextra'
  return 'unknown'
}

function containsMarkdown(directory: string, depth = 0): boolean {
  if (depth > 4) return false
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (isIgnoredDirectory(entry.name) || entry.isSymbolicLink()) continue
    const path = resolveWithin(directory, entry.name)
    if (entry.isFile() && ['.md', '.mdx'].includes(extname(entry.name).toLowerCase())) return true
    if (entry.isDirectory() && containsMarkdown(path, depth + 1)) return true
  }
  return false
}

/** Pick the first conventional content root containing Markdown. */
export function detectRepositoryDocsDir(repositoryDir: string): string {
  for (const candidate of ['docs', 'documentation', 'content', 'pages', 'src/content', 'src/pages', 'guide', 'guides', '']) {
    const path = resolveWithin(repositoryDir, candidate)
    if (existsSync(path) && lstatSync(path).isDirectory() && containsMarkdown(path)) return candidate
  }
  return ''
}

interface ScannedFile {
  absolutePath: string
  relativePath: string
}

/**
 * Scan `root` for its files, following a symbolic link only when its
 * resolved real path stays inside `confinementRoot` (default `root`) — this
 * is how a submodule mounted as a symlink (Oasis's `docs/core ->
 * ../external/oasis-core/docs`, `docs/adrs -> ../external/adrs`) actually
 * gets its content walked, since a plain `git clone` (even with submodules
 * initialized) leaves those as real symlinks on disk that a naive walk
 * would otherwise always skip. `confinementRoot` is normally the whole
 * repository checkout, not just the docs root, because a submodule commonly
 * links out to a sibling directory outside it. `visitedRealPaths` guards
 * against a cycle (a symlink pointing at an ancestor, or two symlinks
 * pointing at each other).
 */
/** A ranked walk is bounded at this many times the file budget: far above it so a ~28k-file repository is walked in full, yet a pathologically huge tree cannot make discovery slow. */
const RANKED_WALK_FACTOR = 20

/**
 * Scan `root` for its files. When `rank` is given, the walk isn't cut off at
 * `MAX_SOURCE_FILES` — it continues (bounded by 20x the budget) so
 * every file's priority can be considered before any are dropped; the
 * caller is responsible for sorting by `rank` and trimming to
 * `MAX_SOURCE_FILES` afterward (see `selectFilesWithinBudget`). Without
 * `rank`, the walk stops as soon as `MAX_SOURCE_FILES` files are found, same
 * as before.
 */
function scanFiles(root: string, confinementRoot: string = root, warnings?: Array<MigrationWarning>, rank?: (relativePath: string) => number, budget: number = MAX_SOURCE_FILES): Array<ScannedFile> {
  const files: Array<ScannedFile> = []
  const walkCap = rank ? budget * RANKED_WALK_FACTOR : budget
  let confinementReal: string
  try {
    confinementReal = realpathSync(confinementRoot)
  } catch {
    confinementReal = confinementRoot
  }
  // Tracks every directory's real path, symlinked or not: a symlink into an
  // ancestor (or two symlinks pointing at each other) must not recurse
  // forever, and this also cheaply dedupes reaching the same real directory
  // through two different symlinks.
  const visitedRealPaths = new Set<string>()
  // `directory` is the real, physical path a symlink was already resolved
  // to (used for readdirSync/realpathSync); `logicalDirectory` is the path
  // as seen through the symlink from `root` (used only for `relativePath`,
  // so a page inside a symlinked submodule gets a sensible id like
  // `core/overview` instead of a `../../..`-laden physical path).
  function visit(directory: string, logicalDirectory: string = directory): void {
    if (files.length >= walkCap) return
    let directoryReal: string
    try {
      directoryReal = realpathSync(directory)
    } catch {
      return
    }
    if (visitedRealPaths.has(directoryReal)) return
    visitedRealPaths.add(directoryReal)
    let entries: Array<Dirent>
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= walkCap) return
      if (isIgnoredContentDirectory(entry.name)) {
        // Still skipped (`.git`, `node_modules`, ...) — but never silently:
        // warn if it turns out to hold real pages, since that's exactly the
        // shape of bug this content root is supposed to be free of.
        if (warnings && entry.isDirectory() && !entry.isSymbolicLink()
          && containsMarkdown(resolveWithin(directory, entry.name))) {
          warnings.push({
            code: 'unsupported-config',
            message: `The "${entry.name}" directory was skipped during migration but contains Markdown/MDX files; if any are real pages, move them out or pass --docs-dir to include them.`,
            source: relative(root, resolveWithin(directory, entry.name)).replace(/\\/g, '/'),
          })
        }
        continue
      }
      const path = resolveWithin(directory, entry.name)
      const logicalPath = resolveWithin(logicalDirectory, entry.name)
      if (entry.isSymbolicLink()) {
        let real: string
        try {
          real = realpathSync(path)
        } catch {
          continue // A broken symlink (e.g. an uninitialized submodule) has nothing to walk.
        }
        const withinConfinement = real === confinementReal || real.startsWith(`${confinementReal}${sep}`)
        if (!withinConfinement) continue
        let target: ReturnType<typeof statSync>
        try {
          target = statSync(real)
        } catch {
          continue
        }
        if (target.isDirectory()) visit(real, logicalPath)
        else if (target.isFile()) files.push({ absolutePath: real, relativePath: relative(root, logicalPath).replace(/\\/g, '/') })
        continue
      }
      if (entry.isDirectory()) visit(path, logicalPath)
      else if (entry.isFile()) files.push({ absolutePath: path, relativePath: relative(root, logicalPath).replace(/\\/g, '/') })
    }
  }
  visit(root)
  if (rank && files.length >= walkCap) {
    warnings?.push({
      code: 'limit-reached',
      message: `Stopped scanning after ${walkCap} files, so the rest of the repository was not looked at. Run the migration on a smaller part of the repository with --docs-dir.`,
    })
  }
  return files
}

/**
 * Applies the `MAX_SOURCE_FILES` budget to one homogeneous group (either
 * documentation pages or assets — see `selectFilesWithinBudget`), keeping
 * the highest-priority files and emitting one warning naming how many were
 * dropped and — for Mintlify — which versions they belonged to.
 */
function selectGroupWithinBudget(
  scanned: Array<ScannedFile>,
  rank: (relativePath: string) => number,
  warnings: Array<MigrationWarning> | undefined,
  allVersionPrefixes: ReadonlySet<string>,
  label: 'file' | 'asset' | 'snippet',
  budget: number = MAX_SOURCE_FILES,
): Array<ScannedFile> {
  if (scanned.length <= budget) return scanned
  // Ties (unreferenced files sharing a ceiling) break by path, not by
  // directory-listing order, so the same repository always keeps the same files.
  const ranked = scanned
    .map((file) => ({ file, priority: rank(file.relativePath) }))
    .sort((left, right) => left.priority - right.priority
      || (left.file.relativePath < right.file.relativePath ? -1 : left.file.relativePath > right.file.relativePath ? 1 : 0))
  const dropped = ranked.slice(budget).map(({ file }) => file)
  if (warnings) {
    const droppedPages = label === 'file' ? dropped.filter((file) => isDocumentationExtension(file.relativePath)) : dropped
    const noun = label === 'file' ? 'page' : label === 'snippet' ? 'snippet file' : 'image or media file'
    const droppedVersions = new Set<string>()
    for (const file of dropped) {
      const firstSegment = file.relativePath.split('/', 1)[0]
      if (allVersionPrefixes.has(firstSegment)) droppedVersions.add(firstSegment)
    }
    const examples = droppedPages.slice(0, 3).map((file) => file.relativePath)
    const rest = droppedPages.length - examples.length
    warnings.push({
      code: 'limit-reached',
      message: `This repository has more than ${budget} ${label === 'file' ? 'files' : label === 'snippet' ? 'snippets' : 'assets'}, so only the first ${budget} (in navigation order, default version first) were migrated. `
        + `${droppedPages.length} ${noun}(s) were left out`
        + (examples.length > 0 ? `: ${examples.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}` : '')
        + (droppedVersions.size > 0 ? ` (versions: ${[...droppedVersions].slice(0, 5).join(', ')}${droppedVersions.size > 5 ? `, and ${droppedVersions.size - 5} more` : ''})` : '')
        + (label === 'asset'
          ? '. Copy them into public/ manually if your pages use them.'
          : '. To include them, run the migration on a smaller part of the repository with --docs-dir.'),
    })
  }
  return ranked.slice(0, budget).map(({ file }) => file)
}

/**
 * When a `scanFiles` walk (run with a `rank` function) found more than
 * `MAX_SOURCE_FILES` files, keep the highest-priority files and drop the
 * rest. `rank` comes from `referenceOrder` (navigation traversal order:
 * default version before non-default, newest non-default before older, per
 * `projectMintlifyNavigation`'s version sort), so referenced pages always
 * win over unreferenced ones, and within referenced pages the default
 * version's own pages always win over other versions'.
 *
 * Assets get their own `MAX_SOURCE_FILES` budget, separate from pages: a
 * repository with more than `MAX_SOURCE_FILES` navigation-referenced pages
 * (e.g. crewAI's ~40 Mintlify versions) would otherwise fill the entire
 * shared budget with pages before a single image is ever considered,
 * since `rank` only orders *pages* (assets always sort last, at
 * `Number.MAX_SAFE_INTEGER` — see `discoveryRank` in `migrateRepository`)
 * — starving every asset even though the asset budget
 * (`MAX_ASSET_BYTES`/`MAX_TOTAL_ASSET_BYTES`) was never reached.
 */
function selectFilesWithinBudget(
  scanned: Array<ScannedFile>,
  rank: (relativePath: string) => number,
  warnings: Array<MigrationWarning> | undefined,
  allVersionPrefixes: ReadonlySet<string>,
  budget: number = MAX_SOURCE_FILES,
): Array<ScannedFile> {
  const isAsset = (file: ScannedFile): boolean => ASSET_EXTENSIONS.has(extname(file.relativePath).toLowerCase())
  // Snippet files are only ever inlined into pages (read from disk), never
  // imported as pages, so they get their own budget instead of taking pages'.
  const isSnippet = (file: ScannedFile): boolean => file.relativePath.split('/').some((segment) => SNIPPET_DIRECTORIES.has(segment.toLowerCase()))
  const snippetFiles = scanned.filter((file) => !isAsset(file) && isSnippet(file))
  const assetFiles = scanned.filter(isAsset)
  const otherFiles = scanned.filter((file) => !isAsset(file) && !isSnippet(file))
  return [
    ...selectGroupWithinBudget(snippetFiles, rank, warnings, allVersionPrefixes, 'snippet', budget),
    ...selectGroupWithinBudget(otherFiles, rank, warnings, allVersionPrefixes, 'file', budget),
    ...selectGroupWithinBudget(assetFiles, rank, warnings, allVersionPrefixes, 'asset', budget),
  ]
}

/**
 * Mintlify excludes paths from the docs site with a gitignore-style
 * `.mintignore` at the project root (see Mintlify's docs). Honoring it keeps
 * internal tooling directories like `agent-context/` out of the migration
 * even though they aren't dotfile directories.
 */
function readMintignoreMatcher(mintlifyRoot: string): IgnoreMatcher | null {
  const path = resolveWithin(mintlifyRoot, MINTIGNORE_FILENAME)
  if (!existsSync(path) || !lstatSync(path).isFile()) return null
  return createIgnoreMatcher().add(readFileSync(path, 'utf8'))
}

/**
 * Compile-check a page body with the same MDX compiler the scaffold's
 * runtime build uses (`@mdx-js/mdx`). A single malformed page must never
 * abort `scripts/build-runtime-sources.mts` for the whole project, so
 * migration excludes it up front instead and reports why.
 */
function invalidMdxReason(body: string): string | null {
  try {
    compileSync(body, { outputFormat: 'program' })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** Extract Mintlify's `colors.{primary,light,dark}` theme hexes, if valid. */
function mintlifyThemeColors(value: unknown): { primary?: string; light?: string; dark?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const colors: { primary?: string; light?: string; dark?: string } = {}
  for (const key of ['primary', 'light', 'dark'] as const) {
    if (typeof source[key] === 'string' && HEX_COLOR.test(source[key])) colors[key] = source[key]
  }
  return Object.keys(colors).length > 0 ? colors : undefined
}

/**
 * Extract Fern's `colors.accent-primary` (a hex string, or `{light, dark}`),
 * if valid. Fern's `light`/`dark` are normal (each names the mode it
 * paints), unlike Mintlify's inverted schema that `site.colors` otherwise
 * follows, so they're swapped onto Mintlify's `{light, dark}` keys here to
 * give downstream consumers (`updateSiteConfig`) one consistent contract.
 */
function fernThemeColors(value: unknown): { primary?: string; light?: string; dark?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const accent = (value as Record<string, unknown>)['accent-primary']
  if (typeof accent === 'string') return HEX_COLOR.test(accent) ? { primary: accent } : undefined
  if (!accent || typeof accent !== 'object') return undefined
  const source = accent as Record<string, unknown>
  const lightMode = typeof source.light === 'string' && HEX_COLOR.test(source.light) ? source.light : undefined
  const darkMode = typeof source.dark === 'string' && HEX_COLOR.test(source.dark) ? source.dark : undefined
  const colors: { light?: string; dark?: string } = {}
  if (darkMode) colors.light = darkMode
  if (lightMode) colors.dark = lightMode
  return Object.keys(colors).length > 0 ? colors : undefined
}

function normalizedReferenceKey(value: string): string {
  return value.split(/[?#]/, 1)[0]
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
    .replace(/\.(?:mdx?|rst|txt)$/i, '')
    .replace(/\/(?:index|readme)$/i, '')
    .replace(/^(?:index|readme)$/i, '') || 'introduction'
}

function exactReferenceKey(value: string): string {
  return value.split(/[?#]/, 1)[0]
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
    .replace(/\.(?:mdx?|rst|txt)$/i, '')
}

/**
 * What visible navigation says about OpenAPI specs. An `openapi` on a container
 * is the spec every operation and page under it belongs to (the nearest one
 * wins); `undefined` means no container names one, `null` that one does but not
 * as a single source.
 */
interface NavigationSpecContext {
  operations: Array<{ ref: string; owner: string | null | undefined }>
  /** The owner of each place a page is listed, by the page id it publishes as (`pageIdentity`). */
  pageOwners: Map<string, Set<string | null | undefined>>
  /** Which page a source path or a navigation entry means: the rule the page loop publishes by, for entries and files alike. */
  pageIdentity: (path: string) => string | null
}

function containerSpec(node: Record<string, unknown>): string | null | undefined {
  const value = node.openapi
  if (value === undefined) return undefined
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).source : value
  return typeof source === 'string' && source.trim() && !splitOpenApiRef(source) ? source.trim() : null
}

/** Operation and page references in navigation that is visible without source-side access, each with the spec it sits under. */
function navigationSpecContext(config: Record<string, unknown> | null, pageIdentity: NavigationSpecContext['pageIdentity']): NavigationSpecContext {
  const context: NavigationSpecContext = { operations: [], pageOwners: new Map(), pageIdentity }
  const visit = (node: unknown, owner: string | null | undefined, listed: boolean): void => {
    if (typeof node === 'string') {
      if (splitOpenApiRef(node)) context.operations.push({ ref: node, owner })
      else if (listed) {
        const page = pageIdentity(node)
        if (page !== null) context.pageOwners.set(page, (context.pageOwners.get(page) ?? new Set()).add(owner))
      }
    }
    else if (Array.isArray(node)) node.forEach((child) => visit(child, owner, true))
    else if (node && typeof node === 'object') {
      // A restricted container does not make any descendant operation public.
      if (navigationGateReason(node as Record<string, unknown>)) return
      const own = containerSpec(node as Record<string, unknown>)
      Object.values(node).forEach((child) => visit(child, own === undefined ? owner : own, false))
    }
  }
  visit(config?.navigation, undefined, false)
  return context
}

/**
 * The references that keep an operation public, each naming the spec it is read
 * in: a bare operation belongs to the spec of the navigation container it is
 * listed under (for a page, the container that lists the page) or else to the
 * site's default spec. A bare one whose spec cannot be told keeps nothing public
 * (fail closed) and is returned in `unowned` so the loss can be reported.
 * `specs` are the specs a spec reference can name: owners are compared by the
 * source they resolve to, so `b.json` and `/b.json` are one owner.
 */
function keptOperationRefs(
  published: ReadonlyArray<{ ref: string; file: string }>,
  navigation: NavigationSpecContext,
  defaultSpec: string | undefined,
  specs: ReadonlyArray<SpecCandidate>,
): { kept: Array<string>; unowned: Array<string> } {
  const kept: Array<string> = []
  const unowned: Array<string> = []
  // An owner that resolves to one local spec is known by that spec's source; any other stays as authored (never merged).
  const source = (owner: string | null | undefined): string | null | undefined => {
    if (!owner || isRemoteSpecRef(owner)) return owner
    const resolved = resolveSpecRef(owner, specs)
    return resolved.kind === 'match' ? resolved.spec.sourcePath ?? resolved.spec.filename : owner
  }
  const add = (raw: string, owner: string | null | undefined): void => {
    const ref = splitOpenApiRef(raw)
    if (!ref) return
    if (ref.specRef) kept.push(raw)
    else if (owner) kept.push(withSpecRef(ref, owner))
    else unowned.push(ref.operation)
  }
  for (const { ref, file } of published) {
    // A page listed under several containers belongs to none of them alone.
    const page = navigation.pageIdentity(file)
    const owners = new Set([...(page === null ? undefined : navigation.pageOwners.get(page)) ?? [undefined]].map((owner) => source(owner === undefined ? defaultSpec : owner)))
    add(ref, owners.size === 1 ? [...owners][0] : null)
  }
  for (const { ref, owner } of navigation.operations) add(ref, source(owner === undefined ? defaultSpec : owner))
  return { kept, unowned }
}

/**
 * Fail closed: an operation named only by access-restricted pages must not be
 * published with a spec that published pages or docs.json also use. Marks such
 * operations `x-excluded` (the renderer's sanitizer then drops them from every
 * published surface) and returns the new bytes and the operations withheld.
 * `keptRefs` are the references that keep an operation public.
 */
function excludeWithheldOperations(
  spec: { sourcePath: string; filename: string; content: Buffer },
  withheldRefs: ReadonlyArray<string>,
  keptRefs: ReadonlyArray<string>,
  /** Every spec a page's prefix can name, so a ref is resolved among them as the page's own is. */
  specs?: ReadonlyArray<{ sourcePath: string; filename: string }>,
): { content: Buffer; excluded: Array<string> } {
  const { withheld, kept } = withheldOperationKeys(spec, withheldRefs, keptRefs, specs)
  return markExcluded(spec.content, withheld, kept)
}

const TOKEN_SEPARATORS = /[\s"'()<>[\]{}=,;:|\\/`*!?#&]+/
/** Like TOKEN_SEPARATORS but keeps `/`, so a word is a whole path. */
const PATH_SEPARATORS = /[\s"'()<>[\]{}=,;:|\\`*!?#&]+/

/** The public/ destination key of a repo-relative file: Thally serves `public/x` at `/x`, exactly as the asset copy pass keys it. */
function publicAssetKey(repoRelative: string): string {
  return repoRelative.split('/', 1)[0].toLowerCase() === 'public' ? repoRelative.slice('public/'.length) : repoRelative
}

/**
 * Collects what a published text (page source with frontmatter, copied CSS/JS,
 * docs.json, migrated components) points at.
 * `exact` gets the destination key of every path it spells in full: absolute
 * from the site root (`/img/a.png`, `/public/a.png`) or relative with a folder
 * (`./img/a.png`, `../a.png`) resolved against `baseDir`, the referring file's
 * folder relative to the site root (undefined: relative forms cannot be
 * resolved and are ignored). A bare file name (`a.png`) names no folder, so it
 * cannot be resolved to one file: it goes to `loose` (lowercased, as does the
 * lowercased key of every exact one, for a letter-case mismatch) and never
 * makes anything public. Linear, no backtracking.
 */
/** Docusaurus: where a page's links resolve against the site root (`siteBase`) and where the docs folder sits in it. */
interface DocusaurusPathContext { siteBase: string; docsPrefix: string }

function addPathReferences(text: string, baseDir: string | undefined, exact: Set<string>, loose: Set<string>, docusaurus?: DocusaurusPathContext): void {
  for (const word of text.split(PATH_SEPARATORS)) {
    let token = word.replace(/\.+$/, '')
    if (!/\.[a-z0-9]{2,5}$/i.test(token) || token.startsWith('//')) continue
    if (token.includes('%')) {
      try { token = decodeURIComponent(token) } catch { /* keep the raw token */ }
    }
    if (!token.includes('/')) {
      loose.add(token.toLowerCase())
      continue
    }
    if (docusaurus && !token.startsWith('/')) {
      // `@site/...` and `../../static/...` name files from the site root, not the docs folder.
      const fromSite = normalizeAssetPath(posix.normalize(token.startsWith('@site/') ? token.slice('@site/'.length) : posix.join(docusaurus.siteBase, token)))
      const docsFolder = docusaurus.docsPrefix ? `${docusaurus.docsPrefix}/` : ''
      const siteKey = fromSite?.startsWith('static/') ? fromSite.slice('static/'.length)
        : fromSite && docsFolder && fromSite.startsWith(docsFolder) ? fromSite.slice(docsFolder.length) : undefined
      if (siteKey) {
        exact.add(siteKey)
        loose.add(siteKey.toLowerCase())
      }
      if (token.startsWith('@site/')) continue
    }
    if (!token.startsWith('/') && baseDir === undefined) continue
    const resolved = normalizeAssetPath(posix.normalize(token.startsWith('/') ? token.slice(1) : posix.join(baseDir ?? '', token)))
    if (!resolved) continue
    // Docusaurus serves `static/x` at `/x`, as `public/` is elsewhere.
    const key = docusaurus && resolved.startsWith('static/') ? resolved.slice('static/'.length) : publicAssetKey(resolved)
    exact.add(key)
    loose.add(key.toLowerCase())
  }
}

/** Inspect public Fern config strings without recursively expanding YAML aliases or skipped navigation. */
function addFernConfigPathReferences(config: Record<string, unknown>, exact: Set<string>, loose: Set<string>): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: config, depth: 0 }]
  const seen = new Set<object>()
  let visits = 0
  while (pending.length > 0 && visits < 5_000) {
    const { value, depth } = pending.pop()!
    visits++
    if (typeof value === 'string') {
      addPathReferences(value, '', exact, loose)
    } else if (value && typeof value === 'object' && !seen.has(value) && depth < 64) {
      seen.add(value)
      if (!Array.isArray(value) && fernViewersReason(value as Record<string, unknown>)) continue
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 })
    }
  }
}

/** Whether a bare file name (or the last word of a name with spaces) or a letter-case variant of this destination was spelled by published text. */
function looselyNamed(assetPath: string, loose: ReadonlySet<string>): boolean {
  const lower = assetPath.toLowerCase()
  const name = lower.split('/').pop() ?? lower
  return loose.has(lower) || loose.has(name) || loose.has(name.split(TOKEN_SEPARATORS).filter(Boolean).pop() ?? name)
}

function findOpenApi(files: Array<ScannedFile>): ScannedFile | null {
  return files.find((file) => OPENAPI_FILENAMES.has(basename(file.relativePath).toLowerCase())
    && classifyApiSpec(file.absolutePath) === 'openapi') ?? null
}

/** A familiar filename is insufficient: Fern repositories also keep AsyncAPI there. */
function classifyApiSpec(path: string): 'openapi' | 'asyncapi' | 'unknown' {
  const buffer = Buffer.alloc(64_000)
  let bytesRead = 0
  try {
    const descriptor = openSync(path, 'r')
    try {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return 'unknown'
  }
  const text = buffer.toString('utf8', 0, bytesRead)
  const topLevel = text.match(/^(?:openapi|swagger|asyncapi)\s*:/m)?.[0]
    ?? text.match(/^\s*\{\s*"(?:openapi|swagger|asyncapi)"\s*:/m)?.[0]
  if (!topLevel) return 'unknown'
  return /asyncapi/i.test(topLevel) ? 'asyncapi' : 'openapi'
}

/**
 * Migrated specs live outside `public/`: anything under `public/` is served
 * verbatim by the host, which would publish `x-excluded` internal operations.
 * The renderer loads a relative `api.source` from the project root instead.
 */
const SPEC_DIRECTORY = 'openapi'

/** Real OpenAPI documents exceed the 2 MB page limit, so specs get their own, larger cap. */
const MAX_SPEC_BYTES = 50_000_000

/** Reads an OpenAPI spec for every platform; one over the cap is skipped with a warning. */
function readSpecFile(absolutePath: string, relativePath: string, warnings: Array<MigrationWarning>): Buffer | undefined {
  if (lstatSync(absolutePath).size > MAX_SPEC_BYTES) {
    warnings.push({
      code: 'skipped-file',
      message: `The OpenAPI spec "${relativePath}" is larger than ${MAX_SPEC_BYTES / 1_000_000} MB and was not migrated; split it or reduce its size.`,
      source: relativePath,
    })
    return undefined
  }
  // Saved without a byte order mark, which the renderer's JSON reader rejects.
  return withoutByteOrderMark(readFileSync(absolutePath))
}

function specAssetPath(filename: string): string {
  return `${SPEC_DIRECTORY}/${filename}`
}

function specAsset(filename: string, content: Uint8Array): MigrationAsset {
  return { path: specAssetPath(filename), content, projectRelative: true }
}

/**
 * The one allocator of the file names migrated specs are written under, shared
 * by everything that binds a spec: a tab, a hidden page-only tab and the spec the
 * repository scan finds when docs.json names none. A source is named once, the
 * first to ask keeps its file name, and a different source that wants a taken
 * name is renamed from its path; the same file bound twice stays one asset. Its
 * asset, its tab binding and every page reference to it read that name, so no
 * two sources share an asset and no page is pointed at another source's bytes.
 * Names are compared without letter case: the assets are written to disks that
 * fold it.
 */
function createSpecAssetNamer(): (spec: { sourcePath: string; filename: string; tabLabel?: string }) => string {
  const nameBySource = new Map<string, string>()
  const sourceByName = new Map<string, string>()
  return ({ sourcePath, filename, tabLabel }) => {
    let name = nameBySource.get(sourcePath)
    if (name === undefined) {
      name = filename
      if (sourceByName.has(name.toLowerCase())) {
        name = sourcePath.replace(/\//g, '-')
        while (sourceByName.has(name.toLowerCase())) name = `${(tabLabel ?? 'default').replace(/\W+/g, '-')}-${name}`
      }
      nameBySource.set(sourcePath, name)
      sourceByName.set(name.toLowerCase(), sourcePath)
    }
    return name
  }
}

/** An OpenAPI/AsyncAPI spec resolved and ready to copy into `public/`, optionally bound to one tab. */
interface ResolvedApiSpec {
  filename: string
  content: Buffer
  tabLabel?: string
  /** `tabLabel` is a per-menu-item sibling tab; place it after this tab. */
  parentTab?: string
  icon?: string
  hidden?: boolean
  /** Named only by published pages' `openapi:` frontmatter, never by docs.json: bound to a hidden tab so no navigation is generated. */
  pageOnly?: boolean
  /** A published page's `openapi:` frontmatter names this spec, so it must be bound to some tab even when its own tab already has a spec. */
  pageReferenced?: boolean
  /** Repository-relative path the spec was read from, used only to disambiguate a basename collision across tabs. */
  sourcePath: string
  /** Mintlify's object-form `{ source, directory }` scoping directory, if any — the prefix its auto-generated operation pages live under. */
  directory?: string
  /** Mintlify generates this spec's endpoint pages (no published page names its operations itself), so Thally should list them in the sidebar too. */
  generatedNavigation?: boolean
  /** The operation groups docs.json authors for the tab this spec binds to, merged across every reference that shares it. */
  groups?: Array<MigrationApiGroup>
  /** Every reference sharing the tab lists operations and none survives (all hidden or restricted): the tab lists none of them, so no endpoint navigation is generated. */
  navigation?: false
  /** With `groups`: the listed operations become pages under this directory (`addEndpointPages`) instead of an API tab's operations. */
  endpointPages?: EndpointPagesTarget
  /** Set once those pages exist: the operations that have one, in listed order. */
  endpointOperations?: Array<string>
  /** The warning that a `directory` scoping was lost, held back while `endpointPages` may still keep it; reported if the spec ends up an API tab. */
  directoryWarning?: MigrationWarning
}

function mintlifyTopLevelApiReferences(config: Record<string, unknown> | null): Array<MintlifyApiSpecReference> {
  const api = config?.api && typeof config.api === 'object' && !Array.isArray(config.api)
    ? config.api as Record<string, unknown>
    : null
  if (!api) return []
  const references: Array<MintlifyApiSpecReference> = []
  for (const kind of ['openapi', 'asyncapi'] as const) {
    const value = api[kind]
    const values = typeof value === 'string'
      ? [value]
      : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
    for (const entry of values) references.push({ value: entry, kind })
  }
  return references
}

/** The files a page's `openapi:` prefix can name: OpenAPI documents by extension, never pages or images that share a stem. */
function specFileCandidates(files: ReadonlyArray<ScannedFile>): Array<Required<SpecCandidate>> {
  return files.filter((file) => /\.(?:json|ya?ml)$/i.test(file.relativePath))
    .map((file) => ({ sourcePath: file.relativePath, filename: specRefBaseName(file.relativePath) }))
}

/**
 * Resolve every OpenAPI/AsyncAPI reference in a Mintlify config — the
 * top-level `api.openapi`/`api.asyncapi` plus every per-tab/group/anchor
 * `openapi`/`asyncapi` field in `navigation` — into copyable spec bytes
 * bound to the tab that referenced them. AsyncAPI has no Thally renderer,
 * so it only ever produces a warning naming the spec. A remote `https://`
 * reference is skipped with an actionable warning until the downloader can
 * validate the connected address on every request, including redirects.
 * Missing local files also produce warnings rather than disappearing.
 */
function resolveMintlifyApiSpecs(
  mintlifyConfig: Record<string, unknown> | null,
  files: Array<ScannedFile>,
  warnings: Array<MigrationWarning>,
  remoteSpecs: Array<RemoteApiSpec>,
  /** Names every spec asset of the site, so a spec bound later (the repository scan's) cannot reuse a name taken here. */
  nameSpec: ReturnType<typeof createSpecAssetNamer>,
  /** Published pages' `openapi:` frontmatter: Mintlify renders a spec named only here, so it is migrated too. */
  pages: ReadonlyArray<{ openapi?: string }> = [],
  /** The API tabs that list operations and nothing else, with the container that owns each and where it sat: the tab of such a container keeps the label the projection gave it. */
  apiTabSlots: ReadonlyArray<{ container: object; slot: EndpointTabSlot }> = [],
): Array<ResolvedApiSpec> {
  if (!mintlifyConfig) return []
  const slotByContainer = new Map(apiTabSlots.map(({ container, slot }) => [container, slot]))
  const slotByLabel = new Map(apiTabSlots.map(({ slot }) => [slot.tab.tab, slot]))
  const references: Array<MintlifyApiSpecReference & { pageOnly?: boolean }> = [
    ...mintlifyTopLevelApiReferences(mintlifyConfig),
    ...mintlifyNavigationApiReferences(mintlifyConfig, (container) => slotByContainer.get(container)?.tab.tab),
  ]
  // A reference that lists operations gets them as pages under its directory, unless the directory cannot name a folder.
  const endpointPagesOf = (reference: MintlifyApiSpecReference): EndpointPagesTarget | undefined => {
    const directory = reference.groups ? endpointDirectory(reference.directory) : undefined
    const slot = reference.tabLabel ? slotByLabel.get(reference.tabLabel) : undefined
    return directory === undefined ? undefined : { directory, ...(slot ? { slot } : {}) }
  }
  const known = new Set(references.map((reference) => canonicalSpecRef(reference.value)))
  const specFiles = specFileCandidates(files)
  // Pages repeat a few spec prefixes: look each one up once.
  const namedFiles = new Map<string, SpecRefResolution<Required<SpecCandidate>>>()
  for (const page of pages) {
    const specRef = page.openapi ? splitOpenApiRef(page.openapi)?.specRef : undefined
    // Remote refs, a missing file and a name that fits several files are reported by rewriteMintlifyPageSpecRefs.
    if (!specRef || /^[a-z][a-z0-9+.-]*:/i.test(specRef)) continue
    const named = namedFiles.get(specRef) ?? resolveSpecRef(specRef, specFiles, false)
    namedFiles.set(specRef, named)
    const key = named.kind === 'match' ? named.spec.sourcePath : ''
    if (!key || known.has(key)) continue
    known.add(key)
    references.push({ value: key, kind: 'openapi', tabLabel: `OpenAPI: ${key}`, hidden: true, pageOnly: true })
  }
  const seen = new Set<string>()
  // Several tabs (one per product, say) can bind one remote spec to the same label, each under its own directory.
  const remoteByKey = new Map<string, RemoteApiSpec>()
  const mountDirectory = (remote: RemoteApiSpec | undefined, reference: MintlifyApiSpecReference): void => {
    const directory = reference.directory?.replace(/^\/+|\/+$/g, '')
    if (!remote || !directory) return
    const mount = remote.directories?.find((existing) => existing.directory === directory)
    if (!mount) {
      remote.directories = [...(remote.directories ?? []), { directory, ...(reference.operations ? { operations: reference.operations } : {}) }]
    } else if (mount.operations && reference.operations) {
      // One directory served the operations of every container that mounted it.
      mount.operations = [...new Set([...mount.operations, ...reference.operations])]
    } else {
      // A container that lists nothing had every operation generated under the directory.
      delete mount.operations
    }
  }
  // References sharing a spec and tab (one per product, say) are one binding: their operation groups are one list, unless
  // one of them lists none (Mintlify generated every operation there), which leaves the generated navigation to list them all.
  // A reference that lists operations but hides or restricts every one adds no groups and lists something all the same, and so
  // does one under a non-default language (the default language's navigation owns the tab): neither leaves the tab unlisted.
  // When every reference that decides lists operations and none survives (`withheld`), the source sidebar showed none of them,
  // and the tab gets an empty authored selection rather than generated navigation that lists them all.
  const listsNothing = (reference: MintlifyApiSpecReference): boolean => !reference.groups && !reference.operationsWithheld && !reference.otherLanguage
  // `directory`: the one directory the references that list operations agree on (undefined while none has, null once two disagree or one has no usable folder).
  const groupTargets = new Map<string, { target: { groups?: Array<MigrationApiGroup>; navigation?: false; endpointPages?: EndpointPagesTarget }; unlisted: boolean; withheld: boolean; directory?: string | null }>()
  const specs: Array<ResolvedApiSpec> = []
  for (const reference of references) {
    const dedupeKey = `${reference.kind}:${reference.value}:${reference.tabLabel ?? ''}`
    if (seen.has(dedupeKey)) {
      mountDirectory(remoteByKey.get(dedupeKey), reference)
      const shared = groupTargets.get(dedupeKey)
      if (shared && !shared.unlisted) {
        if (reference.operationsWithheld) shared.withheld = true
        if (reference.groups) {
          const merged = mergeApiGroups(shared.target.groups, reference.groups)
          if (merged) shared.target.groups = merged
          // Merged groups cannot say which directory each operation was served under: pages are made only when every reference that lists agrees on one.
          const own = endpointPagesOf(reference)
          if (shared.directory === undefined) {
            shared.directory = own?.directory ?? null
            if (own) shared.target.endpointPages = own
          } else if (shared.directory !== (own?.directory ?? null)) {
            shared.directory = null
            delete shared.target.endpointPages
          }
        } else if (listsNothing(reference)) {
          shared.unlisted = true
          delete shared.target.groups
        }
      }
      continue
    }
    seen.add(dedupeKey)
    const groups = mergeApiGroups(undefined, reference.groups)
    const tabSuffix = reference.tabLabel ? ` (tab "${reference.tabLabel}")` : ''
    if (reference.kind === 'asyncapi') {
      warnings.push({
        code: 'unsupported-config',
        message: `AsyncAPI is not supported by Thally's API reference; the spec "${reference.value}"${tabSuffix} was not migrated.`,
      })
      continue
    }
    if (/^https:\/\//i.test(reference.value)) {
      const pagesTarget = endpointPagesOf(reference)
      const remote: RemoteApiSpec = { url: reference.value, ...(reference.tabLabel ? { tabLabel: reference.tabLabel } : {}), ...(reference.parentTab ? { parentTab: reference.parentTab } : {}), ...(reference.icon ? { icon: reference.icon } : {}), ...(reference.hidden ? { hidden: true } : {}), ...(groups ? { groups } : {}), ...(groups && pagesTarget ? { endpointPages: pagesTarget } : {}) }
      mountDirectory(remote, reference)
      remoteSpecs.push(remote)
      remoteByKey.set(dedupeKey, remote)
      groupTargets.set(dedupeKey, { target: remote, unlisted: listsNothing(reference), withheld: reference.operationsWithheld === true, ...(groups ? { directory: pagesTarget?.directory ?? null } : {}) })
      warnings.push({
        code: 'unsupported-config',
        message: `The remote OpenAPI spec "${reference.value}"${tabSuffix} requires a network download before this import is complete.`,
        source: reference.value,
      })
      continue
    }
    if (/^http:\/\//i.test(reference.value)) {
      warnings.push({ code: 'unsupported-config', message: `The OpenAPI spec "${reference.value}"${tabSuffix} uses insecure HTTP and was not imported.`, source: reference.value })
      continue
    }
    const key = canonicalSpecRef(reference.value)
    const match = files.find((file) => file.relativePath === key)
    if (!match) {
      warnings.push({
        code: 'unsupported-config',
        message: `The OpenAPI spec "${reference.value}"${tabSuffix} could not be found in the repository and was not migrated.`,
      })
      continue
    }
    const directoryWarning: MigrationWarning | undefined = reference.directory ? {
      code: 'unsupported-config',
      message: `The OpenAPI spec "${reference.value}"${tabSuffix} was limited to pages under "${reference.directory}" in the source, but Thally's API reference always covers a whole tab, so it was migrated as the tab's full API reference. Links in page bodies and Mintlify endpoint URLs under "${reference.directory}/<tag>/<operation>" are redirected to the matching endpoints where one exists (a separate warning counts any endpoint redirects that were skipped); check any other links to "${reference.directory}/..." manually.`,
    } : undefined
    // Listed operations become pages under the directory, so the warning applies only if that falls back to an API tab.
    const deferWarning = Boolean(groups && endpointPagesOf(reference))
    if (directoryWarning && !deferWarning) warnings.push(directoryWarning)
    const content = readSpecFile(match.absolutePath, match.relativePath, warnings)
    if (!content) continue
    const spec: ResolvedApiSpec = {
      filename: basename(match.relativePath),
      content,
      tabLabel: reference.tabLabel,
      parentTab: reference.parentTab,
      icon: reference.icon,
      hidden: reference.hidden,
      ...(reference.pageOnly ? { pageOnly: true } : {}),
      sourcePath: match.relativePath,
      directory: reference.directory,
      ...(groups ? { groups } : {}),
      ...(deferWarning ? { endpointPages: endpointPagesOf(reference), directoryWarning } : {}),
    }
    specs.push(spec)
    groupTargets.set(dedupeKey, { target: spec, unlisted: listsNothing(reference), withheld: reference.operationsWithheld === true, ...(groups ? { directory: endpointPagesOf(reference)?.directory ?? null } : {}) })
  }
  for (const { target, unlisted, withheld } of groupTargets.values()) {
    if (withheld && !unlisted && !target.groups) target.navigation = false
  }
  for (const spec of specs) spec.filename = nameSpec(spec)
  return specs
}

/**
 * Point each page's `openapi: "<spec> METHOD /path"` prefix at the location
 * the migrated spec was written to. A prefix naming a spec that was not
 * migrated is kept as authored and reported: the page cannot resolve without it.
 */
function rewriteMintlifyPageSpecRefs(
  pages: Array<MigrationPage>,
  specs: Array<{ filename: string; sourcePath?: string }>,
  remoteUrls: Set<string>,
  warnings: Array<MigrationWarning>,
  /** Why a spec path that matched no migrated spec is missing, e.g. a case mismatch, an ignored file or a symlink. */
  explainMissing: (key: string) => string = () => 'no such file was found',
): void {
  for (const page of pages) {
    const ref = page.openapi ? splitOpenApiRef(page.openapi) : null
    if (!ref?.specRef) continue
    if (/^https?:\/\//i.test(ref.specRef)) {
      // A remote spec is rewritten once it has been downloaded (hydrateRemoteApiSpecs).
      if (!remoteUrls.has(ref.specRef)) {
        warnings.push({ code: 'unsupported-config', message: `Page "${page.id}" references the remote OpenAPI spec "${ref.specRef}", which is not referenced from docs.json and was not migrated; the page will not render an endpoint.`, source: page.source })
      }
      continue
    }
    const key = canonicalSpecRef(ref.specRef)
    const resolved = resolveSpecRef(ref.specRef, specs)
    if (resolved.kind === 'match') {
      page.openapi = withSpecRef(ref, specAssetPath(resolved.spec.filename))
    } else if (resolved.kind === 'ambiguous') {
      const candidates = resolved.candidates.map((spec) => spec.sourcePath ?? spec.filename).join(', ')
      warnings.push({ code: 'unsupported-config', message: `Page "${page.id}" references the OpenAPI spec "${ref.specRef}", which fits more than one spec (${candidates}), so it was left as written and the page will not render an endpoint. Write the full path of the spec in the page's openapi frontmatter.`, source: page.source })
    } else {
      warnings.push({ code: 'unsupported-config', message: `Page "${page.id}" references the OpenAPI spec "${ref.specRef}", which was not migrated (${explainMissing(key)}); the page will not render an endpoint.`, source: page.source })
    }
  }
}

const OPENAPI_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']

/** NestJS's conventional CRUD controller method names, mapped to the REST-conventional slug Fern renders them under (confirmed against a live site). */
const FERN_CRUD_METHOD_NAMES: Record<string, string> = {
  findall: 'list',
  findone: 'get',
  remove: 'delete',
}

/** Kebab-case a label the way Mintlify slugs its auto-generated OpenAPI operation pages (tag folder, operation leaf). */
/**
 * Mintlify's URL slug for a tag or operation title, as served by live sites
 * (149/149 of an OpenAPI site's endpoint URLs): lower-cased, punctuation
 * dropped rather than hyphenated ("alpha.decisions" -> "alphadecisions",
 * "intern's" -> "interns"), "&" kept, whitespace -> "-".
 */
export function mintlifyUrlSlug(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_\s&-]/gu, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-')
}

function mintlifyOperationSlugSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

/**
 * Thally's own API operation route segment: path segments (braces stripped)
 * plus the HTTP method — never the summary. Mirrors `buildSlugSegments` in
 * src/lib/openapi/normalize.ts; duplicated rather than imported because
 * packages/migrate cannot depend on the Next.js app. Ceiling: webhook
 * operations (`x-webhooks`) aren't covered — normalize.ts prefixes those
 * with "webhooks", update this alongside it if that ever matters here.
 */
export function thallyOperationSlugSegments(path: string, method: string): Array<string> {
  const cleaned = path
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase())
  if (!cleaned.length) cleaned.push('root')
  cleaned.push(method.toLowerCase())
  return cleaned
}

/** Mirrors `slugifyId` in src/data/docs.ts, which turns a tab label into its API spec id. */
function slugifyApiSpecId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/]+/g, '-').replace(/(^-|-$)+/g, '').replace(/\//g, '-') || value.toLowerCase()
}

/**
 * Each visible API tab with the id the renderer serves its spec under: the
 * first is `default`, every other one takes its tab's slug (a hidden tab's spec
 * serves no endpoint pages of its own).
 */
export function apiTabSpecIds<T extends { tab: string; hidden?: boolean; api?: object }>(tabs: ReadonlyArray<T>): Array<{ tab: T; specId: string }> {
  return tabs.filter((tab) => !tab.hidden && tab.api).map((tab, index) => ({ tab, specId: index === 0 ? 'default' : slugifyApiSpecId(tab.tab) }))
}

interface OpenApiOperationForLinking {
  method: string
  path: string
  tag?: string
  summary?: string
  operationId?: string
  description?: string
}

/** `x-hidden: true` and `x-excluded: true` (or the string `"true"`), as the renderer reads them. */
const flagged = (value: unknown): boolean => value === true || value === 'true'

/** Whether the renderer withholds a path item or an operation, so that it has no endpoint page to link or redirect to. */
export const isWithheld = (node: Record<string, unknown>): boolean => flagged(node['x-hidden']) || flagged(node['x-excluded'])

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A local `#/...` JSON pointer in a spec document, as the renderer reads it (`resolveLocalRef`); undefined when it is not local or leads nowhere. */
function resolveLocalSpecRef(document: unknown, ref: string): unknown {
  if (ref !== '#' && !ref.startsWith('#/')) return undefined
  let node: unknown = document
  for (const segment of ref.slice(2).split('/').filter(Boolean)) {
    if (!isRecord(node) && !Array.isArray(node)) return undefined
    let decoded = segment
    try { decoded = decodeURIComponent(segment) } catch { /* keep the raw segment */ }
    node = (node as Record<string, unknown>)[decoded.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return node
}

/**
 * A `paths` entry as the renderer views it (`viewPathEntry`): the entry and each local `$ref` target it leads to, merged with the nearest level
 * winning, and withheld when `x-hidden` or `x-excluded` is set on any of those levels. A reference that cannot be followed (external, missing,
 * circular) ends the chain there: the levels reached still count, and nothing beyond them can be read.
 */
function viewSpecPathItem(document: unknown, entry: Record<string, unknown>): { item: Record<string, unknown>; withheld: boolean } {
  const chain = [entry]
  let current = entry
  while (typeof current.$ref === 'string') {
    const target = resolveLocalSpecRef(document, current.$ref)
    if (!isRecord(target) || chain.includes(target)) break
    chain.push(target)
    current = target
  }
  const item: Record<string, unknown> = Object.assign({}, ...[...chain].reverse())
  delete item.$ref
  return { item, withheld: chain.some(isWithheld) }
}

/**
 * Read just enough of an OpenAPI document to match Mintlify's auto-generated
 * operation pages. An operation the renderer withholds (`x-hidden`,
 * `x-excluded`, on it or on its path item, whether the path item is inline or a
 * local `$ref`) has no endpoint page to link or redirect to. Malformed input
 * yields no operations rather than throwing.
 */
function parseOpenApiOperationsForLinking(content: Buffer): Array<OpenApiOperationForLinking> {
  const document = readSpecDocument(content)
  return visibleOperations(document, isRecord(document) ? document.paths : undefined)
}

/** The parsed document of a spec, or undefined when it cannot be read. */
function readSpecDocument(content: Buffer): unknown {
  try {
    return parseSpecDocument(content.toString('utf8')).document
  } catch {
    return undefined
  }
}

/**
 * The operations the renderer publishes from one `paths` or `webhooks` table of a document: each entry resolved as `viewSpecPathItem` does,
 * and each operation not withheld on any level. One rule for both tables, so a path operation and a webhook are judged alike.
 */
function visibleOperations(document: unknown, entries: unknown): Array<OpenApiOperationForLinking> {
  if (!isRecord(entries)) return []
  const operations: Array<OpenApiOperationForLinking> = []
  for (const [path, pathItem] of Object.entries(entries)) {
    if (!isRecord(pathItem)) continue
    const { item, withheld } = viewSpecPathItem(document, pathItem)
    if (withheld) continue
    for (const method of OPENAPI_HTTP_METHODS) {
      const operation = item[method]
      if (!operation || typeof operation !== 'object') continue
      const op = operation as Record<string, unknown>
      if (isWithheld(op)) continue
      const tags = Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === 'string') : []
      operations.push({
        method,
        path,
        tag: tags[0],
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        description: typeof op.description === 'string' ? op.description : undefined,
      })
    }
  }
  return operations
}

/** Enumerate generated endpoint routes using the same spec visibility, tab ids and slugs as migration linking. */
export function migrationApiRoutes(bundle: Pick<MigrationBundle, 'docsConfig' | 'assets'>): Array<string> {
  const routes = new Set<string>()
  for (const { tab, specId } of apiTabSpecIds(bundle.docsConfig.tabs)) {
    const source = tab.api!.source.replace(/^\//, '')
    const asset = bundle.assets.find((entry) => entry.path.replace(/^\//, '') === source)
    if (!asset) continue
    const document = readSpecDocument(Buffer.from(asset.content))
    if (!isRecord(document)) continue
    routes.add('/api')
    routes.add(`/api/${specId}`)
    for (const operation of visibleOperations(document, document.paths)) {
      routes.add(`/api/${specId}/${thallyOperationSlugSegments(operation.path, operation.method).join('/')}`)
    }
    for (const operation of visibleOperations(document, document.webhooks)) {
      const segments = thallyOperationSlugSegments(operation.path, operation.method)
      if (segments[0] !== 'webhooks') segments.unshift('webhooks')
      routes.add(`/api/${specId}/${segments.join('/')}`)
    }
  }
  return [...routes]
}

/**
 * Map Mintlify's auto-generated operation page path (e.g.
 * "qstash/api-reference/messages/publish-a-message", from the `directory`
 * an object-form `openapi: { source, directory }` reference scoped its
 * pages under) to Thally's actual operation route
 * (`/api/<specId>/<method+path slug>`), so in-content links to those
 * Mintlify-only pages can be rewritten instead of staying broken.
 *
 * `specId` mirrors buildApiReferenceConfig in src/config/api-reference.ts:
 * the first non-hidden tab with a bound spec is `'default'`, every other
 * one is keyed by its own tab id. Ceiling: matches by tag + (summary,
 * operationId, or "method path"), the same fields Mintlify's generator
 * itself falls back through — an operation whose tag Mintlify computed
 * differently still won't resolve, and stays a broken link as before.
 */
/** A spec bound to a tab, plus the source-platform's own route prefix its auto-generated operation pages live under (Mintlify's `directory`, Fern's section route). */
interface ApiOperationLinkSource {
  filename: string
  content: Buffer
  /** Prefix path segment(s) the source platform served its auto-generated operation pages under (no leading/trailing slash); absent or empty means "no known auto-generated prefix for this spec" and it's skipped. */
  prefix?: string
  /** `METHOD /path` operations the source served under this prefix, in navigation order (it served only these); every operation when absent. */
  operations?: ReadonlyArray<string>
  /** The one tab this prefix belongs to, when several tabs are bound to the spec; every tab bound to it when absent. */
  tab?: string
  /**
   * The served operations are pages of the site (`addEndpointPages`), at the URLs Mintlify served them under: no tab of this spec lists them
   * under `/api/`, so the source is not matched to one, a link to an operation reaches its page, and no endpoint URL is redirected.
   */
  endpointPages?: boolean
}

export interface ApiOperationLinkMaps {
  /** Exact source-platform operation-page path (lowercased) -> Thally operation route. */
  operationLinks: Map<string, string>
  /**
   * Source-platform API-section route prefix (lowercased, no leading/trailing
   * slash) -> that spec's Thally landing route (`/api` for the first spec,
   * `/api/<specId>` for the rest). Used both for a bare tab-landing link
   * (the prefix on its own) and as the fallback for an operation link under
   * this prefix that didn't match any known operation.
   */
  prefixLandings: Map<string, string>
  /** Canonical Mintlify endpoint URL (original case) -> Thally operation route, for redirects. */
  mintlifyPages: Map<string, string>
  /** Mintlify endpoint URLs that two operations share; the first operation keeps the URL. */
  duplicatePages: Array<string>
}

/** The operations a source served under its prefix: the listed ones in listed order, else every operation of the spec. */
function servedOperations(source: ApiOperationLinkSource, parsed: Map<string, Array<OpenApiOperationForLinking>>): Array<OpenApiOperationForLinking> {
  // A spec mounted under several directories is read once, not once per mount.
  let operations = parsed.get(source.filename)
  if (!operations) {
    operations = parseOpenApiOperationsForLinking(source.content)
    parsed.set(source.filename, operations)
  }
  if (!source.operations) return operations
  const byKey = new Map(operations.map((operation) => [`${operation.method} ${operation.path}`, operation]))
  return source.operations.flatMap((reference) => {
    const [method, ...path] = reference.trim().split(/\s+/)
    const operation = byKey.get(`${method.toLowerCase()} ${path.join(' ')}`)
    return operation ? [operation] : []
  })
}

/** A mount's directory as route prefixes compare it: lower-cased, without surrounding slashes. */
export const mountPrefix = (directory: string): string => directory.replace(/^\/+|\/+$/g, '').toLowerCase()

/**
 * Mintlify's URL for an operation's generated page, `<directory>/<first tag>/<summary>`, and the title it carries: the summary, else the
 * operation id, else "METHOD /path". The redirects, the link map and the pages all read the URL here, so they cannot disagree about it.
 * `tag` and `leaf` are the two slugs; either is empty when nothing of its text is URL-safe.
 */
function mintlifyEndpointUrl(directory: string, operation: OpenApiOperationForLinking): { tag: string; leaf: string; url: string; title: string } {
  const tag = mintlifyUrlSlug(operation.tag ?? 'default')
  const leaf = mintlifyUrlSlug(operation.summary?.trim() || operation.operationId?.trim() || `${operation.method} ${operation.path}`)
  return {
    tag,
    leaf,
    url: `${directory}/${tag}/${leaf}`.replace(/^\/+|\/+$/g, ''),
    title: operation.summary?.trim() || operation.operationId?.trim() || `${operation.method.toUpperCase()} ${operation.path}`,
  }
}

export function apiOperationLinkMap(
  sources: Array<ApiOperationLinkSource>,
  docsConfig: MigrationDocsConfig,
  /** Directories of mounts these sources do not cover (a remote spec that could not be downloaded): an address under a deeper one is theirs. */
  otherMounts: ReadonlyArray<string> = [],
): ApiOperationLinkMaps {
  const map = new Map<string, string>()
  const prefixLandings = new Map<string, string>()
  const mintlifyPages = new Map<string, string>()
  const duplicatePages: Array<string> = []
  const parsedByFile = new Map<string, Array<OpenApiOperationForLinking>>()
  // A spec can be mounted under several prefixes (one per product), so a tab may match more than one source.
  // A mount whose operations are pages has no `/api/` id: it is bound to nothing, and its links go to the pages.
  const bound: Array<{ source: ApiOperationLinkSource; specId?: string }> = [
    ...apiTabSpecIds(docsConfig.tabs).flatMap(({ tab, specId }) => sources
      .filter((entry) => !entry.endpointPages && tab.api?.source === specAssetPath(entry.filename) && (!entry.tab || entry.tab === tab.tab))
      .map((source) => ({ source, specId }))),
    ...sources.filter((entry) => entry.endpointPages).map((source) => ({ source })),
  ]
  // An address belongs to the most specific mount it lies under: one mounted at
  // `reference` never claims what a mount at `reference/v2` serves.
  const mounts = new Set([...bound.map(({ source }) => source.prefix ? mountPrefix(source.prefix) : ''), ...otherMounts.map(mountPrefix)].filter(Boolean))
  const underDeeperMount = (route: string, own: string): boolean => {
    const lower = route.toLowerCase()
    return [...mounts].some((mount) => mount.length > own.length && (lower === mount || lower.startsWith(`${mount}/`)))
  }
  bound.forEach(({ source, specId }) => {
    if (!source.prefix) return
    // The directory as written minus surrounding slashes: `reference/` and `/reference` name the folder `reference`.
    const base = source.prefix.replace(/^\/+|\/+$/g, '')
    const prefix = mountPrefix(source.prefix)
    if (prefix && specId !== undefined) prefixLandings.set(prefix, specId === 'default' ? '/api' : `/api/${specId}`)
    for (const operation of servedOperations(source, parsedByFile)) {
      const endpoint = mintlifyEndpointUrl(base, operation)
      // An operation with no URL-safe tag or title has no page to reach.
      if (specId === undefined && (!endpoint.tag || !endpoint.leaf)) continue
      const thallyHref = specId === undefined
        ? `/${endpoint.url}`
        : `/api/${specId}/${thallyOperationSlugSegments(operation.path, operation.method).join('/')}`
      // A mount's overview is the first page it lists, where its tab opens.
      if (specId === undefined && prefix && !prefixLandings.has(prefix)) prefixLandings.set(prefix, thallyHref)
      // Leaf candidates, tried in order of how likely a source generator is
      // to have used them: Mintlify slugs from the summary; Fern instead
      // prefers an SDK-style method name — confirmed against a live Fern
      // site, where `operationId: "ToolController_create"` (summary
      // "Create Tool") rendered its page at ".../tools/create", the
      // operationId's segment after its last "_"/".", not the summary.
      const leafCandidates = new Set<string>()
      if (operation.operationId) {
        const parts = operation.operationId.split(/[_.]/).filter(Boolean)
        const lastPart = parts.at(-1) ?? operation.operationId
        // A NestJS-style controller method name (findOne/findAll/remove) is
        // common enough in real OpenAPI generators that Fern renders it
        // under its REST-conventional name instead — also confirmed live:
        // "CallController_findOne" rendered at ".../calls/get", not
        // ".../calls/find-one".
        const conventional = FERN_CRUD_METHOD_NAMES[lastPart.toLowerCase()]
        if (conventional) leafCandidates.add(conventional)
        leafCandidates.add(mintlifyOperationSlugSegment(lastPart))
      }
      if (operation.summary) leafCandidates.add(mintlifyOperationSlugSegment(operation.summary))
      if (operation.operationId) leafCandidates.add(mintlifyOperationSlugSegment(operation.operationId))
      leafCandidates.add(mintlifyOperationSlugSegment(`${operation.method} ${operation.path}`))
      // Two prefix conventions get registered for every leaf candidate:
      // Mintlify nests auto-generated pages under a tag folder
      // ("<prefix>/<tag>/<leaf>"); Fern's default layout serves them flat
      // under the section route ("<prefix>/<leaf>") instead. Registering
      // every combination costs nothing (an operation matches at most one
      // of them in practice) and avoids guessing which convention and
      // which leaf a given source actually used.
      const tagSegment = mintlifyOperationSlugSegment(operation.tag ?? 'default')
      const { tag: mintlifyTag, leaf: mintlifyLeaf, url: canonical } = endpoint
      if (mintlifyTag && mintlifyLeaf && !underDeeperMount(canonical, prefix)) {
        // A page is served at its own URL, so no endpoint URL of a mount whose operations are pages is redirected (and its duplicates were settled with the pages).
        if (specId !== undefined) {
          if (!mintlifyPages.has(canonical)) mintlifyPages.set(canonical, thallyHref)
          else if (mintlifyPages.get(canonical) !== thallyHref && !duplicatePages.includes(canonical)) duplicatePages.push(canonical)
        }
        if (!map.has(canonical.toLowerCase())) map.set(canonical.toLowerCase(), thallyHref)
      }
      // Mintlify redirects a bare tag URL to that tag's first operation.
      const tagRoot = `${base}/${mintlifyTag}`.replace(/^\/+|\/+$/g, '')
      if (mintlifyTag && !underDeeperMount(tagRoot, prefix)) {
        if (specId !== undefined && !mintlifyPages.has(tagRoot)) mintlifyPages.set(tagRoot, thallyHref)
        if (!map.has(tagRoot.toLowerCase())) map.set(tagRoot.toLowerCase(), thallyHref)
      }
      for (const leaf of leafCandidates) {
        if (!leaf) continue
        const tagged = `${base}/${tagSegment}/${leaf}`.replace(/^\/+|\/+$/g, '').toLowerCase()
        const flat = `${base}/${leaf}`.replace(/^\/+|\/+$/g, '').toLowerCase()
        if (!map.has(tagged) && !underDeeperMount(tagged, prefix)) map.set(tagged, thallyHref)
        if (!map.has(flat) && !underDeeperMount(flat, prefix)) map.set(flat, thallyHref)
      }
    }
  })
  return { operationLinks: map, prefixLandings, mintlifyPages, duplicatePages }
}

/**
 * Redirects from Mintlify's generated endpoint URLs to the matching Thally
 * endpoint pages. A URL that already has a page, or a redirect of its own,
 * keeps it: that URL still serves, so nothing is lost and nothing is said.
 */
export function mintlifyEndpointRedirects(
  maps: Pick<ApiOperationLinkMaps, 'mintlifyPages' | 'duplicatePages'>,
  pages: ReadonlyArray<Pick<MigrationPage, 'id'>>,
  existing: ReadonlyArray<{ source: string }>,
  warnings: Array<MigrationWarning>,
): Array<{ source: string; destination: string }> {
  const { mintlifyPages, duplicatePages } = maps
  if (duplicatePages.length > 0) {
    const listed = duplicatePages.slice(0, 10).map((url) => `/${url}`).join(', ')
    warnings.push({
      code: 'unsupported-config',
      message: `${duplicatePages.length} Mintlify endpoint URL${duplicatePages.length === 1 ? ' is' : 's are'} shared by more than one operation (same tag and summary), so only the first operation is redirected from each: ${listed}${duplicatePages.length > 10 ? ', ...' : ''}.`,
    })
  }
  const taken = servedRoutes(pages)
  for (const redirect of existing) taken.add(literalRoute(redirect.source) ?? redirect.source)
  const candidates = [...mintlifyPages].filter(([source]) => !taken.has(literalRoute(`/${source}`) ?? `/${source}`))
  const redirects = candidates.slice(0, MAX_ENDPOINT_REDIRECTS)
    .map(([source, destination]) => ({ source: `/${source}`, destination }))
  const capped = candidates.length - redirects.length
  if (capped > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `Created ${redirects.length} of ${candidates.length} Mintlify endpoint redirects; skipped ${capped} because a site is limited to ${MAX_ENDPOINT_REDIRECTS} generated endpoint redirects. Old links to skipped endpoint URLs will not redirect.`,
    })
  }
  return redirects
}

/**
 * Link every API mount of a site in one pass: rewrite the body links under them
 * and return the redirects from the endpoint URLs they served. Every spec must
 * be bound in `docsConfig` first, because the id a spec is served under
 * depends on the tabs ahead of it. `reservedMounts` are directories of mounts
 * without a source here (a remote spec that could not be downloaded): the
 * addresses under them are theirs and stay as authored.
 */
export function linkApiMounts(
  sources: Array<ApiOperationLinkSource>,
  docsConfig: MigrationDocsConfig,
  pages: Array<MigrationPage>,
  warnings: Array<MigrationWarning>,
  reservedMounts: ReadonlyArray<string> = [],
): Array<{ source: string; destination: string }> {
  const maps = apiOperationLinkMap(sources, docsConfig, reservedMounts)
  rewriteApiLinksInPages(pages, maps.operationLinks, maps.prefixLandings, warnings, { mounts: reservedMounts, redirects: docsConfig.redirects })
  return mintlifyEndpointRedirects(maps, pages, docsConfig.redirects ?? [], warnings)
}

/** Mintlify's default `directory` for the pages it generates, when docs.json names none. */
const DEFAULT_ENDPOINT_DIRECTORY = 'api-reference'

/**
 * The folder the generated pages of a reference go under, without surrounding slashes. It becomes part of a file path below `src/content`,
 * so only plain segments are accepted (no `.`/`..`, separators, spaces or control characters, none too long for a file name): any other
 * directory yields no pages, and the spec is bound as an API tab instead.
 */
export function endpointDirectory(directory: string | undefined): string | undefined {
  const value = (directory ?? DEFAULT_ENDPOINT_DIRECTORY).replace(/^\/+|\/+$/g, '')
  const plain = (segment: string): boolean => /^[\p{L}\p{N}_&-][\p{L}\p{N}_&.-]*$/u.test(segment) && Buffer.byteLength(`${segment}.mdx`) <= 255
  return value && value.split('/').every(plain) ? value : undefined
}

/** What the endpoint pages of a site share: who owns each URL, and the problems found, which are reported once however many specs there are. */
export interface EndpointPageLedger {
  /** Page id and the operation (`<spec asset> METHOD /path`) a generated page documents, by lower-cased id; null for an authored page, which keeps its URL. */
  owners: Map<string, { id: string; operation: string | null }>
  /** URLs two different operations share (same tag and title): the first keeps the page. */
  duplicates: Array<string>
  /** Listed operations whose tag or title leaves no usable file name, so they have no page. */
  unnamed: Array<string>
}

export function createEndpointPageLedger(pages: ReadonlyArray<Pick<MigrationPage, 'id'>>): EndpointPageLedger {
  return { owners: new Map(pages.map((page) => [page.id.toLowerCase(), { id: page.id, operation: null }])), duplicates: [], unnamed: [] }
}

/** Say what `addEndpointPages` left out, once for the whole site. */
export function reportEndpointPages(ledger: EndpointPageLedger, warnings: Array<MigrationWarning>): void {
  const names = (urls: Array<string>): string => `${urls.slice(0, 10).join(', ')}${urls.length > 10 ? ', ...' : ''}`
  if (ledger.duplicates.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `${ledger.duplicates.length} Mintlify endpoint URL${ledger.duplicates.length === 1 ? ' is' : 's are'} shared by more than one operation (same tag and summary), so only the first operation has a page at each: ${names(ledger.duplicates.map((url) => `/${url}`))}.`,
    })
  }
  if (ledger.unnamed.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `${ledger.unnamed.length} listed operation${ledger.unnamed.length === 1 ? ' has' : 's have'} no page because ${ledger.unnamed.length === 1 ? 'its' : 'their'} tag or title leaves no usable page name: ${names(ledger.unnamed)}.`,
    })
  }
}

/** The first sentence of an operation's description as plain text, or the title when it has none: a page's description is never empty. */
function endpointDescription(description: string | undefined, title: string): string {
  const text = (description ?? '')
    .split(/\r?\n\s*\r?\n/, 1)[0]
    .replace(/<[^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]|__/g, '')
    .replace(/^\s*#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text
  const limited = sentence.length > 300 ? `${sentence.slice(0, 297).replace(/\s+\S*$/, '')}...` : sentence
  return limited || title
}

/** Put an API tab back among its siblings: after the nearest of the tabs that preceded it that is still there, else first when none preceded it, else last. */
function insertEndpointTab(tabs: Array<MigrationNavigationTab>, tab: MigrationNavigationTab, preceding: ReadonlyArray<string>): void {
  if (preceding.length === 0) {
    tabs.unshift(tab)
    return
  }
  for (const label of preceding) {
    const index = tabs.findIndex((candidate) => candidate.tab === label)
    if (index !== -1) {
      tabs.splice(index + 1, 0, tab)
      return
    }
  }
  tabs.push(tab)
}

/**
 * Give each operation a reference lists its own page, where Mintlify served it, and put them in the tab that listed them.
 *
 * Mintlify generates one page per listed operation at `/<directory>/<first tag>/<summary>`. Each becomes an MDX page at that path whose
 * frontmatter (`openapi:`) names the operation, with an empty body, so its URL, sidebar entry, eyebrow and previous/next links are the
 * source's. The tab is an ordinary page tab whose groups are the authored ones, nesting and order kept, with each operation replaced by
 * its page; an operation the spec does not publish (hidden, excluded or unknown) is left out, and so is a group left empty. The spec stays
 * bound in a hidden API tab, once per spec file, where the page's `openapi:` finds it and which lists nothing.
 *
 * `tabs` is the caller's own list: the tab is put in `slot` (or appended to the tab already named `tabLabel`, or created like an API tab
 * would have been), and `pages` gets the new pages. A URL that an authored page, or another operation's page, already has keeps that page.
 * Returns null, and changes nothing, when the spec has no operation to list or its tab is bound to another spec: the caller then binds the
 * spec as an API tab as it always did.
 */
export function addEndpointPages(options: {
  tabs: Array<MigrationNavigationTab>
  pages: Array<MigrationPage>
  ledger: EndpointPageLedger
  spec: {
    /** Where the spec is saved, as `openapi:` names it. */
    assetPath: string
    /** Names the hidden tab that binds the spec: where it came from. */
    source: string
    content: Buffer
    groups: ReadonlyArray<MigrationApiGroup>
    target: EndpointPagesTarget
    tabLabel?: string
    parentTab?: string
    icon?: string
    hidden?: boolean
  }
}): { operations: Array<string> } | null {
  const { tabs, pages, ledger, spec } = options
  const operations = parseOpenApiOperationsForLinking(spec.content)
  if (operations.length === 0) return null
  const existing = spec.tabLabel
    ? tabs.find((tab) => tab.tab === spec.tabLabel)
    : tabs.find((tab) => !tab.hidden && tab.tab.toLowerCase().includes('api'))
  if (existing?.api) return null
  const byKey = new Map(operations.map((operation) => [`${operation.method} ${operation.path}`, operation]))
  const listed: Array<string> = []
  const pageFor = (reference: string): string | undefined => {
    const [method, ...path] = reference.trim().split(/\s+/)
    const operation = byKey.get(`${method.toLowerCase()} ${path.join(' ')}`)
    if (!operation) return undefined
    const key = `${operation.method.toUpperCase()} ${operation.path}`
    const endpoint = mintlifyEndpointUrl(spec.target.directory, operation)
    if (!endpoint.tag || !endpoint.leaf || Buffer.byteLength(`${endpoint.tag}.mdx`) > 255 || Buffer.byteLength(`${endpoint.leaf}.mdx`) > 255) {
      if (!ledger.unnamed.includes(key)) ledger.unnamed.push(key)
      return undefined
    }
    const identity = `${spec.assetPath} ${key}`
    const owner = ledger.owners.get(endpoint.url.toLowerCase())
    if (owner && owner.operation !== null && owner.operation !== identity) {
      if (!ledger.duplicates.includes(endpoint.url)) ledger.duplicates.push(endpoint.url)
      return undefined
    }
    if (!owner) {
      pages.push({
        id: endpoint.url,
        navigationId: endpoint.url,
        title: endpoint.title,
        description: endpointDescription(operation.description, endpoint.title),
        // The summary belongs to metadata; keep full spec prose in the safe
        // operation Markdown renderer rather than copying it into executable MDX.
        descriptionPlacement: 'operation',
        keywords: [],
        body: '',
        source: 'docs.json',
        openapi: `${spec.assetPath} ${key}`,
      })
      ledger.owners.set(endpoint.url.toLowerCase(), { id: endpoint.url, operation: identity })
    }
    listed.push(key)
    return owner?.id ?? endpoint.url
  }
  const convert = (nodes: ReadonlyArray<string | MigrationApiGroup>): Array<string | MigrationNavigationGroup> =>
    nodes.flatMap<string | MigrationNavigationGroup>((node) => {
      if (typeof node === 'string') {
        const id = pageFor(node)
        return id ? [id] : []
      }
      const pagesOf = convert(node.pages)
      return pagesOf.length > 0 ? [{ group: node.group, ...(node.icon ? { icon: node.icon } : {}), pages: pagesOf }] : []
    })
  const groups = convert(spec.groups) as Array<MigrationNavigationGroup>
  if (groups.length === 0) return null
  if (existing) {
    if (existing.groups || !existing.pages) existing.groups = [...(existing.groups ?? []), ...groups]
    else existing.pages = [...existing.pages, ...groups]
  } else {
    const { slot } = spec.target
    const tab: MigrationNavigationTab = {
      ...(slot?.tab ?? { tab: spec.tabLabel ?? 'API Reference', ...(spec.icon ? { icon: spec.icon } : {}), ...(spec.hidden ? { hidden: true } : {}) }),
      groups,
    }
    if (slot) insertEndpointTab(tabs, tab, slot.preceding)
    else insertApiTab(tabs, tab, spec.parentTab)
  }
  if (!tabs.some((tab) => tab.api?.source === spec.assetPath)) {
    // The shape every hidden page-only binding has: a hidden tab lists no navigation and its spec serves no `/api/` pages, and a validator
    // that does not exempt hidden tabs from the empty-tab rule accepts an API tab unless it sets `navigation: false`.
    insertApiTab(tabs, { tab: `OpenAPI: ${spec.source}`, hidden: true, api: { source: spec.assetPath } })
  }
  return { operations: listed }
}

/**
 * The specs the renderer tries, in order, for a bare `openapi:` reference (the first is its `default`). As `getSidebarCollections` and
 * `buildApiReferenceConfig` build them: the API specs of the tabs it keeps as collections, in tab order, then those of the other hidden tabs.
 * It keeps every visible tab, and a hidden one only when its `version` is one `versions` (docs.json `navigation.versions`) declares.
 */
export function specLookupOrder(
  tabs: ReadonlyArray<Pick<MigrationNavigationTab, 'hidden' | 'api' | 'version'>>,
  versions: ReadonlyArray<{ label: string }> = [],
): Array<string> {
  const collected = (tab: Pick<MigrationNavigationTab, 'hidden' | 'version'>): boolean => !tab.hidden || Boolean(tab.version && versions.some((version) => version.label === tab.version))
  const sources = [...tabs.filter(collected), ...tabs.filter((tab) => !collected(tab))].flatMap((tab) => tab.api ? [tab.api.source] : [])
  return [...new Set(sources)]
}

/**
 * The `METHOD /path` and `webhook name` keys a page's `openapi:` can name in a spec: the operations of `paths` and `webhooks` (not
 * `x-webhooks`, which the renderer ignores) that are published. A webhook is named by its key once any of its methods is published.
 */
function publishedOperationKeys(content: Buffer): Set<string> {
  const document = readSpecDocument(content)
  const table = (field: string): Array<OpenApiOperationForLinking> => visibleOperations(document, isRecord(document) ? document[field] : undefined)
  return new Set([
    ...table('paths').map((operation) => `${operation.method} ${operation.path}`),
    ...table('webhooks').map((operation) => `webhook ${operation.path}`),
  ])
}

/**
 * Keep a bare `openapi: "METHOD /path"` reference on the spec it reached. The renderer tries the specs in `specLookupOrder` and takes the
 * first that publishes the operation. Converting a spec's tab to pages binds its spec apart, behind the visible ones, which can change which
 * spec that is. `before` is the lookup order when every spec was an API tab and `after` the order now: a bare reference whose first publishing
 * spec differs between the two is written with the `before` spec in front (`qualifier`, a path the caller's own prefix rewrite resolves, or
 * the saved spec's path), as a prefix an author wrote would be. `content` reads a spec by the source the tabs name it by.
 */
export function qualifyDisplacedBareRefs(options: {
  pages: Array<Pick<MigrationPage, 'openapi'>>
  before: ReadonlyArray<string>
  after: ReadonlyArray<string>
  content: (source: string) => Buffer | undefined
  qualifier: (source: string) => string
}): void {
  const { pages, before, after, content, qualifier } = options
  if (before.join('\n') === after.join('\n')) return
  const published = new Map<string, Set<string>>()
  const firstPublishing = (order: ReadonlyArray<string>, key: string): string | undefined => order.find((source) => {
    if (!published.has(source)) published.set(source, publishedOperationKeys(content(source) ?? Buffer.alloc(0)))
    return published.get(source)!.has(key)
  })
  for (const page of pages) {
    const ref = page.openapi ? splitOpenApiRef(page.openapi) : null
    if (!ref || ref.specRef) continue
    const [method, ...rest] = ref.operation.trim().split(/\s+/)
    const key = `${method.toLowerCase()} ${rest.join(' ')}`
    const reached = firstPublishing(before, key)
    if (reached !== undefined && reached !== firstPublishing(after, key)) page.openapi = withSpecRef(ref, qualifier(reached))
  }
}

/** Rewrite API operation links in every page body, with one capped warning for links that matched no operation. */
export function rewriteApiLinksInPages(
  pages: Array<MigrationPage>,
  operationLinks: Map<string, string>,
  prefixLandings: Map<string, string>,
  warnings: Array<MigrationWarning>,
  /**
   * What answers an address other than these maps. `mounts`: directories of
   * mounts they do not cover; a link under one deeper than the mount it would
   * map to is left for that mount's own pass. `redirects`: an address one of
   * them redirects is answered by it.
   */
  answered: { mounts?: ReadonlyArray<string>; redirects?: ReadonlyArray<{ source: string }> } = {},
): void {
  if (operationLinks.size === 0 && prefixLandings.size === 0) return
  const unmatched = new Set<string>()
  const served = servedRoutes(pages)
  for (const { source } of answered.redirects ?? []) {
    const route = literalRoute(source)
    if (route) served.add(route)
  }
  const others = (answered.mounts ?? []).map(mountPrefix).filter(Boolean)
  for (const page of pages) {
    page.body = rewriteApiOperationLinks(page.body, operationLinks, prefixLandings, served, unmatched, others)
  }
  if (unmatched.size === 0) return
  const sorted = [...unmatched].sort()
  warnings.push({
    code: 'unsupported-config',
    message: `${sorted.length} link(s) to API endpoints matched no endpoint in the OpenAPI spec, so they now point to the API section's overview page instead: `
      + `${sorted.slice(0, 10).join(', ')}${sorted.length > 10 ? `, and ${sorted.length - 10} more` : ''}. Update those links if you want them to reach a specific endpoint.`,
  })
}

/**
 * Rewrite in-content links matching a source platform's auto-generated
 * OpenAPI operation pages to Thally's actual `/api/...` routes. A link
 * that is exactly a known API-section prefix (a bare tab-landing link, e.g.
 * "/api-reference") is rewritten to that spec's Thally landing route. A
 * link under a known prefix that doesn't match any specific operation
 * (renamed/removed operation, or a match this rewrite's heuristics missed)
 * falls back to the same landing route rather than staying broken, and its
 * original target is recorded into `unmatched` so the caller can emit one
 * aggregated warning instead of one per link. Links outside every known
 * prefix are left untouched — still broken, but no worse than before this
 * rewrite existed. A link to an address the site answers itself (an authored
 * guide inside an API directory, say, or a redirect from an old URL) is never
 * rewritten: that page or redirect still serves the address.
 */
function rewriteApiOperationLinks(
  body: string,
  linkMap: Map<string, string>,
  prefixLandings: Map<string, string>,
  served: ReadonlySet<string>,
  unmatched: Set<string>,
  otherMounts: ReadonlyArray<string>,
): string {
  if (linkMap.size === 0 && prefixLandings.size === 0) return body
  // Longest prefix first, so a more specific API section (e.g.
  // "api-reference/webhooks") is preferred over a shorter one that happens
  // to also match ("api-reference").
  const orderedPrefixes = [...prefixLandings.entries()].sort((a, b) => b[0].length - a[0].length)
  let codeFence: string | null = null
  return body.split('\n').map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (!codeFence) codeFence = fence[1][0]
      else if (fence[1][0] === codeFence) codeFence = null
      return line
    }
    if (codeFence) return line
    const rewriteTarget = (target: string): string => {
      const suffixIndex = target.search(/[?#]/)
      const literal = suffixIndex >= 0 ? target.slice(0, suffixIndex) : target
      if (served.has(literalRoute(literal) ?? literal)) return target
      // A trailing slash names the same address, as `literalRoute` reads it above and the endpoint maps are keyed.
      const path = literal.replace(/^\/+|\/+$/g, '').toLowerCase()
      const suffix = suffixIndex >= 0 ? target.slice(suffixIndex) : ''
      // The most specific mount the link lies under owns it: another pass handles it when that mount is not one of these.
      const owner = [...prefixLandings.keys(), ...otherMounts]
        .filter((mount) => path === mount || path.startsWith(`${mount}/`))
        .reduce<string | null>((longest, mount) => (longest === null || mount.length > longest.length ? mount : longest), null)
      if (owner !== null && !prefixLandings.has(owner)) return target
      const mapped = linkMap.get(path)
      if (mapped) return `${mapped}${suffix}`
      for (const [prefix, landing] of orderedPrefixes) {
        if (path === prefix) return `${landing}${suffix}`
        if (path.startsWith(`${prefix}/`)) {
          unmatched.add(target)
          return `${landing}${suffix}`
        }
      }
      return target
    }
    return line
      .replace(/(\]\()\/([^\s)]+)(?=[\s)]|$)/g, (_match, prefix: string, target: string) => `${prefix}${rewriteTarget(`/${target}`)}`)
      .replace(/(\bhref=")\/([^"]+)(")/g, (_match, prefix: string, target: string, suffix: string) => `${prefix}${rewriteTarget(`/${target}`)}${suffix}`)
  }).join('\n')
}

const MAX_FERN_GENERATORS_BYTES = 2_000_000

function fernGeneratorsOpenApiPaths(config: Record<string, unknown>): Array<string> {
  const api = config.api
  if (typeof api === 'string') return [api]
  if (!api || typeof api !== 'object' || Array.isArray(api)) return []
  const specs = (api as Record<string, unknown>).specs
  if (!Array.isArray(specs)) return []
  return specs.flatMap((spec) => {
    if (typeof spec === 'string') return [spec]
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return []
    const openapi = (spec as Record<string, unknown>).openapi
    return typeof openapi === 'string' ? [openapi] : []
  })
}

/**
 * Fern's `generators.yml` can also point an `api.specs[]` entry at an
 * AsyncAPI or OpenRPC document instead of OpenAPI. Thally's API reference
 * only renders OpenAPI, so these are named here purely to produce a
 * specific warning (`fernGeneratorsOpenApiPaths` above never returns them,
 * so without this they'd otherwise look like a missing spec).
 */
function fernGeneratorsUnsupportedSpecPaths(config: Record<string, unknown>): Array<{ kind: 'asyncapi' | 'openrpc'; path: string }> {
  const api = config.api
  if (!api || typeof api !== 'object' || Array.isArray(api)) return []
  const specs = (api as Record<string, unknown>).specs
  if (!Array.isArray(specs)) return []
  return specs.flatMap((spec): Array<{ kind: 'asyncapi' | 'openrpc'; path: string }> => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return []
    const record = spec as Record<string, unknown>
    if (typeof record.asyncapi === 'string') return [{ kind: 'asyncapi', path: record.asyncapi }]
    if (typeof record.openrpc === 'string') return [{ kind: 'openrpc', path: record.openrpc }]
    return []
  })
}

function readFernGeneratorsConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_FERN_GENERATORS_BYTES) return null
  const parsed = parseYaml(readFileSync(path, 'utf8'))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}

/**
 * Resolve the OpenAPI spec Fern's `generators.yml` configures for an API:
 * modern `api.specs[].openapi`, or the legacy top-level `api:` string.
 * Multi-API repos keep a `generators.yml` per API under `fern/apis/<name>/`;
 * single-API repos keep one at the Fern project root.
 *
 * The root `generators.yml` belongs to a *different* API only in a multi-API
 * repo, which Fern lays out under `fern/apis/`. So the root config is skipped
 * only when an explicit `api-name` is set AND a `fern/apis/` directory
 * exists; a single-API repo whose docs.yml still names its API keeps its tab.
 */
function fernOpenApiCandidateDirs(fernRoot: string, apiName: string | undefined, apiNameExplicit: boolean): Array<string> {
  const candidateDirs: Array<string> = []
  if (apiName) {
    try {
      candidateDirs.push(resolveWithin(fernRoot, `apis/${apiName}`))
    } catch {
      // Not a safe relative path (e.g. a display label, not a folder name).
    }
  }
  const apisDir = resolvePath(fernRoot, 'apis')
  const multiApi = existsSync(apisDir) && lstatSync(apisDir).isDirectory()
  if (!apiNameExplicit || !multiApi) candidateDirs.push(fernRoot)
  return candidateDirs
}

/** `findFernConfiguredOpenApi`'s result, plus any AsyncAPI/OpenRPC specs seen along the way (Thally has no renderer for either). */
interface FernOpenApiResolution {
  spec: ScannedFile | null
  unsupported: Array<{ kind: 'asyncapi' | 'openrpc'; path: string }>
}

function findFernConfiguredOpenApi(
  fernRoot: string,
  repositoryDir: string,
  apiName: string | undefined,
  apiNameExplicit: boolean,
  warnings: Array<MigrationWarning>,
): FernOpenApiResolution {
  const candidateDirs = fernOpenApiCandidateDirs(fernRoot, apiName, apiNameExplicit)
  const unsupported: Array<{ kind: 'asyncapi' | 'openrpc'; path: string }> = []
  for (const dir of candidateDirs) {
    let config: Record<string, unknown> | null = null
    let generatorsPath: string
    try {
      generatorsPath = resolveWithin(dir, 'generators.yml')
      config = readFernGeneratorsConfig(generatorsPath)
    } catch {
      continue
    }
    if (!config) continue
    for (const specPath of fernGeneratorsOpenApiPaths(config)) {
      if (/^(?:https?:)?\/\//i.test(specPath)) continue
      // `openapi:` in generators.yml is conventionally relative to that
      // file's own directory (a multi-API repo's `fern/apis/<name>/`), not
      // to the Fern root, so it commonly points outside `dir` (e.g. Cohere's
      // `../../../cohere-openapi.yaml`). The security boundary is still the
      // whole repository checkout, never anything above it.
      try {
        const absolute = withinRealRoot(resolveWithinRoot(dir, specPath, repositoryDir), repositoryDir)
        if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue
        const kind = classifyApiSpec(absolute)
        if (kind === 'asyncapi') {
          unsupported.push({ kind: 'asyncapi', path: specPath })
          continue
        }
        if (kind !== 'openapi') continue
        return { spec: { absolutePath: absolute, relativePath: relative(repositoryDir, absolute).replace(/\\/g, '/') }, unsupported }
      } catch {
        warnings.push({
          code: 'unsupported-config',
          message: `Skipped the OpenAPI spec "${specPath}" listed in ${relative(repositoryDir, generatorsPath).replace(/\\/g, '/')} because it points outside the repository (symlink or ..).`,
        })
      }
    }
    unsupported.push(...fernGeneratorsUnsupportedSpecPaths(config))
  }
  return { spec: null, unsupported }
}

/** Whether a Fern Definition (as opposed to a plain OpenAPI/AsyncAPI spec) backs this API. */
function fernDefinitionExists(fernRoot: string, apiName: string | undefined): boolean {
  const candidateDirs: Array<string> = []
  if (apiName) {
    try {
      candidateDirs.push(resolveWithin(fernRoot, `apis/${apiName}/definition`))
    } catch {
      // Not a safe relative path; skip.
    }
  }
  try {
    candidateDirs.push(resolveWithin(fernRoot, 'definition'))
  } catch {
    // Unreachable: 'definition' is always a safe relative segment.
  }
  return candidateDirs.some((dir) => existsSync(dir) && lstatSync(dir).isDirectory())
}

/** Leading frontmatter of a file without loading all of it; undefined when it is not closed within the window. */
function readFrontmatterHead(path: string): string | undefined {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(FRONTMATTER_HEAD_BYTES)
    const head = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0))
    const opening = /^\uFEFF?---([^\r\n]*)\r?\n/.exec(head)
    if (!opening || opening[1].startsWith('-')) return head
    return /^---[ \t]*\r?\n/m.test(head.slice(opening[0].length)) ? head : undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * Why a file must never be spliced into another page (Mintlify only):
 * `gated` is an access-restricted page, `snippet-gated` a snippet that declares
 * access rules Mintlify does not enforce on snippets, `oversized` and
 * `unreadable` are files that cannot be classified safely.
 */
interface InlineVerdict { kind: 'gated' | 'draft' | 'snippet-gated' | 'oversized' | 'unreadable'; reason: string }
type InlineGate = (candidate: string) => InlineVerdict | undefined

/**
 * How one Mintlify page migrates. `reason` marks restricted content: it is
 * never inlined into another page, and the assets and API operations only it
 * uses stay off public surfaces (public/ and the spec are not access
 * controlled). `quarantineReason` additionally keeps the page out of the
 * content directory, because its rules cannot be carried over safely.
 */
interface PageGate {
  reason?: string
  quarantineReason?: string
  /** Normalized access frontmatter written on the migrated page. */
  access?: ResolvedPageAccess
  openapi?: string
}

/** Why a page's own frontmatter restricts it (for inline warnings). */
function ownRestrictionReason(access: MintlifyAccess): string {
  return access.problem ?? (access.groups?.length ? 'frontmatter `groups`' : 'frontmatter `public: false`')
}

/** The real on-disk spelling of a path, so a case-variant import cannot dodge a path lookup on a case-insensitive filesystem. */
function canonicalPath(path: string): string {
  try { return realpathSync.native(path) } catch { return path }
}

/**
 * A page's own access rules from its raw (or frontmatter-head) text. Invalid
 * YAML is salvaged line by line, which can drop or misread the very line that
 * restricts access, so it fails closed rather than guesses. Key casing
 * (`Groups:`) and TOML frontmatter are deliberately not read: Mintlify ignores
 * them too.
 */
function pageHeadAccess(raw: string): { access: MintlifyAccess; openapi?: string } {
  const parsed = parseFrontmatter(raw)
  const unreadable = parsed.error && /^(groups|public)\s*:/m.test(raw.slice(0, raw.length - parsed.content.length))
  const openapi = typeof parsed.data.openapi === 'string' ? parsed.data.openapi.trim() : undefined
  const access = unreadable
    ? { problem: 'frontmatter could not be parsed and declares `groups` or `public`' }
    : frontmatterAccess(parsed.data)
  return { access, openapi }
}

/** Short description of why a migrated page is restricted, for warnings. */
function describeRestriction(access: ResolvedPageAccess): string {
  return access.groups?.length ? `restricted to groups ${access.groups.join(', ')}` : '`public: false`'
}

/**
 * Fern and Docusaurus pages the runtime cannot gate: Thally has no mapping for
 * Docusaurus `draft` or Fern `viewers` / `authed`, so these quarantine (fail closed).
 */
function pageHeadGateReason(raw: string, platform: MigrationPlatform): { reason?: string; openapi?: string } {
  const parsed = parseFrontmatter(raw)
  const gateKeys = platform === 'docusaurus' ? /^draft\s*:/m : /^(viewers|authed)\s*:/m
  const unreadable = parsed.error && gateKeys.test(raw.slice(0, raw.length - parsed.content.length))
    ? 'frontmatter could not be parsed and declares an access or draft setting'
    : undefined
  const openapi = typeof parsed.data.openapi === 'string' ? parsed.data.openapi.trim() : undefined
  const reason = platform === 'docusaurus' ? docusaurusDraftReason(parsed.data) : fernViewersReason(parsed.data)
  return { reason: reason ?? unreadable, openapi }
}

/** Docusaurus leaves `draft: true` pages out of production builds. Anything but an explicit false is withheld. */
const DOCUSAURUS_DRAFT_REASON = 'frontmatter `draft` marks it as a draft Docusaurus does not publish'

function docusaurusDraftReason(data: Record<string, unknown>): string | undefined {
  const draft = data.draft
  if (draft === undefined || draft === false || (typeof draft === 'string' && draft.trim().toLowerCase() === 'false')) return undefined
  return DOCUSAURUS_DRAFT_REASON
}

/** Blank out fenced code blocks (a backtick fence's info string cannot contain a backtick, as in CommonMark). */
function withoutFencedCode(raw: string): string {
  let fence: { char: string; length: number } | null = null
  return raw.split('\n').map((line) => {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null
      return ''
    }
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r]*)$/.exec(line)
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { char: opening[1][0], length: opening[1].length }
      return ''
    }
    return line
  }).join('\n')
}

/**
 * `<If roles=...>` (or `viewers`) in a Fern page body, outside code: content Fern
 * shows only to some roles. Each tag is scanned to its real end (quotes and
 * braces respected); a tag that never closes is judged by what was scanned.
 */
export function fernIfRolesReason(raw: string): string | undefined {
  const text = withoutFencedCode(raw).replace(/(`{1,3})[^`\n]*\1/g, '')
  const marker = /<If(?![\w$.-])/g
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    const tag = scanJsxOpeningTag(text, match.index, 'If')
    marker.lastIndex = tag.next
    // Comments may precede a JSX spread; unresolved ellipses fail closed.
    if (tag.attributes.includes('...')) {
      return 'it contains `<If>` spread props whose access rules cannot be resolved safely'
    }
    // ponytail: the lexical scan cannot prove regex/template boundaries; use an expression parser before allowing these props.
    if (tag.attributes.includes('{') && /[/`]/.test(tag.attributes)) {
      return 'it contains `<If>` expression props whose access rules cannot be resolved safely'
    }
    if (/(?:^|[\s{}"'])(?:roles|viewers)\s*=/.test(tag.attributes)) {
      return 'it contains `<If roles>` content that Fern shows only to some roles'
    }
  }
  return undefined
}

/** Fern role-based access: frontmatter `viewers` (any non-empty value) or a truthy `authed`. */
function fernViewersReason(data: Record<string, unknown>): string | undefined {
  const viewers = data.viewers
  const hasViewers = Array.isArray(viewers) ? viewers.length > 0
    : typeof viewers === 'string' ? viewers.trim() !== ''
      : viewers !== undefined && viewers !== null && viewers !== false
  if (hasViewers) return 'frontmatter `viewers` restricts it to signed-in roles'
  const authed = data.authed
  if (authed !== undefined && authed !== null && authed !== false && !(typeof authed === 'string' && ['', 'false'].includes(authed.trim().toLowerCase()))) {
    return 'frontmatter `authed` requires sign-in'
  }
  return undefined
}

function withoutFrontmatter(value: string): string {
  return value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

function staticSnippetProperties(attributes: string): Map<string, string> {
  const properties = new Map<string, string>()
  let tree: ts.SourceFile
  try {
    tree = ts.createSourceFile('snippet.tsx', `const snippet = <Snippet ${attributes.replace(/\/\s*$/, '')} />`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  } catch { return properties }
  const statement = tree.statements[0]
  if (!statement || !ts.isVariableStatement(statement)) return properties
  const element = statement.declarationList.declarations[0]?.initializer
  if (!element || !ts.isJsxSelfClosingElement(element)) return properties
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) continue
    const value = attribute.initializer
    if (value && ts.isStringLiteral(value)) properties.set(attribute.name.text, value.text)
    else if (value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) {
      properties.set(attribute.name.text, value.expression.text)
    }
  }
  return properties
}

function interpolateSnippet(snippet: string, attributes: string, children?: string): string {
  const properties = staticSnippetProperties(attributes)
  if (children !== undefined) properties.set('children', children.trim())
  if (properties.size === 0) return snippet
  snippet = bindSnippetProps(snippet, properties)
  const isJsxSnippet = /<[A-Za-z][A-Za-z0-9]*/.test(snippet)
  let fence = ''
  return snippet.split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = ''
      return line
    }
    if (fence) return line
    return line.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (original, name: string) => {
      const value = properties.get(name)
      // Preserve MDX expression syntax: a literal replacement inside JSX
      // would turn `<a href={url}>` into invalid `href=https://...`.
      if (value === undefined) return original
      if (name === 'children') return value
      return isJsxSnippet ? `{${JSON.stringify(value)}}` : value
    })
  }).join('\n')
}

/**
 * A fence only opens or closes on a line of its own, so an inlined snippet that
 * starts or ends with one must not share its line with text around the tag.
 */
function isolateFences(snippet: string, source: string, start: number, end: number): string {
  const fence = /^\s*(?:`{3,}|~{3,})/
  const lines = snippet.split('\n')
  const before = source.slice(source.lastIndexOf('\n', start - 1) + 1, start)
  const after = source.slice(end, source.indexOf('\n', end) < 0 ? undefined : source.indexOf('\n', end))
  return `${fence.test(lines[0]) && /\S/.test(before) ? '\n' : ''}${snippet}${fence.test(lines[lines.length - 1]) && /\S/.test(after) ? '\n' : ''}`
}

/** Extract JSX from a statically declared snippet component before inlining it. */
function snippetComponentBody(source: string, componentName: string): string {
  const parsed = ts.createSourceFile('snippet.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== componentName) continue
      const initializer = declaration.initializer
      if (!initializer || !ts.isArrowFunction(initializer)) continue
      const returned = ts.isBlock(initializer.body)
        ? initializer.body.statements.find(ts.isReturnStatement)?.expression
        : initializer.body
      if (!returned) continue
      let expression: ts.Expression = returned
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression
      if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression) || ts.isJsxFragment(expression)) {
        return expression.getText(parsed)
      }
    }
  }
  return source
}

/** Keep a stateful snippet intact so its hooks and local values move with its JSX. */
function statefulSnippetDeclaration(source: string, componentName: string): string | null {
  const parsed = ts.createSourceFile('snippet.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  // A snippet may declare helpers next to the component (a sibling component
  // it renders); the whole file travels so those stay declared on the page,
  // where the component migrator moves what the component needs. Anything
  // that is not plain ESM is prose, which cannot be preserved as a declaration.
  const isEsm = (statement: ts.Statement): boolean => ts.isImportDeclaration(statement)
    || (ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && !!ts.getModifiers(statement as ts.HasModifiers)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  if (parsed.statements.length === 0 || !parsed.statements.every(isEsm)) return null
  const statement = parsed.statements.find((candidate) => ts.isVariableStatement(candidate)
    && candidate.declarationList.declarations.length === 1
    && ts.isIdentifier(candidate.declarationList.declarations[0].name)
    && candidate.declarationList.declarations[0].name.text === componentName)
  if (!statement || !ts.isVariableStatement(statement)) return null
  const declaration = statement.declarationList.declarations[0]
  if (!declaration.initializer || !ts.isArrowFunction(declaration.initializer)
    || !ts.isBlock(declaration.initializer.body)) return null
  const body = declaration.initializer.body.statements
  // A component with setup statements before its return cannot be flattened
  // to its returned JSX: that strands hooks, computed values, and handlers.
  if (body.length < 2 || !body.some(ts.isReturnStatement)) return null
  return source.trim()
}

/** True for primitives and object/array literals built only from primitives (no calls, spreads, identifiers or computed keys). */
function isStaticLiteral(expression: ts.Expression): boolean {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isNumericLiteral(expression)) return true
  if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.every(isStaticLiteral)
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.every((property) => (
      ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && isStaticLiteral(property.initializer)
    ))
  }
  return false
}

/** Names a snippet exports, from its parsed source: declarations and `export { a as b }` lists. */
function snippetExportedNames(source: string): Set<string> {
  const names = new Set<string>()
  const addBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text)
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) addBinding(element.name)
  }
  const parsed = ts.createSourceFile('snippet.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text)
      }
      continue
    }
    const modifiers = ts.getModifiers(statement as ts.HasModifiers)
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    // `export default function Foo` binds the default export, not a named `Foo`.
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) addBinding(declaration.name)
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text)
  }
  return names
}

/** Read only static named exports (primitives, plain object/array literals); source MDX is parsed, never executed. */
function staticNamedSnippetValues(source: string): Map<string, string> {
  const values = new Map<string, string>()
  const parsed = ts.createSourceFile('snippet.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const expression = declaration.initializer
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        values.set(declaration.name.text, JSON.stringify(expression.text))
      } else if (ts.isNumericLiteral(expression)) {
        values.set(declaration.name.text, expression.text)
      } else if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
        values.set(declaration.name.text, expression.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false')
      } else if (/^[a-z_$]/.test(declaration.name.text) && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) && isSelfContainedFunction(expression)) {
        values.set(declaration.name.text, expression.getText(parsed))
      } else if ((ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) && isStaticLiteral(expression)) {
        values.set(declaration.name.text, expression.getText(parsed))
      }
    }
  }
  return values
}

/** MDX imports from nested Markdown partials must live at page scope. */
function hoistMdxImports(source: string): string {
  const imports = new Set<string>()
  const withoutImports = replaceOutsideCode(source, (body) => body.replace(
    /^[ \t]*import\s+(?:\{[^}\n]+\}|[A-Za-z_$][\w$]*)\s+from\s+(['"])[^'"\n]+\1[ \t]*;?/gm,
    (statement: string) => {
      imports.add(statement.trim().replace(/;?$/, ';'))
      return ''
    },
  ))
  if (imports.size === 0) return source
  const frontmatter = withoutImports.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  const prefix = frontmatter?.[0] ?? ''
  return `${prefix}${[...imports].join('\n')}\n\n${withoutImports.slice(prefix.length).replace(/^(?:\r?\n)*/, '')}`
}

/** Fern can publish a repository beneath a domain path such as `/skills`. */
function fernSourceBasePath(config: Record<string, unknown>): string {
  const instance = Array.isArray(config.instances) ? config.instances[0] : null
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return ''
  const value = instance as Record<string, unknown>
  const address = typeof value['custom-domain'] === 'string' ? value['custom-domain'] : value.url
  if (typeof address !== 'string') return ''
  try {
    const path = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`).pathname.replace(/\/+$/, '')
    return path === '/' ? '' : path
  } catch {
    return ''
  }
}

/** The imported Fern version's URL prefix is omitted from Thally's routes. */
function fernDefaultVersionPath(config: Record<string, unknown>): string {
  if (!Array.isArray(config.versions)) return ''
  const versions = config.versions.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
  const chosen = versions.find((version) => version.default === true) ?? versions[0]
  return typeof chosen?.slug === 'string' && /^[A-Za-z0-9_-]+$/.test(chosen.slug) ? `/${chosen.slug}` : ''
}

/** Preserve the published Fern host for references outside the imported pages. */
function fernSourceSiteUrl(config: Record<string, unknown>): string | undefined {
  const instance = Array.isArray(config.instances) ? config.instances[0] : null
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return undefined
  const value = instance as Record<string, unknown>
  const address = typeof value['custom-domain'] === 'string' ? value['custom-domain'] : value.url
  if (typeof address !== 'string') return undefined
  try {
    const url = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`)
    return `${url.origin}${fernSourceBasePath(config)}${fernDefaultVersionPath(config)}`
  } catch {
    return undefined
  }
}

/** Keep unresolved root-relative links usable on the source site, with an explicit warning. */
function externalizeMissingFernLinks(body: string, pageIds: ReadonlySet<string>, sourceSiteUrl: string, externalized: Set<string>): string {
  const rewrite = (target: string): string => {
    const path = target.split(/[?#]/, 1)[0].replace(/^\//, '').replace(/\/$/, '')
    // Only unresolved page routes belong on the source site. Fern pages may
    // reference copied public assets with root-relative Markdown links; an
    // image or download is not a missing docs page.
    if (!path || pageIds.has(path) || ASSET_EXTENSIONS.has(extname(path).toLowerCase())) return target
    try {
      const base = new URL(`${sourceSiteUrl}/`)
      const sourceLinkUrl = new URL(target.slice(1), base)
      if (sourceLinkUrl.origin !== base.origin) return target
      const sourceLink = sourceLinkUrl.toString()
      externalized.add(target)
      return sourceLink
    } catch {
      return target
    }
  }
  return replaceOutsideCode(body, (text) => text
    .replace(/(\]\()\/(?!\/)([^\s)]+)(\))/g, (_match, before: string, target: string, after: string) => `${before}${rewrite(`/${target}`)}${after}`)
    .replace(/(\b(?:href|to)=(['"]))\/(?!\/)([^'"\n]+)\2/g, (_match, before: string, quote: string, target: string) => `${before}${rewrite(`/${target}`)}${quote}`))
}

/** Rewrite only root-relative Markdown/JSX links, never URLs or code examples. */
function stripFernBasePathFromLinks(body: string, basePath: string): string {
  if (!basePath) return body
  const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return replaceOutsideCode(body, (text) => text
    .replace(new RegExp(`(\\]\\()${escaped}(?=\\/|[)#?])`, 'g'), (match, prefix: string, offset: number, source: string) => (
      prefix + (source[offset + match.length] === '/' ? '' : '/')
    ))
    .replace(new RegExp(`(\\b(?:href|to)=["'])${escaped}(?=\\/|["'#?])`, 'g'), (match, prefix: string, offset: number, source: string) => (
      prefix + (source[offset + match.length] === '/' ? '' : '/')
    )))
}

/** Remove a published Mintlify mount path only when its destination is an imported page. */
function rewriteMintlifyMountedLinks(body: string, pageIds: ReadonlySet<string>): string {
  const rewrite = (target: string): string => {
    const suffixAt = target.search(/[?#]/)
    const pathname = suffixAt < 0 ? target : target.slice(0, suffixAt)
    const suffix = suffixAt < 0 ? '' : target.slice(suffixAt)
    if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')) return target
    const segments = pathname.slice(1).split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return target
    const markdown = pathname.endsWith('.md')
    const sourceMdx = pathname.endsWith('.mdx')
    const routeSegments = markdown || sourceMdx ? [...segments.slice(0, -1), segments.at(-1)!.replace(/\.mdx?$/, '')] : segments
    // MDX filenames name source documents, whereas .md explicitly requests
    // the runtime's machine-readable mirror. Preserve that distinction.
    if (pageIds.has(routeSegments.join('/'))) return sourceMdx ? `/${routeSegments.join('/')}${suffix}` : target
    // A source site may serve its docs below /docs or another mount. Limit
    // removal to a leading path prefix and prove the remaining route exists;
    // this leaves real /docs pages and non-page assets untouched.
    for (let count = 1; count < segments.length && count <= 3; count++) {
      const candidate = routeSegments.slice(count).join('/')
      if (pageIds.has(candidate)) return `/${candidate}${markdown ? '.md' : ''}${suffix}`
    }
    return target
  }
  return replaceOutsideCode(body, (text) => text
    .replace(/(\]\()(\/[^\s)]+)(\))/g, (_match, before: string, target: string, after: string) => `${before}${rewrite(target)}${after}`)
    .replace(/(\b(?:href|to)=(['"]))(\/[^'"\n]+)\2/g, (_match, before: string, quote: string, target: string) => `${before}${rewrite(target)}${quote}`))
}

/** Preserve source fragments that resolve to a unique heading or table row. */
function preserveLinkedAnchors(pages: Array<MigrationPage>): void {
  const pageById = new Map(pages.map((page) => [page.id, page]))
  const requested = new Map<string, Set<string>>()
  const crossPageRequests = new Set<string>()
  const addTarget = (target: string, currentId: string): void => {
    const hash = target.indexOf('#')
    if (hash < 0) return
    let fragment: string
    try { fragment = decodeURIComponent(target.slice(hash + 1)) } catch { return }
    // Only HTML-attribute-safe fragments can become explicit IDs. Encoded
    // fragments are common in exported docs, including names with `$`.
    if (!/^[\p{L}\p{N}_.:$-]{1,120}$/u.test(fragment)) return
    const path = target.slice(0, hash).split('?')[0]
    const id = target.startsWith('#') ? currentId : path.startsWith('/') && !path.startsWith('//')
      ? path.replace(/^\//, '').replace(/\/$/, '') || 'introduction' : ''
    if (!pageById.has(id)) return
    if (!requested.has(id)) requested.set(id, new Set())
    requested.get(id)!.add(fragment)
    if (id !== currentId) crossPageRequests.add(`${id}#${fragment}`)
  }
  for (const page of pages) {
    replaceOutsideCode(page.body, (text) => {
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) addTarget(match[1], page.id)
      for (const match of text.matchAll(/\b(?:href|to)=(['"])([^'"\n]+)\1/g)) addTarget(match[2], page.id)
      return text
    })
  }
  const comparable = (value: string): string => value
    .replace(/&(?:lt|gt|amp|quot);/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
  for (const page of pages) {
    const fragments = requested.get(page.id)
    if (!fragments?.size) continue
    const definitions = new Map<string, string>()
    replaceOutsideCodeAndComments(page.body, (text) => {
      for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:[^\n]*$/gm)) {
        const label = match[1].trim().replace(/\s+/g, ' ').toLowerCase()
        if (!definitions.has(label)) definitions.set(label, match[0])
      }
      return text
    })
    const lines = page.body.split('\n')
    let fence: string | undefined
    const tableCells: Array<{ index: number; text: string }> = []
    const headings = lines.map((line, index) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
      if (marker) {
        if (!fence) fence = marker[1]
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
          && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined
        return null
      }
      if (fence) return null
      const tableCell = line.match(/^ {0,3}\|\s*([^|]+?)\s*\|/)
      if (tableCell && !/^[:\s-]+$/.test(tableCell[1])) tableCells.push({ index, text: tableCell[1] })
      const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
      return match ? { index, text: mdxVisibleText(match[1].replace(/\s*\{\/\*\s*#\S+?\s*\*\/\}$/, ''), definitions) } : null
    }).filter((entry): entry is { index: number; text: string } => entry !== null)
    const existing = new Set<string>()
    replaceOutsideCode(page.body, (text) => {
      for (const match of text.matchAll(/\bid=(?:"([^"]+)"|'([^']+)')/g)) existing.add(match[1] ?? match[2])
      for (const match of text.matchAll(/\{\/\*\s*#(\S+?)\s*\*\/\}/g)) existing.add(match[1])
      return text
    })
    const candidateIndexes = new Map<string, Array<{ index: number; kind: 'heading' | 'table' }>>()
    for (const heading of headings) {
      const key = comparable(heading.text)
      candidateIndexes.set(key, [...(candidateIndexes.get(key) ?? []), { index: heading.index, kind: 'heading' }])
    }
    for (const cell of tableCells) {
      const key = comparable(cell.text)
      candidateIndexes.set(key, [...(candidateIndexes.get(key) ?? []), { index: cell.index, kind: 'table' }])
    }
    const headingSlugs = new Map<string, number>()
    const slugCounts = new Map<string, number>()
    for (const heading of headings) {
      const slug = heading.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      existing.add(slug)
      const seen = slugCounts.get(slug) ?? 0
      slugCounts.set(slug, seen + 1)
      if (slug) headingSlugs.set(seen === 0 ? slug : `${slug}-${seen}`, heading.index)
    }
    const headingAliases = new Map<number, Array<string>>()
    const tableAliases = new Map<number, Array<string>>()
    for (const fragment of fragments) {
      if (existing.has(fragment)) continue
      const matches = candidateIndexes.get(comparable(fragment)) ?? []
      let match = matches.length === 1 ? matches[0] : undefined
      if (!match && matches.length > 1 && !crossPageRequests.has(`${page.id}#${fragment}`)) {
        // Repeated option names can occur in several tables. A same-page
        // reference after one of them refers to the nearest preceding option;
        // only add an alias when every real local link agrees on that row.
        const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const linkPattern = new RegExp(`\\]\\(#${escaped}\\)|\\b(?:href|to)=["']#${escaped}["']`)
        const linkIndexes = lines.flatMap((line, index) => linkPattern.test(line) ? [index] : [])
        const selections = linkIndexes.map((index) => matches.filter((candidate) => candidate.index < index).at(-1))
        if (selections.length && selections.every((candidate) => candidate?.index === selections[0]?.index)) match = selections[0]
      }
      // A fragment names a heading in the source site; option tables that
      // repeat the same word are only extra candidates. When exactly one
      // heading matches, that heading is the target.
      if (!match && matches.length > 1) {
        const headingMatches = matches.filter((candidate) => candidate.kind === 'heading')
        if (headingMatches.length === 1) match = headingMatches[0]
      }
      // Repeated headings get numbered ids (`options`, `options-1`, ...). A
      // fragment that differs from one of those only by letter case names
      // that specific heading.
      if (!match) {
        const index = headingSlugs.get(fragment.toLowerCase())
        if (index !== undefined) match = { index, kind: 'heading' }
      }
      if (!match) continue
      const { index, kind } = match
      const aliases = kind === 'heading' ? headingAliases : tableAliases
      aliases.set(index, [...(aliases.get(index) ?? []), fragment])
      existing.add(fragment)
    }
    if (headingAliases.size || tableAliases.size) page.body = lines.flatMap((line, index) => [
      ...(headingAliases.get(index) ?? []).map((fragment) => `<a id="${fragment}"></a>`),
      tableAliases.has(index)
        ? line.replace(/^( {0,3}\|\s*)/, (prefix) => `${prefix}${tableAliases.get(index)!.map((fragment) => `<a id="${fragment}"></a>`).join('')}`)
        : line,
    ]).join('\n')
  }
}

/** Prevent an entry's EOF-terminated fence from swallowing the next feed entry. */
function closeOpenCodeFence(body: string): string {
  let open: { marker: string; length: number } | null = null
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!match) continue
    const marker = match[1][0]
    if (!open) {
      open = { marker, length: match[1].length }
    } else if (marker === open.marker && match[1].length >= open.length && !match[2].trim()) {
      open = null
    }
  }
  return open ? `${body}\n\n${open.marker.repeat(open.length)}` : body
}

/** Fern changelog fragments prefix each article heading with its date. */
function addDatedHeadingAliases(body: string, date: string): string {
  let open: { marker: string; length: number } | null = null
  const existingIds = new Set([...body.matchAll(/<a\s+id=["']([^"']+)["']/g)].map((match) => match[1]))
  return body.split(/\r?\n/).flatMap((line) => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const marker = fence[1][0]
      if (!open) open = { marker, length: fence[1].length }
      else if (marker === open.marker && fence[1].length >= open.length && !fence[2].trim()) open = null
      return [line]
    }
    if (open) return [line]
    const heading = line.match(/^#{2,6}\s+(.+?)\s*#*\s*$/)
    if (!heading) return [line]
    const slug = heading[1]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_]/g, '')
      .normalize('NFKD').toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim().replace(/\s+/g, '-')
    const id = `${date}-${slug}`
    if (!slug || existingIds.has(id)) return [line]
    existingIds.add(id)
    return [`<a id="${id}" />`, '', line]
  }).join('\n')
}

function resolveSnippetPath(
  sourcePath: string,
  currentFile: string,
  repositoryRoot: string,
  siteRoot: string,
): string {
  // Markdown authors sometimes escape a leading underscore in an import
  // path; the repository filename itself is still unescaped.
  sourcePath = sourcePath.replace(/\\(?=_)/g, '')
  const repositoryRelative = sourcePath.startsWith('@site/')
    ? relative(repositoryRoot, resolveWithin(siteRoot, sourcePath.slice('@site/'.length))).replace(/\\/g, '/')
    : sourcePath.startsWith('/')
      ? relative(repositoryRoot, resolveWithin(siteRoot, sourcePath.replace(/^\/+/, ''))).replace(/\\/g, '/')
      : relative(repositoryRoot, resolvePath(dirname(currentFile), sourcePath)).replace(/\\/g, '/')
  const candidate = resolveWithin(repositoryRoot, repositoryRelative)
  resolveWithin(repositoryRoot, relative(repositoryRoot, candidate))
  return withinRealRoot(candidate, repositoryRoot)
}

/** Static Docusaurus registry entries become ordinary page imports; never evaluate the registry module. */
function docusaurusGlobalImports(siteRoot: string, repositoryRoot: string, warnings: Array<MigrationWarning>): Map<string, string> {
  const registrations = new Map<string, string>()
  for (const filename of ['MDXComponents.js', 'MDXComponents.jsx', 'MDXComponents.ts', 'MDXComponents.tsx', 'MDXComponents/index.js', 'MDXComponents/index.tsx']) {
    try {
      const path = withinRealRoot(resolveWithin(siteRoot, `src/theme/${filename}`), repositoryRoot)
      if (!existsSync(path) || !lstatSync(path).isFile()) continue
      if (lstatSync(path).size > MAX_PAGE_BYTES) throw new Error('registry exceeds the 2 MB limit')
      const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const bindings = new Map<string, { source: string; imported: string }>()
      for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue
        let source = statement.moduleSpecifier.text
        if (source.startsWith('.')) source = `@site/${posix.normalize(posix.join('src/theme', posix.dirname(filename), source))}`
        if (!source.startsWith('@site/') && !source.startsWith('/')) continue
        const clause = statement.importClause
        if (clause?.name) bindings.set(clause.name.text, { source, imported: 'default' })
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const binding of clause.namedBindings.elements) {
            if (!binding.isTypeOnly) bindings.set(binding.name.text, { source, imported: binding.propertyName?.text ?? binding.name.text })
          }
        }
      }
      for (const statement of tree.statements) {
        if (!ts.isExportAssignment(statement) || statement.isExportEquals || !ts.isObjectLiteralExpression(statement.expression)) continue
        for (const property of statement.expression.properties) {
          if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property)) continue
          const name = property.name.getText(tree).replace(/^['"]|['"]$/g, '')
          const local = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer
          if (!/^[A-Z][\w$]*$/.test(name) || !ts.isIdentifier(local)) continue
          const binding = bindings.get(local.text)
          if (!binding) continue
          // Implicit global aliases must not disable widgets already mapped
          // by the platform adapter. Explicit page imports still take precedence.
          if (isThallyBuiltinComponent(name)) {
            warnings.push({ code: 'unsupported-config', message: `Global ${name} override uses the native widget mapping; review the source override for custom styling.`, source: `src/theme/${filename}` })
            continue
          }
          registrations.set(name, binding.imported === 'default'
            ? `import ${name} from ${JSON.stringify(binding.source)};`
            : `import { ${binding.imported} as ${name} } from ${JSON.stringify(binding.source)};`)
        }
      }
      return registrations
    } catch (error) {
      warnings.push({ code: 'unsupported-config', message: `Docusaurus MDX registry was not imported: ${error instanceof Error ? error.message : 'unreadable file'}.`, source: `src/theme/${filename}` })
    }
  }
  return registrations
}

/** Page-local imports/declarations override globals; fenced examples never acquire imports. */
function injectDocusaurusGlobalImports(raw: string, imports: ReadonlyMap<string, string>): string {
  if (imports.size === 0) return raw
  const parsed = parseFrontmatter(raw)
  const declared = pageScopeNames([parsed.content])
  const used = new Set<string>()
  replaceOutsideCodeAndComments(parsed.content, (segment) => {
    for (const match of segment.matchAll(/<([A-Z][\w$]*)(?=[\s/>])/g)) {
      if (imports.has(match[1]) && !declared.has(match[1])) used.add(match[1])
    }
    return segment
  })
  const prefix = raw.slice(0, raw.length - parsed.content.length)
  return used.size === 0 ? raw : `${prefix}${[...used].map((name) => imports.get(name)).join('\n')}\n\n${parsed.content}`
}

function globalSnippetAliases(
  files: Array<ScannedFile>,
  repositoryRoot: string,
  siteRoot: string,
): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const file of files) {
    const segments = file.relativePath.split('/')
    if (!segments.some((segment) => SNIPPET_DIRECTORIES.has(segment.toLowerCase()))) continue
    const basenameWithoutExtension = basename(file.relativePath).replace(/\.mdx?$/i, '')
    const conventionalAlias = basenameWithoutExtension
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
    if (conventionalAlias) aliases.set(conventionalAlias, file.absolutePath)
  }
  for (const file of files) {
    if (!['.md', '.mdx'].includes(extname(file.relativePath).toLowerCase())) continue
    let raw: string
    try { raw = readFileSync(file.absolutePath, 'utf8') } catch { continue } // best-effort: an unreadable page is reported when it is reached
    for (const match of raw.matchAll(SNIPPET_IMPORT_PATTERN)) {
      try {
        const componentName = match[1] ?? match[2]
        const candidate = resolveSnippetPath(match[3], file.absolutePath, repositoryRoot, siteRoot)
        if (existsSync(candidate) && lstatSync(candidate).isFile()) {
          aliases.set(componentName, candidate)
        }
      } catch {
        // The page-local inliner emits the actionable warning when it reaches
        // an unsafe or missing import. Global discovery is best-effort only.
      }
    }
  }
  return aliases
}

/** Every snippet file's exported component names (named, or a default export under the file's own name), keyed by name. Gated files count too, so ambiguity is never hidden. */
function snippetExportIndex(files: Array<ScannedFile>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  const add = (name: string, path: string) => { if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) index.set(name, (index.get(name) ?? new Set()).add(path)) }
  for (const file of files) {
    const extension = extname(file.relativePath).toLowerCase()
    if (!file.relativePath.split('/').some((segment) => SNIPPET_DIRECTORIES.has(segment.toLowerCase()))
      || !['.jsx', '.tsx', '.js', '.ts', '.mdx'].includes(extension)) continue
    let source: string
    try {
      if (lstatSync(file.absolutePath).size > MAX_PAGE_BYTES) continue
      source = readFileSync(file.absolutePath, 'utf8')
      if (!/\bexport\b/.test(source)) continue // nothing to parse: a large prose snippet must not cost a TypeScript parse
      for (const name of snippetExportedNames(source)) add(name, file.absolutePath)
    } catch { continue } // unreadable or unparseable (a pathological file can overflow the parser): not a candidate
    if (extension !== '.mdx') {
      const parsed = ts.createSourceFile('snippet.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const hasDefault = parsed.statements.some((statement) => (ts.isExportAssignment(statement) && !statement.isExportEquals)
        || ts.getModifiers(statement as ts.HasModifiers)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
      if (hasDefault) add(basename(file.relativePath).replace(/\.[^.]+$/, ''), file.absolutePath)
    }
  }
  return index
}

/**
 * Mintlify renders an unimported component as empty, so a page can use one its
 * snippets define without importing it. When exactly one snippet exports the
 * name, prepend the import the author left out, so the ordinary import
 * handling (size cap, gates, symlink containment) resolves it; any other
 * outcome leaves the page for the plain-div fallback.
 */
function importUndeclaredSnippetComponents(
  raw: string,
  currentFile: string,
  repositoryRoot: string,
  siteRoot: string,
  exportIndex: Map<string, Set<string>>,
  aliases: Map<string, string>,
  gate: InlineGate | undefined,
  warnings: Array<MigrationWarning>,
): string {
  if (exportIndex.size === 0) return raw
  const names = new Set<string>()
  replaceUnknownComponents(raw, (name) => names.add(name))
  const statements: Array<string> = []
  for (const name of names) {
    const matches = exportIndex.get(name)
    if (matches?.size !== 1 || aliases.has(name)) continue
    const [match] = matches
    const specifier = '/' + relative(siteRoot, match).replace(/\\/g, '/')
    try {
      const candidate = resolveSnippetPath(specifier, currentFile, repositoryRoot, siteRoot)
      if (candidate !== match || !lstatSync(candidate).isFile() || gate?.(candidate)) continue
      const named = snippetExportedNames(readFileSync(candidate, 'utf8')).has(name)
      statements.push(named ? `import { ${name} } from '${specifier}'` : `import ${name} from '${specifier}'`)
      warnings.push({
        code: 'unsupported-config',
        message: `<${name}> is used without an import; it was resolved to ${specifier.slice(1)} (the only snippet exporting that name). Mintlify renders unimported components as empty, so this page now shows content the live site does not.`,
        source: relative(repositoryRoot, currentFile).replace(/\\/g, '/'),
      })
    } catch { /* unreadable or outside the root: keep the fallback */ }
  }
  if (statements.length === 0) return raw
  const prefix = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0] ?? ''
  return `${prefix}${statements.join('\n')}\n\n${raw.slice(prefix.length)}`
}

function repositoryAssetHref(
  value: string,
  currentFile: string,
  siteRoot: string,
  onReferenced?: (normalizedPath: string, onDiskSpelling?: string) => void,
  /** Called when a page-relative path missed beside the page and the site-root file of that name was used. */
  onRootFallback?: (spelled: string, used: string) => void,
): string | null {
  const isBracketed = value.startsWith('<') && value.endsWith('>')
  const raw = isBracketed ? value.slice(1, -1) : value
  if (!raw || raw.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return null
  const suffixIndex = raw.search(/[?#]/)
  const pathname = suffixIndex >= 0 ? raw.slice(0, suffixIndex) : raw
  const suffix = suffixIndex >= 0 ? raw.slice(suffixIndex) : ''
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (!ASSET_EXTENSIONS.has(extname(decodedPath).toLowerCase())) return null
  try {
    let usedRootFallback = false
    let candidate = decodedPath.startsWith('/')
      ? resolveWithin(siteRoot, decodedPath.replace(/^\/+/, ''))
      : resolveWithinRoot(dirname(currentFile), decodedPath, siteRoot)
    // Authors of nested pages (e.g. v1/introduction) often write `./images/x.png`
    // for a file that lives in the shared root images folder; use it when
    // nothing exists beside the page.
    if (!decodedPath.startsWith('/') && !existsSync(candidate)) {
      const fromRoot = resolveWithin(siteRoot, decodedPath.replace(/^(?:\.\/)+/, ''))
      if (existsSync(fromRoot)) { candidate = fromRoot; usedRootFallback = true }
    }
    // Resolve every path component before accepting an asset. A repository
    // could contain a symlinked directory whose lexical path stays under
    // the docs root while its file contents live elsewhere on the host.
    const realRoot = realpathSync(siteRoot)
    const realCandidate = realpathSync(candidate)
    const realRelative = relative(realRoot, realCandidate)
    if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) return null
    // Mintlify's deploy root is the directory containing docs.json. Do not
    // copy or expose a relative reference that escapes that project boundary.
    const siteRelative = relative(siteRoot, candidate).replace(/\\/g, '/')
    resolveWithin(siteRoot, siteRelative)
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) return null
    const normalized = normalizeAssetPath(siteRelative)
    if (!normalized) return null
    // On a case-insensitive filesystem a differently-cased reference opens the
    // file; report the spelling it really has so it matches the scanned asset.
    const onDiskRelative = relative(realRoot, realpathSync.native(candidate)).replace(/\\/g, '/')
    const onDisk = onDiskRelative.toLowerCase() === siteRelative.toLowerCase() ? normalizeAssetPath(onDiskRelative) : null
    onReferenced?.(normalized, onDisk ?? undefined)
    if (usedRootFallback) onRootFallback?.(decodedPath, normalized)
    const rewritten = `/${normalized}${suffix}`
    // Markdown destinations containing parentheses must stay angle-bracketed;
    // removing the wrapper makes CommonMark terminate the URL too early.
    return isBracketed ? `<${rewritten}>` : rewritten
  } catch {
    return null
  }
}

/**
 * Rewrite links to a page whose Fern frontmatter `slug` replaced its docs.yml
 * hierarchy. Other pages still spell the link the "natural" nested way, so
 * this runs across every page's body, not just the renamed page's own.
 */
function rewriteFernIdRenameLinks(body: string, renames: Map<string, string>): string {
  return replaceOutsideCode(body, (text) => {
    const rewriteTarget = (target: string): string => {
      const suffixIndex = target.search(/[?#]/)
      const path = (suffixIndex >= 0 ? target.slice(0, suffixIndex) : target).replace(/^\/+/, '')
      const suffix = suffixIndex >= 0 ? target.slice(suffixIndex) : ''
      const renamed = renames.get(path)
      return renamed ? `/${renamed}${suffix}` : target
    }
    return text
      .replace(/(\]\()\/([^\s)]+)(?=[\s)]|$)/g, (_match, prefix: string, target: string) => `${prefix}${rewriteTarget(`/${target}`)}`)
      .replace(/(\bhref=")\/([^"]+)(")/g, (_match, prefix: string, target: string, suffix: string) => `${prefix}${rewriteTarget(`/${target}`)}${suffix}`)
  })
}

function rewriteRepositoryAssetLinks(
  body: string,
  currentFile: string,
  siteRoot: string,
  onReferenced?: (normalizedPath: string, onDiskSpelling?: string) => void,
  onRootFallback?: (spelled: string, used: string) => void,
): string {
  return body
    .replace(/(!?\[[^\]]*\]\()(<[^>]+>|[^)\s]+)([^)]*\))/g, (
      original,
      opening: string,
      destination: string,
      closing: string,
    ) => {
      const rewritten = repositoryAssetHref(destination, currentFile, siteRoot, onReferenced, onRootFallback)
      return rewritten ? `${opening}${rewritten}${closing}` : original
    })
    .replace(/\b(src|img|image|href)=(['"])([^'"]+)\2/g, (
      original,
      property: string,
      quote: string,
      destination: string,
    ) => {
      const rewritten = repositoryAssetHref(destination, currentFile, siteRoot, onReferenced, onRootFallback)
      return rewritten ? `${property}=${quote}${rewritten}${quote}` : original
    })
}

const LOCAL_EXPORT_DECLARATION = /^\s*export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/

/** Mintlify leaves JSX comments in MDX. Snippet tags inside them are examples or disabled content. */
function replaceOutsideMdxComments(body: string, transform: (segment: string) => string): string {
  const comment = /\{\/\*[\s\S]*?\*\/\}/g
  let cursor = 0
  let output = ''
  for (const match of body.matchAll(comment)) {
    output += transform(body.slice(cursor, match.index)) + match[0]
    cursor = match.index! + match[0].length
  }
  return output + transform(body.slice(cursor))
}

/** Keep code examples and disabled JSX opaque during snippet expansion. */
function replaceOutsideCodeAndMdxComments(body: string, transform: (segment: string) => string): string {
  return replaceOutsideCode(body, (segment) => replaceOutsideMdxComments(segment, transform))
}

/**
 * Names a page declares itself with a top-level `export const/function/class`.
 * Mintlify treats every file under `/snippets/` as an implicitly available
 * global component keyed by its filename, so a page that happens to declare
 * an inline component with the same name (e.g. both `snippets/counter.mdx`
 * and a page's own `export const Counter = ...`) must keep its local
 * declaration: forcing the unrelated global snippet's source in over a
 * `<Counter />` usage duplicates the export and breaks the compiled module.
 */
function locallyDeclaredNames(raw: string): Set<string> {
  const names = new Set<string>()
  let codeFence: string | null = null
  for (const line of raw.split('\n')) {
    const codeMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (codeMatch) {
      if (!codeFence) codeFence = codeMatch[1][0]
      else if (codeMatch[1][0] === codeFence) codeFence = null
      continue
    }
    if (codeFence) continue
    const declared = line.match(LOCAL_EXPORT_DECLARATION)?.[1]
    if (declared) names.add(declared)
  }
  return names
}

/**
 * The `export` lines that replace a value import. They end at a blank line, so when
 * the import was followed by a line break, one is kept: the next line must not join the block.
 */
function exportBlock(declarations: Array<string>, statement: string, sourcePath: string): string {
  const code = declarations.join('\n')
  return code && statement.slice(statement.lastIndexOf(sourcePath)).includes('\n') ? `${code}\n\n` : code
}

function inlineMdxSnippets(
  raw: string,
  currentFile: string,
  repositoryRoot: string,
  warnings: Array<MigrationWarning>,
  depth = 0,
  siteRoot = repositoryRoot,
  globalAliases: Map<string, string> = new Map(),
  /** Refuses access-restricted (Mintlify only), oversized or unclassifiable files. */
  gate?: InlineGate,
  /** Platform-specific import handling: Docusaurus generated exports, Fern `<Markdown src>` includes. */
  platform?: MigrationPlatform,
): string {
  if (depth >= 8) return raw
  // Hoisting page imports must see indented JSX code examples as fenced code.
  // Otherwise imports shown in translated <Step> examples become live MDX
  // imports, disappear from the example, and can break the server build.
  raw = normalizeIndentedFences(raw)
  const snippets = new Map<string, string>()
  const preservedDeclarations = new Map<string, string>()
  // Fail closed: a restricted, oversized or unclassifiable file is never
  // inlined, whatever its directory. One warning per occurrence; the returned
  // comment replaces the content.
  const source = relative(repositoryRoot, currentFile).replace(/\\/g, '/')
  const blockInline = (candidate: string, shownPath: string, label = shownPath): string | undefined => {
    const verdict = gate?.(candidate)
    if (!verdict) return undefined
    const shown = shownPath.replace(/\*\//g, '* /')
    if (verdict.kind === 'gated') {
      warnings.push({ code: 'gated-page', message: `${label} is access-restricted and was NOT inlined; it was left as a comment.`, source })
      return `{/* Access-restricted content withheld: ${shown} */}`
    }
    if (verdict.kind === 'draft') {
      warnings.push({ code: 'gated-page', message: `${label} is a draft page that Docusaurus does not publish, so it was not inlined; it was left as a comment.`, source })
      return `{/* Draft content not inlined: ${shown} */}`
    }
    if (verdict.kind === 'snippet-gated') {
      warnings.push({
        code: 'gated-page',
        message: `${label} declares access rules (${verdict.reason}). Mintlify does not enforce groups on snippets, but it was NOT inlined to be safe; it was left as a comment.`,
        source,
      })
      return `{/* Access-restricted content withheld: ${shown} */}`
    }
    warnings.push({
      code: 'skipped-file',
      message: `${label} ${verdict.kind === 'oversized' ? 'is too large to inline (over 2 MB)' : 'has frontmatter that could not be read'} and was NOT inlined; it was left as a comment.`,
      source,
    })
    return `{/* ${verdict.kind === 'oversized' ? 'Oversized' : 'Unreadable'} content not inlined: ${shown} */}`
  }
  // Fern renders file-backed Code tags as literal examples, not components.
  // Resolve against the page, keep list indentation, and never parse the
  // included source as MDX or let its backticks close the generated fence.
  if (platform === 'fern') raw = replaceOutsideCodeAndComments(raw, (segment) => {
    const marker = /<Code(?![\w$.-])/g
    let output = ''
    let cursor = 0
    for (let match = marker.exec(segment); match; match = marker.exec(segment)) {
      const opening = scanJsxOpeningTag(segment, match.index, 'Code')
      marker.lastIndex = opening.next
      if (opening.end === null) continue
      if (segment[opening.end - 1] !== '/') continue
      const properties = staticSnippetProperties(opening.attributes)
      const attribute = (name: string): string | undefined => properties.get(name)
      const filePath = attribute('src')
      if (!filePath) continue
      const end = opening.end + 1
      let replacement: string
      try {
        const candidate = resolveSnippetPath(filePath, currentFile, repositoryRoot, siteRoot)
        if (!existsSync(candidate) || !lstatSync(candidate).isFile()) throw new Error('file not found')
        if (lstatSync(candidate).size > MAX_PAGE_BYTES) throw new Error('file exceeds the 2 MB inline limit')
        const blocked = blockInline(candidate, filePath, `Code source ${filePath}`)
        if (blocked) replacement = blocked
        else {
          let code = readFileSync(candidate, 'utf8').replace(/\r\n/g, '\n')
          const lines = attribute('lines')
          if (lines !== undefined) {
            const range = /^(\d+)(?:-(\d+))?$/.exec(lines)
            const first = Number(range?.[1])
            const last = Number(range?.[2] ?? range?.[1])
            if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) throw new Error('invalid line range')
            code = code.split('\n').slice(first - 1, last).join('\n')
          }
          const language = attribute('language') ?? 'text'
          if (!/^[\w+-]+$/.test(language)) throw new Error('invalid language')
          const title = attribute('title')?.replace(/[\r\n`]/g, ' ')
          let fenceLength = 3
          for (const run of code.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run[0].length + 1)
          const fence = '`'.repeat(fenceLength)
          const before = segment.slice(segment.lastIndexOf('\n', match.index - 1) + 1, match.index)
          const indent = /^[ \t]*$/.test(before) ? before : ''
          replacement = isolateFences(`${fence}${language}${title ? ` ${title}` : ''}\n${code.replace(/\n$/, '')}\n${fence}`.split('\n').join(`\n${indent}`), segment, match.index, end)
        }
      } catch (error) {
        warnings.push({ code: 'skipped-file', message: `Code source ${filePath} was not inlined: ${error instanceof Error ? error.message : 'unreadable file'}.`, source })
        replacement = mdxComment(` Code source not inlined: ${filePath} `)
      }
      output += segment.slice(cursor, match.index) + replacement
      cursor = end
    }
    return output + segment.slice(cursor)
  })
  let withoutImports = replaceOutsideCodeAndMdxComments(raw, (source) => source.replace(
    SNIPPET_IMPORT_PATTERN,
    (_statement, namedComponent: string | undefined, defaultComponent: string | undefined, sourcePath: string) => {
      const componentName = (namedComponent ?? defaultComponent) as string
      try {
        const candidate = resolveSnippetPath(sourcePath, currentFile, repositoryRoot, siteRoot)
        if (!existsSync(candidate) || !lstatSync(candidate).isFile()) throw new Error('file not found')
        const blocked = blockInline(candidate, sourcePath, `Imported ${sourcePath}`)
        if (blocked) {
          snippets.set(componentName, blocked)
          return ''
        }
        // An upper-case primitive export (`API_KEY_REF`) matches the component
        // pattern; leave it for the value-import pass that declares it.
        if (namedComponent && staticNamedSnippetValues(readFileSync(candidate, 'utf8')).has(namedComponent)) return _statement
        const nested = inlineMdxSnippets(
          withoutFrontmatter(readFileSync(candidate, 'utf8')),
          candidate,
          repositoryRoot,
          warnings,
          depth + 1,
          siteRoot,
          globalAliases,
          gate,
          platform,
        )
        const declaration = statefulSnippetDeclaration(nested, componentName)
        if (declaration) preservedDeclarations.set(componentName, declaration)
        else snippets.set(componentName, snippetComponentBody(nested, componentName))
        return ''
      } catch (error) {
        if (error instanceof Error && error.message.includes('escapes its root')) {
          warnings.push({
            code: 'unsupported-config',
            message: `Import of ${sourcePath} resolves outside the repository and was NOT inlined.`,
            source: relative(repositoryRoot, currentFile).replace(/\\/g, '/'),
          })
        }
        // Disabled JSX examples may import a snippet that no longer exists.
        // An unused import is safe to drop without a missing-page warning.
        let hasLiveUsage = false
        replaceOutsideCodeAndMdxComments(raw, (segment) => {
          if (new RegExp(`<${componentName}(?:\\s|/?>)`).test(segment)) hasLiveUsage = true
          return segment
        })
        if (!hasLiveUsage) return ''
        warnings.push({
          code: 'missing-page',
          message: `Imported snippet ${sourcePath} could not be resolved and was left as a comment.`,
          source: relative(repositoryRoot, currentFile).replace(/\\/g, '/'),
        })
        snippets.set(componentName, mdxComment(` Missing imported snippet: ${sourcePath} `))
        return ''
      }
    },
  ))
  withoutImports = replaceOutsideCodeAndMdxComments(withoutImports, (segment) => segment.replace(
    SNIPPET_VALUE_IMPORT_PATTERN,
    (statement: string, names: string, sourcePath: string) => {
      const bindings = names.split(',').map((name) => name.trim()).filter(Boolean).map((name) => {
        const parsed = name.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
        return parsed ? { exported: parsed[1], local: parsed[2] ?? parsed[1] } : null
      })
      if (bindings.length === 0 || bindings.some((binding) => !binding)) return statement
      try {
        const candidate = resolveSnippetPath(sourcePath, currentFile, repositoryRoot, siteRoot)
        if (!existsSync(candidate) || !lstatSync(candidate).isFile() || gate?.(candidate)?.kind === 'gated') return statement
        const blocked = blockInline(candidate, sourcePath)
        if (blocked) {
          // Drop the import so the build never resolves the file; bind its names to the comment/empty.
          const declarations: Array<string> = []
          for (const binding of bindings) {
            if (/^[A-Z]/.test(binding!.exported)) snippets.set(binding!.local, blocked)
            else declarations.push(`export const ${binding!.local} = undefined;`)
          }
          return exportBlock(declarations, statement, sourcePath)
        }
        const snippetSource = readFileSync(candidate, 'utf8')
        const values = staticNamedSnippetValues(snippetSource)
        const declarations: Array<string> = []
        const components: Array<[string, string]> = []
        let exportedNames: Set<string> | undefined
        for (const binding of bindings) {
          const value = values.get(binding!.exported)
          if (value !== undefined) {
            declarations.push(`export const ${binding!.local} = ${value};`)
            continue
          }
          exportedNames ??= snippetExportedNames(snippetSource)
          const exported = exportedNames.has(binding!.exported)
          // Docusaurus generates these on every MDX document. Thally has none, and
          // pages spread or index them, so each gets an empty value of its own type.
          const generated = exported || platform !== 'docusaurus' ? undefined : DOCUSAURUS_GENERATED_EXPORTS[binding!.exported]
          if (generated) {
            declarations.push(`export const ${binding!.local} = ${generated};`)
            continue
          }
          if (!exported && !(/^[A-Z]/.test(binding!.exported) && snippetComponentBody(snippetSource, binding!.exported) !== snippetSource)) {
            // Mintlify binds a name its snippet does not export to undefined, which renders as nothing.
            warnings.push({
              code: 'unsupported-config',
              message: `"${binding!.exported}" is not exported by ${sourcePath}. Mintlify renders it as empty, so it was bound to undefined; add the export to the snippet to show a value.`,
              source,
            })
            declarations.push(`export const ${binding!.local} = undefined;`)
            continue
          }
          const body = /^[A-Z]/.test(binding!.exported) ? snippetComponentBody(snippetSource, binding!.exported) : snippetSource
          if (body === snippetSource) {
            warnings.push({
              code: 'unsupported-config',
              message: `Import of "${binding!.exported}" from ${sourcePath} could not be inlined (it is not a static value, a self-contained function or a simple component), so it was bound to undefined. Define "${binding!.exported}" in the page or replace its uses.`,
              source,
            })
            // Keeping the import would be stripped later and leave the other
            // names of the same import undefined too.
            if (/^[A-Z]/.test(binding!.exported)) snippets.set(binding!.local, mdxComment(` Removed <${binding!.local}>: could not be inlined `))
            declarations.push(`export const ${binding!.local} = undefined;`)
            continue
          }
          components.push([binding!.local, body])
        }
        for (const [name, body] of components) snippets.set(name, body)
        return exportBlock(declarations, statement, sourcePath)
      } catch (error) {
        if (error instanceof Error && error.message.includes('escapes its root')) {
          warnings.push({
            code: 'unsupported-config',
            message: `Import of ${sourcePath} resolves outside the repository and was NOT inlined.`,
            source: relative(repositoryRoot, currentFile).replace(/\\/g, '/'),
          })
        }
        return statement
      }
    },
  ))
  // Mintlify resolves snippet imports across its MDX compilation graph. Some
  // real sites consequently reuse an alias on a page that does not repeat the
  // import declaration. Recover those aliases deterministically from imports
  // elsewhere in the same docs project.
  const localNames = locallyDeclaredNames(withoutImports)
  for (const [componentName, candidate] of globalAliases) {
    let hasLiveUsage = false
    replaceOutsideCodeAndMdxComments(withoutImports, (source) => {
      if (new RegExp(`<${componentName}(?:\\s|/?>)`).test(source)) hasLiveUsage = true
      return source
    })
    if (snippets.has(componentName) || localNames.has(componentName) || gate?.(candidate)?.kind === 'gated'
      || !hasLiveUsage) continue
    const blocked = blockInline(candidate, relative(repositoryRoot, candidate).replace(/\\/g, '/'))
    if (blocked) {
      snippets.set(componentName, blocked)
      continue
    }
    const nested = inlineMdxSnippets(
      withoutFrontmatter(readFileSync(candidate, 'utf8')),
      candidate,
      repositoryRoot,
      warnings,
      depth + 1,
      siteRoot,
      globalAliases,
      gate,
      platform,
    )
    const declaration = statefulSnippetDeclaration(nested, componentName)
    if (declaration) preservedDeclarations.set(componentName, declaration)
    else snippets.set(componentName, snippetComponentBody(nested, componentName))
  }
  // Usages inside code or an existing comment stay literal: splicing a snippet
  // (or a missing-snippet comment) there would nest or corrupt the outer block.
  let result = replaceOutsideCodeAndComments(withoutImports, (segment) => {
    for (const [componentName, snippet] of snippets) {
      segment = segment
        .replace(new RegExp(`<${componentName}((?:\\s[^>]*)?)\\s*/>`, 'g'), (tag: string, attributes: string, offset: number, source: string) => {
          return isolateFences(closeOpenCodeFence(interpolateSnippet(snippet, attributes)), source, offset, offset + tag.length)
        })
        .replace(new RegExp(`<${componentName}((?:\\s[^>]*)?)>([\\s\\S]*?)<\\/${componentName}>`, 'g'), (tag: string, attributes: string, children: string, offset: number, source: string) => {
          return isolateFences(closeOpenCodeFence(interpolateSnippet(snippet, attributes, children)), source, offset, offset + tag.length)
        })
    }
    const tagLabel = (filePath: string): string => platform === 'fern' ? `Included file ${filePath}` : `Snippet file="${filePath}"`
    return segment.replace(platform === 'fern' ? FERN_MARKDOWN_TAG_PATTERN : SNIPPET_TAG_PATTERN, (tag: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, offset: number, source: string) => {
      const filePath = (doubleQuoted ?? singleQuoted)!
      try {
        // Mintlify's documented form is relative to `snippets/`; sites also write
        // the full `/snippets/x.mdx` (or a page-relative) path.
        const candidate = (platform === 'fern' ? [
          // Fern's absolute include paths are rooted at fern/, never snippets/.
          () => resolveSnippetPath(filePath, currentFile, repositoryRoot, siteRoot),
        ] : [
          () => withinRealRoot(resolveWithin(siteRoot, `snippets/${filePath}`), repositoryRoot),
          () => resolveSnippetPath(filePath, currentFile, repositoryRoot, siteRoot),
        ]).map((resolveCandidate) => {
          try { return resolveCandidate() } catch { return undefined }
        }).find((path) => path !== undefined && existsSync(path) && lstatSync(path).isFile())
        if (!candidate) throw new Error('file not found')
        const blocked = blockInline(candidate, filePath, tagLabel(filePath))
        if (blocked) return blocked
        return isolateFences(closeOpenCodeFence(inlineMdxSnippets(
          withoutFrontmatter(readFileSync(candidate, 'utf8')),
          candidate,
          repositoryRoot,
          warnings,
          depth + 1,
          siteRoot,
          globalAliases,
          gate,
          platform,
        )), source, offset, offset + tag.length)
      } catch {
        warnings.push({
          code: 'missing-page',
          message: platform === 'fern'
            ? `${tagLabel(filePath)} could not be found, so it was left out of the page.`
            : `${tagLabel(filePath)} could not be resolved and was left as a comment.`,
          source: relative(repositoryRoot, currentFile).replace(/\\/g, '/'),
        })
        return mdxComment(` Missing snippet: ${filePath} `)
      }
    })
  })
  if (preservedDeclarations.size > 0) {
    const frontmatter = result.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
    const prefix = frontmatter?.[0] ?? ''
    result = `${prefix}${[...new Set(preservedDeclarations.values())].join('\n\n')}\n\n${result.slice(prefix.length)}`
  }
  return depth === 0 ? hoistMdxImports(result) : closeOpenFence(result)
}

/**
 * Bind one or more resolved specs into their tabs. A spec with no
 * `tabLabel` (the common single-spec case) falls back to an existing
 * "*api*"-labelled tab, or gets a new "API Reference" tab of its own — the
 * original single-spec behavior. A spec with a `tabLabel` only ever binds
 * to that exact tab (creating it if the source tab had no other content
 * and so was dropped from `config.tabs` earlier), never the loose
 * substring fallback, so two specs from two different tabs can never both
 * land on the same tab by accident.
 */
function injectOpenApiSpecs(
  config: MigrationDocsConfig,
  specs: Array<{ filename: string; sourcePath?: string; tabLabel?: string; parentTab?: string; icon?: string; hidden?: boolean; generatedNavigation?: boolean; pageReferenced?: boolean; groups?: Array<MigrationApiGroup>; navigation?: false }>,
  warnings?: Array<MigrationWarning>,
): MigrationDocsConfig {
  const tabs = config.tabs.map((tab) => ({ ...tab }))
  for (const spec of specs) {
    const apiTab = spec.tabLabel
      ? tabs.find((tab) => tab.tab === spec.tabLabel)
      : tabs.find((tab) => tab.tab.toLowerCase().includes('api'))
    if (apiTab) {
      // Thally binds one API spec per tab; a second spec that resolves to
      // the same tab would otherwise silently replace the first one's
      // binding with no trace of it ever having existed.
      if (apiTab.api && warnings) {
        const source = specAssetPath(spec.filename)
        // Pages that name this spec still resolve it from a hidden tab, which lists no navigation of its own.
        const pageBound = spec.pageReferenced && !tabs.some((tab) => tab.api?.source === source)
        if (pageBound) insertApiTab(tabs, { tab: `OpenAPI: ${spec.sourcePath ?? spec.filename}`, hidden: true, api: { source } })
        warnings.push({
          code: 'unsupported-config',
          message: `Tab "${apiTab.tab}" already uses another OpenAPI spec, and Thally supports one API spec per tab, so "${source}" ${pageBound
            ? 'gets no endpoint list of its own; the pages that name it still show their endpoint. Put it in its own tab to list all its endpoints.'
            : 'was not added. Put it in its own tab to include it.'}`,
        })
        continue
      }
      apiTab.api = {
        source: specAssetPath(spec.filename),
        // An API-only tab needs generated endpoint navigation; an authored
        // page tab keeps its own groups alongside the bound spec, unless
        // Mintlify generated the endpoint pages (the renderer appends the
        // endpoint groups after the authored ones) or docs.json lists the
        // operations itself (those authored groups are the API navigation).
        // A spec whose listed operations are all withheld has no endpoint navigation either way.
        ...(spec.navigation === false || ((apiTab.groups?.length || apiTab.pages?.length) && !spec.generatedNavigation && !spec.groups) ? { navigation: false } : {}),
        ...(spec.groups ? { groups: spec.groups } : {}),
      }
    } else {
      insertApiTab(tabs, {
        tab: spec.tabLabel ?? 'API Reference',
        ...(spec.icon ? { icon: spec.icon } : {}),
        ...(spec.hidden ? { hidden: true } : {}),
        api: { source: specAssetPath(spec.filename), ...(spec.navigation === false ? { navigation: false } : {}), ...(spec.groups ? { groups: spec.groups } : {}) },
      }, spec.parentTab)
    }
  }
  return { ...config, tabs }
}

/** Identify component ownership independently of checkout paths and URL syntax. */
function componentSourceIdentity(sourceUrl: string, repositoryDir: string, siteRoot: string, namespace?: string): string {
  const url = new URL(sourceUrl)
  // A GitHub tree URL and the repository root identify the same source. Branch
  // changes should update its components, while separate monorepo sites must
  // retain independent namespaces even if their snippet filenames coincide.
  // Credentials, queries and fragments are not source identity and never feed
  // generated names; only the canonical origin/path and docs root participate.
  const repository = url.hostname.toLowerCase() === 'github.com'
    ? `https://github.com/${url.pathname.split('/').filter(Boolean).slice(0, 2).join('/').replace(/\.git$/i, '').toLowerCase()}`
    : `${url.origin}${trimTrailingSlashes(url.pathname)}`
  const docsRoot = relative(repositoryDir, siteRoot).replace(/\\/g, '/')
  return JSON.stringify(namespace ? [repository, docsRoot, namespace] : [repository, docsRoot])
}

/** Import an already-available repository directory into a canonical bundle. */
export function migrateRepository(options: RepositoryMigrationOptions): MigrationBundle {
  const repositoryDir = options.repositoryDir
  const platform = options.platform ?? detectRepositoryPlatform(repositoryDir, options.docsDir)
  const warnings: Array<MigrationWarning> = []
  const mintlifyProjectRoot = platform === 'mintlify'
    ? findMintlifyProjectRoot(repositoryDir, options.docsDir, warnings)
    : null
  const docusaurusProjectRoot = platform === 'docusaurus'
    ? findDocusaurusProjectRoot(repositoryDir, options.docsDir, warnings)
    : null
  const fernProjectRoot = platform === 'fern'
    ? findFernProjectRoot(repositoryDir, options.docsDir)
    : null
  const configuredDocsDir = (() => {
    if (options.docsDir !== undefined) {
      const selected = resolveWithin(repositoryDir, options.docsDir || '.')
      if (platform === 'docusaurus' && hasDocusaurusConfig(selected)) {
        const projectRelative = relative(repositoryDir, selected).replace(/\\/g, '/')
        return [projectRelative, primaryDocusaurusDocsDirectory(selected)].filter(Boolean).join('/')
      }
      return options.docsDir
    }
    if (docusaurusProjectRoot) {
      const projectRelative = relative(repositoryDir, docusaurusProjectRoot).replace(/\\/g, '/')
      return [projectRelative, primaryDocusaurusDocsDirectory(docusaurusProjectRoot)].filter(Boolean).join('/')
    }
    if (platform === 'mintlify' && mintlifyProjectRoot) {
      return relative(repositoryDir, mintlifyProjectRoot).replace(/\\/g, '/')
    }
    if (platform === 'fern' && fernProjectRoot) {
      return relative(repositoryDir, fernProjectRoot).replace(/\\/g, '/')
    }
    return platform === 'mintlify' ? '' : detectRepositoryDocsDir(repositoryDir)
  })()
  // A Docusaurus or Fern MDX page can import its own local components
  // (relative, or `@site/...` for Docusaurus) and bare npm packages the same
  // way a Mintlify page can; the same bounded component graph and
  // import-stripping logic applies to any source, rooted at whichever
  // project actually owns the pages. `@site/...` is Docusaurus' own alias
  // for its project root specifically (not the whole repository) and must
  // keep resolving there. A plain relative import (`../../components/X`),
  // though, is written relative to the *page*, which can live outside that
  // root in a monorepo where docs/ is a sibling of website/ (e.g. Redux) or
  // of a Fern project directory rather than nested under it — the
  // repository, not the narrower platform root, is the real confinement
  // boundary for those.
  const componentRoot = mintlifyProjectRoot ?? docusaurusProjectRoot ?? fernProjectRoot ?? repositoryDir
  const componentMigrator = platform === 'mintlify' || platform === 'docusaurus' || platform === 'fern'
    ? createComponentMigrator(componentRoot, repositoryDir, warnings, componentSourceIdentity(options.sourceUrl, repositoryDir, componentRoot, options.componentNamespace))
    : undefined
  const globalDocusaurusImports = platform === 'docusaurus'
    ? docusaurusGlobalImports(componentRoot, repositoryDir, warnings) : new Map<string, string>()
  let docsConfig: MigrationDocsConfig = { tabs: [] }
  // Literal leading path segments (e.g. "v1.15.22") that identify a
  // Mintlify `versions` container's default version — see
  // `mintlifyDefaultVersionPrefixes`.
  let defaultVersionPrefixes: ReadonlySet<string> = new Set()
  // Every version identifier declared in the config (default and
  // non-default) — used only to name which versions' pages were dropped if
  // discovery exceeds MAX_SOURCE_FILES; see `selectFilesWithinBudget`.
  let allVersionPrefixes: ReadonlySet<string> = new Set()
  const referenceMap = new Map<string, { navigationId: string; locale?: string }>()
  const exactReferenceMap = new Map<string, { navigationId: string; locale?: string }>()
  const referenceOrder = new Map<string, number>()
  let docusaurusSidebars: DocusaurusSidebars | null = null
  let mintlifyConfig: Record<string, unknown> | null = null
  /** The API tabs of the projected navigation that list operations and nothing else: left out of `docsConfig.tabs` until their spec is bound. */
  let mintlifyApiTabSlots: MintlifyNavigationResult['apiTabSlots'] = []
  /** Access each navigation appearance of a Mintlify page imposes, keyed like page references. */
  const mintlifyNavigationAccess = new Map<string, Array<NavigationAccess>>()
  let fernRawConfig: Record<string, unknown> | null = null
  let fernBasePath = ''
  let fernVersionPath = ''
  let fernApiSections: Array<FernApiSection> = []
  let fernRestrictedApiSections: Array<FernApiSection> = []
  let fernNavigationIncomplete = false
  // sourcePaths of Fern descriptors that resolve outside fern/ (from a
  // `versions:` file living in a sibling directory) — resolved directly,
  // below, since the ordinary fern/-rooted scan can't reach them.
  const fernExternalSourcePaths = new Set<string>()
  let fernChangelogIndexes: Array<{ route: string; entries: Array<string> }> = []
  const fernReferencedPaths = new Set<string>()
  const fernSourceLinkAliases = new Map<string, string>()
  const fernNavTitles = new Map<string, string>()
  const fernHiddenIds = new Set<string>()
  const fernRestrictedPaths = new Set<string>()

  const activeSourceRefs: Array<SourceRefImport> = []
  const usedSourceRefs = new Set<SourceRefImport>()
  const gatedSourceRepos = new Set<string>()
  for (const ref of options.sourceRefs ?? []) {
    if (platform !== 'mintlify') {
      warnings.push({ code: 'unsupported-config', message: `--source-ref ${ref.repo}=${ref.mountPath} applies only to Mintlify sources and was ignored.` })
    } else if (sourceRefMountCollides(mintlifyProjectRoot ?? repositoryDir, ref.mountPath)) {
      warnings.push({ code: 'collision', message: `sourceRef ${ref.repo} was not imported: the mount path "${ref.mountPath}" already exists in this site.` })
    } else {
      activeSourceRefs.push(ref)
    }
  }

  if (platform === 'mintlify') {
    try {
      const config = readMintlifyConfig(mintlifyProjectRoot ?? repositoryDir)
      if (config) {
        mintlifyConfig = config
        defaultVersionPrefixes = mintlifyDefaultVersionPrefixes(config)
        allVersionPrefixes = mintlifyAllVersionPrefixes(config)
        const projected = projectMintlifyNavigation(config, {
          // injectOpenApiSpecs / hydrateRemoteApiSpecs bind the authored operation lists to their API tabs.
          operationGroups: true,
          resolveSourceRef: (repo) => {
            const ref = activeSourceRefs.find((candidate) => candidate.repo.toLowerCase() === repo.toLowerCase())
            if (!ref) return null
            usedSourceRefs.add(ref)
            return ref.navigation
          },
        })
        docsConfig = projected.docsConfig
        mintlifyApiTabSlots = projected.apiTabSlots
        warnings.push(...projected.warnings)
        for (const repo of projected.gatedSourceRefs) gatedSourceRepos.add(repo.toLowerCase())
        for (const appearance of projected.referenceAccess) {
          const accessKey = normalizedReferenceKey(appearance.ref).toLowerCase()
          const known = mintlifyNavigationAccess.get(accessKey)
          if (known) known.push(appearance.access)
          else mintlifyNavigationAccess.set(accessKey, [appearance.access])
        }
        for (const [index, reference] of projected.pageReferences.entries()) {
          const key = normalizedReferenceKey(reference.ref)
          // Shared source pages may appear in several language menus. The
          // projector visits the default language first; retain that primary
          // file so other locales can use the runtime's content fallback.
          if (!referenceMap.has(key)) referenceMap.set(key, reference)
          const exactKey = exactReferenceKey(reference.ref)
          if (!exactReferenceMap.has(exactKey)) exactReferenceMap.set(exactKey, reference)
          if (!referenceOrder.has(key)) referenceOrder.set(key, index)
        }
      }
    } catch (error) {
      warnings.push({
        code: 'unsupported-config',
        message: `Mintlify config could not be read: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  if (platform === 'fern' && fernProjectRoot) {
    try {
      const fernConfig = readFernConfig(fernProjectRoot)
      if (fernConfig) {
        fernRawConfig = fernConfig.config
        fernBasePath = fernSourceBasePath(fernConfig.config)
        fernVersionPath = fernDefaultVersionPath(fernConfig.config)
        const projected = projectFernNavigation({ config: fernConfig.config, fernRoot: fernProjectRoot, repositoryRoot: repositoryDir })
        docsConfig = projected.docsConfig
        warnings.push(...projected.warnings)
        fernApiSections = projected.apiSections
        fernRestrictedApiSections = projected.restrictedApiSections
        fernNavigationIncomplete = projected.navigationIncomplete
        fernChangelogIndexes = projected.changelogIndexes
        for (const [index, descriptor] of projected.descriptors.entries()) {
          fernReferencedPaths.add(descriptor.sourcePath)
          if (descriptor.navTitle && !fernNavTitles.has(descriptor.navigationId)) {
            fernNavTitles.set(descriptor.navigationId, descriptor.navTitle)
          }
          if (descriptor.hidden) fernHiddenIds.add(descriptor.navigationId)
          if (descriptor.restricted) fernRestrictedPaths.add(canonicalPath(resolvePath(fernProjectRoot, descriptor.sourcePath)))
          // Fern pages often link by their source directory while a section
          // title changes the published route (for example tts-vendors to
          // tts-vendor-settings). Resolve only unambiguous, tab-prefixed
          // source paths rather than guessing at arbitrary root links.
          const sourceTail = descriptor.sourcePath.match(/(?:^|\/)pages\/(.+)\.mdx?$/i)?.[1]?.replace(/\/index$/i, '')
          if (sourceTail) {
            const routeSegments = descriptor.navigationId.split('/')
            const sourceSegments = sourceTail.split('/')
            if (routeSegments.length === sourceSegments.length + 1) {
              const alias = `${routeSegments[0]}/${sourceTail}`
              if (alias !== descriptor.navigationId && !fernSourceLinkAliases.has(alias)) fernSourceLinkAliases.set(alias, descriptor.navigationId)
            }
          }
          const key = normalizedReferenceKey(descriptor.sourcePath)
          if (!referenceMap.has(key)) referenceMap.set(key, { navigationId: descriptor.navigationId })
          const exactKey = exactReferenceKey(descriptor.sourcePath)
          if (!exactReferenceMap.has(exactKey)) exactReferenceMap.set(exactKey, { navigationId: descriptor.navigationId })
          if (!referenceOrder.has(key)) referenceOrder.set(key, index)
          if (descriptor.sourcePath.startsWith('../')) fernExternalSourcePaths.add(descriptor.sourcePath)
        }
      }
    } catch (error) {
      warnings.push({
        code: 'unsupported-config',
        message: `Fern config could not be read: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // A skipped branch could add a restricted appearance to any otherwise-public
  // file. No partial result can prove access safety, including API fallbacks.
  if (fernNavigationIncomplete) {
    throw new Error(`Fern navigation could not be fully classified, so no pages, assets or API specs were migrated. Fix cyclic references or reduce the navigation's nesting or node count before retrying.\n${warnings.map((warning) => `- ${warning.message}`).join('\n')}`)
  }

  if (platform === 'docusaurus') {
    try {
      docusaurusSidebars = options.docusaurusSkipSidebar || !docusaurusProjectRoot
        ? null
        : readDocusaurusSidebars(docusaurusProjectRoot, options.docusaurusSidebarPath)
    } catch (error) {
      warnings.push({
        code: 'unsupported-config',
        message: isPathEscapeError(error)
          ? 'Skipped the sidebar file because it points outside the repository (symlink or ..). Navigation was generated from the docs folder instead.'
          : `Docusaurus sidebar could not be read safely: ${error instanceof Error ? error.message : String(error)} Generated navigation will be used.`,
      })
    }
  }

  const contentRoot = resolveWithin(repositoryDir, configuredDocsDir)
  if (!existsSync(contentRoot) || !lstatSync(contentRoot).isDirectory()) {
    throw new Error(`Documentation directory does not exist: ${configuredDocsDir || '.'}`)
  }
  const mintignoreMatcher = platform === 'mintlify' && mintlifyProjectRoot
    ? readMintignoreMatcher(mintlifyProjectRoot)
    : null
  // Referenced files (found in the navigation config) are ranked ahead of
  // unreferenced ones, in navigation traversal order — which already puts a
  // Mintlify default version's pages before non-default versions' (and
  // newer non-default versions before older ones); see
  // `selectFilesWithinBudget`. Only meaningful when a nav was actually
  // parsed (Mintlify/Fern); Docusaurus has no pre-scan reference set.
  //
  // An *unreferenced* page (a real file Mintlify still serves by its own
  // file-based routing even though no sidebar entry points at it, e.g.
  // crewAI's `tools/web-scraping/firecrawlsearchtool.mdx`) used to get the
  // exact same flat lowest priority regardless of which version it belonged
  // to. Ranking it just after a single *global* floor (every referenced
  // page, from every version) isn't enough to fix that: a repository whose
  // total *referenced*-page count alone already exceeds the budget (e.g.
  // crewAI's ~40 versions x ~180 pages each) would still starve every
  // orphan, including the default version's own, since literally every
  // referenced page from every version would still outrank it. Instead,
  // each orphan is ranked right after the *last* referenced page found
  // under its own version+locale block — traversal is contiguous per
  // (language, version) pair (a whole version's pages, referenced and its
  // own orphans together, are visited before the next version starts, and
  // a whole language's versions before the next language's) — so grouping
  // by version alone (dropping the locale segment) would still pool an
  // English orphan's ceiling together with, say, Arabic's or Korean's much
  // later-traversed pages under the same version identifier. Keying by the
  // first two path segments (version, then locale) — rather than requiring
  // an exact match against `allVersionPrefixes` (the `version:` label
  // declared in config) — also keeps this working even when a version's
  // declared label and its actual directory prefix disagree in spelling or
  // case (e.g. crewAI's own `"version": "Edge"` label for its lowercase
  // `edge/` directory): what matters for contiguity is purely the directory
  // structure real pages were discovered under, not the label text. A
  // version's orphans land immediately behind that same version+locale's
  // own referenced pages, never behind another locale's or version's.
  const lastReferencedIndexByVersionLocale = new Map<string, number>()
  for (const [key, index] of referenceOrder) {
    const blockKey = key.split('/').slice(0, 2).join('/')
    const current = lastReferencedIndexByVersionLocale.get(blockKey)
    if (current === undefined || index > current) lastReferencedIndexByVersionLocale.set(blockKey, index)
  }
  const discoveryRank = referenceOrder.size > 0
    ? (relativePath: string): number => {
        const referencedIndex = referenceOrder.get(normalizedReferenceKey(relativePath))
        if (referencedIndex !== undefined) return referencedIndex
        const blockKey = relativePath.split('/').slice(0, 2).join('/')
        const versionCeiling = lastReferencedIndexByVersionLocale.get(blockKey)
        return versionCeiling !== undefined ? versionCeiling + 1 : Number.MAX_SAFE_INTEGER
      }
    : undefined
  const sourceBudget = options.maxSourceFiles ?? MAX_SOURCE_FILES
  const scannedFiles = scanFiles(contentRoot, repositoryDir, warnings, discoveryRank, sourceBudget)
  const mintignoreFilteredFiles = mintignoreMatcher
    ? scannedFiles.filter((file) => !mintignoreMatcher.ignores(file.relativePath))
    : scannedFiles
  // Mintlify snippet modules are dependencies loaded by path while inlining
  // pages; they are not published pages. The selector gives snippets their own
  // bounded group so they cannot evict translated or versioned pages.
  const isUnreferencedSnippetModule = (file: ScannedFile): boolean => (
    file.relativePath.split('/').some((segment) => SNIPPET_DIRECTORIES.has(segment.toLowerCase()))
    && isDocumentationExtension(file.relativePath)
    && !referenceOrder.has(normalizedReferenceKey(file.relativePath))
  )
  const files = discoveryRank
    ? selectFilesWithinBudget(mintignoreFilteredFiles, discoveryRank, warnings, allVersionPrefixes, sourceBudget)
    : mintignoreFilteredFiles
  // A Fern `versions:` file may live outside fern/ (a sibling `docs/`
  // directory) and its own pages resolve relative to it, so their
  // sourcePath (e.g. `../docs/pages/x.mdx`) falls outside the fern/-rooted
  // scan above. Resolve exactly those referenced files directly, rather
  // than rescanning the whole repository (which would also shift every
  // asset's firstSegment and break the fern/-relative asset-bucket
  // detection below).
  if (platform === 'fern' && fernProjectRoot) {
    const discovered = new Set(files.map((file) => file.relativePath))
    for (const sourcePath of fernExternalSourcePaths) {
      if (discovered.has(sourcePath)) continue
      try {
        const absolutePath = withinRealRoot(resolveWithinRoot(fernProjectRoot, sourcePath, repositoryDir), repositoryDir)
        if (existsSync(absolutePath) && lstatSync(absolutePath).isFile()) {
          files.push({ absolutePath, relativePath: sourcePath })
          discovered.add(sourcePath)
        } else {
          warnings.push({ code: 'missing-page', message: 'A Fern navigation path could not be read within this repository.', source: sourcePath })
        }
      } catch {
        warnings.push({ code: 'missing-page', message: 'A Fern navigation path could not be read within this repository.', source: sourcePath })
      }
    }
  }
  const pages: Array<MigrationPage> = []
  const assets: Array<MigrationAsset> = []
  const sourceRefPages: Array<MigrationPage> = []
  const sourceRefAssets: Array<MigrationAsset> = []
  const remoteApiSpecs: Array<RemoteApiSpec> = []
  const localApiMounts: NonNullable<MigrationBundle['localApiMounts']> = []
  // Which pages reference which asset (by its normalized copy-destination
  // path), so the final asset-copy pass can prioritize referenced assets
  // over unreferenced ones when the budget is tight, and name the
  // referencing pages in the warning if one still gets dropped.
  const referencedAssetPaths = new Map<string, Set<string>>()
  const addAssetReference = (assetPath: string, referencingPage: string): void => {
    const referrers = referencedAssetPaths.get(assetPath)
    if (referrers) referrers.add(referencingPage)
    else referencedAssetPaths.set(assetPath, new Set([referencingPage]))
  }
  const docusaurusDescriptors: Array<DocusaurusPageDescriptor> = []
  const docusaurusDocCardRoutes = new Set<string>()
  const seenPageIds = new Set<string>()
  const quarantinedFiles: Array<RenderedMigrationFile> = []
  /** Pages migrated with `groups` / `public: false`; never a source of public assets or specs. */
  const restrictedPages = new Set<MigrationPage>()
  // Assets that withheld pages use (their own and via inlined snippets), and
  // the raw text of everything published (page source with snippets inlined,
  // frontmatter included, plus copied CSS/JS and migrated components), which
  // asset rewriting does not fully track: images named only there stay public.
  const withheldAssetPaths = new Set<string>()
  // What published text points at, by destination path (`publishedExact`: a path
  // spelled in full) or only by name (`publishedLoose`, which never makes an
  // asset public). Filled only on a site that fails closed for assets (the only
  // place they are read); no page text is kept.
  const publishedExact = new Set<string>()
  const publishedLoose = new Set<string>()
  const withholdAsset = (assetPath: string, onDiskSpelling?: string): void => { withheldAssetPaths.add(publicAssetKey(onDiskSpelling ?? assetPath)) }
  let sawPublicTrue = false
  // Access verdicts are computed up front so a page that imports a
  // restricted page as a component can never inline its content.
  const gateByPath = new Map<string, PageGate>()
  // Frontmatter `openapi:` references, split by whether the page is withheld.
  const withheldSpecRefs: Array<string> = []
  const publishedSpecRefs: Array<string> = []
  const publishedSpecPages: Array<{ ref: string; file: string }> = []
  const withheldPaths = new Set<string>()
  // The access verdict of one Mintlify page: a bounded read of its frontmatter
  // head, combined with every navigation container listing it. Unreadable
  // or contradictory rules fail closed (quarantined).
  const isDocFile = (file: ScannedFile): boolean => ['.md', '.mdx'].includes(extname(file.relativePath).toLowerCase())
  const isGateCandidate = (file: ScannedFile): boolean => isDocFile(file)
    && !file.relativePath.split('/').some((segment) => SNIPPET_DIRECTORIES.has(segment.toLowerCase()))
  const navigationAccessFor = (relativePath: string): NavigationAccess =>
    mergeNavigationAppearances(mintlifyNavigationAccess.get(normalizedReferenceKey(relativePath).toLowerCase()) ?? [])
  const classifyPageGate = (file: ScannedFile): PageGate => {
    let head: { access: MintlifyAccess; openapi?: string } | { reason?: string; openapi?: string }
    try {
      // Pages above the size cap are never imported, but another page can
      // still inline them, so they are classified from their frontmatter.
      // One bounded read for nearly every page; a frontmatter longer than the
      // head window falls back to the whole file, as before.
      const size = lstatSync(file.absolutePath).size
      const raw = readFrontmatterHead(file.absolutePath) ?? (size > MAX_PAGE_BYTES ? undefined : readFileSync(file.absolutePath, 'utf8'))
      if (raw === undefined) throw new Error('frontmatter is not terminated within the bounded read')
      head = platform === 'mintlify' ? pageHeadAccess(raw) : pageHeadGateReason(raw, platform)
    } catch {
      head = platform === 'mintlify' ? { access: { problem: 'frontmatter could not be read' } } : { reason: 'frontmatter could not be read' }
    }
    // Fern and Docusaurus rules have no runtime mapping: a hit is quarantined, never migrated.
    if (!('access' in head)) return head.reason ? { reason: head.reason, quarantineReason: head.reason, openapi: head.openapi } : { openapi: head.openapi }
    const verdict = resolvePageAccess(head.access, navigationAccessFor(file.relativePath))
    if (verdict.problem) return { reason: verdict.problem, quarantineReason: verdict.problem, openapi: head.openapi }
    const access = verdict.access ?? {}
    return { ...(isRestrictedAccess(access) ? { reason: describeRestriction(access) } : {}), access, openapi: head.openapi }
  }
  // Pages the file budget dropped, or a walk that hit its cap, are not
  // published, but their gate still decides what is withheld: classified here
  // from the same bounded head read, before anything trims them.
  const keptFiles = new Set(files)
  const droppedGatedFiles: Array<{ file: ScannedFile; reason: string }> = []
  // Restricted documents never published as pages (snippets, and .mintignore'd
  // files): their assets are withheld and the site fails closed.
  const withheldDocFiles: Array<ScannedFile> = []
  let droppedPageCount = 0
  const scanTruncated = scannedFiles.length >= (discoveryRank ? sourceBudget * RANKED_WALK_FACTOR : sourceBudget)
  if (platform === 'mintlify') {
    for (const file of files) {
      // A snippet that declares access rules is never inlined: it is restricted
      // content, so its assets are withheld and the site fails closed too.
      if (isDocFile(file) && !isGateCandidate(file)) {
        const snippetReason = classifyPageGate(file).reason
        if (snippetReason) withheldDocFiles.push(file)
        continue
      }
      if (!isGateCandidate(file)) continue
      const verdict = classifyPageGate(file)
      gateByPath.set(file.absolutePath, verdict)
      if (verdict.openapi) (verdict.reason ? withheldSpecRefs : publishedSpecRefs).push(verdict.openapi)
      if (verdict.openapi && !verdict.reason) publishedSpecPages.push({ ref: verdict.openapi, file: file.relativePath })
      if (verdict.reason) withheldPaths.add(file.absolutePath)
    }
    for (const file of mintignoreFilteredFiles) {
      if (keptFiles.has(file) || !isDocFile(file)) continue
      // Snippet modules do not consume the page budget. Classify their access
      // rules without treating every ordinary snippet as a dropped page.
      if (isUnreferencedSnippetModule(file)) {
        if (classifyPageGate(file).reason) withheldDocFiles.push(file)
        continue
      }
      // Every dropped document, snippet or page, fails the site closed for assets.
      droppedPageCount++
      if (!isGateCandidate(file)) {
        const snippetReason = classifyPageGate(file).reason
        if (snippetReason) {
          withheldDocFiles.push(file)
          warnings.push({ code: 'gated-page', message: `Access-restricted snippet (${snippetReason}) was dropped by the file limit; its assets were kept out of public/.`, source: file.relativePath })
        }
        continue
      }
      const verdict = classifyPageGate(file)
      if (!verdict.reason) continue
      if (verdict.openapi) withheldSpecRefs.push(verdict.openapi)
      withheldPaths.add(file.absolutePath)
      droppedGatedFiles.push({ file, reason: verdict.reason })
    }
    // A .mintignore'd document is not migrated, but if it is restricted, the
    // assets it uses are still restricted.
    for (const file of scannedFiles) {
      if (!mintignoreMatcher?.ignores(file.relativePath) || !isDocFile(file)) continue
      const verdict = classifyPageGate(file)
      if (!verdict.reason) continue
      if (verdict.openapi) withheldSpecRefs.push(verdict.openapi)
      withheldDocFiles.push(file)
    }
  }
  // Pages that were never classified (dropped by the budget, or beyond the walk
  // cap) could be restricted: assets no published page names by exact path stay
  // out of public/ on such a site, as on one with known restricted pages.
  // Pages over the page cap are never published, so only smaller ones are read for role-restricted content.
  const fernBodyReason = (file: ScannedFile): string | undefined => {
    if (platform !== 'fern') return undefined
    try {
      return lstatSync(file.absolutePath).size > MAX_PAGE_BYTES ? undefined : fernIfRolesReason(readFileSync(file.absolutePath, 'utf8'))
    } catch {
      return 'it could not be read to check for role-restricted content'
    }
  }
  // Fern and Docusaurus: why a document must not be published or inlined, or undefined. Cached per real path.
  const gateReasonCache = new Map<string, string | null>()
  const nonMintlifyGateReason = (file: ScannedFile): string | undefined => {
    if (!isDocFile(file)) return undefined
    const key = canonicalPath(file.absolutePath)
    let reason = gateReasonCache.get(key)
    if (reason === undefined) {
      // Docusaurus never treats `_` files and directories as documents, so a `draft` there means nothing.
      reason = platform === 'docusaurus' && file.relativePath.split('/').some((segment) => segment.startsWith('_'))
        ? null
        : (fernRestrictedPaths.has(key)
          ? 'docs.yml `viewers` restricts it to signed-in roles'
          : classifyPageGate(file).reason ?? fernBodyReason(file)) ?? null
      gateReasonCache.set(key, reason)
    }
    return reason ?? undefined
  }
  if (platform === 'docusaurus' || platform === 'fern') {
    // Fail closed here too: a draft (Docusaurus) or role-restricted (Fern) page is quarantined, never published.
    // `files` can hold pages the scan never saw (a Fern versions file outside fern/), so both lists are classified.
    for (const file of new Set([...scannedFiles, ...files])) {
      const reason = nonMintlifyGateReason(file)
      if (!reason) continue
      gateByPath.set(file.absolutePath, { reason, quarantineReason: reason })
      withheldPaths.add(file.absolutePath)
    }
  }
  // Oversized bodies can contain access rules that the bounded classifier never reads.
  const pagesNotClassified = droppedPageCount > 0 || scanTruncated
    || files.some((file) => isDocFile(file) && lstatSync(file.absolutePath).size > MAX_PAGE_BYTES)
  const hasWithheldContent = withheldPaths.size > 0 || withheldDocFiles.length > 0
  const trackPublishedRefs = hasWithheldContent || pagesNotClassified
  // Docusaurus: the docs folder's place in the site, so `@site/...` and `../../static/...` links resolve from the site root.
  const docusaurusDocsPrefix = platform === 'docusaurus' ? relative(docusaurusProjectRoot ?? repositoryDir, contentRoot).replace(/\\/g, '/') : ''
  const docusaurusPaths = (siteBase: string): DocusaurusPathContext | undefined => (
    platform === 'docusaurus' ? { siteBase: posix.normalize(siteBase).replace(/^\.$/, ''), docsPrefix: docusaurusDocsPrefix } : undefined)
  // Mintlify only. The pre-pass covers only files inside the file budget, so a
  // candidate it never saw (dropped by the budget, in a snippet directory, under
  // a case-variant path) is classified on demand: frontmatter gates, navigation
  // gates, then size/readability. Cached per real path.
  const withheldCanonical = new Set([...withheldPaths].map(canonicalPath))
  const verdictCache = new Map<string, InlineVerdict | null>()
  const classifyInlineCandidate = (candidate: string, key: string): InlineVerdict | undefined => {
    if (withheldCanonical.has(key)) return { kind: 'gated', reason: 'access-restricted' }
    const shown = relative(contentRoot, candidate).replace(/\\/g, '/')
    const inSnippetDirectory = shown.split('/').some((segment) => SNIPPET_DIRECTORIES.has(segment.toLowerCase()))
    let head: string | undefined
    try { head = readFrontmatterHead(candidate) } catch { return { kind: 'unreadable', reason: 'could not be read' } }
    const own = head === undefined ? undefined : pageHeadAccess(head).access
    if (own && isRestrictedAccess(own)) return { kind: inSnippetDirectory ? 'snippet-gated' : 'gated', reason: ownRestrictionReason(own) }
    if (!inSnippetDirectory) {
      const navigation = navigationAccessFor(shown)
      if (isNavigationRestricted(navigation)) return { kind: 'gated', reason: navigation.problem ?? 'its navigation container restricts it' }
    }
    // Invalid YAML is salvaged line by line, so what a snippet declares cannot be trusted; same as oversized.
    if (head !== undefined && parseFrontmatter(head).error) return { kind: 'unreadable', reason: 'frontmatter could not be parsed' }
    if (lstatSync(candidate).size > MAX_PAGE_BYTES) return { kind: 'oversized', reason: 'over 2 MB' }
    return head === undefined ? { kind: 'unreadable', reason: 'frontmatter not terminated in the bounded read' } : undefined
  }
  const inlineGate: InlineGate | undefined = platform === 'mintlify'
    ? (candidate) => {
        const key = canonicalPath(candidate)
        let verdict = verdictCache.get(key)
        if (verdict === undefined) {
          verdict = classifyInlineCandidate(candidate, key) ?? null
          verdictCache.set(key, verdict)
        }
        return verdict ?? undefined
      }
    // Fern and Docusaurus have no access rules to enforce, but an inlined file still has the page size cap.
    : (candidate) => {
        // A file the pre-pass never saw is classified now; a miss is never treated as public.
        const reason = nonMintlifyGateReason({ absolutePath: candidate, relativePath: relative(contentRoot, candidate).replace(/\\/g, '/') })
        if (reason) return { kind: reason === DOCUSAURUS_DRAFT_REASON ? 'draft' : 'gated', reason }
        return lstatSync(candidate).size > MAX_PAGE_BYTES ? { kind: 'oversized', reason: 'over 2 MB' } : undefined
      }
  /** docs.yml-derived navigationId -> final id, when a page's frontmatter `slug` overrides it. */
  const fernIdRenames = new Map<string, string>()
  let skipped = 0
  let discovered = files.length

  const localeConfig = docsConfig.i18n
  const defaultPageIds = new Set([...referenceMap.values()]
    .filter((reference) => !reference.locale || reference.locale === localeConfig?.defaultLocale)
    .map((reference) => reference.navigationId))
  /**
   * The one rule that decides which page a source path publishes as: the
   * navigation entry that names it (exactly, else by its name with `index`
   * and a nested `readme` folded into the folder), else its own path, in the
   * locale its folder belongs to. The page loop publishes by this, and OpenAPI
   * ownership is keyed by it for navigation entries and files alike, so a page
   * and the places that list it cannot disagree about which page they mean.
   * Null when the path cannot be normalized safely.
   */
  const resolvePageIdentity = (path: string): { locale?: string; navigationId: string; id: string } | null => {
    const referenced = exactReferenceMap.get(exactReferenceKey(path)) ?? referenceMap.get(normalizedReferenceKey(path))
    let locale = referenced?.locale
    let navigationId = referenced?.navigationId ?? pageIdFromReference(path, platform === 'mintlify')
    if (!referenced && localeConfig) {
      for (const entry of localeConfig.locales) {
        const localized = mintlifyLocalizedReference(path, entry.code, defaultPageIds)
        if (localized === path) continue
        locale = entry.code
        navigationId = pageIdFromReference(localized, platform === 'mintlify')
        break
      }
    }
    if (!navigationId) return null
    const isDefaultLocale = !locale || locale === localeConfig?.defaultLocale
    return { locale, navigationId, id: isDefaultLocale ? navigationId : `${locale}/${navigationId}` }
  }
  const routeAliases: NonNullable<MigrationDocsConfig['redirects']> = []
  const pageFiles = [...files].sort((left, right) => {
    const leftOrder = referenceOrder.get(normalizedReferenceKey(left.relativePath)) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = referenceOrder.get(normalizedReferenceKey(right.relativePath)) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || left.relativePath.localeCompare(right.relativePath)
  })
  const snippetAliases = platform === 'mintlify' && mintlifyProjectRoot
    // Snippets are dependencies, not publishable pages. They stay outside the
    // page budget but must remain available for implicit Mintlify aliases.
    ? globalSnippetAliases(files, repositoryDir, mintlifyProjectRoot)
    : new Map<string, string>()
  const snippetExports = platform === 'mintlify' && mintlifyProjectRoot ? snippetExportIndex(files) : new Map<string, Set<string>>()
  // A restricted page the budget dropped is not published or saved, but the
  // assets it uses must still stay out of public/ (bounded scan, like the
  // oversized restricted pages).
  droppedGatedFiles.forEach(({ file, reason }, index) => {
    if (index < MAX_DROPPED_GATED_WARNINGS) {
      warnings.push({
        code: 'gated-page',
        message: `Access-restricted page (${reason}) was dropped by the file limit, so it was NOT published and was not saved under ${QUARANTINE_DIRECTORY}/; recover it from the source repository.`,
        source: file.relativePath,
      })
    }
    if (!mintlifyProjectRoot) return
    try {
      if (lstatSync(file.absolutePath).size > MAX_WITHHELD_SCAN_BYTES) throw new Error('too large to scan')
      rewriteRepositoryAssetLinks(
        inlineMdxSnippets(readFileSync(file.absolutePath, 'utf8'), file.absolutePath, repositoryDir, [], 0, mintlifyProjectRoot, snippetAliases, inlineGate),
        file.absolutePath,
        mintlifyProjectRoot,
        withholdAsset,
      )
    } catch {
      // Unscannable, so its assets are unknown: they stay out of public/ unless a published page names them by exact path.
    }
  })
  for (const file of withheldDocFiles) {
    try {
      if (!mintlifyProjectRoot) continue
      if (lstatSync(file.absolutePath).size > MAX_WITHHELD_SCAN_BYTES) {
        warnings.push({
          code: 'gated-page',
          message: 'Access-restricted file is too large to scan, so the assets it uses could not be checked and may have been copied to public/. Review them before publishing.',
          source: file.relativePath,
        })
        continue
      }
      rewriteRepositoryAssetLinks(readFileSync(file.absolutePath, 'utf8'), file.absolutePath, mintlifyProjectRoot, withholdAsset)
    } catch {
      // Unscannable: its assets stay out of public/ unless a published page names them by exact path.
    }
  }
  if (droppedGatedFiles.length > MAX_DROPPED_GATED_WARNINGS) {
    warnings.push({
      code: 'gated-page',
      message: `${droppedGatedFiles.length - MAX_DROPPED_GATED_WARNINGS} more access-restricted page(s) were dropped by the file limit and NOT published; recover them from the source repository.`,
    })
  }
  for (const file of pageFiles) {
    if (!isDocumentationExtension(file.relativePath)) continue
    // Unlike Mintlify/Docusaurus, Fern only ever serves pages reachable from
    // docs.yml (or a versions file); everything else is invisible on the
    // live site, so importing it as an "orphan" page would fabricate content
    // (and can crash a build on stray files that were never meant to render).
    if (platform === 'fern'
      && !exactReferenceMap.has(exactReferenceKey(file.relativePath))
      && !referenceMap.has(normalizedReferenceKey(file.relativePath))) {
      skipped++
      continue
    }
    const sourceSegments = file.relativePath.split('/')
    if (sourceSegments.some((segment) => SNIPPET_DIRECTORIES.has(segment.toLowerCase()))
      || (platform === 'docusaurus' && sourceSegments.some((segment) => segment.startsWith('_')))) {
      skipped++
      continue
    }
    const rootFilename = !file.relativePath.includes('/') ? basename(file.relativePath).toLowerCase() : ''
    if (REPOSITORY_ONLY_DOCUMENTS.has(rootFilename) && !exactReferenceMap.has(exactReferenceKey(file.relativePath))) {
      skipped++
      continue
    }
    if (!['.md', '.mdx'].includes(extname(file.relativePath).toLowerCase())) {
      skipped++
      warnings.push({ code: 'skipped-file', message: 'Only Markdown and MDX are imported without an explicit converter.', source: file.relativePath })
      continue
    }
    const size = lstatSync(file.absolutePath).size
    if (size > MAX_PAGE_BYTES) {
      skipped++
      warnings.push({ code: 'skipped-file', message: 'Page exceeded the 2 MB repository import limit.', source: file.relativePath })
      // Known restricted from its frontmatter; its assets must stay out of public/ too.
      const oversizedGate = gateByPath.get(file.absolutePath)?.reason
      if (oversizedGate) {
        warnings.push({
          code: 'gated-page',
          message: `Access-restricted page (${oversizedGate}) is too large to migrate (over 2 MB), so it was NOT published and was not saved under ${QUARANTINE_DIRECTORY}/; recover it from the source repository.`,
          source: file.relativePath,
        })
      }
      if (oversizedGate && mintlifyProjectRoot) {
        if (size > MAX_WITHHELD_SCAN_BYTES) {
          warnings.push({
            code: 'gated-page',
            message: 'Access-restricted page is too large to scan, so the assets it uses could not be checked and may have been copied to public/. Review them before publishing.',
            source: file.relativePath,
          })
        } else {
          rewriteRepositoryAssetLinks(readFileSync(file.absolutePath, 'utf8'), file.absolutePath, mintlifyProjectRoot, withholdAsset)
        }
      }
      continue
    }
    // Restricted Mintlify pages migrate with `groups` / `public: false`
    // frontmatter the runtime enforces, but what they use must not leak through
    // surfaces that are not access controlled (public/, specs, other pages).
    // Fern and Docusaurus have no runtime mapping, so their gated pages are
    // quarantined outright (the gate sets quarantineReason).
    let pageGate: PageGate | undefined
    {
      pageGate = gateByPath.get(file.absolutePath)
      if (pageGate?.access?.isPublic === true) sawPublicTrue = true
      // Rules that cannot be carried over safely (malformed values, group
      // lists that share no group, unreadable frontmatter) fail closed: the
      // original file is kept outside every published path so nothing is lost.
      const gateReason = pageGate?.quarantineReason
      if (gateReason) {
        skipped++
        if (file.relativePath.split('/').some((segment) => segment === '..')) {
          warnings.push({ code: 'gated-page', message: `Access-restricted page (${gateReason}) was withheld from the site, but its path could not be preserved safely; recover it from the source repository.`, source: file.relativePath })
          continue
        }
        try {
          if (mintlifyProjectRoot) {
            rewriteRepositoryAssetLinks(
              inlineMdxSnippets(readFileSync(file.absolutePath, 'utf8'), file.absolutePath, repositoryDir, [], 0, mintlifyProjectRoot, snippetAliases, inlineGate),
              file.absolutePath,
              mintlifyProjectRoot,
              withholdAsset,
            )
          }
          quarantinedFiles.push({ path: `${QUARANTINE_DIRECTORY}/${file.relativePath}`, content: readFileSync(file.absolutePath) })
        } catch {
          // An unreadable restricted page must not abort the migration or be published.
          warnings.push({
            code: 'gated-page',
            message: `Access-restricted page (${gateReason}) was NOT published, but it could not be read, so it was not copied to ${QUARANTINE_DIRECTORY}/; recover it from the source repository.`,
            source: file.relativePath,
          })
          continue
        }
        warnings.push({
          code: 'gated-page',
          message: gateReason === DOCUSAURUS_DRAFT_REASON
            ? `This is a draft page that Docusaurus does not publish, so it was NOT published. The original is saved at ${QUARANTINE_DIRECTORY}/${file.relativePath}; links from other pages to it will break.`
            : platform === 'mintlify'
              ? `Access-restricted on the source site, but its access rules could not be migrated safely (${gateReason}), so it was NOT published. Fix the rules in the original, saved at ${QUARANTINE_DIRECTORY}/${file.relativePath}, and move it into src/content/; until then links from other pages to it will break.`
              : `Access-restricted on the source site (${gateReason}), so it was NOT published. The original is saved at ${QUARANTINE_DIRECTORY}/${file.relativePath}; links from other pages to it will break.`,
          source: file.relativePath,
        })
        continue
      }
      if (pageGate?.reason && mintlifyProjectRoot) {
        // Raw text, frontmatter and inlined snippets included, so an image
        // named only in a restricted page's metadata stays private too.
        try {
          rewriteRepositoryAssetLinks(
            inlineMdxSnippets(readFileSync(file.absolutePath, 'utf8'), file.absolutePath, repositoryDir, [], 0, mintlifyProjectRoot, snippetAliases, inlineGate),
            file.absolutePath,
            mintlifyProjectRoot,
            withholdAsset,
          )
        } catch {
          // Unscannable: its assets stay out of public/ unless a published page
          // names them by exact path; the page itself is read again below.
        }
      }
    }
    const isRestrictedPage = Boolean(pageGate?.reason)
    const identity = resolvePageIdentity(file.relativePath)
    if (!identity) {
      skipped++
      warnings.push({ code: 'invalid-page', message: 'Page path could not be normalized safely.', source: file.relativePath })
      continue
    }
    const { locale, navigationId, id } = identity
    let raw = inlineMdxSnippets(
      mintlifyProjectRoot
        ? importUndeclaredSnippetComponents(readFileSync(file.absolutePath, 'utf8'), file.absolutePath, repositoryDir, mintlifyProjectRoot, snippetExports, snippetAliases, inlineGate, warnings)
        : injectDocusaurusGlobalImports(readFileSync(file.absolutePath, 'utf8'), globalDocusaurusImports),
      file.absolutePath,
      repositoryDir,
      warnings,
      0,
      mintlifyProjectRoot ?? docusaurusProjectRoot ?? fernProjectRoot ?? repositoryDir,
      snippetAliases,
      inlineGate,
      platform,
    )
    // Counted as published only once the page is certain to be (below). A
    // restricted page's text never makes an asset public.
    const publishedText = trackPublishedRefs && !isRestrictedPage ? raw : undefined
    const pageAssetReferences: Array<string> = []
    if (platform === 'fern' || platform === 'mintlify' || platform === 'docusaurus') {
      // A heading's `{#custom-id}` anchor (`## Title {#custom-id}`) crashes
      // `@mdx-js/mdx`'s parser outright, so it must be converted to a
      // preceding `<a id="custom-id"></a>` (see `normalizeExplicitHeadingIds`)
      // before ANY MDX parse of this page is attempted — including
      // `componentMigrator.transform` below, whose own early parse would
      // otherwise choke on it and skip the page's import analysis entirely.
      raw = normalizeExplicitHeadingIds(
        raw,
        (message) => warnings.push({ code: 'invalid-page', message, source: file.relativePath }),
        { headingMarkers: platform === 'mintlify' },
      )
    }
    if (componentMigrator) {
      const warningsBeforeTransform = warnings.length
      raw = componentMigrator.transform(raw, file.absolutePath)
      // `transform` excludes a page itself (pushing a 'skipped-file' warning
      // for it) when it references an unsupported npm import outside JSX —
      // keeping that import would fail `next build` for the whole site. Skip
      // building this page too; `pruneMissingNavigationPages` below drops it
      // from navigation since it never joins `pages`.
      // `warning.source` is relative to `componentRoot`, which can differ
      // from `repositoryDir` (a nested Mintlify/Docusaurus project root);
      // compare absolute paths rather than the two relative forms directly.
      if (warnings.slice(warningsBeforeTransform).some((warning) => warning.code === 'skipped-file' && warning.source !== undefined
        && resolvePath(componentRoot, warning.source) === file.absolutePath)) {
        skipped++
        continue
      }
    }
    // A bare `{word}` in prose (e.g. Infisical's STYLE_GUIDE.md `{x}`) is
    // literal text on Mintlify and Docusaurus too, not just Fern — MDX
    // always evaluates `{...}` as a JS expression, so any platform's source
    // can hit the same `ReferenceError` at render. `escapeFernLiteralBraces`
    // is platform-agnostic (it only reads the page's own AST/ESM scope), so
    // run it for every platform Thally migrates from.
    if (platform === 'fern' || platform === 'mintlify' || platform === 'docusaurus') {
      // Math must be protected before the AST-based brace escaper runs:
      // `$$\begin{align*}...\end{align*}$$` crashes that parser outright
      // (see `protectMathBlocks`), which is what excluded these pages
      // before this ran. The heading-custom-id case that used to be
      // handled at this same point is now converted earlier, above, before
      // `componentMigrator.transform` gets a chance to choke on it too.
      const protectedMath = protectMathBlocks(raw)
      if (protectedMath.guardTriggered) {
        warnings.push({
          code: 'unsupported-config',
          message: 'A suspected math span looked like it needed converting, but doing so broke the page; the page was kept as originally authored instead.',
          source: relative(repositoryDir, file.absolutePath).replace(/\\/g, '/'),
        })
      }
      raw = escapeFernLiteralBraces(protectedMath.body)
    }
    const hasDocusaurusDocCardList = platform === 'docusaurus' && /<DocCardList\b[^>]*\/>/.test(raw)
    if (hasDocusaurusDocCardList) {
      // A plain HTML placeholder survives the generic MDX normalizer while
      // retaining the card list's exact position relative to surrounding prose.
      raw = raw.replace(/<DocCardList\b[^>]*\/>/g, '<div data-thally-doc-card-list="" />')
    }
    let docusaurusDescriptor: Omit<DocusaurusPageDescriptor, 'title'> | undefined
    const page = parseMarkdownPage({
      id,
      navigationId,
      warn: (message) => warnings.push({ code: 'unsupported-config', message, source: relative(repositoryDir, file.absolutePath).replace(/\\/g, '/') }),
      ...(locale ? { locale } : {}),
      raw,
      platform,
      source: `${options.sourceUrl}#${relative(repositoryDir, file.absolutePath).replace(/\\/g, '/')}`,
      ...(platform === 'docusaurus' ? {
        resolveIdentity: (frontmatter, fallback) => {
          const resolved = resolveDocusaurusPageIdentity(file.relativePath, frontmatter, fallback)
          const routePrefix = options.docusaurusRoutePrefix === undefined
            ? undefined
            : trimEdgeSlashes(options.docusaurusRoutePrefix)
          if (!routePrefix) {
            docusaurusDescriptor = resolved.descriptor
            return resolved.identity
          }
          const prefixedNavigationId = resolved.identity.navigationId === 'introduction'
            ? routePrefix
            : `${routePrefix}/${resolved.identity.navigationId}`
          const prefixedStorageId = resolved.identity.id === 'introduction'
            ? routePrefix
            : `${routePrefix}/${resolved.identity.id}`
          docusaurusDescriptor = {
            ...resolved.descriptor,
            navigationId: prefixedNavigationId,
          }
          return {
            ...resolved.identity,
            id: prefixedStorageId,
            navigationId: prefixedNavigationId,
          }
        },
      } : {}),
      // A Fern page's own frontmatter `slug` replaces its whole section/folder
      // hierarchy (never just its own segment) and wins over a docs.yml slug.
      ...(platform === 'fern' ? {
        resolveIdentity: (frontmatter, fallback) => {
          const slug = typeof frontmatter.slug === 'string' ? frontmatter.slug.trim() : ''
          if (!slug) return fallback
          const overridden = pageIdFromReference(slug, true)
          if (!overridden) return fallback
          fernIdRenames.set(fallback.navigationId, overridden)
          return { ...fallback, id: overridden, navigationId: overridden }
        },
      } : {}),
    })
    if (!page) {
      skipped++
      continue
    }
    if (page.frontmatterError) {
      warnings.push({
        code: 'unsupported-config',
        message: `The page's frontmatter is not valid YAML (${page.frontmatterError}); the page was kept and as much of its metadata as could be read was used.`,
        source: relative(repositoryDir, file.absolutePath).replace(/\\/g, '/'),
      })
    }
    if (platform === 'fern' && !page.navTitle) {
      const navTitle = fernNavTitles.get(navigationId)
      if (navTitle && navTitle !== page.title) page.navTitle = navTitle
    }
    if (platform === 'fern' && fernHiddenIds.has(navigationId)) page.hidden = true
    if (platform === 'mintlify' && mintlifyProjectRoot) {
      // Counted as published only once the page is certain to be (below).
      page.body = rewriteRepositoryAssetLinks(page.body, file.absolutePath, mintlifyProjectRoot, (assetPath, onDiskSpelling) => {
        if (isRestrictedPage) withholdAsset(assetPath, onDiskSpelling)
        else pageAssetReferences.push(publicAssetKey(onDiskSpelling ?? assetPath))
      }, (spelled, used) => {
        warnings.push({ code: 'unsupported-config', message: `"${spelled}" was not found beside this page; the file "${used}" in the site root was used instead and will be published.`, source: file.relativePath })
      })
    }
    if (platform === 'fern' && fernProjectRoot) {
      // Fern can keep docs in a sibling `docs/` directory beside `fern/`.
      // The checkout, not the config directory, is the safe asset boundary.
      page.body = rewriteRepositoryAssetLinks(page.body, file.absolutePath, fernProjectRoot, (assetPath) => {
        addAssetReference(assetPath, file.relativePath)
      })
      page.body = rewriteRepositoryAssetLinks(page.body, file.absolutePath, repositoryDir, (assetPath) => {
        addAssetReference(assetPath, file.relativePath)
      })
      page.body = stripFernBasePathFromLinks(page.body, fernBasePath)
      page.body = stripFernBasePathFromLinks(page.body, fernVersionPath)
    }
    if (platform === 'mintlify' || platform === 'docusaurus' || platform === 'fern') {
      // `<Link href="...">` (common Mintlify/Docusaurus prose, e.g. mem0's
      // docs) has no Thally builtin; map it to a plain anchor before the
      // generic unknown-component fallback runs, so a real navigable link
      // survives instead of becoming a `<div>`. Runs on the fully normalized
      // body (after `parseMarkdownPage`'s `normalizeMdx`), so a tag that a
      // platform-specific rename still resolves (Docusaurus `TabItem` ->
      // `Tab`, Mintlify `Warn` -> `Warning`, ...) is never mistaken for
      // unknown. Fern-native components with no Thally equivalent
      // (`Markdown`, `Button`, `Download`, ...) fall into the same generic
      // path below — there is no separate Fern-specific detector, so each
      // unknown tag gets exactly one warning.
      page.body = replaceLinkWithAnchor(page.body)
      // Anything still capitalized and unresolved at this point (not a
      // Thally builtin, not declared/imported by the page, not already
      // handled by componentMigrator's copy/removal above) would otherwise
      // throw "Expected component X to be defined" at render. Warn once per
      // component name and neutralize it: keep a paired tag's children,
      // drop a self-closing one outright.
      page.body = replaceUnknownComponents(page.body, (name) => {
        warnings.push({
          code: 'unsupported-config',
          message: `Unresolved MDX component <${name}> was replaced with a plain <div> (or removed, if self-closing) so the page still builds. It may be a site-authored or third-party implementation; review its source before adding a Thally equivalent.`,
          source: file.relativePath,
        })
      })
    }
    if (platform === 'docusaurus') resolvePageDisplayHeading(page, platform)
    let mdxError = invalidMdxReason(page.body)
    if (mdxError) {
      // Fail closed: only keep a repair that actually compiles.
      const repaired = escapeUnmatchedClosingTags(page.body)
      if (repaired.lines.length > 0 && invalidMdxReason(repaired.body) === null) {
        page.body = repaired.body
        mdxError = null
        warnings.push({
          code: 'unsupported-config',
          message: `Escaped unmatched closing tag(s) on line ${repaired.lines.join(', ')} so the page compiles; they render as literal text.`,
          source: file.relativePath,
        })
      }
    }
    if (mdxError) {
      skipped++
      warnings.push({
        code: 'skipped-file',
        message: `Page was excluded because it does not compile as MDX: ${mdxError}`,
        source: file.relativePath,
      })
      continue
    }
    const unresolvedModules = unresolvedRelativeModuleSpecifiers(page.body)
    if (unresolvedModules.length > 0) {
      skipped++
      warnings.push({
        code: 'skipped-file',
        message: `Page was excluded because it imports ${unresolvedModules.map((specifier) => `"${specifier}"`).join(', ')}, which is not copied by the migration `
          + 'and would break the site build. Copy that file in manually or remove the import, then add the page back.',
        source: file.relativePath,
      })
      continue
    }
    // `hasAnyFunctionValuedProp` only proves a function value (a reference to
    // a page-declared function, or a function written inline) is passed as
    // *some* JSX prop; it does not know which tag receives it. A prop
    // landing on a component this migration actually extracted as
    // 'use client' (`Migrated<hash>`/`Inline<n>`) or on a Thally runtime
    // built-in already backed by a 'use client' module (`Accordion`, `Panel`,
    // `Tabs`, ... — see `CLIENT_BUILTIN_COMPONENT_TAGS` in components.ts) is
    // confirmed to cross the server/client boundary and throw at render — a
    // prop on any other tag (an unregistered/removed component) is not
    // confirmed either way, so exclusion (a last resort) is reserved for the
    // confirmed case; the unconfirmed case is warned instead, so it is never
    // silently dropped or silently shipped broken.
    const declaredNames = functionDeclaredNames(page.body)
    if (hasAnyFunctionValuedProp(page.body, declaredNames)) {
      if (propsTargetExtractedClientComponent(page.body, declaredNames)) {
        skipped++
        warnings.push({
          code: 'skipped-file',
          message: "This page passes a function to an interactive component, which can't be rendered on the server. "
            + 'Move the function into the component or edit the page manually.',
          source: file.relativePath,
        })
        continue
      }
      warnings.push({
        code: 'unsupported-config',
        message: "This page might pass a function to an interactive component, which can't be rendered on the "
          + 'server; review it manually if the built page fails to render.',
        source: file.relativePath,
      })
    }
    if (declarationsReferenceBrowserGlobal(page.body)) {
      warnings.push({
        code: 'unsupported-config',
        message: "This page defines a component that uses `document`/`window`, which isn't available when pages "
          + 'are rendered on the server. Move that code into a client component or edit the page manually.',
        source: file.relativePath,
      })
    }
    if (seenPageIds.has(page.id)) {
      skipped++
      warnings.push({ code: 'collision', message: `Multiple source files map to ${page.id}; the first file was kept.`, source: file.relativePath })
      continue
    }
    seenPageIds.add(page.id)
    if (pageGate?.access?.groups) page.groups = pageGate.access.groups
    if (pageGate?.access?.isPublic !== undefined) page.public = pageGate.access.isPublic
    pages.push(page)
    if (isRestrictedPage) restrictedPages.add(page)
    for (const assetPath of pageAssetReferences) addAssetReference(assetPath, file.relativePath)
    if (publishedText !== undefined) addPathReferences(publishedText, posix.dirname(file.relativePath).replace(/^\.$/, ''), publishedExact, publishedLoose, docusaurusPaths(posix.join(docusaurusDocsPrefix, posix.dirname(file.relativePath))))
    // MDX normalization removes DocCardList because Thally has no matching
    // component. Remember its authored route so the resolved sidebar can
    // supply the cards once every page and category has been discovered.
    if (hasDocusaurusDocCardList) {
      docusaurusDocCardRoutes.add(page.navigationId)
    }
    if (platform === 'mintlify') {
      const sourcePath = exactReferenceKey(file.relativePath)
      // Only literal portable paths become Next redirects: source filenames
      // must never introduce route patterns such as `:param` or wildcards.
      if (sourcePath !== page.id && /^[A-Za-z0-9_./-]+$/.test(sourcePath)) {
        routeAliases.push({ source: `/${sourcePath}`, destination: `/${page.id}`, permanent: false })
      }
      // The default version's own pages are also linked without the
      // version segment (the live Mintlify site 307s such a link to the
      // versioned page) — add the matching alias so those in-repo links
      // resolve instead of dead-ending. See `mintlifyDefaultVersionPrefixes`.
      const versionPrefix = [...defaultVersionPrefixes].find((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`))
      if (versionPrefix) {
        const unversioned = sourcePath.slice(versionPrefix.length).replace(/^\/+/, '')
        if (unversioned && unversioned !== sourcePath && unversioned !== page.id
          && /^[A-Za-z0-9_./-]+$/.test(unversioned)
          && !routeAliases.some((redirect) => redirect.source === `/${unversioned}`)) {
          routeAliases.push({ source: `/${unversioned}`, destination: `/${page.id}`, permanent: false })
        }
      }
    }
    if (docusaurusDescriptor) {
      if (docusaurusDescriptor.unlisted) page.hidden = true
      docusaurusDescriptors.push({ ...docusaurusDescriptor, title: page.title })
    }
  }

  const discoveredReferenceKeys = new Set(files.map((file) => normalizedReferenceKey(file.relativePath)))
  for (const [key] of referenceMap) {
    if (!discoveredReferenceKeys.has(key)) {
      warnings.push({ code: 'missing-page', message: 'A navigation entry did not resolve to a source page.', source: key })
    }
  }

  const docusaurusAssetRoot = docusaurusProjectRoot ?? repositoryDir
  const fernBrandAssetPaths = new Map<string, string>()
  const fernReferencedAssets: Array<ScannedFile> = []
  if (platform === 'fern' && fernProjectRoot) {
    const seen = new Set<string>()
    const addFernAsset = (candidate: string, source?: string): void => {
      try {
        const absolutePath = source
          ? resolveWithinRoot(fernProjectRoot, source.replace(/^\/+/, ''), repositoryDir)
          : resolveWithin(repositoryDir, candidate)
        if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) return
        const realRoot = realpathSync(repositoryDir)
        const realPath = realpathSync(absolutePath)
        const confined = relative(realRoot, realPath)
        if (confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined)) return
        const withinFern = relative(fernProjectRoot, absolutePath)
        const assetRelative = withinFern !== '..' && !withinFern.startsWith(`..${sep}`) && !isAbsolute(withinFern)
          ? withinFern
          : relative(repositoryDir, absolutePath)
        const assetPath = normalizeAssetPath(assetRelative.replace(/\\/g, '/'))
        if (!assetPath || !ASSET_EXTENSIONS.has(extname(assetPath).toLowerCase())) return
        if (source) {
          fernBrandAssetPaths.set(source, assetPath)
          addAssetReference(assetPath, 'fern/docs.yml')
        }
        if (seen.has(absolutePath)) return
        seen.add(absolutePath)
        fernReferencedAssets.push({ absolutePath, relativePath: assetPath })
      } catch {
        // The existing missing-asset warning names any unresolved brand path.
      }
    }
    for (const path of referencedAssetPaths.keys()) addFernAsset(path)
    for (const value of [fernRawConfig?.logo, fernRawConfig?.favicon]) {
      if (typeof value === 'string') addFernAsset('', value)
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const variants = value as Record<string, unknown>
        for (const candidate of [variants.light, variants.dark, variants.src, variants.srcDark]) {
          if (typeof candidate === 'string') addFernAsset('', candidate)
        }
      }
    }
  }
  const repositoryAssets = platform === 'docusaurus' && configuredDocsDir && !options.docusaurusSkipAssets
    ? ['static', 'public'].flatMap((directory) => {
        const root = resolveWithin(docusaurusAssetRoot, directory)
        if (!existsSync(root) || !lstatSync(root).isDirectory()) return []
        return scanFiles(root, repositoryDir).map((file) => ({
          ...file,
          relativePath: `${directory}/${file.relativePath}`,
        }))
      })
    : []
  interface AssetCandidate { file: ScannedFile; assetPath: string; size: number }
  const assetCandidates: Array<AssetCandidate> = []
  const seenAssetSources = new Map<string, Set<string>>()
  // Mintlify serves every `.css`/`.js` file in its content directory
  // site-wide, plus any font file named by docs.json `fonts.source`.
  const mintlifyFonts = platform === 'mintlify' ? mintlifyFontSources(mintlifyConfig) : []
  const fontRelativePaths = new Set(mintlifyFonts.flatMap((font) => font.path ? [font.path] : []))
  // A `.js` that pages import as a component was copied under src/mdx/migrated;
  // loading it again as a site-wide script would run a module as a plain script.
  const importedComponentSources = new Set((componentMigrator?.files() ?? []).flatMap((file) => {
    const source = /^src\/mdx\/migrated\/[^/]+\/source\/(.+)$/.exec(file.path)?.[1]
    return source ? [resolvePath(repositoryDir, source)] : []
  }))
  // Mintlify loads its root stylesheet implicitly. Project it once, before
  // asset publication, so only URLs retained in authored rules can keep an
  // otherwise withheld asset public. The unfiltered source is never copied.
  const rootStylesheetPath = platform === 'mintlify' && mintlifyProjectRoot
    ? resolveWithin(mintlifyProjectRoot, 'style.css')
    : undefined
  const hasRootStylesheet = Boolean(rootStylesheetPath && existsSync(rootStylesheetPath)
    && lstatSync(rootStylesheetPath).isFile() && !lstatSync(rootStylesheetPath).isSymbolicLink())
  let rootStyleProjection: ReturnType<typeof projectAuthoredStyles> | undefined
  let rootNavbarButtons: ReturnType<typeof navbarLinkButtons> = []
  let rootStyleProblem: 'unsafe' | 'parse' | undefined
  const styleVarSources: Array<{ source: string; vars: ReturnType<typeof cssBrandVars> }> = []
  if (hasRootStylesheet && rootStylesheetPath && lstatSync(rootStylesheetPath).size <= MAX_ASSET_BYTES) {
    const css = readFileSync(rootStylesheetPath, 'utf8')
    // An import may fetch arbitrary CSS; URL schemes that read local files or
    // execute script are not transferable into a public Thally stylesheet.
    // Colours are plain values, safe to read even when the sheet cannot be shipped.
    styleVarSources.push({ source: 'style.css', vars: cssBrandVars(css) })
    if (/@import\b|url\s*\(\s*['"]?\s*(?:javascript:|file:)/i.test(css)) rootStyleProblem = 'unsafe'
    else {
      try {
        rootNavbarButtons = navbarLinkButtons(css)
        rootStyleProjection = projectAuthoredStyles(css, [
          // Restricted pages' markup must not keep a rule (and the image its
          // url() names) public; rules only they use are dropped.
          ...pages.filter((page) => !restrictedPages.has(page)).map((page) => page.body),
          ...(componentMigrator?.files() ?? []).map((file) => typeof file.content === 'string' ? file.content : ''),
          // Site-wide scripts build markup of their own (a CTA card, say) that the stylesheet is meant for.
          ...files.filter((file) => isMintlifyServedScriptOrStyle(file.relativePath) && extname(file.relativePath).toLowerCase() === '.js'
            && lstatSync(file.absolutePath).size <= MAX_PAGE_BYTES).map((file) => readFileSync(file.absolutePath, 'utf8')),
        ])
      } catch {
        rootStyleProblem = 'parse'
      }
    }
  }
  if (trackPublishedRefs && rootStyleProjection?.css) {
    addPathReferences(rootStyleProjection.css, '', publishedExact, publishedLoose)
  }
  const siteAssetPaths = new Map<string, 'style' | 'script' | 'font'>()
  const fontAssetByRelative = new Map<string, string>()
  for (const file of [...files, ...repositoryAssets, ...fernReferencedAssets]) {
    if (rootStylesheetPath && file.absolutePath === rootStylesheetPath) continue
    const firstSegment = file.relativePath.split('/', 1)[0].toLowerCase()
    const siteKind = platform !== 'mintlify' ? undefined
      : fontRelativePaths.has(file.relativePath) ? 'font' as const
        : isMintlifyServedScriptOrStyle(file.relativePath) && !importedComponentSources.has(file.absolutePath)
          ? (extname(file.relativePath).toLowerCase() === '.css' ? 'style' as const : 'script' as const)
          : undefined
    if (!siteKind && !ASSET_EXTENSIONS.has(extname(file.relativePath).toLowerCase())) continue
    if (platform !== 'mintlify' && !ASSET_DIRECTORIES.has(firstSegment)
      && !(platform === 'fern' && referencedAssetPaths.has(file.relativePath))) continue
    const isDocusaurusStatic = platform === 'docusaurus' && firstSegment === 'static'
    const assetPath = normalizeAssetPath(firstSegment === 'public'
      ? file.relativePath.slice('public/'.length)
      : isDocusaurusStatic
        ? file.relativePath.slice('static/'.length)
        : file.relativePath)
    if (!assetPath) continue
    const sourceKey = canonicalPath(file.absolutePath)
    const destinations = seenAssetSources.get(sourceKey) ?? new Set<string>()
    if (destinations.has(assetPath)) continue
    destinations.add(assetPath)
    seenAssetSources.set(sourceKey, destinations)
    if (siteKind) {
      siteAssetPaths.set(assetPath, siteKind)
      if (siteKind === 'font') fontAssetByRelative.set(file.relativePath, assetPath)
    }
    const candidateSize = lstatSync(file.absolutePath).size
    // Site-wide CSS/JS can load images by url(); a published page may use them.
    if (siteKind === 'style' || siteKind === 'script') {
      if (trackPublishedRefs && candidateSize <= MAX_PAGE_BYTES) addPathReferences(readFileSync(file.absolutePath, 'utf8'), posix.dirname(file.relativePath).replace(/^\.$/, ''), publishedExact, publishedLoose)
    }
    assetCandidates.push({ file, assetPath, size: candidateSize })
  }
  // Copy assets that pages actually reference before unreferenced ones, so a
  // tight budget drops decorative/unused files first instead of screenshots
  // a page links to (each group keeps its original scan order).
  const isReferenced = (candidate: AssetCandidate): boolean => referencedAssetPaths.has(candidate.assetPath)
  const orderedAssetCandidates = [
    ...assetCandidates.filter((candidate) => isReferenced(candidate)),
    ...assetCandidates.filter((candidate) => !isReferenced(candidate)),
  ]
  const quarantinedPageCount = quarantinedFiles.length
  // Two files can map to one public path (`logo.png` and `public/logo.png`);
  // only one would survive the copy, so on a site that fails closed neither is
  // trusted to be the one a published page means.
  const destinationCounts = new Map<string, number>()
  for (const { assetPath } of assetCandidates) destinationCounts.set(assetPath, (destinationCounts.get(assetPath) ?? 0) + 1)
  // Fail closed on a site with withheld content: an asset no published page
  // reaches could belong to the gated pages (referenced dynamically, or not
  // tracked), so it stays out of public/. Any mention by a published page, its
  // frontmatter, docs.json, copied CSS/JS or a migrated component keeps it
  // public, but only by the exact destination path it spells (a bare file name
  // never counts: it cannot be told apart from another folder's file).
  // Untrackable, so quarantined: paths built at runtime (template strings,
  // concatenation) and references from remote content.
  // A restricted navigation container (and everything under it) publishes nothing.
  if (trackPublishedRefs) {
    const publishedConfig = platform === 'mintlify'
      ? JSON.stringify(mintlifyConfig ?? {}, (_key, value: unknown) => (
        value && typeof value === 'object' && !Array.isArray(value) && navigationGateReason(value as Record<string, unknown>) ? undefined : value))
      // Branding the migrated config will name: Fern's docs.yml (logo, favicon, ...) and Docusaurus' static site settings.
      : JSON.stringify([docsConfig, docusaurusProjectRoot ? readDocusaurusSiteSettings(docusaurusProjectRoot) : null])
    addPathReferences(publishedConfig, '', publishedExact, publishedLoose, docusaurusPaths(''))
    if (fernRawConfig) addFernConfigPathReferences(fernRawConfig, publishedExact, publishedLoose)
  }
  for (const file of componentMigrator?.files() ?? []) {
    if (!trackPublishedRefs || typeof file.content !== 'string') continue
    // A copied component source resolves relative paths from where it came from.
    const original = /^src\/mdx\/migrated\/[^/]+\/source\/(.+)$/.exec(file.path)?.[1]
    addPathReferences(file.content, original === undefined ? '' : posix.dirname(original).replace(/^\.$/, ''), publishedExact, publishedLoose)
  }
  const failClosedAssets = trackPublishedRefs
  const isPublicReachable = (assetPath: string): boolean => referencedAssetPaths.has(assetPath) || publishedExact.has(assetPath)
  const isQuarantinedAsset = (assetPath: string): boolean => (withheldAssetPaths.has(assetPath) || (failClosedAssets && !siteAssetPaths.has(assetPath)))
    && !(isPublicReachable(assetPath) && !(failClosedAssets && (destinationCounts.get(assetPath) ?? 0) > 1))
  let withheldAssetCount = 0
  let unreferencedAssetCount = 0
  let totalAssetBytes = 0
  // One summary warning per skip reason, not one per file: a repository with
  // hundreds of oversized assets would otherwise bury every other warning.
  const overBudgetAssets: Array<string> = []
  let overBudgetReferenced = 0
  const lfsPointerAssets: Array<string> = []
  const ambiguouslyNamedAssets: Array<string> = []
  for (const { file, assetPath, size } of orderedAssetCandidates) {
    const individualLimit = referencedAssetPaths.has(assetPath) ? MAX_REFERENCED_ASSET_BYTES : MAX_ASSET_BYTES
    if (size > individualLimit || totalAssetBytes + size > MAX_TOTAL_ASSET_BYTES) {
      overBudgetAssets.push(file.relativePath)
      if (referencedAssetPaths.has(assetPath)) overBudgetReferenced++
      continue
    }
    const content = readFileSync(file.absolutePath)
    if (isGitLfsPointer(content)) {
      lfsPointerAssets.push(file.relativePath)
      continue
    }
    if (isQuarantinedAsset(assetPath)) {
      quarantinedFiles.push({ path: `${QUARANTINE_DIRECTORY}/assets/${assetPath}`, content })
      if (looselyNamed(assetPath, publishedLoose) || (destinationCounts.get(assetPath) ?? 0) > 1) ambiguouslyNamedAssets.push(assetPath)
      if (withheldAssetPaths.has(assetPath)) withheldAssetCount++
      else unreferencedAssetCount++
      continue
    }
    assets.push({ path: assetPath, content })
    totalAssetBytes += size
  }
  if (ambiguouslyNamedAssets.length > 0) {
    warnings.push({
      code: 'gated-page',
      message: `${ambiguouslyNamedAssets.length} asset(s) were kept out of public/ because a published page names a file like ${ambiguouslyNamedAssets.length === 1 ? 'it' : 'them'} in a way that does not give its folder (or differs in letter case), so it cannot be matched to one file (or two files share one public path): ${listAssetPaths(ambiguouslyNamedAssets)}. `
        + `Copy any that published pages need from ${QUARANTINE_DIRECTORY}/assets/ into public/ by hand.`,
    })
  }
  if (platform === 'mintlify') {
    const copiedSite = assets.flatMap((asset) => siteAssetPaths.has(asset.path) ? [{ path: asset.path, kind: siteAssetPaths.get(asset.path)! }] : [])
    const scripts = copiedSite.filter((entry) => entry.kind === 'script')
    if (scripts.length > 0) {
      docsConfig = {
        ...docsConfig,
        customScripts: [...(docsConfig.customScripts ?? []), ...scripts.map((entry) => ({ src: `/${entry.path.split('/').map(encodeURIComponent).join('/')}`, strategy: 'afterInteractive' as const }))],
      }
      warnings.push({
        code: 'unsupported-config',
        message: `${scripts.length} script(s) from the content directory (${scripts.map((entry) => entry.path).join(', ')}) now load on every page via docs.json customScripts, as they did on Mintlify. They may target Mintlify's page structure; review them.`,
      })
    }
    for (const entry of copiedSite.filter((item) => item.kind === 'style')) {
      warnings.push({
        code: 'unsupported-config',
        message: `Migration gap: custom stylesheet ${entry.path} is NOT applied. It was copied to public/${entry.path} but was not declared in docs.json stylesheets; its selectors may target Mintlify's markup. Review and port its authored rules into a Thally stylesheet.`,
        source: entry.path,
      })
    }
    for (const font of mintlifyFonts) {
      const copiedPath = font.path ? fontAssetByRelative.get(font.path) : undefined
      const copied = copiedPath !== undefined && assets.some((asset) => asset.path === copiedPath)
      const detail = font.remote
        ? `its source ${font.source} is a remote URL and was not downloaded`
        : !font.path
          ? `its source ${font.source} is not a safe local .woff/.woff2/.ttf/.otf path inside the docs directory and was not imported`
          : !copiedPath
            ? `its source file ${font.source} was not found in the docs directory`
            : copied
              ? `its file was copied to public/${copiedPath}`
              : null
      if (detail === null) continue
      warnings.push({
        code: 'unsupported-config',
        message: `Self-hosted font "${font.family}" is not applied: Thally's fonts setting loads Google Fonts by family only; ${detail}. The family name was still mapped, which loads a Google font of that name if one exists.`,
      })
    }
  }
  if (overBudgetAssets.length > 0) {
    warnings.push({
      code: 'limit-reached',
      message: `${overBudgetAssets.length} asset file${overBudgetAssets.length === 1 ? ' was' : 's were'} not copied because unreferenced files over ${MAX_ASSET_BYTES / 1_000_000} MB, referenced files over ${MAX_REFERENCED_ASSET_BYTES / 1_000_000} MB, or files beyond ${MAX_TOTAL_ASSET_BYTES / 1_000_000} MB in total, are skipped: ${listAssetPaths(overBudgetAssets)}. `
        + (overBudgetReferenced > 0 ? `${overBudgetReferenced} of them ${overBudgetReferenced === 1 ? 'is' : 'are'} used by pages, so those images will be broken until you copy ${overBudgetAssets.length === 1 ? 'it' : 'them'}. ` : '')
        + `Copy ${overBudgetAssets.length === 1 ? 'it' : 'them'} into public/ manually.`,
    })
  }
  if (lfsPointerAssets.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `${lfsPointerAssets.length} asset file${lfsPointerAssets.length === 1 ? ' is a Git LFS pointer' : 's are Git LFS pointers'}, not real content, and ${lfsPointerAssets.length === 1 ? 'was' : 'were'} not copied (Git LFS was skipped during clone because the host has no git-lfs binary): ${listAssetPaths(lfsPointerAssets)}. `
        + 'Install git-lfs and re-run the migration, or copy the real files into public/ manually.',
    })
  }

  // Mintlify loads root style.css implicitly. Keep rules for authored markup,
  // but never ship selectors coupled to Mintlify's private shell classes.
  // Thally owns the navbar, cards and footer through docs.json and its theme.
  if (hasRootStylesheet && rootStylesheetPath && mintlifyProjectRoot) {
    const size = lstatSync(rootStylesheetPath).size
    if (size > MAX_ASSET_BYTES || totalAssetBytes + size > MAX_TOTAL_ASSET_BYTES) {
      warnings.push({ code: 'limit-reached', message: 'Mintlify root style.css exceeded the asset budget and was not imported.', source: 'style.css' })
    } else if (rootStyleProblem === 'unsafe') {
      warnings.push({ code: 'unsupported-config', message: 'Mintlify root style.css contains a CSS import or unsafe URL; review and import it manually.', source: 'style.css' })
    } else if (rootStyleProblem === 'parse' || !rootStyleProjection) {
      // Invalid CSS is reported without breaking an otherwise valid site.
      warnings.push({ code: 'unsupported-config', message: 'Mintlify root style.css could not be parsed and was not imported.', source: 'style.css' })
    } else {
      if (rootNavbarButtons.length > 0 && docsConfig.navbar?.links) {
        docsConfig = {
          ...docsConfig,
          navbar: {
            ...docsConfig.navbar,
            links: docsConfig.navbar.links.map((link) => {
              const rule = rootNavbarButtons.find((entry) => entry.exact ? link.href === entry.href : link.href.includes(entry.href))
              return rule ? { ...link, button: { background: rule.background, ...(rule.color ? { color: rule.color } : {}) } } : link
            }),
          },
        }
      }
      if (rootStyleProjection.omittedSelectors > 0) warnings.push({
        code: 'unsupported-config',
        source: 'style.css',
        message: `Skipped ${rootStyleProjection.omittedSelectors} stylesheet selector${rootStyleProjection.omittedSelectors === 1 ? '' : 's'} that target platform-owned or unreferenced markup. Recreate any intentional shell customization with Thally configuration.`,
      })
      if (rootStyleProjection.css.trim()) {
        const identity = createHash('sha256').update(componentSourceIdentity(options.sourceUrl, repositoryDir, mintlifyProjectRoot)).digest('hex').slice(0, 12)
        const assetPath = `migrated/${identity}/style.css`
        const content = Buffer.from(rootStyleProjection.css)
        assets.push({ path: assetPath, content })
        docsConfig = { ...docsConfig, stylesheets: [...(docsConfig.stylesheets ?? []), `/${assetPath}`] }
        totalAssetBytes += content.length
      }
    }
  }

  // The site's own `--primary*` variables win over docs.json `colors`, as they do
  // in Mintlify, which loads every `.css` file in the content directory.
  if (platform === 'mintlify') {
    for (const file of files) {
      if (!isMintlifyServedScriptOrStyle(file.relativePath) || extname(file.relativePath).toLowerCase() !== '.css'
        || file.absolutePath === rootStylesheetPath) continue
      try {
        if (lstatSync(file.absolutePath).isSymbolicLink() || lstatSync(file.absolutePath).size > MAX_ASSET_BYTES) continue
        styleVarSources.push({ source: file.relativePath, vars: cssBrandVars(readFileSync(file.absolutePath, 'utf8')) })
      } catch {
        // Unreadable stylesheet: skip it, the migration continues without its colours.
      }
    }
  }
  // Merge per variable, so a later file setting only `--primary` keeps an
  // earlier file's `--primary-dark`; then resolve once.
  const mergedVars: { root: BrandVars; dark: BrandVars } = { root: {}, dark: {} }
  const colourSources: Array<string> = []
  for (const { source, vars } of styleVarSources) {
    if (Object.keys(vars.root).length + Object.keys(vars.dark).length > 0) colourSources.push(source)
    Object.assign(mergedVars.root, vars.root)
    Object.assign(mergedVars.dark, vars.dark)
  }
  const styleColors = brandColorsFromVars(mergedVars) ?? {}
  if (styleColors.light || styleColors.dark) {
    docsConfig = {
      ...docsConfig,
      colors: {
        ...docsConfig.colors,
        ...(styleColors.light ? { light: { ...docsConfig.colors?.light, ...styleColors.light } } : {}),
        ...(styleColors.dark ? { dark: { ...docsConfig.colors?.dark, ...styleColors.dark } } : {}),
      },
    }
    warnings.push({
      code: 'unsupported-config',
      source: colourSources.join(', '),
      message: 'Brand colours were taken from the --primary custom properties in the site stylesheets and override docs.json colors.',
    })
  }

  // Ranked discovery gives pages, snippets and assets separate budgets and
  // reports dropped groups itself. A total across those groups is not evidence
  // that the scan stopped early. Only the unranked walk uses this fallback.
  if (!discoveryRank && files.length >= sourceBudget) {
    warnings.push({ code: 'limit-reached', message: `Stopped scanning after ${sourceBudget} files, so the rest of the repository was not looked at. Run the migration on a smaller part of the repository with --docs-dir.` })
  }
  if (platform === 'docusaurus') {
    const projected = projectDocusaurusNavigation({
      sidebars: docusaurusSidebars,
      descriptors: docusaurusDescriptors,
      contentRoot,
      sourceUrl: options.sourceUrl,
      routePrefix: options.docusaurusRoutePrefix,
    })
    docsConfig = projected.docsConfig
    expandDocusaurusDocCardLists(pages, docsConfig, docusaurusDocCardRoutes)
    warnings.push(...projected.warnings)
    for (const page of projected.generatedPages) {
      if (seenPageIds.has(page.id)) continue
      seenPageIds.add(page.id)
      pages.push(page)
    }
    const descriptorByNavigationId = new Map(
      docusaurusDescriptors.map((descriptor) => [descriptor.navigationId, descriptor]),
    )
    const sourceOrigin = docusaurusProjectRoot ? readDocusaurusSiteOrigin(docusaurusProjectRoot) : undefined
    const externalizedLinks = new Set<string>()
    for (const page of pages) {
      const descriptor = descriptorByNavigationId.get(page.navigationId)
      if (descriptor) page.body = rewriteDocusaurusLinks(page.body, descriptor, docusaurusDescriptors, {
        sourceOrigin,
        onExternalLink: (target) => externalizedLinks.add(target),
        assetPaths: new Set(assets.map((asset) => asset.path)),
      })
    }
    if (externalizedLinks.size > 0) warnings.push({
      code: 'unsupported-config',
      message: `${externalizedLinks.size} link(s) outside the imported Docusaurus docs still point to ${sourceOrigin}; migrate those sections separately if this site must be fully independent.`,
    })
    if (docusaurusProjectRoot && !options.docusaurusSkipRedirects) {
      const redirects = readDocusaurusRedirects(docusaurusProjectRoot, warnings)
      if (redirects.length > 0) docsConfig = { ...docsConfig, redirects: [...(docsConfig.redirects ?? []), ...redirects] }
    }
  }
  if (platform === 'fern' && fernIdRenames.size > 0) {
    const renamedRoute = (route: string): string => {
      const renamed = fernIdRenames.get(route.replace(/^\//, ''))
      return renamed ? `/${renamed}` : route
    }
    const renamePages = (nodes: Array<string | MigrationNavigationGroup>): Array<string | MigrationNavigationGroup> =>
      nodes.map((node) => typeof node === 'string'
        ? fernIdRenames.get(node) ?? node
        : { ...node, pages: renamePages(node.pages) })
    for (const page of pages) {
      page.body = rewriteFernIdRenameLinks(page.body, fernIdRenames)
    }
    docsConfig = {
      ...docsConfig,
      tabs: docsConfig.tabs.map((tab) => ({
        ...tab,
        ...(tab.pages ? { pages: renamePages(tab.pages) } : {}),
        ...(tab.groups ? { groups: renamePages(tab.groups) as Array<MigrationNavigationGroup> } : {}),
      })),
      ...(docsConfig.redirects ? {
        redirects: docsConfig.redirects.map((redirect) => ({
          ...redirect,
          source: renamedRoute(redirect.source),
          destination: renamedRoute(redirect.destination),
        })),
      } : {}),
    }
  }
  if (platform === 'fern' && fernSourceLinkAliases.size > 0) {
    const imported = new Set(pages.map((page) => page.id))
    const aliases = new Map([...fernSourceLinkAliases]
      .map(([source, target]) => [source, fernIdRenames.get(target) ?? target] as const)
      .filter(([, target]) => imported.has(target)))
    for (const page of pages) page.body = rewriteFernIdRenameLinks(page.body, aliases)
  }
  if (docsConfig.tabs.length === 0) docsConfig = buildNavigationFromPages(pages)
  if (platform === 'fern' && fernProjectRoot) {
    // A repo-wide scan for *any* `openapi.yml`/`.json` file cannot tell one
    // API's spec from another's, so once an explicit `api-name` names a
    // specific API, that naive scan is never consulted as a fallback (the
    // root `generators.yml` rule is in `fernOpenApiCandidateDirs`). A docs.yml
    // with no `api:` node at all falls back to the naive scan, bound to
    // whatever tab `injectOpenApiSpecs` picks for an unbound spec.
    const sections: Array<{ name?: string; nameExplicit: boolean; tabLabel?: string; routeSegments?: Array<string> }> = fernApiSections.length > 0
      ? fernApiSections
      // Every `api:` node is restricted: none may fall back to a repository-wide spec scan.
      : fernRestrictedApiSections.length > 0 ? [] : [{ nameExplicit: false }]
    const resolvedSpecs: Array<{ filename: string; tabLabel?: string; content: Buffer; routeSegments: Array<string> }> = []
    // Two different multi-API specs commonly share a basename (Paradex's
    // prod_rest and testnet_rest both resolve to their own
    // apis/<name>/openapi/openapi.json) — track which absolute file a
    // filename already names so a second, genuinely different spec gets a
    // distinguishing prefix instead of silently reusing the first spec's
    // copied asset for both tabs.
    const specFilenameSources = new Map<string, string>()
    for (const section of sections) {
      const resolution = findFernConfiguredOpenApi(fernProjectRoot, repositoryDir, section.name, section.nameExplicit, warnings)
      const spec = resolution.spec ?? (!section.nameExplicit ? findOpenApi(files) : null)
      if (spec) {
        let filename = basename(spec.relativePath)
        const existingSource = specFilenameSources.get(filename)
        if (existingSource && existingSource !== spec.absolutePath) {
          const prefix = section.name ? `${section.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-` : `${specFilenameSources.size + 1}-`
          filename = `${prefix}${filename}`
        }
        specFilenameSources.set(filename, spec.absolutePath)
        const specContent = readSpecFile(spec.absolutePath, spec.relativePath, warnings)
        if (!specContent) continue
        if (!assets.some((asset) => asset.path === specAssetPath(filename))) {
          assets.push(specAsset(filename, specContent))
        }
        resolvedSpecs.push({ filename, tabLabel: section.tabLabel, content: specContent, routeSegments: section.routeSegments ?? [] })
        continue
      }
      if (resolution.unsupported.length > 0) {
        const sectionLabel = section.name ? ` for the "${section.name}" API` : ''
        for (const entry of resolution.unsupported) {
          warnings.push({
            code: 'unsupported-config',
            message: `${entry.kind === 'asyncapi' ? 'AsyncAPI' : 'OpenRPC'} is not supported by Thally's API reference; the spec "${entry.path}"${sectionLabel} was not migrated.`,
          })
        }
        continue
      }
      if (section.name === undefined) continue
      if (fernDefinitionExists(fernProjectRoot, section.name)) {
        warnings.push({
          code: 'unsupported-config',
          message: `This API${section.name ? ` ("${section.name}")` : ''} is defined with a Fern Definition, not an OpenAPI/AsyncAPI document; generating a spec from a Fern Definition is not supported. Export an OpenAPI document and reference it from generators.yml, or add it manually.`,
        })
        continue
      }
      // Neither an OpenAPI/AsyncAPI spec nor a Fern Definition could be found
      // for this `api:` node — the API tab was silently dropped from the nav.
      // Name the node so the user knows which one to fix.
      const checked = fernOpenApiCandidateDirs(fernProjectRoot, section.name, section.nameExplicit)
        .map((dir) => relative(repositoryDir, resolvePath(dir, 'generators.yml')).replace(/\\/g, '/'))
      if (!section.nameExplicit) checked.push('any openapi or swagger file in the repository')
      warnings.push({
        code: 'unsupported-config',
        message: checked.length
          ? `No OpenAPI/AsyncAPI spec could be found for the "${section.name}" API. Checked: ${checked.join(', ')}. Point generators.yml at a spec file that exists.`
          : `No OpenAPI/AsyncAPI spec could be found for the "${section.name}" API, because its api-name is not a valid folder name. Add the spec manually.`,
      })
    }
    // An `api:` node under a restricted node publishes nothing. Its spec is saved
    // under the quarantine folder instead, unless a public node uses the same file.
    const publicSpecFiles = new Set(specFilenameSources.values())
    for (const section of fernRestrictedApiSections) {
      const spec = findFernConfiguredOpenApi(fernProjectRoot, repositoryDir, section.name, section.nameExplicit, warnings).spec
        ?? (!section.nameExplicit ? findOpenApi(files) : null)
      if (!spec || publicSpecFiles.has(spec.absolutePath)) continue
      const content = readSpecFile(spec.absolutePath, spec.relativePath, warnings)
      if (!content) continue
      quarantinedFiles.push({ path: `${QUARANTINE_DIRECTORY}/assets/${specAssetPath(basename(spec.relativePath))}`, content })
      warnings.push({
        code: 'gated-page',
        message: `The "${section.name ?? 'API'}" API reference is limited to signed-in roles in Fern, so it was NOT published. Its spec was saved at ${QUARANTINE_DIRECTORY}/assets/${specAssetPath(basename(spec.relativePath))}.`,
        source: spec.relativePath,
      })
    }
    if (resolvedSpecs.length > 0) {
      docsConfig = injectOpenApiSpecs(docsConfig, resolvedSpecs, warnings)
      // Fern serves each api: section's auto-generated operation pages
      // under that section's own route (e.g. "api-reference/messages/...")
      // — the same shape Mintlify's `directory` scoping produces, so the
      // same rewrite applies, keyed by the section's route instead.
      const { operationLinks, prefixLandings } = apiOperationLinkMap(
        resolvedSpecs.map((spec) => ({ filename: spec.filename, content: spec.content, prefix: spec.routeSegments.join('/') })),
        docsConfig,
      )
      rewriteApiLinksInPages(pages, operationLinks, prefixLandings, warnings, { redirects: docsConfig.redirects })
    }
  } else if (platform === 'mintlify') {
    const warnSharedSpec = (path: string, excluded: Array<string> = []): void => {
      warnings.push({ code: 'gated-page', message: sharedSpecMessage(path, excluded), source: path })
    }
    // A spec only restricted pages name is not migrated (the spec is public).
    // Every spec asset of the site is named here, whichever binding asks: a tab, a hidden page-only tab, the repository scan's spec.
    const nameSpec = createSpecAssetNamer()
    const generatedEndpointPages = new Set<MigrationPage>()
    const allSpecs = resolveMintlifyApiSpecs(mintlifyConfig, files, warnings, remoteApiSpecs, nameSpec, pages.filter((page) => !restrictedPages.has(page)), mintlifyApiTabSlots)
    // Operations docs.json lists explicitly stay public like those on published pages. A prefix that fits several specs
    // documents none of them, so it keeps nothing public: a restricted operation is never exposed by an ambiguous page.
    // A bare operation keeps one public only in the spec it belongs to: its navigation container's, or the site's default.
    const navigation = navigationSpecContext(mintlifyConfig, (path) => resolvePageIdentity(path)?.id ?? null)
    const defaultSources = new Set([
      ...allSpecs.filter((spec) => !spec.pageOnly && spec.tabLabel === undefined).map((spec) => spec.sourcePath),
      ...remoteApiSpecs.filter((spec) => spec.tabLabel === undefined).map((spec) => spec.url),
    ])
    const keptOperations = (fallbackSource?: string): ReturnType<typeof keptOperationRefs> => {
      const defaultSpec = defaultSources.size === 0 ? fallbackSource : defaultSources.size === 1 ? [...defaultSources][0] : undefined
      const candidates = fallbackSource ? [{ sourcePath: fallbackSource, filename: basename(fallbackSource) }, ...allSpecs] : allSpecs
      const { kept, unowned } = keptOperationRefs(publishedSpecPages, navigation, defaultSpec, candidates)
      return { kept: kept.filter((ref) => !namesSeveralSpecs(ref, allSpecs)), unowned }
    }
    let { kept: keptSpecRefs, unowned: unownedOperations } = keptOperations()
    const withheldKeys = new Set<string>()
    // Remote specs are downloaded later: carry the operations to withhold from them.
    for (const remote of remoteApiSpecs) {
      const { withheld, kept } = withheldOperationKeys({ sourcePath: remote.url, filename: remote.url }, withheldSpecRefs, keptSpecRefs)
      if (withheld.length > 0) { remote.withheldOperations = withheld; remote.keptOperations = kept }
    }
    const withheldOperations = new Map<ResolvedApiSpec, Array<string>>()
    for (const spec of allSpecs) {
      const result = excludeWithheldOperations(spec, withheldSpecRefs, keptSpecRefs, allSpecs)
      spec.content = result.content
      withheldOperations.set(spec, result.excluded)
      result.excluded.forEach((operation) => withheldKeys.add(operationKey(operation)))
    }
    const resolvedSpecs = allSpecs.filter((spec) => !spec.pageOnly)
    const pageOnlySpecs = allSpecs.filter((spec) => spec.pageOnly)
    for (const spec of resolvedSpecs) {
      if (!assets.some((asset) => asset.path === specAssetPath(spec.filename))) {
        assets.push(specAsset(spec.filename, spec.content))
      }
      if (withheldSpecRefs.some((ref) => specRefMatches(ref, spec.sourcePath, true))) warnSharedSpec(spec.sourcePath, withheldOperations.get(spec))
    }
    let pageSpecs: Array<{ filename: string; sourcePath?: string }> = resolvedSpecs
    if (resolvedSpecs.length > 0) {
      const namedByPages = new Set(pages.filter((page) => !restrictedPages.has(page)).map((page) => specNamedByPage(page.openapi, resolvedSpecs)))
      for (const spec of resolvedSpecs) {
        spec.pageReferenced = namedByPages.has(spec)
        spec.generatedNavigation = Boolean(spec.directory)
          && !publishedSpecRefs.some((ref) => specRefMatches(ref, spec.sourcePath, true))
      }
      // The operations docs.json lists become pages of the tab that listed them; every other spec is bound as an API tab. The API tabs come
      // first, so a spec one of them binds needs no hidden binding for the pages that name it.
      const listingSpecs = resolvedSpecs.filter((spec) => spec.groups && spec.endpointPages)
      const unbound = docsConfig
      docsConfig = injectOpenApiSpecs(docsConfig, resolvedSpecs.filter((spec) => !listingSpecs.includes(spec)), warnings)
      const ledger = createEndpointPageLedger(pages)
      const tabs = docsConfig.tabs.map((tab) => ({ ...tab }))
      const pagesBefore = pages.length
      const endpointSpecs = new Set<ResolvedApiSpec>()
      for (const spec of listingSpecs) {
        if (!spec.groups || !spec.endpointPages) continue
        const added = addEndpointPages({
          tabs,
          pages,
          ledger,
          spec: {
            assetPath: specAssetPath(spec.filename),
            source: spec.sourcePath,
            content: spec.content,
            groups: spec.groups,
            target: spec.endpointPages,
            tabLabel: spec.tabLabel,
            parentTab: spec.parentTab,
            icon: spec.icon,
            hidden: spec.hidden,
          },
        })
        if (!added) continue
        spec.endpointOperations = added.operations
        endpointSpecs.add(spec)
      }
      reportEndpointPages(ledger, warnings)
      for (const spec of resolvedSpecs) if (spec.directoryWarning && !endpointSpecs.has(spec)) warnings.push(spec.directoryWarning)
      // The pages name their spec by where it was saved: the rewrite below is for the prefixes authors wrote.
      for (const page of pages.slice(pagesBefore)) generatedEndpointPages.add(page)
      // A spec whose operations could not become pages is bound as an API tab after all.
      docsConfig = injectOpenApiSpecs({ ...docsConfig, tabs }, listingSpecs.filter((spec) => !endpointSpecs.has(spec)), warnings)
      // A converted spec may no longer be the one the renderer tries first for a bare `openapi:` reference. With remote specs still to bind, hydration decides.
      // The prefix is the source path: the rewrite of authored prefixes below points it at the saved spec.
      if (remoteApiSpecs.length === 0 && endpointSpecs.size > 0) {
        const bySource = new Map(resolvedSpecs.map((spec) => [specAssetPath(spec.filename), spec]))
        qualifyDisplacedBareRefs({
          pages,
          before: specLookupOrder(injectOpenApiSpecs(unbound, resolvedSpecs).tabs, docsConfig.navigation?.versions),
          after: specLookupOrder(docsConfig.tabs, docsConfig.navigation?.versions),
          content: (source) => bySource.get(source)?.content,
          qualifier: (source) => bySource.get(source)?.sourcePath ?? source,
        })
      }
      // A mount whose operations are pages is served by them: only its links need a map, never a redirect.
      const mountOf = (spec: ResolvedApiSpec): { prefix?: string; operations?: Array<string> } => endpointSpecs.has(spec)
        ? { prefix: spec.endpointPages?.directory, operations: spec.endpointOperations }
        : { prefix: spec.directory }
      if (remoteApiSpecs.length > 0) {
        // A remote tab that binds ahead of these shifts their ids, so hydration links every mount, local and remote, once the downloads have settled.
        localApiMounts.push(...resolvedSpecs.flatMap((spec) => {
          const { prefix, operations } = mountOf(spec)
          return prefix ? [{ filename: spec.filename, directory: prefix, ...(spec.tabLabel ? { tab: spec.tabLabel } : {}), ...(operations ? { endpointOperations: operations } : {}) }] : []
        }))
      } else {
        // Mintlify's own endpoint URLs keep working: they have no page of their own here.
        const endpointRedirects = linkApiMounts(
          resolvedSpecs.map((spec) => {
            const { prefix, operations } = mountOf(spec)
            return { filename: spec.filename, content: spec.content, prefix, ...(operations ? { endpointPages: true, operations } : {}), ...(spec.tabLabel ? { tab: spec.tabLabel } : {}) }
          }),
          docsConfig,
          pages,
          warnings,
        )
        if (endpointRedirects.length > 0) docsConfig = { ...docsConfig, redirects: [...(docsConfig.redirects ?? []), ...endpointRedirects] }
      }
    } else {
      // No docs.json-configured spec at all: fall back to a naive repo scan,
      // matching every other platform's baseline behavior.
      const fallback = findOpenApi(files)
      const fallbackContent = fallback ? readSpecFile(fallback.absolutePath, fallback.relativePath, warnings) : undefined
      if (fallback && fallbackContent) {
        const matches = (ref: string): boolean => specRefMatches(ref, fallback.relativePath, true)
        if (withheldSpecRefs.some(matches) && !publishedSpecRefs.some(matches)) {
          // Only restricted pages name this spec, and docs.json does not list it.
          quarantinedFiles.push({ path: `${QUARANTINE_DIRECTORY}/assets/${specAssetPath(basename(fallback.relativePath))}`, content: fallbackContent })
          withheldAssetCount++
        } else {
          const filename = nameSpec({ sourcePath: fallback.relativePath, filename: basename(fallback.relativePath) })
          const fallbackSpec = { sourcePath: fallback.relativePath, filename, content: fallbackContent }
          // The spec found by the scan is the site's default: bare operations belong to it.
          ;({ kept: keptSpecRefs, unowned: unownedOperations } = keptOperations(fallback.relativePath))
          const pruned = excludeWithheldOperations(fallbackSpec, withheldSpecRefs, keptSpecRefs, [fallbackSpec, ...allSpecs])
          pruned.excluded.forEach((operation) => withheldKeys.add(operationKey(operation)))
          if (!assets.some((asset) => asset.path === specAssetPath(filename))) {
            assets.push(specAsset(filename, pruned.content))
          }
          docsConfig = injectOpenApiSpecs(docsConfig, [{ filename }])
          pageSpecs = [{ filename, sourcePath: fallback.relativePath }]
          if (withheldSpecRefs.some(matches)) warnSharedSpec(fallback.relativePath, pruned.excluded)
        }
      }
    }
    // Specs named only by unrestricted pages: copied (and bound to a hidden
    // tab) so those pages render. A spec only restricted pages name never gets
    // here, because restricted pages were left out of `allSpecs` above.
    for (const spec of pageOnlySpecs) {
      if (!assets.some((asset) => asset.path === specAssetPath(spec.filename))) assets.push(specAsset(spec.filename, spec.content))
      if (withheldSpecRefs.some((ref) => specRefMatches(ref, spec.sourcePath, true))) warnSharedSpec(spec.sourcePath, withheldOperations.get(spec))
    }
    if (pageOnlySpecs.length > 0) {
      docsConfig = injectOpenApiSpecs(docsConfig, pageOnlySpecs, warnings)
      pageSpecs = [...pageSpecs, ...pageOnlySpecs]
    }
    const notKeptPublic = [...new Set(unownedOperations.filter((operation) => withheldKeys.has(operationKey(operation))))]
    if (notKeptPublic.length > 0) {
      warnings.push({
        code: 'gated-page',
        message: `${notKeptPublic.length} operation(s) withheld from a published OpenAPI spec (${notKeptPublic.join(', ')}) are also named by a published page or navigation entry that does not say which spec it means, so that reference did not keep them public. Write the spec in its openapi value (for example "openapi.json GET /x") to publish the operation.`,
      })
    }
    const explainMissingSpec = (key: string): string => {
      const fits = resolveSpecRef(key, specFileCandidates(files), false)
      if (fits.kind === 'ambiguous') return `several spec files fit that name (${fits.candidates.map((spec) => spec.sourcePath).join(', ')}); write the full path in the page's openapi frontmatter`
      const sameName = scannedFiles.find((file) => file.relativePath.toLowerCase() === key.toLowerCase())
      if (sameName && sameName.relativePath !== key) return `paths are case-sensitive; the file is at "${sameName.relativePath}"`
      if (sameName && mintignoreMatcher?.ignores(sameName.relativePath)) return 'the file is excluded by .mintignore'
      try { if (lstatSync(resolvePath(repositoryDir, key)).isSymbolicLink()) return 'the file is a symbolic link, which is never followed' } catch { /* missing */ }
      return sameName ? 'the file could not be read as an OpenAPI document' : `no file exists at "${key}"`
    }
    rewriteMintlifyPageSpecRefs(pages.filter((page) => !generatedEndpointPages.has(page)), pageSpecs, new Set(remoteApiSpecs.map((spec) => spec.url)), warnings, explainMissingSpec)
    // Mintlify operation pages carry no "OpenAPI specification" line.
    if (docsConfig.tabs.some((tab) => tab.api)) docsConfig = { ...docsConfig, api: { ...docsConfig.api, specLink: false } }
  }
  if (platform === 'mintlify') {
    const sources = new Set((docsConfig.redirects ?? []).map((redirect) => redirect.source.toLowerCase()))
    // An alias for a path the site serves as a page of its own (the version-less form of a page under the default version, say) would hide that page.
    const served = servedRoutes(pages)
    const aliases = routeAliases.filter((redirect) => !sources.has(redirect.source.toLowerCase()) && !served.has(literalRoute(redirect.source) ?? redirect.source))
    if (aliases.length > 0) docsConfig = { ...docsConfig, redirects: [...(docsConfig.redirects ?? []), ...aliases] }
    docsConfig = addMintlifyHomepageRedirects(addMintlifyDirectoryRedirects(docsConfig, pages), pages)
    // `index.mdx` pages often publish at their parent route while source
    // prose still links to `/docs/<locale>/section/index`. Route aliases are
    // known only after the page loop, so include them in this final rewrite.
    const reachablePaths = new Set([
      ...pages.map((page) => page.id),
      ...(docsConfig.redirects ?? []).map((redirect) => redirect.source.replace(/^\//, '')),
    ])
    for (const page of pages) page.body = rewriteMintlifyMountedLinks(page.body, reachablePaths)
  }

  if (platform === 'docusaurus' && docusaurusProjectRoot && !options.docusaurusSkipPlugins) {
    const additionalRoots: Array<DocusaurusArchiveRoot> = [
      ...additionalDocusaurusPluginRoots(repositoryDir, docusaurusProjectRoot, warnings).map((plugin) => ({
        ...plugin,
        label: plugin.routePrefix.split(/[-_/]/).filter(Boolean)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
      })),
      ...docusaurusArchiveRoots(docusaurusProjectRoot, repositoryDir, warnings),
    ]
    for (const plugin of additionalRoots) {
      if (discovered >= MAX_SOURCE_FILES) {
        warnings.push({ code: 'limit-reached', message: `Stopped importing Docusaurus docs plugins after ${MAX_SOURCE_FILES} files; the remaining plugin docs were not migrated.` })
        break
      }
      if (plugin.docsDir === configuredDocsDir) continue
      const pluginBundle = migrateRepository({
        ...options,
        docsDir: plugin.docsDir,
        platform: 'docusaurus',
        docusaurusRoutePrefix: plugin.routePrefix,
        docusaurusSkipPlugins: true,
        docusaurusSkipSidebar: !plugin.sidebarPath,
        docusaurusSidebarPath: plugin.sidebarPath,
        docusaurusSkipAssets: true,
        docusaurusSkipRedirects: true,
      })
      for (const page of pluginBundle.pages) {
        if (seenPageIds.has(page.id)) {
          skipped++
          warnings.push({ code: 'collision', message: `Docusaurus docs roots both map to ${page.id}; the first page was kept.`, source: page.source })
          continue
        }
        seenPageIds.add(page.id)
        pages.push(page)
      }
      const assetPaths = new Set(assets.map((asset) => asset.path))
      for (const asset of pluginBundle.assets) {
        if (assetPaths.has(asset.path)) continue
        assetPaths.add(asset.path)
        assets.push(asset)
      }
      const pluginLabel = plugin.label
      docsConfig.tabs.push(...pluginBundle.docsConfig.tabs.map((tab, index) => ({
        ...tab,
        tab: index === 0 ? pluginLabel : `${pluginLabel}: ${tab.tab}`,
      })))
      warnings.push(...pluginBundle.warnings)
      discovered += pluginBundle.stats.discovered
      skipped += pluginBundle.stats.skipped
    }
  }

  if (platform === 'docusaurus') {
    // Localized and archived docs are imported as separate roots, often with
    // asset copying disabled. Once all roots are merged, resolve their mounted
    // `/docs/...` references against the assets actually copied by the parent.
    const copiedAssets = new Set(assets.map((asset) => asset.path))
    for (const page of pages) {
      page.body = rewriteDocusaurusLinks(page.body, {
        sourcePath: page.source ?? page.navigationId,
        docId: page.navigationId,
        navigationId: page.navigationId,
        title: page.title,
      }, [], { assetPaths: copiedAssets })
    }
    const importedRoutes = new Set(pages.map((page) => page.navigationId))
    docsConfig.tabs = docsConfig.tabs.map((tab) => {
      if (tab.href) return tab
      const root = tab.tab.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')
      if (!root || !importedRoutes.has(root)) return tab
      // Auto-generated Docusaurus sidebars can sort an `index.mdx` landing
      // page after alphabetic siblings. Keep the actual tab root as the
      // collection destination, and put it first when it is a direct child.
      return {
        ...tab,
        href: `/${root}`,
        ...(tab.pages ? { pages: tab.pages.map((node) => {
          if (typeof node === 'string') return node
          const index = node.pages.indexOf(root)
          return index > 0
            ? { ...node, pages: [root, ...node.pages.filter((page) => page !== root)] }
            : node
        }) } : {}),
        ...(tab.groups ? { groups: tab.groups.map((group) => {
          const index = group.pages.indexOf(root)
          return index > 0
            ? { ...group, pages: [root, ...group.pages.filter((page) => page !== root)] }
            : group
        }) } : {}),
      }
    })
  }

  // Pages skipped above (invalid MDX, a client-boundary function prop, an id
  // collision) never entered `pages`, but the nav was projected from the raw
  // source config and may still reference their ids. Drop those dangling
  // references so `thally check` never reports a nav entry with no MDX file.
  if (platform === 'fern') {
    const byId = new Map(pages.map((page) => [page.navigationId, page]))
    for (const changelog of fernChangelogIndexes) {
      let index = byId.get(changelog.route)
      const entries = changelog.entries
        .map((id) => byId.get(fernIdRenames.get(id) ?? id))
        .filter((page): page is MigrationPage => Boolean(page))
        .slice(0, 10)
      if (entries.length === 0) continue
      if (!index) {
        // A changelog directory may have no overview file at all. Fern still
        // publishes a feed at the tab route, so materialize that route before
        // pruning navigation entries which lack an imported source file.
        index = {
          id: changelog.route,
          navigationId: changelog.route,
          title: 'Release Notes',
          description: 'Latest release notes and product updates.',
          descriptionPlacement: 'body',
          keywords: [],
          body: '',
          source: entries[0].source,
        }
        pages.push(index)
        byId.set(index.navigationId, index)
        docsConfig.redirects = docsConfig.redirects?.filter((redirect) => redirect.source !== `/${changelog.route}`)
      }
      if (index.body.trim()) continue
      // Fern renders changelog directories as a dated feed at the bare tab
      // route. Its `overview.mdx` is often intentionally blank: leaving that
      // page blank strands the release notes even though every entry imports.
      // The feed contains the full articles, including code examples and
      // images. Entry bodies have already gone through normal MDX migration
      // and link/asset rewriting. Pages with module declarations need an
      // excerpt because imports cannot safely be concatenated into one MDX
      // document without renaming all their bindings.
      index.description ||= 'Latest release notes and product updates.'
      index.body = entries.map((entry) => {
        const date = entry.source.match(/\d{4}-\d{2}-\d{2}/)?.[0]
        const escapeText = (value: string): string => value.replace(/([\\{}<>\[\]*_`])/g, '\\$1')
        // The runtime wraps headings in their own permalink anchor. A link
        // inside the heading would create nested anchors and break hydration.
        const body = /^(?:import|export)\s.+(?:from\s|\{)/m.test(entry.body)
          ? escapeText(entry.description)
          : closeOpenCodeFence(date ? addDatedHeadingAliases(entry.body.trim(), date) : entry.body.trim()) || escapeText(entry.description)
        const dateAnchor = date ? `<a id="${date}T00:00:00.000Z" />\n\n` : ''
        return `${dateAnchor}## ${escapeText(entry.title)}\n\n${date ? `**${date}** · ` : ''}[Read release note](/${entry.id})\n\n${body}`
      }).join('\n\n---\n\n')
    }
  }
  const importedSourceRefs: Array<{ repo: string; mountPath: string; pages: number }> = []
  const navigationPageIds = (nodes: Array<string | MigrationNavigationGroup>): Array<string> => nodes.flatMap((node) => typeof node === 'string' ? [node] : navigationPageIds(node.pages))
  // Targets a sub-site's root-absolute link can name: its own pages and assets, or the main site's pages, assets and redirects.
  const rootLinkIndex = (): RootLinkIndex => {
    const ids = (entries: Iterable<string>): Set<string> => new Set([...entries].map((entry) => entry.replace(/^\/+/, '')))
    const main = ids([...pages.map((page) => page.id), ...assets.map((asset) => asset.path), ...(docsConfig.redirects ?? []).map((redirect) => redirect.source)])
    return {
      main,
      // Orphan pages (a repo's own `docs/` folder, say) are not sections of the published site; navigation and redirects are.
      sections: new Set([...navigationPageIds([...docsConfig.tabs.flatMap((tab) => [...(tab.pages ?? []), ...(tab.groups ?? [])])]), ...(docsConfig.redirects ?? []).map((redirect) => redirect.source)].map((id) => id.replace(/^\/+/, '').split('/', 1)[0])),
      sub: ids([...activeSourceRefs.flatMap((candidate) => [...candidate.pages.map((page) => page.id), ...candidate.assets.map((asset) => asset.path)])]),
    }
  }
  for (const ref of activeSourceRefs) {
    if (!usedSourceRefs.has(ref)) {
      // A restricted mount already got its own warning; nothing of it is imported.
      if (gatedSourceRepos.has(ref.repo.toLowerCase())) continue
      warnings.push({ code: 'unsupported-config', message: `--source-ref ${ref.repo}=${ref.mountPath} matched no sourceRef in the navigation; nothing was imported for it.` })
      continue
    }
    warnings.push(...ref.warnings)
    const taken = new Set(pages.map((page) => page.id))
    let count = 0
    const unresolvedLinks: Array<string> = []
    const linkIndex = rootLinkIndex()
    const resolveLink = (target: string): string | undefined => mainSiteLinkTarget(target, ref.mountPath, linkIndex, unresolvedLinks)
    for (const sourcePage of ref.pages) {
      const page = { ...sourcePage, body: prefixRootLinks(sourcePage.body, ref.mountPath, resolveLink) }
      if (taken.has(page.id)) {
        warnings.push({ code: 'collision', message: `sourceRef ${ref.repo} page "${page.id}" already exists in this site and was skipped.` })
        continue
      }
      sourceRefPages.push(page)
      count++
    }
    const knownAssets = new Set(assets.map((asset) => asset.path))
    for (const asset of ref.assets) if (!knownAssets.has(asset.path)) sourceRefAssets.push(asset)
    // Pages keep their `<MigratedXXXX/>` tags, so the sub-site's component
    // files and registry entries must ship with them (hash ids avoid clashes).
    // Their root-absolute links and images get the same mount prefix as the page bodies.
    if (ref.componentFiles?.length && componentMigrator) {
      componentMigrator.adopt(ref.componentFiles.map((file) => typeof file.content === 'string' && /\.(?:[cm]?[jt]sx?|mdx)$/.test(file.path) && file.path !== 'src/mdx/custom-components.tsx'
        ? { ...file, content: prefixRootLinks(file.content, ref.mountPath, resolveLink, false) }
        : file))
    }
    importedSourceRefs.push({ repo: ref.repo, mountPath: ref.mountPath, pages: count })
    const unresolved = [...new Set(unresolvedLinks)]
    if (unresolved.length > 0) {
      warnings.push({
        code: 'unsupported-config',
        message: `[${ref.repo}] ${unresolved.length} root-absolute link target${unresolved.length === 1 ? '' : 's'} match no page in the sub-site or the main site and were kept under "${ref.mountPath}": ${unresolved.slice(0, 10).map((target) => stripControlCharacters(target)).join(', ')}${unresolved.length > 10 ? ', …' : ''}.`,
      })
    }
  }
  if (importedSourceRefs.length > 0) {
    warnings.push({ code: 'unsupported-config', message: 'Only the pages and navigation of sourceRef repositories were imported; their branding, colors and redirects were ignored. Root-absolute links inside those pages were prefixed with their mount path unless they name a page of the main site.' })
  }
  docsConfig = pruneMissingNavigationPages(docsConfig, new Set([...pages, ...sourceRefPages].map((page) => page.navigationId)))
  // Sub-site pages joined after the directory pass above, so a mount root
  // (`/client-sdks/typescript`) needs its own redirect to the sub-site's first page, as on Mintlify.
  if (platform === 'mintlify' && sourceRefPages.length > 0) docsConfig = addMintlifyDirectoryRedirects(docsConfig, [...pages, ...sourceRefPages])
  if (platform === 'docusaurus') addDocusaurusTranslatedHeadingAliases(pages)
  if (platform === 'fern' && fernProjectRoot) {
    const sourcePath = (page: MigrationPage): string | null => {
      const fragment = page.source.split('#', 2)[1]
      if (!fragment) return null
      try {
        return relative(fernProjectRoot, resolveWithin(repositoryDir, decodeURIComponent(fragment))).replace(/\\/g, '/')
      } catch {
        return null
      }
    }
    const routes = new Map<string, string>()
    for (const page of pages) {
      const source = sourcePath(page)
      if (source) routes.set(source, page.id)
    }
    for (const page of pages) {
      const source = sourcePath(page)
      if (source) page.body = rewriteFernRelativePageLinks(page.body, source, routes)
    }
  }
  preserveLinkedAnchors(pages)
  if (platform === 'fern' && fernRawConfig) {
    const sourceSiteUrl = fernSourceSiteUrl(fernRawConfig)
    if (sourceSiteUrl) {
      const externalized = new Set<string>()
      const pageIds = new Set(pages.map((page) => page.id))
      for (const page of pages) page.body = externalizeMissingFernLinks(page.body, pageIds, sourceSiteUrl, externalized)
      if (externalized.size > 0) warnings.push({
        code: 'unsupported-config',
        message: `${externalized.size} unresolved Fern link(s) still point to ${sourceSiteUrl}; import those sections separately for a fully independent site.`,
      })
    }
  }
  if (docsConfig.redirects) {
    // Every platform's redirects meet here: none may fail the build, hide a page or loop.
    docsConfig = dropConflictingRedirects(dropUnroutableRedirects(docsConfig, warnings), [...pages, ...sourceRefPages], warnings)
  }
  // A Mintlify page whose frontmatter `url` is another address is a link in the sidebar. Its entry stays in
  // the navigation and every address that opens it redirects there (the home page is served at `/` as well as
  // `/introduction`); the redirect hides the page on purpose, so it skips the pass above. A sourceRef page
  // redirects from its mounted path. A redirect the source site already has for one of those addresses (only
  // `/` can: the pass above drops any other) keeps its place, and a warning says so.
  const redirectSources = new Map((docsConfig.redirects ?? []).map((redirect) => [(redirect.source.replace(/\/+$/, '') || '/').toLowerCase(), redirect.destination]))
  const linkRedirects: Array<{ source: string; destination: string; permanent: false }> = []
  for (const page of [...pages, ...sourceRefPages]) {
    if (!page.externalUrl) continue
    for (const source of pageEntryRoutes(page)) {
      const existing = redirectSources.get(source.toLowerCase())
      if (existing !== undefined) {
        warnings.push({
          code: 'unsupported-config',
          message: `Page "${page.id}" links to ${stripControlCharacters(page.externalUrl)}, but "${source}" already redirects to ${stripControlCharacters(existing)}; that redirect was kept, so "${source}" does not open the link.`,
        })
        continue
      }
      redirectSources.set(source.toLowerCase(), page.externalUrl)
      linkRedirects.push({ source, destination: page.externalUrl, permanent: false })
    }
  }
  if (linkRedirects.length > 0) docsConfig = { ...docsConfig, redirects: [...(docsConfig.redirects ?? []), ...linkRedirects] }

  if (pages.length === 0) {
    const reasons = warnings.map((warning) => warning.message)
    throw new Error(reasons.length
      ? `No importable Markdown or MDX pages were found in the repository. Warnings encountered during migration:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`
      : 'No importable Markdown or MDX pages were found in the repository.')
  }
  // Redirects and branding are global site config, extracted once at the
  // top-level Docusaurus call — `docusaurusSkipRedirects` already marks the
  // recursive per-plugin-instance sub-calls (community/mcp/agent-cli), which
  // would otherwise redundantly re-read (and re-warn about) the same config.
  const isTopLevelDocusaurus = platform === 'docusaurus' && docusaurusProjectRoot && !options.docusaurusSkipRedirects
  const docusaurusSettings = isTopLevelDocusaurus
    ? readDocusaurusSiteSettings(docusaurusProjectRoot!)
    : undefined
  const presentation = docusaurusSettings ? readDocusaurusPresentation(docusaurusProjectRoot!) : undefined
  if (docusaurusSettings) {
    if (presentation) {
      assets.push({ path: '_thally/source-theme.css', content: Buffer.from(presentation.css) })
      docsConfig = { ...docsConfig, stylesheets: [...(docsConfig.stylesheets ?? []), '/_thally/source-theme.css'], ...(presentation.headingFont ? { fonts: { ...docsConfig.fonts, heading: { family: presentation.headingFont, weight: ['400', '500', '600', '700'] } } } : {}) }
      if (presentation.unresolved) warnings.push({ code: 'unsupported-config', message: 'Docusaurus Sass/Tailwind theme values could not be resolved statically; provide compiled build/assets/css/styles.*.css to retain those colors.' })
    }
    if (docusaurusSettings.banner) docsConfig = { ...docsConfig, banner: docusaurusSettings.banner }
    const importedRoutes = new Set(pages.map((page) => page.navigationId))
    const sourceOrigin = readDocusaurusSiteOrigin(docusaurusProjectRoot!)
    const externalized = new Set<string>()
    const projectLink = (raw: string, sourceLiteral = false): string | undefined => {
      if (/^https?:\/\//i.test(raw)) return raw
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw) || raw.includes('\\')) return undefined
      const suffixAt = raw.search(/[?#]/)
      const path = suffixAt < 0 ? raw : raw.slice(0, suffixAt)
      const suffix = suffixAt < 0 ? '' : raw.slice(suffixAt)
      const route = path.replace(/^\.?\//, '').replace(/\/+$/, '')
      if (route === '..' || route.startsWith('../') || route.includes('/../')) return undefined
      const docsBase = docusaurusSettings.docsRouteBasePath.replace(/^\/+|\/+$/g, '')
      // Literal site links are routes in Docusaurus' URL space. A docs page
      // called "blog" must not capture the site's separate /blog section
      // when docs are mounted below /docs.
      const isOutsideDocs = sourceLiteral && docsBase
        && route !== docsBase && !route.startsWith(`${docsBase}/`)
      if (isOutsideDocs && sourceOrigin) {
        externalized.add(raw)
        return new URL(raw, `${sourceOrigin}/`).toString()
      }
      const strippedDocsRoute = docsBase && route.startsWith(`${docsBase}/`)
        ? route.slice(docsBase.length + 1) : route
      const candidates = [route, strippedDocsRoute, ...(route === docsBase ? ['introduction'] : [])]
      const imported = candidates.find((candidate) => importedRoutes.has(candidate))
      if (imported) return `/${imported}${suffix}`
      if (sourceOrigin) {
        externalized.add(raw)
        return new URL(raw, `${sourceOrigin}/`).toString()
      }
      return path.startsWith('/') ? `${path}${suffix}` : `/${route}${suffix}`
    }
    const firstNavigationPage = (nodes: Array<string | MigrationNavigationGroup>): string | undefined => {
      for (const node of nodes) {
        if (typeof node === 'string') return node
        const nested = firstNavigationPage(node.pages)
        if (nested) return nested
      }
      return undefined
    }
    const navbarLinks = docusaurusSettings.navbarLinks.flatMap((link) => {
      const docRoute = link.docId && !link.docsPluginId && docusaurusDescriptors.find((page) =>
        page.docId === link.docId)?.navigationId
      const sidebar = link.sidebarId && docsConfig.tabs.find((tab) =>
        tab.tab.toLowerCase() === link.sidebarId!.toLowerCase())
      const sidebarRoute = sidebar && firstNavigationPage(sidebar.pages ?? sidebar.groups ?? [])
      const pluginRoot = link.docsPluginId && importedRoutes.has(link.docsPluginId)
        ? link.docsPluginId : undefined
      const rawHref = link.href ?? (docRoute ? `/${docRoute}` : undefined)
        ?? (pluginRoot ? `/${pluginRoot}` : undefined)
        ?? (sidebarRoute ? `/${sidebarRoute}` : undefined)
        ?? (link.docsPluginId ? `/${link.docsPluginId}` : undefined)
      const href = rawHref && projectLink(rawHref, Boolean(link.href))
      return href ? [{ label: link.label, href }] : []
    })
    const footerLinks = docusaurusSettings.footerLinks?.flatMap((column) => {
      const items = column.items.flatMap((item) => {
        const href = projectLink(item.href, true)
        return href ? [{ label: item.label, href }] : []
      })
      return items.length > 0 ? [{ heading: column.heading, items }] : []
    })
    docsConfig = {
      ...docsConfig,
      ...(navbarLinks.length > 0 ? { navbar: { ...docsConfig.navbar, links: navbarLinks } } : {}),
      ...(footerLinks?.length || docusaurusSettings.copyright ? {
        footer: {
          ...docsConfig.footer,
          ...(footerLinks?.length ? { links: footerLinks } : {}),
          ...(docusaurusSettings.copyright ? { copyright: docusaurusSettings.copyright } : {}),
        },
      } : {}),
    }
    if (externalized.size > 0) warnings.push({
      code: 'unsupported-config',
      message: `${externalized.size} site navigation/footer link(s) point outside the imported docs and were kept on ${sourceOrigin}.`,
    })
  }
  // Dense version menus should fit in one header row. A dozen archived
  // Docusaurus releases otherwise turn the collection tabs into a tall wall
  // above every document.
  if (!docsConfig.navigation?.display && docsConfig.tabs.filter((tab) => !tab.hidden).length > 6) {
    docsConfig = { ...docsConfig, navigation: { display: 'dropdown', ...(docsConfig.navigation?.groupHeadings ? { groupHeadings: docsConfig.navigation.groupHeadings } : {}) } }
  }
  const themeColors = mintlifyConfig
    ? mintlifyThemeColors(mintlifyConfig.colors)
    : fernRawConfig
      ? fernThemeColors(fernRawConfig.colors) ?? (fernRawConfig['global-theme'] === 'nvidia' ? { primary: '#76B900' } : undefined)
      : isTopLevelDocusaurus ? presentation?.colors ?? readDocusaurusThemeColor(docusaurusProjectRoot!) : undefined
  // Brand assets are copied as ordinary public files. Wire only assets that
  // were actually imported; a missing source file must not create a broken
  // header image or favicon. Admin uploads still override these fallbacks.
  const assetPaths = new Set(assets.map((asset) => asset.path))
  const publicBrandPath = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return undefined
    const normalized = fernBrandAssetPaths.get(value) ?? normalizeAssetPath(value)
    return normalized && assetPaths.has(normalized) ? `/${normalized}` : undefined
  }
  const brandVariants = (value: unknown): { light?: string; dark?: string; showTitle?: boolean } => {
    if (typeof value === 'string') return { light: value }
    if (!value || typeof value !== 'object') return {}
    const source = value as Record<string, unknown>
    const light = source.light ?? source.src
    const dark = source.dark ?? source.srcDark
    return {
      ...(typeof light === 'string' ? { light } : {}),
      ...(typeof dark === 'string' ? { dark } : {}),
      ...(typeof source.showTitle === 'boolean' ? { showTitle: source.showTitle } : {}),
    }
  }
  const sourceLogo = mintlifyConfig?.logo ?? fernRawConfig?.logo ?? docusaurusSettings?.logo
  const sourceFavicon = mintlifyConfig?.favicon ?? fernRawConfig?.favicon ?? docusaurusSettings?.favicon
  const logo = brandVariants(sourceLogo)
  const favicon = brandVariants(sourceFavicon)
  // A source can name one asset per colour mode yet ship only one of them. The
  // imported variant then serves both modes (the renderer already falls back
  // dark to light, so only the light slot needs filling); a path that was not
  // imported is never emitted.
  const logoDark = publicBrandPath(logo.dark)
  const logoLight = publicBrandPath(logo.light) ?? logoDark
  const faviconDark = publicBrandPath(favicon.dark)
  const faviconLight = publicBrandPath(favicon.light) ?? faviconDark
  if (logoLight) docsConfig = {
    ...docsConfig,
    navbar: {
      ...docsConfig.navbar,
      logo: {
        light: logoLight,
        ...(logoDark ? { dark: logoDark } : {}),
        showTitle: mintlifyConfig || fernRawConfig ? false : logo.showTitle !== false,
        ...(typeof (fernRawConfig?.logo as Record<string, unknown> | undefined)?.['right-text'] === 'string'
          ? { rightText: String((fernRawConfig!.logo as Record<string, unknown>)['right-text']).trim().slice(0, 40) }
          : {}),
      },
    },
  }
  if (platform === 'docusaurus' && docusaurusSettings?.navbarTitle && !logoLight) {
    // Docusaurus commonly uses a text-only navbar. Its commented-out logo
    // template must not become Thally's unrelated starter leaf mark.
    docsConfig = { ...docsConfig, navbar: { ...docsConfig.navbar, logo: null } }
  }
  if (mintlifyConfig) {
    const analytics = projectMintlifyIntegrations(mintlifyConfig)
    warnings.push(...analytics.warnings)
    if (analytics.integrations) docsConfig = { ...docsConfig, integrations: analytics.integrations }
    const appearance = mintlifyAppearance(mintlifyConfig, warnings)
    if (Object.keys(appearance).length > 0) {
      docsConfig = { ...docsConfig, appearance: { ...docsConfig.appearance, ...appearance } }
    }
    const background = mintlifyConfig.background && typeof mintlifyConfig.background === 'object'
      ? mintlifyConfig.background as Record<string, unknown> : null
    if (background) {
      const decoration = background.decoration
      const image = publicBrandPath(background.image)
      const imageDark = publicBrandPath(background.imageDark)
      const mapped: NonNullable<MigrationDocsConfig['background']> = {
        ...docsConfig.background,
        ...(decoration === 'none' || decoration === 'grid' || decoration === 'gradient' ? { decoration } : {}),
        ...(image ? { image } : {}),
        ...(imageDark ? { imageDark } : {}),
      }
      if (Object.keys(mapped).length > 0) docsConfig = { ...docsConfig, background: mapped }
      // Solid canvas colours ride on the per-mode brand colours (six-digit hex).
      const canvas = background.color && typeof background.color === 'object'
        ? background.color as Record<string, unknown> : {}
      for (const mode of ['light', 'dark'] as const) {
        if (canvas[mode] === undefined) continue
        const hex = typeof canvas[mode] === 'string' ? cssColorToHex(canvas[mode]) : undefined
        if (!hex) {
          warnings.push({
            code: 'unsupported-config',
            message: `background.color.${mode} ${JSON.stringify(canvas[mode])?.slice(0, 40)} is not a hex or rgb() colour (for example #121317) and was dropped, so that mode keeps Thally's default canvas. Use a hex value in docs.json to set it.`,
            source: 'docs.json',
          })
          continue
        }
        docsConfig = {
          ...docsConfig,
          colors: { ...docsConfig.colors, [mode]: { ...docsConfig.colors?.[mode], background: hex } },
        }
      }
    }
  }
  if (platform === 'docusaurus') {
    docsConfig = { ...docsConfig, appearance: { ...docsConfig.appearance, default: docusaurusSettings?.defaultColorMode ?? 'light' } }
  }
  if (faviconLight) docsConfig = {
    ...docsConfig,
    favicon: { light: faviconLight, ...(faviconDark ? { dark: faviconDark } : {}) },
  }
  const notImported = (variants: { light?: string; dark?: string }) =>
    [variants.light, variants.dark].filter((value): value is string => typeof value === 'string' && !publicBrandPath(value))
  const missingLogo = notImported(logo)
  const missingFavicon = notImported(favicon)
  const missingBrand = [...missingLogo, ...missingFavicon]
  // An imported variant exists next to a missing one only when it was substituted for it.
  const substituted = [
    ...(missingLogo.length > 0 && logoLight ? [`logo (${logoLight})`] : []),
    ...(missingFavicon.length > 0 && faviconLight ? [`favicon (${faviconLight})`] : []),
  ].map((asset) => ` The imported ${asset} is used for both light and dark mode.`).join('')
  if (missingBrand.length > 0) warnings.push({
    code: 'unsupported-config',
    message: `Brand asset(s) were referenced but not imported: ${[...new Set(missingBrand)].join(', ')}. Add these files under public/ or update docs.json.${substituted}`,
  })
  const logoHref = sourceLogo && typeof sourceLogo === 'object' ? (sourceLogo as Record<string, unknown>).href : undefined
  if (typeof logoHref === 'string' && logoHref.trim() && logoHref.trim() !== '/') warnings.push({
    code: 'unsupported-config',
    message: `logo.href ${JSON.stringify(logoHref.trim().slice(0, 120))} was dropped: the header logo always links to the docs home page. Add it as a navbar link in docs.json if readers need it.`,
    source: mintlifyConfig ? 'docs.json' : 'docs.yml',
  })
  if (platform === 'mintlify') {
    // Mintlify serves a Markdown mirror of every page by default. The mirror
    // route reads only src/content, the same files the HTML routes serve.
    docsConfig = { ...docsConfig, markdown: { enabled: true } }
    if (restrictedPages.size > 0) {
      const apiNote = [...restrictedPages].some((page) => page.openapi)
        ? ' API operations documented only on restricted pages were withheld from the published OpenAPI spec (specs are not access-controlled), so those pages do not render their endpoint until you restore the operation.'
        : ''
      warnings.push({
        code: 'gated-page',
        message: `${restrictedPages.size} page(s) are restricted with \`groups\`/\`public: false\`. Thally hides them from everyone until you configure reader authentication in docs.json \`auth\` (see /guides/authenticated-docs).${apiNote}`,
      })
    }
    if (quarantinedPageCount > 0 || withheldAssetCount > 0 || unreferencedAssetCount > 0) {
      const assetNote = withheldAssetCount > 0
        ? `${withheldAssetCount} file(s) used only by access-restricted pages were not copied to public/, because public/ is not access-controlled; they are saved under ${QUARANTINE_DIRECTORY}/assets/. Copy them into public/ manually if they may be public, or the restricted pages will show them broken. `
        : ''
      const unreferencedReason = [
        ...(hasWithheldContent ? ['this site has access-restricted content'] : []),
        ...(pagesNotClassified ? ['pages were dropped by the file limit (or the file scan stopped at its cap) and could not all be checked for access restrictions'] : []),
      ].join(' and ')
      const unreferencedNote = unreferencedAssetCount > 0
        ? `${unreferencedAssetCount} unreferenced asset(s) were kept out of public/ because ${unreferencedReason}; review ${QUARANTINE_DIRECTORY}/assets/ and copy any that published pages need. `
        : ''
      warnings.push({
        code: 'gated-page',
        message: (quarantinedPageCount > 0
          ? `${quarantinedPageCount} access-restricted page(s) whose access rules could not be migrated safely were withheld from the published site and saved under ${QUARANTINE_DIRECTORY}/ (local only: git-ignored, never served or deployed). `
          : '')
          + assetNote
          + unreferencedNote
          + 'Assets that published pages also use are still copied to public/. Review them before deciding how to publish or protect that content.',
      })
    }
    // Dashboard-level access control (a private site, SSO, groups) is not in
    // the repository, so every Mintlify migration must be checked by hand.
    warnings.push({
      code: 'gated-page',
      message: (sawPublicTrue ? 'Some pages set `public: true`, which means the source site used Mintlify authentication and every page WITHOUT it was private. ' : '')
        + 'Access control set in the Mintlify dashboard is not visible in the repository. Check the source site\'s dashboard access settings before publishing: until docs.json `auth` is configured, Thally publishes every imported page that has no `groups` or `public: false` to everyone. '
        + 'Confirm nothing here was meant to stay private before deploying.',
    })
  }
  if (typeof fernRawConfig?.['global-theme'] === 'string') warnings.push({
    code: 'unsupported-config',
    message: `Fern global theme ${JSON.stringify(fernRawConfig['global-theme'])} could not be fetched during local migration; local overrides and Thally default styling tokens were applied.`,
    source: 'global-theme',
  })
  if (fernRawConfig?.logo && !fernRawConfig['global-theme'] && !logoLight && !logo.light && !logo.dark) warnings.push({
    code: 'unsupported-config',
    message: 'Fern supplied a logo through its global theme without a local asset; add a logo path to docs.json after import.',
  })
  pages.push(...sourceRefPages)
  assets.push(...sourceRefAssets)
  return {
    sourceUrl: options.sourceUrl,
    sourceKind: 'repository',
    platform,
    pages,
    assets,
    ...(importedSourceRefs.length > 0 ? { sourceRefs: importedSourceRefs } : {}),
    ...(remoteApiSpecs.length > 0 ? { remoteApiSpecs } : {}),
    ...(remoteApiSpecs.length > 0 && localApiMounts.length > 0 ? { localApiMounts } : {}),
    ...(componentMigrator ? { componentFiles: componentMigrator.files() } : {}),
    ...(quarantinedFiles.length > 0 ? { quarantinedFiles } : {}),
    ...(droppedGatedFiles.length > 0 ? { droppedGatedPages: droppedGatedFiles.length } : {}),
    docsConfig,
    ...(mintlifyConfig ? {
      site: {
        ...(typeof mintlifyConfig.name === 'string' ? { name: mintlifyConfig.name } : {}),
        ...(typeof mintlifyConfig.description === 'string' ? { description: mintlifyConfig.description } : {}),
        ...(themeColors ? { colors: themeColors } : {}),
      },
    } : fernRawConfig && (typeof fernRawConfig.title === 'string' || themeColors) ? {
      site: {
        ...(typeof fernRawConfig.title === 'string' ? { name: fernRawConfig.title } : {}),
        ...(themeColors ? { colors: themeColors } : {}),
      },
    } : docusaurusSettings && (docusaurusSettings.name || docusaurusSettings.description || themeColors) ? {
      site: {
        ...(docusaurusSettings.navbarTitle || docusaurusSettings.name ? { name: docusaurusSettings.navbarTitle ?? docusaurusSettings.name } : {}),
        ...(docusaurusSettings.description ? { description: docusaurusSettings.description } : {}),
        ...(themeColors ? { colors: themeColors } : {}),
      },
    } : themeColors ? {
      site: { colors: themeColors },
    } : {}),
    warnings,
    stats: { discovered, imported: pages.length, skipped },
  }
}
