/** A small spec and navigation shaped like Unkey's docs: one spec, three products, each with an API reference tab that lists its operations. */

const response = { responses: { 200: { description: 'OK' } } }

export const endpointSpec = {
  openapi: '3.0.0',
  info: { title: 'Unkey', version: '2' },
  paths: {
    '/v2/keys.createKey': { post: { operationId: 'createKey', summary: 'Create API key', tags: ['Keys', 'Other'], description: 'Creates a key for a user. Keys are shown once.\n\nSee the guide for more.', ...response } },
    '/v2/keys.getKey': { post: { operationId: 'getKey', summary: 'Get API key', tags: ['Keys'], ...response } },
    '/v2/keys.deleteKey': { post: { summary: 'Delete API key', tags: ['Keys'], ...response } },
    '/v2/keys.hiddenKey': { post: { summary: 'Hidden key', tags: ['Keys'], 'x-hidden': true, ...response } },
    '/v2/keys.excludedKey': { post: { summary: 'Excluded key', tags: ['Keys'], 'x-excluded': true, ...response } },
    '/v2/ratelimit.limit': { post: { summary: 'Apply rate limiting', tags: ['Ratelimit'], description: '**Check** a [limit](https://example.com/limits). More follows.', ...response } },
    '/v2/apis.createApi': { post: { summary: 'Create API namespace', tags: ['APIs'], ...response } },
    '/v2/domains.createDomain': { post: { summary: 'Create domain', tags: ['Domains'], ...response } },
    '/v2/domains.listDomains': { post: { summary: 'List domains', tags: ['Domains'], ...response } },
  },
}

/**
 * The tabs a navigation validator reports as empty ("has no groups and no href") when it has no exemption for hidden tabs, as an older Cloud's
 * does: no pages, no groups, no href, and not an API tab that lists navigation (`api.navigation !== false`).
 */
export function emptyTabsWithoutHiddenExemption(tabs: ReadonlyArray<{ tab: string; href?: string; pages?: ReadonlyArray<unknown>; groups?: ReadonlyArray<unknown>; api?: { navigation?: boolean } }>): Array<string> {
  return tabs
    .filter((tab) => !(tab.pages?.length || tab.groups?.length) && !tab.href && !(tab.api && tab.api.navigation !== false))
    .map((tab) => tab.tab)
}

/** Page ids the operations above get under a directory: `<directory>/<first tag>/<summary>`, slugged as Mintlify slugs them. */
export const endpointPageId = (directory: string, operation: 'createKey' | 'getKey' | 'deleteKey' | 'limit' | 'createApi' | 'createDomain' | 'listDomains'): string => {
  const names = {
    createKey: 'keys/create-api-key',
    getKey: 'keys/get-api-key',
    deleteKey: 'keys/delete-api-key',
    limit: 'ratelimit/apply-rate-limiting',
    createApi: 'apis/create-api-namespace',
    createDomain: 'domains/create-domain',
    listDomains: 'domains/list-domains',
  }
  return `${directory}/${names[operation]}`
}

/** Three products over one spec, as Unkey's docs.json lays them out: each has Guides and an API reference tab that lists operations. */
export function productsNavigation(source: string): Record<string, unknown> {
  const guides = { tab: 'Guides', groups: [{ group: 'Start', pages: ['guide'] }] }
  const api = (directory: string, groups: Array<unknown>) => ({ tab: 'API reference', icon: 'code', openapi: { source, directory }, groups })
  return {
    products: [
      {
        product: 'Platform',
        tabs: [guides, api('platform/api-reference', [{ group: 'Compute', pages: [{ group: 'Domains', icon: 'globe', pages: ['POST /v2/domains.createDomain', 'POST /v2/domains.listDomains'] }] }])],
      },
      {
        product: 'Compute',
        tabs: [guides, { tab: 'CLI', groups: [{ group: 'Commands', pages: ['guide'] }] }, api('compute/api-reference', [{ group: 'Domains', pages: ['POST /v2/domains.createDomain'] }])],
      },
      {
        product: 'API management',
        tabs: [
          guides,
          api('api-management/api-reference', [
            { group: 'Keys', pages: ['POST /v2/keys.createKey', 'POST /v2/keys.getKey', 'POST /v2/keys.hiddenKey', 'POST /v2/keys.excludedKey', 'POST /v2/keys.deleteKey'] },
            { group: 'Internal', pages: ['POST /v2/keys.hiddenKey', 'POST /v2/keys.excludedKey'] },
            { group: 'Rate limiting', pages: [{ group: 'Limits', pages: ['POST /v2/ratelimit.limit'] }] },
            { group: 'APIs', pages: ['POST /v2/apis.createApi'] },
          ]),
          { tab: 'SDKs', groups: [{ group: 'Libraries', pages: ['guide'] }] },
        ],
      },
    ],
  }
}
