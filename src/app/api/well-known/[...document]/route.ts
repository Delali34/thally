import { type NextRequest } from 'next/server'
import { toolMetadata } from '@/lib/mcp/tool-metadata'
import { resolveSiteConfig, type SiteIdentity } from '@/lib/site-config'
import { agentIdentitySlug } from '@/lib/agent-identity'
import { mcpServerCard, oauthProtectedResource } from '@/lib/agent-discovery-responses'
import { problemResponse } from '@/lib/http/problem'
import { DOCS_ACCESS_COOKIE } from '@/lib/admin/auth-edge'
import {
  resolveDocumentationAccessMode,
  type DocumentationAccessMode,
} from '@/lib/openapi/documentation-access'

/**
 * Agent-discovery documents served under `/.well-known/*` (and `/auth.md`),
 * mapped here via rewrites in next.config.ts so every deployment emits
 * absolute URLs for its own origin — no per-site configuration needed.
 *
 * Everything published here describes capability the site actually has:
 * the MCP server at /api/mcp, the search API, Markdown content negotiation,
 * and the effective public or password-protected read model. Standards covered:
 *  - RFC 9727 api-catalog (linkset)
 *  - MCP Server Card (/.well-known/mcp.json, /.well-known/mcp/server-card.json)
 *  - Agent Skills discovery (/.well-known/agent-skills/*)
 *  - RFC 9728 OAuth Protected Resource Metadata
 *  - auth.md (agent-readable auth documentation)
 *
 * Deliberately imports the dependency-free `tool-metadata` (not `site-tools`),
 * so these discovery documents don't drag the search engine + MDX/remark
 * toolchain into their cold-start bundle. No `export const runtime` is needed:
 * nothing here requires the Node runtime (Next defaults to nodejs anyway).
 */

const JSON_TYPE = 'application/json; charset=utf-8'
const LINKSET_TYPE = 'application/linkset+json; charset=utf-8'
const MARKDOWN_TYPE = 'text/markdown; charset=utf-8'

function json(body: unknown, contentType: string = JSON_TYPE): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': contentType, 'cache-control': 'public, max-age=300' },
  })
}

function markdown(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': MARKDOWN_TYPE, 'cache-control': 'public, max-age=300' },
  })
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function apiCatalog(origin: string): Response {
  return json(
    {
      linkset: [
        {
          anchor: `${origin}/`,
          'service-desc': [
            { href: `${origin}/openapi.yaml`, type: 'application/yaml', title: 'OpenAPI description' },
          ],
          'service-doc': [
            { href: `${origin}/`, type: 'text/html', title: 'Documentation site' },
            { href: `${origin}/llms.txt`, type: 'text/markdown', title: 'llms.txt index for agents' },
          ],
          'service-meta': [
            { href: `${origin}/auth.md`, type: 'text/markdown', title: 'Authentication guide for agents' },
          ],
          item: [
            { href: `${origin}/api/mcp`, title: 'MCP server (streamable HTTP)' },
            { href: `${origin}/api/search`, title: 'Documentation search API' },
            { href: `${origin}/api/docs-index`, title: 'Machine-readable page index' },
          ],
        },
      ],
    },
    LINKSET_TYPE,
  )
}

