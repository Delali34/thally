/** Regression coverage for schema-derived Try it controls and preflight validation. */
import { describe, expect, it } from 'vitest'
import type { NormalizedOperation } from '@/lib/openapi/types'
import { fieldJsonValue, getTryItFields, initialTryItBody, initialTryItParameters, isCredentialHeader, parseBodyObject, validateTryItFields } from './try-it-fields'

const operation: NormalizedOperation = {
  id: 'create-page', key: 'POST /pages/{project_id}', specId: 'example', title: 'Create page', method: 'POST', path: '/pages/{project_id}', isWebhook: false, group: 'Pages', tags: [], servers: [{ url: 'https://api.example.com' }], security: [[{ name: 'apiKey', scopes: [] }]], authSchemes: [{ name: 'bearer', kind: 'bearer', in: 'header', paramName: 'Authorization' }, { name: 'apiKey', kind: 'apiKey', in: 'header', paramName: 'X-Custom-Credential' }],
  parameters: { path: [], query: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }], header: [], cookie: [] },
  prefill: { path: {}, query: {}, header: { Authorization: 'Bearer YOUR_API_KEY', 'X-Custom-Credential': 'YOUR_API_KEY', 'Content-Type': 'application/json' }, cookie: {}, body: '{}' }, responses: [],
  requestBody: { required: true, contents: [{ mediaType: 'application/json', examples: [], schema: { type: 'object', required: ['title', 'published'], properties: { title: { type: 'string', description: 'Page title' }, published: { type: 'boolean', default: false }, status: { type: 'string', enum: ['draft', 'published'] }, metadata: { type: 'object' }, tags: { type: 'array' } } } }] },
}

describe('Try it fields', () => {
  it('includes path placeholders and declared parameters without examples', () => {
    const fields = getTryItFields(operation)
    expect(fields.find((field) => field.id === 'path:project_id')).toMatchObject({ required: true, type: 'string' })
    expect(fields.find((field) => field.id === 'query:limit')).toMatchObject({ type: 'integer' })
    expect(fields.find((field) => field.id === 'body:status')?.schema.enum).toEqual(['draft', 'published'])
    expect(fields.find((field) => field.id === 'body:published')?.schema.default).toBe(false)
  })

  it('recognizes custom auth headers without treating media headers as credentials', () => {
    expect(isCredentialHeader(operation, 'X-Custom-Credential')).toBe(true)
    expect(isCredentialHeader(operation, 'Authorization')).toBe(true)
    expect(isCredentialHeader(operation, 'Content-Type')).toBe(false)
    expect(isCredentialHeader(operation, 'Accept')).toBe(false)
  })

  it('rejects missing fields and placeholder credentials before a real request', () => {
    const fields = getTryItFields(operation)
    const errors = validateTryItFields(fields, { 'auth:bearer': 'Bearer YOUR_API_KEY' })
    expect(errors['path:project_id']).toBe('Required')
    expect(errors['body:title']).toBe('Required')
    expect(errors['auth:bearer']).toBe('Enter your credentials')
    expect(errors['header:Content-Type']).toBeUndefined()
    expect(errors['auth:apiKey']).toBeUndefined()
  })

  it('accepts false and zero, validates enum and nested JSON types', () => {
    const fields = getTryItFields(operation)
    const values = { 'path:project_id': 'project', 'auth:bearer': 'Bearer real', 'auth:apiKey': 'key', 'body:title': 'Title', 'body:published': 'false', 'query:limit': '0', 'body:status': 'draft', 'body:metadata': '{}', 'body:tags': '[]' }
    expect(validateTryItFields(fields, values)).toEqual({})
    expect(validateTryItFields(fields, { ...values, 'query:limit': '1.5', 'body:status': 'unknown', 'body:metadata': '[]', 'body:tags': '{}' })).toMatchObject({ 'query:limit': 'Enter an integer', 'body:status': 'Choose a listed value', 'body:metadata': 'Enter a JSON object', 'body:tags': 'Enter a JSON array' })
  })

  it('preserves numeric, boolean, object and array JSON values', () => {
    const fields = getTryItFields(operation)
    expect(fieldJsonValue(fields.find((field) => field.id === 'query:limit')!, '0')).toBe(0)
    expect(fieldJsonValue(fields.find((field) => field.id === 'body:published')!, 'false')).toBe(false)
    expect(fieldJsonValue(fields.find((field) => field.id === 'body:metadata')!, '{"key":"value"}')).toEqual({ key: 'value' })
    expect(fieldJsonValue(fields.find((field) => field.id === 'body:tags')!, '["one"]')).toEqual(['one'])
    expect(parseBodyObject('{"extra":{"untouched":true}}')).toEqual({ extra: { untouched: true } })
  })

  it('does not require every alternative credential or anonymous security group', () => {
    const alternatives = { ...operation, security: [[{ name: 'bearer', scopes: [] }], [{ name: 'apiKey', scopes: [] }]] }
    expect(getTryItFields(alternatives).filter((field) => field.isCredential).every((field) => !field.required)).toBe(true)
    expect(getTryItFields({ ...operation, security: [[], [{ name: 'apiKey', scopes: [] }]] }).filter((field) => field.isCredential).every((field) => !field.required)).toBe(true)
    const single = { ...operation, authSchemes: [operation.authSchemes[0]], prefill: { ...operation.prefill, header: { Authorization: 'Bearer YOUR_API_KEY' } } }
    expect(getTryItFields(single).find((field) => field.id === 'auth:bearer')?.required).toBe(false)
    expect(getTryItFields({ ...single, parameters: { ...single.parameters, header: [{ name: 'Authorization', in: 'header', required: true }] }, security: [] }).find((field) => field.id === 'auth:bearer')?.required).toBe(true)
  })

  it('permits an omitted optional body but validates it once supplied', () => {
    const optional = { ...operation, requestBody: { ...operation.requestBody!, required: false }, security: [] }
    const fields = getTryItFields(optional)
    const values = { 'path:project_id': 'project' }
    expect(validateTryItFields(fields, values, { isBodyOmitted: true })).toEqual({})
    expect(validateTryItFields(fields, values)['body:title']).toBe('Required')
    expect(validateTryItFields(fields, values)['body:published']).toBe('Required')
  })

  it('applies defaults to the actual request as well as form values', () => {
    expect(JSON.parse(initialTryItBody(operation))).toEqual({ published: false })
    expect(initialTryItParameters({ ...operation, parameters: { ...operation.parameters, query: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 10 } }] } }, 'query')).toEqual({ limit: '10' })
  })

  it('validates raw JSON scalar bodies before sending', () => {
    const scalar = { ...operation, requestBody: { required: true, contents: [{ mediaType: 'application/json', examples: [], schema: { type: 'string' } }] } }
    const fields = getTryItFields(scalar).filter((field) => field.group === 'body')
    expect(validateTryItFields(fields, { 'body:__raw': 'hello' })).toEqual({ 'body:__raw': 'Enter valid JSON' })
    expect(validateTryItFields(fields, { 'body:__raw': '123' })).toEqual({ 'body:__raw': 'Enter a JSON string' })
    expect(validateTryItFields(fields, { 'body:__raw': '\"hello\"' })).toEqual({})
  })

  it('uses a raw editor for non-object bodies and hides bodies for GET', () => {
    const bodyOperation = { ...operation, requestBody: { required: true, contents: [{ mediaType: 'application/json', examples: [], schema: { type: 'array' } }] } }
    expect(getTryItFields(bodyOperation).find((field) => field.group === 'body')).toMatchObject({ id: 'body:__raw', required: true, type: 'json' })
    expect(getTryItFields({ ...operation, method: 'GET' }).some((field) => field.group === 'body')).toBe(false)
  })
})


