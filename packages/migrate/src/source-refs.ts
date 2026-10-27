/**
 * Mintlify `sourceRef` navigation nodes mount the docs of another repository
 * (`{"sourceRef": "owner/repo"}`). The mount path is not derivable from any
 * docs.json, so the caller supplies it with `--source-ref owner/repo=<path>`.
 * The referenced repository is untrusted remote content: it is validated,
 * size-capped, stripped of symlinks and dot-directories, then run through the
 * same repository pipeline as the main site and prefixed with its mount path.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { replaceOutsideCodeAndComments } from './mdx.js'
import { isCloudflareAssetWarning, migrateRepository } from './repository.js'
import type { MigrationAsset, MigrationDocsConfig, MigrationFetcher, MigrationNavigationGroup, MigrationPage, MigrationWarning, RenderedMigrationFile } from './types.js'
import { defaultMigrationFetcher } from './url.js'

/** Per referenced repository: files and bytes under its docs root. Constants on purpose, not configurable. */
export const SOURCE_REF_MAX_FILES = 5_000
export const SOURCE_REF_MAX_BYTES = 50_000_000
/** GitHub reports repository size in KB; a larger repository is refused before it is cloned. */
export const SOURCE_REF_MAX_REPOSITORY_KB = 200_000
const DOCS_JSON_MAX_BYTES = 1_000_000
const MAX_FORWARDED_WARNINGS = 50

/** Strip C0 control characters (except newline and tab) and escape sequences, so a hostile file name cannot rewrite the terminal. */
export function stripControlCharacters(text: string): string {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|.)?/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const MOUNT_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/

/** First mount segments the site already serves (src/app routes, scaffold public/ folders, root files); a mount there would shadow or be shadowed. */
const RESERVED_MOUNT_SEGMENTS: ReadonlySet<string> = new Set([
  'api', 'admin', 'access', 'changelog', '_next', '_thally', 'public', 'static', 'brand', 'fonts', 'images',
  'llms.txt', 'llms-full.txt', 'ai.txt', 'robots.txt', 'sitemap.xml', 'sitemap.ts', 'openapi.json', 'openapi.yaml', 'skill.md', 'icon.png', 'favicon.ico',
])

export interface SourceRefMapping {
  /** `owner/repo`, exactly as written in the source navigation. */
  repo: string
  /** Relative slug path the referenced docs are mounted at, e.g. `client-sdks/typescript`. */
  mountPath: string
}

export interface SourceRefImport extends SourceRefMapping {
  pages: Array<MigrationPage>
  assets: Array<MigrationAsset>
  /** Navigation entries with every page id already prefixed by the mount path. */
  navigation: Array<string | MigrationNavigationGroup>
  /** Custom component files (and registry) the mounted pages' `<MigratedXXXX/>` tags need; merged into the main bundle. */
  componentFiles?: Array<RenderedMigrationFile>
  /** Why the import is empty (or partial), plus forwarded pipeline warnings. */
  warnings: Array<MigrationWarning>
}

/** Parse repeated `owner/repo=mount/path` values; throws on anything unsafe. */
export function parseSourceRefFlags(values: ReadonlyArray<string>): Array<SourceRefMapping> {
  const mappings: Array<SourceRefMapping> = []
  for (const value of values) {
    const separator = value.indexOf('=')
    const repo = separator < 0 ? value : value.slice(0, separator)
    const mountPath = separator < 0 ? '' : value.slice(separator + 1)
    if (!REPO_PATTERN.test(repo) || repo.includes('..') || repo.split('/')[1] === '.' || repo.endsWith('.git')) {
      throw new Error(`--source-ref "${value}": the repository must look like owner/repo.`)
    }
    if (!MOUNT_PATTERN.test(mountPath) || mountPath.split('/').some((segment) => segment === '.' || segment === '..' || segment.startsWith('.'))) {
      throw new Error(`--source-ref "${value}": the mount path must be a relative lowercase slug path such as client-sdks/typescript (no leading slash, no "..").`)
    }
    const reserved = mountPath.split('/')[0]
    if (RESERVED_MOUNT_SEGMENTS.has(reserved)) {
      throw new Error(`--source-ref "${value}": "${reserved}" is used by the site itself; choose another mount path.`)
    }
    for (const earlier of mappings) {
      if (earlier.repo.toLowerCase() === repo.toLowerCase()) throw new Error(`--source-ref: ${repo} is mapped twice.`)
      if (earlier.mountPath === mountPath || earlier.mountPath.startsWith(`${mountPath}/`) || mountPath.startsWith(`${earlier.mountPath}/`)) {
        throw new Error(`--source-ref: mount paths "${earlier.mountPath}" and "${mountPath}" overlap.`)
      }
    }
    mappings.push({ repo, mountPath })
  }
  return mappings
}

