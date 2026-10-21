/** OpenAPI form projection and validation shared by the Try it UI and controller. */
import { flattenSchema, unionVariants } from '@/lib/openapi/schema-variants'
import { isFormEditable, schemaKind } from '@/lib/openapi/body-form'
import { isSendableScheme } from '@/lib/openapi/auth'
import type { NormalizedOperation } from '@/lib/openapi/types'

export interface TryItField {
  id: string
  name: string
  group: 'path' | 'query' | 'header' | 'body'
  type: string
  required: boolean
  description?: string
  schema: Record<string, unknown>
  isCredential?: boolean
  authSchemeName?: string
}

/** Keep authentication headers private, including custom API-key header names. */
export function isCredentialHeader(operation: NormalizedOperation, name: string): boolean {
  return (operation.authSchemes ?? []).some((scheme) => isSendableScheme(scheme) && scheme.paramName.toLowerCase() === name.toLowerCase()) || /authorization|api[-_]?key|token|secret/i.test(name)
}

/** Project flat object properties; nested values retain a JSON editor. */
export function getTryItFields(operation: NormalizedOperation): TryItField[] {
  const fields: TryItField[] = (operation.authSchemes ?? []).filter(isSendableScheme).map((scheme) => ({
    id: `auth:${scheme.name}`, name: scheme.paramName, group: 'header', type: scheme.kind === 'bearer' ? 'Bearer token' : scheme.kind === 'basic' ? 'Basic credentials' : 'API key', required: operation.parameters.header.some((parameter) => parameter.required && parameter.name.toLowerCase() === scheme.paramName.toLowerCase()), schema: {}, description: scheme.description, isCredential: true, authSchemeName: scheme.name,
  }))
  for (const group of ['path', 'query', 'header'] as const) {
    const names = new Set([...Object.keys(operation.prefill[group]), ...operation.parameters[group].map((parameter) => parameter.name)])
    if (group === 'path') for (const match of operation.path.matchAll(/{([^}]+)}/g)) names.add(match[1])
    for (const name of names) {
      if (group === 'header' && fields.some((field) => field.authSchemeName && field.name.toLowerCase() === name.toLowerCase())) continue
      const parameter = operation.parameters[group].find((item) => item.name === name)
      const schema = parameter?.schema ?? {}
      const isCredential = group === 'header' && isCredentialHeader(operation, name)
      fields.push({ id: `${group}:${name}`, name, group, schema, type: schemaKind(schema) ?? 'string', required: group === 'path' || Boolean(parameter?.required), description: parameter?.description, isCredential })
    }
  }
  // Credential alternatives are enforced by the server; do not require every scheme.
  if (!['GET', 'HEAD'].includes(operation.method.toUpperCase()) && operation.requestBody) {
    const media = operation.requestBody.contents[0]
    const schema = flattenSchema(media?.schema ?? {})
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      const required = Array.isArray(schema.required) ? schema.required : []
      for (const [name, raw] of Object.entries(schema.properties)) {
        const property = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
        fields.push({ id: `body:${name}`, name, group: 'body', schema: property, type: schemaKind(property) ?? 'string', required: required.includes(name), description: typeof property.description === 'string' ? property.description : undefined })
      }
    } else {
      fields.push({ id: 'body:__raw', name: 'Request body', group: 'body', schema, type: /json/.test(media?.mediaType ?? '') ? 'json' : 'string', required: operation.requestBody.required, description: operation.requestBody.description })
    }
  }
  return fields
}

