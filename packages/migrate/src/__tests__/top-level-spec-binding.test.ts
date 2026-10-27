/** A spec only page frontmatter names is rendered where those pages put it, not listed as a tab of its own. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateRepository } from '../index.js'
import { hydrateRemoteApiSpecs } from '../remote-api.js'
import { renderMigrationFiles } from '../render.js'
import type { MigrationFetcher } from '../types.js'

const REMOTE = 'https://specs.example.com/openapi.json'
const spec = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Example', version: '1' },
  paths: {
    '/v1/users': { get: { summary: 'List users', tags: ['Users'], responses: { 200: { description: 'OK' } } } },
    '/v1/teams': { get: { summary: 'List teams', tags: ['Teams'], responses: { 200: { description: 'OK' } } } },
  },
})
const fetcher: MigrationFetcher = async (url) => ({ finalUrl: url, body: spec, contentType: 'application/json' })

function site(files: Record<string, string>, api: unknown, navigation: unknown = { pages: ['home'] }) {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-spec-binding-'))
  const all = { 'docs.json': JSON.stringify({ $schema: 'https://mintlify.com/docs.json', name: 'Acme', api, navigation }), ...files }
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
}

const page = (openapi?: string) => `---\ntitle: Home\n${openapi ? `openapi: ${JSON.stringify(openapi)}\n` : ''}---\n\nBody.\n`
const apiTabs = (bundle: { docsConfig: { tabs: Array<{ tab: string; hidden?: boolean; api?: unknown }> } }) => bundle.docsConfig.tabs.filter((tab) => tab.api)

describe('a docs.json spec that only pages name', () => {
  it('binds a remote spec to a hidden tab and lists none of its operations', async () => {
    const bundle = await hydrateRemoteApiSpecs(site({ 'home.mdx': page('GET /v1/users') }, { openapi: REMOTE }), fetcher)
    expect(apiTabs(bundle)).toHaveLength(1)
    expect(apiTabs(bundle)[0]).toMatchObject({ hidden: true })
    expect(bundle.docsConfig.tabs.filter((tab) => !tab.hidden).map((tab) => tab.tab)).toEqual(['Documentation'])
  })

  it('binds a local spec to a hidden tab when the pages name it by its path', () => {
    const bundle = site({ 'home.mdx': page('openapi.json GET /v1/users'), 'openapi.json': spec }, { openapi: 'openapi.json' })
    expect(apiTabs(bundle)).toHaveLength(1)
    expect(apiTabs(bundle)[0]).toMatchObject({ hidden: true })
  })

  it('binds a local spec to a hidden tab when the site has no other spec and a page names an operation bare', () => {
    const bundle = site({ 'home.mdx': page('GET /v1/users'), 'openapi.json': spec }, { openapi: 'openapi.json' })
    expect(apiTabs(bundle)).toHaveLength(1)
    expect(apiTabs(bundle)[0]).toMatchObject({ hidden: true })
  })

  it('keeps the API tab when no page names an operation', async () => {
    const bundle = await hydrateRemoteApiSpecs(site({ 'home.mdx': page() }, { openapi: REMOTE }), fetcher)
    expect(apiTabs(bundle)).toHaveLength(1)
    expect(apiTabs(bundle)[0]).toMatchObject({ tab: 'API Reference' })
    expect(apiTabs(bundle)[0]).not.toHaveProperty('hidden')
  })

  it('keeps the API tab when docs.json navigation lists the spec itself', () => {
    const bundle = site(
      { 'home.mdx': page('GET /v1/users'), 'openapi.json': spec },
      { openapi: 'openapi.json' },
      { tabs: [{ tab: 'Guides', pages: ['home'] }, { tab: 'Reference', openapi: 'openapi.json' }] },
    )
    expect(apiTabs(bundle).some((tab) => !tab.hidden)).toBe(true)
  })
})

describe('two remote specs in one docs.json, only one of them named by a page', () => {
  const A = 'https://example.com/a.json'
  const B = 'https://example.com/b.json'
  const specWith = (path: string, tag: string) => JSON.stringify({
    openapi: '3.0.0',
    info: { title: tag, version: '1' },
    paths: { [path]: { get: { summary: `Get ${tag}`, tags: [tag], responses: { 200: { description: 'OK' } } } } },
  })
  const bodies: Record<string, string> = { [A]: specWith('/x', 'Alpha'), [B]: specWith('/users', 'Beta') }
  const twoSpecs: MigrationFetcher = async (url) => ({ finalUrl: url, body: bodies[url.toString()], contentType: 'application/json' })
  const bind = (order: Array<string>) => hydrateRemoteApiSpecs(site({ 'home.mdx': page(`${A} GET /x`) }, { openapi: order }), twoSpecs)

  for (const order of [[A, B], [B, A]]) {
    it(`keeps each spec in its own tab (${order.map((url) => url.slice(-6)).join(', ')})`, async () => {
      const bundle = await bind(order)
      const assetFor = (url: string) => bundle.assets.find((asset) => Buffer.from(asset.content).toString() === bodies[url])?.path
      const hidden = apiTabs(bundle).filter((tab) => tab.hidden)
      const listed = apiTabs(bundle).filter((tab) => !tab.hidden)
      expect(hidden.map((tab) => tab.tab)).toEqual([`OpenAPI: ${A}`])
      expect(hidden[0].api).toMatchObject({ source: assetFor(A) })
      expect(listed).toHaveLength(1)
      expect(listed[0].api).toMatchObject({ source: assetFor(B) })
      expect(listed[0].api).not.toHaveProperty('navigation')
      // A has a tab of its own whichever binds first, so nothing is dropped, replaced or reported.
      expect(bundle.warnings.filter((warning) => warning.code === 'unsupported-config')).toEqual([])
    })
  }

  it('keeps the first of two specs no page names and warns, rather than replacing its binding with the second', async () => {
    const bundle = await hydrateRemoteApiSpecs(site({ 'home.mdx': page() }, { openapi: [A, B] }), twoSpecs)
    const assetFor = (url: string) => bundle.assets.find((asset) => Buffer.from(asset.content).toString() === bodies[url])?.path
    expect(apiTabs(bundle)).toHaveLength(1)
    expect(apiTabs(bundle)[0].api).toMatchObject({ source: assetFor(A) })
    expect(bundle.warnings.some((warning) => warning.code === 'unsupported-config' && warning.source === B && warning.message.includes(`${B} was not added`))).toBe(true)
  })
})

describe('a spec the tab rejects never takes over a bare operation reference', () => {
  const A = 'https://example.com/a.json'
  const B = 'https://example.com/b.json'
  const specWith = (tag: string) => JSON.stringify({
    openapi: '3.0.0',
    info: { title: tag, version: '1' },
    paths: { '/x': { get: { summary: `Get ${tag}`, tags: [tag], responses: { 200: { description: 'OK' } } } } },
  })
  const bodies: Record<string, string> = { [A]: specWith('Alpha'), [B]: specWith('Beta') }
  const both: MigrationFetcher = async (url) => ({ finalUrl: url, body: bodies[url.toString()], contentType: 'application/json' })

  it('leaves the page on the spec that was kept, never the one that was rejected', async () => {
    const bundle = await hydrateRemoteApiSpecs(site({ 'home.mdx': page('GET /x') }, { openapi: [A, B] }), both)
    const assetFor = (url: string) => bundle.assets.find((asset) => Buffer.from(asset.content).toString() === bodies[url])?.path
    expect(apiTabs(bundle)).toHaveLength(1)
    expect((apiTabs(bundle)[0].api as { source: string }).source).toBe(assetFor(A))
    expect(bundle.warnings.some((warning) => warning.code === 'unsupported-config' && warning.source === B)).toBe(true)
    // `GET /x` reached A before and still does: it names no spec that has no binding.
    expect(bundle.pages.find((entry) => entry.id === 'home')!.openapi).not.toContain(assetFor(B)!)
  })
})

describe('two local specs in one docs.json, only one of them named by a page', () => {
  const specWith = (path: string, tag: string) => JSON.stringify({
    openapi: '3.0.0',
    info: { title: tag, version: '1' },
    paths: { [path]: { get: { summary: `Get ${tag}`, tags: [tag], responses: { 200: { description: 'OK' } } } } },
  })
  for (const order of [['a.json', 'b.json'], ['b.json', 'a.json']]) {
    it(`keeps each spec in its own tab (${order.join(', ')})`, () => {
      const bundle = site(
        { 'home.mdx': page('a.json GET /x'), 'a.json': specWith('/x', 'Alpha'), 'b.json': specWith('/users', 'Beta') },
        { openapi: order },
      )
      expect(apiTabs(bundle).map((tab) => [tab.tab, tab.hidden === true, (tab.api as { source: string }).source])).toEqual(expect.arrayContaining([
        ['OpenAPI: a.json', true, 'openapi/a.json'],
        ['API Reference', false, 'openapi/b.json'],
      ]))
      expect(apiTabs(bundle)).toHaveLength(2)
      expect(bundle.warnings.some((warning) => warning.message.includes('was not added'))).toBe(false)
    })
  }
})

describe('a spec only pages name never binds to an existing tab because its label contains "API"', () => {
  const specWith = (path: string, tag: string) => JSON.stringify({
    openapi: '3.0.0',
    info: { title: tag, version: '1' },
    paths: { [path]: { get: { summary: `Get ${tag}`, tags: [tag], responses: { 200: { description: 'OK' } } } } },
  })
  const guides = { tabs: [{ tab: 'API Guides', pages: ['home'] }] }
  const expectOwnTab = (bundle: Awaited<ReturnType<typeof hydrateRemoteApiSpecs>>, specA: string, specB: string, nameA: string) => {
    const tabs = apiTabs(bundle) as Array<{ tab: string; hidden?: boolean; api: { source: string } }>
    const sourceOf = (tab: string) => tabs.find((candidate) => candidate.tab === tab)?.api.source
    // A is in a hidden tab of its own, the visible "API Guides" tab holds B, and nothing is dropped or reported as conflicting.
    expect(tabs.filter((tab) => tab.hidden).map((tab) => [tab.tab, tab.api.source])).toEqual([[`OpenAPI: ${nameA}`, specA]])
    expect(sourceOf('API Guides')).toBe(specB)
    expect(bundle.warnings.some((warning) => warning.message.includes('was not added') || warning.message.includes('already uses another OpenAPI spec'))).toBe(false)
  }

  it('gives a local spec a hidden tab of its own and binds the other spec to the visible tab', () => {
    const bundle = site(
      { 'home.mdx': page('a.json GET /x'), 'a.json': specWith('/x', 'Alpha'), 'b.json': specWith('/users', 'Beta') },
      { openapi: ['a.json', 'b.json'] },
      guides,
    )
    expectOwnTab(bundle as never, 'openapi/a.json', 'openapi/b.json', 'a.json')
  })

  it('gives a remote spec a hidden tab of its own and lists none of its endpoints in the visible tab', async () => {
    const A = 'https://example.com/a.json'
    const B = 'https://example.com/b.json'
    const bodies: Record<string, string> = { [A]: specWith('/x', 'Alpha'), [B]: specWith('/users', 'Beta') }
    const fetchBoth: MigrationFetcher = async (url) => ({ finalUrl: url, body: bodies[url.toString()], contentType: 'application/json' })
    const bundle = await hydrateRemoteApiSpecs(site({ 'home.mdx': page(`${A} GET /x`) }, { openapi: [A, B] }, guides), fetchBoth)
    const assetFor = (url: string) => bundle.assets.find((asset) => Buffer.from(asset.content).toString() === bodies[url])?.path
    expectOwnTab(bundle, assetFor(A)!, assetFor(B)!, A)
  })
})

describe('a spec only pages name never binds to a tab an author gave the same label as its own', () => {
  const specWith = (path: string, tag: string) => JSON.stringify({
    openapi: '3.0.0',
    info: { title: tag, version: '1' },
    paths: { [path]: { get: { summary: `Get ${tag}`, tags: [tag], responses: { 200: { description: 'OK' } } } } },
  })
  type Tab = { tab: string; hidden?: boolean; api: { source: string } }
  const expectOwnTab = (bundle: Awaited<ReturnType<typeof hydrateRemoteApiSpecs>>, label: string, specA: string, specB: string) => {
    const tabs = apiTabs(bundle) as Array<Tab>
    // The authored tab is visible and holds B; A is in a hidden tab of its own, and nothing is dropped.
    expect(tabs.filter((tab) => !tab.hidden).map((tab) => [tab.tab, tab.api.source])).toEqual([[label, specB]])
    expect(tabs.filter((tab) => tab.hidden).map((tab) => [tab.tab, tab.api.source])).toEqual([[label, specA]])
    expect(bundle.warnings.some((warning) => warning.message.includes('was not added') || warning.message.includes('already uses another OpenAPI spec'))).toBe(false)
  }

  it('gives a local spec a hidden tab of its own beside the authored visible tab', () => {
    const bundle = site(
      { 'home.mdx': page('a.json GET /x'), 'a.json': specWith('/x', 'Alpha'), 'b.json': specWith('/users', 'Beta') },
      { openapi: ['a.json', 'b.json'] },
      { tabs: [{ tab: 'OpenAPI: a.json', pages: ['home'] }] },
    )
    expectOwnTab(bundle as never, 'OpenAPI: a.json', 'openapi/a.json', 'openapi/b.json')
  })

  it('gives a remote spec a hidden tab of its own beside the authored visible tab', async () => {
    const A = 'https://example.com/a.json'
    const B = 'https://example.com/b.json'
    const bodies: Record<string, string> = { [A]: specWith('/x', 'Alpha'), [B]: specWith('/users', 'Beta') }
    const fetchBoth: MigrationFetcher = async (url) => ({ finalUrl: url, body: bodies[url.toString()], contentType: 'application/json' })
    const bundle = await hydrateRemoteApiSpecs(
      site({ 'home.mdx': page(`${A} GET /x`) }, { openapi: [A, B] }, { tabs: [{ tab: `OpenAPI: ${A}`, pages: ['home'] }] }),
      fetchBoth,
    )
    const assetFor = (url: string) => bundle.assets.find((asset) => Buffer.from(asset.content).toString() === bodies[url])?.path
    expectOwnTab(bundle, `OpenAPI: ${A}`, assetFor(A)!, assetFor(B)!)
  })
})

describe('a spec only pages name, once the bundle has crossed the CLI worker boundary', () => {
  const B = 'https://example.com/b.json'
  const specWith = (path: string, tag: string) => JSON.stringify({
    openapi: '3.0.0',
    info: { title: tag, version: '1' },
    paths: { [path]: { get: { summary: `Get ${tag}`, tags: [tag], responses: { 200: { description: 'OK' } } } } },
  })
  const bodyB = specWith('/users', 'Beta')
  const fetchB: MigrationFetcher = async (url) => ({ finalUrl: url, body: bodyB, contentType: 'application/json' })
  const convert = () => site(
    { 'home.mdx': page('a.json GET /x'), 'a.json': specWith('/x', 'Alpha') },
    { openapi: ['a.json', B] },
  )

  it('keeps its hidden tab to itself, and binds the remote spec to a tab of its own', async () => {
    // The worker posts the conversion result with structuredClone, which keeps data and nothing else.
    const hydrated = await hydrateRemoteApiSpecs(structuredClone(convert()), fetchB)
    const tabs = apiTabs(hydrated) as Array<{ tab: string; hidden?: boolean; api: { source: string } }>
    const assetB = hydrated.assets.find((asset) => Buffer.from(asset.content).toString() === bodyB)?.path
    expect(tabs.filter((tab) => tab.hidden).map((tab) => [tab.tab, tab.api.source])).toEqual([['OpenAPI: a.json', 'openapi/a.json']])
    expect(tabs.filter((tab) => !tab.hidden).map((tab) => [tab.tab, tab.api.source])).toEqual([['API Reference', assetB]])
    expect(hydrated.warnings.filter((warning) => warning.code === 'unsupported-config')).toEqual([])
  })

  it('gives the same result as hydrating without the clone, and writes nothing of the mark to docs.json', async () => {
    const direct = await hydrateRemoteApiSpecs(convert(), fetchB)
    const cloned = await hydrateRemoteApiSpecs(structuredClone(convert()), fetchB)
    expect(cloned.docsConfig).toEqual(direct.docsConfig)
    const docsJson = String(renderMigrationFiles(cloned).find((file) => file.path === 'docs.json')!.content)
    expect(docsJson).not.toMatch(/page-?only/i)
  })
})
