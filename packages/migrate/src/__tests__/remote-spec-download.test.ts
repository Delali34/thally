/** The spec download asks for compression and gives up on silence, not on a slow-but-steady transfer. */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync, type Gunzip } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const target = vi.hoisted(() => ({ port: 0 }))
// Every decoder the download creates, with the decoded bytes it has produced so far.
const decoders = vi.hoisted(() => ({ made: [] as Array<{ decoder: Gunzip; bytes: number }> }))

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  return {
    ...actual,
    createGunzip: (...args: Parameters<typeof actual.createGunzip>) => {
      const decoder = actual.createGunzip(...args)
      const record = { decoder, bytes: 0 }
      decoder.on('data', (chunk: Buffer) => { record.bytes += chunk.length })
      decoders.made.push(record)
      return decoder
    },
  }
})

// Resolve to a public address and speak plain HTTP to a local server, so the real
// request, timeout and decoding code runs without touching the network.
// A test sets `dns.delays` to make the next lookups slow, one entry per lookup.
const dns = vi.hoisted(() => ({ delays: [] as Array<number> }))
vi.mock('node:dns/promises', () => ({
  lookup: async () => {
    const delay = dns.delays.shift() ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return [{ address: '93.184.216.34', family: 4 }]
  },
}))
vi.mock('node:https', () => ({
  request: (url: URL, options: object, callback: (response: IncomingMessage) => void) => httpRequest(
    { ...options, host: '127.0.0.1', port: target.port, path: `${url.pathname}${url.search}` },
    callback,
  ),
}))

import { downloadSpec } from '../remote-spec.js'

const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} })
const specUrl = (path: string) => `https://specs.example.com${path}`

// 100 MB of spaces is about 100 KB gzipped, so the whole body arrives long before the limit trips.
const hugeBomb = gzipSync(Buffer.alloc(100_000_000, 32))

let server: Server
let dripClosed = Promise.resolve()
let lastHeaders: IncomingHttpHeaders = {}
const timers = new Set<NodeJS.Timeout>()

