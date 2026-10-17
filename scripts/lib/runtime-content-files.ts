/**
 * Build-time inventory and static-asset writer for authored runtime content.
 *
 * Managed hosting keeps customer content out of executable Worker modules.
 * This module defines the one file inventory shared by the generated embedded
 * fallback and the immutable assets release, preventing the two delivery
 * paths from silently drifting apart.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseFrontmatter } from '../../src/lib/frontmatter'
import { MAX_SEARCH_SHARD_BYTES, MAX_SEARCH_SHARDS, PREPARED_SEARCH_FORMAT, type PreparedSearchDescriptor, type PreparedSearchRecord } from '../../src/lib/search/prepared-content-contract'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { parseOpenApiFrontmatter } from '../../src/lib/openapi/page-frontmatter'
import { UNPUBLISHED_PAGES_FILE, pageReferenceState, type RoutedSpec } from '../../src/lib/openapi/publication'
import { sanitizeSpecForPublication } from '../../src/lib/openapi/sanitize'
import type { ApiSpecConfig, OpenAPIDocument, OperationOverride } from '../../src/lib/openapi/types'

export interface RuntimeSourceEntry {
  content: string
  modifiedAtMs: number
}

export type RuntimeSourceMap = Record<string, RuntimeSourceEntry>

export interface ContentAssetManifest {
  version: 1
  files: Record<string, { modifiedAtMs: number; sha256: string; searchShard?: number }>
  search?: PreparedSearchDescriptor
}

/** Reserved public directory copied verbatim into OpenNext static assets. */
export const MANAGED_CONTENT_ASSET_DIRECTORY = 'public/_thally/content'

function projectPath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join('/')
}

function addTextFile(
  projectRoot: string,
  sources: RuntimeSourceMap,
  filePath: string,
): void {
  if (!existsSync(filePath)) return
  const stats = lstatSync(filePath)
  if (!stats.isFile()) return
  sources[projectPath(projectRoot, filePath)] = {
    content: readFileSync(filePath, 'utf8'),
    modifiedAtMs: stats.mtimeMs,
  }
}

