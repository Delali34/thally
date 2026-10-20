/** End-to-end orchestration coverage for immutable starter updates. */

import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  STABLE_SCAFFOLD_RELEASE,
  SUPPORTED_SCAFFOLD_RELEASES,
  type ScaffoldOwnershipContract,
  type ScaffoldRelease,
  type StarterReleaseManifest,
} from '../release.js'
import { starterManifestSha256 } from '../starter-sync.js'
import {
  fetchStarterReleaseHint,
  resolveStarterReleaseFromManifest,
  updateStarterProject,
  type StarterUpdateDownload,
} from '../starter-update.js'

const directories: string[] = []

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  directories.push(path)
  return path
}

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, source, 'utf8')
}

const oldOwnership: ScaffoldOwnershipContract = {
  frameworkSyncEligible: ['framework/**'],
  userOwnedNeverOverwrite: [
    'src/content/**',
    'src/mdx/custom-components.tsx',
    'snippets/**',
    'framework/owner.ts',
  ],
  manualReview: ['next.config.ts'],
}

const newOwnership: ScaffoldOwnershipContract = {
  frameworkSyncEligible: ['framework/**'],
  userOwnedNeverOverwrite: [
    'src/content/**',
    'src/mdx/custom-components.tsx',
    'snippets/**',
  ],
  manualReview: ['next.config.ts', 'framework/manual.ts'],
}

function releaseFixture(
  version: number,
  ownership: ScaffoldOwnershipContract,
  /** Distinguishes multiple promoted releases of the same starterVersion. */
  revision = 0,
): { release: ScaffoldRelease; manifestSource: string; tree: string } {
  const label = revision === 0 ? `${version}` : `${version}.${revision}`
  const commitSha = `${String(version).repeat(39)}${revision}`
  const runtimeSha = `${String(version + 2).repeat(39)}${revision}`
  const manifest: StarterReleaseManifest = {
    schemaVersion: 1,
    starterVersion: version,
    repository: 'thallylabs/starter',
    defaultBranch: 'main',
    runtime: {
      repository: 'thallylabs/thally',
      commitSha: runtimeSha,
      treeSha: `${String(version + 4).repeat(39)}${revision}`,
    },
    packages: {
      next: `${version}.${revision}.0`,
      '@thallylabs/core': `${version}.${revision}.0`,
    },
    ownership,
  }
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`
  const tree = directory(`thally-release-${label}-`)
  write(tree, 'starter-release.json', manifestSource)
  write(
    tree,
    'package.json',
    `${JSON.stringify({
      name: 'thally-starter',
      dependencies: {
        next: `${version}.${revision}.0`,
        '@thallylabs/core': `${version}.${revision}.0`,
      },
    }, null, 2)}\n`,
  )
  write(tree, 'framework/runtime.ts', `runtime ${label}\n`)
  write(tree, 'framework/owner.ts', `starter owner ${label}\n`)
  write(tree, 'framework/manual.ts', `manual ${label}\n`)
  write(tree, 'next.config.ts', `config ${label}\n`)
  write(tree, 'src/content/index.mdx', `customer content ${label}\n`)
  const release: ScaffoldRelease = {
    schemaVersion: 1,
    id: `starter-${label}`,
    starterVersion: version,
    source: {
      repository: 'thallylabs/starter',
      commitSha,
      treeSha: `starter-tree-${label}`,
      archiveUrl: `https://example.invalid/starter-${label}.tar.gz`,
      manifestPath: 'starter-release.json',
      manifestSha256: starterManifestSha256(manifestSource),
    },
    runtime: {
      repository: 'thallylabs/thally',
      commitSha: runtimeSha,
      treeSha: `${String(version + 4).repeat(39)}${revision}`,
      contentSource: 'assets',
      identityContractVersion: 1,
    },
  }
  return { release, manifestSource, tree }
}

function copyTree(source: string, target: string): void {
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(target, entry), { recursive: true })
  }
}

function fixtureDownload(
  fixtures: ReadonlyMap<string, string>,
): StarterUpdateDownload {
  return async (targetDir, release) => {
    const source = fixtures.get(release.source.commitSha)
    if (!source) throw new Error('missing fixture release')
    copyTree(source, targetDir)
  }
}

