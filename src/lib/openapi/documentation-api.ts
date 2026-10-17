/**
 * OpenAPI description for the read-only APIs built into every Thally site.
 *
 * Customer API specifications remain authoritative when configured. This
 * document is the truthful fallback for sites that expose Thally's built-in
 * documentation, search, and readiness endpoints. Password-protected sites
 * advertise the same cookie gate enforced by middleware.
 */

import type { OpenAPIDocument } from '@/lib/openapi/types'
import { DOCS_ACCESS_COOKIE } from '@/lib/admin/auth-edge'

const PROBLEM_RESPONSE = {
  description: 'A machine-actionable error response.',
  content: {
    'application/problem+json': {
      schema: { $ref: '#/components/schemas/Problem' },
    },
  },
}

const DOCUMENTATION_NOT_FOUND_RESPONSE = {
  description:
    'The page identifier is not published. The representation follows the requested or default response format.',
  content: {
    'application/problem+json': {
      schema: { $ref: '#/components/schemas/Problem' },
    },
    'text/markdown': {
      schema: { type: 'string' },
    },
  },
}

const ACCESS_REQUIRED_RESPONSE = {
  description: 'The documentation site requires a valid docs-access session cookie.',
  content: {
    'application/problem+json': {
      schema: { $ref: '#/components/schemas/Problem' },
    },
  },
}

export interface DocumentationApiOpenApiOptions {
  accessMode?: 'public' | 'password'
  accessCookieName?: string
}