function isContainedProjectPath(projectRoot: string, filePath: string): boolean {
  const relativePath = path.relative(projectRoot, filePath)
  return (
    relativePath.length > 0 &&
    !path.isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`)
  )
}

interface ConfiguredOpenApiSource {
  source: string
  overrides?: Record<string, OperationOverride>
}

function configuredOpenApiSources(projectRoot: string): Array<ConfiguredOpenApiSource> {
  const docsJsonPath = path.join(projectRoot, 'docs.json')
  if (!existsSync(docsJsonPath)) return []

  const config = JSON.parse(readFileSync(docsJsonPath, 'utf8')) as {
    tabs?: Array<{ api?: { source?: unknown; overrides?: Record<string, OperationOverride> } }>
  }

  const bySource = new Map<string, Array<Record<string, OperationOverride> | undefined>>()
  for (const tab of config.tabs ?? []) {
    const source = tab.api?.source
    if (typeof source !== 'string' || source.startsWith('http://') || source.startsWith('https://')) continue
    bySource.set(source, [...(bySource.get(source) ?? []), tab.api?.overrides])
  }
  return [...bySource].map(([source, list]) => ({ source, overrides: mergeOverrides(list) }))
}

/**
 * Several tabs may bind one spec file with different overrides, but the managed
 * copy exists once. Remove an operation from it only when every tab hides it, so
 * no tab loses an operation it shows; each tab's own overrides still apply at runtime.
 */
function mergeOverrides(
  list: Array<Record<string, OperationOverride> | undefined>,
): Record<string, OperationOverride> | undefined {
  if (list.length === 1) return list[0]
  const merged: Record<string, OperationOverride> = {}
  for (const key of new Set(list.flatMap((overrides) => Object.keys(overrides ?? {})))) {
    const hidden = list.map((overrides) => overrides?.[key]?.hidden)
    if (hidden.every((value) => value === true)) merged[key] = { hidden: true }
    else if (hidden.some((value) => value === false)) merged[key] = { hidden: false }
  }
  return merged
}

/**
 * Managed assets are served verbatim from `/_thally/content/…`, so a spec
 * copied there must already be publication-safe (excluded operations removed).
 * The runtime re-sanitizes on load, which is idempotent.
 */
function addSpecFile(
  projectRoot: string,
  sources: RuntimeSourceMap,
  filePath: string,
  overrides?: Record<string, OperationOverride>,
): void {
  addTextFile(projectRoot, sources, filePath)
  const entry = sources[projectPath(projectRoot, filePath)]
  if (!entry) return
  const isJson = path.extname(filePath).toLowerCase() === '.json'
  let document: unknown
  try {
    document = isJson ? JSON.parse(entry.content) : parseYaml(entry.content)
  } catch (error) {
    // Unfilterable, so it must not ship: it may carry hidden or excluded
    // operations, and managed assets are published as files. The runtime could
    // not load it anyway, so leaving it out loses nothing a reader could see;
    // the build keeps going because the file may be an unused root default.
    delete sources[projectPath(projectRoot, filePath)]
    console.warn(`[thally] OpenAPI source is not valid ${isJson ? 'JSON' : 'YAML'} and was left out of the build: ${projectPath(projectRoot, filePath)} (${(error as Error).message})`)
    return
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    delete sources[projectPath(projectRoot, filePath)]
    console.warn(`[thally] OpenAPI source is not an object and was left out of the build: ${projectPath(projectRoot, filePath)}`)
    return
  }
  const sanitized = sanitizeSpecForPublication(document as OpenAPIDocument, { overrides })
  if (sanitized === document) return
  entry.content = isJson ? `${JSON.stringify(sanitized, null, 2)}\n` : stringifyYaml(sanitized)
}

/**
 * `/openapi.json` and `/openapi.yaml` are route handlers that publish the
 * filtered spec, but the host serves `public/` first: a same-named file there
 * answers instead, raw. Returns those files when filtering would change them.
 */
export function findShadowingPublicSpecs(projectRoot: string): Array<string> {
  const configured = configuredOpenApiSources(projectRoot)
  const shadowing: Array<string> = []
  for (const name of ['openapi.json', 'openapi.yaml']) {
    const filePath = path.join(projectRoot, 'public', name)
    let document: unknown
    try {
      if (!lstatSync(filePath).isFile()) continue
      const raw = readFileSync(filePath, 'utf8')
      document = name.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)
    } catch {
      continue
    }
    if (!document || typeof document !== 'object') continue
    const overrides = configured.find(({ source }) => source === `/${name}` || source === `public/${name}`)?.overrides
    if (sanitizeSpecForPublication(document as OpenAPIDocument, { overrides }) !== document) shadowing.push(`public/${name}`)
  }
  return shadowing
}

export interface UnpublishedOpenApiPage {
  /** Project-relative page file. */
  file: string
  /** Page id, as the docs route and `isDocPublished` key it. */
  id: string
  /** The `openapi:` reference as authored, without quotes. */
  operation: string
  state: 'hidden' | 'excluded'
}

/**
 * The specs the docs route serves operations from, in route order: every
 * visible API tab, the first being the default (src/config/api-reference.ts).
 * A remote or unreadable spec keeps its place with no document.
 */
function loadRoutedSpecs(projectRoot: string): Array<RoutedSpec> {
  const docsJsonPath = path.join(projectRoot, 'docs.json')
  if (!existsSync(docsJsonPath)) return []
  let tabs: Array<{ hidden?: boolean; api?: { source?: unknown; overrides?: Record<string, OperationOverride> } }>
  try {
    tabs = (JSON.parse(readFileSync(docsJsonPath, 'utf8')) as { tabs?: typeof tabs }).tabs ?? []
  } catch {
    return []
  }
  if (!Array.isArray(tabs)) return []
  return tabs
    .filter((tab) => !tab?.hidden && typeof tab?.api?.source === 'string')
    .map((tab, index) => {
      const source = tab.api!.source as string
      const isUrl = /^https?:\/\//i.test(source)
      const config: ApiSpecConfig = {
        id: index === 0 ? 'default' : String(index),
        label: '',
        source: isUrl ? { type: 'url', url: source } : { type: 'file', path: source },
        operationOverrides: tab.api!.overrides,
      }
      if (isUrl) return { config }
      const specPath = source.startsWith('/') ? path.join(projectRoot, 'public', source.slice(1)) : path.join(projectRoot, source)
      try {
        if (!isContainedProjectPath(projectRoot, path.resolve(specPath)) || !lstatSync(specPath).isFile()) return { config }
        const raw = readFileSync(specPath, 'utf8')
        return { config, document: path.extname(specPath).toLowerCase() === '.json' ? JSON.parse(raw) : parseYaml(raw) }
      } catch {
        return { config }
      }
    })
}

/**
 * Pages whose `openapi:` frontmatter resolves only to hidden or excluded
 * operations, judged with the docs route's own lookup (`pageReferenceState`).
 * Such a page is not published: its route 404s and it is left out of every
 * listing. Remote specs cannot be judged here, and unknown operations are not
 * reported.
 */
export function findUnpublishedOpenApiPages(projectRoot: string): Array<UnpublishedOpenApiPage> {
  const specs = loadRoutedSpecs(projectRoot)
  if (specs.length === 0) return []
  const contentRoot = path.join(projectRoot, 'src/content')
  const pages: Array<UnpublishedOpenApiPage> = []
  const scan = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        scan(filePath)
        continue
      }
      if (!entry.isFile() || !/\.mdx?$/.test(entry.name)) continue
      const head = readFileSync(filePath, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
      if (!head || !/^openapi\s*:/m.test(head)) continue
      let reference
      try {
        reference = parseOpenApiFrontmatter((parseYaml(head) as { openapi?: unknown } | null)?.openapi)
      } catch {
        continue
      }
      if (!reference) continue
      const state = pageReferenceState(reference, specs)
      if (state !== 'hidden' && state !== 'excluded') continue
      const relative = path.relative(contentRoot, filePath).split(path.sep).join('/').replace(/\.mdx?$/, '')
      pages.push({
        file: projectPath(projectRoot, filePath),
        id: relative.endsWith('/index') ? relative.slice(0, -'/index'.length) : relative,
        operation: `${reference.specRef ? `${reference.specRef} ` : ''}${reference.method} ${reference.path}`,
        state,
      })
    }
  }
  scan(contentRoot)
  return pages.sort((a, b) => a.file.localeCompare(b.file))
}

function addConfiguredOpenApiFile(
  projectRoot: string,
  sources: RuntimeSourceMap,
  configuredPath: string,
  overrides?: Record<string, OperationOverride>,
): void {
  const filePath = configuredPath.startsWith('/')
    ? path.resolve(projectRoot, 'public', configuredPath.slice(1))
    : path.resolve(projectRoot, configuredPath)

  if (!isContainedProjectPath(projectRoot, filePath)) {
    throw new Error(`Configured OpenAPI source escapes the project: ${configuredPath}`)
  }
  if (!['.json', '.yaml', '.yml'].includes(path.extname(filePath).toLowerCase())) {
    throw new Error(`Configured OpenAPI source has an unsupported extension: ${configuredPath}`)
  }
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new Error(`Configured OpenAPI source is not a regular file: ${configuredPath}`)
  }
  if (!isContainedProjectPath(realpathSync(projectRoot), realpathSync(filePath))) {
    throw new Error(`Configured OpenAPI source resolves outside the project: ${configuredPath}`)
  }

  addSpecFile(projectRoot, sources, filePath, overrides)
}

function walkTextFiles(
  projectRoot: string,
  sources: RuntimeSourceMap,
  directory: string,
  extensions: ReadonlyArray<string>,
): void {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      walkTextFiles(projectRoot, sources, filePath, extensions)
    } else if (
      entry.isFile() &&
      extensions.some((extension) => entry.name.endsWith(extension))
    ) {
      addTextFile(projectRoot, sources, filePath)
    }
  }
}

/**
 * Collect every authored text input required by the deployed docs runtime.
 * Binary public assets are already handled by Next/OpenNext and deliberately
 * stay outside this manifest; file-backed API specs are included explicitly.
 */
export function collectRuntimeContentFiles(projectRoot: string): RuntimeSourceMap {
  const sources: RuntimeSourceMap = {}
  walkTextFiles(projectRoot, sources, path.join(projectRoot, 'src/content'), ['.mdx', '.md'])
  walkTextFiles(projectRoot, sources, path.join(projectRoot, 'snippets'), ['.mdx', '.md'])
  walkTextFiles(projectRoot, sources, path.join(projectRoot, 'public'), [
    '.yaml',
    '.yml',
    '.json',
  ])
  addSpecFile(projectRoot, sources, path.join(projectRoot, 'openapi.yaml'))
  addSpecFile(projectRoot, sources, path.join(projectRoot, 'openapi.yml'))
  addSpecFile(projectRoot, sources, path.join(projectRoot, 'openapi.json'))
  for (const { source, overrides } of configuredOpenApiSources(projectRoot)) {
    addConfiguredOpenApiFile(projectRoot, sources, source, overrides)
  }
  // The copy above is already filtered, so the runtime can no longer tell a
  // withheld operation from a typo: record which pages the build withholds.
  const unpublished = findUnpublishedOpenApiPages(projectRoot).map((page) => page.id)
  if (unpublished.length > 0) {
    sources[UNPUBLISHED_PAGES_FILE] = { content: `${JSON.stringify([...new Set(unpublished)])}\n`, modifiedAtMs: Date.now() }
  }
  addTextFile(projectRoot, sources, path.join(projectRoot, 'docs.json'))
  addTextFile(projectRoot, sources, path.join(projectRoot, 'AGENTS.md'))
  return sources
}

function assertSafeProjectPath(filePath: string): void {
  if (
    !filePath ||
    path.posix.isAbsolute(filePath) ||
    filePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Managed content asset path is unsafe: ${filePath}`)
  }
}