function sharedManifestFixtures() {
  const ownership = { ...oldOwnership, manualReview: [...oldOwnership.manualReview, 'package.json', 'package-lock.json'] }
  const old = releaseFixture(1, ownership), next = releaseFixture(1, ownership, 1)
  next.release.runtime = { ...old.release.runtime }
  next.release.source.manifestSha256 = old.release.source.manifestSha256
  write(next.tree, 'starter-release.json', old.manifestSource)
  const canonicalPackage = JSON.parse(readFileSync(join(old.tree, 'package.json'), 'utf8'))
  write(old.tree, 'package.json', JSON.stringify({ ...canonicalPackage, devDependencies: { '@thallylabs/cli': '0.8.86' } }))
  write(next.tree, 'package.json', JSON.stringify({ ...canonicalPackage, devDependencies: { '@thallylabs/cli': '0.8.103' } }))
  write(next.tree, 'framework/runtime.ts', 'runtime 1\n')
  for (const [archive, version] of [[old, '0.8.86'], [next, '0.8.103']] as const) {
    const packageJson = JSON.parse(readFileSync(join(archive.tree, 'package.json'), 'utf8'))
    write(archive.tree, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
      '': { dependencies: packageJson.dependencies, devDependencies: packageJson.devDependencies },
      'node_modules/next': { version: '1.0.0' },
      'node_modules/@thallylabs/core': { version: '1.0.0' },
      'node_modules/@thallylabs/cli': { version },
    } }))
  }
  const download = fixtureDownload(new Map([[old.release.source.commitSha, old.tree], [next.release.source.commitSha, next.tree]]))
  return { old, next, canonicalPackage, download }
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('retained release catalog', () => {
  // Same-starterVersion forwardness is decided purely by catalog position, so
  // the shipped catalog must stay newest-first or the downgrade guard inverts.
  it('keeps the shipped catalog newest-first', () => {
    expect(SUPPORTED_SCAFFOLD_RELEASES[0]).toBe(STABLE_SCAFFOLD_RELEASE)
    for (let i = 1; i < SUPPORTED_SCAFFOLD_RELEASES.length; i += 1) {
      expect(SUPPORTED_SCAFFOLD_RELEASES[i].starterVersion)
        .toBeLessThanOrEqual(SUPPORTED_SCAFFOLD_RELEASES[i - 1].starterVersion)
    }
  })
})

