import type {
  ApiSpecConfig,
  NormalizedMediaType,
  NormalizedOperation,
  NormalizedParameter,
  NormalizedRequestBody,
  NormalizedResponse,
  NormalizedAuthScheme,
  NormalizedSecurityRequirement,
  NormalizedServer,
  NormalizedSpec,
  OperationOverride,
  ResolvedSpec,
} from '@/lib/openapi/types'
import { getApiMdxConfig, getApiPlaygroundCredentials } from '@/data/docs'
import { HTTP_METHODS, buildOperationKey, isExtensionSet } from '@/lib/openapi/operation-keys'
import { buildSchemaExample } from '@/lib/openapi/schema-example'
import { isObj, operationVisibility, viewPathEntry } from '@/lib/openapi/path-items'

type RawObject = Record<string, unknown>

export { HTTP_METHODS, buildOperationKey, isExtensionSet }

export function normalizeSpec(resolved: ResolvedSpec): NormalizedSpec {
  const specServers = normalizeServers((resolved.document as RawObject).servers)
  const resolveRef = createSchemaResolver(resolved.document as RawObject)
  // Shared across every operation in this spec: a component schema referenced
  // by many operations (e.g. a large shared "Assistant" or "Call" object) is
  // deep-resolved once and reused by reference, instead of being re-expanded
  // and duplicated in memory for every operation that references it.
  const deepResolve = createDeepResolver(resolveRef)
  const securitySchemes = (resolved.document as RawObject).components as RawObject | undefined
  const rawSecuritySchemes =
    securitySchemes && typeof securitySchemes.securitySchemes === 'object'
      ? (securitySchemes.securitySchemes as Record<string, RawObject>)
      : {}
  const implicitAuth = implicitAuthFor()
  const operations: Array<NormalizedOperation> = []

  const paths = (resolved.document as RawObject).paths
  if (paths && typeof paths === 'object') {
    Object.entries(paths as Record<string, RawObject>).forEach(([pathKey, entry]) => {
      if (!isObj(entry)) return
      const view = viewPathEntry(resolved.document, entry)
      const pathItem = view.item
      const pathParameters = extractParameters(pathItem.parameters)
      const pathServers = normalizeServers(pathItem.servers)

      for (const method of HTTP_METHODS) {
        const operation = pathItem[method]
        if (!operation || typeof operation !== 'object') {
          continue
        }
        const visibility = operationVisibility(
          view,
          method,
          resolved.config.operationOverrides?.[buildOperationKey(method, pathKey)],
        )
        if (visibility === 'excluded') {
          continue
        }
        operations.push(
          normalizeOperation({
            specId: resolved.config.id,
            path: pathKey,
            method,
            rawOperation: operation as RawObject,
            sharedParameters: pathParameters,
            pathServers,
            specServers,
            config: resolved.config,
            documentSecurity: (resolved.document as RawObject).security,
            securitySchemes: rawSecuritySchemes,
            implicitAuth,
            hidden: visibility === 'hidden',
            isWebhook: false,
            resolveRef,
            deepResolve,
          }),
        )
      }
    })
  }

  const webhooks = (resolved.document as RawObject).webhooks
  if (webhooks && typeof webhooks === 'object') {
    Object.entries(webhooks as Record<string, RawObject>).forEach(([webhookKey, entry]) => {
      if (!isObj(entry)) return
      const view = viewPathEntry(resolved.document, entry)
      const webhookItem = view.item
      const hookParameters = extractParameters(webhookItem.parameters)
      const hookServers = normalizeServers(webhookItem.servers)
      for (const method of HTTP_METHODS) {
        const operation = webhookItem[method]
        if (!operation || typeof operation !== 'object') {
          continue
        }
        const visibility = operationVisibility(
          view,
          method,
          resolved.config.operationOverrides?.[buildOperationKey(method, webhookKey, true)],
        )
        if (visibility === 'excluded') {
          continue
        }
        operations.push(
          normalizeOperation({
            specId: resolved.config.id,
            path: webhookKey,
            method,
            rawOperation: operation as RawObject,
            sharedParameters: hookParameters,
            pathServers: hookServers,
            specServers,
            config: resolved.config,
            documentSecurity: (resolved.document as RawObject).security,
            securitySchemes: rawSecuritySchemes,
            hidden: visibility === 'hidden',
            isWebhook: true,
            resolveRef,
            deepResolve,
          }),
        )
      }
    })
  }

  operations.sort((a, b) => {
    if (a.group === b.group) {
      return a.title.localeCompare(b.title)
    }
    return a.group.localeCompare(b.group)
  })

  return {
    config: resolved.config,
    servers: specServers,
    operations,
  }
}

