/**
 * User-reachable orchestration for immutable starter release updates.
 *
 * Projects carry the exact bytes of `starter-release.json`. The manifest hash
 * resolves the old release from the toolchain's retained immutable catalog;
 * neither the old nor new side follows a branch. Updates are dry-run by
 * default and advance provenance only after a confirmed, conflict-free apply.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadStarter } from './download.js'
import {
  STABLE_SCAFFOLD_RELEASE,
  SUPPORTED_SCAFFOLD_RELEASES,
  type ScaffoldRelease,
} from './release.js'
import {
  applyStarterRuntimeSyncPlan,
  captureTargetPrecondition,
  mergeStarterOwnershipContracts,
  parseStarterReleaseManifest,
  planStarterRuntimeSync,
  readStarterReleaseManifest,
  starterManifestSha256,
  type StarterRuntimeSyncPlan,
} from './starter-sync.js'

import { resolveManualReviewMutations, type StarterManualConflict } from './starter-manual-review.js'
export { resolveManualReviewMutations, type ManualReviewMutations, type StarterManualConflict } from './starter-manual-review.js'

const EMPTY_PLAN: StarterRuntimeSyncPlan = {
  copyPaths: [],
  deletePaths: [],
  conflictPaths: [],
  manualReviewPaths: [],
  preservedPaths: [],
  unchangedPaths: [],
  targetPreconditions: {},
}

export interface StarterUpdateDownload {
  (targetDir: string, release: ScaffoldRelease): Promise<void>
}

export interface UpdateStarterProjectOptions {
  targetDir: string
  /** Applying is opt-in. Omitted/false always produces a dry-run plan. */
  apply?: boolean
  /** Separate acknowledgement for programmatic callers. */
  confirmed?: boolean
  targetRelease?: ScaffoldRelease
  releases?: readonly ScaffoldRelease[]
  download?: StarterUpdateDownload
  resolveReleaseHint?: StarterReleaseHintResolver
}

export interface StarterUpdateResult {
  previousRelease: ScaffoldRelease
  targetRelease: ScaffoldRelease
  plan: StarterRuntimeSyncPlan
  isUpToDate: boolean
  applied: boolean
  /** A verified published baseline replaced noncanonical manifest provenance. */
  manualConflicts?: StarterManualConflict[]
  resolvedManualPaths?: string[]
  deletedManualPaths?: string[]
  recoveredProvenance?: boolean
}

function readDownstreamManifest(targetDir: string, manifestPath: string): string {
  const path = join(targetDir, manifestPath)
  if (!existsSync(path)) {
    throw new Error(
      `This project has no ${manifestPath}; update it from a versioned Thally starter first.`,
    )
  }
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 256 * 1024) {
    throw new Error('The project starter manifest must be a bounded regular file.')
  }
  return readFileSync(path, 'utf8')
}

/** Resolve exact downstream provenance without consulting a moving branch. */
export function resolveStarterReleaseFromManifest(
  source: string,
  releases: readonly ScaffoldRelease[] = SUPPORTED_SCAFFOLD_RELEASES,
): ScaffoldRelease {
  const hash = starterManifestSha256(source)
  const matching = releases.filter(
    (release) => release.source.manifestSha256 === hash,
  )
  if (matching.length !== 1) {
    throw new Error(
      'The project starter manifest is edited, unknown, or ambiguously registered; refusing to update.',
    )
  }
  parseStarterReleaseManifest(source, matching[0])
  return matching[0]
}

/** An untrusted promotion record can suggest only an already trusted release. */
export interface StarterReleaseHintResolver {
  (runtimeCommitSha: string): Promise<unknown>
}

/** Recognizable transient failure; callers must not cache it as unsupported. */
export function starterReleaseProviderError(cause?: unknown): Error & { code: string } {
  return Object.assign(new Error('The public starter release provider is unavailable.', { cause }), {
    name: 'StarterReleaseProviderError', code: 'STARTER_RELEASE_PROVIDER_UNAVAILABLE',
  })
}

