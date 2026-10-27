/** The URLs Mintlify generates for the operations of an OpenAPI spec that a navigation group lists none of. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateRepository } from '../index.js'
import type { MigrationBundle, MigrationFetcher } from '../index.js'
import { hydrateRemoteApiSpecs } from '../remote-api.js'

const SPEC_URL = 'https://specs.example.com/openapi.json'
const response = { responses: { 200: { description: 'OK' } } }

const spec = {
  openapi: '3.0.0',
  info: { title: 'Example', version: '1' },
  paths: {
    '/users': {
      get: { summary: 'List users', tags: ['Users'], ...response },
      // No summary: the title is "Post users".
      post: { tags: ['Users'], ...response },
    },
    // The operation id is never part of the title.
    '/users/{userId}/orders': { get: { operationId: 'listOrders', tags: ['Users'], ...response } },
    // Untagged: no tag folder.
    '/legacy-items/{id}': { delete: { operationId: 'removeLegacy', ...response } },
    '/ping-a': { get: { summary: 'Ping', tags: ['Health'], ...response } },
    '/ping-b': { get: { summary: ' Ping ', tags: ['Health'], ...response } },
    '/ping-c': { get: { summary: 'Ping', tags: ['Health'], ...response } },
    '/plans': { get: { summary: 'Get plan', tags: ['Billing & Plans'], ...response } },
    // Only the first tag counts.
    '/bans': { post: { summary: 'Ban user', tags: ['Users', 'Admin'], ...response } },
  },
}

/** Mintlify's URL of each operation above, and the endpoint page Thally serves it at. */
const operationRedirects = {
  '/api-reference/users/list-users': '/api/default/users/get',
  '/api-reference/users/post-users': '/api/default/users/post',
  '/api-reference/users/get-users-orders': '/api/default/users/userid/orders/get',
  '/api-reference/delete-legacy-items': '/api/default/legacy-items/id/delete',
  '/api-reference/health/ping': '/api/default/ping-a/get',
  '/api-reference/health/ping-1': '/api/default/ping-b/get',
  '/api-reference/health/ping-2': '/api/default/ping-c/get',
  '/api-reference/billing-&-plans/get-plan': '/api/default/plans/get',
  '/api-reference/users/ban-user': '/api/default/bans/post',
}

/** A bare tag URL opens that tag's first operation. */
const tagRedirects = {
  '/api-reference/users': '/api/default/users/get',
  '/api-reference/health': '/api/default/ping-a/get',
  '/api-reference/billing-&-plans': '/api/default/plans/get',
}

