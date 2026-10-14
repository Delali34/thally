/**
 * Ownership-aware, three-way planning for future starter runtime updates.
 *
 * The ownership contract comes from the pinned starter archive's
 * `starter-release.json`. Automatic updates touch only framework-eligible files
 * that still match the recorded old starter. Owner paths are never mutated;
 * manual-review files join the transaction only after a separate safe merge.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import {
  STABLE_SCAFFOLD_RELEASE,
  type ScaffoldOwnershipContract,
  type ScaffoldRelease,
  type StarterReleaseManifest,
} from './release.js'

const MAX_MANIFEST_BYTES = 256 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export type StarterPathOwnership =
  | 'protected'
  | 'manual'
  | 'syncable'
  | 'unmanaged'

export interface StarterRuntimeSyncPlan {
  copyPaths: string[]
  deletePaths: string[]
  conflictPaths: string[]
  manualReviewPaths: string[]
  preservedPaths: string[]
  unchangedPaths: string[]
  targetPreconditions: Record<string, StarterTargetPrecondition>
}

export interface StarterTargetPrecondition {
  kind: 'missing' | 'file'
  sha256?: string
}

export interface StarterApplyProvenance {
  sourcePath: string
  targetPath: string
  expectedSha256: string
}

export interface ApplyStarterRuntimeSyncOptions {
  /** Explicit acknowledgement that the caller reviewed this exact plan. */
  confirmed: boolean
  /** Optional immutable provenance file, atomically replaced after mutations. */
  provenance?: StarterApplyProvenance
  /** Integration hook; an exception aborts and rolls back the transaction. */
  /** Owner-reviewed paths explicitly resolved by the shared three-way merge. */
  manualMutations?: {
    writeFiles: ReadonlyMap<string, Buffer>
    deletePaths: readonly string[]
    targetPreconditions: Record<string, StarterTargetPrecondition>
  }
  onMutationApplied?: (path: string, index: number) => void
}

function normalizedRelativePath(value: string): string | null {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/')
  ) {
    return null
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

function normalizedRule(value: string): string | null {
  const isDirectoryRule = value.endsWith('/**')
  const isFilenamePrefixRule = !isDirectoryRule && value.endsWith('*')
  const path = isDirectoryRule
    ? value.slice(0, -3)
    : isFilenamePrefixRule
      ? value.slice(0, -1)
      : value
  const normalized = normalizedRelativePath(path)
  if (!normalized || path.includes('*')) return null

  if (isFilenamePrefixRule) {
    const filenamePrefix = normalized.split('/').at(-1)
    if (!filenamePrefix) return null
    return `${normalized}*`
  }
  return isDirectoryRule ? `${normalized}/**` : normalized
}

function parsePathRules(
  value: unknown,
  field: string,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`The starter ownership contract requires ${field}.`)
  }
  const rules: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const rule = typeof candidate === 'string'
      ? normalizedRule(candidate)
      : null
    if (!rule || seen.has(rule)) {
      throw new Error(`The starter ownership contract contains invalid ${field}.`)
    }
    seen.add(rule)
    rules.push(rule)
  }
  return rules
}

/** Parse and validate the ownership section in `starter-release.json`. */
export function parseStarterOwnershipContract(
  value: unknown,
): ScaffoldOwnershipContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The starter ownership contract is invalid.')
  }
  const candidate = value as Partial<ScaffoldOwnershipContract>
  return {
    frameworkSyncEligible: parsePathRules(
      candidate.frameworkSyncEligible,
      'frameworkSyncEligible',
    ),
    userOwnedNeverOverwrite: parsePathRules(
      candidate.userOwnedNeverOverwrite,
      'userOwnedNeverOverwrite',
    ),
    manualReview: parsePathRules(candidate.manualReview, 'manualReview', true),
  }
}

/**
 * Combine the previous and next release policies without weakening ownership.
 *
 * A later starter may broaden framework ownership, but it cannot retroactively
 * make a path safe to overwrite when either release marked that path as owner
 * controlled or manual-review. Classification precedence enforces that union.
 */
export function mergeStarterOwnershipContracts(
  previous: ScaffoldOwnershipContract,
  next: ScaffoldOwnershipContract,
): ScaffoldOwnershipContract {
  const oldContract = parseStarterOwnershipContract(previous)
  const newContract = parseStarterOwnershipContract(next)
  const unique = (values: readonly string[]): string[] => [...new Set(values)]

  return {
    frameworkSyncEligible: unique([
      ...oldContract.frameworkSyncEligible,
      ...newContract.frameworkSyncEligible,
    ]),
    userOwnedNeverOverwrite: unique([
      ...oldContract.userOwnedNeverOverwrite,
      ...newContract.userOwnedNeverOverwrite,
      STABLE_SCAFFOLD_RELEASE.source.manifestPath,
    ]),
    manualReview: unique([
      ...oldContract.manualReview,
      ...newContract.manualReview,
    ]),
  }
}

