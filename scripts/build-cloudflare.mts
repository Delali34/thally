/**
 * Build and validate the Cloudflare deployment with explicit build context.
 *
 * Managed workflows select asset-backed content with THALLY_CONTENT_SOURCE.
 * This wrapper marks the local build phase so page-data collection can read
 * authored files before an ASSETS binding exists. A temporary adapter config
 * defaults to webpack while retaining customer overrides and config bytes.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

// The same runtime wrapper is overlaid onto existing sites. Older Next
// versions already default to webpack and do not recognize its explicit flag.
const installedNext = requireFromProject('next/package.json') as { name?: unknown; version?: unknown }
const versionMatch = installedNext.name === 'next' && typeof installedNext.version === 'string'
  ? /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(installedNext.version)
  : null
if (!versionMatch || !Number.isSafeInteger(Number(versionMatch[1]))) {
  throw new Error('Cannot select the Cloudflare build command: installed next/package.json must declare a valid Next.js version.')
}
const defaultBuildCommand = Number(versionMatch[1]) >= 16
  ? 'npm run build -- --webpack'
  : 'npm run build'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const environment = {
  ...process.env,
  THALLY_CONTENT_BUILD: '1',
}

function runNpmScript(script: string, args: string[] = []): void {
  const result = spawnSync(npmCommand, ['run', script, ...(args.length ? ['--', ...args] : [])], {
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status ?? 'unknown'}.`)
  }
}

// OpenNext 1.20.12 discovers this exact filename. Keep that contract rather
// than selecting a different customer file or replacing their configuration.
if (!existsSync('open-next.config.ts')) {
  throw new Error('Missing open-next.config.ts. Run opennextjs-cloudflare migrate to configure the Cloudflare adapter before building.')
}

// A root-level temporary module keeps relative owner imports and OpenNext's
// project-root discovery intact. The adapter compiles it into its build output
// before this source is removed. Explicit owner build commands always win.
const adapterConfigPath = resolve(`.thally-open-next-build-${randomUUID()}.mjs`)
writeFileSync(adapterConfigPath, `
import ownerConfig from './open-next.config.ts'
export default {
  ...ownerConfig,
  buildCommand: ownerConfig.buildCommand ?? ${JSON.stringify(defaultBuildCommand)},
}
`, { flag: 'wx' })
try {
  runNpmScript('build:cloudflare:opennext', ['--openNextConfigPath', adapterConfigPath])
} finally {
  rmSync(adapterConfigPath, { force: true })
}
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
