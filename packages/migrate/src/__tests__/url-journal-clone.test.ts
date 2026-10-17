/** Journal cloning preserves JSON data while isolating every mutable container. */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cloneUrlMigrationCheckpoint } from '../url-journal-clone.js'
import type { UrlMigrationCheckpoint } from '../url-run-types.js'

describe('checkpoint container clone', () => {
  it('clones 10000 shared-logo records within a 96MiB heap without whole-journal serialization', () => {
    const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=96', '--import', 'tsx', fileURLToPath(new URL('./fixtures/url-journal-memory.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30_000 }))
    expect(result.records).toBe(10_000)
    expect(result.expandedPayloadBytes).toBeGreaterThan(1024 ** 3)
    expect(result.retainedHeapBytes).toBeLessThan(16 * 1024 ** 2)
    expect(result.wholeJournalSerializations).toBe(0)
    expect(result.isolated).toBe(true)
  })

  it('matches JSON semantics and isolates nested journal data without serializing shared strings', () => {
    const shared = 'bytes'.repeat(100_000)
    const input = {
      schemaVersion: 1, converterVersion: 'url-evidence-v2', sourceUrl: 'https://docs.test/', scopePath: '/', captureVersion: 'fetch-v1',
      records: [{ url: 'https://docs.test/', outcome: 'imported', discoveredBy: ['submitted'],
        page: { frontmatter: { nested: [{ label: 'original' }] } },
        evidence: { states: [{ code: ['exact\n'] }], code: ['code'], anchors: ['a'], links: ['/next'] },
        assets: [{ base64: shared }], issues: [{ message: 'original' }],
      }], navigation: [{ label: 'Group', children: [{ label: 'Page' }] }],
      extra: JSON.parse('{"__proto__":{"polluted":true}}'),
      omitted: undefined, numbers: [NaN, Infinity, -0], empty: [undefined, , null],
    }
    const copied = cloneUrlMigrationCheckpoint(input as unknown as UrlMigrationCheckpoint) as unknown as typeof input
    expect(JSON.stringify(copied)).toBe(JSON.stringify(input))
    copied.records[0].page.frontmatter.nested[0].label = 'changed'
    copied.records[0].evidence.states[0].code.push('changed')
    copied.records[0].assets[0].base64 = 'changed'
    copied.records[0].issues[0].message = 'changed'
    copied.records[0].discoveredBy.push('changed')
    copied.navigation[0].children[0].label = 'changed'
    expect(input.records[0].page.frontmatter.nested[0].label).toBe('original')
    expect(input.records[0].evidence.states[0].code).toEqual(['exact\n'])
    expect(input.records[0].assets[0].base64).toBe(shared)
    expect(input.records[0].issues[0].message).toBe('original')
    expect(input.records[0].discoveredBy).toEqual(['submitted'])
    expect(input.navigation[0].children[0].label).toBe('Page')
    expect(Object.getPrototypeOf(copied.extra)).toBe(Object.prototype)
    expect(Object.hasOwn(copied.extra, '__proto__')).toBe(true)
    expect({}).not.toHaveProperty('polluted')
  })

  it('rejects circular or executable non-JSON containers', () => {
    const circular = { records: [] as unknown[] }
    circular.records.push(circular)
    expect(() => cloneUrlMigrationCheckpoint(circular as unknown as UrlMigrationCheckpoint)).toThrow('circular')
    expect(() => cloneUrlMigrationCheckpoint({ records: [new Map()] } as unknown as UrlMigrationCheckpoint)).toThrow('plain JSON')
  })
})