interface NormalizeOperationOptions {
  specId: string
  path: string
  method: (typeof HTTP_METHODS)[number]
  rawOperation: RawObject
  sharedParameters: Array<RawObject>
  pathServers: Array<NormalizedServer>
  specServers: Array<NormalizedServer>
  documentSecurity?: unknown
  securitySchemes: Record<string, RawObject>
  /** Credentials for an operation whose spec declares no `security` at all; never given to webhooks. */
  implicitAuth?: ImplicitAuth | null
  config: ApiSpecConfig
  hidden: boolean
  isWebhook: boolean
  resolveRef: (ref: string) => RawObject | null
  deepResolve: (schema: RawObject) => RawObject
}

function normalizeOperation(options: NormalizeOperationOptions): NormalizedOperation {
  const method = options.method.toUpperCase()
  const key = buildOperationKey(method, options.path, options.isWebhook)
  const override = options.config.operationOverrides?.[key]
  const title = override?.title ?? (options.rawOperation.summary as string | undefined) ?? (options.rawOperation.operationId as string | undefined) ?? `${method} ${options.path}`
  const description =
    override?.description ??
    (options.rawOperation.description as string | undefined) ??
    (options.rawOperation.summary as string | undefined)
  const tags = Array.isArray(options.rawOperation.tags)
    ? (options.rawOperation.tags.filter((tag): tag is string => typeof tag === 'string') as Array<string>)
    : []
  const group = resolveGroup({ tags, override, config: options.config, isWebhook: options.isWebhook })

  const pathLevelParameters = options.sharedParameters
  const operationParameters = extractParameters(options.rawOperation.parameters)
  const { groupedParameters, parameterPrefill } = normalizeParameters([...pathLevelParameters, ...operationParameters], options.resolveRef, options.deepResolve)
  const { body: requestBody, sample: requestBodySample } = normalizeRequestBody(options.rawOperation.requestBody, options.resolveRef, options.deepResolve)
  const responses = normalizeResponses(options.rawOperation.responses, options.resolveRef, options.deepResolve)
  const declaredSecurity = options.rawOperation.security ?? options.documentSecurity
  const implicit = declaredSecurity === undefined || declaredSecurity === null ? options.implicitAuth : undefined
  const security = normalizeSecurity(implicit ? implicit.security : declaredSecurity)
  const authSchemes = buildAuthSchemes(security, implicit?.schemes ?? options.securitySchemes, options.resolveRef)

  const operationServers = normalizeServers(options.rawOperation.servers)
  const servers =
    operationServers.length > 0
      ? operationServers
      : options.pathServers.length > 0
        ? options.pathServers
        : options.specServers

  const slug = override?.slug ?? buildSlugSegments(options.path, method, options.isWebhook)
  const id = buildOperationId(options.specId, slug, options.isWebhook)

  return {
    specId: options.specId,
    id,
    key,
    slug,
    title,
    description,
    method,
    path: options.path,
    isWebhook: options.isWebhook,
    group,
    badge: override?.badge,
    tags,
    servers,
    parameters: groupedParameters,
    requestBody,
    responses,
    security,
    authSchemes,
    codeSamples: normalizeCodeSamples(options.rawOperation['x-codeSamples'] ?? options.rawOperation['x-code-samples']),
    hidden: options.hidden,
    prefill: {
      path: parameterPrefill.path,
      query: parameterPrefill.query,
      header: parameterPrefill.header,
      cookie: parameterPrefill.cookie,
      body: requestBodySample,
    },
  }
}

