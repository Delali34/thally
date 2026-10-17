/** Navigation wire fidelity and bounded inline decisions over the real canonical model. */
import { describe, expect, it } from 'vitest'
import type { SidebarCollection } from '@/data/docs'
import { canInlineNavigation, decodeNavigationWire, navigationHeaders, navigationJson, navigationWire, readNavigationResponse, MAX_NAVIGATION_RESPONSE_BYTES } from '@/lib/navigation-snapshot'

function fixture(count: number): Array<SidebarCollection> {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `page-${index}`, title: `Page ${index}`, href: `/v2/fr/page-${index}`, description: `Description ${index}`,
    icon: 'book', badge: 'New', method: 'GET', groupPath: ['Reference', 'Nested'],
  }))
  return [{ id: 'reference', label: 'Reference', version: 'v2', href: '/v2/fr', sections: [{
    id: 'nested', title: 'Reference', defaultOpen: true, items,
    nodes: [{ type: 'group', group: { id: 'inner', title: 'Nested', icon: 'box', defaultOpen: false, nodes: items.map(item => ({ type: 'page', item })) } }],
  }] }]
}

describe('navigation transport', () => {
  it('keeps the whole recursive tree, display fields, order and reference-based flat compatibility lists', () => {
    const source = fixture(10_000)
    const chunks = [...navigationWire(source)]
    expect(chunks.reduce((maximum, chunk) => Math.max(maximum, chunk.length), 0)).toBeLessThanOrEqual(6144)
    const wire = chunks.join('')
    expect(wire).not.toContain('"items":')
    const decoded = decodeNavigationWire(JSON.parse(wire))
    expect(decoded).toEqual(source)
    const root = decoded[0].sections[0].nodes![0]
    if (root.type !== 'group' || root.group.nodes[0].type !== 'page') throw new Error('Lost nested fixture')
    expect(decoded[0].sections[0].items[0]).toBe(root.group.nodes[0].item)
  })

  it('rebuilds flat generated API sections without dropping their UI metadata', () => {
    const source = fixture(3)
    delete source[0].sections[0].nodes
    const decoded = decodeNavigationWire(JSON.parse([...navigationWire(source)].join('')))
    expect(decoded[0].sections[0].items).toEqual(source[0].sections[0].items)
    expect(decoded[0].sections[0].nodes).toHaveLength(3)
  })

  it('roundtrips Unicode, control characters and surrogate boundaries in bounded string chunks', () => {
    const value = { text: 'x'.repeat(1023) + '😀\n"\\\u0000\ud800' + '€'.repeat(20_000), absent: undefined, array: [undefined, NaN] }
    const chunks = [...navigationJson(value)]
    expect(JSON.parse(chunks.join(''))).toEqual(JSON.parse(JSON.stringify(value)))
    expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(6144)
  })

  it('requires both node and payload limits and bounds deferred collection headers', () => {
    expect(canInlineNavigation(fixture(255))).toBe(true)
    expect(canInlineNavigation(fixture(256))).toBe(false) // The group is a node too.
    const large = fixture(1)
    large[0].sections[0].items[0].description = 'a'.repeat(128 * 1024)
    expect(canInlineNavigation(large)).toBe(false)
    expect(navigationHeaders(fixture(10_000))[0].sections).toEqual([])
    expect(navigationHeaders(Array.from({ length: 1000 }, (_, index) => ({ id: `${index}`, label: `${index}`, sections: [] })))).toHaveLength(256)
  })

  it('rejects malformed nodes instead of installing an unrelated or partial tree', () => {
    expect(() => decodeNavigationWire([{ id: 'docs', label: 'Docs', sections: [{ title: 'Bad', nodes: [{ type: 'page', item: { href: '/' } }] }] }])).toThrow()
    expect(() => decodeNavigationWire({ collections: [] })).toThrow()
  })
})


it('enforces actual streamed bytes, cancels over-budget responses and rejects invalid UTF-8', async () => {
  let cancelled = 0
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { cancelled++ },
  }, { highWaterMark: 0 })
  await expect(readNavigationResponse(new Response(source))).rejects.toThrow('supported response size')
  expect(cancelled).toBe(1)
  await expect(readNavigationResponse(new Response('[]', { headers: { 'Content-Length': `${MAX_NAVIGATION_RESPONSE_BYTES + 1}` } }))).rejects.toThrow('supported response size')
  await expect(readNavigationResponse(new Response(new Uint8Array([0xc0, 0xaf])))).rejects.toThrow()
  const encoder = new TextEncoder()
  const data = encoder.encode(JSON.stringify({ text: '😀é'.repeat(100) }))
  let offset = 0
  const tinyChunks = new ReadableStream<Uint8Array>({ pull(controller) { if (offset === data.length) controller.close(); else controller.enqueue(data.slice(offset, ++offset)) } })
  await expect(readNavigationResponse(new Response(tinyChunks))).resolves.toEqual({ text: '😀é'.repeat(100) })
})

it('counts empty collection and section metadata toward the decoder safety bound', () => {
  expect(() => decodeNavigationWire(Array.from({ length: 100_001 }, () => ({ id: 'x', label: 'x', sections: [] })))).toThrow()
  expect(() => decodeNavigationWire([{ id: 'x', label: 'x', sections: Array.from({ length: 100_000 }, () => ({ title: 'x', nodes: [] })) }])).toThrow()
})
