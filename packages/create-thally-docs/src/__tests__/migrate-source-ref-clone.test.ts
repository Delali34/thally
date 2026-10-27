/** sourceRef clones are untrusted and size-checked before any network clone. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cloneCalls, oversize } = vi.hoisted(() => ({
  cloneCalls: [] as Array<{ repo: string; options: unknown }>,
  oversize: { reason: null as string | null },
}))

vi.mock('../utils.js', () => ({ installDeps: vi.fn(), initGit: vi.fn() }))
vi.mock('../migrate/validate.js', () => ({ validateMigration: vi.fn().mockResolvedValue({ content: 'passed', build: 'passed', messages: [] }) }))
vi.mock('@thallylabs/migrate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@thallylabs/migrate')>()),
  sourceRefOversizeReason: async () => oversize.reason,
  cloneGitHubRepository: async (source: { repo: string }, directory: string, _warnings: unknown, options: unknown) => {
    cloneCalls.push({ repo: source.repo, options })
    mkdirSync(directory, { recursive: true })
    const main = source.repo === 'docs'
    writeFileSync(join(directory, 'docs.json'), JSON.stringify({ navigation: { pages: main ? ['intro', { sourceRef: 'acme/sdk' }] : ['sdk-intro'] } }))
    writeFileSync(join(directory, main ? 'intro.mdx' : 'sdk-intro.mdx'), '---\ntitle: Page\n---\n\nHello\n')
  },
}))

// Worker parity is covered in migration-work.test.ts; run conversion in-process here.
vi.mock('../migration-work.js', async () => {
  const engine = await import('@thallylabs/migrate')
  return { convertRepository: engine.migrateRepository, renderFiles: engine.renderMigrationFiles }
})

import { migrateDocs } from '../migrate/index.js'

async function run(): Promise<{ warnings: Array<string>; pages: number }> {
  const projectDir = mkdtempSync(join(tmpdir(), 'thally-cli-source-ref-'))
  writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [] }))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const result = await migrateDocs({ sourceUrl: 'https://github.com/acme/docs', projectDir, into: true, yes: true, platform: 'mintlify', sourceRefs: [{ repo: 'acme/sdk', mountPath: 'sdk' }] })
  return { warnings: warn.mock.calls.map((call) => String(call[0])), pages: result.pagesWritten }
}

describe('sourceRef clone', () => {
  beforeEach(() => {
    cloneCalls.length = 0
    oversize.reason = null
    vi.clearAllMocks()
  })

  it('clones the referenced repository without following its submodules', async () => {
    const { pages } = await run()
    expect(cloneCalls.find((call) => call.repo === 'sdk')?.options).toEqual({ skipSubmodules: true })
    // The main repository keeps its submodules (no `skipSubmodules`) and says which docs directory its `.mintignore` is read from.
    expect(cloneCalls.find((call) => call.repo === 'docs')?.options).toEqual({ docsDir: undefined })
    expect(pages).toBe(2)
  })

  it('refuses an oversized repository with a warning and never clones it', async () => {
    oversize.reason = 'GitHub reports it as 900 MB, over the 200 MB limit for a referenced repository.'
    const { warnings } = await run()
    expect(cloneCalls.map((call) => call.repo)).toEqual(['docs'])
    expect(warnings.some((line) => line.includes('sourceRef acme/sdk was not imported') && line.includes('900 MB'))).toBe(true)
  })
})
