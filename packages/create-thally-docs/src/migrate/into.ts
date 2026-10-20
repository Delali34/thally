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
import { assertMigrationDestination } from './local-source.js'

function seedFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('Starter seed content contains a symbolic link.')
    const path = join(directory, entry.name)
    return entry.isDirectory() ? seedFiles(path) : entry.isFile() ? [path] : []
  })
}

/** Compare semantic navigation and exact seed bytes (allowing Windows CRLF). */
export function hasUntouchedSeedNavigation(projectDir: string, baselineDir: string, existing: MigrationDocsConfig): boolean {
  const baseline: MigrationDocsConfig = JSON.parse(readFileSync(join(baselineDir, 'docs.json'), 'utf8'))
  if (!isDeepStrictEqual(existing.tabs, baseline.tabs)) return false
  return seedFiles(join(baselineDir, 'src/content')).every((path) => {
    const target = assertMigrationDestination(projectDir, relative(baselineDir, path))
    return existsSync(target) && lstatSync(target).isFile()
      && readFileSync(target, 'utf8').replace(/\r\n/g, '\n') === readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  })
}

/** Retain authored navigation unless published scaffold provenance proves its seed. */
export async function migrationExistingConfig(projectDir: string, existing: MigrationDocsConfig | undefined, warnings: MigrationWarning[]): Promise<MigrationDocsConfig | undefined> {
  if (!existing) return undefined
  const manifest = assertMigrationDestination(projectDir, 'starter-release.json')
  if (!existsSync(manifest)) return existing
  const temporary = mkdtempSync(join(tmpdir(), 'thally-migration-seed-'))
  try {
    const { release } = await resolveStarterUpdateBase({ targetDir: projectDir })
    await downloadStarter(temporary, undefined, release, { announce: false })
    if (hasUntouchedSeedNavigation(projectDir, temporary, existing)) return { ...existing, tabs: [] }
  } catch (error) {
    warnings.push({ code: 'unsupported-config', message: `Starter navigation could not be verified and was preserved. ${error instanceof Error ? error.message : String(error)}` })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return existing
}
