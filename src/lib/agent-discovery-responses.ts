/**
 * Tenant-specific discovery response builders shared by routes and tests.
 * Metadata describes the effective read model without advertising OAuth support.
 */

import { agentServerName } from '@/lib/agent-identity'
import { DOCS_ACCESS_COOKIE } from '@/lib/admin/auth-edge'
import { toolMetadata } from '@/lib/mcp/tool-metadata'
import type { DocumentationAccessMode } from '@/lib/openapi/documentation-access'
import type { SiteIdentity } from '@/lib/site-config'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  })
}

/** Describe the site MCP endpoint and the actual reader credential model. */
export function mcpServerCard(
  origin: string,
  identity: SiteIdentity,
  accessMode: DocumentationAccessMode = 'public',
): Response {
  const isPasswordProtected = accessMode === 'password'
  return json({
    name: agentServerName(identity.name),
    title: `${identity.name} documentation MCP server`,
    description:
      `Read-only MCP server exposing the ${identity.name} documentation site: full-text search, page reads as Markdown, a page index, and an agent-readiness report.`,
    version: '1.0.0',
    protocolVersion: '2025-06-18',
    url: `${origin}/api/mcp`,
    endpoint: `${origin}/api/mcp`,
    transport: ['streamable-http'],
    authentication: isPasswordProtected
      ? {
          type: 'cookie',
          in: 'cookie',
          name: DOCS_ACCESS_COOKIE,
          documentation: `${origin}/auth.md`,
        }
      : { type: 'none' },
    capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
    tools: toolMetadata.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
    documentation: `${origin}/auth.md`,
  })
}

/** Publish RFC 9728 metadata without implying a bearer-token exchange. */
export function oauthProtectedResource(
  origin: string,
  identity: SiteIdentity,
  accessMode: DocumentationAccessMode = 'public',
): Response {
  const isPasswordProtected = accessMode === 'password'
  // RFC 9728 metadata never advertises an authorization server or OAuth
  // scopes because neither access mode supports bearer tokens. The namespaced
  // extension makes the real non-OAuth cookie gate machine-discoverable.
  return json({
    resource: origin,
    resource_name: `${identity.name} documentation`,
    // RFC 9728 explicitly permits [] to declare that bearer tokens are not
    // accepted, while `authorization_servers` must be omitted when empty.
    bearer_methods_supported: [],
    resource_documentation: `${origin}/auth.md`,
    ...(isPasswordProtected
      ? {
          x_thally_access: {
            mode: 'password',
            credential: 'cookie',
            cookie_name: DOCS_ACCESS_COOKIE,
            authentication_endpoint: `${origin}/api/access/auth`,
            interactive_login: `${origin}/access`,
          },
        }
      : {}),
  })
}