function normalizeServers(raw: unknown): Array<NormalizedServer> {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((server) => (server && typeof server === 'object' ? server : null))
    .filter((server): server is RawObject => Boolean(server && typeof server.url === 'string'))
    .map((server) => ({
      url: String(server.url),
      description: typeof server.description === 'string' ? server.description : undefined,
    }))
}

function extractParameters(raw: unknown): Array<RawObject> {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.filter((param): param is RawObject => param !== null && typeof param === 'object')
}

function normalizeParameters(
  params: Array<RawObject>,
  resolveRef: (ref: string) => RawObject | null,
  deepResolve: (schema: RawObject) => RawObject,
): {
  groupedParameters: Record<'path' | 'query' | 'header' | 'cookie', Array<NormalizedParameter>>
  parameterPrefill: Record<'path' | 'query' | 'header' | 'cookie', Record<string, string>>
} {
  const grouped: Record<'path' | 'query' | 'header' | 'cookie', Array<NormalizedParameter>> = {
    path: [],
    query: [],
    header: [],
    cookie: [],
  }
  const prefill: Record<'path' | 'query' | 'header' | 'cookie', Record<string, string>> = {
    path: {},
    query: {},
    header: {},
    cookie: {},
  }

  const deduped = new Map<string, RawObject>()
  // Path-level params come first, so a later (operation-level) entry with the
  // same name+in overrides them. `$ref` params point at components/parameters.
  params.forEach((raw) => {
    const param = typeof raw.$ref === 'string' ? resolveRef(raw.$ref) : raw
    if (!param || typeof param.name !== 'string' || typeof param.in !== 'string') {
      return
    }
    deduped.set(`${param.in}:${param.name}`, param)
  })

  deduped.forEach((param) => {
    const location = param.in
    if (location === 'path' || location === 'query' || location === 'header' || location === 'cookie') {
      // Resolved like a body schema, so a `$ref` schema shows its own type, description and values.
      const schema = isObj(param.schema) ? deepResolve(param.schema) : undefined
      const normalizedParameter: NormalizedParameter = {
        name: param.name as string,
        in: location,
        required: Boolean(param.required),
        // The parameter's own description wins; some specs only put it on the schema.
        description: typeof param.description === 'string' ? param.description : typeof schema?.description === 'string' ? schema.description : undefined,
        schema,
      }
      grouped[location].push(normalizedParameter)
      prefill[location][normalizedParameter.name] = buildParameterSampleValue(normalizedParameter.schema, resolveRef, normalizedParameter.required)
    }
  })

  return {
    groupedParameters: grouped,
    parameterPrefill: prefill,
  }
}

function normalizeRequestBody(
  raw: unknown,
  resolveRef: (ref: string) => RawObject | null,
  deepResolve: (schema: RawObject) => RawObject,
): {
  body?: NormalizedRequestBody
  sample?: string
} {
  if (!raw || typeof raw !== 'object') {
    return { body: undefined, sample: undefined }
  }
  const contents = normalizeContent((raw as RawObject).content, deepResolve)
  if (!contents.length) {
    return { body: undefined, sample: undefined }
  }
  const primaryContent = contents[0]
  const sampleValue = primaryContent ? buildBodyExample(primaryContent, resolveRef) : undefined
  const sample = sampleValue !== undefined ? JSON.stringify(sampleValue, null, 2) : undefined

  return {
    body: {
      description: typeof (raw as RawObject).description === 'string' ? ((raw as RawObject).description as string) : undefined,
      required: Boolean((raw as RawObject).required),
      contents,
    },
    sample,
  }
}