function repository(docs: Record<string, unknown>, files: Record<string, string> = {}): MigrationBundle {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-endpoint-urls-'))
  const all = { 'docs.json': JSON.stringify({ $schema: 'https://mintlify.com/docs.json', ...docs }), 'guide.mdx': '---\ntitle: Guide\n---\n\nBody.\n', ...files }
  for (const [name, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
}

const navigation = (reference: unknown) => ({ navigation: { tabs: [{ tab: 'API', groups: [{ group: 'Guides', pages: ['guide'] }, { group: 'Reference', openapi: reference }] }] } })
const fetcher: MigrationFetcher = async (url) => ({ finalUrl: url, body: JSON.stringify(spec), contentType: 'application/json' })
const endpointRedirects = (bundle: MigrationBundle, from = '/api-reference'): Record<string, string> => Object.fromEntries(
  (bundle.docsConfig.redirects ?? []).filter((redirect) => redirect.source.startsWith(from)).map((redirect) => [redirect.source, redirect.destination]).sort(),
)
const sorted = (value: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(value).sort())

describe('Mintlify generated endpoint URLs', () => {
  it('redirects every operation of a remote spec a group lists none of, from the URL Mintlify gave it', async () => {
    const migrated = repository(navigation(SPEC_URL))
    expect(migrated.remoteApiSpecs?.[0].directories).toEqual([{ directory: 'api-reference' }])
    const hydrated = await hydrateRemoteApiSpecs(migrated, fetcher)
    expect(endpointRedirects(hydrated)).toEqual(sorted({ ...operationRedirects, ...tagRedirects }))
  })

  it('does the same for a local spec', () => {
    const migrated = repository(navigation('openapi.json'), { 'openapi.json': JSON.stringify(spec) })
    expect(endpointRedirects(migrated)).toEqual(sorted({ ...operationRedirects, ...tagRedirects }))
  })

  it('follows the same rule under a directory the source names, with no folder for an untagged operation', () => {
    const migrated = repository(navigation({ source: 'openapi.json', directory: 'reference' }), { 'openapi.json': JSON.stringify(spec) })
    const expected = Object.fromEntries(Object.entries({ ...operationRedirects, ...tagRedirects }).map(([source, destination]) => [source.replace('/api-reference', '/reference'), destination]))
    expect(endpointRedirects(migrated, '/reference')).toEqual(sorted(expected))
    expect(endpointRedirects(migrated)).toEqual({})
  })

  it('never redirects an address an authored page serves', () => {
    const migrated = repository(navigation('openapi.json'), {
      'openapi.json': JSON.stringify(spec),
      'api-reference/health/ping.mdx': '---\ntitle: Ping\n---\n\nAuthored.\n',
    })
    const redirects = endpointRedirects(migrated)
    expect(redirects).not.toHaveProperty(['/api-reference/health/ping'])
    expect(redirects['/api-reference/health/ping-1']).toBe('/api/default/ping-b/get')
  })

  it('adds nothing for a spec only the top-level api setting names', () => {
    const migrated = repository(
      { api: { openapi: 'openapi.json' }, navigation: { tabs: [{ tab: 'Guides', pages: ['guide'] }] } },
      { 'openapi.json': JSON.stringify(spec) },
    )
    expect(endpointRedirects(migrated)).toEqual({})
  })

  it('redirects the same endpoint URLs whether or not the top-level api setting names the spec', () => {
    const files = { 'openapi.json': JSON.stringify(spec) }
    const reference = { groups: [{ group: 'Guides', pages: ['guide'] }, { group: 'API', openapi: 'openapi.json' }] }
    const without = endpointRedirects(repository({ navigation: reference }, files))
    expect(without['/api-reference/health/ping']).toBe('/api/default/ping-a/get')
    expect(endpointRedirects(repository({ api: { openapi: 'openapi.json' }, navigation: reference }, files))).toEqual(without)
  })

  it('does not redirect a group that lists its operations: they become pages', async () => {
    const migrated = repository({ navigation: { tabs: [{ tab: 'API', groups: [{ group: 'Reference', openapi: SPEC_URL, pages: ['GET /users', 'POST /users', 'DELETE /legacy-items/{id}'] }] }] } })
    expect(migrated.remoteApiSpecs?.[0].directories ?? []).toEqual([])
    const hydrated = await hydrateRemoteApiSpecs(migrated, fetcher)
    // Only the directory landings (a folder opens its first page) redirect: no operation URL is a redirect source.
    expect(Object.keys(endpointRedirects(hydrated)).filter((source) => source in operationRedirects)).toEqual([])
    expect(hydrated.pages.filter((page) => page.id.startsWith('api-reference/')).map((page) => [page.id, page.title])).toEqual([
      ['api-reference/users/list-users', 'List users'],
      ['api-reference/users/post-users', 'Post users'],
      ['api-reference/delete-legacy-items', 'Delete legacy items'],
    ])
  })

  it('numbers a repeated summary around the URL a literal summary already has', async () => {
    const operations = [['Ping', '/op0'], ['Ping', '/op1'], ['Ping-1', '/op2']] as const
    const repeating = {
      openapi: '3.0.0',
      info: { title: 'Example', version: '1' },
      paths: Object.fromEntries(operations.map(([summary, path]) => [path, { get: { summary, tags: ['Health'], ...response } }])),
    }
    const serve: MigrationFetcher = async (url) => ({ finalUrl: url, body: JSON.stringify(repeating), contentType: 'application/json' })
    // Generated numbers skip a URL a summary spells out, wherever in the order it comes.
    const hydrated = await hydrateRemoteApiSpecs(repository(navigation(SPEC_URL)), serve)
    expect(endpointRedirects(hydrated)).toMatchObject({
      '/api-reference/health/ping': '/api/default/op0/get',
      '/api-reference/health/ping-1': '/api/default/op2/get',
      '/api-reference/health/ping-2': '/api/default/op1/get',
    })
    // Listed operations become pages: each gets one, none is dropped for sharing a URL.
    const listed = repository({ navigation: { tabs: [{ tab: 'API', groups: [{ group: 'Reference', openapi: SPEC_URL, pages: operations.map(([, path]) => `GET ${path}`) }] }] } })
    const withPages = await hydrateRemoteApiSpecs(listed, serve)
    expect(withPages.pages.filter((page) => page.id.startsWith('api-reference/health/')).map((page) => page.id)).toEqual([
      'api-reference/health/ping',
      'api-reference/health/ping-2',
      'api-reference/health/ping-1',
    ])
  })

  it('redirects an authored link to the operation that kept its URL when summaries repeat', async () => {
    const migrated = repository(navigation(SPEC_URL), {
      'guide.mdx': '---\ntitle: Guide\n---\n\n[first](/legacy-api/health/ping) [second](/legacy-api/health/ping-1)\n',
    })
    const hydrated = await hydrateRemoteApiSpecs(migrated, fetcher)
    expect(endpointRedirects(hydrated, '/legacy-api')).toEqual({
      '/legacy-api/health/ping': '/api/default/ping-a/get',
      '/legacy-api/health/ping-1': '/api/default/ping-b/get',
    })
  })
})
