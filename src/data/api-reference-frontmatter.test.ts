/** Spec-prefix and multi-spec resolution of `openapi:` frontmatter. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const docs = vi.hoisted(() => ({
  a: { openapi: '3.0.0', paths: { '/things': { post: { summary: 'A things' } }, '/dup': { get: {} }, '/hidden': { get: { 'x-hidden': true } }, '/excluded': { get: { 'x-excluded': true } } }, webhooks: { orderUpdated: { post: {} } } },
  b: { openapi: '3.0.0', paths: { '/widgets/{id}': { get: { summary: 'B widget' } }, '/dup': { get: {} } } },
  c: { openapi: '3.0.0', paths: { '/dup': { get: {} }, '/only-c': { get: {} } } },
}))

vi.mock('@/config/api-reference', () => ({
  apiReferenceConfig: {
    defaultSpecId: 'default',
    specs: [
      { id: 'default', label: 'A', source: { type: 'file', path: '/openapi-a.json' } },
      { id: 'b', label: 'B', source: { type: 'file', path: '/openapi-b.yaml' } },
      { id: 'c', label: 'C', source: { type: 'file', path: '/specs/c.json' } },
    ],
  },
}))
vi.mock('@/data/docs', () => ({ getApiPlaygroundCredentials: () => ({}), getApiMdxConfig: () => ({ servers: [] }) }))
vi.mock('@/lib/openapi/fetch', () => ({
  getSpecConfig: (config: { specs: Array<{ id: string }> }, id: string) => config.specs.find((s) => s.id === id),
  loadSpec: async (config: { id: string }) => ({
    config,
    document: config.id === 'default' ? docs.a : config.id === 'b' ? docs.b : docs.c,
  }),
  loadAuthoredSpecDocument: async (config: { id: string }) => (config.id === 'default' ? docs.a : config.id === 'b' ? docs.b : docs.c),
}))

import { getApiOperationForFrontmatter, lookupApiOperationForFrontmatter } from '@/data/api-reference'
import { parseOpenApiFrontmatter } from '@/lib/openapi/page-frontmatter'

async function resolve(value: string) {
  return getApiOperationForFrontmatter(parseOpenApiFrontmatter(value)!)
}

describe('getApiOperationForFrontmatter', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))

  it('resolves the bare form in the default spec first (unchanged behaviour)', async () => {
    expect((await resolve('POST /things'))?.operation.specId).toBe('default')
    expect((await resolve('get /dup'))?.operation.specId).toBe('default')
  })

  it('searches other specs when the default lacks the operation', async () => {
    expect((await resolve('GET /widgets/{id}'))?.operation.specId).toBe('b')
    expect((await resolve('GET /only-c'))?.operation.specId).toBe('c')
  })

  it('honours a spec prefix, even when another spec has the same operation', async () => {
    expect((await resolve('openapi-b.yaml GET /widgets/{id}'))?.operation.specId).toBe('b')
    expect((await resolve('/specs/c.json GET /dup'))?.operation.specId).toBe('c')
    expect((await resolve('"c.json" GET /dup'))?.operation.specId).toBe('c')
    expect((await resolve('openapi-a.json GET /widgets/{id}'))).toBeNull()
  })

  it('returns null for unknown specs and operations', async () => {
    expect(await resolve('nope.json GET /widgets/{id}')).toBeNull()
    expect(await resolve('FETCH /x')).toBeNull()
    expect(await resolve('GET /missing')).toBeNull()
  })

  it('resolves webhooks by name', async () => {
    expect((await resolve('openapi-a.json webhook orderUpdated'))?.operation.isWebhook).toBe(true)
    expect(await resolve('openapi-b.yaml webhook orderUpdated')).toBeNull()
  })
})

describe('lookupApiOperationForFrontmatter', () => {
  const lookup = (value: string) => lookupApiOperationForFrontmatter(parseOpenApiFrontmatter(value)!)

  it('returns the node when the operation resolves', async () => {
    expect((await lookup('POST /things')).node?.operation.specId).toBe('default')
  })

  it('reports a hidden or excluded operation as withheld', async () => {
    expect(await lookup('GET /hidden')).toEqual({ node: null, reason: 'withheld' })
    expect(await lookup('GET /excluded')).toEqual({ node: null, reason: 'withheld' })
    expect(await lookup('openapi-a.json GET /excluded')).toEqual({ node: null, reason: 'withheld' })
  })

  it('reports an unknown spec or operation as unresolved', async () => {
    expect(await lookup('GET /missing')).toEqual({ node: null, reason: 'unresolved' })
    expect(await lookup('nope.json GET /things')).toEqual({ node: null, reason: 'unresolved' })
  })
})
