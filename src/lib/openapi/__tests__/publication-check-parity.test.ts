import { describe, expect, it } from 'vitest'
// Monorepo-only: `thally check` ships in packages/create-thally-docs, which the
// standalone starter does not have (see SOURCE_ONLY_PATHS in
// .github/scripts/starter-runtime-contract.mjs).
import { API_GROUPS_MAX_DEPTH as CHECK_GROUPS_MAX_DEPTH, groupKeyState, listedOperationKeys, operationDescription, operationState, pageState, parseDocReference } from '../../../../packages/create-thally-docs/src/openapi-publication'
import { API_GROUPS_MAX_DEPTH as MIGRATE_GROUPS_MAX_DEPTH } from '../../../../packages/migrate/src/navigation'
import { mdxServers, paramFieldPathNames, parseManualApi } from '../../../../packages/create-thally-docs/src/manual-api-check'
import { extractParamFields, parseApiFrontmatter, sanitizeApiMdxConfig } from '../manual-operation'
import { normalizeSpec } from '../normalize'
import { API_GROUPS_MAX_DEPTH, operationKeyFromRef } from '../operation-keys'
import { parseOpenApiFrontmatter } from '../page-frontmatter'
import { operationPublicationState, pageReferenceState, type RoutedSpec } from '../publication'
import type { ResolvedSpec } from '../types'

const ok = { responses: { 200: { description: 'ok' } } }
const doc = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: '3.1.0', info: { title: 't', version: '1' }, paths, ...extra,
})

describe('thally check publication parity', () => {
  it('gives `thally check` the same verdicts as the site', () => {
    const document = doc({
      '/a': { get: { 'x-hidden': true, ...ok }, post: { 'x-excluded': 'true', ...ok }, put: ok },
      '/entry': { 'x-excluded': true, get: ok },
      '/ref': { $ref: '#/components/pathItems/Flagged' },
      '/sibling': { $ref: '#/components/pathItems/Plain', 'x-hidden': true },
      '/chain': { $ref: '#/components/pathItems/Alias' },
      '/enc': { $ref: '#/components/pathItems/A%20B' },
      '/external': { $ref: 'other.yaml#/paths/~1x' },
      '/loop': { $ref: '#/paths/~1loop' },
    }, { components: { pathItems: {
      Flagged: { 'x-hidden': true, get: ok },
      Plain: { get: ok },
      Alias: { $ref: '#/components/pathItems/Flagged' },
      'A B': { 'x-excluded': true, get: ok },
    } } })
    const overrides = { 'GET /a': { hidden: false }, 'PUT /a': { hidden: true } }
    for (const path of ['/a', '/entry', '/ref', '/sibling', '/chain', '/enc', '/external', '/loop', '/missing']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        for (const withOverrides of [undefined, overrides]) {
          expect(operationState(document, method, path, withOverrides), `${method} ${path}`)
            .toBe(operationPublicationState(document, method, path, withOverrides))
        }
      }
    }
  })
})

describe('thally check operation description parity', () => {
  const document = doc({
    '/described': { get: { description: 'Described.', summary: 'Summary.', ...ok } },
    '/summary-only': { get: { summary: 'Summary.', ...ok } },
    '/empty-description': { get: { description: '', summary: 'Summary.', ...ok } },
    '/neither': { get: ok },
    '/overridden': { get: { description: 'Described.', ...ok }, post: ok },
    '/ref': { $ref: '#/components/pathItems/Plain' },
  }, { components: { pathItems: { Plain: { get: { description: 'Through a reference.', ...ok } } } } })
  const overrides = { 'GET /overridden': { description: 'Overridden.' }, 'POST /overridden': { description: '' } }

  it('shows the description `thally check` reads, or none where the site has none', () => {
    let compared = 0
    for (const withOverrides of [undefined, overrides]) {
      const config = { id: 'default', label: '', source: { type: 'file' as const, path: 'openapi.yaml' }, operationOverrides: withOverrides }
      const site = new Map(normalizeSpec({ config, document } as ResolvedSpec).operations.map((operation) => [operation.key, operation.description]))
      for (const path of ['/described', '/summary-only', '/empty-description', '/neither', '/overridden', '/ref']) {
        for (const method of ['GET', 'POST']) {
          const ref = parseDocReference(`openapi.yaml ${method} ${path}`)!
          const key = operationKeyFromRef(`${method} ${path}`)
          if (!key || !site.has(key)) continue
          compared++
          const shown = site.get(key)
          expect(operationDescription(ref, [{ source: 'openapi.yaml', document, overrides: withOverrides }]), `${method} ${path} ${withOverrides ? 'with' : 'without'} overrides`)
            .toBe(typeof shown === 'string' && shown.trim() ? shown : undefined)
        }
      }
    }
    // 6 get operations and 1 post, each with and without overrides.
    expect(compared).toBe(14)
  })
})

