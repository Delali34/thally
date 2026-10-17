/** Black-box coverage for help and invalid-option behavior in the published CLI. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const packageMetadata = createRequire(import.meta.url)('../../package.json') as {
  version: string
}

function runCli(...args: Array<string>) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 5_000,
  })
}

describe('migrate --source-ref', () => {
  it('lists the flag in migrate help', () => {
    expect(runCli('migrate', '--help').stdout).toContain('--source-ref <owner/repo>=<path>')
  })

  it.each(['A/b=../x', 'A/b=/abs', 'A/b=a/../b', 'noequals'])('rejects %s before any network access', (value) => {
    const result = runCli('migrate', 'https://github.com/example/docs', '--source-ref', value, '--yes')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--source-ref')
  })
})

describe('migrate --source-ref without a value', () => {
  it.each([[['--source-ref']], [['--source-ref', '--yes']]])('fails clearly for %j', (extra) => {
    const result = runCli('migrate', 'https://github.com/example/docs', ...extra)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--source-ref needs a value')
  })
})

describe('migrate --max-pages', () => {
  it.each(['1001', '10000'])('accepts %s without starting a crawl', (value) => {
    // A later invalid source-ref stops execution before migrateDocs. Reaching
    // that guard proves the actual CLI parser accepted the explicit page limit.
    const result = runCli('migrate', 'https://github.com/example/docs', '--max-pages', value, '--source-ref', 'noequals', '--yes')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--source-ref')
    expect(result.stderr).not.toContain('--max-pages must')
  })

  it.each(['0', '10001', '1.5', 'invalid'])('rejects %s before migration', (value) => {
    const result = runCli('migrate', 'https://github.com/example/docs', '--max-pages', value, '--yes')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--max-pages must be an integer between 1 and 10000')
  })

  it('documents the existing compiler limit and unchanged default', () => {
    expect(runCli('migrate', '--help').stdout).toContain('1-10000 pages (default: 1000)')
  })
})

describe('create-thally-docs help', () => {
  it.each(['--version', '-v', '-V', 'version'])('prints the package version for %s', (argument) => {
    const result = runCli(argument)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${packageMetadata.version}\n`)
    expect(result.stderr).toBe('')
  })

  it.each(['--help', '-h'])('prints root help without prompting for %s', (flag) => {
    const result = runCli(flag)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('create-thally-docs <command>')
    expect(result.stdout).not.toContain('Project directory:')
    expect(result.stderr).toBe('')
  })

  it.each([
    ['migrate', '<github-or-docs-url>', '--max-pages <count>'],
    ['check', '[project-dir]', '--external'],
    ['translate', '--locale <code>', '--pages <ids>'],
  ])('prints scoped %s help without prompting', (command, usage, option) => {
    const result = runCli(command, '--help')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`create-thally-docs ${command}`)
    expect(result.stdout).toContain(usage)
    expect(result.stdout).toContain(option)
    expect(result.stdout).not.toContain('Project directory:')
    expect(result.stderr).toBe('')
  })

  it('rejects unknown scaffold options with a useful error', () => {
    const result = runCli('--unknown')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown option "--unknown"')
    expect(result.stderr).toContain('create-thally-docs --help')
    expect(result.stdout).not.toContain('Project directory:')
  })
  it('requires no additional source-trust option for migration', () => {
    const result = runCli('migrate', '--help')
    expect(result.stdout).not.toContain('--trust-source')
    expect(result.stdout).toContain('--skip-validation')
  })

  it('rejects options outside a subcommand scope', () => {
    const result = runCli('check', '--install')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown option "--install"')
    expect(result.stderr).toContain('create-thally-docs check --help')
  })
})