describe('immutable starter update orchestration', () => {
  it('resolves a direct GitHub-template copy from manifest-only provenance', async () => {
    const old = releaseFixture(1, oldOwnership)
    const next = releaseFixture(2, newOwnership)
    const target = directory('thally-direct-template-')
    copyTree(old.tree, target)

    expect(
      resolveStarterReleaseFromManifest(old.manifestSource, [
        old.release,
        next.release,
      ]),
    ).toEqual(old.release)

    const result = await updateStarterProject({
      targetDir: target,
      releases: [old.release, next.release],
      targetRelease: next.release,
      download: fixtureDownload(new Map([
        [old.release.source.commitSha, old.tree],
        [next.release.source.commitSha, next.tree],
      ])),
    })

    expect(result.applied).toBe(false)
    expect(result.plan.copyPaths).toEqual(['framework/runtime.ts'])
    expect(result.resolvedManualPaths).toEqual(['framework/manual.ts', 'next.config.ts'])
    expect(result.plan.manualReviewPaths).toEqual([])
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(
      old.manifestSource,
    )
  })

  it('proves a unique archive base for shared manifests and preserves customer additions', async () => {
    const { old, next, canonicalPackage, download } = sharedManifestFixtures()
    const target = directory('thally-shared-manifest-')
    copyTree(old.tree, target)
    write(target, 'package.json', JSON.stringify({ ...canonicalPackage, name: 'customer-docs', private: true,
      dependencies: { ...canonicalPackage.dependencies, 'customer-library': '^1.0.0' },
      devDependencies: { '@thallylabs/cli': '0.8.86' },
    }))
    const result = await updateStarterProject({
      targetDir: target, targetRelease: next.release, releases: [next.release, old.release],
      download,
      apply: true, confirmed: true,
    })
    expect(result.isUpToDate).toBe(false)
    expect(result.applied).toBe(true)
    expect(result.previousRelease).toEqual(old.release)
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))).toMatchObject({
      name: 'customer-docs', private: true, dependencies: { 'customer-library': '^1.0.0' },
      devDependencies: { '@thallylabs/cli': '0.8.103' },
    })
    expect(readFileSync(join(target, 'next.config.ts'), 'utf8')).toBe('config 1.1\n')
    expect(readFileSync(join(target, 'src/content/index.mdx'), 'utf8')).toBe('customer content 1\n')
  })

  it('recognizes the current archive with a retained same-manifest older release', async () => {
    const { old, next, download } = sharedManifestFixtures()
    const target = directory('thally-shared-current-')
    copyTree(next.tree, target)
    const result = await updateStarterProject({ targetDir: target, targetRelease: next.release,
      releases: [next.release, old.release], download,
    })
    expect(result.isUpToDate).toBe(true)
    expect(result.previousRelease).toEqual(next.release)
  })

  it.each(['modified', 'framework', 'lockfile', 'override', 'indistinguishable'] as const)('rejects %s same-manifest archive bases', async kind => {
    const { old, next, download } = sharedManifestFixtures()
    const target = directory('thally-shared-reject-')
    copyTree(old.tree, target)
    if (kind === 'modified') write(target, 'package.json', JSON.stringify({ dependencies: { next: 'unknown' } }))
    else if (kind === 'override') {
      const packageJson = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
      packageJson.optionalDependencies = { next: '2.0.0' }
      write(target, 'package.json', JSON.stringify(packageJson))
    } else if (kind === 'framework') write(target, 'framework/runtime.ts', 'modified runtime\n')
    else if (kind === 'lockfile') {
      const lock = JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'))
      lock.packages['node_modules/@thallylabs/cli'].version = 'unknown'
      write(target, 'package-lock.json', JSON.stringify(lock))
    } else {
      // Differences confined to customer-owned/manual defaults do not prove
      // archive identity; never select whichever record appears first.
      copyTree(old.tree, next.tree)
    }
    await expect(updateStarterProject({ targetDir: target, targetRelease: next.release,
      releases: [next.release, old.release], download,
    })).rejects.toThrow('no unique verified archive baseline')
  })

  it('rejects a tampered same-manifest archive before it can establish trust', async () => {
    const { old, next, download } = sharedManifestFixtures()
    const target = directory('thally-shared-tampered-')
    copyTree(old.tree, target)
    await expect(updateStarterProject({ targetDir: target, targetRelease: next.release,
      releases: [next.release, old.release], download: async (directory, release) => {
        await download(directory, release)
        write(directory, 'starter-release.json', '{}')
      },
    })).rejects.toThrow('promoted SHA-256')
  })

  it('preserves old protected policy and reports two-sided customer conflicts', async () => {
    const old = releaseFixture(1, oldOwnership)
    const next = releaseFixture(2, newOwnership)
    const target = directory('thally-customer-conflict-')
    copyTree(old.tree, target)
    write(target, 'framework/runtime.ts', 'customer runtime edit\n')
    write(target, 'framework/owner.ts', 'customer owner edit\n')

    const result = await updateStarterProject({
      targetDir: target,
      releases: [old.release, next.release],
      targetRelease: next.release,
      download: fixtureDownload(new Map([
        [old.release.source.commitSha, old.tree],
        [next.release.source.commitSha, next.tree],
      ])),
    })

    expect(result.plan.conflictPaths).toEqual(['framework/runtime.ts'])
    expect(result.plan.copyPaths).not.toContain('framework/owner.ts')
    await expect(updateStarterProject({
      targetDir: target,
      releases: [old.release, next.release],
      targetRelease: next.release,
      download: fixtureDownload(new Map([
        [old.release.source.commitSha, old.tree],
        [next.release.source.commitSha, next.tree],
      ])),
      apply: true,
      confirmed: true,
    })).rejects.toThrow('Resolve starter synchronization conflicts')
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(
      old.manifestSource,
    )
  })

  it('applies a clean plan and advances provenance only after success', async () => {
    const old = releaseFixture(1, oldOwnership)
    const next = releaseFixture(2, newOwnership)
    const target = directory('thally-clean-update-')
    copyTree(old.tree, target)

    const result = await updateStarterProject({
      targetDir: target,
      releases: [old.release, next.release],
      targetRelease: next.release,
      download: fixtureDownload(new Map([
        [old.release.source.commitSha, old.tree],
        [next.release.source.commitSha, next.tree],
      ])),
      apply: true,
      confirmed: true,
    })

    expect(result.applied).toBe(true)
    expect(readFileSync(join(target, 'framework/runtime.ts'), 'utf8')).toBe(
      'runtime 2\n',
    )
    expect(readFileSync(join(target, 'framework/owner.ts'), 'utf8')).toBe(
      'starter owner 1\n',
    )
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(
      next.manifestSource,
    )
  })

  it('updates forward between retained releases of the same starterVersion', async () => {
    const base = releaseFixture(2, newOwnership)
    const promoted = releaseFixture(2, newOwnership, 1)
    const target = directory('thally-same-version-forward-')
    copyTree(base.tree, target)
    // Newest-first catalog order, exactly as promotion prepends releases.
    const releases = [promoted.release, base.release]

    const result = await updateStarterProject({
      targetDir: target,
      releases,
      targetRelease: promoted.release,
      download: fixtureDownload(new Map([
        [base.release.source.commitSha, base.tree],
        [promoted.release.source.commitSha, promoted.tree],
      ])),
      apply: true,
      confirmed: true,
    })

    expect(result.isUpToDate).toBe(false)
    expect(result.applied).toBe(true)
    expect(readFileSync(join(target, 'framework/runtime.ts'), 'utf8')).toBe(
      'runtime 2.1\n',
    )
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(
      promoted.manifestSource,
    )
  })

  it('rejects a same-starterVersion downgrade to an older retained release', async () => {
    const base = releaseFixture(2, newOwnership)
    const promoted = releaseFixture(2, newOwnership, 1)
    const target = directory('thally-same-version-downgrade-')
    copyTree(promoted.tree, target)

    await expect(updateStarterProject({
      targetDir: target,
      releases: [promoted.release, base.release],
      targetRelease: base.release,
      download: fixtureDownload(new Map([
        [base.release.source.commitSha, base.tree],
        [promoted.release.source.commitSha, promoted.tree],
      ])),
    })).rejects.toThrow('does not contain a newer starter release')
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(
      promoted.manifestSource,
    )
  })

  it('rejects a same-starterVersion target that is not in the retained catalog', async () => {
    const base = releaseFixture(2, newOwnership)
    const unregistered = releaseFixture(2, newOwnership, 1)
    const target = directory('thally-same-version-unregistered-')
    copyTree(base.tree, target)

    await expect(updateStarterProject({
      targetDir: target,
      releases: [base.release],
      targetRelease: unregistered.release,
      download: fixtureDownload(new Map([
        [base.release.source.commitSha, base.tree],
        [unregistered.release.source.commitSha, unregistered.tree],
      ])),
    })).rejects.toThrow('not in the trusted release catalog')
  })

  it('still updates across starterVersions when the catalog retains same-version releases', async () => {
    const old = releaseFixture(1, oldOwnership)
    const base = releaseFixture(2, newOwnership)
    const promoted = releaseFixture(2, newOwnership, 1)
    const target = directory('thally-cross-version-forward-')
    copyTree(old.tree, target)

    const result = await updateStarterProject({
      targetDir: target,
      releases: [promoted.release, base.release, old.release],
      targetRelease: promoted.release,
      download: fixtureDownload(new Map([
        [old.release.source.commitSha, old.tree],
        [promoted.release.source.commitSha, promoted.tree],
      ])),
    })

    expect(result.isUpToDate).toBe(false)
    expect(result.plan.copyPaths).toContain('framework/runtime.ts')
  })

  it('refuses a customer-edited manifest and unconfirmed apply', async () => {
    const old = releaseFixture(1, oldOwnership)
    const next = releaseFixture(2, newOwnership)
    const target = directory('thally-manifest-edit-')
    copyTree(old.tree, target)
    const edited = JSON.parse(old.manifestSource)
    edited.repository = 'edited/starter'
    write(target, 'starter-release.json', JSON.stringify(edited))

    await expect(updateStarterProject({
      targetDir: target,
      releases: [old.release, next.release],
      targetRelease: next.release,
      download: fixtureDownload(new Map([[old.release.source.commitSha, old.tree]])),
    })).rejects.toThrow('edited, unknown')

    write(target, 'starter-release.json', old.manifestSource)
    await expect(updateStarterProject({
      targetDir: target,
      releases: [old.release, next.release],
      targetRelease: next.release,
      apply: true,
      confirmed: false,
    })).rejects.toThrow('explicit confirmation')
  })
})

