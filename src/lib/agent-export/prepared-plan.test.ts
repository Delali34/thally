/** Request metadata and current physical lookup, never prepared-index metadata, choose ranges. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentSource } from '@/lib/content-source/types'
import { createPreparedAgentExportPlan } from './prepared-plan'
import { PREPARED_BULK_FORMAT, type PreparedBulkDescriptor } from './prepared-contract'

const state = vi.hoisted(() => ({ source: null as ContentSource | null }))
vi.mock('@/lib/content-source', () => ({ getContentSource: () => state.source }))
const sha = 'a'.repeat(64)
const descriptor: PreparedBulkDescriptor = {
  version: 1, format: PREPARED_BULK_FORMAT, sourceRevision: sha,
  shards: [{ path: 'bulk/0000.txt', bytes: 100, sha256: sha }],
  records: {
    'src/content/a.mdx': { sha256: sha, ranges: [{ shard: 0, start: 0, end: 10 }] },
    'src/content/a/index.mdx': { sha256: sha, ranges: [{ shard: 0, start: 10, end: 20 }] },
    'src/content/fr/a.mdx': { sha256: sha, ranges: [{ shard: 0, start: 20, end: 30 }] },
    'src/content/secret.mdx': { sha256: sha, ranges: [{ shard: 0, start: 30, end: 40 }] },
    'src/content/b.mdx': { sha256: sha, ranges: [{ shard: 0, start: 40, end: 50 }] },
    'src/content/fr/b/index.mdx': { sha256: sha, ranges: [{ shard: 0, start: 50, end: 60 }] },
  },
}
const input = { origin: 'https://current.example', locale: 'en', siteName: 'Current site', siteDescription: 'Current description', pages: [{ id: 'a', title: 'Current title', description: 'Current page description', href: '/a' }, { id: 'b', title: 'B', href: '/b' }], apiMarkdown: ['## Current authorized operation'] }
beforeEach(() => { state.source = { kind: 'assets', bulkExport: async () => descriptor, read: async () => { throw new Error('No source body parsing in prepared plan') }, exists: async () => false, modifiedAt: async () => 0, list: async () => [] } })

describe('authorized prepared range plan', () => {
  it('retains caller authorization/order/metadata and exact primary precedence without adding withheld index pages', async () => {
    const plan = await createPreparedAgentExportPlan(input)
    expect(plan?.pages).toEqual([
      { title: 'Current title', description: 'Current page description', href: '/a', ranges: [{ shard: 0, start: 0, end: 10 }] },
      { title: 'B', description: '', href: '/b', ranges: [{ shard: 0, start: 40, end: 50 }] },
    ])
    expect(JSON.stringify(plan)).not.toContain('secret')
    expect(plan?.apiMarkdown).toEqual(input.apiMarkdown)
  })

  it('uses the same explicit locale and index fallback candidates as the full document reader', async () => {
    const plan = await createPreparedAgentExportPlan({ ...input, locale: 'fr', engineLocale: 'fr', apiMarkdown: [] })
    expect(plan?.pages.map((page) => page.ranges)).toEqual([[{ shard: 0, start: 20, end: 30 }], [{ shard: 0, start: 50, end: 60 }]])
    expect(plan?.locale).toBe('fr')
    expect(plan?.apiMarkdown).toEqual([])
  })

  it('omits missing source entries as the canonical loader does and rejects unsafe page identifiers', async () => {
    const plan = await createPreparedAgentExportPlan({ ...input, pages: [{ id: 'missing', title: 'No file', href: '/missing' }, { id: '../secret', title: 'Unsafe', href: '/unsafe' }] })
    expect(plan?.pages).toEqual([])
  })

  it('fails actionable when current authored order cannot be represented by increasing protected ranges', async () => {
    await expect(createPreparedAgentExportPlan({ ...input, pages: [...input.pages].reverse() })).rejects.toThrow(/navigation order/)
  })

  it('does not select native delivery without an assets capability and a complete valid descriptor', async () => {
    state.source = { ...state.source!, kind: 'filesystem' }
    expect(await createPreparedAgentExportPlan(input)).toBeNull()
    state.source = { ...state.source!, kind: 'assets', bulkExport: undefined }
    expect(await createPreparedAgentExportPlan(input)).toBeNull()
    state.source = { ...state.source!, bulkExport: async () => null }
    expect(await createPreparedAgentExportPlan(input)).toBeNull()
  })
})
