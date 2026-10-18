/** Schema coverage requires operation evidence and publisher semantics together. */
import { describe, expect, it } from 'vitest'
import { apiSchemaTabGroups } from '../url-api-schema-controls.js'

const operation = { method: 'POST', path: '/widgets/{id}' }
const schema = { oneOf: [{ title: 'Small widget', type: 'object', properties: { size: { const: 'small' } } }, { title: 'Large widget', type: 'object', properties: { size: { const: 'large' } } }] }
function spec(requestSchema: unknown = schema, responseSchema: unknown = schema) {
  return {
    openapi: '3.1.0',
    paths: { [operation.path]: { post: {
      requestBody: { content: { 'application/json': { schema: requestSchema } } },
      responses: { '200': { content: { 'application/json': { schema: responseSchema } } } },
    } } },
  }
}
function tabs(labels = ['Small widget', 'Large widget'], prefix = 'schema') {
  return `<div class="tabs tab-container"><ul role="tablist" data-component-part="tabs-list">${labels.map((label, index) => `<li role="tab" data-component-part="tab" id="${prefix}-tab-${index}" aria-controls="${prefix}-panel-${index}">${label}</li>`).join('')}</ul><div data-component-part="tabs-panels">${labels.map((_label, index) => `<div role="tabpanel" data-component-part="tab-content" id="${prefix}-panel-${index}" aria-labelledby="${prefix}-tab-${index}"></div>`).join('')}</div></div>`
}
function section(content: string, title = 'Body', status = '200', media = 'application/json') {
  return `<div class="api-section"><div class="api-section-heading"><h4 class="api-section-heading-title">${title}</h4>${title.toLowerCase() === 'response' ? `<button aria-haspopup="menu"><span>${status}</span></button>` : ''}<span>${media}</span></div><div class="object-param-field">${content}</div></div>`
}
function article(content: string) {
  return `<main><div id="api-playground-7-operation-page">${content}</div></main>`
}

