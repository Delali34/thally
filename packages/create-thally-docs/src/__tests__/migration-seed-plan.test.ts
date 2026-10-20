/** Verified starter proof must authorize seed replacement through the real materializer policy. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ baseline: '', wait: undefined as Promise<void> | undefined, downloaded: undefined as (() => void) | undefined }))
// These tests isolate the already-verified immutable archive boundary. The
// downloader/updater suites and candidate CLI replay verify release authenticity.
vi.mock('../download.js', () => ({ downloadStarter: async (target: string) => {
  boundary.downloaded?.()
  await boundary.wait
  cpSync(boundary.baseline, target, { recursive: true })
} }))
vi.mock('../starter-update.js', () => ({ resolveStarterUpdateBase: async () => ({ release: { id: 'synthetic-verified-seed-fixture', source: { commitSha: 'a'.repeat(40) } } }) }))
vi.mock('../utils.js', () => ({ installDeps: vi.fn(), initGit: vi.fn() }))
vi.mock('../migrate/validate.js', () => ({ validateMigration: async () => ({ content: 'passed', build: 'passed', messages: [] }) }))
vi.mock('../migration-work.js', async () => {
  const engine = await import('@thallylabs/migrate')
  return { convertRepository: engine.migrateRepository, renderFiles: engine.renderMigrationFiles }
})
import { migrateDocs } from '../migrate/index.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thally-verified-seed-import-'))
  const baseline = join(root, 'baseline')
  const site = join(root, 'site')
  const source = join(root, 'source')
  mkdirSync(join(baseline, 'src/content'), { recursive: true })
  const config = { tabs: [{ tab: 'Starter', pages: ['introduction', 'quickstart', 'unused'] }] }
  writeFileSync(join(baseline, 'docs.json'), JSON.stringify(config))
  writeFileSync(join(baseline, 'starter-release.json'), 'synthetic verified manifest bytes')
  for (const name of ['introduction', 'quickstart', 'unused']) writeFileSync(join(baseline, `src/content/${name}.mdx`), `# Seed ${name}\n\nSeed prose.\n`)
  cpSync(baseline, site, { recursive: true })
  // An extra owner-authored file is not part of the verified seed inventory.
  writeFileSync(join(site, 'src/content/owner.mdx'), '# Owner sentinel\n\nKeep every byte.\n')
  mkdirSync(source)
  writeFileSync(join(source, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { groups: [{ group: 'Imported', pages: ['introduction', 'quickstart'] }] } }))
  for (const name of ['introduction', 'quickstart']) writeFileSync(join(source, `${name}.mdx`), `# Imported ${name}\n\nIncoming prose.\n`)
  boundary.baseline = baseline
  return { site, source }
}

beforeEach(() => { boundary.wait = undefined; boundary.downloaded = undefined })

describe('verified seed import orchestration', () => {
  it('overwrites two seed collisions, removes unused seed and preserves owner content after navigation replacement', async () => {
    const { site, source } = fixture()
    const owner = readFileSync(join(site, 'src/content/owner.mdx'))
    const result = await migrateDocs({ sourceUrl: source, sourceDirectory: source, projectDir: site, into: true, yes: true, skipValidation: true })
    expect(result.pagesWritten).toBe(2)
    expect(result.validation.content).toBe('passed')
    for (const name of ['introduction', 'quickstart']) expect(readFileSync(join(site, `src/content/${name}.mdx`), 'utf8')).toContain('Incoming prose.')
    expect(existsSync(join(site, 'src/content/unused.mdx'))).toBe(false)
    expect(readFileSync(join(site, 'src/content/owner.mdx'))).toEqual(owner)
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
    expect(report.conflicts).toEqual([])
    expect(report.removedSeedPaths).toEqual(['src/content/unused.mdx'])
    expect(report.replacedSeedRelease).toEqual({ id: 'synthetic-verified-seed-fixture', sourceCommit: 'a'.repeat(40) })
    expect(JSON.parse(readFileSync(join(site, 'docs.json'), 'utf8')).tabs.some((tab: { tab: string }) => tab.tab === 'Starter')).toBe(false)
  })
  it('waits for archive verification and preserves a seed edited while that verification is pending', async () => {
    const { site, source } = fixture()
    let continueDownload!: () => void
    boundary.wait = new Promise<void>((resolve) => { continueDownload = resolve })
    const started = new Promise<void>((resolve) => { boundary.downloaded = resolve })
    const migration = migrateDocs({ sourceUrl: source, sourceDirectory: source, projectDir: site, into: true, yes: true, skipValidation: true })
    await started
    expect(readFileSync(join(site, 'src/content/introduction.mdx'), 'utf8')).toContain('Seed prose.')
    expect(existsSync(join(site, 'src/content/unused.mdx'))).toBe(true)
    writeFileSync(join(site, 'src/content/quickstart.mdx'), '# Edited by the owner while verifying')
    continueDownload()
    const result = await migration
    expect(result.validation.content).toBe('failed')
    expect(readFileSync(join(site, 'src/content/quickstart.mdx'), 'utf8')).toBe('# Edited by the owner while verifying')
    expect(existsSync(join(site, 'src/content/unused.mdx'))).toBe(true)
    expect(readFileSync(join(site, 'src/content/owner.mdx'), 'utf8')).toContain('Keep every byte.')
  })
})
