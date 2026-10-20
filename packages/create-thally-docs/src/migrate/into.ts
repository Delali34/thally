/**
 * In-place imports preserve owner content. Only navigation proven against the
 * project's verified immutable starter archive is eligible for replacement.
 * An unavailable archive leaves navigation intact and becomes a review note.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { MigrationDocsConfig, MigrationWarning } from '@thallylabs/migrate'
import { downloadStarter } from '../download.js'
import { resolveStarterUpdateBase } from '../starter-update.js'
import { areStarterFileContentsEquivalent } from '../starter-file-comparison.js'
import { assertMigrationDestination } from './local-source.js'

function seedFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('Starter seed content contains a symbolic link.')
    const path = join(directory, entry.name)
    return entry.isDirectory() ? seedFiles(path) : entry.isFile() ? [path] : []
  })
}

/** Read every candidate once: the exact compared bytes become mutation preconditions. */
function untouchedSeedFiles(projectDir: string, baselineDir: string, existing: MigrationDocsConfig): Map<string, Buffer> | undefined {
  const baseline: MigrationDocsConfig = JSON.parse(readFileSync(join(baselineDir, 'docs.json'), 'utf8'))
  if (!isDeepStrictEqual(existing.tabs, baseline.tabs)) return undefined
  const seed = new Map<string, Buffer>()
  for (const path of seedFiles(join(baselineDir, 'src/content'))) {
    const name = relative(baselineDir, path).replace(/\\/g, '/')
    const target = assertMigrationDestination(projectDir, name)
    if (!existsSync(target) || !lstatSync(target).isFile()) return undefined
    const current = readFileSync(target)
    if (!areStarterFileContentsEquivalent(name, current, readFileSync(path))) return undefined
    seed.set(name, current)
  }
  return seed
}

/** Compare semantic navigation and exact seed bytes (allowing valid UTF-8 CRLF). */
export function hasUntouchedSeedNavigation(projectDir: string, baselineDir: string, existing: MigrationDocsConfig): boolean {
  return untouchedSeedFiles(projectDir, baselineDir, existing) !== undefined
}

/** Exact checked bytes guard the gap between asynchronous proof and mutation. */
export interface MigrationExistingPlan {
  config?: MigrationDocsConfig
  seedFiles: Map<string, Buffer>
  preconditions: Map<string, Buffer | undefined>
  seedRelease?: { id: string; sourceCommit: string }
}

/** Retain authored navigation unless published scaffold provenance proves its seed. */
export async function migrationExistingConfig(projectDir: string, existing: MigrationDocsConfig | undefined, warnings: MigrationWarning[]): Promise<MigrationExistingPlan> {
  const preserved = { config: existing, seedFiles: new Map<string, Buffer>(), preconditions: new Map<string, Buffer | undefined>() }
  if (!existing) return preserved
  const initialConfig = readFileSync(assertMigrationDestination(projectDir, 'docs.json'))
  preserved.preconditions.set('docs.json', initialConfig)
  const manifest = assertMigrationDestination(projectDir, 'starter-release.json')
  if (!existsSync(manifest)) return preserved
  const temporary = mkdtempSync(join(tmpdir(), 'thally-migration-seed-'))
  try {
    const initialManifest = readFileSync(manifest)
    const { release } = await resolveStarterUpdateBase({ targetDir: projectDir })
    await downloadStarter(temporary, undefined, release, { announce: false })
    if (!initialManifest.equals(readFileSync(manifest)) || !initialConfig.equals(readFileSync(assertMigrationDestination(projectDir, 'docs.json')))) throw new Error('The project changed during starter verification. Retry migration.')
    const seed = untouchedSeedFiles(projectDir, temporary, existing)
    if (seed) {
      return {
        config: { ...existing, tabs: [] },
        seedFiles: seed,
        preconditions: new Map([['starter-release.json', initialManifest], ['docs.json', initialConfig], ...seed]),
        seedRelease: { id: release.id, sourceCommit: release.source.commitSha },
      }
    }
  } catch (error) {
    warnings.push({ code: 'unsupported-config', message: `Starter navigation could not be verified and was preserved. ${error instanceof Error ? error.message : String(error)}` })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return preserved
}
