/** Local migration snapshots and output writes must remain inside explicit roots. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMigrationDestination, assertSeparateMigrationDirectories, snapshotLocalMigration } from '../migrate/local-source.js'
import { hasUntouchedSeedNavigation } from '../migrate/into.js'

describe('trusted local migration boundary', () => {
  it('snapshots inert source data without secrets, dependencies, or escaping symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-local-source-'))
    const source = join(root, 'source')
    mkdirSync(join(source, 'node_modules'), { recursive: true })
    writeFileSync(join(source, 'guide.mdx'), '# Guide')
    writeFileSync(join(source, 'docs.json'), '{"navigation":{}}')
    writeFileSync(join(source, '.env'), 'SECRET=value')
    writeFileSync(join(source, 'node_modules', 'secret.md'), 'dependency')
    writeFileSync(join(root, 'outside.md'), 'outside')
    symlinkSync(join(root, 'outside.md'), join(source, 'escape.md'))
    symlinkSync(join(source, '.env'), join(source, 'pretend.md'))
    symlinkSync(join(source, 'guide.mdx'), join(source, 'inside.md'))
    const output = join(root, 'snapshot')
    snapshotLocalMigration(source, output)
    expect(readFileSync(join(output, 'guide.mdx'), 'utf8')).toBe('# Guide')
    expect(readFileSync(join(output, 'inside.md'), 'utf8')).toBe('# Guide')
    for (const excluded of ['.env', 'node_modules', 'escape.md', 'pretend.md']) expect(existsSync(join(output, excluded))).toBe(false)
  })
  it('rejects source/output overlap through an existing symlink ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-local-overlap-'))
    const source = join(root, 'source')
    mkdirSync(source)
    symlinkSync(source, join(root, 'alias'))
    expect(() => assertSeparateMigrationDirectories(source, join(root, 'alias', 'new-docs'))).toThrow('must not overlap')
    expect(() => assertSeparateMigrationDirectories(source, root)).toThrow('must not overlap')
    expect(() => assertSeparateMigrationDirectories(source, join(root, 'output'))).not.toThrow()
  })
  it('rejects nested and dangling destination symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-output-links-'))
    mkdirSync(join(root, 'site'))
    symlinkSync(join(root, 'missing'), join(root, 'site', 'src'))
    expect(() => assertMigrationDestination(join(root, 'site'), 'src/content/guide.mdx')).toThrow('symbolic link')
    expect(() => assertMigrationDestination(join(root, 'site'), '../outside')).toThrow('escapes')
  })
  it('replaces only seed navigation with verified unchanged content, allowing CRLF', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-seed-nav-'))
    const baseline = join(root, 'baseline')
    const project = join(root, 'project')
    const config = { tabs: [{ tab: 'Guide', pages: ['introduction'] }] }
    for (const directory of [baseline, project]) {
      mkdirSync(join(directory, 'src/content'), { recursive: true })
      writeFileSync(join(directory, 'docs.json'), JSON.stringify(config))
      writeFileSync(join(directory, 'src/content/introduction.mdx'), '---\ntitle: Welcome\n---\nSeed.\n')
    }
    writeFileSync(join(project, 'src/content/introduction.mdx'), readFileSync(join(project, 'src/content/introduction.mdx'), 'utf8').replace(/\n/g, '\r\n'))
    expect(hasUntouchedSeedNavigation(project, baseline, config)).toBe(true)
    writeFileSync(join(project, 'src/content/introduction.mdx'), 'My own introduction')
    expect(hasUntouchedSeedNavigation(project, baseline, config)).toBe(false)
    expect(hasUntouchedSeedNavigation(project, baseline, { tabs: [{ tab: 'Authored', pages: ['guide'] }] })).toBe(false)
  })
})

describe('unresolved migration links', () => {
  it('reports unknown prose destinations while recognizing machine links and skipping samples', async () => {
    const { reportUnresolvedMigrationLinks } = await import('../migrate/links.js')
    const bundle = { sourceUrl: 'local-directory', sourceKind: 'repository' as const, platform: 'mintlify' as const, pages: [{ id: 'guide', navigationId: 'guide', title: 'Guide', description: '', keywords: [], source: 'guide.mdx', body: '[Missing](/missing) [Machine](/llms.txt) [Mirror](/guide.md)\n\n```md\n[Sample](/example)\n```' }], assets: [], docsConfig: { tabs: [] }, warnings: [] as import('@thallylabs/migrate').MigrationWarning[], stats: { discovered: 1, imported: 1, skipped: 0 } }
    reportUnresolvedMigrationLinks(bundle)
    expect(bundle.warnings).toEqual([{ code: 'unsupported-config', source: 'guide', message: expect.stringContaining('/missing') }])
    expect(bundle.warnings[0].message).not.toContain('/example')
    expect(bundle.warnings[0].message).not.toContain('/guide.md')
  })
})

describe('authored documentation in output-named folders', () => {
  it('keeps root and nested navigation-proven build sections while excluding generated output', async () => {
    const { migrateRepository } = await import('@thallylabs/migrate')
    const root = mkdtempSync(join(tmpdir(), 'thally-authored-build-docs-'))
    const source = join(root, 'source')
    for (const directory of ['build', 'guides/build', 'dist', 'coverage', '.next']) mkdirSync(join(source, directory), { recursive: true })
    writeFileSync(join(source, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { groups: [{ group: 'Guides', pages: ['build/overview', 'guides/build/overview'] }] } }))
    for (const page of ['build/overview', 'guides/build/overview', 'dist/generated', 'coverage/generated', '.next/generated']) writeFileSync(join(source, `${page}.mdx`), '# Overview\n\nAuthored documentation.')
    const snapshot = join(root, 'snapshot')
    snapshotLocalMigration(source, snapshot)
    expect(existsSync(join(snapshot, 'build/overview.mdx'))).toBe(true)
    expect(existsSync(join(snapshot, 'guides/build/overview.mdx'))).toBe(true)
    for (const excluded of ['dist', 'coverage', '.next']) expect(existsSync(join(snapshot, excluded))).toBe(false)
    const migrated = migrateRepository({ repositoryDir: snapshot, sourceUrl: 'https://local.invalid/source', platform: 'mintlify' })
    expect(migrated.pages.map((page) => page.id)).toEqual(['build/overview', 'guides/build/overview'])
  })
  it.each([undefined, 'docs'])('keeps build sections in the detected or explicit docs root (%s)', (docsDir) => {
    const root = mkdtempSync(join(tmpdir(), 'thally-docs-root-build-'))
    const source = join(root, 'source')
    mkdirSync(join(source, 'docs/build'), { recursive: true })
    mkdirSync(join(source, 'dist'), { recursive: true })
    writeFileSync(join(source, 'docs/build/overview.mdx'), '# Build guide')
    writeFileSync(join(source, 'dist/generated.mdx'), '# Generated artifact')
    const snapshot = join(root, 'snapshot')
    snapshotLocalMigration(source, snapshot, docsDir)
    expect(readFileSync(join(snapshot, 'docs/build/overview.mdx'), 'utf8')).toBe('# Build guide')
    expect(existsSync(join(snapshot, 'dist'))).toBe(false)
  })
})

describe('actual mounted API route diagnostics', () => {
  it('recognizes generated, referenced and static endpoint routes but reports nonexistent routes', async () => {
    const { reportUnresolvedMigrationLinks } = await import('../migrate/links.js')
    const schema = { openapi: '3.0.0', paths: { '/users/{id}': { $ref: '#/components/pathItems/User' }, '/secret': { get: { 'x-hidden': true, responses: {} } } }, components: { pathItems: { User: { get: { responses: {} } } } }, webhooks: { orderCreated: { post: { responses: {} } } } }
    const bundle: import('@thallylabs/migrate').MigrationBundle = {
      sourceUrl: 'local-directory', sourceKind: 'repository', platform: 'mintlify',
      pages: [{ id: 'guide', navigationId: 'guide', title: 'Guide', description: '', keywords: [], source: 'guide.mdx', body: '[Real](/api/default/users/id/get) [Alias case](/API/DEFAULT/USERS/ID/GET/) [Static](/api/custom) [Webhook](/api/default/webhooks/ordercreated/post) [Missing](/api/nonexistent-endpoint) [Hidden](/api/default/secret/get)' }, { id: 'api/custom', navigationId: 'api/custom', title: 'Custom endpoint', description: '', keywords: [], source: 'api/custom.mdx', body: '', openapi: 'GET /users/{id}' }],
      assets: [{ path: 'openapi/example.json', projectRelative: true, content: Buffer.from(JSON.stringify(schema)) }],
      docsConfig: { tabs: [{ tab: 'API', api: { source: 'openapi/example.json' } }] }, warnings: [], stats: { discovered: 2, imported: 2, skipped: 0 },
    }
    reportUnresolvedMigrationLinks(bundle)
    expect(bundle.warnings).toHaveLength(1)
    expect(bundle.warnings[0].message).toContain('/api/nonexistent-endpoint, /api/default/secret/get')
    expect(bundle.warnings[0].message).not.toContain('/api/default/users')
    expect(bundle.warnings[0].message).not.toContain('/api/custom')
    expect(bundle.warnings[0].message).not.toContain('/api/default/webhooks')
  })
})


describe('explicit local docs-root confinement', () => {
  it('rejects a selected docs directory that resolves outside the source before reading its config', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-docs-root-symlink-'))
    const source = join(root, 'source')
    const outside = join(root, 'outside')
    mkdirSync(source)
    mkdirSync(outside)
    writeFileSync(join(outside, 'docs.json'), '{"navigation": {}}')
    symlinkSync(outside, join(source, 'docs'))
    expect(() => snapshotLocalMigration(source, join(root, 'snapshot'), 'docs')).toThrow('must remain inside')
    expect(existsSync(join(root, 'snapshot'))).toBe(false)
  })
})