beforeAll(async () => {
  server = createServer((request, response) => {
    lastHeaders = request.headers
    const send = (body: Buffer, headers: Record<string, string> = {}) => { response.writeHead(200, headers); response.end(body) }
    const gzipped = { 'Content-Encoding': 'gzip' }
    switch (request.url) {
      case '/negotiated':
        if (String(request.headers['accept-encoding']).includes('gzip')) send(gzipSync(spec), gzipped)
        else send(Buffer.from(spec))
        break
      case '/always-gzip': send(gzipSync(spec), gzipped); break
      case '/unknown-encoding': send(Buffer.from(spec), { 'Content-Encoding': 'zstd' }); break
      case '/bomb': send(gzipSync(Buffer.alloc(26_000_000, 32)), gzipped); break
      case '/huge-bomb': send(hugeBomb, gzipped); break
      case '/stall':
        response.writeHead(200)
        response.write(spec.slice(0, 10))
        break
      case '/trickle': {
        response.writeHead(200)
        const timer = setInterval(() => response.write(' '), 40)
        timers.add(timer)
        response.on('close', () => { clearInterval(timer); timers.delete(timer) })
        break
      }
      case '/steady': {
        response.writeHead(200)
        const chunks = spec.match(/.{1,12}/g) ?? []
        let index = 0
        const timer = setInterval(() => {
          if (index < chunks.length) response.write(chunks[index++])
          else { clearInterval(timer); timers.delete(timer); response.end() }
        }, 60)
        timers.add(timer)
        break
      }
      case '/drip-redirect': {
        // A redirect whose body never ends: one byte every 30 ms, forever.
        let markClosed = () => {}
        dripClosed = new Promise<void>((resolve) => { markClosed = resolve })
        response.writeHead(302, { Location: '/always-gzip' })
        response.flushHeaders()
        const timer = setInterval(() => response.write('x'), 30)
        timers.add(timer)
        response.on('close', () => { clearInterval(timer); timers.delete(timer); markClosed() })
        break
      }
      default: {
        // /hop/N answers after 200 ms with a redirect to /hop/N-1, and /hop/0 is the spec itself.
        const hops = /^\/hop\/(\d+)$/.exec(request.url ?? '')
        if (!hops) { response.writeHead(404); response.end(); break }
        const left = Number(hops[1])
        setTimeout(() => {
          if (left === 0) send(Buffer.from(spec))
          else { response.writeHead(302, { Location: `/hop/${left - 1}` }); response.end() }
        }, 200)
      }
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  target.port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  for (const timer of timers) clearInterval(timer)
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

describe('remote spec download', () => {
  it('asks for a gzip response and returns the decoded spec', async () => {
    const body = await downloadSpec(specUrl('/negotiated'))
    expect(String(lastHeaders['accept-encoding'])).toContain('gzip')
    expect(body.toString()).toBe(spec)
  })

  it('reads a plain response when the server does not compress', async () => {
    const body = await downloadSpec(specUrl('/steady'), undefined, { idleMs: 500 })
    expect(body.toString()).toBe(spec)
  })

  it('decodes a gzip response whatever the server was asked', async () => {
    expect((await downloadSpec(specUrl('/always-gzip'))).toString()).toBe(spec)
  })

  it('refuses an encoding it did not ask for', async () => {
    await expect(downloadSpec(specUrl('/unknown-encoding'))).rejects.toThrow('zstd')
  })

  it('applies the 25 MB limit to the decoded size', async () => {
    await expect(downloadSpec(specUrl('/bomb'))).rejects.toThrow('25 MB')
  })

  it('stops decompressing once the decoded size limit trips', async () => {
    decoders.made.length = 0
    await expect(downloadSpec(specUrl('/huge-bomb'))).rejects.toThrow('25 MB')
    // Give a decoder that kept running time to chew through the rest of the 100 MB.
    await new Promise((resolve) => setTimeout(resolve, 700))
    const [{ decoder, bytes }] = decoders.made
    expect(decoder.destroyed).toBe(true)
    expect(bytes).toBeLessThan(30_000_000)
  })

  it('closes the body of a redirect it follows', async () => {
    expect((await downloadSpec(specUrl('/drip-redirect'))).toString()).toBe(spec)
    const closed = await Promise.race([dripClosed.then(() => true), new Promise<boolean>((resolve) => setTimeout(resolve, 1_000, false))])
    expect(closed).toBe(true)
  })

  it('counts one total time across every redirect of a download', async () => {
    // Three 200 ms hops against 300 ms in all: each hop alone is well inside it.
    await expect(downloadSpec(specUrl('/hop/2'), undefined, { idleMs: 5_000, totalMs: 300 })).rejects.toThrow('took longer than')
    expect((await downloadSpec(specUrl('/hop/2'), undefined, { idleMs: 5_000, totalMs: 5_000 })).toString()).toBe(spec)
  })

  it('counts a slow address lookup against the total time, without waiting for it to finish', async () => {
    dns.delays = [400]
    const started = Date.now()
    await expect(downloadSpec(specUrl('/hop/0'), undefined, { idleMs: 5_000, totalMs: 50 })).rejects.toThrow('took longer than')
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('counts the address lookup of a redirect against the same total time', async () => {
    // The first hop answers in 200 ms, then the lookup for the redirect stalls for 600 ms against 450 ms in all.
    dns.delays = [0, 600]
    const started = Date.now()
    await expect(downloadSpec(specUrl('/hop/1'), undefined, { idleMs: 5_000, totalMs: 450 })).rejects.toThrow('took longer than')
    expect(Date.now() - started).toBeLessThan(580)
  })

  it('keeps waiting while bytes keep arriving, even past the idle time', async () => {
    // 15 chunks, one every 60 ms: about 900 ms in all, against an idle time of 300 ms.
    const body = await downloadSpec(specUrl('/steady'), undefined, { idleMs: 300, totalMs: 10_000 })
    expect(body.toString()).toBe(spec)
  })

  it('gives up when the server stops sending data', async () => {
    await expect(downloadSpec(specUrl('/stall'), undefined, { idleMs: 200, totalMs: 10_000 })).rejects.toThrow('stopped sending data')
  })

  it('gives up on a transfer that never ends, even if bytes keep arriving', async () => {
    await expect(downloadSpec(specUrl('/trickle'), undefined, { idleMs: 1_000, totalMs: 300 })).rejects.toThrow('took longer than')
  })
})
