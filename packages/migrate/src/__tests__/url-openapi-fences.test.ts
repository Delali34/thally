/** Publisher operation fences remain portable data, never source files or code. */

import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'

import { findSpecForRef, parseOpenApiFrontmatter } from '../../../../src/lib/openapi/page-frontmatter'
import { extractEmbeddedOpenApi, mergeEmbeddedOpenApi } from '../url.js'

const schema = `openapi: 3.0.2
info:
  title: LI.FI API
  version: 1.0.0
servers:
  - url: https://li.quest
security:
  - apiKey: []
paths:
  /v1/chains/{chainId}:
    parameters:
      - name: chainId
        in: path
        required: true
        schema:
          type: integer
    get:
      operationId: getChain
      responses:
        '200':
          description: Chain information
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Chain'
components:
  schemas:
    Chain:
      type: object
      properties:
        name:
          type: string
  securitySchemes:
    apiKey:
      type: apiKey
      in: header
      name: x-lifi-api-key
`

function publisherFence(metadata: string, document = schema): string {
  return `## OpenAPI\n\n\`\`\`\`yaml ${metadata}\n${document}\`\`\`\`\n`
}

describe('publisher OpenAPI metadata', () => {
  it.each(['get /v1/chains/{chainId}', '/openapi.yaml GET /v1/chains/{chainId}'])('extracts a declared operation with metadata %s', (metadata) => {
    const body = `Authored introduction.\n\n${publisherFence(metadata)}\nAuthored conclusion.`
    const result = extractEmbeddedOpenApi(body)
    expect(result.content).toBe('Authored introduction.\n\n\n\nAuthored conclusion.')
    expect(result.openapi).toBe('GET /v1/chains/{chainId}')
    expect(result.fragment).toMatchObject({ method: 'GET', path: '/v1/chains/{chainId}', document: { components: { schemas: { Chain: { properties: { name: { type: 'string' } } } } } } })
    const projected = parseYaml(new TextDecoder().decode(mergeEmbeddedOpenApi([result.fragment!])!))
    expect(projected.paths['/v1/chains/{chainId}'].parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'chainId', in: 'path', required: true })]))
    expect(projected.paths['/v1/chains/{chainId}'].get).toMatchObject({ operationId: 'getChain', servers: [{ url: 'https://li.quest' }], security: [{ apiKey: [] }] })
    expect(projected.components.schemas.Chain.properties.name.type).toBe('string')
    expect(projected.paths['/v1/chains/{chainId}'].get.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/Chain')
  })

  it('treats publisher filenames as inert hints and uses caller-chosen local file bindings', () => {
    const result = extractEmbeddedOpenApi(publisherFence('../../outside.yaml get /v1/chains/{chainId}'))
    expect(result.fragment?.path).toBe('/v1/chains/{chainId}')
    expect(JSON.stringify(result.fragment)).not.toContain('../../outside.yaml')
    const source = 'openapi/migration-1234.json'
    const reference = parseOpenApiFrontmatter(`${source} GET /v1/chains/{chainId}`)!
    expect(reference).toMatchObject({ specRef: source, method: 'GET', path: '/v1/chains/{chainId}' })
    expect(findSpecForRef([{ id: 'operation-1234', label: 'API', source: { type: 'file', path: source }, pageOnly: true }], reference.specRef!)?.id).toBe('operation-1234')
    expect(findSpecForRef([], reference.specRef!)).toBeNull()
  })

  it('ignores quoted/nested/example fences and rejects ambiguous declared operations', () => {
    const fence = publisherFence('get /v1/chains/{chainId}')
    const literalExample = `\`\`\`\`\`markdown\n${fence}\`\`\`\`\`\n`
    expect(extractEmbeddedOpenApi(literalExample)).toEqual({ content: literalExample })
    const quotedExample = fence.split('\n').map((line) => `> ${line}`).join('\n')
    expect(extractEmbeddedOpenApi(quotedExample)).toEqual({ content: quotedExample })
    const ambiguous = `${fence}\n${fence}`
    expect(extractEmbeddedOpenApi(ambiguous)).toEqual({ content: ambiguous })
  })

  it.each([
    ['mismatched method', publisherFence('post /v1/chains/{chainId}')],
    ['mismatched path', publisherFence('get /v1/other')],
    ['ambiguous metadata', publisherFence('get /v1/chains/{chainId} extra')],
    ['operation array', publisherFence('get /v1/chains/{chainId}', schema.replace('    get:\n      operationId: getChain', '    get: []\n    other:\n      operationId: getChain'))],
    ['operation null', publisherFence('get /v1/chains/{chainId}', 'openapi: 3.0.2\npaths:\n  /v1/chains/{chainId}:\n    get: null\n')],
    ['duplicate mapping key', publisherFence('get /v1/chains/{chainId}', `${schema}\npaths: {}\n`)],
    ['cyclic alias', publisherFence('get /v1/chains/{chainId}', `${schema}\ncycle: &cycle\n  self: *cycle\n`)],
    ['unclosed fence', publisherFence('get /v1/chains/{chainId}').replace(/````\n$/, '')],
    ['oversized payload', `${'a'.repeat(2_000_001)}\n${publisherFence('get /v1/chains/{chainId}')}`],
  ])('leaves %s for explicit review', (_name, body) => {
    expect(extractEmbeddedOpenApi(body)).toEqual({ content: body })
  })

  it('bounds YAML alias amplification and never interprets JavaScript prose', () => {
    const aliases = 'a: &a [one, two, three, four]\nb: &b [*a, *a, *a, *a]\nc: &c [*b, *b, *b, *b]\nd: [*c, *c, *c, *c]\n'
    const body = publisherFence('get /v1/chains/{chainId}', `${schema}\n${aliases}`)
    expect(extractEmbeddedOpenApi(body)).toEqual({ content: body })
    const prose = 'import malicious from "never-import-this"\n\n{globalThis.process.exit()}\n\n'
    const result = extractEmbeddedOpenApi(`${prose}${publisherFence('get /v1/chains/{chainId}')}`)
    expect(result.fragment?.method).toBe('GET')
    expect(result.content).toContain('import malicious')
    expect(result.content).toContain('{globalThis.process.exit()}')
  })
})