describe('thally check webhook parity', () => {
  const hook = (extra: Record<string, unknown> = {}) => ({ ...extra, post: ok })
  const document = doc({}, {
    webhooks: {
      hidden: hook({ 'x-hidden': true }),
      excluded: hook({ 'x-excluded': true }),
      opHidden: { post: { 'x-hidden': true, ...ok } },
      mixed: { post: { 'x-hidden': true, ...ok }, put: ok },
      shown: hook(),
      ref: { $ref: '#/components/pathItems/Flagged' },
      overridden: { post: { 'x-hidden': true, ...ok } },
      external: { $ref: 'other.yaml#/x' },
    },
    // The renderer only reads `webhooks`; `x-webhooks` never makes a page render.
    'x-webhooks': { onlyExt: hook({ 'x-hidden': true }), shown: hook({ 'x-hidden': true }) },
    components: { pathItems: { Flagged: { 'x-hidden': true, post: ok } } },
  })
  const overrides = { 'WEBHOOK POST overridden': { hidden: false }, 'WEBHOOK POST shown': { hidden: true } }
  const names = ['hidden', 'excluded', 'opHidden', 'mixed', 'shown', 'ref', 'overridden', 'external', 'onlyExt', 'missing']

  it('judges webhook pages the same in both implementations, spec-prefixed or bare', () => {
    for (const withOverrides of [undefined, overrides]) {
      const routed: Array<RoutedSpec> = [{
        config: { id: 'default', label: '', source: { type: 'file', path: 'openapi.yaml' }, operationOverrides: withOverrides },
        document,
      }]
      const specs = [{ source: 'openapi.yaml', document, overrides: withOverrides }]
      for (const name of names) {
        for (const raw of [`webhook ${name}`, `openapi.yaml webhook ${name}`]) {
          expect(pageState(parseDocReference(raw)!, specs), raw).toBe(pageReferenceState(parseOpenApiFrontmatter(raw)!, routed))
        }
      }
    }
  })

  it('withholds hidden and excluded webhooks and nothing the renderer can show', () => {
    const state = (name: string) => pageReferenceState(parseOpenApiFrontmatter(`openapi.yaml webhook ${name}`)!, [{ config: { id: 'default', label: '', source: { type: 'file', path: 'openapi.yaml' } }, document }])
    expect(['hidden', 'excluded', 'opHidden', 'ref'].map(state)).toEqual(['hidden', 'excluded', 'hidden', 'hidden'])
    // One visible method renders the page; an unreadable ref, a typo and x-webhooks-only entries are not judged.
    expect(['mixed', 'shown', 'external', 'onlyExt', 'missing'].map(state)).toEqual(['published', 'published', 'unknown', 'unknown', 'unknown'])
  })
})