// Request-body sample: the media type's own example(s) first, then the schema.
function buildBodyExample(content: NormalizedMediaType, resolveRef: (ref: string) => RawObject | null): unknown {
  if (content.example !== undefined) {
    return content.example
  }
  const first = content.examples?.[0]
  if (first && first.value !== undefined) {
    return first.value
  }
  return content.schema ? buildSchemaExample(content.schema, resolveRef, new Set<string>(), true) : undefined
}

// Authored `x-codeSamples` / `x-code-samples`: [{ lang, label?, source }].
function normalizeCodeSamples(raw: unknown): Array<{ label: string; source: string }> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: RawObject) => {
    const label = entry?.label ?? entry?.lang
    const source = entry?.source
    return typeof label === 'string' && label && typeof source === 'string' && source ? [{ label, source }] : []
  })
}

function normalizeResponses(
  raw: unknown,
  resolveRef: (ref: string) => RawObject | null,
  deepResolve: (schema: RawObject) => RawObject,
): Array<NormalizedResponse> {
  if (!raw || typeof raw !== 'object') {
    return []
  }
  return Object.entries(raw as Record<string, RawObject>)
    .map(([code, response]) => {
      // Responses can also be $refs (e.g. '#/components/responses/NotFound')
      const resolved = typeof response.$ref === 'string' ? (resolveRef(response.$ref) ?? response) : response
      return {
        code,
        description: typeof resolved.description === 'string' ? resolved.description : undefined,
        contents: normalizeContent(resolved.content, deepResolve),
      }
    })
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
}

function normalizeContent(raw: unknown, deepResolve: (schema: RawObject) => RawObject): Array<NormalizedMediaType> {
  if (!raw || typeof raw !== 'object') {
    return []
  }
  return Object.entries(raw as Record<string, RawObject>).map(([mediaType, definition]) => {
    let schema = typeof definition.schema === 'object' ? (definition.schema as Record<string, unknown>) : undefined
    // Deep-resolve all $refs in the schema tree so the renderer sees plain objects
    if (schema) {
      schema = deepResolve(schema)
    }
    return {
      mediaType,
      schema,
      example: definition.example,
      examples: normalizeExamples(definition.examples),
    }
  })
}

// Real specs stay far below these caps (VapiAI's, the densest known, needs
// under 2,000 lookups per schema); they only stop pathological ones —
// thousands of nesting levels, or a dense clique of mutually-referencing
// schemas — from overflowing the stack or hanging the build. Past a cap the
// schema is shown as a short placeholder.
const MAX_DEPTH = 1000
const MAX_REF_EXPANSIONS = 200_000
const MAX_CYCLE_ENTRIES = 1000

/**
 * A `$ref` node's own `description` and `title` win over the ones on the schema it points at, as Mintlify shows
 * `{ "$ref": "#/components/schemas/Group", "description": "The newly created group" }`. Any other sibling of a `$ref` is still ignored.
 * `resolved` is shared by every reference to that schema, so the override is applied to a copy.
 */
function withRefSiblings(node: RawObject, resolved: RawObject): RawObject {
  if (typeof node.$ref !== 'string' || resolved === node) return resolved
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)
  const title = text(node.title)
  const description = text(node.description)
  if (title === undefined && description === undefined) return resolved
  return { ...resolved, ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }) }
}

/**
 * Builds a schema deep-resolver bound to one spec document. Resolves every
 * $ref pointer it finds — including refs inside properties, items, and
 * allOf/anyOf/oneOf members — recursively. Circular references are broken by
 * tracking visited $ref paths.
 *
 * A component schema referenced by many operations (e.g. a large shared
 * "Assistant" or "Call" object in a big API) would otherwise be re-expanded
 * and duplicated in memory independently for every operation that
 * references it. This memoizes the fully-resolved result per $ref so it is
 * computed once per spec and reused by reference everywhere else.
 */
