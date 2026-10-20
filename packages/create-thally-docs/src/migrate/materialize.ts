/**
 * Atomic-in-intent migration materialization: stage every replacement and back up
 * original bytes before mutation. Exact preconditions protect owner edits made
 * while asynchronous source/archive discovery was running. Failed application
 * restores the original tree; interrupted rollback retains recoverable backups.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RenderedMigrationFile } from '@thallylabs/migrate'
import { assertMigrationDestination } from './local-source.js'

interface FileState { content?: Buffer; mode?: number }

/** Capture only regular files; path confinement rejects symlink ancestors too. */
export function migrationFileState(projectDir: string, path: string): FileState {
  const target = assertMigrationDestination(projectDir, path)
  if (!existsSync(target)) return {}
  const entry = lstatSync(target)
  if (!entry.isFile()) throw new Error(`Migration destination must be a regular file: ${path}`)
  return { content: readFileSync(target), mode: entry.mode }
}

function same(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined || right === undefined ? left === right : left.equals(right)
}

export interface MigrationMaterializeOptions {
  /** Verified archive/config/seed bytes, captured before asynchronous rendering. */
  preconditions?: ReadonlyMap<string, Buffer | undefined>
  /** Integration seam for failure/owner-edit preservation regressions. */
  onMutationApplied?: (path: string, index: number) => void
}

/** Apply a complete write/delete plan, rolling back on every application failure. */
export function materializeMigration(projectDir: string, files: ReadonlyArray<RenderedMigrationFile>, deletePaths: ReadonlyArray<string>, options: MigrationMaterializeOptions = {}): void {
  const mutations = [...files.map((file) => ({ path: file.path, content: Buffer.from(file.content) })), ...deletePaths.map((path) => ({ path, content: undefined }))]
  if (new Set(mutations.map((mutation) => mutation.path)).size !== mutations.length) throw new Error('Migration contains conflicting destination mutations.')
  const originals = new Map(mutations.map(({ path }) => [path, migrationFileState(projectDir, path)]))
  const expectations = new Map([...originals].map(([path, state]) => [path, state.content]))
  for (const [path, bytes] of options.preconditions ?? []) expectations.set(path, bytes)
  const unchanged = (path: string, expected: Buffer | undefined): void => {
    if (!same(migrationFileState(projectDir, path).content, expected)) throw new Error(`Migration destination changed after planning: ${path}. Retry without overwriting the owner edit.`)
  }
  const transaction = mkdtempSync(join(dirname(projectDir), '.thally-migration-transaction-'))
  const applied: typeof mutations = []
  let retainBackup = false
  const temporaryPath = (area: string, path: string): string => assertMigrationDestination(join(transaction, area), path)
  try {
    for (const mutation of mutations) {
      const original = originals.get(mutation.path)!
      if (original.content !== undefined) {
        const backup = temporaryPath('backup', mutation.path)
        mkdirSync(dirname(backup), { recursive: true })
        writeFileSync(backup, original.content, { mode: original.mode })
        if (original.mode !== undefined) chmodSync(backup, original.mode)
      }
      if (mutation.content !== undefined) {
        const stage = temporaryPath('stage', mutation.path)
        mkdirSync(dirname(stage), { recursive: true })
        writeFileSync(stage, mutation.content, { mode: original.mode })
        if (original.mode !== undefined) chmodSync(stage, original.mode)
      }
    }
    // Verify the entire plan before touching the project, then every target at
    // its mutation. These checks remain exact even when seed proof permits CRLF.
    for (const [path, expected] of expectations) unchanged(path, expected)
    for (const [index, mutation] of mutations.entries()) {
      unchanged(mutation.path, expectations.get(mutation.path))
      const destination = assertMigrationDestination(projectDir, mutation.path)
      if (mutation.content === undefined) rmSync(destination, { force: true })
      else {
        mkdirSync(dirname(destination), { recursive: true })
        renameSync(temporaryPath('stage', mutation.path), destination)
      }
      applied.push(mutation)
      options.onMutationApplied?.(mutation.path, index)
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const mutation of applied.reverse()) {
      try {
        // Do not erase an owner edit made after an applied mutation; retain
        // its original backup and surface the recovery location instead.
        unchanged(mutation.path, mutation.content)
        const destination = assertMigrationDestination(projectDir, mutation.path)
        const original = originals.get(mutation.path)!
        if (original.content === undefined) rmSync(destination, { force: true })
        else renameSync(temporaryPath('backup', mutation.path), destination)
      } catch (failure) { rollbackErrors.push(failure) }
    }
    if (rollbackErrors.length) {
      retainBackup = true
      throw new AggregateError([error, ...rollbackErrors], `Migration failed and some files changed during rollback. Original files are retained at ${transaction}/backup; preserve owner edits before recovery.`)
    }
    throw error
  } finally {
    if (!retainBackup) rmSync(transaction, { recursive: true, force: true })
  }
}
