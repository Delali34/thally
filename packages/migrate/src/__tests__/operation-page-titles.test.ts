/** A Mintlify page that names an OpenAPI operation and sets no title is titled by that operation, as Mintlify titles it. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { migrateRepository, type MigrationBundle, type MigrationFetcher } from '../index.js'
import { hydrateRemoteApiSpecs } from '../remote-api.js'

const SPEC_URL = 'https://specs.example.com/openapi.json'

const response = { responses: { 200: { description: 'OK' } } }
const spec = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Links', version: '1' },
  paths: {
    '/links': {
      post: { operationId: 'createLink', summary: 'Create a link', tags: ['Links'], ...response },
      get: { operationId: 'listLinks', tags: ['Links'], ...response },
    },
    '/links/{linkId}': {
      delete: { tags: ['Links'], ...response },
      get: { summary: '  Retrieve a link  ', operationId: 'getLink', tags: ['Links'], ...response },
    },
  },
  webhooks: {
    'link.created': { post: { summary: 'Link created event', tags: ['Links'], ...response } },
    'link.updated': { post: { operationId: 'linkUpdated', ...response } },
    'link.deleted': { post: response },
    'link.moved': { $ref: '#/x-items/moved' },
    'link.both': { post: { summary: 'Zeta event', ...response }, put: { summary: 'Alpha event', ...response } },
    'link.hidden': { post: { 'x-hidden': true, summary: 'Hidden event', ...response } },
  },
  'x-webhooks': { 'link.extension': { post: { summary: 'Extension event', ...response } } },
  'x-items': { moved: { post: { summary: 'Link moved event', ...response } } },
})

const operationPage = (frontmatter: string[], body = ''): string => `---\n${frontmatter.join('\n')}\n---\n\n${body}`

const pages: Record<string, string> = {
  'api-reference/links/create': operationPage(['openapi: post /links', 'sidebarTitle: Create link']),
  'api-reference/links/list': operationPage(['openapi: get /links']),
  'api-reference/links/delete': operationPage(['openapi: delete /links/{linkId}']),
  'api-reference/links/retrieve': operationPage([`openapi: "${SPEC_URL} get /links/{linkId}"`]),
  'api-reference/links/authored': operationPage(['title: Make one', 'openapi: post /links']),
  'api-reference/links/headed': operationPage(['openapi: post /links'], '# Our own heading\n\nBody.'),
  'api-reference/links/missing': operationPage(['openapi: patch /nowhere']),
  'api-reference/webhooks/created': operationPage(['openapi: webhook link.created']),
  'api-reference/webhooks/updated': operationPage(['openapi: "WEBHOOK   link.updated"']),
  'api-reference/webhooks/deleted': operationPage(['openapi: webhook link.deleted']),
  'api-reference/webhooks/moved': operationPage(['openapi: webhook link.moved']),
  'api-reference/webhooks/both': operationPage(['openapi: webhook link.both']),
  'api-reference/webhooks/named': operationPage(['openapi: "openapi.json webhook link.created"']),
  'api-reference/webhooks/remote': operationPage([`openapi: "${SPEC_URL} webhook link.updated"`]),
  'api-reference/webhooks/hidden': operationPage(['openapi: webhook link.hidden']),
  'api-reference/webhooks/extension': operationPage(['openapi: webhook link.extension']),
  'api-reference/webhooks/other-case': operationPage(['openapi: webhook Link.Created']),
  'api-reference/webhooks/missing': operationPage(['openapi: webhook link.nowhere']),
  guide: operationPage(['description: A guide.'], 'Hello.'),
}

function repository(api: string): string {
  const root = mkdtempSync(join(tmpdir(), 'thally-operation-titles-'))
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  write('docs.json', JSON.stringify({
    $schema: 'https://mintlify.com/docs.json',
    name: 'Links',
    api: { openapi: api },
    navigation: { groups: [{ group: 'Start', pages: ['guide'] }, { group: 'Links', pages: Object.keys(pages).filter((id) => id.startsWith('api-reference/')) }] },
  }))
  if (api === 'openapi.json') write('openapi.json', spec)
  for (const [id, content] of Object.entries(pages)) write(`${id}.mdx`, content)
  return root
}

const migrate = (api: string): MigrationBundle => migrateRepository({ repositoryDir: repository(api), sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
const titles = (bundle: MigrationBundle): Record<string, string> => Object.fromEntries(bundle.pages.map((page) => [page.id, page.title]))

describe('titles of Mintlify operation pages', () => {
  it('uses the summary of the operation a local spec binds, else its operation id, else METHOD /path', () => {
    const bundle = migrate('openapi.json')
    expect(titles(bundle)).toMatchObject({
      'api-reference/links/create': 'Create a link',
      'api-reference/links/list': 'listLinks',
      'api-reference/links/delete': 'DELETE /links/{linkId}',
    })
    expect(bundle.pages.find((page) => page.id === 'api-reference/links/create')?.navTitle).toBe('Create link')
  })

  it('titles a webhook page by the operation of the webhook a local spec binds, whichever way the page writes the reference', () => {
    expect(titles(migrate('openapi.json'))).toMatchObject({
      'api-reference/webhooks/created': 'Link created event',
      'api-reference/webhooks/updated': 'linkUpdated',
      'api-reference/webhooks/deleted': 'POST link.deleted',
      'api-reference/webhooks/moved': 'Link moved event',
      'api-reference/webhooks/both': 'Alpha event',
      'api-reference/webhooks/named': 'Link created event',
    })
  })

  it('keeps the file name title of a webhook page whose webhook the renderer does not serve', () => {
    expect(titles(migrate('openapi.json'))).toMatchObject({
      'api-reference/webhooks/hidden': 'Hidden',
      'api-reference/webhooks/extension': 'Extension',
      'api-reference/webhooks/other-case': 'Other Case',
      'api-reference/webhooks/missing': 'Missing',
    })
  })

  it('keeps an authored title, a heading of the page, a page that names no operation, and a page whose operation is missing', () => {
    expect(titles(migrate('openapi.json'))).toMatchObject({
      'api-reference/links/authored': 'Make one',
      'api-reference/links/headed': 'Our own heading',
      'api-reference/links/missing': 'Missing',
      guide: 'Guide',
    })
  })

  it('uses the summary of the operation a remote spec binds once it is downloaded', async () => {
    const bundle = migrate(SPEC_URL)
    expect(bundle.remoteApiSpecs).toHaveLength(1)
    expect(titles(bundle)['api-reference/links/create']).toBe('Create')
    const fetcher: MigrationFetcher = vi.fn(async (url) => ({ finalUrl: url, body: spec, contentType: 'application/json' }))
    const hydrated = await hydrateRemoteApiSpecs(bundle, fetcher)
    expect(titles(hydrated)).toMatchObject({
      'api-reference/links/create': 'Create a link',
      'api-reference/links/list': 'listLinks',
      'api-reference/links/delete': 'DELETE /links/{linkId}',
      'api-reference/links/retrieve': 'Retrieve a link',
      'api-reference/webhooks/created': 'Link created event',
      'api-reference/webhooks/updated': 'linkUpdated',
      'api-reference/webhooks/remote': 'linkUpdated',
      'api-reference/webhooks/hidden': 'Hidden',
      'api-reference/links/authored': 'Make one',
      'api-reference/links/headed': 'Our own heading',
      'api-reference/links/missing': 'Missing',
      guide: 'Guide',
    })
    expect(hydrated.pages.find((page) => page.id === 'api-reference/links/create')?.navTitle).toBe('Create link')
    expect(titles(bundle)['api-reference/links/create']).toBe('Create')
  })

  it('keeps the file name title when the remote spec cannot be downloaded', async () => {
    const hydrated = await hydrateRemoteApiSpecs(migrate(SPEC_URL), async () => { throw new Error('offline') })
    expect(titles(hydrated)['api-reference/links/create']).toBe('Create')
  })
})
