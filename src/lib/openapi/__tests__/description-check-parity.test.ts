/** `thally check` reads the description of the operation the site resolves a page's `openapi:` reference to. */

import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const respond = { responses: { 200: { description: 'ok' } } }
  const document = (extra: Record<string, unknown>) => ({ openapi: '3.1.0', info: { title: 't', version: '1' }, ...extra })
  return {
    // The default spec, then a later one that lists some of the same operations.
    a: document({
      paths: {
        '/status': { get: { operationId: 'getStatus', ...respond } },
        '/withheld': { get: { 'x-hidden': true, description: 'Hidden in A.', ...respond } },
        '/excluded': { get: { 'x-excluded': true, description: 'Excluded in A.', ...respond } },
        '/only-a': { get: { summary: 'Only in A.', ...respond } },
      },
      webhooks: {
        ticket: { post: { operationId: 'zeta', ...respond }, put: { operationId: 'alpha', description: 'Put text.', ...respond } },
        ranked: { post: { summary: 'Beta', description: 'Beta text.', ...respond }, put: { summary: 'Alpha', description: 'Alpha text.', ...respond } },
        quiet: { post: { operationId: 'alpha', 'x-hidden': true, description: 'Hidden post.', ...respond }, put: { operationId: 'zeta', ...respond } },
        loud: { post: { operationId: 'alpha', 'x-excluded': true, description: 'Excluded post.', ...respond }, put: { operationId: 'zeta', description: 'Put text.', ...respond } },
        tied: { post: { operationId: 'same', ...respond }, put: { operationId: 'same', description: 'Put text.', ...respond } },
        grouped: { post: { operationId: 'alpha', ...respond }, put: { operationId: 'zeta', description: 'Grouped put.', ...respond } },
        regrouped: { post: { operationId: 'alpha', ...respond }, put: { operationId: 'zeta', description: 'Regrouped put.', ...respond } },
      },
    }),
    b: document({
      paths: {
        '/status': { get: { description: 'Status in B.', ...respond } },
        '/withheld': { get: { description: 'Visible in B.', ...respond } },
        '/only-b': { get: { summary: 'Only in B.', ...respond } },
      },
      webhooks: { ticket: { post: { description: 'Ticket in B.', ...respond } }, only: { post: { operationId: 'only', description: 'Webhook only in B.', ...respond } } },
    }),
    aOverrides: { 'WEBHOOK PUT grouped': { group: 'A group' }, 'WEBHOOK POST regrouped': { group: 'Zeta group' } },
  }
})

vi.mock('@/config/api-reference', () => ({
  apiReferenceConfig: {
    defaultSpecId: 'default',
    specs: [
      { id: 'default', label: 'A', source: { type: 'file', path: '/openapi-a.json' }, operationOverrides: fixture.aOverrides, webhookGroup: 'Events' },
      { id: 'b', label: 'B', source: { type: 'file', path: '/openapi-b.yaml' } },
    ],
  },
}))
vi.mock('@/data/docs', () => ({ getApiPlaygroundCredentials: () => ({}) }))
vi.mock('@/lib/openapi/fetch', () => ({
  getSpecConfig: (config: { specs: Array<{ id: string }> }, id: string) => config.specs.find((s) => s.id === id),
  loadSpec: async (config: { id: string }) => ({ config, document: config.id === 'default' ? fixture.a : fixture.b }),
  loadAuthoredSpecDocument: async (config: { id: string }) => (config.id === 'default' ? fixture.a : fixture.b),
}))

import { getApiOperationForFrontmatter } from '@/data/api-reference'
import { parseOpenApiFrontmatter } from '../page-frontmatter'
// Monorepo-only: `thally check` ships in packages/create-thally-docs, which the
// standalone starter does not have (see SOURCE_ONLY_PATHS in
// .github/scripts/starter-runtime-contract.mjs).
import { operationDescription, parseDocReference } from '../../../../packages/create-thally-docs/src/openapi-publication'

describe('thally check operation description parity with the site', () => {
  const specs = [
    { source: 'openapi-a.json', document: fixture.a, overrides: fixture.aOverrides, webhookGroup: 'Events' },
    { source: 'openapi-b.yaml', document: fixture.b },
  ]
  const references = [
    ...['GET /status', 'GET /withheld', 'GET /excluded', 'GET /only-a', 'GET /only-b', 'GET /missing',
      'webhook ticket', 'webhook ranked', 'webhook quiet', 'webhook loud', 'webhook tied', 'webhook grouped', 'webhook regrouped', 'webhook only'],
    ...['openapi-a.json', 'openapi-b.yaml'].flatMap((spec) => ['GET /status', 'GET /withheld', 'webhook ticket', 'webhook only'].map((reference) => `${spec} ${reference}`)),
  ]

  it('shows the description of the operation the site resolves to, across specs, hidden operations and webhook methods', async () => {
    const shown: Record<string, string | undefined> = {}
    for (const reference of references) {
      const description = (await getApiOperationForFrontmatter(parseOpenApiFrontmatter(reference)!))?.operation.description
      shown[reference] = typeof description === 'string' && description.trim() ? description : undefined
      expect(operationDescription(parseDocReference(reference)!, specs), reference).toBe(shown[reference])
    }
    // Guard against a vacuous comparison: both outcomes occur, and the site's choices are the ones the fixture sets up.
    expect(Object.values(shown).filter(Boolean).length).toBeGreaterThan(10)
    expect(Object.values(shown).filter((value) => value === undefined).length).toBeGreaterThan(5)
    expect(shown).toMatchObject({
      'GET /status': undefined,
      'GET /withheld': 'Visible in B.',
      'GET /excluded': undefined,
      'webhook ticket': 'Put text.',
      'webhook ranked': 'Alpha text.',
      'webhook quiet': undefined,
      'webhook loud': 'Put text.',
      'webhook tied': undefined,
      'webhook grouped': 'Grouped put.',
      'webhook regrouped': 'Regrouped put.',
    })
  })
})
