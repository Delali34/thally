import { type NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { siteTools, getSiteTool, isToolInputError } from '@/lib/mcp/site-tools'
import { listResources, readResource, resourceTemplates, rpcErrorCode } from '@/lib/mcp/site-resources'
import { getAdminSettings } from '@/lib/admin/settings'
import { resolveSiteConfig } from '@/lib/site-config'
import { agentServerName } from '@/lib/agent-identity'
import { BODY_TOO_LARGE_ERROR, readBoundedJson } from '@/lib/http/bounded-json'
import { consumePublicQuota, readRateLimitEnv } from '@/lib/http/public-rate-limit'
import { getReaderContextFromRequest } from '@/lib/reader-auth/context'
import type { ReaderContext } from '@/lib/reader-auth/access'

export const runtime = 'nodejs'

/**
 * Remote MCP endpoint — streamable HTTP, stateless, JSON responses. Any MCP
 * client attaches with `claude mcp add --transport http https://<site>/api/mcp`
 * and gets the site's docs as native tools and resources. Read-only and public
 * (subject to the docs-access gate in middleware on password-protected sites).
 * On reader-auth sites a `Bearer thrt_…` agent token (or reader session)
 * widens page, API and changelog tools to what that reader may open; search
 * stays anonymous. Without one, every tool sees the anonymous view.
 *
 * Implemented as plain JSON-RPC 2.0 (no SDK — the app carries none, and the
 * SDK's server transport keeps per-session state this stateless route avoids).
 *
 * Protocol notes:
 * - Negotiates up to MCP 2025-11-25 and falls back to the newest version it
 *   supports when a client asks for an unknown one. A non-initialize request
 *   carrying an unsupported `MCP-Protocol-Version` header gets 400, as the
 *   streamable-HTTP transport requires.
 * - JSON-RPC batches were removed from MCP in 2025-06-18; they are still
 *   accepted (capped at {@link MAX_BATCH}) for 2025-03-26 clients.
 * - Tool argument problems are tool execution errors (`isError: true`) so the
 *   model can self-correct; unknown tools and malformed requests are JSON-RPC
 *   protocol errors.
 */

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0]

/** Largest accepted request body. Tool arguments are short strings. */
const MAX_BODY_BYTES = 64 * 1024

/** Most messages in one (legacy) batch. */
const MAX_BATCH = 20

/** Methods that do real work (search, parsing, spec projection) and count against the limit. */
const METERED_METHODS = new Set(['tools/call', 'resources/read'])

/** Per-client ceiling on metered calls per minute (0 disables). */
const RATE_PER_MIN = readRateLimitEnv('MCP_RATE_PER_MIN', 60)

const INSTRUCTIONS = [
  'Read-only access to this documentation site.',
  'Use search_sections to answer a question from the most relevant sections, or search_docs to find pages and API operations.',
  'Read whole pages with read_page; inspect the API with list_api_operations and get_api_operation; check recent changes with list_changes.',
  'Cite the returned URLs. Pages are also available as resources (docs://pages/{pageId}).',
].join(' ')

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function errorResponse(status: number, code: number, message: string, headers?: HeadersInit) {
  return Response.json(rpcError(null, code, message), { status, headers })
}

/** Per-request state every handler needs. */
interface RequestScope {
  siteName: string
  origin: string
  reader: ReaderContext
}

