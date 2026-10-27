/** Bounded HTTPS specification downloading and inert operation parsing, without repository capabilities. */
import { lookup } from 'node:dns/promises'
import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { createGunzip, type Gunzip } from 'node:zlib'
import type { MigrationFetcher } from './types.js'

/** The same extension flags the runtime uses to withhold an operation. */
const isWithheld = (node: Record<string, unknown>): boolean => [node['x-hidden'], node['x-excluded']].some((value) => value === true || value === 'true')

const MAX_SPEC_BYTES = 25_000_000
const MAX_REDIRECTS = 3

/**
 * A download is abandoned when no bytes arrive for `idleMs`, or after `totalMs` however steadily it
 * goes. A large spec from a slow server can take a minute; a stalled one is not worth waiting for.
 */
export interface SpecDownloadLimits {
  idleMs: number
  totalMs: number
}

const DEFAULT_LIMITS: SpecDownloadLimits = { idleMs: 30_000, totalMs: 300_000 }

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    const [a, b] = parts
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 203 && b === 0)
      || (a === 198 && b === 51))
  }
  // Global unicast only. This excludes loopback, link-local, unique-local,
  // mapped IPv4, multicast, and every host-local address family.
  return family === 6 && /^[23][0-9a-f]{0,3}:/i.test(address)
    && !/^2001:db8:/i.test(address)
}

function validatedSpecUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || isIP(url.hostname)) {
    throw new Error('Remote OpenAPI references must use an HTTPS domain without credentials or an IP literal.')
  }
  url.hash = ''
  return url
}

async function getPinnedAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await lookup(url.hostname, { all: true })
  if (addresses.length === 0 || addresses.some((candidate) => !isPublicAddress(candidate.address, candidate.family))) {
    throw new Error('The OpenAPI host did not resolve exclusively to public addresses.')
  }
  return addresses[0] as { address: string; family: 4 | 6 }
}

interface SpecResponse {
  status: number
  location?: string
  body: Buffer
}

/** `deadlineAt` is the wall-clock end of the whole download, shared by every redirect hop. */
async function requestPinnedSpec(url: URL, limits: SpecDownloadLimits, deadlineAt: number): Promise<SpecResponse> {
  const timedOut = (): Error => new Error(`Downloading the OpenAPI spec took longer than ${limits.totalMs / 1000} seconds.`)
  const lookupMs = deadlineAt - Date.now()
  if (lookupMs <= 0) throw timedOut()
  // The address lookup cannot be cancelled, so the deadline is raced against it: a stalled lookup ends the download on time.
  let lookupTimer: NodeJS.Timeout | undefined
  const pinned = await Promise.race([
    getPinnedAddress(url),
    new Promise<never>((_resolve, reject) => { lookupTimer = setTimeout(() => reject(timedOut()), lookupMs) }),
  ]).finally(() => clearTimeout(lookupTimer))
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) throw timedOut()
  return new Promise<SpecResponse>((resolve, reject) => {
    let response: IncomingMessage | undefined
    let decoder: Gunzip | undefined
    // Whichever limit trips, stop everything: destroying only the request would leave the decoder
    // expanding bytes it already holds, long after the download was given up on.
    const abandon = (error: Error): void => {
      clearTimeout(deadline)
      decoder?.destroy()
      response?.destroy()
      req.destroy()
      reject(error)
    }
    const req = request(url, {
      // Node's request does not ask for compression by itself, and a large spec is far smaller gzipped.
      headers: { Accept: 'application/json, application/yaml, text/yaml, */*', 'Accept-Encoding': 'gzip', 'User-Agent': 'Thally-Migrate/1.0 (+https://thally.io)' },
      // Node's dual-stack connector asks lookup for `all: true`; that
      // callback must receive address records, not a single address string.
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [pinned])
        else callback(null, pinned.address, pinned.family)
      },
    }, (incoming) => {
      response = incoming
      const status = incoming.statusCode ?? 0
      if (status >= 300 && status < 400) {
        // Only the Location header is wanted: close the body now so it cannot hold a connection open.
        clearTimeout(deadline)
        incoming.destroy()
        resolve({ status, location: incoming.headers.location, body: Buffer.alloc(0) })
        return
      }
      if (status < 200 || status >= 300) {
        abandon(new Error(`OpenAPI server returned ${status}.`))
        return
      }
      const statedBytes = Number(incoming.headers['content-length'] ?? 0)
      if (statedBytes > MAX_SPEC_BYTES) {
        abandon(new Error('Remote OpenAPI spec exceeds the 25 MB import limit.'))
        return
      }
      const encoding = String(incoming.headers['content-encoding'] ?? 'identity').toLowerCase()
      if (encoding !== 'identity' && encoding !== 'gzip') {
        abandon(new Error(`The OpenAPI server compressed the spec with "${encoding}", which Thally cannot read. Serve it uncompressed or as gzip.`))
        return
      }
      if (encoding === 'gzip') decoder = incoming.pipe(createGunzip())
      const body = decoder ?? incoming
      const chunks: Array<Buffer> = []
      let bytes = 0
      // The limit counts decoded bytes, so a small download cannot expand past it.
      body.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_SPEC_BYTES) {
          abandon(new Error('Remote OpenAPI spec exceeds the 25 MB import limit.'))
          return
        }
        chunks.push(chunk)
      })
      body.on('end', () => {
        clearTimeout(deadline)
        resolve({ status, body: Buffer.concat(chunks) })
      })
      body.on('error', (error) => abandon(decoder ? new Error(`The OpenAPI spec could not be decompressed: ${error.message}`) : error))
      if (decoder) incoming.on('error', abandon)
    })
    req.setTimeout(limits.idleMs, () => abandon(new Error(`The OpenAPI server stopped sending data for ${limits.idleMs / 1000} seconds.`)))
    const deadline = setTimeout(() => abandon(timedOut()), remainingMs)
    req.on('error', abandon)
    req.end()
  })
}