describe('current runtime schema and authorization contracts', () => {
  it('projects auth schemes by their actual header names and omits query/cookie credential inputs', () => {
    const authOperation: NormalizedOperation = { ...operation, authSchemes: [
      { name: 'headerKey', kind: 'apiKey', in: 'header', paramName: 'X-Custom-Credential' },
      { name: 'queryKey', kind: 'apiKey', in: 'query', paramName: 'api_key' },
      { name: 'cookieKey', kind: 'apiKey', in: 'cookie', paramName: 'session' },
    ] }
    const fields = getTryItFields(authOperation)
    expect(fields.find((field) => field.id === 'auth:headerKey')).toMatchObject({ group: 'header', name: 'X-Custom-Credential', authSchemeName: 'headerKey' })
    expect(fields.some((field) => field.id === 'auth:queryKey' || field.id === 'auth:cookieKey')).toBe(false)
  })

  it('flattens allOf request properties and preserves the first declared media type', () => {
    const composed = { ...operation, requestBody: { required: true, contents: [{ mediaType: 'multipart/form-data', examples: [], schema: { allOf: [{ type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } }, { type: 'object', properties: { note: { type: 'string' } } }] } }] } }
    expect(getTryItFields(composed).find((field) => field.id === 'body:file')).toMatchObject({ required: true, schema: { format: 'binary' } })
  })
})


describe('nullable request properties', () => {
  it('retains a declared nullable scalar without rejecting its existing null value', () => {
    const nullable = { ...operation, requestBody: { required: true, contents: [{ mediaType: 'application/json', examples: [], schema: { type: 'object', required: ['count'], properties: { count: { type: ['integer', 'null'] } } } }] } }
    const field = getTryItFields(nullable).find((item) => item.id === 'body:count')!
    expect(field.type).toBe('integer')
    expect(validateTryItFields([field], { 'body:count': 'null' })).toEqual({})
    expect(fieldJsonValue(field, 'null')).toBeNull()
  })
})