describe('proven API schema tabs', () => {
  it('covers only operation-root request schema groups in the shared index order', () => {
    const body = article(`<div role="tablist"><button role="tab">Other</button></div>${section(tabs())}`)
    expect(apiSchemaTabGroups(body, spec(), operation)).toEqual([1])
  })

  it('binds response variants through exact status and media selectors', () => {
    expect(apiSchemaTabGroups(article(section(tabs(), 'Response')), spec(), operation)).toEqual([0])
    expect(apiSchemaTabGroups(article(section(tabs(), 'Response', '404')), spec(), operation)).toEqual([])
    expect(apiSchemaTabGroups(article(section(tabs(), 'Response', '200', 'text/plain')), spec(), operation)).toEqual([])
  })

  it('follows local refs and their schema titles, independent of host and method casing', () => {
    const document = {
      ...spec({ $ref: '#/components/schemas/Variants' }),
      components: { schemas: {
        Variants: { oneOf: [{ $ref: '#/components/schemas/Small~1Widget' }, { $ref: '#/components/schemas/Large' }] },
        'Small/Widget': schema.oneOf[0], Large: schema.oneOf[1],
      } },
    }
    const body = article(section(tabs(), 'bOdY'))
    for (const host of ['docs.first.example', 'reference.second.example']) {
      expect(apiSchemaTabGroups(`<html><head><base href="https://${host}/"></head>${body}</html>`, document, { ...operation, method: 'pOsT' })).toEqual([0])
    }
  })

  it('covers unnamed branches using the publisher Option N projection', () => {
    const unnamed = { oneOf: [{ type: 'object', properties: { json: { type: 'array' } } }, { type: 'object', properties: { csv: { type: 'string' } } }] }
    expect(apiSchemaTabGroups(article(section(tabs(['Option 1', 'Option 2']), 'Response')), spec(schema, unnamed), operation)).toEqual([0])
  })

  it('rejects missing, remote, cyclic and unrelated operation references', () => {
    for (const request of [
      { $ref: '#/components/schemas/Missing' },
      { $ref: 'https://schemas.example/spec.json#/Variant' },
    ]) expect(apiSchemaTabGroups(article(section(tabs())), spec(request), operation)).toEqual([])
    const document = { ...spec({ $ref: '#/components/schemas/Loop' }), components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } } }
    expect(apiSchemaTabGroups(article(section(tabs())), document, operation)).toEqual([])
    expect(apiSchemaTabGroups(article(section(tabs())), spec(), { ...operation, method: 'DELETE' })).toEqual([])
    expect(apiSchemaTabGroups(article(section(tabs())), spec(), { ...operation, path: '/other' })).toEqual([])
    expect(apiSchemaTabGroups(article(section(tabs())), { ...spec(), unrelated: { $ref: '#/missing' } }, operation)).toEqual([])
  })

  it('rejects reversed, missing, duplicate and invented branch labels', () => {
    for (const names of [['Large widget', 'Small widget'], ['Small widget'], ['Small widget', 'Small widget'], ['Small widget', 'Custom']]) {
      expect(apiSchemaTabGroups(article(section(tabs(names))), spec(), operation)).toEqual([])
    }
    expect(apiSchemaTabGroups(article(section(tabs(['Option 1', 'Option 2']))), spec(), operation)).toEqual([])
  })

  it('leaves custom article tabs and nested property schemas unresolved', () => {
    const custom = tabs().replaceAll('data-component-part="tabs-list"', 'data-custom="tabs"')
    expect(apiSchemaTabGroups(article(section(custom)), spec(), operation)).toEqual([])
    expect(apiSchemaTabGroups(`<main>${section(tabs())}</main>`, spec(), operation)).toEqual([])
    expect(apiSchemaTabGroups(article(tabs()), spec(), operation)).toEqual([])
    expect(apiSchemaTabGroups(article(section(`<div class="object-param-field">${tabs()}</div>`)), spec(), operation)).toEqual([])
    // A nested property can contain its own section and still use generic root
    // schema labels. Its ancestry must not grant operation-root coverage.
    expect(apiSchemaTabGroups(article(`<div class="object-param-field">${section(tabs())}</div>`), spec(), operation)).toEqual([])
    expect(apiSchemaTabGroups(article(section(tabs(), 'Examples')), spec(), operation)).toEqual([])
  })

  it('requires exact unique empty panel identity and keeps panel controls blocking', () => {
    const content = tabs()
    for (const bad of [
      content.replace('aria-controls="schema-panel-0"', 'aria-controls="missing"'),
      content.replace('aria-labelledby="schema-tab-0"', 'aria-labelledby="wrong"'),
      content.replace('id="schema-panel-1"', 'id="schema-panel-0"'),
      content.replace('aria-labelledby="schema-tab-0"></div>', 'aria-labelledby="schema-tab-0"><form></form></div>'),
    ]) expect(apiSchemaTabGroups(article(section(bad)), spec(), operation)).toEqual([])
    expect(apiSchemaTabGroups(article(section(content) + '<div id="schema-panel-0"></div>'), spec(), operation)).toEqual([])
  })

  it('rejects ambiguous repeated schema groups but allows distinct request and response groups', () => {
    expect(apiSchemaTabGroups(article(section(tabs()) + section(tabs(undefined, 'second'))), spec(), operation)).toEqual([])
    expect(apiSchemaTabGroups(article(section(tabs()) + section(tabs(undefined, 'response'), 'Response')), spec(), operation)).toEqual([0, 1])
  })

  it('bounds recursive or excessive evidence without evaluating source content', () => {
    const document: Record<string, unknown> = spec()
    document.cycle = document
    expect(apiSchemaTabGroups(article(section(tabs())), document, operation)).toEqual([])
    const deep: Record<string, unknown> = spec()
    let cursor = deep
    for (let index = 0; index < 100; index += 1) { cursor.child = {}; cursor = cursor.child as Record<string, unknown> }
    expect(apiSchemaTabGroups(article(section(tabs())), deep, operation)).toEqual([])
  })

  it('leaves excessive source groups and tabs unresolved before proving any coverage', () => {
    const candidate = section(tabs())
    const excessGroups = '<div role="tablist"></div>'.repeat(256)
    expect(apiSchemaTabGroups(article(candidate + excessGroups), spec(), operation)).toEqual([])
    const excessTabs = '<button role="tab">Unrelated</button>'.repeat(1_024)
    expect(apiSchemaTabGroups(article(candidate + excessTabs), spec(), operation)).toEqual([])
    const repeatedSchemas = Array.from({ length: 257 }, (_, index) => section(tabs(undefined, `repeated-${index}`))).join('')
    expect(apiSchemaTabGroups(article(repeatedSchemas), spec(), operation)).toEqual([])
  })
})