/** Stable SHA-256 of the exact manifest bytes promoted with a release. */
export function starterManifestSha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`The starter release manifest contains invalid ${field}.`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.some(([key, item]) => !key || typeof item !== 'string')) {
    throw new Error(`The starter release manifest contains invalid ${field}.`)
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/**
 * Parse the archive-owned release manifest and bind it to its promoted source,
 * runtime identity, and SHA-256. Branch names never participate in updates.
 */
export function parseStarterReleaseManifest(
  source: string,
  release: ScaffoldRelease = STABLE_SCAFFOLD_RELEASE,
): StarterReleaseManifest {
  if (!source || Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('The starter release manifest is missing or too large.')
  }
  const expectedHash = release.source.manifestSha256
  if (!SHA256_PATTERN.test(expectedHash) || starterManifestSha256(source) !== expectedHash) {
    throw new Error('The starter release manifest does not match its promoted SHA-256.')
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('The starter release manifest is invalid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The starter release manifest is invalid.')
  }
  const candidate = value as Partial<StarterReleaseManifest>
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.starterVersion) ||
    Number(candidate.starterVersion) < 1 ||
    candidate.starterVersion !== release.starterVersion ||
    candidate.repository !== release.source.repository ||
    candidate.defaultBranch !== 'main' ||
    !candidate.runtime ||
    candidate.runtime.repository !== release.runtime.repository ||
    candidate.runtime.commitSha !== release.runtime.commitSha ||
    candidate.runtime.treeSha !== release.runtime.treeSha
  ) {
    throw new Error('The starter release manifest identity does not match its release.')
  }

  return {
    schemaVersion: 1,
    starterVersion: candidate.starterVersion,
    repository: candidate.repository,
    defaultBranch: candidate.defaultBranch,
    runtime: {
      repository: candidate.runtime.repository,
      commitSha: candidate.runtime.commitSha,
      treeSha: candidate.runtime.treeSha,
    },
    packages: parseStringRecord(candidate.packages, 'packages'),
    ownership: parseStarterOwnershipContract(candidate.ownership),
  }
}

/** Read and validate the canonical ownership manifest from an extracted archive. */
export function readStarterReleaseManifest(
  starterDir: string,
  release: ScaffoldRelease = STABLE_SCAFFOLD_RELEASE,
): StarterReleaseManifest {
  const manifest = parseStarterReleaseManifest(
    readFileSync(join(starterDir, release.source.manifestPath), 'utf8'),
    release,
  )
  let packageValue: unknown
  try {
    packageValue = JSON.parse(readFileSync(join(starterDir, 'package.json'), 'utf8'))
  } catch {
    throw new Error('The stable Thally starter contains invalid package.json.')
  }
  if (!packageValue || typeof packageValue !== 'object' || Array.isArray(packageValue)) {
    throw new Error('The stable Thally starter contains invalid package.json.')
  }
  const packageJson = packageValue as {
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  }
  const declaredPackages = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  for (const [name, version] of Object.entries(manifest.packages)) {
    if (declaredPackages[name] !== version) {
      throw new Error(
        `The starter release manifest package ${name} does not match package.json.`,
      )
    }
  }
  return manifest
}

function matchesRule(path: string, rule: string): boolean {
  if (rule.endsWith('/**')) {
    const root = rule.slice(0, -3)
    return path === root || path.startsWith(`${root}/`)
  }
  if (rule.endsWith('*')) {
    const prefix = rule.slice(0, -1)
    if (!path.startsWith(prefix)) return false
    return !path.slice(prefix.length).includes('/')
  }
  return path === rule
}

function ruleRoot(rule: string): string {
  if (rule.endsWith('/**')) return rule.slice(0, -3)
  if (!rule.endsWith('*')) return rule
  const prefix = rule.slice(0, -1)
  const slash = prefix.lastIndexOf('/')
  return slash === -1 ? '' : prefix.slice(0, slash)
}