describe('verified published recovery bases', () => {
  function setup() {
    const old = releaseFixture(1, oldOwnership)
    const next = releaseFixture(2, newOwnership)
    const target = directory('thally-recovery-')
    copyTree(old.tree, target)
    const alias = JSON.parse(old.manifestSource)
    alias.runtime.commitSha = 'a'.repeat(40)
    alias.runtime.treeSha = 'b'.repeat(40)
    write(target, 'starter-release.json', JSON.stringify(alias))
    return {
      old, next, target,
      options: {
        targetDir: target,
        targetRelease: next.release,
        releases: [next.release, old.release],
        download: fixtureDownload(new Map([
          [old.release.source.commitSha, old.tree],
          [next.release.source.commitSha, next.tree],
        ])),
        resolveReleaseHint: async () => old.release,
      },
    }
  }

  it('recovers promotion aliases using a real published base and preserves owner content', async () => {
    const { old, next, target, options } = setup()
    write(target, 'src/content/index.mdx', 'customer authored content\n')
    write(target, 'framework/owner.ts', 'customer owned framework exception\n')
    const before = readFileSync(join(target, 'starter-release.json'), 'utf8')
    const plan = await updateStarterProject(options)
    expect(plan.previousRelease).toEqual(old.release)
    expect(plan.recoveredProvenance).toBe(true)
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(before)
    const result = await updateStarterProject({ ...options, apply: true, confirmed: true })
    expect(result.applied).toBe(true)
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(next.manifestSource)
    expect(readFileSync(join(target, 'src/content/index.mdx'), 'utf8')).toBe('customer authored content\n')
    expect(readFileSync(join(target, 'framework/owner.ts'), 'utf8')).toBe('customer owned framework exception\n')
  })

  it('canonicalizes recovered provenance even when the published runtime is already current', async () => {
    const { old, target, options } = setup()
    const result = await updateStarterProject({ ...options, targetRelease: old.release, apply: true, confirmed: true })
    expect(result.isUpToDate).toBe(false)
    expect(result.recoveredProvenance).toBe(true)
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(old.manifestSource)
  })

  it('accepts formatting-only differences without requesting a promotion hint', async () => {
    const { old, target, options } = setup()
    write(target, 'starter-release.json', JSON.stringify(JSON.parse(old.manifestSource)))
    const result = await updateStarterProject({ ...options, resolveReleaseHint: async () => { throw new Error('unexpected hint lookup') } })
    expect(result.recoveredProvenance).toBe(true)
    expect(result.previousRelease).toEqual(old.release)
  })

  it('recovers a Windows CRLF manifest only after proving its trusted framework baseline', async () => {
    const { old, target, options } = setup()
    write(target, 'starter-release.json', old.manifestSource.replace(/\n/g, '\r\n'))
    const runtimePath = 'framework/runtime.ts'
    write(target, runtimePath, readFileSync(join(old.tree, runtimePath), 'utf8').replace(/\n/g, '\r\n'))
    const result = await updateStarterProject({ ...options, resolveReleaseHint: async () => { throw new Error('unexpected hint lookup') } })
    expect(result.recoveredProvenance).toBe(true)
    expect(result.previousRelease).toEqual(old.release)
  })

  it.each(['changed', 'missing', 'extra'])('rejects %s framework inventory without writes', async (change) => {
    const { target, options } = setup()
    if (change === 'missing') rmSync(join(target, 'framework/runtime.ts'))
    else write(target, change === 'extra' ? 'framework/extra.ts' : 'framework/runtime.ts', 'custom runtime\n')
    const before = readFileSync(join(target, 'starter-release.json'), 'utf8')
    await expect(updateStarterProject({ ...options, apply: true, confirmed: true })).rejects.toThrow('no verified published framework baseline')
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(before)
  })

  it.each(['ownership', 'packages', 'repository'])('rejects edited %s contract', async (field) => {
    const { target, options } = setup()
    const manifest = JSON.parse(readFileSync(join(target, 'starter-release.json'), 'utf8'))
    if (field === 'ownership') manifest.ownership.userOwnedNeverOverwrite.push('framework/runtime.ts')
    else if (field === 'packages') manifest.packages.next = '999.0.0'
    else manifest.repository = 'attacker/starter'
    write(target, 'starter-release.json', JSON.stringify(manifest))
    await expect(updateStarterProject(options)).rejects.toThrow('no verified published framework baseline')
  })

  it('does not trust a hint that invents a source commit', async () => {
    const { old, options } = setup()
    await expect(updateStarterProject({ ...options, resolveReleaseHint: async () => ({ ...old.release, source: { ...old.release.source, commitSha: 'f'.repeat(40) } }) })).rejects.toThrow('no verified published framework baseline')
  })

  it('requires installed package declarations to agree with the published base', async () => {
    const { target, options } = setup()
    write(target, 'package.json', JSON.stringify({ dependencies: { next: '999.0.0' } }))
    await expect(updateStarterProject(options)).rejects.toThrow('Installed starter packages')
  })

  it('rejects provenance changes while obtaining the trusted recovery archive', async () => {
    const { target, options } = setup()
    const download = options.download
    await expect(updateStarterProject({ ...options, download: async (directory, release) => {
      await download(directory, release)
      write(target, 'starter-release.json', 'changed during verification')
    } })).rejects.toThrow('manifest changed during update planning')
  })
})

