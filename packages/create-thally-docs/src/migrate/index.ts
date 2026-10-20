/**
 * CLI materializer for the shared Thally migration engine. Discovery completes
 * before scaffolding or writing, and every generated path is proven to remain
 * inside the selected project directory.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  cloneGitHubRepository,
  importSourceRef,
  hydrateRemoteApiSpecs,
  hydrateUrlOpenApi,
  migrateUrl,
  runUrlMigration,
  parseGitHubRepositoryUrl,
  sourceRefOversizeReason,
  type MigrationBundle,
  type MigrationDocsConfig,
  type MigrationFetcher,
  type MigrationPlatform,
  type MigrationWarning,
  type SourceRefImport,
  type SourceRefMapping,
  type UrlMigrationRunOptions,
} from '@thallylabs/migrate'

import { pruneMissingSiteLinks } from '../customize.js'
import { findPublicSpecs, shadowNote } from '../public-specs.js'
import { scaffold } from '../scaffold.js'
import { initGit, installDeps } from '../utils.js'
import { terminal } from '../terminal.js'
import { convertRepository, discoverUrl, renderFiles } from '../migration-work.js'
import { validateMigration, type MigrationValidation } from './validate.js'
import { assertMigrationDestination, assertSeparateMigrationDirectories, snapshotLocalMigration } from './local-source.js'
import { migrationExistingConfig } from './into.js'
import { reportUnresolvedMigrationLinks } from './links.js'

export interface MigrateOptions {
  sourceUrl: string
  /** Explicit trusted local CLI capability; never inferred by remote adapters. */
  sourceDirectory?: string
  projectDir: string
  into: boolean
  /** Retained for CLI compatibility; Markdown/MDX imports do not require a key. */
  apiKey?: string
  branch?: string
  docsDir?: string
  projectName?: string
  yes: boolean
  maxPages?: number
  /** Explicit HTTPS specification for a URL-only documentation source. */
  openapiUrl?: string
  /** Explicit source platform selected by an interactive or automated caller. */
  platform?: MigrationPlatform
  /** Optional host fetch boundary; used by Thally Cloud adapters and tests. */
  fetcher?: MigrationFetcher
  /** Enable evidence-bearing browser capture, durable checkpoints and resume. */
  urlMigration?: Omit<UrlMigrationRunOptions, 'sourceUrl'>
  /** Explicitly opt out of content/build gates; the report remains unverified. */
  skipValidation?: boolean
  /** Mintlify `sourceRef` repositories to import, from `--source-ref owner/repo=<path>`. */
  sourceRefs?: Array<SourceRefMapping>
}

export interface MigrateResult {
  pagesWritten: number
  assetsWritten: number
  projectDir: string
  platform: MigrationBundle['platform']
  warnings: Array<MigrationWarning>
  validation: MigrationValidation
  reportPath: string
}

function projectPath(projectDir: string, candidate: string): string {
  return assertMigrationDestination(projectDir, candidate)
}

/**
 * Keep withheld access-restricted pages out of git: the new project is
 * committed by `initGit`, and a public push must not publish them. Appends to
 * (never replaces) an existing .gitignore, once.
 */
function ignoreQuarantineDirectory(projectDir: string): void {
  const ignorePath = projectPath(projectDir, '.gitignore')
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : ''
  // The last matching rule wins in .gitignore: an existing entry only counts if
  // no later `!migration-quarantine` line re-includes the folder.
  const rules = existing.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^!?\/?migration-quarantine(?:\/(?:\*\*?)?)?$/.test(line))
  if (rules.length > 0 && !rules[rules.length - 1].startsWith('!')) return
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  writeFileSync(ignorePath, `${existing}${separator}\n# Access-restricted pages withheld by migration: local only, never commit or deploy\n/migration-quarantine/\n`)
}

