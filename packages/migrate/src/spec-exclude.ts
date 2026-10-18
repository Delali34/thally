/** Fail-closed pruning of OpenAPI operations that only access-restricted pages document; shared by local and remote specs. */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { splitOpenApiRef } from './openapi-ref.js'

/**
 * Whether a frontmatter `openapi:` value ("GET /x", "specs/api.json GET /x")
 * names this spec. A bare operation resolves to the default spec; a prefixed
 * one to the spec whose path ends with the prefix, on a segment boundary.
 */
export function specRefMatches(ref: string, specPath: string, specFilename: string, isDefault: boolean): boolean {
  const prefix = /^(?:(\S+)\s+)?(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|WEBHOOK)\s/i.exec(`${ref} `)?.[1]
  if (!prefix) return isDefault
  const wanted = prefix.replace(/^\/+/, '').toLowerCase()
  // Whole path segments only: `pi/openapi.json` does not name `api/openapi.json`.
  const lowerPath = specPath.toLowerCase()
  return lowerPath === wanted || lowerPath.endsWith(`/${wanted}`) || specFilename.toLowerCase() === wanted
}

/** `GET /x` / `webhook name` normalised so two spellings of one operation compare equal. */
function operationKey(operation: string): string {
  const [first, ...rest] = operation.trim().split(/\s+/)
  return `${first.toLowerCase()} ${rest.join(' ')}`
}

/** Operation keys of the refs that name this spec. */
function keysFor(spec: { sourcePath: string; filename: string }, refs: ReadonlyArray<string>): Array<string> {
  return [...new Set(
    refs.filter((ref) => specRefMatches(ref, spec.sourcePath, spec.filename, true))
      .map((ref) => splitOpenApiRef(ref)?.operation).filter((op): op is string => !!op).map(operationKey),
  )]
}

/** Operations only withheld refs name (`withheld`) and those a kept ref names (`kept`), for one spec. */
export function withheldOperationKeys(
  spec: { sourcePath: string; filename: string },
  withheldRefs: ReadonlyArray<string>,
  keptRefs: ReadonlyArray<string>,
): { withheld: Array<string>; kept: Array<string> } {
  const kept = keysFor(spec, keptRefs)
  return { withheld: keysFor(spec, withheldRefs).filter((key) => !kept.includes(key)), kept }
}

/** A UTF-8 byte order mark ahead of the document: `JSON.parse` rejects it, so a spec saved with one would not load as JSON. */
export function withoutByteOrderMark(content: Buffer): Buffer {
  return content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf ? content.subarray(3) : content
}

/**
 * Reads a spec by what it is, not by its URL, file name or first character:
 * JSON when it is strict JSON, YAML when the YAML parser accepts it (flow-style
 * YAML such as `{openapi: 3.0.0}` opens with a brace too). A leading byte order
 * mark is ignored. When neither accepts it, the error is the one of the format
 * it looks like. Every place that picks a spec's saved extension, its parser or
 * the format it is written back in asks this, so they cannot disagree.
 */
export function parseSpecDocument(text: string): { format: 'json' | 'yaml'; document: unknown } {
  const source = text.replace(/^\uFEFF/, '')
  try {
    return { format: 'json', document: JSON.parse(source) as unknown }
  } catch (jsonError) {
    try {
      return { format: 'yaml', document: parseYaml(source) as unknown }
    } catch (yamlError) {
      throw source.trimStart().startsWith('{') ? jsonError : yamlError
    }
  }
}

/**
 * Marks the given operations `x-excluded` (the renderer's sanitizer then drops
 * them from every published surface); returns the new bytes and the operations
 * marked. `keptKeys` stop a `$ref` path item shared with a public operation
 * from being excluded whole.
 */
export function markExcluded(content: Buffer, operationKeys: ReadonlyArray<string>, keptKeys: ReadonlyArray<string> = []): { content: Buffer; excluded: Array<string> } {
  const untouched = { content, excluded: [] as Array<string> }
  if (operationKeys.length === 0) return untouched
  const text = content.toString('utf8')
  type Entries = Record<string, Record<string, unknown> | undefined>
  let parsed: ReturnType<typeof parseSpecDocument>
  try { parsed = parseSpecDocument(text) } catch { return untouched }
  const doc = parsed.document as { paths?: Entries; webhooks?: Entries; 'x-webhooks'?: Entries } | null
  if (!doc || typeof doc !== 'object') return untouched
  const excluded: Array<string> = []
  for (const key of operationKeys) {
    const [method, ...rest] = key.split(' ')
    const name = rest.join(' ')
    if (method === 'webhook') {
      const entry = doc.webhooks?.[name] ?? doc['x-webhooks']?.[name]
      if (entry && typeof entry === 'object') { entry['x-excluded'] = true; excluded.push(`WEBHOOK ${name}`) }
      continue
    }
    const entry = doc.paths?.[name]
    if (!entry || typeof entry !== 'object') continue
    // A `$ref` entry may share its item with other operations: exclude it only when no kept ref names the path.
    const target = typeof entry.$ref === 'string'
      ? (keptKeys.some((k) => k.slice(k.indexOf(' ') + 1) === name) ? undefined : entry)
      : entry[method]
    if (target && typeof target === 'object') { (target as Record<string, unknown>)['x-excluded'] = true; excluded.push(`${method.toUpperCase()} ${name}`) }
  }
  if (excluded.length === 0) return untouched
  const out = parsed.format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : stringifyYaml(doc)
  return { content: Buffer.from(out), excluded }
}

/** Warning text for a published spec that access-restricted pages also name. */
export function sharedSpecMessage(path: string, excluded: ReadonlyArray<string> = []): string {
  return excluded.length
    ? `OpenAPI spec ${path} is shared with access-restricted pages and is published, but ${excluded.length} operation(s) documented only on those pages were withheld from it (${excluded.join(', ')}). Review the rest of the spec before publishing.`
    : `OpenAPI spec ${path} is shared with access-restricted pages and is published; it may describe restricted endpoints. Review it before publishing.`
}
