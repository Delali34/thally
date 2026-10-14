/** Verify no-JavaScript discovery, registry parity and safe inline JSON output. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { toolMetadata } from '@/lib/mcp/tool-metadata'
import { webMcpToolMetadata } from '@/lib/mcp/web-mcp-metadata'
import { WebMcpDiscovery } from './web-mcp-discovery'

function renderDiscovery() {
  const html = renderToStaticMarkup(createElement(WebMcpDiscovery))
  const json = html.match(/<script[^>]*type="application\/webmcp\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1]
  expect(json).toBeDefined()
  return { html, json: json!, manifest: JSON.parse(json!) }
}

describe('server-rendered WebMCP discovery', () => {
  it('publishes canonical native metadata without a browser or hydration', () => {
    const { html, manifest } = renderDiscovery()
    expect(manifest.tools).toEqual(webMcpToolMetadata)
    expect(manifest.tools).toHaveLength(10)
    expect(manifest.format).toBe('thally-webmcp-discovery')
    expect(manifest.schemaVersion).toBe(1)
    expect(html).toContain('rel="service-desc"')
    expect(html).toContain('href="/.well-known/mcp.json"')
  })

  it('separates HTTP-callable tools from capabilities that require a live browser', () => {
    const { manifest } = renderDiscovery()
    expect(manifest.browser).toEqual({ api: 'document.modelContext', requiresJavaScript: true, requiresSupportedBrowser: true })
    expect(manifest.mcp).toEqual({
      endpoint: '/api/mcp', serverCard: '/.well-known/mcp.json', transport: 'streamable-http',
      tools: toolMetadata.map((tool) => tool.name),
    })
    expect(manifest.mcp.tools).not.toContain('get_current_page')
    expect(manifest.mcp.tools).not.toContain('navigate_to_page')
    expect(manifest.description).toContain('does not register or execute')
  })

  it('preserves hostile descriptions as JSON data without terminating the script', () => {
    const metadata = webMcpToolMetadata[0]
    const original = metadata.description
    const hostile = '</script><script>alert("metadata")</script> & <tag>\u2028\u2029'
    try {
      metadata.description = hostile
      const { html, json, manifest } = renderDiscovery()
      expect(manifest.tools[0].description).toBe(hostile)
      expect(json).not.toContain('<')
      expect(html.match(/<script\b/g)).toHaveLength(1)
      expect(html.match(/<\/script>/g)).toHaveLength(1)
    } finally {
      metadata.description = original
    }
  })
})
