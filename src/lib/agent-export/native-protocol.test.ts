/** The in-process capability cannot be forged by HTTP or reused across fetches. */
import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { createNativeAgentExportCapability, isNativeAgentExportPlan, nativeAgentExportCapability, nativeAgentExportStringBytes, MAX_NATIVE_PLAN_PAYLOAD_BYTES, NATIVE_AGENT_EXPORT_SYMBOL, type NativeAgentExportPlan } from './native-protocol'

function plan(origin = 'https://public.example'): NativeAgentExportPlan {
  return { version: 1, origin, locale: 'en', siteName: 'Docs', siteDescription: 'Description', shards: [], pages: [], apiMarkdown: [] }
}

describe('native export capability', () => {
  it('accepts one plan only and closes before body delivery', () => {
    const handoff = createNativeAgentExportCapability(new Request('https://public.example/llms-full.txt?locale=en'))
    const candidate = plan()
    expect(handoff.capability.accept(candidate)).toBe(true)
    expect(handoff.capability.accept(plan())).toBe(false)
    expect(handoff.finish()).toBe(candidate)
    expect(handoff.finish()).toBeNull()
    expect(handoff.capability.accept(plan())).toBe(false)
  })

  it('keeps two overlapping handoffs isolated and rejects aborts', () => {
    const a = createNativeAgentExportCapability(new Request('https://public.example/llms-full.txt'))
    const abort = new AbortController()
    const b = createNativeAgentExportCapability(new Request('https://other.example/llms-full.txt', { signal: abort.signal }))
    expect(a.capability.accept(plan('https://other.example'))).toBe(false)
    expect(b.capability.accept(plan())).toBe(false)
    expect(a.capability.accept(plan())).toBe(true)
    abort.abort()
    expect(b.capability.accept(plan('https://other.example'))).toBe(false)
    expect(b.finish()).toBeNull()
    expect(a.finish()?.origin).toBe('https://public.example')
  })

  it('allows adapter origin normalization but binds the original path and query', () => {
    const handoff = createNativeAgentExportCapability(new Request('https://public.example/llms-full.txt?locale=fr'))
    const environment = { [NATIVE_AGENT_EXPORT_SYMBOL]: handoff.capability }
    const current = new Request('http://localhost:1234/llms-full.txt?locale=fr')
    expect(nativeAgentExportCapability(current, environment)?.requestUrl).toBe(handoff.capability.requestUrl)
    expect(nativeAgentExportCapability(new Request('http://localhost:1234/llms-full.txt?locale=en'), environment)).toBeNull()
    expect(nativeAgentExportCapability(new Request('http://localhost:1234/api/search?locale=fr'), environment)).toBeNull()
    expect(nativeAgentExportCapability(new Request(current.url, { method: 'POST' }), environment)).toBeNull()
  })

  it('does not accept forged HTTP headers or serialized environment strings', () => {
    const request = new Request('https://public.example/llms-full.txt', { headers: { 'X-Thally-Export-Plan': 'true' } })
    expect(nativeAgentExportCapability(request, {})).toBeNull()
    expect(nativeAgentExportCapability(request, { [NATIVE_AGENT_EXPORT_SYMBOL]: JSON.stringify({ version: 1, requestUrl: request.url }) })).toBeNull()
  })

  it('rejects functions, framework objects, extra data and oversized metadata', () => {
    expect(isNativeAgentExportPlan({ ...plan(), apiMarkdown: [() => 'secret'] })).toBe(false)
    expect(isNativeAgentExportPlan({ ...plan(), headers: new Headers() })).toBe(false)
    expect(isNativeAgentExportPlan({ ...plan(), siteDescription: 'x'.repeat(MAX_NATIVE_PLAN_PAYLOAD_BYTES + 1) })).toBe(false)
    expect(isNativeAgentExportPlan(Object.assign(new Date(), plan()))).toBe(false)
  })

  it('counts every UTF-16 unit and surrogate boundary exactly like native UTF-8 encoders', () => {
    const allUnits = Array.from({ length: 65536 }, (_, unit) => String.fromCharCode(unit)).join('')
    const samples = ['', 'ASCII\0\n"\\', '\u007f\u0080\u07ff\u0800\uffff', 'Français 中文 العربية', '😀𐀀', '\ud800', '\udfff', '\ud800x\udc00', '\ud800\ud800\udc00\udc00', allUnits]
    for (const sample of samples) {
      expect(nativeAgentExportStringBytes(sample)).toBe(Buffer.byteLength(sample, 'utf8'))
      expect(nativeAgentExportStringBytes(sample)).toBe(new TextEncoder().encode(sample).byteLength)
    }
  })

  it('retains the exact 8 MiB payload cap without rejecting 3 MiB of ASCII', () => {
    expect(isNativeAgentExportPlan({ ...plan(), siteDescription: 'x'.repeat(3 * 1024 * 1024) })).toBe(true)
    const candidate = { ...plan(), siteDescription: '' }
    const fixedBytes = [candidate.origin, candidate.locale, candidate.siteName].reduce((bytes, value) => bytes + Buffer.byteLength(value), 128)
    candidate.siteDescription = 'x'.repeat(MAX_NATIVE_PLAN_PAYLOAD_BYTES - fixedBytes)
    expect(isNativeAgentExportPlan(candidate)).toBe(true)
    candidate.siteDescription += 'x'
    expect(isNativeAgentExportPlan(candidate)).toBe(false)
    expect(isNativeAgentExportPlan({ ...plan(), apiMarkdown: ['漢'.repeat(Math.floor(MAX_NATIVE_PLAN_PAYLOAD_BYTES / 3) + 1)] })).toBe(false)
    expect(isNativeAgentExportPlan({ ...plan(), apiMarkdown: ['\ud800'.repeat(Math.floor(MAX_NATIVE_PLAN_PAYLOAD_BYTES / 3) + 1)] })).toBe(false)
  })

  it('rejects backward, overlapping and out-of-bounds physical ranges', () => {
    const candidate = { ...plan(), shards: [{ path: 'bulk/0000.txt', bytes: 10, sha256: 'a'.repeat(64) }], pages: [{ title: 'A', description: '', href: '/a', ranges: [{ shard: 0, start: 0, end: 6 }] }, { title: 'B', description: '', href: '/b', ranges: [{ shard: 0, start: 5, end: 10 }] }] }
    expect(isNativeAgentExportPlan(candidate)).toBe(false)
    candidate.pages[1].ranges[0].start = 6
    expect(isNativeAgentExportPlan(candidate)).toBe(true)
    candidate.pages[1].ranges[0].end = 11
    expect(isNativeAgentExportPlan(candidate)).toBe(false)
  })
})
