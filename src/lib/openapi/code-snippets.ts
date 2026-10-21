/** Handoff display labels and parameter metadata layered over the canonical OpenAPI sample generators. */
import type { PreparedRequest } from '@/components/api/use-try-it-controller'
import { buildCodeSamples, type CodeSample } from '@/lib/openapi/code-samples'
import { buildSchemaExample } from '@/lib/openapi/schema-example'
import { formatExample } from '@/lib/openapi/response-examples'

export const DOCS_LANGUAGES = ['cURL', 'Node.js', 'Python', 'Go', 'Ruby', 'PHP'] as const
export type DocsLanguage = typeof DOCS_LANGUAGES[number]

/** Normalize fence aliases without changing arbitrary authored group labels. */
export function normalizeDocsLanguage(language: string): string {
  const aliases: Record<string, string> = { curl: 'cURL', bash: 'cURL', sh: 'cURL', shell: 'cURL', javascript: 'Node.js', js: 'Node.js', 'node.js': 'Node.js', node: 'Node.js', python: 'Python', py: 'Python', go: 'Go', ruby: 'Ruby', rb: 'Ruby', php: 'PHP' }
  return aliases[language.toLowerCase()] ?? language
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const literalQuote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** Preserve canonical multipart, authored sample, quoting, and placeholder behavior. */
export function buildRequestSnippet(request: PreparedRequest, language: string, authored: CodeSample[] = []): string {
  const samples = buildCodeSamples(request, authored)
  const sample = samples.find((candidate) => normalizeDocsLanguage(candidate.label) === normalizeDocsLanguage(language)) ?? samples[0]
  return sample?.source ?? 'Configure a server URL to preview this request.'
}

/** Render only documented examples; absence of an example is stated explicitly. */
export function formatResponseExample(value: unknown): string {
  return value === undefined ? 'No response example is documented.' : formatExample(value)
}

/** Reuse the normalized schema's canonical example/default/union semantics. */
export function buildSchemaResponseExample(schema?: Record<string, unknown>): unknown {
  return buildSchemaExample(schema, () => null, new Set<string>(), true)
}

interface RequestSnippetField {
  name: string
  group: 'path' | 'query' | 'header' | 'body'
}

/**
 * Associate resolved URL source with the operation's actual path/query fields.
 * Indices are zero-based source lines. The exact emitter-quoted URL locates the
 * line; an opaque /123 path is never interpreted to guess a parameter name.
 */
export function requestSnippetLineParameters(code: string, request: Pick<PreparedRequest, 'url'>, fields: readonly RequestSnippetField[]): Record<number, string[]> {
  if (!request.url) return {}
  const serializedUrls = [...new Set([JSON.stringify(request.url), shellQuote(request.url), literalQuote(request.url), JSON.stringify(request.url).replace(/#(?=[{$@])/g, '\\#')])]
  const index = code.split('\n').findIndex((line) => serializedUrls.some((value) => line.includes(value)))
  if (index < 0) return {}
  let searchParams: URLSearchParams | undefined
  try { searchParams = new URL(request.url).searchParams } catch { /* Invalid URLs have no trustworthy query projection. */ }
  const parameters = [...new Set(fields.filter((field) => field.group === 'path' || (field.group === 'query' && searchParams?.has(field.name))).map((field) => field.name))]
  return parameters.length ? { [index]: parameters } : {}
}