describe('complete transactional starter updates', () => {
  function setup() {
    const ownership = { ...oldOwnership, manualReview: ['next.config.ts', 'package.json', 'package-lock.json'] }
    const old = releaseFixture(1, ownership)
    const next = releaseFixture(2, ownership)
    for (const fixture of [old, next]) {
      write(fixture.tree, 'package-lock.json', JSON.stringify({
        name: 'thally-starter', lockfileVersion: 3,
        packages: { '': { dependencies: { '@thallylabs/core': `${fixture.release.starterVersion}.0.0` } },
          'node_modules/@thallylabs/core': { version: `${fixture.release.starterVersion}.0.0`, resolved: `https://registry.npmjs.org/core-${fixture.release.starterVersion}.tgz`, integrity: `canonical-${fixture.release.starterVersion}` },
          'node_modules/next': { version: `${fixture.release.starterVersion}.0.0` } },
      }))
    }
    const target = directory('thally-complete-')
    copyTree(old.tree, target)
    const options = { targetDir: target, targetRelease: next.release, releases: [next.release, old.release],
      download: fixtureDownload(new Map([[old.release.source.commitSha, old.tree], [next.release.source.commitSha, next.tree]])) }
    return { old, next, target, options }
  }

  it('merges packages and lockfiles atomically while retaining independent customer fields', async () => {
    const { next, target, options } = setup()
    for (const path of ['package.json', 'package-lock.json']) {
      const current = JSON.parse(readFileSync(join(target, path), 'utf8'))
      current.name = 'customer-docs'
      write(target, path, JSON.stringify(current))
    }
    const result = await updateStarterProject({ ...options, apply: true, confirmed: true })
    expect(result.resolvedManualPaths).toEqual(['next.config.ts', 'package-lock.json', 'package.json'])
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))).toMatchObject({ name: 'customer-docs', dependencies: { '@thallylabs/core': '2.0.0' } })
    expect(JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'))).toMatchObject({ name: 'customer-docs', packages: { 'node_modules/@thallylabs/core': { version: '2.0.0' } } })
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(next.manifestSource)
  })

  it('reports exact JSON conflicts and performs no partial framework or manifest writes', async () => {
    const { old, target, options } = setup()
    const current = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    current.dependencies['@thallylabs/core'] = '99.0.0'
    write(target, 'package.json', JSON.stringify(current))
    const result = await updateStarterProject(options)
    expect(result.manualConflicts).toContainEqual({ path: 'package.json', fields: ['/dependencies/@thallylabs~1core'] })
    await expect(updateStarterProject({ ...options, apply: true, confirmed: true })).rejects.toThrow('conflicts')
    expect(readFileSync(join(target, 'framework/runtime.ts'), 'utf8')).toBe('runtime 1\n')
    expect(readFileSync(join(target, 'starter-release.json'), 'utf8')).toBe(old.manifestSource)
  })

  it('refuses alias recovery when the locked Core artifact changes at the same version', async () => {
    const { old, target, options } = setup()
    write(target, 'starter-release.json', JSON.stringify(JSON.parse(old.manifestSource)))
    const lock = JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'))
    lock.packages['node_modules/@thallylabs/core'].resolved = 'https://untrusted.invalid/core.tgz'
    write(target, 'package-lock.json', JSON.stringify(lock))
    await expect(updateStarterProject(options)).rejects.toThrow('package lock')
  })

  it('refuses alias recovery with stale locked packages', async () => {
    const { old, target, options } = setup()
    write(target, 'starter-release.json', JSON.stringify(JSON.parse(old.manifestSource)))
    const lock = JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'))
    lock.packages['node_modules/@thallylabs/core'].version = '0.0.1'
    write(target, 'package-lock.json', JSON.stringify(lock))
    await expect(updateStarterProject(options)).rejects.toThrow('package lock')
  })
})