function readExistingConfig(projectDir: string): MigrationDocsConfig | undefined {
  const configPath = projectPath(projectDir, 'docs.json')
  if (!existsSync(configPath)) return undefined
  return JSON.parse(readFileSync(configPath, 'utf8')) as MigrationDocsConfig
}

/**
 * Remove content authored by the starter template before materializing a fresh
 * migration. This is intentionally limited to newly scaffolded projects;
 * `--into` imports must never delete files the user already owns.
 */
function resetFreshMigrationContent(projectDir: string): void {
  const contentDirectory = projectPath(projectDir, 'src/content')
  rmSync(contentDirectory, { recursive: true, force: true })
  mkdirSync(contentDirectory, { recursive: true })

  // The scaffold's sample spec is useful for a new blank site but misleading
  // after a migration, which writes any discovered spec below `public/`.
  for (const sampleSpec of ['openapi.yaml', 'openapi.json']) {
    rmSync(projectPath(projectDir, sampleSpec), { force: true })
  }
}

/** Clone each mapped sourceRef repository (github.com only) and prepare it as a sub-site; a failed clone is a warning, not a crash. */
async function fetchSourceRefs(mappings: ReadonlyArray<SourceRefMapping>, warnings: Array<MigrationWarning>): Promise<Array<SourceRefImport>> {
  const imports: Array<SourceRefImport> = []
  for (const mapping of mappings) {
    const root = mkdtempSync(join(tmpdir(), 'thally-source-ref-'))
    try {
      const source = parseGitHubRepositoryUrl(`https://github.com/${mapping.repo}`)
      const tooLarge = await sourceRefOversizeReason(mapping.repo)
      if (tooLarge) throw new Error(tooLarge)
      const cloneDir = join(root, 'repository')
      await cloneGitHubRepository(source, cloneDir, warnings, { skipSubmodules: true })
      imports.push(importSourceRef(mapping, cloneDir))
    } catch (error) {
      warnings.push({ code: 'fetch-failed', message: `sourceRef ${mapping.repo} was not imported: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  return imports
}

async function discoverMigration(options: MigrateOptions): Promise<MigrationBundle> {
  if (options.sourceDirectory) {
    assertSeparateMigrationDirectories(options.sourceDirectory, options.projectDir)
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'thally-local-migrate-'))
    try {
      const snapshot = join(temporaryRoot, 'source')
      snapshotLocalMigration(options.sourceDirectory, snapshot, options.docsDir)
      const bundle = await terminal.step('Converting local documentation', () => convertRepository({
        repositoryDir: snapshot,
        sourceUrl: 'https://local.invalid/selected-directory',
        // Namespace components stably without exposing the private checkout path.
        componentNamespace: `local-${createHash('sha256').update(realpathSync(options.sourceDirectory!)).digest('hex').slice(0, 16)}`,
        docsDir: options.docsDir,
        platform: options.platform,
      }), 'Local documentation converted')
      return hydrateRemoteApiSpecs(bundle, options.fetcher)
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }
  const url = new URL(options.sourceUrl)
  if (url.hostname.toLowerCase() !== 'github.com') {
    if (options.sourceRefs?.length) terminal.warn('--source-ref applies only to GitHub repository sources and was ignored.')
    return terminal.step('Discovering public documentation', () => {
      const discovery = {
        sourceUrl: options.sourceUrl,
        platform: options.platform,
        maxPages: options.maxPages,
        openapiUrl: options.openapiUrl,
      }
      if (options.urlMigration) return runUrlMigration({ ...discovery, fetcher: options.fetcher, ...options.urlMigration }).then((run) => options.openapiUrl ? hydrateUrlOpenApi(run.bundle, options.openapiUrl, options.fetcher) : run.bundle)
      // Host callbacks cannot cross a worker boundary. Normal CLI discovery has
      // no callback, so conversion and per-page normalization can stay off-thread.
      return options.fetcher
        ? migrateUrl({ ...discovery, fetcher: options.fetcher })
        : discoverUrl(discovery)
    }, 'Public documentation discovered')
  }

  const source = parseGitHubRepositoryUrl(options.sourceUrl)
  if (options.branch) source.branch = options.branch
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'thally-migrate-'))
  const cloneDir = join(temporaryRoot, 'repository')
  try {
    const cloneWarnings: Array<MigrationWarning> = []
    await terminal.step(`Cloning ${source.owner}/${source.repo}`, () => cloneGitHubRepository(source, cloneDir, cloneWarnings), 'Source repository cloned')
    const sourceRefs = options.sourceRefs?.length
      ? await terminal.step('Importing sourceRef repositories', () => fetchSourceRefs(options.sourceRefs ?? [], cloneWarnings), 'sourceRef repositories imported')
      : []
    const bundle = await terminal.step('Converting repository documentation', () => convertRepository({
      sourceRefs,
      repositoryDir: cloneDir,
      sourceUrl: options.sourceUrl,
      docsDir: options.docsDir ?? (source.docsDir || undefined),
      platform: options.platform,
    }), 'Repository documentation converted')
    const hydrated = await terminal.step('Loading remote API specifications', () => hydrateRemoteApiSpecs(bundle, options.fetcher), 'Remote API specifications loaded')
    return cloneWarnings.length > 0 ? { ...hydrated, warnings: [...cloneWarnings, ...hydrated.warnings] } : hydrated
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

/**
 * Migrated specs are written outside `public/`, but a spec already there (from
 * an earlier import or an older release) stays served as-is. Never deleted
 * here: list it so the owner can remove it.
 */
function publicSpecWarning(projectDir: string, bundle: MigrationBundle): MigrationWarning | null {
  const { specs, skipped } = findPublicSpecs(projectDir)
  if (specs.length === 0 && skipped.length === 0) return null
  const migrated = new Set(bundle.assets.filter((asset) => asset.projectRelative).map((asset) => basename(asset.path)))
  const lines = [
    ...specs.map((spec) => `${spec.path}${migrated.has(basename(spec.path)) ? ' (same file name as a migrated spec)' : ''}${spec.hasHiddenOperations ? ' (contains x-excluded/x-hidden operations)' : ''}${shadowNote(spec.urlPath) ? ` (answers /${spec.urlPath} in place of the filtered specification)` : ''}`),
    ...skipped.map((path) => `${path} (too large to inspect)`),
  ]
  return {
    code: 'unsupported-config',
    message: `Existing OpenAPI files under public/ are served publicly as-is: ${lines.join('; ')}. Migrated specs are written to openapi/, and re-running migration does not remove old copies from public/. Delete any old copy manually (nothing was deleted), or its hidden operations stay downloadable.`,
  }
}

/** Import a repository, public docs URL, or explicitly trusted local checkout. */
export async function migrateDocs(options: MigrateOptions): Promise<MigrateResult> {
  const projectDir = resolve(options.projectDir)
  assertMigrationDestination(projectDir)
  const bundle = await discoverMigration(options)
  reportUnresolvedMigrationLinks(bundle)

  if (!options.into) {
    terminal.detail('Project', projectDir)
    await scaffold({
      projectDir,
      projectName: options.projectName ?? bundle.site?.name ?? 'My Docs',
      description: bundle.site?.description ?? `Documentation migrated from ${options.sourceDirectory ? basename(resolve(options.sourceDirectory)) : new URL(options.sourceUrl).hostname}`,
      brandPreset: 'primary',
      // Source provenance is not the destination repository. Migrated pages
      // live at new paths, so source URLs cannot power edit/issue actions.
      repoUrl: '',
      doInstall: false,
      colors: bundle.site?.colors,
    })
    resetFreshMigrationContent(projectDir)
    pruneMissingSiteLinks(projectDir, new Set(bundle.pages.map((page) => page.id)))
  } else if (!existsSync(projectDir)) {
    throw new Error(`Project directory "${projectDir}" does not exist. Use without --into to scaffold a new one.`)
  }

  // Preserve portable runtime capabilities, not the starter's sample pages,
  // navigation or locale setup. A source-derived Markdown setting (Mintlify
  // serves .md mirrors by default) wins over the starter's.
  if (!options.into) {
    const starterConfig = readExistingConfig(projectDir)
    if (starterConfig?.markdown) bundle.docsConfig.markdown ??= starterConfig.markdown
    // The starter's "Get started" link points at its sample quickstart. A
    // migrated source without its own primary action must not inherit it.
    if (!bundle.docsConfig.navbar?.primary) {
      bundle.docsConfig.navbar = { ...bundle.docsConfig.navbar, primary: null }
    }
    // An absent locale block invokes the runtime's legacy bilingual fallback.
    // A single-language source must not acquire a phantom translation menu.
    bundle.docsConfig.i18n ??= { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] }
  }

  if (options.into) {
    const stale = publicSpecWarning(projectDir, bundle)
    if (stale) bundle.warnings.unshift(stale)
  }

  const rendered = await terminal.step('Rendering documentation', async () => renderFiles(bundle, {
      existingConfig: options.into ? await migrationExistingConfig(projectDir, readExistingConfig(projectDir), bundle.warnings) : undefined,
      existingComponentRegistry: existsSync(projectPath(projectDir, 'src/mdx/custom-components.tsx'))
        ? readFileSync(projectPath(projectDir, 'src/mdx/custom-components.tsx'), 'utf8')
        : undefined,
  }), 'Documentation rendered')
  const conflicts: string[] = []
  const writable = rendered.filter((file) => {
    const path = projectPath(projectDir, file.path)
    // Config and the component registry use explicit merge policies. All other
    // owner files need a conflict report, never an unconditional replacement.
    if (!options.into || file.path === 'docs.json' || file.path === 'src/mdx/custom-components.tsx' || !existsSync(path)) return true
    if (Buffer.from(readFileSync(path)).equals(Buffer.from(file.content))) return true
    conflicts.push(file.path)
    return false
  })
  const conflictPaths = new Set(conflicts)
  const pagesWritten = bundle.pages.filter((page) => !conflictPaths.has(`src/content/${page.id}.mdx`)).length
  const assetsWritten = bundle.assets.filter((asset) => !conflictPaths.has(asset.projectRelative ? asset.path : `public/${asset.path}`)).length
  if (conflicts.length) bundle.warnings.push({ code: 'unsupported-config', message: `Existing authored files were preserved because imported content conflicts: ${conflicts.join(', ')}. Resolve these files before publishing.` })
  await terminal.step('Writing documentation', async (update) => {
    // Preflight every path before the first write: a late symlink must not leave a partial import.
    for (const file of writable) projectPath(projectDir, file.path)
    projectPath(projectDir, 'migration-report.json')
    if (bundle.quarantinedFiles?.length) projectPath(projectDir, '.gitignore')
    let written = 0
    for (const file of writable) {
      const destination = projectPath(projectDir, file.path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, file.content)
      written += 1
      if (written % 32 === 0) {
        update(`Writing documentation (${written}/${writable.length} files)`)
        await setImmediate()
      }
    }

    if (bundle.quarantinedFiles?.length) ignoreQuarantineDirectory(projectDir)
  }, `Imported ${pagesWritten} pages and ${assetsWritten} assets from ${bundle.platform}`)

  const format = (warning: MigrationWarning): string => `${warning.message}${warning.source ? ` (${warning.source})` : ''}`
  for (const warning of bundle.warnings.filter((item) => item.code !== 'gated-page')) terminal.warn(format(warning))
  // Access-restricted content is a security matter: keep it together, last,
  // and unmistakable so it is not lost among compatibility notes.
  const gatedWarnings = bundle.warnings.filter((item) => item.code === 'gated-page')
  if (gatedWarnings.length > 0) {
    terminal.warn('ACCESS-RESTRICTED CONTENT — review before publishing')
    for (const warning of gatedWarnings) terminal.warn(format(warning))
    if (bundle.droppedGatedPages) {
      terminal.warn(`${bundle.droppedGatedPages} access-restricted page(s) were dropped by the file limit: not published and not saved under migration-quarantine/; recover them from the source repository.`)
    }
    // Quarantined assets may include files the gated pages needed; the dashboard
    // settings are not in the repository. Say both once, only for gated sites.
    if (bundle.quarantinedFiles?.length || gatedWarnings.some((warning) => !/dashboard access settings/i.test(warning.message))) {
      terminal.warn('Before publishing, review migration-quarantine/assets/ and the dashboard access settings of the source site.')
    }
  }

  let installationFailed = false
  // Migration is a developer build workflow for owner-selected project code.
  // Disclose execution without adding another confirmation to that workflow.
  if (!options.skipValidation) terminal.info('Migration validation runs project code locally, including imported MDX and components.')
  if (!options.into && !options.skipValidation) {
    try {
      await installDeps(projectDir)
    } catch (error) {
      const exitCode = (error as Error & { exitCode?: number }).exitCode
      if (exitCode === 130 || exitCode === 143) throw error
      // Imported files and static diagnostics remain useful when a registry or
      // lifecycle step fails. Always produce the same machine-readable report.
      installationFailed = true
    }
  }
  terminal.info('Validating imported documentation...')
  const validation = await validateMigration(projectDir, options.skipValidation, installationFailed)
  if (conflicts.length) {
    validation.content = 'failed'
    validation.messages.push(`${conflicts.length} existing file(s) conflict with imported content; owner files were preserved.`)
  }
  if (bundle.urlMigrationValidation && bundle.urlMigrationValidation.status !== 'passed') {
    validation.content = 'failed'
    validation.messages.push(`Source evidence validation is ${bundle.urlMigrationValidation.status}; ${bundle.urlMigrationValidation.issues.length} issue(s) require review.`)
  }
  // Quarantine holds withheld pages and the assets only they use; count them apart.
  const quarantinedPages = (bundle.quarantinedFiles ?? []).filter((file) => /\.mdx?$/i.test(file.path)).length
  const reportPath = projectPath(projectDir, 'migration-report.json')
  writeFileSync(reportPath, `${JSON.stringify({
    version: 1,
    sourceUrl: options.sourceDirectory ? 'local-directory' : `${new URL(options.sourceUrl).origin}${new URL(options.sourceUrl).pathname}`,
    platform: bundle.platform,
    pages: bundle.pages.length,
    assets: bundle.assets.length,
    pagesWritten,
    assetsWritten,
    components: bundle.componentFiles?.length ?? 0,
    sourceRefs: bundle.sourceRefs ?? [],
    quarantined: quarantinedPages,
    quarantinedAssets: (bundle.quarantinedFiles?.length ?? 0) - quarantinedPages,
    droppedGatedPages: bundle.droppedGatedPages ?? 0,
    warnings: bundle.warnings,
    conflicts,
    validation,
    ...(bundle.urlMigrationValidation ? { sourceValidation: bundle.urlMigrationValidation } : {}),
  }, null, 2)}\n`)
  for (const message of validation.messages) terminal.warn(message)
  terminal.detail('Migration report', reportPath)
  if (validation.content === 'passed' && validation.build === 'passed') {
    terminal.success(`Content and production build passed.${bundle.warnings.length ? ' Review the migration warnings for compatibility limitations.' : ''}`)
  } else {
    terminal.warn('Import retained, but validation is incomplete. Do not publish without reviewing the report.')
  }
  if (!options.into) await initGit(projectDir)
  return {
    pagesWritten,
    assetsWritten,
    projectDir,
    platform: bundle.platform,
    warnings: bundle.warnings,
    validation,
    reportPath,
  }
}