describe('thally check page-reference parity', () => {
  const docA = doc({ '/h': { get: { 'x-hidden': true, ...ok } }, '/moved': { get: { 'x-hidden': true, ...ok } }, '/v': { get: ok } })
  const docB = doc({ '/moved': { get: ok }, '/secret': { get: { 'x-excluded': true, ...ok } }, '/o': { get: ok } })
  const setups: Array<Array<{ source: string; document?: unknown; overrides?: Record<string, { hidden: boolean }> }>> = [
    [{ source: 'openapi/a.json', document: docA }, { source: 'openapi/b.yaml', document: docB, overrides: { 'GET /o': { hidden: true } } }],
    [{ source: '/specs/a.json', document: docA }, { source: 'https://example.com/b.yaml' }],
    [{ source: 'openapi/a.json' }, { source: 'openapi/b.yaml', document: docB }],
    [{ source: 'openapi/Orders.yaml', document: docA }, { source: 'openapi/orders.yaml', document: docB }],
    [{ source: 'https://example.com/V1/api.yaml', document: docB }],
    [],
  ]
  const references = [
    'GET /h', 'GET /moved', 'GET /v', 'GET /secret', 'GET /o', 'GET /typo', 'get   /h', 'FETCH /h', 'GET h', '',
    'openapi/a.json GET /h', 'a.json GET /h', '/openapi/a.json GET /v', './openapi/b.yaml GET /secret', "'b.yaml' GET /o",
    '"OpenAPI/B.YAML" GET /moved', 'specs/a.json GET /h', 'https://example.com/b.yaml GET /secret', 'other.yaml GET /h',
    'openapi/Orders.yaml GET /h', 'openapi/orders.yaml GET /secret', 'OPENAPI/ORDERS.YAML GET /h', 'orders.yaml GET /secret',
    'HTTPS://Example.COM/V1/api.yaml GET /secret', 'https://example.com/v1/API.yaml GET /secret',
    'webhook orderUpdated', 'b.yaml webhook orderUpdated', 'my spec.json GET /v',
    '__proto__ GET /v', 'constructor GET /v', 'openapi/../../b.yaml GET /o', '..\\b.yaml GET /o', '%2e%2e%2fb.yaml GET /o',
    'https://user@EXAMPLE.com./b.yaml GET /o', 'b.yaml?x#y GET /o', 'ORDERS.YAML GET /h', 'orders.yaml GET /v',
  ]

  it('parses `openapi:` frontmatter the same way', () => {
    for (const raw of [...references, 42, null, '   ', '"GET /h"']) {
      const site = parseOpenApiFrontmatter(raw)
      const check = parseDocReference(raw)
      expect(check, String(raw)).toEqual(site ? { ...(site.specRef ? { specRef: site.specRef } : {}), method: site.method, path: site.path, ...(site.webhook ? { webhook: true } : {}) } : null)
    }
  })

  it('withholds the same pages as the build', () => {
    for (const setup of setups) {
      const routed: Array<RoutedSpec> = setup.map((spec, index) => ({
        config: {
          id: index === 0 ? 'default' : `s${index}`,
          label: '',
          source: /^https?:/.test(spec.source) ? { type: 'url', url: spec.source } : { type: 'file', path: spec.source },
          operationOverrides: spec.overrides,
        },
        document: spec.document,
      }))
      for (const raw of references) {
        const site = parseOpenApiFrontmatter(raw)
        const check = parseDocReference(raw)
        if (!site || !check) continue
        expect(pageState(check, setup), `${raw} with ${setup.map((spec) => spec.source).join(', ')}`).toBe(pageReferenceState(site, routed))
      }
    }
  })

  it('judges a pin against its own case-distinct source in both implementations', () => {
    const setup = setups[3]
    const routed: Array<RoutedSpec> = setup.map((spec, index) => ({
      config: { id: `s${index}`, label: '', source: { type: 'file', path: spec.source } },
      document: spec.document,
    }))
    for (const [raw, expected] of [
      ['openapi/orders.yaml GET /secret', 'excluded'],
      ['openapi/Orders.yaml GET /h', 'hidden'],
      ['openapi/orders.yaml GET /h', 'unknown'],
    ] as const) {
      expect(pageState(parseDocReference(raw)!, setup), raw).toBe(expected)
      expect(pageReferenceState(parseOpenApiFrontmatter(raw)!, routed), raw).toBe(expected)
    }
  })
})

describe('thally check manual api parity', () => {
  it('reads `api:` the same way as the site', () => {
    for (const raw of [
      'GET /status', 'post https://api.example.com/users?x=1&y=2#frag', '"PUT /a/{id}"', "'DELETE https://h.test'", 'GET https://h.test/',
      'FETCH /x', 'GET', 'GET x', 'GET /a b', 'GET https://u:p@h.test/x', 'GET https://h.test:8080/x', 'GET http://[::1]/x', 'GET ftp://h/x',
      '', '   ', 42, null, undefined, ['GET /x'], { a: 1 },
    ]) {
      const site = parseApiFrontmatter(raw)
      expect(parseManualApi(raw), String(raw)).toEqual(site)
    }
  })

  it('collects ParamField path names the same way as the site', () => {
    for (const mdx of [
      '<ParamField path="id" type="string" />',
      '<ParamField path="id" /><ParamField path="id" /><ParamField query="id" />',
      '<ParamField body="a" path="b" /><ParamField name="n" /><ParamField path={"x"} /><ParamField path />',
      '<ParamField path="false" path="id" />',
      'text <ParamField path="inline" /> text',
      '<ParamField path="a">\n  <ParamField path="nested" />\n</ParamField>',
      '<ParamField path="broken"', '{unclosed',
    ]) {
      expect(paramFieldPathNames(mdx), mdx).toEqual(extractParamFields(mdx).filter((field) => field.location === 'path').map((field) => field.name))
    }
  })

  it('reads docs.json api.mdx.server the same way as the site', () => {
    for (const api of [undefined, {}, { mdx: {} }, { mdx: { server: 'https://a.test/' } }, { mdx: { server: ['https://a.test', 'nope', 'https://a.test', 'https://u@h.test'] } }, { mdx: 5 }]) {
      expect(mdxServers(api), JSON.stringify(api)).toEqual(sanitizeApiMdxConfig((api as { mdx?: unknown } | undefined)?.mdx).servers)
    }
  })
})