describe('release provider failures', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([429, 502])('propagates temporary provider status %s as a retryable error', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))
    await expect(fetchStarterReleaseHint('a'.repeat(40))).rejects.toMatchObject({
      name: 'StarterReleaseProviderError', code: 'STARTER_RELEASE_PROVIDER_UNAVAILABLE',
    })
  })

  it('distinguishes absent hints from network outages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    await expect(fetchStarterReleaseHint('a'.repeat(40))).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network outage')))
    await expect(fetchStarterReleaseHint('a'.repeat(40))).rejects.toMatchObject({ code: 'STARTER_RELEASE_PROVIDER_UNAVAILABLE' })
  })

  it('propagates a recovery hint outage instead of declaring the project unsupported', async () => {
    const old = releaseFixture(1, oldOwnership)
    const target = directory('thally-provider-recovery-')
    copyTree(old.tree, target)
    const manifest = JSON.parse(old.manifestSource)
    manifest.runtime.commitSha = 'a'.repeat(40)
    write(target, 'starter-release.json', JSON.stringify(manifest))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })))
    await expect(updateStarterProject({ targetDir: target, targetRelease: old.release, releases: [old.release] })).rejects.toMatchObject({
      code: 'STARTER_RELEASE_PROVIDER_UNAVAILABLE',
    })
  })
})

