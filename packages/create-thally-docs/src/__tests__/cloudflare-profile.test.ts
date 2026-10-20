/** Optional provider builds fail before running project code when tooling is absent. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

it('explains how to opt into Cloudflare without downloading tools implicitly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'thally-no-provider-'))
  writeFileSync(join(directory, 'package.json'), '{}')
  try {
    let output = ''
    try {
      execFileSync(process.execPath, [
        resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/build-cloudflare.mts'),
      ], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      output = String((error as { stderr: string }).stderr)
    }
    expect(output).toContain('Missing optional Cloudflare tooling (@opennextjs/cloudflare)')
    expect(output).toContain('npm run setup:cloudflare')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