async function callTool(id: unknown, params: Record<string, unknown>, { origin, reader }: RequestScope) {
  const name = typeof params.name === 'string' ? params.name : ''
  const tool = getSiteTool(name)
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name || '(none)'}`)
  if (params.arguments !== undefined && !isRecord(params.arguments)) {
    return rpcError(id, -32602, 'Tool "arguments" must be an object.')
  }
  try {
    const { text, structured } = await tool.handler((params.arguments as Record<string, unknown>) ?? {}, { origin, reader })
    return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: structured, isError: false })
  } catch (err) {
    if (isToolInputError(err)) {
      return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true })
    }
    // Internal failures can carry file paths or upstream responses; never echo them publicly.
    console.error(`[mcp] tool ${name} failed`, err)
    return rpcResult(id, { content: [{ type: 'text', text: `The ${name} tool failed unexpectedly. Try again later.` }], isError: true })
  }
}

async function handleRequest(id: unknown, method: string, params: Record<string, unknown>, scope: RequestScope) {
  const { siteName, origin, reader } = scope
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: agentServerName(siteName), title: `${siteName} documentation`, version: '2.0.0' },
        instructions: INSTRUCTIONS,
      })
    }

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list':
      return rpcResult(id, {
        tools: siteTools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        })),
      })

    case 'tools/call':
      return callTool(id, params, scope)

    case 'resources/list':
      return rpcResult(id, await listResources(params.cursor, reader))

    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates })

    case 'resources/read': {
      const contents = await readResource(params.uri, origin, reader)
      if (!contents) return rpcError(id, -32002, 'Resource not found', { uri: params.uri })
      return rpcResult(id, { contents: [contents] })
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

/**
 * Handle one JSON-RPC message. Returns null for notifications (no `id`) and
 * for client responses, which this stateless server never solicits.
 */
async function handleMessage(msg: unknown, scope: RequestScope): Promise<object | null> {
  if (!isRecord(msg)) return rpcError(null, -32600, 'Invalid Request')
  const { id, method, params } = msg as JsonRpcMessage
  const isNotification = !('id' in msg)
  if (typeof method !== 'string') {
    // A response object (result/error, no method) needs no reply.
    if ('result' in msg || 'error' in msg) return null
    return isNotification ? null : rpcError(id, -32600, 'Invalid Request')
  }
  if (isNotification) return null
  if (params !== undefined && !isRecord(params)) return rpcError(id, -32602, 'Invalid params')
  try {
    return await handleRequest(id, method, (params as Record<string, unknown>) ?? {}, scope)
  } catch (err) {
    const code = rpcErrorCode(err)
    if (code !== undefined && err instanceof Error) return rpcError(id, code, err.message)
    console.error(`[mcp] ${method} failed`, err)
    return rpcError(id, -32603, 'Internal error')
  }
}

export async function POST(request: NextRequest) {
  // Credentialed browser tools use this fixed read-only boundary. Reject a
  // foreign browser origin before reader cookies can widen its content view.
  const requestOrigin = request.headers.get('origin')
  if (requestOrigin && requestOrigin !== request.nextUrl.origin) {
    return errorResponse(403, -32000, 'Origin is not allowed.')
  }
  // Admins can disable the public MCP endpoint from the dashboard.
  if ((await getAdminSettings()).mcpEnabled === false) {
    return errorResponse(404, -32601, 'MCP endpoint is disabled.')
  }

  let body: unknown
  try {
    body = await readBoundedJson(request, MAX_BODY_BYTES)
  } catch (err) {
    if (err instanceof Error && err.message === BODY_TOO_LARGE_ERROR) {
      return errorResponse(413, -32600, 'Request body too large.')
    }
    return errorResponse(400, -32700, 'Parse error')
  }

  const isBatch = Array.isArray(body)
  const messages: Array<unknown> = isBatch ? (body as Array<unknown>) : [body]
  if (messages.length === 0) return errorResponse(400, -32600, 'Invalid Request: empty batch.')
  if (messages.length > MAX_BATCH) return errorResponse(400, -32600, `Invalid Request: batches are limited to ${MAX_BATCH} messages.`)

  const methods = messages.map((msg) => (isRecord(msg) && typeof msg.method === 'string' ? msg.method : null))
  const isInitialize = methods.includes('initialize')

  // After initialization the client echoes the negotiated version; reject one
  // this server never offered, as the streamable-HTTP transport requires.
  const protocolHeader = request.headers.get('mcp-protocol-version')
  if (!isInitialize && protocolHeader !== null && !SUPPORTED_PROTOCOLS.includes(protocolHeader)) {
    return errorResponse(
      400,
      -32000,
      `Bad Request: Unsupported protocol version: ${protocolHeader} (supported versions: ${SUPPORTED_PROTOCOLS.join(', ')})`,
    )
  }

  // Rate-limit the expensive methods per client — counting EVERY metered call
  // in a batch, or one batched array would bypass the ceiling. The client key
  // cannot be spoofed with a forged leftmost X-Forwarded-For (see
  // `public-rate-limit`). Fails open: a storage hiccup must not take docs down.
  const meteredCount = methods.filter((method) => method !== null && METERED_METHODS.has(method)).length
  if (meteredCount > 0) {
    const { allowed } = await consumePublicQuota({
      bucket: 'mcp_rate',
      headers: request.headers,
      amount: meteredCount,
      limitPerMinute: RATE_PER_MIN,
      failOpen: true,
    })
    if (!allowed) {
      const id = !isBatch && isRecord(body) ? body.id : null
      return Response.json(rpcError(id, -32000, 'Rate limit exceeded. Please slow down.'), {
        status: 429,
        headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
      })
    }
  }

  // Issue a session id on initialize; echo any the client already holds.
  // Purely informational: no server state is keyed by it.
  // Only a well-formed id (visible ASCII, bounded) is reflected back.
  const incomingSession = request.headers.get('mcp-session-id')
  const echoedSession = incomingSession && /^[\x21-\x7e]{1,128}$/.test(incomingSession) ? incomingSession : null
  const sessionId = echoedSession ?? (isInitialize ? randomUUID() : null)
  const headers = sessionId ? { 'mcp-session-id': sessionId } : undefined

  const origin = request.nextUrl.origin
  const effectiveSite = await resolveSiteConfig(origin)
  // Anonymous unless reader auth is active and a valid token/session is presented.
  const reader = await getReaderContextFromRequest(request)
  const scope: RequestScope = { siteName: effectiveSite.name, origin, reader }
  const responses: Array<object> = []
  for (const msg of messages) {
    const res = await handleMessage(msg, scope)
    if (res) responses.push(res)
  }

  // Only notifications/responses (e.g. notifications/initialized) → 202, no body.
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers })
  }

  return Response.json(isBatch ? responses : responses[0], { headers })
}

export async function GET(request: NextRequest) {
  // Streamable-HTTP GET opens a server→client SSE stream; this stateless server
  // never pushes, so it's POST-only.
  const effectiveSite = await resolveSiteConfig(request.nextUrl.origin)
  return new Response(`${effectiveSite.name} MCP endpoint — POST JSON-RPC 2.0 (streamable HTTP).`, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}