/** Protected > manual-review > syncable > unmanaged. */
export function classifyStarterPath(
  path: string,
  contract: ScaffoldOwnershipContract,
): StarterPathOwnership {
  const normalized = normalizedRelativePath(path)
  if (!normalized) throw new Error('Cannot classify an unsafe starter path.')
  const parsed = parseStarterOwnershipContract(contract)
  if (
    parsed.userOwnedNeverOverwrite.some((rule) => matchesRule(normalized, rule))
  ) {
    return 'protected'
  }
  if (parsed.manualReview.some((rule) => matchesRule(normalized, rule))) {
    return 'manual'
  }
  if (parsed.frameworkSyncEligible.some((rule) => matchesRule(normalized, rule))) {
    return 'syncable'
  }
  return 'unmanaged'
}

function filesystemPathToRepositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function collectFiles(
  root: string,
  contract: ScaffoldOwnershipContract,
  desiredOwnership: 'syncable' | 'manual',
): Map<string, string> {
  const files = new Map<string, string>()
  const visited = new Set<string>()
  const rules = desiredOwnership === 'syncable'
    ? contract.frameworkSyncEligible
    : contract.manualReview

  const visit = (absolutePath: string): void => {
    const resolvedPath = resolve(absolutePath)
    // Exact-file ownership rules can jump directly into nested directories;
    // validate ancestors too, rather than following a symlink before visiting.
    if (resolvedPath !== resolve(root)) assertSafeTargetParents(root, resolvedPath)
    if (visited.has(resolvedPath)) return
    visited.add(resolvedPath)
    const repositoryPath = filesystemPathToRepositoryPath(root, resolvedPath)
    const ownership = classifyStarterPath(repositoryPath, contract)
    if (ownership === 'protected') return
    const entry = lstatSync(resolvedPath)
    if (entry.isSymbolicLink()) {
      throw new Error('Starter synchronization does not follow symbolic links.')
    }
    if (entry.isFile()) {
      if (ownership === desiredOwnership) files.set(repositoryPath, resolvedPath)
      return
    }
    if (!entry.isDirectory()) {
      throw new Error('Starter synchronization supports only files and directories.')
    }
    for (const child of readdirSync(resolvedPath)) visit(join(resolvedPath, child))
  }

  for (const rule of rules) {
    const rootPath = join(root, ruleRoot(rule))
    if (!existsSync(rootPath)) continue
    if (rule.endsWith('*') && !rule.endsWith('/**')) {
      for (const child of readdirSync(rootPath)) {
        const childPath = join(rootPath, child)
        const repositoryPath = filesystemPathToRepositoryPath(root, childPath)
        if (matchesRule(repositoryPath, rule)) visit(childPath)
      }
    } else {
      visit(rootPath)
    }
  }
  return files
}

function sameFile(left?: string, right?: string): boolean {
  if (!left || !right) return left === right
  return readFileSync(left).equals(readFileSync(right))
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Capture exact file identity before planning a filesystem mutation. */
export function captureTargetPrecondition(path: string): StarterTargetPrecondition {
  if (!existsSync(path)) return { kind: 'missing' }
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('Starter synchronization target mutations must be regular files.')
  }
  return { kind: 'file', sha256: fileSha256(path) }
}

function matchesTargetPrecondition(
  path: string,
  precondition: StarterTargetPrecondition,
): boolean {
  if (precondition.kind === 'missing') return !existsSync(path)
  if (!existsSync(path)) return false
  const entry = lstatSync(path)
  return entry.isFile() && !entry.isSymbolicLink() &&
    fileSha256(path) === precondition.sha256
}

/**
 * Build a safe three-way update plan from the recorded old starter, the new
 * starter, and the customer's current tree.
 */