/** Build a request-origin-bound OpenAPI 3.1 description for site APIs. */
export function buildDocumentationApiOpenApi(
  origin: string,
  siteName = 'Thally',
  {
    accessMode = 'public',
    accessCookieName = DOCS_ACCESS_COOKIE,
  }: DocumentationApiOpenApiOptions = {},
): OpenAPIDocument {
  const serverOrigin = new URL(origin).origin
  const displayName = siteName.trim() || 'Thally'
  const isPasswordProtected = accessMode === 'password'
  const security = isPasswordProtected ? [{ docsAccess: [] }] : []
  const accessResponses = isPasswordProtected
    ? { '401': ACCESS_REQUIRED_RESPONSE }
    : {}

  return {
    openapi: '3.1.1',
    info: {
      title: `${displayName} documentation API`,
      version: '1.0.0',
      description: isPasswordProtected
        ? 'Read-only access to this password-protected documentation site. Authenticate through `/access` or `POST /api/access/auth`, then send the issued docs-access cookie with each operation.'
        : 'Read-only access to this documentation site. Every operation is public and anonymous; no OAuth server, bearer token, API key, or permission scope is required.',
    },
    externalDocs: {
      description: isPasswordProtected
        ? 'Interactive documentation access'
        : 'Authentication and access model',
      url: isPasswordProtected
        ? `${serverOrigin}/access`
        : `${serverOrigin}/auth.md`,
    },
    servers: [{ url: serverOrigin }],
    // An empty array means anonymous access; protected sites instead inherit
    // the real signed-cookie requirement enforced by middleware.
    security,
    tags: [
      { name: 'Discovery', description: 'Discover published pages and capabilities.' },
      { name: 'Content', description: 'Read and search the published documentation corpus.' },
      { name: 'Readiness', description: 'Inspect machine-readability health.' },
    ],
    paths: {
      '/api/docs-index': {
        get: {
          operationId: 'listDocumentationPages',
          summary: 'List published documentation pages',
          tags: ['Discovery'],
          responses: {
            '200': {
              description: 'The machine-readable documentation index.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DocumentIndex' },
                },
              },
            },
            ...accessResponses,
          },
        },
      },
      '/api/search': {
        get: {
          operationId: 'searchDocumentation',
          summary: 'Search the documentation corpus',
          tags: ['Content'],
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: true,
              description: 'The search query.',
              schema: { type: 'string', minLength: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Maximum number of results.',
              schema: { type: 'integer', minimum: 1, maximum: 25, default: 8 },
            },
            {
              name: 'mode',
              in: 'query',
              required: false,
              description: 'Search ranking mode. Asset-backed sites serve `fulltext` for hybrid requests with degradation reason `runtime_capacity`. Other sites support `hybrid` vector similarity, metered per client when using a hosted embedding provider; over the limit it degrades to `fulltext` with reason `rate_limited`.',
              schema: { type: 'string', enum: ['hybrid', 'fulltext'], default: 'fulltext' },
            },
          ],
          responses: {
            '200': {
              description: 'Ranked documentation results.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SearchResults' },
                },
              },
            },
            '400': PROBLEM_RESPONSE,
            ...accessResponses,
          },
        },
      },
      '/api/docs/{page_id}': {
        get: {
          operationId: 'readDocumentationPage',
          summary: 'Read one published documentation page',
          description:
            'Use a page identifier returned by `/api/docs-index`. Select JSON, JSON-LD, or Markdown with the `Accept` header or `format` query parameter.',
          tags: ['Content'],
          parameters: [
            {
              name: 'page_id',
              in: 'path',
              required: true,
              description:
                'Stable page identifier from the documentation index. Percent-encode `/` characters in nested identifiers as `%2F`.',
              schema: { type: 'string', minLength: 1 },
            },
            {
              name: 'format',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['json', 'ldjson', 'md'] },
            },
          ],
          responses: {
            '200': {
              description: 'The requested page projection.',
              content: {
                'application/json': { schema: { type: 'object' } },
                'application/ld+json': { schema: { type: 'object' } },
                'text/markdown': { schema: { type: 'string' } },
              },
            },
            '404': DOCUMENTATION_NOT_FOUND_RESPONSE,
            ...accessResponses,
          },
        },
      },
      '/api/agent-readiness': {
        get: {
          operationId: 'getAgentReadiness',
          summary: 'Inspect documentation readiness',
          tags: ['Readiness'],
          responses: {
            '200': {
              description: 'An explainable readiness report for the published corpus.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReadinessReport' },
                },
              },
            },
            ...accessResponses,
          },
        },
      },
    },
    components: {
      ...(isPasswordProtected
        ? {
            securitySchemes: {
              docsAccess: {
                type: 'apiKey',
                in: 'cookie',
                name: accessCookieName,
                description:
                  'Signed HTTP-only session cookie issued after a successful password submission to `POST /api/access/auth`. Browser users can authenticate at `/access`.',
              },
            },
          }
        : {}),
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'code', 'detail', 'resolution'],
          properties: {
            type: { type: 'string', format: 'uri-reference' },
            title: { type: 'string' },
            status: { type: 'integer', minimum: 400, maximum: 599 },
            code: { type: 'string' },
            detail: { type: 'string' },
            resolution: { type: 'string' },
            instance: { type: 'string', format: 'uri-reference' },
            error: { type: 'string', deprecated: true },
            message: { type: 'string', deprecated: true },
          },
        },
        DocumentIndex: {
          type: 'object',
          required: ['schema_version', 'total', 'discovery', 'pages'],
          properties: {
            schema_version: { type: 'string' },
            total: { type: 'integer', minimum: 0 },
            discovery: { type: 'object', additionalProperties: { type: 'string', format: 'uri' } },
            pages: { type: 'array', items: { type: 'object' } },
          },
        },
        SearchResults: {
          type: 'object',
          required: ['schema_version', 'query', 'mode', 'total', 'results'],
          properties: {
            schema_version: { type: 'string' },
            query: { type: 'string' },
            mode: { type: 'string', enum: ['hybrid', 'fulltext'] },
            mode_requested: { type: 'string', enum: ['hybrid'] },
            mode_degraded_reason: { type: 'string', enum: ['rate_limited', 'runtime_capacity'] },
            total: { type: 'integer', minimum: 0 },
            results: { type: 'array', items: { type: 'object' } },
          },
        },
        ReadinessReport: {
          type: 'object',
          required: ['schema_version', 'score', 'grade', 'subscores'],
          properties: {
            schema_version: { type: 'string' },
            score: { type: 'integer', minimum: 0, maximum: 100 },
            grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
            subscores: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  }
}