describe('thally check api.groups parity', () => {
  const document = doc({
    '/a': { get: { 'x-hidden': true, ...ok }, post: { 'x-excluded': 'true', ...ok }, put: ok, delete: ok },
    '/entry': { 'x-excluded': true, get: ok },
    '/ref': { $ref: '#/components/pathItems/Flagged' },
    '/plain': { get: ok },
  }, {
    webhooks: {
      shown: { post: ok, put: { 'x-hidden': true, ...ok } },
      hidden: { 'x-hidden': true, post: ok },
      mixed: { post: { 'x-excluded': true, ...ok }, get: ok },
    },
    components: { pathItems: { Flagged: { 'x-hidden': true, get: ok } } },
  })
  const overrides = { 'DELETE /a': { hidden: true }, 'GET /a': { hidden: false }, 'WEBHOOK PUT shown': { hidden: false }, 'WEBHOOK POST hidden': { hidden: false } }
  const keys = [
    'GET /a', 'POST /a', 'PUT /a', 'DELETE /a', 'get   /a', ' put /a ', 'GET /entry', 'GET /ref', 'GET /plain', 'GET /plain/', 'GET /Plain', 'FETCH /plain', 'GET', 'plain', '',
    'WEBHOOK POST shown', 'WEBHOOK PUT shown', 'webhook put shown', 'WEBHOOK POST hidden', 'WEBHOOK POST mixed', 'WEBHOOK GET mixed', 'WEBHOOK PUT mixed',
    'WEBHOOK GET shown', 'WEBHOOK POST nope', 'POST shown', 'WEBHOOK shown',
  ]

  it('lists the same operations in the sidebar as `thally check` calls published', () => {
    for (const withOverrides of [undefined, overrides]) {
      const config = { id: 'default', label: '', source: { type: 'file' as const, path: 'openapi.yaml' }, operationOverrides: withOverrides }
      const listed = new Set(normalizeSpec({ config, document } as ResolvedSpec).operations
        .filter((operation) => !operation.hidden)
        .map((operation) => operation.key))
      for (const key of keys) {
        const siteKey = operationKeyFromRef(key)
        expect(groupKeyState(document, key, withOverrides) === 'published', `${key} ${withOverrides ? 'with' : 'without'} overrides`)
          .toBe(siteKey !== null && listed.has(siteKey))
      }
    }
  })

  it('walks nested groups and ignores anything that is not an authored string', () => {
    expect(listedOperationKeys([
      { group: 'A', pages: ['GET /a', { group: 'B', pages: ['POST /a', { group: 'C', pages: ['PUT /a'] }] }, 'DELETE /a'] },
      { group: 'D', pages: [] },
      { group: 'E', pages: [7, null, ['GET /x']] },
      { group: 'F' },
      'GET /stray',
    ])).toEqual(['GET /a', 'POST /a', 'PUT /a', 'DELETE /a'])
    expect(listedOperationKeys(undefined)).toEqual([])
    expect(listedOperationKeys({ group: 'A', pages: ['GET /a'] })).toEqual([])
  })

  it('stops at the same group depth as the site', () => {
    expect(CHECK_GROUPS_MAX_DEPTH).toBe(API_GROUPS_MAX_DEPTH)
    // Renderer parity belongs to the public application, since the migration
    // package also runs in hosts that do not ship this renderer.
    expect(MIGRATE_GROUPS_MAX_DEPTH).toBe(API_GROUPS_MAX_DEPTH)
  })
})