export function planStarterRuntimeSync(
  oldStarterDir: string,
  newStarterDir: string,
  targetDir: string,
  ownership: ScaffoldOwnershipContract,
): StarterRuntimeSyncPlan {
  const contract = parseStarterOwnershipContract(ownership)
  const oldFiles = collectFiles(resolve(oldStarterDir), contract, 'syncable')
  const newFiles = collectFiles(resolve(newStarterDir), contract, 'syncable')
  const targetFiles = collectFiles(resolve(targetDir), contract, 'syncable')
  const manualReviewPaths = new Set([
    ...collectFiles(resolve(oldStarterDir), contract, 'manual').keys(),
    ...collectFiles(resolve(newStarterDir), contract, 'manual').keys(),
    ...collectFiles(resolve(targetDir), contract, 'manual').keys(),
  ])
  const copyPaths: string[] = []
  const deletePaths: string[] = []
  const conflictPaths: string[] = []
  const preservedPaths: string[] = []
  const unchangedPaths: string[] = []
  const paths = new Set([
    ...oldFiles.keys(),
    ...newFiles.keys(),
    ...targetFiles.keys(),
  ])

  for (const path of paths) {
    const oldPath = oldFiles.get(path)
    const newPath = newFiles.get(path)
    const targetPath = targetFiles.get(path)
    const targetMatchesOld = sameFile(targetPath, oldPath)
    const newMatchesOld = sameFile(newPath, oldPath)
    const targetMatchesNew = sameFile(targetPath, newPath)

    if (!oldPath) {
      if (!newPath) preservedPaths.push(path)
      else if (!targetPath) copyPaths.push(path)
      else if (targetMatchesNew) unchangedPaths.push(path)
      else conflictPaths.push(path)
      continue
    }
    if (targetMatchesOld) {
      if (!newPath) deletePaths.push(path)
      else if (newMatchesOld) unchangedPaths.push(path)
      else copyPaths.push(path)
      continue
    }
    if (newMatchesOld || targetMatchesNew || (!targetPath && !newPath)) {
      preservedPaths.push(path)
    } else {
      conflictPaths.push(path)
    }
  }

  const sortedCopyPaths = copyPaths.sort()
  const sortedDeletePaths = deletePaths.sort()
  const targetPreconditions = Object.fromEntries(
    [...sortedCopyPaths, ...sortedDeletePaths].map((path) => [
      path,
      captureTargetPrecondition(ensureContained(targetDir, path)),
    ]),
  )

  return {
    copyPaths: sortedCopyPaths,
    deletePaths: sortedDeletePaths,
    conflictPaths: conflictPaths.sort(),
    manualReviewPaths: [...manualReviewPaths].sort(),
    preservedPaths: preservedPaths.sort(),
    unchangedPaths: unchangedPaths.sort(),
    targetPreconditions,
  }
}

function ensureContained(root: string, repositoryPath: string): string {
  const target = resolve(root, repositoryPath)
  const prefix = `${resolve(root)}${sep}`
  if (!target.startsWith(prefix)) {
    throw new Error('Starter synchronization resolved outside its target.')
  }
  return target
}

function assertSafeTargetParents(root: string, path: string): void {
  const resolvedRoot = resolve(root)
  let parent = dirname(resolve(path))
  while (parent !== resolvedRoot) {
    if (!parent.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error('Starter synchronization parent resolved outside its target.')
    }
    if (existsSync(parent)) {
      const entry = lstatSync(parent)
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('Starter synchronization refuses unsafe target parents.')
      }
    }
    parent = dirname(parent)
  }
}