function createDeepResolver(resolveRef: (ref: string) => RawObject | null) {
  // Refs that sit on no $ref cycle resolve identically from every entry path,
  // so one result is shared by reference everywhere.
  const cache = new Map<string, RawObject>()
  // A ref on a cycle resolves differently depending on which of its
  // cycle-mates are already in progress (they become "[Circular]"
  // placeholders). Its result is memoized together with the context it is
  // valid for, so it is reused only where the walk would provably come out
  // the same: every in-progress ref it truncated at (`deps`) is in progress
  // again, and no ref it expanded (`expanded`) is. Without this, a large
  // strongly-connected component (VapiAI's has 34 schemas) is re-walked once
  // per simple path through it, which takes seconds and hundreds of MB per
  // call and exhausts the heap during `next build`.
  interface CycleEntry {
    deps: Array<string>
    expanded: Set<string>
    result: RawObject
  }
  interface Frame {
    deps: Set<string>
    expanded: Set<string>
    onCycle: boolean
  }
  const cycleCache = new Map<string, Array<CycleEntry>>()
  const stack: Array<string> = []
  const frames: Array<Frame> = []
  let depth = 0
  let budget = 0

  // `ref` (at stack[index]) was reached again while in progress: every frame
  // from it to the top is on that cycle, and every frame above it depends on
  // `ref` being in progress.
  function markCycle(index: number, ref: string) {
    for (let i = index; i < frames.length; i++) {
      frames[i].onCycle = true
      if (i > index) frames[i].deps.add(ref)
    }
  }

  function resolve(schema: RawObject): RawObject {
    if (depth >= MAX_DEPTH) return { type: 'object', description: '[Too deeply nested to show]' }
    depth++
    try {
      return withRefSiblings(schema, resolveNode(schema))
    } finally {
      depth--
    }
  }

  function resolveNode(schema: RawObject): RawObject {
    // If this node IS a $ref, resolve it first (then recurse into the result)
    if (typeof schema.$ref === 'string') {
      const ref = schema.$ref
      const cached = cache.get(ref)
      if (cached) {
        return cached
      }
      const cycleStart = stack.indexOf(ref)
      if (cycleStart !== -1) {
        // Break circular reference — return a placeholder.
        markCycle(cycleStart, ref)
        return { type: 'object', description: `[Circular: ${ref.split('/').pop()}]` }
      }
      const candidates = cycleCache.get(ref)
      // Each lookup costs one unit plus one per cached entry it may scan.
      budget -= 1 + (candidates?.length ?? 0)
      if (budget < 0) return { type: 'object', description: `[Too large to show: ${ref.split('/').pop()}]` }
      const entry = candidates?.find(
        (e) => e.deps.every((d) => stack.includes(d)) && ![...e.expanded].some((x) => stack.includes(x)),
      )
      if (entry) {
        for (const d of entry.deps) markCycle(stack.indexOf(d), d)
        const parent = frames[frames.length - 1]
        if (parent) {
          parent.expanded.add(ref)
          for (const x of entry.expanded) parent.expanded.add(x)
        }
        return entry.result
      }
      const resolved = resolveRef(ref)
      if (resolved) {
        const frame: Frame = { deps: new Set(), expanded: new Set(), onCycle: false }
        stack.push(ref)
        frames.push(frame)
        const result = resolve(resolved)
        stack.pop()
        frames.pop()
        if (!frame.onCycle) {
          cache.set(ref, result)
        } else {
          const entries = cycleCache.get(ref) ?? []
          if (entries.length < MAX_CYCLE_ENTRIES) entries.push({ deps: [...frame.deps], expanded: frame.expanded, result })
          cycleCache.set(ref, entries)
          const parent = frames[frames.length - 1]
          if (parent) {
            parent.expanded.add(ref)
            for (const x of frame.expanded) parent.expanded.add(x)
          }
        }
        return result
      }
      return schema
    }

    const result: RawObject = { ...schema }

    // Resolve allOf / anyOf / oneOf members
    for (const compositeKey of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (Array.isArray(schema[compositeKey])) {
        result[compositeKey] = (schema[compositeKey] as unknown[]).map((item) =>
          item && typeof item === 'object' ? resolve(item as RawObject) : item,
        )
      }
    }

    // Resolve each property schema
    if (schema.properties && typeof schema.properties === 'object') {
      const resolvedProps: Record<string, unknown> = {}
      for (const [propKey, propSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
        resolvedProps[propKey] =
          propSchema && typeof propSchema === 'object' ? resolve(propSchema as RawObject) : propSchema
      }
      result.properties = resolvedProps
    }

    // Resolve array items
    if (schema.items && typeof schema.items === 'object') {
      result.items = resolve(schema.items as RawObject)
    }

    return result
  }

  return (schema: RawObject) => {
    budget = MAX_REF_EXPANSIONS
    return resolve(schema)
  }
}

function normalizeExamples(raw: unknown): Array<{ key: string; summary?: string; description?: string; value: unknown }> {
  if (!raw || typeof raw !== 'object') {
    return []
  }
  return Object.entries(raw as Record<string, RawObject>)
    .map(([key, example]) => ({
      key,
      summary: typeof example.summary === 'string' ? example.summary : undefined,
      description: typeof example.description === 'string' ? example.description : undefined,
      value: 'value' in example ? example.value : example,
    }))
    .filter((example) => example.value !== undefined)
}

interface ImplicitAuth {
  security: Array<RawObject>
  schemes: Record<string, RawObject>
}

/**
 * The credential for operations whose spec has no `security` at root or on the operation, as Mintlify shows it:
 * the site's docs.json `api.mdx.auth`, which the site author declared for every API page. Nothing is inferred from
 * the spec's own components. A spec that declares `security` (even `[]`, a public operation) never reaches this.
 */
function implicitAuthFor(): ImplicitAuth | null {
  const auth = getApiMdxConfig().auth
  const name = auth?.method === 'key' ? auth.name : 'Authorization'
  if (!auth || !name) return null
  const scheme = auth.method === 'key' ? { type: 'apiKey', in: 'header', name } : { type: 'http', scheme: auth.method }
  return { security: [{ [name]: [] }], schemes: { [name]: scheme } }
}

function normalizeSecurity(raw: unknown): Array<Array<NormalizedSecurityRequirement>> {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((requirement) => {
      if (!requirement || typeof requirement !== 'object') {
        return null
      }
      return Object.entries(requirement as Record<string, unknown>)
        .map(([name, scopes]) => ({
          name,
          scopes: Array.isArray(scopes) ? (scopes.filter((scope): scope is string => typeof scope === 'string') as Array<string>) : [],
        }))
        .filter((entry) => entry.name.length > 0)
    })
    .filter((group): group is Array<NormalizedSecurityRequirement> => Array.isArray(group) && group.length > 0)
}

function resolveSecurityScheme(
  schemes: Record<string, RawObject>,
  name: string,
  resolveRef: (ref: string) => RawObject | null,
): RawObject | null {
  const scheme = schemes[name]
  if (!scheme) return null
  if (typeof scheme.$ref === 'string') {
    const ref = scheme.$ref as string
    const parts = ref.split('/')
    const refName = parts[parts.length - 1]
    return schemes[refName] ?? resolveRef(ref)
  }
  return scheme
}

/**
 * The credentials the operation accepts, one per distinct scheme in its
 * security requirements. A token is prefilled only from the site's own
 * `apiPlayground.credentials`; there is never a placeholder key.
 */
function buildAuthSchemes(
  security: Array<Array<NormalizedSecurityRequirement>>,
  securitySchemes: Record<string, RawObject>,
  resolveRef: (ref: string) => RawObject | null,
): Array<NormalizedAuthScheme> {
  const credentials = getApiPlaygroundCredentials()
  const result: Array<NormalizedAuthScheme> = []
  for (const requirement of security.flat()) {
    if (result.some((entry) => entry.name === requirement.name)) continue
    const scheme = resolveSecurityScheme(securitySchemes, requirement.name, resolveRef)
    if (!scheme) continue
    const configured = credentials[requirement.name]
    const description = typeof scheme.description === 'string' ? scheme.description : undefined
    const base = { name: requirement.name, description }
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      result.push({ ...base, kind: 'bearer', in: 'header', paramName: 'Authorization', prefill: configured?.replace(/^Bearer /, '') })
    } else if (scheme.type === 'http' && scheme.scheme === 'basic') {
      result.push({ ...base, kind: 'basic', in: 'header', paramName: 'Authorization', prefill: configured?.replace(/^Basic /, '') })
    } else if (scheme.type === 'apiKey' && typeof scheme.name === 'string' && (scheme.in === 'header' || scheme.in === 'query' || scheme.in === 'cookie')) {
      result.push({ ...base, kind: 'apiKey', in: scheme.in, paramName: scheme.name, prefill: configured })
    }
  }
  return result
}