/** Read a bounded lookup hint from the fixed public repository at an exact SHA. */
export async function fetchStarterReleaseHint(runtimeCommitSha: string): Promise<unknown> {
  if (!/^[a-f0-9]{40}$/.test(runtimeCommitSha)) return undefined
  let response: Response
  try {
    response = await fetch(
      `https://raw.githubusercontent.com/thallylabs/thally/${runtimeCommitSha}/packages/create-thally-docs/src/stable-scaffold-release.json`,
      { signal: AbortSignal.timeout(15_000), redirect: 'error' },
    )
  } catch (error) {
    throw starterReleaseProviderError(error)
  }
  if (response.status === 404) return undefined
  if (!response.ok || !response.body) throw starterReleaseProviderError()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() } catch (error) { throw starterReleaseProviderError(error) }
      if (chunk.done) break
      size += chunk.value.byteLength
      // Malformed or oversized hints are untrusted lookup data, not evidence
      // of a temporary provider outage. They can never authorize recovery.
      if (size > 256 * 1024) return undefined
      chunks.push(chunk.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { return undefined }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function comparableManifest(source: string): unknown {
  const manifest = JSON.parse(source) as Record<string, unknown>
  const runtime = manifest.runtime as Record<string, unknown> | undefined
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return undefined
  const runtimeContract = { ...runtime }
  delete runtimeContract.commitSha
  delete runtimeContract.treeSha
  return { ...manifest, runtime: runtimeContract }
}

function assertRecoveryPackages(targetDir: string, baselineDir: string, packages: Record<string, string>): void {
  const installed = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
  const declarations = { ...installed.dependencies, ...installed.devDependencies }
  for (const [name, version] of Object.entries(packages)) {
    if (declarations[name] !== version) throw new Error('Installed starter packages do not match the recovery baseline.')
  }
  // A lockfile is owner reviewed, but recovery must prove the baseline's package
  // identity rather than silently blessing a stale Core installation.
  if (existsSync(join(baselineDir, 'package-lock.json'))) {
    const canonical = JSON.parse(readFileSync(join(baselineDir, 'package-lock.json'), 'utf8'))
    const current = JSON.parse(readFileSync(join(targetDir, 'package-lock.json'), 'utf8'))
    for (const name of Object.keys(packages)) {
      const path = `node_modules/${name}`
      const expected = canonical.packages?.[path]
      if (!expected?.version || !isDeepStrictEqual(current.packages?.[path], expected)) {
        throw new Error('Installed starter package lock does not match the recovery baseline.')
      }
    }
  }
}

/** Trusted catalog and bounded download seams shared by CLI and managed callers. */
export interface ResolveStarterUpdateBaseOptions {
  targetDir: string
  releases?: readonly ScaffoldRelease[]
  download?: StarterUpdateDownload
  resolveReleaseHint?: StarterReleaseHintResolver
}

/** Published baseline identity plus evidence needed to guard provenance writes. */
export interface StarterUpdateBase {
  release: ScaffoldRelease
  recoveredProvenance: boolean
  /** The actual initial bytes, including noncanonical provenance, guard apply. */
  manifestSha256: string
}

/**
 * Resolve a published three-way base. Unknown provenance is accepted only when
 * its contract and complete framework inventory equal a trusted published tree.
 * Neither arbitrary manifest ownership nor a fetched hint authorizes writes.
 */
export async function resolveStarterUpdateBase(options: ResolveStarterUpdateBaseOptions): Promise<StarterUpdateBase> {
  const releases = options.releases ?? SUPPORTED_SCAFFOLD_RELEASES
  const manifestPath = STABLE_SCAFFOLD_RELEASE.source.manifestPath
  const source = readDownstreamManifest(options.targetDir, manifestPath)
  const manifestSha256 = starterManifestSha256(source)
  const exact = releases.filter((release) => release.source.manifestSha256 === manifestSha256)
  if (exact.length) return { release: resolveStarterReleaseFromManifest(source, releases), recoveredProvenance: false, manifestSha256 }
  if (Buffer.byteLength(source, 'utf8') > 256 * 1024) throw new Error('The project starter manifest is too large.')
  let candidate: Record<string, unknown>
  try { candidate = JSON.parse(source) } catch { throw new Error('The project starter manifest is invalid JSON.') }
  const runtime = candidate?.runtime as Record<string, unknown> | undefined
  if (!runtime || typeof runtime.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(runtime.commitSha) ||
      typeof runtime.treeSha !== 'string' || !/^[a-f0-9]{40}$/.test(runtime.treeSha)) {
    throw new Error('The project starter manifest has no verifiable recovery baseline.')
  }
  let candidates = releases.filter((release) => release.runtime.commitSha === runtime.commitSha)
  if (!candidates.length) {
    const hint = await (options.resolveReleaseHint ?? fetchStarterReleaseHint)(runtime.commitSha)
    const record = hint as Partial<ScaffoldRelease> | undefined
    candidates = releases.filter((release) => record?.id === release.id && record.source?.commitSha === release.source.commitSha)
  }
  const download = options.download ?? (async (directory, release) => {
    await downloadStarter(directory, undefined, release, { announce: false })
  })
  const workspace = mkdtempSync(join(tmpdir(), 'thally-starter-base-'))
  try {
    for (const [index, release] of candidates.entries()) {
      const baselineDir = join(workspace, String(index))
      mkdirSync(baselineDir)
      await download(baselineDir, release)
      const baseline = readStarterReleaseManifest(baselineDir, release)
      const canonicalSource = readFileSync(join(baselineDir, manifestPath), 'utf8')
      if (!isDeepStrictEqual(comparableManifest(source), comparableManifest(canonicalSource))) continue
      const ownership = mergeStarterOwnershipContracts(baseline.ownership, baseline.ownership)
      const proof = planStarterRuntimeSync(baselineDir, baselineDir, options.targetDir, ownership)
      if (proof.copyPaths.length || proof.deletePaths.length || proof.preservedPaths.length || proof.conflictPaths.length) continue
      assertRecoveryPackages(options.targetDir, baselineDir, baseline.packages)
      return { release, recoveredProvenance: true, manifestSha256 }
    }
    throw new Error('The project starter manifest is edited, unknown, or has no verified published framework baseline; refusing to update.')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function assertForwardRelease(
  previous: ScaffoldRelease,
  target: ScaffoldRelease,
  releases: readonly ScaffoldRelease[],
): void {
  if (
    previous.source.repository !== target.source.repository ||
    previous.source.manifestPath !== target.source.manifestPath
  ) {
    throw new Error('Starter updates cannot cross repository or manifest contracts.')
  }
  if (previous.source.commitSha === target.source.commitSha) return
  if (previous.starterVersion > target.starterVersion) {
    throw new Error('The installed CLI does not contain a newer starter release.')
  }
  if (previous.starterVersion === target.starterVersion) {
    // A starterVersion can receive multiple promoted releases. Promotion
    // prepends to the retained catalog, so within a version the catalog
    // position is the only recency signal: the update is forward only when
    // the previous release sits later (older) in the list than the target.
    const targetIndex = releases.findIndex(
      (release) => release.source.commitSha === target.source.commitSha,
    )
    const previousIndex = releases.findIndex(
      (release) => release.source.commitSha === previous.source.commitSha,
    )
    if (targetIndex === -1 || previousIndex === -1 || previousIndex <= targetIndex) {
      throw new Error('The installed CLI does not contain a newer starter release.')
    }
  }
}

/**
 * Plan or explicitly apply an immutable three-way starter update.
 *
 * Direct GitHub-template copies need no generated state beyond the canonical
 * manifest: its pinned hash selects the old archive from the retained catalog.
 */
export async function updateStarterProject(
  options: UpdateStarterProjectOptions,
): Promise<StarterUpdateResult> {
  const targetRelease = options.targetRelease ?? STABLE_SCAFFOLD_RELEASE
  const releases = options.releases ?? SUPPORTED_SCAFFOLD_RELEASES
  if (!releases.some((release) => isDeepStrictEqual(release, targetRelease))) {
    throw new Error('The target starter release is not in the trusted release catalog.')
  }
  const manifestPath = targetRelease.source.manifestPath
  const downstreamManifest = readDownstreamManifest(options.targetDir, manifestPath)
  const base = await resolveStarterUpdateBase({ ...options, releases })
  const previousRelease = base.release
  if (base.manifestSha256 !== starterManifestSha256(downstreamManifest) || readDownstreamManifest(options.targetDir, manifestPath) !== downstreamManifest) {
    throw new Error('The project starter manifest changed during update planning.')
  }
  assertForwardRelease(previousRelease, targetRelease, releases)

  if (!base.recoveredProvenance && previousRelease.source.commitSha === targetRelease.source.commitSha) {
    return {
      previousRelease,
      targetRelease,
      plan: EMPTY_PLAN,
      isUpToDate: true,
      applied: false,
    }
  }
  if (options.apply && !options.confirmed) {
    throw new Error('Pass explicit confirmation before applying a starter update.')
  }

  const workspace = mkdtempSync(join(tmpdir(), 'thally-starter-update-'))
  const oldStarterDir = join(workspace, 'old')
  const newStarterDir = join(workspace, 'new')
  mkdirSync(oldStarterDir)
  mkdirSync(newStarterDir)
  const download = options.download ?? (async (targetDir, release) => {
    await downloadStarter(targetDir, undefined, release, { announce: false })
  })

  try {
    await download(oldStarterDir, previousRelease)
    await download(newStarterDir, targetRelease)
    const oldManifest = readStarterReleaseManifest(oldStarterDir, previousRelease)
    const newManifest = readStarterReleaseManifest(newStarterDir, targetRelease)
    const ownership = mergeStarterOwnershipContracts(
      oldManifest.ownership,
      newManifest.ownership,
    )
    if (base.recoveredProvenance) {
      const proof = planStarterRuntimeSync(oldStarterDir, oldStarterDir, options.targetDir,
        mergeStarterOwnershipContracts(oldManifest.ownership, oldManifest.ownership))
      if (proof.copyPaths.length || proof.deletePaths.length || proof.preservedPaths.length || proof.conflictPaths.length) {
        throw new Error('The recovery framework changed during update planning.')
      }
      assertRecoveryPackages(options.targetDir, oldStarterDir, oldManifest.packages)
    }
    if (readDownstreamManifest(options.targetDir, manifestPath) !== downstreamManifest) {
      throw new Error('The project starter manifest changed during update planning.')
    }
    const plan = planStarterRuntimeSync(
      oldStarterDir,
      newStarterDir,
      options.targetDir,
      ownership,
    )

    const allManualPreconditions = Object.fromEntries(plan.manualReviewPaths.map((path) => [
      path, captureTargetPrecondition(join(options.targetDir, path)),
    ]))
    const readManualFiles = (root: string): Map<string, Buffer> => new Map(
      plan.manualReviewPaths.filter((path) => existsSync(join(root, path))).map((path) => {
        const entry = lstatSync(join(root, path))
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Manual starter updates require regular files.')
        // The planner has already validated symlink ancestors during inventory.
        return [path, readFileSync(join(root, path))] as const
      }),
    )
    const manual = resolveManualReviewMutations(
      plan.manualReviewPaths, readManualFiles(options.targetDir),
      readManualFiles(oldStarterDir), readManualFiles(newStarterDir),
    )
    const resolvedManualPaths = [...manual.writeFiles.keys(), ...manual.deletePaths].sort()
    const manualPreconditions = Object.fromEntries(resolvedManualPaths.map((path) => [
      path, allManualPreconditions[path],
    ]))
    plan.conflictPaths = [...new Set([...plan.conflictPaths, ...manual.conflicts.map((conflict) => conflict.path)])].sort()
    plan.manualReviewPaths = manual.conflicts.map((conflict) => conflict.path)

    if (!options.apply) {
      return {
        previousRelease,
        targetRelease,
        plan,
        isUpToDate: false,
        applied: false,
        recoveredProvenance: base.recoveredProvenance,
        manualConflicts: manual.conflicts,
        resolvedManualPaths,
        deletedManualPaths: manual.deletePaths,
      }
    }
    if (plan.conflictPaths.length > 0) {
      throw new Error('Resolve starter synchronization conflicts before applying.')
    }

    // The manifest is special provenance, never a framework mutation. It joins
    // the filesystem transaction as the final atomic rename so a failed update
    // restores both the framework tree and its prior provenance.
    if (readDownstreamManifest(options.targetDir, manifestPath) !== downstreamManifest) {
      throw new Error('The project starter manifest changed during update planning.')
    }
    applyStarterRuntimeSyncPlan(
      newStarterDir,
      options.targetDir,
      plan,
      ownership,
      {
        confirmed: true,
        manualMutations: { ...manual, targetPreconditions: manualPreconditions },
        provenance: {
          sourcePath: join(newStarterDir, manifestPath),
          targetPath: join(options.targetDir, manifestPath),
          expectedSha256: base.manifestSha256,
        },
      },
    )

    return {
      previousRelease,
      targetRelease,
      plan,
      isUpToDate: false,
      applied: true,
      recoveredProvenance: base.recoveredProvenance,
      manualConflicts: manual.conflicts,
      resolvedManualPaths,
      deletedManualPaths: manual.deletePaths,
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}
