/** Failure and concurrent-edit coverage for migration's verified seed replacement transaction. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeMigration } from '../migrate/materialize.js'

function project(): { root: string; site: string; originals: Map<string, Buffer> } {
  const root = mkdtempSync(join(tmpdir(), 'thally-migration-transaction-test-'))
  const site = join(root, 'site')
  mkdirSync(join(site, 'src/content'), { recursive: true })
  const originals = new Map([
    ['src/content/introduction.mdx', Buffer.from('Seed introduction\r\n')],
    ['src/content/quickstart.mdx', Buffer.from('Seed quickstart\n')],
    ['src/content/unused.mdx', Buffer.from('Unused seed page')],
    ['src/content/owner.mdx', Buffer.from('Owner-authored sentinel')],
    ['docs.json', Buffer.from('{"tabs":[]}')],
    ['starter-release.json', Buffer.from('verified-release-identity')],
  ])
  for (const [path, bytes] of originals) writeFileSync(join(site, path), bytes)
  return { root, site, originals }
}

const writes = [
  { path: 'src/content/introduction.mdx', content: 'Imported introduction' },
  { path: 'src/content/quickstart.mdx', content: 'Imported quickstart' },
  { path: 'src/content/new.mdx', content: 'Imported new page' },
  { path: 'docs.json', content: '{"tabs":[{"tab":"Imported"}]}' },
]

describe('verified seed replacement transaction', () => {
  it('replaces two proven seed collisions and removes unused seed while retaining nonseed owner bytes', () => {
    const { site, originals } = project()
    materializeMigration(site, writes, ['src/content/unused.mdx'], { preconditions: originals })
    expect(readFileSync(join(site, 'src/content/introduction.mdx'), 'utf8')).toBe('Imported introduction')
    expect(readFileSync(join(site, 'src/content/quickstart.mdx'), 'utf8')).toBe('Imported quickstart')
    expect(existsSync(join(site, 'src/content/unused.mdx'))).toBe(false)
    expect(readFileSync(join(site, 'src/content/owner.mdx'))).toEqual(originals.get('src/content/owner.mdx'))
  })
  it.each([0, 3, 4])('restores replaced files, deleted seed, config and new-file absence on mutation failure %s', (failureIndex) => {
    const { root, site, originals } = project()
    expect(() => materializeMigration(site, writes, ['src/content/unused.mdx'], { preconditions: originals, onMutationApplied: (_path, index) => { if (index === failureIndex) throw new Error('Injected filesystem failure') } })).toThrow('Injected filesystem failure')
    for (const [path, bytes] of originals) expect(readFileSync(join(site, path))).toEqual(bytes)
    expect(existsSync(join(site, 'src/content/new.mdx'))).toBe(false)
    expect(readdirSync(root).filter((path) => path.startsWith('.thally-migration-transaction-'))).toEqual([])
  })
  it('aborts before any write if an owner edits a seed after asynchronous proof', () => {
    const { site, originals } = project()
    writeFileSync(join(site, 'src/content/quickstart.mdx'), 'An owner edit after proof')
    expect(() => materializeMigration(site, writes, ['src/content/unused.mdx'], { preconditions: originals })).toThrow('changed after planning: src/content/quickstart.mdx')
    expect(readFileSync(join(site, 'src/content/introduction.mdx'))).toEqual(originals.get('src/content/introduction.mdx'))
    expect(readFileSync(join(site, 'src/content/quickstart.mdx'), 'utf8')).toBe('An owner edit after proof')
    expect(existsSync(join(site, 'src/content/unused.mdx'))).toBe(true)
  })
  it('rejects a symlinked deletion destination before any write', () => {
    const { root, site } = project()
    const external = join(root, 'external.mdx')
    writeFileSync(external, 'External owner page')
    symlinkSync(external, join(site, 'src/content/alias.mdx'))
    expect(() => materializeMigration(site, writes, ['src/content/alias.mdx'])).toThrow('symbolic link')
    expect(readFileSync(external, 'utf8')).toBe('External owner page')
    expect(readFileSync(join(site, 'src/content/introduction.mdx'), 'utf8')).toBe('Seed introduction\r\n')
  })
})