/** Apply an explicitly confirmed, conflict-free three-way plan. */
export function applyStarterRuntimeSyncPlan(
  newStarterDir: string,
  targetDir: string,
  plan: StarterRuntimeSyncPlan,
  ownership: ScaffoldOwnershipContract,
  options: ApplyStarterRuntimeSyncOptions,
): void {
  const contract = parseStarterOwnershipContract(ownership)
  if (!options.confirmed) {
    throw new Error('Review and confirm the starter synchronization plan first.')
  }
  if (plan.conflictPaths.length > 0) {
    throw new Error('Resolve starter synchronization conflicts before applying.')
  }
  const manual = options.manualMutations
  const copyPaths = [...plan.copyPaths, ...(manual?.writeFiles.keys() ?? [])]
  const deletePaths = [...plan.deletePaths, ...(manual?.deletePaths ?? [])]
  const preconditions = { ...plan.targetPreconditions, ...manual?.targetPreconditions }
  const uniqueMutations = new Set([...copyPaths, ...deletePaths])
  if (uniqueMutations.size !== copyPaths.length + deletePaths.length) {
    throw new Error('Starter synchronization plan contains conflicting mutations.')
  }
  for (const path of uniqueMutations) {
    const isManualMutation = manual?.writeFiles.has(path) || manual?.deletePaths.includes(path)
    if (classifyStarterPath(path, contract) !== (isManualMutation ? 'manual' : 'syncable')) {
      throw new Error(`Starter synchronization refused owner path ${path}.`)
    }
    if (!preconditions[path]) {
      throw new Error(`Starter synchronization plan lacks a target precondition for ${path}.`)
    }
  }

  const targetRoot = resolve(targetDir)
  const targetRootEntry = lstatSync(targetRoot)
  if (!targetRootEntry.isDirectory() || targetRootEntry.isSymbolicLink()) {
    throw new Error('Starter synchronization requires a regular target directory.')
  }
  if (options.provenance) {
    const expectedTarget = ensureContained(
      targetDir,
      STABLE_SCAFFOLD_RELEASE.source.manifestPath,
    )
    const expectedSource = ensureContained(
      newStarterDir,
      STABLE_SCAFFOLD_RELEASE.source.manifestPath,
    )
    if (
      resolve(options.provenance.targetPath) !== expectedTarget ||
      resolve(options.provenance.sourcePath) !== expectedSource
    ) {
      throw new Error('Starter synchronization received unsafe provenance paths.')
    }
  }
  const transactionDir = mkdtempSync(join(dirname(targetRoot), '.thally-starter-transaction-'))
  const stagedDir = join(transactionDir, 'staged')
  const backupDir = join(transactionDir, 'backup')
  mkdirSync(stagedDir)
  mkdirSync(backupDir)
  const applied: Array<{
    path: string
    targetPath: string
    precondition: StarterTargetPrecondition
  }> = []
  let mutationIndex = 0

  const stagePath = (path: string): string => {
    const stagedPath = ensureContained(stagedDir, path)
    mkdirSync(dirname(stagedPath), { recursive: true })
    return stagedPath
  }
  const backupPath = (path: string): string => {
    const pathInBackup = ensureContained(backupDir, path)
    mkdirSync(dirname(pathInBackup), { recursive: true })
    return pathInBackup
  }

  const mutate = (
    path: string,
    targetPath: string,
    precondition: StarterTargetPrecondition,
    replacementPath?: string,
  ): void => {
    assertSafeTargetParents(targetDir, targetPath)
    if (!matchesTargetPrecondition(targetPath, precondition)) {
      throw new Error(`Starter synchronization target changed after planning: ${path}.`)
    }
    if (precondition.kind === 'file') {
      copyFileSync(targetPath, backupPath(path))
    }
    applied.push({ path, targetPath, precondition })
    if (replacementPath) {
      mkdirSync(dirname(targetPath), { recursive: true })
      renameSync(replacementPath, targetPath)
    } else {
      rmSync(targetPath, { force: true })
    }
    options.onMutationApplied?.(path, mutationIndex)
    mutationIndex += 1
  }

  try {
    for (const path of copyPaths) {
      if (manual?.writeFiles.has(path)) {
        writeFileSync(stagePath(path), manual.writeFiles.get(path)!)
        continue
      }
      const sourcePath = ensureContained(newStarterDir, path)
      if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
        throw new Error(`Starter synchronization source is missing ${path}.`)
      }
      copyFileSync(sourcePath, stagePath(path))
    }
    let provenanceStagePath: string | undefined
    if (options.provenance) {
      if (!existsSync(options.provenance.sourcePath) ||
        !lstatSync(options.provenance.sourcePath).isFile()) {
        throw new Error('Starter synchronization provenance source is missing.')
      }
      provenanceStagePath = join(transactionDir, 'next-provenance')
      copyFileSync(options.provenance.sourcePath, provenanceStagePath)
    }

    // Revalidate the complete plan before the first write, then again directly
    // before every mutation to close the plan/apply race on local filesystems.
    for (const path of uniqueMutations) {
      const targetPath = ensureContained(targetDir, path)
      assertSafeTargetParents(targetDir, targetPath)
      if (!matchesTargetPrecondition(targetPath, preconditions[path])) {
        throw new Error(`Starter synchronization target changed after planning: ${path}.`)
      }
    }
    if (options.provenance) {
      assertSafeTargetParents(targetDir, options.provenance.targetPath)
      if (fileSha256(options.provenance.targetPath) !==
        options.provenance.expectedSha256) {
        throw new Error('The project starter manifest changed during update planning.')
      }
    }

    for (const path of deletePaths) {
      mutate(
        path,
        ensureContained(targetDir, path),
        preconditions[path],
      )
    }
    for (const path of copyPaths) {
      mutate(
        path,
        ensureContained(targetDir, path),
        preconditions[path],
        ensureContained(stagedDir, path),
      )
    }
    if (options.provenance && provenanceStagePath) {
      const provenancePrecondition: StarterTargetPrecondition = {
        kind: 'file',
        sha256: options.provenance.expectedSha256,
      }
      mutate(
        STABLE_SCAFFOLD_RELEASE.source.manifestPath,
        options.provenance.targetPath,
        provenancePrecondition,
        provenanceStagePath,
      )
    }
  } catch (error) {
    let rollbackError: unknown
    for (const mutation of applied.reverse()) {
      try {
        rmSync(mutation.targetPath, { force: true })
        if (mutation.precondition.kind === 'file') {
          mkdirSync(dirname(mutation.targetPath), { recursive: true })
          renameSync(backupPath(mutation.path), mutation.targetPath)
        }
      } catch (candidate) {
        rollbackError ??= candidate
      }
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Starter synchronization failed and rollback was incomplete.',
      )
    }
    throw error
  } finally {
    rmSync(transactionDir, { recursive: true, force: true })
  }
}