function oauthAuthorizationServerUnavailable(
  request: NextRequest,
  accessMode: DocumentationAccessMode,
): Response {
  const isPasswordProtected = accessMode === 'password'
  return problemResponse({
    status: 404,
    code: 'oauth_not_supported',
    title: 'OAuth authorization server not available',
    detail: isPasswordProtected
      ? 'This password-protected documentation site uses a signed docs-access session cookie and is not an OAuth authorization server.'
      : 'This documentation site exposes a public anonymous read surface and is not an OAuth authorization server.',
    resolution: isPasswordProtected
      ? 'Authenticate at `/access` or submit the site password to `POST /api/access/auth`, then retry with the issued docs-access cookie. Read `/auth.md` for the complete non-OAuth flow.'
      : 'Use the endpoints without credentials and read `/auth.md` for the supported access model.',
    instance: request.nextUrl.pathname,
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}

function authMd(
  origin: string,
  identity: SiteIdentity,
  accessMode: DocumentationAccessMode,
): Response {
  const host = new URL(origin).host
  const localMcpName = agentIdentitySlug(identity.name)
  if (accessMode === 'password') {
    return markdown(`# auth.md

You are an agent. This document tells you how to access **${host}** — a
password-protected documentation service. This site does not support OAuth,
OpenID Connect, bearer tokens, API keys, dynamic client registration, or
permission scopes for documentation readers.

Supported credential type: **signed docs-access session cookie**. Obtain it
with the site password, retain the \`Set-Cookie\` response in a cookie jar, and
send it on protected documentation API and MCP requests. Never place the site
password in a URL, log, prompt transcript, or committed file.

## Step 1 — Create a docs-access session

\`\`\`http
POST /api/access/auth HTTP/1.1
Host: ${host}
Content-Type: application/json

{"password":"<site-password>"}
\`\`\`

A successful response sets the HTTP-only \`${DOCS_ACCESS_COOKIE}\` cookie.
Human readers can complete the same flow at [${origin}/access](${origin}/access).

## Step 2 — Use the protected API

\`\`\`http
GET /api/search?q=example HTTP/1.1
Host: ${host}
Cookie: ${DOCS_ACCESS_COOKIE}=<session-value>
User-Agent: your-agent/1.0
\`\`\`

The cookie is required for documentation pages, search, the page index, page
reads, and the MCP server. Non-content discovery documents such as \`/ai.txt\`,
\`/skill.md\`, \`/.well-known/oauth-protected-resource\`, and this guide remain
reachable without the cookie so clients can discover the access model.

## Step 3 — Attach over MCP (optional)

Configure your MCP client to retain and send the same docs-access cookie when
connecting to \`${origin}/api/mcp\`. The server is read-only; authentication
does not grant write or operator permissions.

## OAuth status

OAuth is **not supported**. There is no authorization server, token endpoint,
client registration endpoint, bearer token, or OAuth scope to request. Do not
send an \`Authorization: Bearer\` header.

## Errors

- \`401 docs_access_required\` — the cookie is missing, invalid, or expired.
  Create a new session and retry.
- \`401\` from \`POST /api/access/auth\` — the supplied site password is invalid.
- \`429\` — back off and retry after the rate-limit window.
- \`403\` on \`/admin\` or \`/api/admin/*\` — operator access is separate and the
  docs-access cookie does not authorize it.
`)
  }

  return markdown(`# auth.md

You are an agent. This document tells you how to access **${host}** — a
public documentation service. This is the **anonymous** flow: every agent
surface works without registering, provisioning a credential, or claiming
anything. There is no agent-verified or email-verified registration today.

Supported credential types: **none — access is anonymous.** There is no
\`api_key\` issuance, no \`client_id\`/\`client_secret\`, no
\`registration_endpoint\` (OAuth 2.0 Dynamic Client Registration, RFC 7591,
is not offered), and no claim ceremony — there is nothing to claim.

## Step 1 — Discover the surface

| Surface | Auth |
| --- | --- |
| Documentation pages (HTML or Markdown via \`Accept: text/markdown\`) | None |
| \`${origin}/llms.txt\` and \`${origin}/llms-full.txt\` | None |
| Search API — \`GET ${origin}/api/search?q=<query>\` | None |
| Page index — \`GET ${origin}/api/docs-index\` | None |
| MCP server — \`${origin}/api/mcp\` (streamable HTTP) | None |

## Step 2 — Use the API (anonymous, no credential)

\`\`\`
GET /api/search?q=example HTTP/1.1
Host: ${host}
User-Agent: your-agent/1.0
\`\`\`

Do not send an \`Authorization: Bearer\` header — requests carry no
credential, and none will ever be required for the read surface. Identify
honestly via \`User-Agent\` so rate limiting can be fair.

## Step 3 — Attach over MCP (optional)

\`\`\`
claude mcp add --transport http ${localMcpName} ${origin}/api/mcp
\`\`\`

The MCP server accepts anonymous \`initialize\` and \`tools/call\` requests.

## Errors

- \`429\` — per-IP rate limit on MCP tool calls. Back off and retry; the
  limit resets within a minute.
- \`401\`/\`403\` — you have reached an operator-only surface (\`/admin\`,
  \`/api/admin/*\`). These are session-authenticated for human operators,
  disallowed in robots.txt, and have no agent credential exchange. Do not
  retry with credentials; none exist for agents.
`)
}

// ---------------------------------------------------------------------------
// Agent Skills (https://agentskills.io discovery draft)
// ---------------------------------------------------------------------------

interface SkillDoc {
  name: string
  description: string
  body: (origin: string, accessMode: DocumentationAccessMode) => string
}

const SKILLS: Record<string, SkillDoc> = {
  'search-docs': {
    name: 'search-docs',
    description: 'Search this documentation site and retrieve ranked, cited results.',
    body: (origin, accessMode) => `---
name: search-docs
description: Search this documentation site and retrieve ranked, cited results.
---

# Searching this documentation site

Query the search API directly:

\`\`\`
GET ${origin}/api/search?q=<query>&limit=8
\`\`\`

Returns JSON hits with \`title\`, \`url\`, and a matching snippet, ranked by
relevance. ${accessMode === 'password' ? `Authenticate first as described in ${origin}/auth.md and send the issued \`${DOCS_ACCESS_COOKIE}\` cookie.` : 'No authentication is required.'} Prefer this over crawling pages.
`,
  },
  'read-page-markdown': {
    name: 'read-page-markdown',
    description: 'Fetch any documentation page as clean Markdown instead of HTML.',
    body: (origin, accessMode) => `---
name: read-page-markdown
description: Fetch any documentation page as clean Markdown instead of HTML.
---

# Reading pages as Markdown

Every documentation page supports content negotiation. Request the page URL
with \`Accept: text/markdown\` to receive the page as Markdown:

\`\`\`
curl -H "Accept: text/markdown" ${origin}/<page-path>
\`\`\`

The full page index lives at \`${origin}/llms.txt\`; the entire corpus in one
file at \`${origin}/llms-full.txt\`.
${accessMode === 'password' ? `Protected page reads require the docs-access cookie described in ${origin}/auth.md.` : ''}
`,
  },
  'connect-mcp': {
    name: 'connect-mcp',
    description: 'Attach an MCP client to this site and use its docs as native tools.',
    body: (origin, accessMode) => `---
name: connect-mcp
description: Attach an MCP client to this site and use its docs as native tools.
---

# Connecting over MCP

This site runs a read-only MCP server (streamable HTTP${accessMode === 'password' ? ', docs-access cookie required' : ', no auth'}):

\`\`\`
claude mcp add --transport http docs ${origin}/api/mcp
\`\`\`

Available tools: ${toolMetadata.map((tool) => `\`${tool.name}\``).join(', ')}.
${accessMode === 'password' ? `Authenticate first as described in ${origin}/auth.md and configure the client to retain the issued cookie.` : ''}
`,
  },
}

function agentSkillsIndex(origin: string): Response {
  return json({
    version: '0.2.0',
    skills: Object.values(SKILLS).map((skill) => ({
      name: skill.name,
      description: skill.description,
      url: `${origin}/.well-known/agent-skills/${skill.name}.md`,
    })),
  })
}

function agentSkillFile(
  origin: string,
  file: string | null,
  accessMode: DocumentationAccessMode,
): Response {
  const name = (file ?? '').replace(/\.md$/, '')
  const skill = SKILLS[name]
  if (!skill) {
    return new Response('Skill not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
  return markdown(skill.body(origin, accessMode))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ document: Array<string> }> },
): Promise<Response> {
  const { document } = await params
  const [name, arg] = document
  const origin = request.nextUrl.origin
  const accessMode = await resolveDocumentationAccessMode(origin)
  if (name === 'oauth-authorization-server') {
    return oauthAuthorizationServerUnavailable(request, accessMode)
  }
  const identity = await resolveSiteConfig(origin)

  switch (name) {
    case 'api-catalog':
      return apiCatalog(origin)
    case 'mcp-server-card':
      return mcpServerCard(origin, identity, accessMode)
    case 'oauth-protected-resource':
      return oauthProtectedResource(origin, identity, accessMode)
    case 'auth-md':
      return authMd(origin, identity, accessMode)
    case 'agent-skills-index':
      return agentSkillsIndex(origin)
    case 'agent-skills-file':
      return agentSkillFile(origin, arg ?? null, accessMode)
    default:
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
}
