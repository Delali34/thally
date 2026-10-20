/** Quiet subprocesses retain bounded failure diagnostics and enforce build timeouts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { terminal } from '../terminal.js'
import { installDeps, assertProjectNodeVersion, dependencyInstallArguments, detectPackageManager, previewCommand, quoteDirectory, runProjectCommand } from '../utils.js'

afterEach(() => vi.restoreAllMocks())

describe('project subprocess output', () => {
  it('offers one chained preview command, including skipped installation when needed', () => {
    const directory = "/tmp/docs owner's site"
    expect(previewCommand(directory)).toBe(`cd ${quoteDirectory(directory)} && npm run dev`)
    expect(previewCommand(directory, true)).toBe(`cd ${quoteDirectory(directory)} && npm install && npm run dev`)
    expect(previewCommand(directory)).not.toContain('\n')
    expect(previewCommand(directory, true, 'pnpm')).toBe(`cd ${quoteDirectory(directory)} && pnpm install && pnpm run dev`)
  })

  it('retains both streams from a failed quiet command', async () => {
    vi.spyOn(terminal, 'isRich', 'get').mockReturnValue(true)
    vi.spyOn(terminal, 'isVerbose', 'get').mockReturnValue(false)
    const failure = await runProjectCommand(process.execPath, ['-e', "console.log('build context'); console.error('missing component'); process.exitCode = 1"], process.cwd()).catch(error => error)
    expect(failure.message).toContain('exit 1')
    expect(failure.output).toContain('build context')
    expect(failure.output).toContain('missing component')
  })

  it('bounds captured output while retaining the useful tail', async () => {
    vi.spyOn(terminal, 'isRich', 'get').mockReturnValue(true)
    vi.spyOn(terminal, 'isVerbose', 'get').mockReturnValue(false)
    const failure = await runProjectCommand(process.execPath, ['-e', "console.error('x'.repeat(100000) + ' final diagnostic'); process.exitCode = 1"], process.cwd()).catch(error => error)
    expect(failure.output.length).toBeLessThan(66000)
    expect(failure.output).toContain('Earlier output omitted')
    expect(failure.output).toContain('final diagnostic')
  })

  it('does not leave a hung build running after its timeout', async () => {
    vi.spyOn(terminal, 'isRich', 'get').mockReturnValue(true)
    const failure = await runProjectCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), 50).catch(error => error)
    expect(failure.message).toContain('SIGTERM')
    expect(failure.message).toContain('Timed out after 50ms')
    expect(failure.exitCode).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('terminates descendants that hold inherited build pipes open', async () => {
    vi.spyOn(terminal, 'isRich', 'get').mockReturnValue(true)
    const start = Date.now()
    const script = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)`
    await expect(runProjectCommand(process.execPath, ['-e', script], process.cwd(), 100)).rejects.toThrow('SIGTERM')
    expect(Date.now() - start).toBeLessThan(1500)
  })

  it('quotes an absolute destination with spaces and apostrophes for the current shell', () => {
    if (process.platform !== 'win32') expect(quoteDirectory("/tmp/docs owner's site")).toBe("'/tmp/docs owner'\\''s site'")
  })
})

it('uses npm ci for a pinned site and honors pnpm, Yarn and explicit selection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'thally-package-manager-'))
  try {
    expect(dependencyInstallArguments(directory, 'npm')[0]).toBe('install')
    writeFileSync(join(directory, 'package-lock.json'), '{}')
    expect(dependencyInstallArguments(directory, 'npm')[0]).toBe('ci')
    expect(detectPackageManager(directory, undefined, 'pnpm/10.0.0')).toBe('pnpm')
    writeFileSync(join(directory, 'yarn.lock'), '')
    expect(detectPackageManager(directory, undefined, 'npm/10.9.0')).toBe('yarn')
    expect(detectPackageManager(directory, 'npm', 'pnpm/10.0.0')).toBe('npm')
    expect(dependencyInstallArguments(directory, 'pnpm')).toEqual(['install'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('checks the generated site engine before installation without mutating files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'thally-site-engine-'))
  const manifest = JSON.stringify({ engines: { node: '^20.19.0 || ^22.14.0 || >=24.0.0' } })
  try {
    writeFileSync(join(directory, 'package.json'), manifest)
    for (const version of ['20.19.0', '20.20.0', '22.14.0', '22.18.0', '24.1.0']) {
      expect(() => assertProjectNodeVersion(directory, version)).not.toThrow()
    }
    for (const version of ['18.20.0', '20.9.0', '22.0.0', '23.0.0']) {
      expect(() => assertProjectNodeVersion(directory, version)).toThrow(`you are using ${version}`)
    }
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(manifest)
    expect(existsSync(join(directory, 'node_modules'))).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('prints the required and current Node versions before a scaffold install can fail generically', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'thally-engine-diagnostic-'))
  const manifest = JSON.stringify({ engines: { node: '<1.0.0' } })
  const errorOutput = vi.spyOn(terminal, 'error').mockImplementation(() => {})
  vi.spyOn(terminal, 'warn').mockImplementation(() => {})
  try {
    writeFileSync(join(directory, 'package.json'), manifest)
    await expect(installDeps(directory, 'npm')).rejects.toThrow('requires Node.js <1.0.0')
    expect(errorOutput).toHaveBeenCalledWith(expect.stringContaining(`requires Node.js <1.0.0; you are using ${process.versions.node}`))
    expect(existsSync(join(directory, 'node_modules'))).toBe(false)
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(manifest)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