/**
 * Emit the immutable managed-content tree into `public/` before Next builds.
 * OpenNext copies this directory to `.open-next/assets`, where `env.ASSETS`
 * serves it without adding a byte to the executable Worker module graph.
 */
export async function writeManagedContentAssets(
  projectRoot: string,
  sources: Readonly<RuntimeSourceMap>,
): Promise<ContentAssetManifest> {
  const outputRoot = path.join(projectRoot, MANAGED_CONTENT_ASSET_DIRECTORY)
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })

  const manifest: ContentAssetManifest = { version: 1, files: {} }
  for (const [filePath, entry] of Object.entries(sources).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    assertSafeProjectPath(filePath)
    const outputPath = path.join(outputRoot, ...filePath.split('/'))
    mkdirSync(path.dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, entry.content, 'utf8')
    manifest.files[filePath] = { modifiedAtMs: entry.modifiedAtMs, sha256: rawSha256(entry.content) }
  }

  await writePreparedSearchAssets(outputRoot, sources, manifest)

  writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifest)}\n`,
    'utf8',
  )
  return manifest
}

function rawSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Prepare only canonical search text. Entry metadata, visibility, locales and
 * current versions are resolved by the runtime, never frozen in these shards.
 * Limits bound a transfer/decode; oversized records keep the normal parser.
 */
async function writePreparedSearchAssets(outputRoot: string, sources: Readonly<RuntimeSourceMap>, manifest: ContentAssetManifest): Promise<void> {
  // Ordinary monorepo postinstall generates embedded sources before workspace
  // dist exists. Only a managed build needs the published canonical parser.
  const [{ parseMdxContent }, { projectSearchContent }] = await Promise.all([
    import('@thallylabs/core/markdown'), import('@thallylabs/core/search'),
  ])
  const descriptor: PreparedSearchDescriptor = { version: 1, shards: [] }
  const prefix = `{"version":1,"format":${JSON.stringify(PREPARED_SEARCH_FORMAT)},"records":{`
  const suffix = '}}'
  let pairs: Array<{ path: string; json: string }> = []
  let size = Buffer.byteLength(prefix + suffix)
  const flush = (): void => {
    if (!pairs.length) return
    const index = descriptor.shards.length
    const relativePath = `search/${String(index).padStart(4, '0')}.json`
    const body = prefix + pairs.map((pair) => pair.json).join(',') + suffix
    mkdirSync(path.join(outputRoot, 'search'), { recursive: true })
    writeFileSync(path.join(outputRoot, relativePath), body, 'utf8')
    descriptor.shards.push({ path: relativePath, sha256: rawSha256(body), bytes: Buffer.byteLength(body) })
    for (const pair of pairs) manifest.files[pair.path].searchShard = index
    pairs = []
    size = Buffer.byteLength(prefix + suffix)
  }
  for (const filePath of Object.keys(manifest.files)) {
    if (!filePath.startsWith('src/content/') || !filePath.endsWith('.mdx')) continue
    const { content } = parseFrontmatter(sources[filePath].content)
    const record: PreparedSearchRecord = {
      sha256: manifest.files[filePath].sha256,
      content: projectSearchContent(parseMdxContent(content, 'agents')),
    }
    const json = `${JSON.stringify(filePath)}:${JSON.stringify(record)}`
    const bytes = Buffer.byteLength(json)
    if (bytes + Buffer.byteLength(prefix + suffix) > MAX_SEARCH_SHARD_BYTES) continue
    if (size + bytes + (pairs.length ? 1 : 0) > MAX_SEARCH_SHARD_BYTES) flush()
    if (descriptor.shards.length >= MAX_SEARCH_SHARDS) break
    size += bytes + (pairs.length ? 1 : 0)
    pairs.push({ path: filePath, json })
  }
  flush()
  if (descriptor.shards.length) manifest.search = descriptor
}

/** Remove a previous managed tree when switching back to embedded mode. */
export function removeManagedContentAssets(projectRoot: string): void {
  rmSync(path.join(projectRoot, MANAGED_CONTENT_ASSET_DIRECTORY), {
    recursive: true,
    force: true,
  })
}