function resolveGroup({
  tags,
  override,
  config,
  isWebhook,
}: {
  tags: Array<string>
  override?: OperationOverride
  config: ApiSpecConfig
  isWebhook: boolean
}) {
  if (override?.group) {
    return override.group
  }
  if (isWebhook) {
    return config.webhookGroup ?? 'Webhooks'
  }
  if (config.tagsOrder?.length) {
    const target = config.tagsOrder
      .map((tag) => tag.toLowerCase())
      .find((orderedTag) => tags.some((operationTag) => operationTag.toLowerCase() === orderedTag))
    if (target) {
      return tags.find((tag) => tag.toLowerCase() === target) ?? target
    }
  }
  if (tags.length > 0) {
    return tags[0]
  }
  return config.defaultGroup ?? 'Endpoints'
}

function buildSlugSegments(path: string, method: string, isWebhook: boolean): Array<string> {
  const cleaned = path
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase())

  if (!cleaned.length) {
    cleaned.push('root')
  }

  if (isWebhook && cleaned[0] !== 'webhooks') {
    cleaned.unshift('webhooks')
  }

  cleaned.push(method.toLowerCase())
  return cleaned
}

function buildOperationId(specId: string, slug: Array<string>, isWebhook: boolean) {
  const prefix = isWebhook ? 'webhook' : 'endpoint'
  return [prefix, specId, ...slug].join('-').replace(/-+/g, '-')
}

/** A `$ref` fragment is URI-encoded (`Pet%20Store`); malformed escapes stay as written. */
function decodeFragmentSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function createSchemaResolver(document: RawObject) {
  return function resolveRef(ref: string): RawObject | null {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) {
      return null
    }
    const pathSegments = ref
      .slice(2)
      .split('/')
      .map((segment) => decodeFragmentSegment(segment).replace(/~1/g, '/').replace(/~0/g, '~'))

    let current: unknown = document
    for (const segment of pathSegments) {
      if (!current || typeof current !== 'object' || !(segment in (current as Record<string, unknown>))) {
        return null
      }
      current = (current as Record<string, unknown>)[segment]
    }
    return current && typeof current === 'object' ? (current as RawObject) : null
  }
}

function buildParameterSampleValue(
  schema: Record<string, unknown> | undefined,
  resolveRef: (ref: string) => RawObject | null,
  required: boolean,
): string {
  const value = schema ? buildSchemaExample(schema, resolveRef) : undefined
  if (value === undefined || value === null) {
    return required ? 'required-value' : ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