describe('removing the frozen CLI from the default starter', () => {
  function setup() {
    const ownership = { ...oldOwnership, manualReview: ['package.json', 'package-lock.json'] }
    const old = releaseFixture(2, ownership)
    const next = releaseFixture(3, ownership)
    for (const [fixture, hasCli] of [[old, true], [next, false]] as const) {
      const manifest = JSON.parse(readFileSync(join(fixture.tree, 'package.json'), 'utf8'))
      manifest.devDependencies = { typescript: '5.9.3', ...(hasCli ? { '@thallylabs/cli': '0.8.120' } : {}) }
      write(fixture.tree, 'package.json', JSON.stringify(manifest))
      write(fixture.tree, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
        '': { dependencies: manifest.dependencies, devDependencies: manifest.devDependencies },
        'node_modules/@thallylabs/core': { version: `${fixture.release.starterVersion}.0.0` },
        'node_modules/typescript': { version: '5.9.3' },
        ...(hasCli ? { 'node_modules/@thallylabs/cli': { version: '0.8.120' } } : {}),
      } }))
    }
    const target = directory('thally-cli-removal-')
    copyTree(old.tree, target)
    return { target, options: { targetDir: target, targetRelease: next.release, releases: [next.release, old.release],
      download: fixtureDownload(new Map([[old.release.source.commitSha, old.tree], [next.release.source.commitSha, next.tree]])) } }
  }

  it('removes only unchanged CLI declarations and lock entries during a v2 to v3 update', async () => {
    const { target, options } = setup()
    const result = await updateStarterProject({ ...options, apply: true, confirmed: true })
    expect(result.applied).toBe(true)
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'))
    expect(manifest.devDependencies).toEqual({ typescript: '5.9.3' })
    expect(lock.packages[''].devDependencies).toEqual({ typescript: '5.9.3' })
    expect(lock.packages['node_modules/@thallylabs/cli']).toBeUndefined()
  })

  it('keeps an owner-selected CLI version as a conflict requiring review', async () => {
    const { target, options } = setup()
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    manifest.devDependencies['@thallylabs/cli'] = '0.8.99'
    write(target, 'package.json', JSON.stringify(manifest))
    const result = await updateStarterProject(options)
    expect(result.manualConflicts).toContainEqual({ path: 'package.json', fields: ['/devDependencies/@thallylabs~1cli'] })
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).devDependencies['@thallylabs/cli']).toBe('0.8.99')
  })
})
