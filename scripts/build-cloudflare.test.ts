/** Provider builds retain preparation, customer overrides, and temporary-file cleanup. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

const wrapperPath = resolve('scripts/build-cloudflare.mts')
const tsxPath = resolve('node_modules/tsx/dist/cli.mjs')
// These integration fixtures launch npm and the adapter compiler under shared CI load.
const providerBuildTimeoutMs = 30_000

function runWrapper(directory: string): void {
  execFileSync(process.execPath, [tsxPath, wrapperPath], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function createBuildFixture(ownerConfig: string, hasAdapterFailure = false, nextVersion = '16.4.1'): string {
  const directory = mkdtempSync(join(tmpdir(), 'thally-provider-build-'))
  mkdirSync(join(directory, 'node_modules', 'next'), { recursive: true })
  for (const dependency of ['@opennextjs', 'wrangler', 'tsx']) {
    symlinkSync(resolve('node_modules', dependency), join(directory, 'node_modules', dependency), 'dir')
  }
  writeFileSync(join(directory, 'node_modules/next/package.json'), JSON.stringify({ name: 'next', version: nextVersion }))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    scripts: {
      'build:cloudflare:opennext': 'node --import tsx adapter.mts',
      prebuild: 'node prepare.cjs',
      build: 'node build.cjs',
      'package:cloudflare': 'node record.cjs package',
      'check:cloudflare-size': 'node record.cjs size',
    },
  }))
  writeFileSync(join(directory, 'open-next.config.ts'), ownerConfig)
  writeFileSync(join(directory, 'record.cjs'), `
    require('node:fs').appendFileSync('steps.txt', process.argv.slice(2).join(':') + '\\n')
  `)
  writeFileSync(join(directory, 'prepare.cjs'), `
    require('node:child_process').execFileSync(process.execPath, ['record.cjs', 'prepare'])
  `)
  writeFileSync(join(directory, 'build.cjs'), `
    require('node:child_process').execFileSync(process.execPath, ['record.cjs', 'build', ...process.argv.slice(2)])
  `)
  writeFileSync(join(directory, 'custom.cjs'), `
    require('node:child_process').execFileSync(process.execPath, ['record.cjs', 'custom'])
  `)
  writeFileSync(join(directory, 'adapter.mts'), `
    import { execSync } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    import { pathToFileURL } from 'node:url'
    import { compileOpenNextConfigNode } from '@opennextjs/aws/build/compileConfig.js'
    const configIndex = process.argv.indexOf('--openNextConfigPath')
    if (configIndex === -1) throw new Error('Missing explicit adapter config argument')
    const compiledPath = compileOpenNextConfigNode(process.argv[configIndex + 1], process.cwd(), [])
    const config = (await import(pathToFileURL(compiledPath).href)).default
    writeFileSync('adapter-result.json', JSON.stringify({ config, buildPhase: process.env.THALLY_CONTENT_BUILD }))
    ${hasAdapterFailure ? "process.exit(23)" : "execSync(config.buildCommand, { stdio: 'inherit' })"}
  `)
  return directory
}

function expectOwnerConfigAndCleanup(directory: string, original: string): void {
  expect(readFileSync(join(directory, 'open-next.config.ts'), 'utf8')).toBe(original)
  expect(readdirSync(directory).filter((name) => name.startsWith('.thally-open-next-build-'))).toEqual([])
}

it('explains how to opt into Cloudflare without downloading tools implicitly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'thally-no-provider-'))
  writeFileSync(join(directory, 'package.json'), '{}')
  try {
    let output = ''
    try { runWrapper(directory) } catch (error) {
      output = String((error as { stderr: string }).stderr)
    }
    expect(output).toContain('Missing optional Cloudflare tooling (@opennextjs/cloudflare)')
    expect(output).toContain('npm run setup:cloudflare')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('prepares runtime inputs before the default webpack build without changing owner configuration', () => {
  const ownerConfig = "import { ownerOptions } from './owner-options'\nexport default ownerOptions\n"
  const directory = createBuildFixture(ownerConfig)
  writeFileSync(join(directory, 'owner-options.ts'), "export const ownerOptions = { customOwnerSetting: 'retained' }\n")
  try {
    runWrapper(directory)
    expect(readFileSync(join(directory, 'steps.txt'), 'utf8').trim().split('\n')).toEqual([
      'prepare', 'build:--webpack', 'package', 'size',
    ])
    expect(JSON.parse(readFileSync(join(directory, 'adapter-result.json'), 'utf8'))).toMatchObject({
      config: { customOwnerSetting: 'retained', buildCommand: 'npm run build -- --webpack' },
      buildPhase: '1',
    })
    expect(existsSync(join(directory, '.open-next/assets/_thally/runtime-capabilities.json'))).toBe(true)
    expectOwnerConfigAndCleanup(directory, ownerConfig)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, providerBuildTimeoutMs)

it('keeps the default webpack command compatible with Next 15', () => {
  const ownerConfig = 'export default {}\n'
  const directory = createBuildFixture(ownerConfig, false, '15.5.12')
  try {
    runWrapper(directory)
    expect(readFileSync(join(directory, 'steps.txt'), 'utf8').trim().split('\n')).toEqual([
      'prepare', 'build', 'package', 'size',
    ])
    expect(JSON.parse(readFileSync(join(directory, 'adapter-result.json'), 'utf8')).config.buildCommand).toBe('npm run build')
    expectOwnerConfigAndCleanup(directory, ownerConfig)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, providerBuildTimeoutMs)

it('fails before building when the installed Next version cannot be interpreted', () => {
  const ownerConfig = 'export default {}\n'
  const directory = createBuildFixture(ownerConfig, false, 'not-a-version')
  try {
    let output = ''
    try { runWrapper(directory) } catch (error) {
      output = String((error as { stderr: string }).stderr)
    }
    expect(output).toContain('installed next/package.json must declare a valid Next.js version')
    expect(existsSync(join(directory, 'adapter-result.json'))).toBe(false)
    expectOwnerConfigAndCleanup(directory, ownerConfig)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('honors an explicit owner build command', () => {
  const ownerConfig = "export default { buildCommand: 'node custom.cjs' }\n"
  const directory = createBuildFixture(ownerConfig)
  try {
    runWrapper(directory)
    expect(readFileSync(join(directory, 'steps.txt'), 'utf8').trim().split('\n')).toEqual([
      'custom', 'package', 'size',
    ])
    expectOwnerConfigAndCleanup(directory, ownerConfig)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, providerBuildTimeoutMs)

it('cleans up the temporary config and skips packaging when the adapter fails', () => {
  const ownerConfig = 'export default {}\n'
  const directory = createBuildFixture(ownerConfig, true)
  try {
    expect(() => runWrapper(directory)).toThrow()
    expect(existsSync(join(directory, 'adapter-result.json'))).toBe(true)
    expect(existsSync(join(directory, 'steps.txt'))).toBe(false)
    expect(existsSync(join(directory, '.open-next/assets/_thally/runtime-capabilities.json'))).toBe(false)
    expectOwnerConfigAndCleanup(directory, ownerConfig)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, providerBuildTimeoutMs)

it('fails clearly when the owner adapter configuration is missing', () => {
  const directory = createBuildFixture('export default {}\n')
  rmSync(join(directory, 'open-next.config.ts'))
  try {
    let output = ''
    try { runWrapper(directory) } catch (error) {
      output = String((error as { stderr: string }).stderr)
    }
    expect(output).toContain('Missing open-next.config.ts')
    expect(existsSync(join(directory, 'adapter-result.json'))).toBe(false)
    expect(existsSync(join(directory, 'open-next.config.ts'))).toBe(false)
    expect(readdirSync(directory).filter((name) => name.startsWith('.thally-open-next-build-'))).toEqual([])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
