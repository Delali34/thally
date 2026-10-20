/** End-to-end CLI materialization through the shared public URL engine. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MigrationFetcher } from '@thallylabs/migrate'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scaffoldMock, installDepsMock, initGitMock, validateMigrationMock } = vi.hoisted(() => ({
  scaffoldMock: vi.fn(),
  installDepsMock: vi.fn(),
  initGitMock: vi.fn(),
  validateMigrationMock: vi.fn(),
}))

vi.mock('../scaffold.js', () => ({ scaffold: scaffoldMock }))
vi.mock('../utils.js', () => ({ installDeps: installDepsMock, initGit: initGitMock }))
vi.mock('../migrate/validate.js', () => ({ validateMigration: validateMigrationMock }))

// These materialization fixtures exercise main-thread policy; worker parity and
// isolation are covered separately with the actual compiled worker entry.
vi.mock('../migration-work.js', async () => {
  const engine = await import('@thallylabs/migrate')
  return { convertRepository: engine.migrateRepository, renderFiles: engine.renderMigrationFiles }
})

import { migrateDocs } from '../migrate/index.js'
import { terminal } from '../terminal.js'

describe('CLI migration flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    validateMigrationMock.mockResolvedValue({ content: 'passed', build: 'passed', messages: [] })
  })

  it('discovers, merges, and writes a live docs migration into an existing project', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-cli-migrate-'))
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({
      tabs: [{ tab: 'Existing', groups: [{ group: 'Keep', pages: ['existing', 'introduction'] }] }],
    }))
    const fetcher: MigrationFetcher = async (url) => {
      if (url.toString() === 'https://docs.example.com/docs') {
        return {
          finalUrl: url,
          contentType: 'text/html',
          body: '<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Documentation homepage with enough useful content to migrate safely.</p></main></body></html>',
        }
      }
      if (url.toString() === 'https://docs.example.com/docs.md') {
        return {
          finalUrl: url,
          contentType: 'text/markdown',
          body: '---\ntitle: Imported docs\ndescription: Migrated documentation.\n---\n\n# Imported docs\n\nThe imported page body.',
        }
      }
      throw new Error('not found')
    }

    const result = await migrateDocs({
      sourceUrl: 'https://docs.example.com/docs',
      projectDir,
      into: true,
      yes: true,
      fetcher,
    })

    expect(result.pagesWritten).toBe(1)
    expect(result.validation.build).toBe('passed')
    expect(validateMigrationMock).toHaveBeenCalledWith(projectDir, undefined, false)
    expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).pages).toBe(1)
    expect(readFileSync(join(projectDir, 'src/content/introduction.mdx'), 'utf8')).toContain('The imported page body.')
    const config = JSON.parse(readFileSync(join(projectDir, 'docs.json'), 'utf8')) as { tabs: Array<{ tab: string }> }
    expect(config.tabs.map((tab) => tab.tab)).toEqual(['Existing'])
  })

  it('warns about OpenAPI files already under public/ when importing into an existing site, without deleting them', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-cli-migrate-public-spec-'))
    mkdirSync(join(projectDir, 'public'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Existing', groups: [{ group: 'Keep', pages: ['existing'] }] }] }))
    const stale = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/a': { get: { 'x-hidden': true, responses: {} } } } })
    writeFileSync(join(projectDir, 'public', 'openapi.json'), stale)
    writeFileSync(join(projectDir, 'public', 'manifest.json'), '{"name":"not a spec"}')
    const fetcher: MigrationFetcher = async (url) => {
      if (url.toString() === 'https://docs.example.com/docs') {
        return { finalUrl: url, contentType: 'text/html', body: '<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Documentation homepage with enough useful content to migrate safely.</p></main></body></html>' }
      }
      if (url.toString() === 'https://docs.example.com/docs.md') {
        return { finalUrl: url, contentType: 'text/markdown', body: '---\ntitle: Imported docs\n---\n\n# Imported docs\n\nThe imported page body.' }
      }
      throw new Error('not found')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let result
    try {
      result = await migrateDocs({ sourceUrl: 'https://docs.example.com/docs', projectDir, into: true, yes: true, fetcher })
    } finally {
      warn.mockRestore()
    }
    const message = result.warnings.map((warning) => warning.message).join('\n')
    expect(message).toContain('public/openapi.json')
    expect(message).toContain('contains x-excluded/x-hidden operations')
    expect(message).toContain('does not remove old copies from public/')
    expect(message).not.toContain('manifest.json')
    expect(readFileSync(join(projectDir, 'public', 'openapi.json'), 'utf8')).toBe(stale)
  })

  it.each([
    { yes: false, skipValidation: false, failsInstallation: false },
    { yes: true, skipValidation: false, failsInstallation: false },
    { yes: true, skipValidation: false, failsInstallation: true },
    { yes: true, skipValidation: true, failsInstallation: false },
  ])('retains fresh imports and reports with yes=$yes, skip=$skipValidation, install failure=$failsInstallation', async ({ yes, skipValidation, failsInstallation }) => {
    const success = vi.spyOn(terminal, 'success')
    if (failsInstallation) {
      // Installation now runs asynchronously; a rejection must still retain the
      // import and mark build validation as failed in the durable report.
      installDepsMock.mockRejectedValueOnce(new Error('Registry unavailable'))
      validateMigrationMock.mockResolvedValueOnce({ content: 'passed', build: 'failed', messages: ['Dependency installation failed'] })
    }
    if (skipValidation) {
      validateMigrationMock.mockResolvedValueOnce({ content: 'skipped', build: 'skipped', messages: ['Validation skipped'] })
    }
    const parentDir = mkdtempSync(join(tmpdir(), 'thally-cli-fresh-migrate-'))
    const projectDir = join(parentDir, 'site')
    scaffoldMock.mockImplementationOnce(async ({ projectDir: targetDir }: { projectDir: string }) => {
      mkdirSync(join(targetDir, 'src/content/es'), { recursive: true })
      writeFileSync(join(targetDir, 'docs.json'), JSON.stringify({
        markdown: { enabled: true },
        tabs: [{ tab: 'Starter', groups: [{ group: 'Start', pages: ['introduction', 'quickstart'] }] }],
      }))
      writeFileSync(join(targetDir, 'src/content/introduction.mdx'), 'Starter introduction')
      writeFileSync(join(targetDir, 'src/content/quickstart.mdx'), 'Starter quickstart')
      writeFileSync(join(targetDir, 'src/content/es/introduction.mdx'), 'Starter translation')
      writeFileSync(join(targetDir, 'openapi.yaml'), 'openapi: 3.0.0')
      return { projectDir: targetDir }
    })
    const fetcher: MigrationFetcher = async (url) => {
      if (url.toString() === 'https://docs.example.com/docs') {
        return {
          finalUrl: url,
          contentType: 'text/html',
          body: '<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Documentation homepage with enough useful content to migrate safely.</p></main></body></html>',
        }
      }
      if (url.toString() === 'https://docs.example.com/docs.md') {
        return {
          finalUrl: url,
          contentType: 'text/markdown',
          body: '---\ntitle: Imported docs\ndescription: Migrated documentation.\n---\n\n# Imported docs\n\nThe imported page body.',
        }
      }
      throw new Error('not found')
    }

    const result = await migrateDocs({
      sourceUrl: 'https://docs.example.com/docs',
      projectDir,
      into: false,
      yes,
      skipValidation,
      fetcher,
    })

    expect(readFileSync(join(projectDir, 'src/content/introduction.mdx'), 'utf8')).toContain('The imported page body.')
    expect(existsSync(join(projectDir, 'src/content/quickstart.mdx'))).toBe(false)
    expect(existsSync(join(projectDir, 'src/content/es/introduction.mdx'))).toBe(false)
    expect(existsSync(join(projectDir, 'openapi.yaml'))).toBe(false)
    expect(JSON.parse(readFileSync(join(projectDir, 'docs.json'), 'utf8')).markdown).toEqual({ enabled: true })
    expect(JSON.parse(readFileSync(join(projectDir, 'docs.json'), 'utf8')).i18n).toEqual({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] })
    if (skipValidation) expect(installDepsMock).not.toHaveBeenCalled()
    else expect(installDepsMock).toHaveBeenCalledWith(projectDir)
    expect(validateMigrationMock).toHaveBeenCalledWith(projectDir, skipValidation, failsInstallation)
    expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).validation.build).toBe(skipValidation ? 'skipped' : failsInstallation ? 'failed' : 'passed')
    if (skipValidation || failsInstallation) {
      expect(success).not.toHaveBeenCalledWith(expect.stringContaining('Content and production build passed'))
    } else {
      expect(success).toHaveBeenCalledWith(expect.stringContaining('Content and production build passed'))
    }
    success.mockRestore()
    expect(initGitMock).toHaveBeenCalledWith(projectDir)
    expect(scaffoldMock).toHaveBeenCalledWith(expect.objectContaining({ repoUrl: '' }))
  })
})

describe('trusted local repository materialization', () => {
  it('imports local Mintlify prose and an interactive API without cloning, running config, or publishing secrets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-local-e2e-'))
    const source = join(root, 'private docs')
    const output = join(root, 'site')
    mkdirSync(source)
    mkdirSync(output)
    writeFileSync(join(output, 'docs.json'), JSON.stringify({ tabs: [] }))
    writeFileSync(join(source, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { tabs: [{ tab: 'Guide', groups: [{ group: 'Basics', pages: ['introduction'] }] }, { tab: 'API', openapi: { source: 'openapi.json', directory: 'api-reference' } }] } }))
    writeFileSync(join(source, 'introduction.mdx'), '---\ntitle: Welcome\nsidebarTitle: Start\nhidden: true\nlayout: vendor-layout\n---\n\n[API](/api-reference/users/list-users)\n[Machine index](/llms.txt)\n\n```ts client.ts lines wrap\nconst value = "safe"\n```\n')
    writeFileSync(join(source, '.env'), 'TOP_SECRET=never-import')
    writeFileSync(join(source, 'docusaurus.config.js'), 'throw new Error("must not execute")')
    writeFileSync(join(source, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Example', version: '1' }, paths: { '/users': { get: { summary: 'List users', tags: ['Users'], responses: { 200: { description: 'OK' } } } } } }))
    const result = await migrateDocs({ sourceUrl: source, sourceDirectory: source, projectDir: output, into: true, yes: true, platform: 'mintlify', skipValidation: true })
    expect(result.pagesWritten).toBe(1)
    const page = readFileSync(join(output, 'src/content/introduction.mdx'), 'utf8')
    expect(page).toContain('hidden: true')
    expect(page).toContain('navTitle: "Start"')
    expect(page).toContain('```ts client.ts lines wrap')
    expect(page).toContain('[API](/api/default/users/get)')
    expect(page).toContain('[Machine index](/llms.txt)')
    expect(page).not.toContain('layout:')
    expect(JSON.parse(readFileSync(join(output, 'docs.json'), 'utf8')).tabs.find((tab: { api?: unknown }) => tab.api)).toBeDefined()
    expect(result.warnings.some((warning) => warning.message.includes('layout'))).toBe(true)
    expect(existsSync(join(output, '.env'))).toBe(false)
    expect(readFileSync(result.reportPath, 'utf8')).not.toContain(source)
  })

  it('preserves an authored file on collision and records an actionable failed validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-local-conflict-'))
    const source = join(root, 'source')
    const output = join(root, 'site')
    mkdirSync(source)
    mkdirSync(join(output, 'src/content'), { recursive: true })
    writeFileSync(join(output, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Authored', pages: ['introduction'] }] }))
    writeFileSync(join(output, 'src/content/introduction.mdx'), '# My own introduction')
    writeFileSync(join(source, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { groups: [{ group: 'Docs', pages: ['introduction'] }] } }))
    writeFileSync(join(source, 'introduction.mdx'), '# Incoming introduction\n\nImported prose.')
    const result = await migrateDocs({ sourceUrl: source, sourceDirectory: source, projectDir: output, into: true, yes: true, skipValidation: true })
    expect(readFileSync(join(output, 'src/content/introduction.mdx'), 'utf8')).toBe('# My own introduction')
    expect(result.validation.content).toBe('failed')
    expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).conflicts).toEqual(['src/content/introduction.mdx'])
    expect(JSON.parse(readFileSync(join(output, 'docs.json'), 'utf8')).tabs[0].tab).toBe('Authored')
  })
})


describe('local source-document link materialization', () => {
  it('imports known MDX links as HTML links and preserves machine Markdown links', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-local-mdx-links-'))
    const source = join(root, 'source')
    const output = join(root, 'site')
    mkdirSync(source)
    mkdirSync(output)
    writeFileSync(join(output, 'docs.json'), '{"tabs":[]}')
    writeFileSync(join(source, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { groups: [{ group: 'Guide', pages: ['introduction', 'quickstart'] }] } }))
    writeFileSync(join(source, 'introduction.mdx'), '# Welcome\n\n[HTML](/quickstart.mdx#run) [Mirror](/quickstart.md) [Unknown](/missing.mdx)')
    writeFileSync(join(source, 'quickstart.mdx'), '# Quickstart\n\nRun the example.')
    const result = await migrateDocs({ sourceUrl: source, sourceDirectory: source, projectDir: output, into: true, yes: true, skipValidation: true })
    const page = readFileSync(join(output, 'src/content/introduction.mdx'), 'utf8')
    expect(page).toContain('[HTML](/quickstart#run)')
    expect(page).toContain('[Mirror](/quickstart.md)')
    const linkWarnings = result.warnings.filter((warning) => warning.message.includes('Internal links have no imported destination'))
    expect(linkWarnings).toEqual([expect.objectContaining({ message: expect.stringContaining('/missing.mdx') })])
    expect(linkWarnings[0].message).not.toContain('/quickstart')
  })
})

describe('rendered URL runner combined with onboarding materialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    validateMigrationMock.mockResolvedValue({ content: 'passed', build: 'passed', messages: [] })
  })

  it('enriches a declared Markdown operation from the complete explicit spec as one HTML-backed page without duplicate endpoint navigation', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-runner-openapi-onboarding-'))
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Existing', pages: ['existing'] }] }))
    const origin = 'https://docs.example.com'
    const path = '/docs/api-reference/users/list-users'
    const specUrl = 'https://specs.example.com/openapi.json'
    const schema = { openapi: '3.0.3', info: { title: 'Example', version: '1' }, paths: { '/users': { get: { summary: 'List users', tags: ['Users'], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ready: { type: 'object', description: 'Complete nested field', properties: { value: { type: 'boolean' } } } } } } } } } } } } }
    const complete = { ...schema, paths: { '/users': { get: { ...schema.paths['/users'].get, parameters: [{ name: 'cursor', in: 'query', description: 'Only present in the complete explicitly selected schema', schema: { type: 'string' } }] } } } }
    const markdown = `# List users\n\n\`\`\`yaml get /users\n${JSON.stringify(schema)}\n\`\`\``
    const html = `<html><head><link rel="alternate" type="text/markdown" href="${path}.md"></head><body><main><article><h1>List users</h1><p>Original endpoint prose stays visible.</p><pre><code>GET /users</code></pre><div id="api-playground-2-operation-page"><div class="method-pill">GET</div><div data-component-part="scroll-area-content">/users</div><section class="api-section"><div class="api-section-heading"><button aria-haspopup="menu">200</button><span>application/json</span></div><div class="object-param-field"><p data-component-part="field-name">ready</p><details class="expandable" data-component-part="expandable"><summary data-component-part="expandable-button" aria-controls="ready-panel" aria-expanded="false"><p>Attributes</p></summary><div id="ready-panel" data-component-part="expandable-content"></div></details></div></section></div></article></main></body></html>`
    const fetcher: MigrationFetcher = vi.fn(async (url) => {
      if (url.href !== specUrl) throw new Error('Unexpected specification fetch')
      return { finalUrl: url, contentType: 'application/json', body: JSON.stringify(complete) }
    })
    const result = await migrateDocs({ sourceUrl: `${origin}${path}`, projectDir, into: true, yes: true, openapiUrl: specUrl, fetcher, urlMigration: {
      scopePath: '/docs', concurrency: 1,
      captureProvider: { capture: async ({ url }) => {
        if (url.pathname === path) return { finalUrl: url, contentType: 'text/html', body: html }
        if (url.pathname === `${path}.md`) return { finalUrl: url, contentType: 'text/markdown', body: markdown }
        throw new Error('No discovery index')
      } },
    } })
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
    expect(report.sourceValidation.status).toBe('passed')
    expect(result.pagesWritten).toBe(1)
    const page = readFileSync(join(projectDir, 'src/content/api-reference/users/list-users.mdx'), 'utf8')
    expect(page).toContain('Original endpoint prose stays visible.')
    expect(page).toContain('GET /users')
    expect(page).toMatch(/openapi: "openapi\/openapi-[a-f0-9]+\.json GET \/users"/)
    expect(existsSync(join(projectDir, 'src/content/api-reference/users/list-users.md.mdx'))).toBe(false)
    const config = JSON.parse(readFileSync(join(projectDir, 'docs.json'), 'utf8'))
    expect(config.tabs.filter((tab: { api?: { navigation?: boolean }; hidden?: boolean }) => tab.api && !tab.hidden && tab.api.navigation !== false)).toEqual([])
    const bindings = config.tabs.filter((tab: { api?: { source: string } }) => tab.api)
    expect(bindings).toHaveLength(1)
    expect(page).toContain(`openapi: "${bindings[0].api.source} GET /users"`)
    expect(JSON.parse(readFileSync(join(projectDir, bindings[0].api.source), 'utf8'))).toEqual(complete)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('retains distinct sidebar aliases, noindex and their redirect alongside an existing owner redirect after config merge', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-runner-alias-onboarding-'))
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Existing', pages: ['existing'] }], redirects: [{ source: '/old-guide', destination: '/existing', permanent: true }] }))
    const origin = 'https://docs.example.com'
    const primary = '/docs/dashboard/domains/tracking'
    const alias = '/docs/knowledge-base/why-open-rates'
    const navigation = [
      { label: 'Dashboard', children: [{ label: 'Tracking', url: `${origin}${primary}` }] },
      { label: 'Knowledge base', children: [{ label: 'Why are my open rates not accurate', url: `${origin}${alias}` }] },
    ]
    const result = await migrateDocs({ sourceUrl: `${origin}${primary}`, projectDir, into: true, yes: true, urlMigration: {
      scopePath: '/docs', concurrency: 1,
      captureProvider: { capture: async ({ url }) => {
        if ([primary, alias].includes(url.pathname)) return { finalUrl: new URL(primary, origin), contentType: 'text/html', body: '<article><h1>Tracking</h1><p>Original article about domain tracking.</p></article>', navigation }
        throw new Error('No discovery index')
      } },
    } })
    expect(result.pagesWritten).toBe(2)
    const aliasPage = readFileSync(join(projectDir, 'src/content/knowledge-base/why-open-rates.mdx'), 'utf8')
    expect(aliasPage).toContain('noindex: true')
    expect(aliasPage).toContain('navTitle: "Why are my open rates not accurate"')
    expect(aliasPage).toContain('Original article about domain tracking.')
    const primaryPage = readFileSync(join(projectDir, 'src/content/dashboard/domains/tracking.mdx'), 'utf8')
    expect(primaryPage).not.toContain('noindex: true')
    const config = JSON.parse(readFileSync(join(projectDir, 'docs.json'), 'utf8'))
    expect(config.redirects).toEqual(expect.arrayContaining([
      { source: '/old-guide', destination: '/existing', permanent: true },
      { source: '/knowledge-base/why-open-rates', destination: '/dashboard/domains/tracking', permanent: true },
    ]))
    expect(JSON.stringify(config.tabs)).toContain('knowledge-base/why-open-rates')
    expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).sourceValidation.status).toBe('passed')
  })
})