/** Parse a JSON object without discarding unknown properties when editing a field. */
export function parseBodyObject(body: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

/** Match control text to the declared JSON type; invalid text stays editable. */
export function fieldJsonValue(field: TryItField, value: string): unknown {
  if (Array.isArray(field.schema.enum)) {
    const index = field.schema.enum.findIndex((item) => String(item) === value)
    if (index >= 0) return field.schema.enum[index]
  }
  if (value === 'null' && (field.schema.nullable === true || (Array.isArray(field.schema.type) && field.schema.type.includes('null')))) return null
  if (field.type === 'number' || field.type === 'integer') return value.trim() && Number.isFinite(Number(value)) ? Number(value) : value
  if (field.type === 'boolean') return value === 'true' ? true : value === 'false' ? false : value
  if (field.type === 'object' || field.type === 'array') {
    try { return JSON.parse(value) } catch { return value }
  }
  return value
}

/** Validate required values and declared scalar types before a real network call. */
export function validateTryItFields(fields: TryItField[], values: Record<string, string>, options: { isBodyOmitted?: boolean } = {}): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    if (field.group === 'body' && options.isBodyOmitted) continue
    const value = values[field.id] ?? ''
    if (!value.trim()) {
      if (field.required) errors[field.id] = 'Required'
      continue
    }
    if (field.group === 'body' && value === 'null' && (field.schema.nullable === true || (Array.isArray(field.schema.type) && field.schema.type.includes('null')))) continue
    if (field.isCredential && /YOUR_(API_KEY|BASE64_CREDENTIALS)/.test(value)) errors[field.id] = 'Enter your credentials'
    else if ((field.type === 'number' || field.type === 'integer') && (!Number.isFinite(Number(value)) || (field.type === 'integer' && !Number.isInteger(Number(value))))) errors[field.id] = `Enter ${field.type === 'integer' ? 'an integer' : 'a number'}`
    else if (field.type === 'boolean' && !['true', 'false'].includes(value)) errors[field.id] = 'Choose true or false'
    else if (Array.isArray(field.schema.enum) && !field.schema.enum.some((item) => String(item) === value)) errors[field.id] = 'Choose a listed value'
    else if (['json', 'object', 'array'].includes(field.type)) {
      try {
        const parsed: unknown = JSON.parse(value)
        const jsonType = field.type === 'json' ? field.schema.type : field.type
        if (jsonType === 'array' && !Array.isArray(parsed)) errors[field.id] = 'Enter a JSON array'
        if (jsonType === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) errors[field.id] = 'Enter a JSON object'
        if (jsonType === 'string' && typeof parsed !== 'string') errors[field.id] = 'Enter a JSON string'
        if (jsonType === 'boolean' && typeof parsed !== 'boolean') errors[field.id] = 'Enter a JSON boolean'
        if ((jsonType === 'number' || jsonType === 'integer') && (typeof parsed !== 'number' || (jsonType === 'integer' && !Number.isInteger(parsed)))) errors[field.id] = 'Enter a JSON number'
      } catch { errors[field.id] = 'Enter valid JSON' }
    }
  }
  return errors
}

/** Populate declared defaults in both the form and actual request, avoiding preview drift. */
export function initialTryItParameters(operation: NormalizedOperation, group: 'path' | 'query' | 'header'): Record<string, string> {
  const values = { ...operation.prefill[group] }
  for (const parameter of operation.parameters[group]) {
    if (values[parameter.name] === undefined && parameter.schema?.default !== undefined) values[parameter.name] = String(parameter.schema.default)
  }
  return values
}

/** Seed JSON property defaults without replacing customer-authored example properties. */
export function initialTryItBody(operation: NormalizedOperation): string {
  const fields = getTryItFields(operation).filter((field) => field.group === 'body')
  if (!fields.length || fields[0].id === 'body:__raw') return operation.prefill.body ?? ''
  const values = parseBodyObject(operation.prefill.body ?? '')
  for (const field of fields) if (values[field.name] === undefined && field.schema.default !== undefined) values[field.name] = field.schema.default
  return operation.prefill.body || Object.keys(values).length || operation.requestBody?.required ? JSON.stringify(values, null, 2) : ''
}

/** Preserve the runtime's full schema editor for nested values, unions, and files. */
export function usesStructuredBodyForm(operation: NormalizedOperation): boolean {
  const schema = operation.requestBody?.contents[0]?.schema
  if (!schema || !isFormEditable(schema)) return false
  const flat = flattenSchema(schema)
  if (unionVariants(flat)) return true
  const properties = flat.properties as Record<string, Record<string, unknown>> | undefined
  return Object.values(properties ?? {}).some((property) => {
    const kind = schemaKind(property)
    return kind === 'object' || kind === 'array' || property.format === 'binary' || Boolean(unionVariants(property))
  })
}
