/**
 * Publish inert WebMCP discovery metadata in the initial server-rendered head.
 * This is a Thally extension, not a browser registration API. The browser still
 * registers callbacks through document.modelContext after JavaScript runs.
 */
import { toolMetadata } from '@/lib/mcp/tool-metadata'
import { webMcpToolMetadata } from '@/lib/mcp/web-mcp-metadata'

/** Describe the same tools as the native adapter without importing its handlers. */
export function WebMcpDiscovery() {
  const discovery = {
    format: 'thally-webmcp-discovery',
    schemaVersion: 1,
    description: 'Discovery metadata only. This block does not register or execute tools. Tool access follows the site reader permissions.',
    browser: {
      api: 'document.modelContext',
      requiresJavaScript: true,
      requiresSupportedBrowser: true,
    },
    mcp: {
      endpoint: '/api/mcp',
      serverCard: '/.well-known/mcp.json',
      transport: 'streamable-http',
      // Only these tools can be called over HTTP. Current-page context and
      // navigation need the live browser session even though all ten are listed.
      tools: toolMetadata.map((tool) => tool.name),
    },
    tools: webMcpToolMetadata,
  }

  // Inert script bodies still use the HTML raw-text parser. Escape '<' so a
  // future metadata description containing </script> cannot close this block.
  const json = JSON.stringify(discovery).replaceAll('<', '\\u003c')

  return (
    <>
      <link rel="service-desc" type="application/json" href="/.well-known/mcp.json" title="MCP tool discovery" />
      <script id="thally-webmcp-discovery" type="application/webmcp+json" dangerouslySetInnerHTML={{ __html: json }} />
    </>
  )
}
