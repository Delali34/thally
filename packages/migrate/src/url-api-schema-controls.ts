/**
 * Proves which deferred schema fields and generated examples are covered by an
 * exact recovered OpenAPI operation. This never fetches references, executes
 * controls, or grants coverage to ordinary article tabs.
 */
import { migrationHtmlArticle } from './url.js'
import { readMigrationFlightDocument, resolveMigrationFlightValue } from './url-flight-content.js'

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

/** Bind empty native child-field disclosures to the exact operation rendered from a complete local spec. */
export function apiSchemaDisclosureGroups(body: string, document: SchemaObject, operation: ApiSchemaOperation): number[] {
  if (Buffer.byteLength(body) > MAX_CAPTURE_BYTES || !complete(document)) return []
  if (!/^(?:get|post|put|patch|delete|head|options|trace)$/i.test(operation.method)) return []
  const path = object(object(document.paths)?.[operation.path])
  const selected = object(path?.[operation.method.toLowerCase()])
  if (!selected) return []
  const { $, root } = migrationHtmlArticle(body)
  const operations = root.find('[id^="api-playground-"][id$="-operation-page"]').filter((_index, node) => {
    const item = $(node)
    const endpoint = item.find('[data-component-part="scroll-area-content"]').first().clone()
    // This marker is emitted only by the shared validated base-URL projector.
    // Its menu is adjacent to the endpoint path, not part of that path.
    endpoint.find('[data-thally-static-base-urls]').remove()
    return item.find('.method-pill').first().text().trim().toLowerCase() === operation.method.toLowerCase()
      && endpoint.text().trim() === operation.path
  })
  if (operations.length !== 1) return []
  const ids = new Map<string, number>()
  root.find('[id]').each((_index, node) => { const id = $(node).attr('id')!; ids.set(id, (ids.get(id) ?? 0) + 1) })
  if (ids.get(operations.attr('id')!) !== 1) return []
  let visits = 0
  const property = (value: unknown, name: string, active = new Set<unknown>()): unknown[] => {
    if (++visits > 100_000 || active.has(value)) return []
    const schema = resolve(document, value)
    if (!schema) return []
    active.add(value)
    const direct = object(schema.properties)?.[name]
    const result = direct ? [direct] : [
      ...(schema.items ? property(schema.items, name, active) : []),
      ...['allOf', 'oneOf', 'anyOf'].flatMap(key => Array.isArray(schema[key]) ? (schema[key] as unknown[]).flatMap(child => property(child, name, active)) : []),
    ]
    active.delete(value)
    return result
  }
  const fieldSelector = '.object-param-field,.array-param-field'
  const proofs: number[] = []
  if (root.find('details').length > MAX_TABS) return []
  root.find('details').each((index, node) => {
    const details = $(node), control = details.children('summary[data-component-part="expandable-button"]')
    const panel = details.children('[data-component-part="expandable-content"]')
    const field = details.closest(fieldSelector), section = field.closest('.api-section')
    if (!details.is('.expandable[data-component-part="expandable"]') || control.length !== 1 || panel.length !== 1 || details.children().length !== 2
      || !field.length || section.closest('[id^="api-playground-"][id$="-operation-page"]')[0] !== operations[0]) return
    const target = control.attr('aria-controls'), controlId = control.attr('id')
    if ((target && (panel.attr('id') !== target || ids.get(target) !== 1)) || (controlId && ids.get(controlId) !== 1)) return
    const payload = panel.clone(); payload.find('script,style').remove()
    if (payload.text().trim() || payload.children().length) return
    // Repeated field collections reuse the field class. Only a parent's
    // owned child-content region proves a nested schema-property relationship.
    const ancestors = field.parents(fieldSelector).toArray().reverse().filter(owner =>
      $(owner).is('.array-param-field') || $(owner).find('[data-component-part="expandable-content"]').toArray().some(region =>
        $(region).closest(fieldSelector)[0] === owner
        && field.parents().toArray().includes(region)))
    const chain = [...ancestors, field[0]]
    const names = chain.map(owner => $(owner).find('[data-component-part="field-name"]').filter((_index, name) => $(name).closest(fieldSelector)[0] === owner))
    const hasNamedPath = names.every(name => name.length === 1 && Boolean(name.text().trim()))
    const heading = section.children('.api-section-heading')
    if (heading.length !== 1) return
    const leaves = heading.find('*').toArray().filter(element => $(element).children().length === 0).map(element => $(element).text().trim())
    const combined = leaves.flatMap(text => { const match = text.match(/^([1-5]\d{2}|default) - ([a-z][a-z\d.+-]*\/[a-z\d.+-]+)$/i); return match ? [{status:match[1],media:match[2]}] : [] })
    const media = heading.find('*').toArray().filter(element => $(element).children().length === 0)
      .map(element => $(element).text().trim()).filter(text => /^[a-z][a-z\d.+-]*\/[a-z\d.+-]+$/i.test(text))
    const statuses = heading.find('button[aria-haspopup="menu"]').toArray().map(button => $(button).text().trim()).filter(text => /^(?:[1-5]\d{2}|default)$/.test(text))
    if (combined.length === 1 && !media.length && !statuses.length) { media.push(combined[0].media); statuses.push(combined[0].status) }
    let schemas: unknown[] = []
    let offset = 0
    let prefix = ''
    if (media.length === 1 && statuses.length === 1) {
      const response = resolve(document, object(selected.responses)?.[statuses[0]])
      schemas = [object(object(response?.content)?.[media[0]])?.schema]; prefix = 'response'
    } else if (media.length === 1 && !statuses.length) {
      const request = resolve(document, selected.requestBody)
      schemas = [object(object(request?.content)?.[media[0]])?.schema]; prefix = 'body'
    } else if (!media.length && !statuses.length) {
      const head = $(chain[0]).find('.param-head[id]').filter((_index, element) => $(element).closest(fieldSelector)[0] === chain[0]).first().attr('id') ?? ''
      const location = ['query', 'path', 'header', 'cookie'].find(value => head.startsWith(`${value}-`))
      if (names[0]?.length !== 1 || (!location && !head.startsWith('parameter-'))) return
      const parameters = [...(Array.isArray(path?.parameters) ? path.parameters : []), ...(Array.isArray(selected.parameters) ? selected.parameters : [])]
        .map(value => resolve(document, value)).filter(parameter => (!location || parameter?.in === location) && parameter?.name === names[0].text().trim())
      if (parameters.length !== 1) return
      schemas = [parameters[0]?.schema]; offset = 1; prefix = $(chain[0]).is('.array-param-field') ? 'parameter' : `parameter-${names[0].text().trim()}`
    }
    const expandable = (value: unknown): boolean => {
      const schema = resolve(document, value)
      return Boolean(schema && (object(schema.properties) || object(schema.items) || object(schema.additionalProperties) || ['allOf', 'oneOf', 'anyOf'].some(key => Array.isArray(schema[key]))))
    }
    const roots = schemas
    if (hasNamedPath) {
      for (const name of names.slice(offset)) schemas = schemas.flatMap(schema => property(schema, name.text().trim()))
      if (schemas.some(expandable)) { proofs.push(index); return }
    }
    // Anonymous array items and union branches have no visible field-name.
    // Bind their literal machine path to the registered schema instead of
    // treating an arbitrary empty disclosure as operation-wide coverage.
    const marker = details.attr('data-testid')
    if (!prefix || !marker?.endsWith('-children')) return
    const expected = marker.slice(0, -'-children'.length)
    const visibleNames = chain.flatMap(owner => {
      const labels = $(owner).find('[data-component-part="field-name"]').filter((_index, label) => $(label).closest(fieldSelector)[0] === owner)
      return labels.length === 1 ? [labels.text().trim()] : []
    })
    const matches = new Set<unknown>()
    const walk = (value: unknown, key: string, pathNames: string[], active = new Set<unknown>()): void => {
      if (++visits > 100_000 || key.length > 2_048 || active.has(value)) return
      const schema = resolve(document, value)
      if (!schema) return
      if (key === expected && expandable(schema)) {
        let cursor = 0
        const labelsAgree = visibleNames.every(name => { const found = pathNames.indexOf(name, cursor); cursor = found + 1; return found >= 0 })
        if (labelsAgree) matches.add(schema)
      }
      if (!expected.startsWith(`${key}-`)) return
      active.add(value)
      for (const [name, child] of Object.entries(object(schema.properties) ?? {})) {
        const segments = new Set([name, name.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase()])
        for (const segment of segments) walk(child, `${key}-${segment}`, [...pathNames, name], active)
      }
      if (schema.items) walk(schema.items, `${key}-items`, pathNames, active)
      // OpenAPI 3.0 nullable is rendered as the value branch followed by null.
      // allOf combines object properties without introducing a visible choice.
      if ((schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'))) && !schema.oneOf) walk({ ...schema, nullable: false, type: Array.isArray(schema.type) ? schema.type.filter(value => value !== 'null') : schema.type }, `${key}-one-of-0`, pathNames, active)
      if (Array.isArray(schema.allOf)) schema.allOf.forEach(child => walk(child, key, pathNames, active))
      for (const [keyword, segment] of [['allOf', 'all-of'], ['oneOf', 'one-of'], ['anyOf', 'any-of']]) {
        const children = schema[keyword]
        if (Array.isArray(children)) children.forEach((child, branch) => walk(child, `${key}-${segment}-${branch}`, pathNames, active))
      }
      active.delete(value)
    }
    roots.forEach(schema => walk(schema, prefix, offset ? [names[0].text().trim()] : []))
    if (matches.size === 1) proofs.push(index)
  })
  return visits > 100_000 ? [] : proofs
}


/**
 * Prove generated request-example pickers through the rendered provider tree.
 * The registered operation regenerates client examples. Authored examples still
 * require exact source bytes in both its x-codeSamples and captured panels.
 */
export function apiOperationCodeControls(body: string, specification: SchemaObject, operation: ApiSchemaOperation): number[] {
  if (Buffer.byteLength(body) > MAX_CAPTURE_BYTES || !complete(specification)) return []
  const selected = object(object(object(specification.paths)?.[operation.path])?.[operation.method.toLowerCase()])
  if (!selected) return []
  const { $, root } = migrationHtmlArticle(body)
  const flight = readMigrationFlightDocument($)
  if (!flight) return []
  let visited = 0, textBytes = 0, exceeded = false
  const resolveValue = (input: unknown): unknown => {
    if (exceeded) return undefined
    const result = resolveMigrationFlightValue(flight, input)
    if (!result.resolved) exceeded = true
    return result.value
  }
  const textOf = (input: unknown, depth = 0, label = false): string | undefined => {
    if (exceeded || ++visited > 100_000 || depth > 96) { exceeded = true; return undefined }
    const value = resolveValue(input)
    if (value === undefined || value === null || typeof value === 'boolean') return ''
    if (typeof value === 'string' || typeof value === 'number') {
      const result = String(value); textBytes += Buffer.byteLength(result)
      if (textBytes > MAX_CAPTURE_BYTES) { exceeded = true; return undefined }
      return result
    }
    if (!Array.isArray(value)) return undefined
    if (value[0] === '$') {
      if (typeof value[1] !== 'string' || !(label ? ['div', 'p', 'span', 'code', 'a', 'br', 'svg', 'path', 'polyline'] : ['span', 'code', 'a', 'br']).includes(value[1]) || !object(value[3])) return undefined
      return value[1] === 'br' ? '\n' : textOf((value[3] as SchemaObject).children, depth + 1, label)
    }
    const children = value.map(child => textOf(child, depth + 1, label))
    return children.some(child => child === undefined) ? undefined : children.join('')
  }
  const samplePairs = (value: unknown, transport = true): string[] | undefined => {
    if (exceeded) return undefined
    const samples = transport ? resolveValue(value) : value
    if (!Array.isArray(samples) || samples.length > 64) return undefined
    const pairs: string[] = []
    for (const input of samples) {
      const sample = object(transport ? resolveValue(input) : input)
      const language = transport ? resolveValue(sample?.lang) : sample?.lang
      const source = transport ? resolveValue(sample?.source) : sample?.source
      const label = transport ? resolveValue(sample?.label) : sample?.label
      if (label !== undefined && typeof label !== 'string') return undefined
      if (typeof language !== 'string' || !language.trim() || typeof source !== 'string' || !source.trim()) return undefined
      textBytes += Buffer.byteLength(language) + Buffer.byteLength(source) + (typeof label === 'string' ? Buffer.byteLength(label) : 0)
      if (textBytes > MAX_CAPTURE_BYTES) { exceeded = true; return undefined }
      pairs.push(JSON.stringify([language, source, label ?? null]))
    }
    return pairs
  }
  const declared = selected['x-codeSamples'] === undefined ? [] : samplePairs(selected['x-codeSamples'], false)
  if (!declared) return []
  interface Group { owners: string[]; code: string[]; controls: string[]; toolbar: boolean; generated: boolean; invalid: boolean }
  const groups: Group[] = []
  const providers: SchemaObject[] = []
  let providerCount = 0, generatedControllers = 0, providerMetadataMatches = false
  const matchesOperation = (value: unknown): boolean => {
    const metadata = object(resolveValue(value))
    const declaration = resolveValue(metadata?.openapi)
    if (typeof declaration !== 'string') return false
    const tokens = declaration.trim().split(/\s+/)
    return tokens.at(-2)?.toLowerCase() === operation.method.toLowerCase() && tokens.at(-1) === operation.path
  }
  const active = new Set<unknown>()
  const visit = (input: unknown, provider: boolean, group: Group | undefined, depth: number, owners: string[] = []): void => {
    if (exceeded || ++visited > 100_000 || depth > 96) { exceeded = true; return }
    const value = resolveValue(input)
    if (!value || typeof value !== 'object') return
    if (active.has(value)) { exceeded = true; return }
    active.add(value)
    if (Array.isArray(value)) {
      if (value[0] === '$' && object(value[3])) {
        const props = value[3] as SchemaObject
        const moduleId = typeof value[1] === 'string' ? /^\$L([a-f\d]+)$/i.exec(value[1])?.[1] : undefined
        const kind = moduleId ? flight.modules.get(moduleId) : value[1]
        const ownId = moduleId ? undefined : resolveValue(props.id)
        const localOwners = typeof ownId === 'string' ? [...owners, ownId] : owners
        let owned = provider
        if (kind === 'OpenApiProvider') {
          providerCount += 1
          const data = object(resolveValue(props.openApiReferenceData))
          const source = object(resolveValue(data?.operation))
          const samples = samplePairs(source?.codeSamples)
          const authored = source?.['x-codeSamples'] === undefined ? [] : samplePairs(source['x-codeSamples'])
          owned = Boolean(source && source.method === operation.method.toLowerCase() && source.path === operation.path
            && samples && authored && JSON.stringify(samples) === JSON.stringify(declared) && JSON.stringify(authored) === JSON.stringify(declared))
          if (owned) { providers.push(source!); providerMetadataMatches = matchesOperation(props.pageMetadata) }
        }
        if (owned && kind === 'MDXContentController' && matchesOperation(props.pageMetadata)) {
          const child = resolveValue(props.children)
          const childId = Array.isArray(child) && child[0] === '$' && typeof child[1] === 'string' ? /^\$L([a-f\d]+)$/i.exec(child[1])?.[1] : undefined
          const childProps = Array.isArray(child) ? object(child[3]) : undefined
          const source = object(resolveValue(childProps?.mdxSource))
          const scope = object(resolveValue(source?.scope))
          if (childId && flight.modules.get(childId) === 'default' && typeof source?.compiledSource === 'string'
            && (() => {
              if (matchesOperation(scope?.pageMetadata)) return true
              // Raw MDX hints can retain older placeholder identifiers. The
              // resolved provider/controller/spec remain the exact authority;
              // only an identical source href and route template agree here.
              const hint = object(resolveValue(scope?.pageMetadata)), metadata = object(resolveValue(props.pageMetadata))
              const declaration = resolveValue(hint?.openapi)
              if (typeof declaration !== 'string' || typeof hint?.href !== 'string' || !hint.href || hint.href !== metadata?.href) return false
              const tokens = declaration.trim().split(/\s+/)
              const template = (path: string) => path.split('/').map(segment => /^\{[^{}\/]+\}$/.test(segment) ? '{}' : segment).join('/')
              return tokens.at(-2)?.toLowerCase() === operation.method.toLowerCase()
                && template(tokens.at(-1) ?? '') === template(operation.path)
            })()) generatedControllers += 1
        }
        let local = group
        if (owned && typeof props.className === 'string' && props.className.split(/\s+/).includes('code-group')) {
          local = { owners: localOwners, code: [], controls: [], toolbar: false, generated: false, invalid: false }; groups.push(local)
        }
        if (local && owned) {
          if (props['data-component-part'] === 'code-group-tab-bar') local.toolbar = true
          if (String(props['data-index']) === '-1') local.generated = true
          if (props['aria-expanded'] !== undefined) {
            const text = textOf(props.children, 0, true)
            if (kind !== 'button' || props['aria-haspopup'] !== 'menu' || text === undefined) local.invalid = true
            else local.controls.push(JSON.stringify([text, props['aria-label'] ?? '', String(props['aria-expanded']), props['aria-haspopup']]))
          }
          if (kind === 'pre') {
            const code = textOf(props.children)
            if (code === undefined || !code.trim()) local.invalid = true
            else local.code.push(code)
          }
          if (props['aria-busy'] === true || props['aria-busy'] === 'true' || props.role === 'progressbar') local.invalid = true
        }
        visit(props.children, owned, local, depth + 1, localOwners)
      } else for (const child of value) visit(child, provider, group, depth + 1, owners)
    } else if (depth === 0 && Array.isArray((value as SchemaObject).f)) {
      visit((value as SchemaObject).f, provider, group, depth + 1, owners)
    } else if (Object.keys(value).every(key => key === 'children')) {
      // Next's rendered route slot is the only supported object edge. Metadata
      // options containing plausible provider tuples never grant authority.
      const children = (value as SchemaObject).children
      if (Array.isArray(children) && children.length >= 2) visit(children, provider, group, depth + 1, owners)
    }
    active.delete(value)
  }
  visit(flight.records.get('0'), false, undefined, 0)
  if (exceeded || providerCount !== 1 || providers.length !== 1 || groups.length > MAX_TAB_GROUPS) return []
  const sources = declared.map(pair => (JSON.parse(pair) as string[])[1])
  const sourceCounts = new Map<string, number>()
  for (const group of groups) if (group.toolbar && group.generated && !group.invalid && group.controls.length >= 1 && group.controls.length <= 2) {
    const signature = JSON.stringify([group.owners, group.code, group.controls])
    sourceCounts.set(signature, (sourceCounts.get(signature) ?? 0) + 1)
  }
  const expanded = root.find('[aria-expanded]').toArray()
  if (expanded.length > MAX_TABS) return []
  const controlIndices = new Map(expanded.map((node, index) => [node, index]))
  const domGroups = new Map<unknown, { signature: string; indices: number[]; code: string[]; label: boolean; title?: string; legacy: boolean }>()
  $(expanded).each((_index, node) => {
    const control = $(node)
    const group = control.closest('.code-group,[data-testid="code-group-select"]')
    const legacy = group.is('[data-testid="code-group-select"]')
    if (!control.is('button[aria-haspopup="menu"]') || control.attr('aria-controls')
      || (!legacy && !control.closest('[data-component-part="code-group-tab-bar"]').length) || !group.length
      || group.find('[aria-expanded]').length < 1 || group.find('[aria-expanded]').length > 2) return
    if (domGroups.has(group[0])) return
    const menus = group.find('[aria-expanded]')
    if (menus.toArray().some(menu => !$(menu).is('button[aria-haspopup="menu"]') || (!$(menu).attr('aria-label')?.trim() && !$(menu).text().trim()) || $(menu).attr('aria-controls')
      || (!legacy && $(menu).closest('[data-component-part="code-group-tab-bar"]')[0] !== group.children('[data-component-part="code-group-tab-bar"]')[0])
      || (legacy && !$(menu).parents().toArray().includes(group.children().first()[0])))) return
    if (menus.length === 2) {
      const samples = declared.map(pair => JSON.parse(pair) as Array<string | null>)
      const labelledChoices = samples.filter(sample => sample[2] && samples.filter(other => other[0] === sample[0]).length >= 2)
      if (!labelledChoices.length || !menus.toArray().some(menu => labelledChoices.some(sample => sample[2] === $(menu).text().trim()))) return
    }
    const panels = group.find('[data-index]')
    const code = group.find('pre').toArray().map(pre => {
      const lines = $(pre).find('.token-line')
      return lines.length ? lines.toArray().map(line => $(line).text()).join('\n') : $(pre).text()
    })
    if (group.find('[aria-busy="true"],[role="progressbar"]').length) return
    if (legacy) {
      // Older request-example clients render only the selected authored item.
      // All alternatives are literal in the exact registered/provider inventory;
      // the runtime generator retains them, including same-language variants.
      if (menus.length !== 2 || group.children().length !== 2 || group.children().first().find('pre').length
        || code.length !== 1 || !code[0].trim() || panels.length) return
      const selectedSamples = declared.map(pair => JSON.parse(pair) as Array<string | null>).filter(sample =>
        sample[2] && menus.toArray().some(menu => $(menu).text().trim() === sample[2])
        && menus.toArray().some(menu => $(menu).text().trim().toLowerCase() === sample[0]?.toLowerCase())
        && (code[0] === sample[1] || code[0] === sample[1]?.replace(/\n$/, '')))
      if (!selectedSamples.length) return
    } else if (!panels.length || panels.length > MAX_TABS || code.length !== panels.length
      || !panels.toArray().some(panel => $(panel).attr('data-index') === '-1')
      || panels.toArray().some(panel => $(panel).find('pre').length !== 1 || !$(panel).text().trim())
      || !sources.every(source => code.some(captured => captured === source || captured === source.replace(/\n$/, '')))) return
    const controls = menus.toArray().map(menu => JSON.stringify([$(menu).text(), $(menu).attr('aria-label') ?? '', $(menu).attr('aria-expanded'), $(menu).attr('aria-haspopup')]))
    const owners = group.parents('[id]').toArray().reverse().map(owner => $(owner).attr('id')!)
    if (group.attr('id')) owners.push(group.attr('id')!)
    domGroups.set(group[0], { signature: JSON.stringify([owners, code, controls]), indices: menus.toArray().map(menu => controlIndices.get(menu)!), code, legacy, title: group.children('[data-component-part="code-group-tab-bar"]').find('span[title]').first().attr('title'), label: legacy || group.children('[data-component-part="code-group-tab-bar"]').length === 1
      && group.children('[data-component-part="code-group-tab-bar"]').find('span[title]').toArray().some(title => Boolean($(title).attr('title')?.trim()) && $(title).text().trim() === $(title).attr('title')) })
  })
  // A matching payload cannot lend authority to a second, unrelated picker.
  // Responsive instances need distinct source ownership paths. Repeated
  // equally matching signatures stay unresolved rather than transferring proof.
  const domCounts = new Map<string, number>()
  for (const group of domGroups.values()) domCounts.set(group.signature, (domCounts.get(group.signature) ?? 0) + 1)
  const proofs: number[] = []
  for (const group of domGroups.values()) if (sourceCounts.get(group.signature) === 1 && domCounts.get(group.signature) === 1) proofs.push(...group.indices)
  if (groups.length === 0 && providerMetadataMatches && generatedControllers === 1 && domGroups.size === 2) {
    // Current client renderers do not transmit RequestExample's generated DOM
    // in Flight. This explicit two-slot component contract substitutes the
    // complete registered generator, while captured/authored code stays exact.
    const operations = root.find('[id^="api-playground-"][id$="-operation-page"]').filter((_index, node) => {
      const endpoint = $(node).find('[data-component-part="scroll-area-content"]').first().clone()
      endpoint.find('[data-thally-static-base-urls]').remove()
      return $(node).find('.method-pill').first().text().trim().toLowerCase() === operation.method.toLowerCase() && endpoint.text().trim() === operation.path
    })
    const main = $('main#content-container'), side = $('[id="content-side-layout"]')
    const content = $('[id="content-area"]')
    const slots = new Map<string, { indices: number[]; code: string[] }>()
    const titles = [resolveValue(providers[0].title), resolveValue(providers[0].summary), ...declared.flatMap(pair => { const values = JSON.parse(pair) as Array<string | null>; return [values[0], values[2]] })].filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase())
    let valid = operations.length === 1 && main.length === 1 && side.length === 1 && content.length === 1
      && operations.closest('#content-area')[0] === content[0] && $('[id]').filter((_index, node) => $(node).attr('id') === operations.attr('id')).length === 1 && side.closest('main')[0] === main[0]
    for (const [node, entry] of domGroups) {
      const group = $(node as Parameters<typeof $>[0])
      const control = group.find('button[aria-expanded]').first()
      const owner = group.closest('[id^="api-playground-"][id$="-operation-page"]')
      const slot = owner[0] === operations[0] ? 'inline' : group.closest('#content-side-layout')[0] === side[0] ? 'sidebar' : undefined
      if (!slot || slots.has(slot) || !entry.label || (!entry.legacy && (!entry.title || !titles.includes(entry.title.toLowerCase()) || !control.attr('aria-label')?.trim()))
        || group.closest('main')[0] !== main[0] || group.closest('.mdx-content,.api-section,.object-param-field,.array-param-field,[data-component-part="expandable-content"]').length) valid = false
      else slots.set(slot, entry)
    }
    if (valid && slots.size === 2 && JSON.stringify(slots.get('inline')?.code) === JSON.stringify(slots.get('sidebar')?.code)) {
      proofs.push(...[...slots.values()].flatMap(slot => slot.indices))
    }
  }
  return proofs
}
