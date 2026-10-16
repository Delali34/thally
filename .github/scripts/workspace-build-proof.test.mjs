/** A package build receipt is valid only for exact bytes in its original job. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hasCurrentWorkspaceBuild, proofContext, recordWorkspaceBuild } from '../../scripts/workspace-build-proof.mjs'

test('standalone builds and repository-local receipts cannot opt out of compilation', () => {
  assert.equal(proofContext({}), null)
  assert.equal(proofContext({ GITHUB_ACTIONS: 'true', GITHUB_JOB: 'publish' }), null)
  assert.equal(hasCurrentWorkspaceBuild(null), false)
})

test('reuse requires unchanged source, dependency lock, outputs, and job identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'thally-proof-'))
  const runner = mkdtempSync(join(tmpdir(), 'thally-runner-'))
  try {
    execFileSync('git', ['init', '-q', directory])
    mkdirSync(join(directory, 'packages/example/dist'), { recursive: true })
    writeFileSync(join(directory, 'package-lock.json'), 'lock-v1')
    writeFileSync(join(directory, 'packages/example/package.json'), '{}')
    writeFileSync(join(directory, 'packages/example/source.ts'), 'source-v1')
    writeFileSync(join(directory, 'packages/example/dist/index.js'), 'output-v1')
    const environment = { GITHUB_ACTIONS: 'true', GITHUB_JOB: 'verify', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: runner,
      THALLY_CI_PACKAGE_BUILD_PROOF: 'true' }
    const context = proofContext(environment, directory)
    assert.ok(context)
    assert.equal(hasCurrentWorkspaceBuild(context), false)
    recordWorkspaceBuild(context)
    assert.equal(hasCurrentWorkspaceBuild(context), true)
    for (const path of ['packages/example/source.ts', 'package-lock.json', 'packages/example/dist/index.js']) {
      writeFileSync(join(directory, path), 'changed')
      assert.equal(hasCurrentWorkspaceBuild(context), false, path)
      recordWorkspaceBuild(context)
      assert.equal(hasCurrentWorkspaceBuild(context), true)
    }
    writeFileSync(join(directory, 'packages/example/new-source.ts'), 'new')
    assert.equal(hasCurrentWorkspaceBuild(context), false)
    recordWorkspaceBuild(context)
    assert.equal(hasCurrentWorkspaceBuild(proofContext({ ...environment, GITHUB_RUN_ATTEMPT: '2' }, directory)), false)
    assert.equal(hasCurrentWorkspaceBuild(proofContext({ ...environment, NODE_OPTIONS: '--no-warnings' }, directory)), false)
    assert.equal(proofContext({ ...environment, THALLY_CI_PACKAGE_BUILD_PROOF: join(directory, 'thally-package-build-proof.json') }, directory), null)
    rmSync(join(directory, 'packages/example/dist'), { recursive: true })
    assert.equal(hasCurrentWorkspaceBuild(context), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(runner, { recursive: true, force: true })
  }
})