/**
 * Why a referenced repository is too large to clone, or null when it is small
 * enough or its size is unknown (GitHub API unreachable, rate-limited or
 * private): an unknown size proceeds, and the post-clone caps still apply.
 */
export async function sourceRefOversizeReason(repo: string, fetcher: MigrationFetcher = defaultMigrationFetcher): Promise<string | null> {
  try {
    const response = await fetcher(new URL(`https://api.github.com/repos/${repo}`), { accept: 'application/vnd.github+json' })
    const size: unknown = (JSON.parse(response.body) as { size?: unknown }).size
    if (typeof size === 'number' && size > SOURCE_REF_MAX_REPOSITORY_KB) {
      return `GitHub reports it as ${Math.round(size / 1000)} MB, over the ${SOURCE_REF_MAX_REPOSITORY_KB / 1000} MB limit for a referenced repository.`
    }
  } catch {
    // Size unknown: clone anyway.
  }
  return null
}

/** The directory holding a Mintlify docs.json: `docs/` first, then the repository root. */
export function findSourceRefDocsRoot(repositoryDir: string): string | null {
  for (const directory of [join(repositoryDir, 'docs'), repositoryDir]) {
    try {
      const config = join(directory, 'docs.json')
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(config).isFile() || lstatSync(config).size > DOCS_JSON_MAX_BYTES) continue
      const parsed: unknown = JSON.parse(readFileSync(config, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'navigation' in parsed) return directory
    } catch {
      // Missing or unparseable: try the next candidate.
    }
  }
  return null
}

/**
 * Remove symlinks and dot-directories (the clone is disposable), then count.
 * Returns an error message when a cap is exceeded: the whole repository is
 * refused rather than imported partially.
 */
function sanitizeAndMeasure(root: string): { removedLinks: number; error?: string } {
  let files = 0
  let bytes = 0
  let removedLinks = 0
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        unlinkSync(path)
        removedLinks++
      } else if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') rmSync(path, { recursive: true, force: true })
        else stack.push(path)
      } else if (entry.isFile()) {
        files++
        bytes += lstatSync(path).size
        if (files > SOURCE_REF_MAX_FILES) return { removedLinks, error: `it has more than ${SOURCE_REF_MAX_FILES} files` }
        if (bytes > SOURCE_REF_MAX_BYTES) return { removedLinks, error: `it is larger than ${SOURCE_REF_MAX_BYTES / 1_000_000} MB` }
      }
    }
  }
  return { removedLinks }
}

/** Page ids, asset paths and redirect sources (no leading slash) used to tell sub-site targets from main-site ones. */
export interface RootLinkIndex {
  /** Mounted paths of every imported sub-site page and asset. */
  sub: ReadonlySet<string>
  /** Main-site page ids, asset paths and redirect sources. */
  main: ReadonlySet<string>
  /** First path segments of the published site (navigation and redirects). */
  sections: ReadonlySet<string>
}

/**
 * A root-absolute link in a sub-site page is resolved against the live site, so
 * it can name a main-site page, optionally behind the site's base path (`/docs/…`).
 * Returns the main-site target, or undefined to keep the link under the mount
 * path; `unresolved` collects targets found in neither place.
 */
