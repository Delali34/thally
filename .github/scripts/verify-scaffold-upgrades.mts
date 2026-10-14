/**
 * Pre-publication CLI for the shared, credential-free historical upgrade gate.
 * Inputs are exact candidate records and retained history from the reviewed
 * checkout. Downloaded archives are data only; their code is never executed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadStarter } from '../../packages/create-thally-docs/src/download.js'
import type { ScaffoldRelease } from '../../packages/create-thally-docs/src/release.js'
import { assertCanonicalScaffoldUpgradeRelease, verifyScaffoldUpgrades } from '../../packages/create-thally-docs/src/starter-upgrade-canary.js'

const [recordPath, candidateDirectory, historyPath, currentPath] = process.argv.slice(2)
if (!recordPath || !candidateDirectory || !historyPath || !currentPath) {
  throw new Error('Usage: verify-scaffold-upgrades.mts <record> <candidate-directory|download> <history> <current-record>')
}
const target = JSON.parse(readFileSync(recordPath, 'utf8')) as ScaffoldRelease
assertCanonicalScaffoldUpgradeRelease(target)
const releases = JSON.parse(readFileSync(historyPath, 'utf8')) as ScaffoldRelease[]
const current = JSON.parse(readFileSync(currentPath, 'utf8')) as ScaffoldRelease
if (!Array.isArray(releases) || ![target, ...releases].some(release =>
  release.id === current.id && release.source.manifestSha256 === current.source.manifestSha256 && release.source.commitSha === current.source.commitSha,
)) throw new Error('The outgoing stable release is absent from the trusted retained catalog.')
const workspace = mkdtempSync(join(tmpdir(), 'thally-prepublish-upgrades-'))
try {
  const directory = candidateDirectory === 'download' ? join(workspace, 'candidate') : candidateDirectory
  if (candidateDirectory === 'download') {
    mkdirSync(directory)
    await downloadStarter(directory, undefined, target, { announce: false })
  }
  const bases = await verifyScaffoldUpgrades({ target, candidateDirectory: directory, releases, current })
  console.info(`Historical upgrade canaries passed before publication: ${bases.join(', ')}`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
