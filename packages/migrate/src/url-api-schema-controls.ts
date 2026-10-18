/**
 * Proves which deferred publisher API-schema tabs are already represented by an
 * exact recovered OpenAPI operation. This never fetches references, executes
 * controls, or grants coverage to ordinary article tabs.
 */
import { migrationHtmlArticle } from './url.js'

interface ApiSchemaOperation {
  method: string
  path: string
}

interface SchemaObject {
  [key: string]: unknown
}

// Evidence beyond these bounds stays unresolved rather than spending unbounded
// CPU proving that an adversarial page repeats the same deferred schema UI.
const MAX_CAPTURE_BYTES = 8_000_000
const MAX_TAB_GROUPS = 256
const MAX_TABS = 1_024

function object(value: unknown): SchemaObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SchemaObject : undefined
}

function localReference(document: SchemaObject, reference: unknown): unknown {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return undefined
  let target: unknown = document
  try {
    for (const part of reference.slice(2).split('/')) {
      const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return undefined
      target = (target as SchemaObject)[key]
    }
  } catch { return undefined }
  return target
}

function resolve(document: SchemaObject, value: unknown): SchemaObject | undefined {
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 32; depth += 1) {
    const schema = object(value)
    if (!schema || seen.has(schema)) return undefined
    seen.add(schema)
    if (!Object.hasOwn(schema, '$ref')) return schema
    value = localReference(document, schema.$ref)
  }
  return undefined
}

/** An incomplete or nonlocal reference anywhere invalidates coverage evidence. */
function complete(document: SchemaObject): boolean {
  let visited = 0
  const active = new Set<unknown>()
  const visit = (value: unknown, depth: number): boolean => {
    if (++visited > 100_000 || depth > 96) return false
    if (typeof value === 'number' && !Number.isFinite(value)) return false
    if (!value || typeof value !== 'object') return true
    if (active.has(value)) return false
    active.add(value)
    const schema = object(value)
    const valid = (!schema || !Object.hasOwn(schema, '$ref') || Boolean(object(localReference(document, schema.$ref))))
      && Object.values(value).every(child => visit(child, depth + 1))
    active.delete(value)
    return valid
  }
  return visit(document, 0)
}

function labels(document: SchemaObject, value: unknown): string[] | undefined {
  const schema = resolve(document, value)
  if (!Array.isArray(schema?.oneOf) || schema.oneOf.length < 2 || schema.oneOf.length > 64) return undefined
  const result: string[] = []
  for (const [index, branch] of schema.oneOf.entries()) {
    const target = resolve(document, branch)
    if (!target) return undefined
    const title = object(branch)?.title ?? target.title
    result.push(typeof title === 'string' && title.trim() ? title.trim().replace(/\s+/g, ' ') : `Option ${index + 1}`)
  }
  return new Set(result).size === result.length ? result : undefined
}

/**
 * Return indices into migrationHtmlArticle(body).root.find(
 * '[role="tablist"],[data-component-part="tabs-list"]') for proven schema groups.
 * Callers may exempt only tabs in those groups from deferred-panel review. The
 * complete operation must still be rendered from its registered local spec.
 */
export function apiSchemaTabGroups(
  body: string,
  document: SchemaObject,
  operation: ApiSchemaOperation,
): number[] {
  if (Buffer.byteLength(body) > MAX_CAPTURE_BYTES || !complete(document)) return []
  const path = object(document.paths)?.[operation.path]
  const method = operation.method.toLowerCase()
  if (!/^(?:get|post|put|patch|delete|head|options|trace)$/.test(method)) return []
  const selected = object(object(path)?.[method])
  if (!selected) return []
  const { $, root } = migrationHtmlArticle(body)
  const groups = root.find('[role="tablist"],[data-component-part="tabs-list"]')
  if (groups.length > MAX_TAB_GROUPS || root.find('[role="tab"]').length > MAX_TABS) return []
  // ID uniqueness belongs to the complete article. Index it once: querying
  // every article ID for each candidate panel made source-controlled evidence
  // quadratic even when ambiguous groups would ultimately receive no coverage.
  const idCounts = new Map<string, number>()
  root.find('[id]').each((_index, node) => {
    const id = $(node).attr('id')!
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  })
  const proofs: Array<{ index: number; scope: string }> = []
  groups.each((index, node) => {
    const group = $(node)
    const container = group.parent('.tabs.tab-container')
    const field = group.closest('.object-param-field')
    const section = field.parent('.api-section')
    if (!group.is('[role="tablist"][data-component-part="tabs-list"]') || !container.length
      || !section.length || !section.closest('[id^="api-playground-"][id$="-operation-page"]').length) return
    // Nested property schemas need an explicit property path; matching a generic
    // Option N label elsewhere in the operation is insufficient evidence.
    if (field.parents('.object-param-field').length) return
    const heading = section.children('.api-section-heading')
    const title = heading.find('.api-section-heading-title').text().trim().toLowerCase()
    const media = heading.find('*').toArray().filter(element => $(element).children().length === 0)
      .map(element => $(element).text().trim()).filter(text => /^[a-z][a-z\d.+-]*\/[a-z\d.+-]+$/i.test(text))
    if (heading.length !== 1 || !media || media.length !== 1) return
    let schema: unknown
    let scope: string
    if (title === 'body') {
      const request = resolve(document, selected.requestBody)
      schema = object(object(request?.content)?.[media[0]])?.schema
      scope = `request:${media[0]}`
    } else if (title === 'response') {
      const statuses = heading.find('button[aria-haspopup="menu"]').toArray()
        .map(button => $(button).text().trim()).filter(text => /^(?:[1-5]\d{2}|default)$/.test(text))
      if (statuses.length !== 1) return
      const response = resolve(document, object(selected.responses)?.[statuses[0]])
      schema = object(object(response?.content)?.[media[0]])?.schema
      scope = `response:${statuses[0]}:${media[0]}`
    } else return
    const expected = labels(document, schema)
    const tabs = group.children('[role="tab"][data-component-part="tab"]')
    if (!expected || tabs.length !== expected.length || group.children().length !== tabs.length) return
    const panels = container.children('[data-component-part="tabs-panels"]').children('[role="tabpanel"][data-component-part="tab-content"]')
    if (panels.length !== tabs.length) return
    const ids = new Set<string>()
    for (const [position, tab] of tabs.toArray().entries()) {
      const control = $(tab).attr('aria-controls')
      const panel = panels.eq(position)
      if ($(tab).text().trim().replace(/\s+/g, ' ') !== expected[position]
        || !control || ids.has(control) || panel.attr('id') !== control
        || !$(tab).attr('id') || panel.attr('aria-labelledby') !== $(tab).attr('id')
        || idCounts.get(control) !== 1
        || panel.text().trim() || panel.children().length) return
      ids.add(control)
    }
    proofs.push({ index, scope })
  })
  // Repeated schema groups with identical labels cannot be assigned uniquely.
  const scopeCounts = new Map<string, number>()
  for (const proof of proofs) scopeCounts.set(proof.scope, (scopeCounts.get(proof.scope) ?? 0) + 1)
  return proofs.filter(proof => scopeCounts.get(proof.scope) === 1).map(proof => proof.index)
}