export function mainSiteLinkTarget(target: string, mountPath: string, index: RootLinkIndex, unresolved: Array<string>): string | undefined {
  const [, base, tail] = /^([^?#]*)([\s\S]*)$/.exec(target)!
  const key = base.replace(/^\/+|\/+$/g, '')
  if (!key) return undefined
  const has = (set: ReadonlySet<string>, id: string): boolean => set.has(id) || set.has(`${id}/index`)
  if (has(index.sub, `${mountPath}/${key}`)) return undefined
  const found = (id: string): string => `/${id}${base.endsWith('/') ? '/' : ''}${tail}`
  if (has(index.main, key)) return found(key)
  // A base path (`/docs`) is a first segment that is not a section of the main site itself.
  const slash = key.indexOf('/')
  if (slash > 0) {
    const first = key.slice(0, slash)
    const rest = key.slice(slash + 1)
    if (has(index.main, rest) && !index.sections.has(first)) return found(rest)
  }
  unresolved.push(target)
  return undefined
}

/** One root-absolute target of a sub-site page: under the mount path, unless it already is or `resolve` places it elsewhere. */
export function mountedLinkTarget(target: string, mountPath: string, resolve?: (target: string) => string | undefined): string {
  const mounted = `/${mountPath}`
  // A link already under the mount path is left alone: prefixing it again would break it.
  if (target === mounted || ['/', '?', '#'].some((next) => target.startsWith(mounted + next))) return target
  return resolve?.(target) ?? `${mounted}${target}`
}

/**
 * Prefix every root-absolute link/image/asset target in a page body with the mount path, unless `resolve` places it elsewhere.
 * Component source passes `markdown: false` so code that merely resembles a Markdown link is left alone.
 */
export function prefixRootLinks(body: string, mountPath: string, resolve?: (target: string) => string | undefined, markdown = true): string {
  const fix = (target: string): string => mountedLinkTarget(target, mountPath, resolve)
  return replaceOutsideCodeAndComments(body, (text) => text
    .replace(markdown ? /(\]\(<?)(\/(?!\/)[^\s)>]*)/g : /(?!)/g, (_match, before: string, target: string) => `${before}${fix(target)}`)
    .replace(/(\b(?:href|src|to|poster)=(['"]))(\/(?!\/)[^'"\n]*)\2/g, (_match, before: string, quote: string, target: string) => `${before}${fix(target)}${quote}`)
    .replace(/(\b(?:href|src|to|poster)=\{\s*(['"]))(\/(?!\/)[^'"\n]*)\2(\s*\})/g, (_match, before: string, quote: string, target: string, after: string) => `${before}${fix(target)}${quote}${after}`)
    .replace(markdown ? /^(\[[^\]\n]+\]:[ \t]*<?)(\/(?!\/)\S*)/gm : /(?!)/g, (_match, before: string, target: string) => `${before}${fix(target)}`))
}

function prefixNavigation(
  entries: Array<string | MigrationNavigationGroup>,
  mountPath: string,
): Array<string | MigrationNavigationGroup> {
  return entries.map((entry) => typeof entry === 'string'
    ? `${mountPath}/${entry}`
    : { ...entry, pages: prefixNavigation(entry.pages, mountPath) })
}

/** Tabs flatten into groups (one tab: its entries directly); group structure is kept. */
function flattenTabs(config: MigrationDocsConfig): Array<string | MigrationNavigationGroup> {
  const tabs = config.tabs.filter((tab) => !tab.api)
  const entriesOf = (tab: (typeof tabs)[number]): Array<string | MigrationNavigationGroup> => [...(tab.pages ?? []), ...(tab.groups ?? [])]
  if (tabs.length === 1) return entriesOf(tabs[0])
  return tabs.flatMap((tab) => {
    const pages = entriesOf(tab)
    return pages.length === 0 ? [] : [{ group: tab.displayLabel ?? tab.tab, ...(tab.icon ? { icon: tab.icon } : {}), pages }]
  })
}

/**
 * A sub-repository's quarantined files are discarded, so its warnings must not
 * claim they were saved. Rewrites each quarantine wording the pipeline uses.
 */
export function withheldNotSaved(message: string): string {
  return message
    .replace(/ and saved under migration-quarantine\/ \(local only[^)]*\)/g, ' (not saved)')
    .replace(/ and saved under migration-quarantine\/assets\//g, ' (not saved)')
    .replace(/; they are saved under migration-quarantine\/assets\/\. Copy them into public\/ manually if they may be public, or/g, '; they are withheld from the site (not saved). Recover any that may be public from the referenced repository, or')
    .replace(/, so it was NOT published and was not saved under migration-quarantine\/;/g, ', so it was NOT published and is not saved;')
    .replace(/, so it was not copied to migration-quarantine\/;/g, ', so it is not saved;')
    .replace(/The original is saved at migration-quarantine\/[^;]*;/g, 'It is withheld from the site (not saved);')
    .replace(/; review migration-quarantine\/assets\/ and copy any that published pages need\./g, '; they are withheld from the site (not saved).')
    .replace(/Copy any that published pages need from migration-quarantine\/assets\/ into public\/ by hand\./g, 'They are withheld from the site (not saved); recover any that published pages need from the referenced repository.')
    .replace(/migration-quarantine\/\S*/g, 'withheld from the site (not saved)')
}

function empty(mapping: SourceRefMapping, message: string): SourceRefImport {
  return { ...mapping, pages: [], assets: [], navigation: [], warnings: [{ code: 'skipped-file', message: `sourceRef ${mapping.repo} was not imported: ${message}` }] }
}

/**
 * Import one cloned referenced repository as a sub-site under its mount path.
 * `repositoryDir` is a disposable clone: symlinks and dot-directories under
 * its docs root are deleted.
 */
export function importSourceRef(mapping: SourceRefMapping, repositoryDir: string): SourceRefImport {
  const docsRoot = findSourceRefDocsRoot(repositoryDir)
  if (!docsRoot) return empty(mapping, 'no Mintlify docs.json was found in docs/ or at the repository root.')
  const realRoot = realpathSync(docsRoot)
  const fromClone = relative(realpathSync(repositoryDir), realRoot)
  if (fromClone === '..' || fromClone.startsWith(`..${sep}`) || isAbsolute(fromClone)) return empty(mapping, 'its docs directory resolves outside the repository.')
  const measured = sanitizeAndMeasure(realRoot)
  if (measured.error) return empty(mapping, `${measured.error}, over the per-repository limit. Nothing was imported.`)

  const bundle = migrateRepository({
    repositoryDir: realRoot,
    sourceUrl: `https://github.com/${mapping.repo}`,
    docsDir: '',
    platform: 'mintlify',
    componentNamespace: mapping.mountPath,
  })
  const prefix = (message: string): string => `[${mapping.repo}] ${message}`
  // The main migration lists oversized assets itself, once they are mounted and their paths are final.
  const warnings: Array<MigrationWarning> = bundle.warnings.filter((warning) => !/dashboard access settings/i.test(warning.message) && !isCloudflareAssetWarning(warning)).slice(0, MAX_FORWARDED_WARNINGS).map((warning) => ({ ...warning, message: prefix(stripControlCharacters(withheldNotSaved(warning.message))), ...(warning.source ? { source: stripControlCharacters(warning.source) } : {}) }))
  if (bundle.warnings.length > MAX_FORWARDED_WARNINGS) {
    warnings.push({ code: 'unsupported-config', message: prefix(`${bundle.warnings.length - MAX_FORWARDED_WARNINGS} more migration warnings were omitted.`) })
  }
  if (measured.removedLinks > 0) warnings.push({ code: 'skipped-file', message: prefix(`${measured.removedLinks} symbolic link(s) were ignored.`) })
  const dropped = [
    bundle.remoteApiSpecs?.length ? 'remote OpenAPI specs' : '',
    bundle.assets.some((asset) => asset.projectRelative) ? 'local OpenAPI specs' : '',
    bundle.quarantinedFiles?.length || bundle.droppedGatedPages ? 'access-restricted pages' : '',
  ].filter(Boolean)
  if (dropped.length > 0) warnings.push({ code: 'unsupported-config', message: prefix(`Not imported: ${dropped.join(', ')}.`) })

  const mounted = (id: string): string => `${mapping.mountPath}/${id}`
  // Bodies keep their root-absolute links; the main migration prefixes them once it knows the main site's pages.
  const pages = bundle.pages.filter((page) => !page.openapi).map((page) => ({
    ...page,
    id: mounted(page.id),
    navigationId: mounted(page.navigationId),
  }))
  const openApiPages = bundle.pages.length - pages.length
  if (openApiPages > 0) warnings.push({ code: 'skipped-file', message: prefix(`${openApiPages} page(s) bound to an OpenAPI operation were skipped.`) })
  const assets = bundle.assets.filter((asset) => !asset.projectRelative).map((asset) => ({ ...asset, path: mounted(asset.path) }))
  return { ...mapping, pages, assets, ...(bundle.componentFiles?.length ? { componentFiles: bundle.componentFiles } : {}), navigation: prefixNavigation(flattenTabs(bundle.docsConfig), mapping.mountPath), warnings }
}

/** True when the main site already owns the mount path (a directory or a same-named page file). */
export function sourceRefMountCollides(siteRoot: string, mountPath: string): boolean {
  const target = resolve(siteRoot, mountPath)
  return [target, `${target}.md`, `${target}.mdx`].some((candidate) => {
    try {
      lstatSync(candidate)
      return true
    } catch {
      return false
    }
  })
}