/** Fetch one bounded HTTPS specification, validating every redirect and public DNS address. */
export async function downloadSpec(value: string, fetcher?: MigrationFetcher, limits: Partial<SpecDownloadLimits> = {}): Promise<Buffer> {
  let url = validatedSpecUrl(value)
  if (fetcher) {
    const response = await fetcher(url, { accept: 'application/json, application/yaml, text/yaml' })
    validatedSpecUrl(response.finalUrl.toString())
    const body = Buffer.from(response.body)
    if (body.length > MAX_SPEC_BYTES) throw new Error('Remote OpenAPI spec exceeds the 25 MB import limit.')
    return body
  }
  const resolved = { ...DEFAULT_LIMITS, ...limits }
  const deadlineAt = Date.now() + resolved.totalMs
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await requestPinnedSpec(url, resolved, deadlineAt)
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || hop === MAX_REDIRECTS) throw new Error('Remote OpenAPI spec redirected too many times.')
      url = validatedSpecUrl(new URL(response.location, url).toString())
      continue
    }
    return response.body
  }
  throw new Error('Remote OpenAPI spec redirected too many times.')
}

export interface OpenApiOperation {
  method: string
  path: string
  tag: string
  summary: string
}

/** List visible operations from inert OpenAPI 3 data within the path budget. */
export function parseOpenApi(parsed: unknown): Array<OpenApiOperation> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OpenAPI spec is not an object.')
  const document = parsed as Record<string, unknown>
  if (typeof document.openapi !== 'string' || !/^3\./.test(document.openapi)) {
    throw new Error('Remote specification is not OpenAPI 3.x.')
  }
  if (!document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)) {
    throw new Error('Remote OpenAPI spec has no paths object.')
  }
  const paths = Object.entries(document.paths as Record<string, unknown>)
  if (paths.length > 5_000) throw new Error('Remote OpenAPI spec has too many paths to import.')
  const operations: Array<OpenApiOperation> = []
  for (const [path, value] of paths) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isWithheld(value as Record<string, unknown>)) continue
    for (const [method, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!/^(get|post|put|patch|delete|head|options|trace)$/i.test(method)
        || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const operation = raw as Record<string, unknown>
      // The published spec does not carry a withheld operation, so no endpoint page exists to redirect to.
      if (isWithheld(operation)) continue
      const tags = Array.isArray(operation.tags) ? operation.tags : []
      operations.push({
        method: method.toLowerCase(),
        path,
        tag: typeof tags[0] === 'string' ? tags[0] : 'API Reference',
        summary: typeof operation.summary === 'string' ? operation.summary : String(operation.operationId ?? ''),
      })
    }
  }
  return operations
}

