/**
 * Build and validate the Cloudflare deployment with explicit build context.
 *
 * Managed workflows select asset-backed content with THALLY_CONTENT_SOURCE.
 * This wrapper only marks the local build phase, allowing page-data collection
 * to read authored files before an ASSETS binding exists. Self-hosted builds
 * keep their default embedded-content behavior unchanged.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

// Resolve from the project so trusted managed tooling and an owner's explicit
// provider profile obey the same package boundary. Never fall back to npx.
const requireFromProject = createRequire(resolve('package.json'))
for (const dependency of ['@opennextjs/cloudflare', 'wrangler']) {
  try { requireFromProject.resolve(dependency) } catch {
    throw new Error(`Missing optional Cloudflare tooling (${dependency}). Run npm run setup:cloudflare before building for Cloudflare.`)
  }
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const environment = {
  ...process.env,
  THALLY_CONTENT_BUILD: '1',
}

function runNpmScript(script: string): void {
  const result = spawnSync(npmCommand, ['run', script], {
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status ?? 'unknown'}.`)
  }
}

runNpmScript('build:cloudflare:opennext')
// The managed builder reads this build-owned marker before admitting the
// release as a parent for docs.json-only publishes. Repositories on an older
// runtime omit it and safely take the full-build path until upgraded.
mkdirSync('.open-next/assets/_thally', { recursive: true })
writeFileSync(
  '.open-next/assets/_thally/runtime-capabilities.json',
  `${JSON.stringify({ version: 1, docsConfigBinding: true, showPoweredByPolicy: true })}\n`,
  'utf8',
)
runNpmScript('package:cloudflare')
runNpmScript('check:cloudflare-size')
