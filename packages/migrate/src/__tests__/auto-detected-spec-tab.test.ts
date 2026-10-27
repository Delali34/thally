/**
 * Mintlify finds an OpenAPI file by itself and renders it only where a page's `openapi:` frontmatter names an
 * operation, so it adds no tab. The migrated site binds that spec to a hidden tab and shows no API tab either.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateRepository, type MigrationBundle } from '../index.js'
import { specLookupOrder } from '../repository.js'

const spec = JSON.stringify({
  openapi: '3.0.1',
  info: { title: 'Cloud API', version: '1' },
  paths: {
    '/v1/organizations': { get: { summary: 'List organizations', tags: ['Organizations'], responses: { '200': { description: 'ok' } } } },
    '/v1/groups': { post: { summary: 'Create group', tags: ['Groups'], responses: { '200': { description: 'ok' } } } },
  },
})

const page = (title: string, extra = ''): string => `---\ntitle: ${title}\n${extra}---\n\nBody of ${title}.\n`

function site(files: Record<string, string>, navigation: Record<string, unknown>, withScannedSpec = true, config: Record<string, unknown> = {}): MigrationBundle {
  const root = mkdtempSync(join(tmpdir(), 'thally-auto-spec-'))
  const all = { 'docs.json': JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation, ...config }), ...(withScannedSpec ? { 'api-reference/openapi.json': spec } : {}), ...files }
  for (const [name, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
}

const tabs = { tabs: [
  { tab: 'Database', groups: [{ group: 'Start', pages: ['intro'] }] },
  { tab: 'Cloud', groups: [{ group: 'Reference', pages: ['api/organizations', 'api/groups'] }] },
] }
const hiddenBinding = { tab: 'OpenAPI: api-reference/openapi.json', hidden: true, api: { source: 'openapi/openapi.json' } }
const visibleTabs = (bundle: MigrationBundle): Array<string> => bundle.docsConfig.tabs.filter((tab) => !tab.hidden).map((tab) => tab.tab)
const specAssets = (bundle: MigrationBundle): Array<string> => bundle.assets.map((asset) => asset.path).filter((path) => path.startsWith('openapi/'))
const noSpecConflict = (bundle: MigrationBundle): boolean => !bundle.warnings.some((warning) => /already uses another OpenAPI spec/.test(warning.message))

describe('a spec that only the repository scan finds', () => {
  it('binds it to a hidden tab, without an API tab, when pages name its operations', () => {
    const bundle = site({
      'intro.mdx': page('Intro'),
      'api/organizations.mdx': page('List organizations', 'openapi: "GET /v1/organizations"\n'),
      'api/groups.mdx': page('Create group', 'openapi: "POST /v1/groups"\n'),
    }, tabs)
    expect(visibleTabs(bundle)).toEqual(['Database', 'Cloud'])
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api)).toEqual([hiddenBinding])
    expect(specAssets(bundle)).toEqual(['openapi/openapi.json'])
    expect(specLookupOrder(bundle.docsConfig.tabs)).toEqual(['openapi/openapi.json'])
    expect(bundle.pages.find((entry) => entry.id === 'api/organizations')?.openapi).toBe('GET /v1/organizations')
    expect(bundle.pages.find((entry) => entry.id === 'api/groups')?.openapi).toBe('POST /v1/groups')
    expect(noSpecConflict(bundle)).toBe(true)
  })

  it('binds it once when a page also writes the spec path', () => {
    const bundle = site({
      'intro.mdx': page('Intro'),
      'api/organizations.mdx': page('List organizations', 'openapi: "api-reference/openapi.json GET /v1/organizations"\n'),
      'api/groups.mdx': page('Create group', 'openapi: "POST /v1/groups"\n'),
    }, tabs)
    expect(visibleTabs(bundle)).toEqual(['Database', 'Cloud'])
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api)).toEqual([hiddenBinding])
    expect(bundle.pages.find((entry) => entry.id === 'api/organizations')?.openapi).toBe('openapi/openapi.json GET /v1/organizations')
    expect(noSpecConflict(bundle)).toBe(true)
  })

  it('binds it to a hidden tab even when a tab already has "api" in its name', () => {
    const bundle = site({
      'intro.mdx': page('Intro'),
      'api/organizations.mdx': page('List organizations', 'openapi: "GET /v1/organizations"\n'),
    }, { tabs: [{ tab: 'Docs', groups: [{ group: 'Start', pages: ['intro'] }] }, { tab: 'API Reference', groups: [{ group: 'Reference', pages: ['api/organizations'] }] }] })
    expect(visibleTabs(bundle)).toEqual(['Docs', 'API Reference'])
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api)).toEqual([hiddenBinding])
  })

  it('keeps an API tab for it when no page names an operation', () => {
    const bundle = site({ 'intro.mdx': page('Intro') }, { tabs: [{ tab: 'Docs', groups: [{ group: 'Start', pages: ['intro'] }] }] })
    expect(visibleTabs(bundle)).toEqual(['Docs', 'API Reference'])
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api)).toEqual([{ tab: 'API Reference', api: { source: 'openapi/openapi.json' } }])
  })

  it('keeps an API tab for it when the only page naming a spec names another file', () => {
    const bundle = site({
      'intro.mdx': page('Intro'),
      'api/organizations.mdx': page('List organizations', 'openapi: "other/spec.json GET /v1/organizations"\n'),
      'other/spec.json': spec,
    }, { tabs: [{ tab: 'Docs', groups: [{ group: 'Start', pages: ['intro', 'api/organizations'] }] }] })
    expect(visibleTabs(bundle)).toEqual(['Docs', 'API Reference'])
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api && !tab.hidden)).toEqual([{ tab: 'API Reference', api: { source: 'openapi/openapi.json' } }])
  })
})

describe('the spec a bare openapi reference reaches', () => {
  const sharing = (title: string): string => JSON.stringify({ openapi: '3.0.1', info: { title, version: '1' }, paths: { '/x': { get: { summary: title, responses: { '200': { description: 'ok' } } } } } })
  const docs = { tabs: [{ tab: 'Docs', groups: [{ group: 'Start', pages: ['intro', 'a-other', 'endpoint', 'z-default'] }] }] }

  it('stays the auto-detected spec when pages that name other specs come before and after it', () => {
    const bundle = site({
      'api-reference/openapi.json': sharing('Default'),
      'api-reference/other.json': sharing('Other'),
      'intro.mdx': page('Intro'),
      'a-other.mdx': page('A', 'openapi: "api-reference/other.json GET /x"\n'),
      'endpoint.mdx': page('Endpoint', 'openapi: "GET /x"\n'),
      'z-default.mdx': page('Z', 'openapi: "api-reference/openapi.json GET /x"\n'),
    }, docs)
    // The renderer takes the first spec in this order that publishes the operation, as it did when the scanned spec had a visible tab.
    expect(specLookupOrder(bundle.docsConfig.tabs)).toEqual(['openapi/openapi.json', 'openapi/other.json'])
    expect(bundle.pages.find((entry) => entry.id === 'endpoint')?.openapi).toBe('GET /x')
    expect(visibleTabs(bundle)).toEqual(['Docs'])
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api).map((tab) => tab.hidden)).toEqual([true, true])
    expect(noSpecConflict(bundle)).toBe(true)
  })

  it('stays the auto-detected spec when only a page that names another spec comes first', () => {
    const bundle = site({
      'api-reference/openapi.json': sharing('Default'),
      'api-reference/other.json': sharing('Other'),
      'intro.mdx': page('Intro'),
      'a-other.mdx': page('A', 'openapi: "api-reference/other.json GET /x"\n'),
      'endpoint.mdx': page('Endpoint', 'openapi: "GET /x"\n'),
    }, docs)
    expect(specLookupOrder(bundle.docsConfig.tabs)).toEqual(['openapi/openapi.json', 'openapi/other.json'])
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api).map((tab) => tab.hidden)).toEqual([true, true])
  })

  it('keeps its API tab when a remote spec is still to be bound, so the order the remote tab joins is unchanged', () => {
    const bundle = site({
      'intro.mdx': page('Intro'),
      'endpoint.mdx': page('Endpoint', 'openapi: "GET /v1/organizations"\n'),
    }, { tabs: [{ tab: 'Docs', groups: [{ group: 'Start', pages: ['intro', 'endpoint'] }] }] }, true, { api: { openapi: 'https://specs.example.com/openapi.json' } })
    expect(visibleTabs(bundle)).toEqual(['Docs', 'API Reference'])
  })

  it('is bound in the tab shape a spec only pages name gets', () => {
    const scanned = site({ 'intro.mdx': page('Intro'), 'api/organizations.mdx': page('List', 'openapi: "GET /v1/organizations"\n') }, tabs).docsConfig.tabs.filter((tab) => tab.api)
    const named = site({
      'api-reference/spec.json': spec,
      'intro.mdx': page('Intro'),
      'api/organizations.mdx': page('List', 'openapi: "api-reference/spec.json GET /v1/organizations"\n'),
    }, tabs, false).docsConfig.tabs.filter((tab) => tab.api)
    expect(named).toEqual([{ tab: 'OpenAPI: api-reference/spec.json', hidden: true, api: { source: 'openapi/spec.json' } }])
    expect(JSON.stringify(scanned).replaceAll('openapi.json', 'spec.json')).toBe(JSON.stringify(named))
  })
})
