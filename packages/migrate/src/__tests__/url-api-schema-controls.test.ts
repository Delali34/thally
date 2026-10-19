/** Schema coverage requires operation evidence and publisher semantics together. */
import { describe, expect, it } from 'vitest'
import { runUrlMigration } from '../url-run.js'
import { apiSchemaTabGroups, apiSchemaDisclosureGroups, apiOperationCodeControls } from '../url-api-schema-controls.js'

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


const childSchema = { type: 'object', properties: { configuration: { type: 'object', properties: { enabled: { type: 'boolean' } } } } }
function childDisclosure(name = 'configuration', extra = '') {
  return `<span data-component-part="field-name">${name}</span><details class="expandable" data-component-part="expandable"><summary aria-controls="children" aria-expanded="false" data-component-part="expandable-button">Child attributes</summary><div id="children" data-component-part="expandable-content">${extra}</div></details>`
}
function operationArticle(content: string) {
  return article(`<span class="method-pill">POST</span><div data-component-part="scroll-area-content">/widgets/{id}</div>${content}`)
}
describe('exact registered schema child disclosures', () => {
  it('covers empty shells only through exact operation, media and property evidence', () => {
    expect(apiSchemaDisclosureGroups(operationArticle(section(childDisclosure())), spec(childSchema), operation)).toEqual([0])
    expect(apiSchemaDisclosureGroups(operationArticle(section(childDisclosure(), 'Response')), spec(schema, childSchema), operation)).toEqual([0])
    const translated = operationArticle(section(childDisclosure(), '正文'))
    expect(apiSchemaDisclosureGroups(translated, spec(childSchema), operation)).toEqual([0])
  })
  it('leaves unknown properties, unrelated details and contradictory selectors unresolved', () => {
    const body = operationArticle(section(childDisclosure()))
    for (const bad of [
      body.replace('>configuration<', '>unknown<'), body.replace('>POST<', '>GET<'),
      body.replace('>/widgets/{id}<', '>/different<'), body.replace('application/json', 'text/plain'),
      body.replace('id="children"', 'id="wrong"'), body.replace('</main>', '<div id="children"></div></main>'),
      operationArticle(section(childDisclosure('configuration', '<p>Unrepresented prose.</p>'))),
      operationArticle('<details class="expandable"><summary>Unknown article alternatives</summary></details>'),
      '<main>' + section(childDisclosure()) + '</main>',
    ]) expect(apiSchemaDisclosureGroups(bad, spec(childSchema), operation)).toEqual([])
    expect(apiSchemaDisclosureGroups(operationArticle(section(childDisclosure(), 'Response', '404')), spec(schema, childSchema), operation)).toEqual([])
    expect(apiSchemaDisclosureGroups(body, spec({ properties: { configuration: { type: 'boolean' } } }), operation)).toEqual([])
  })
  it('binds anonymous array and union child shells through exact literal schema paths', () => {
    const shell = childDisclosure().replace('<span data-component-part="field-name">configuration</span>', '').replace('data-component-part="expandable">', 'data-component-part="expandable" data-testid="body-items-items-children">')
    const body = operationArticle(section('<div class="array-param-field"><span data-component-part="field-name">items</span><div class="object-param-field">' + shell + '</div></div>'))
    const document = spec({ properties: { items: { type: 'array', items: { type: 'object', properties: { enabled: { type: 'boolean' } } } } } })
    expect(apiSchemaDisclosureGroups(body, document, operation)).toEqual([0])
    expect(apiSchemaDisclosureGroups(body.replace('body-items-items-children', 'body-unknown-items-children'), document, operation)).toEqual([])
    expect(apiSchemaDisclosureGroups(body.replace('>items<', '>invented<'), document, operation)).toEqual([])
    const union = spec({ properties: { items: { oneOf: [{ type: 'array', items: { properties: { enabled: { type: 'boolean' } } } }, { type: 'string' }] } } })
    expect(apiSchemaDisclosureGroups(body.replace('body-items-items-children', 'body-items-one-of-0-items-children'), union, operation)).toEqual([0])
    expect(apiSchemaDisclosureGroups(body.replace('body-items-items-children', 'body-items-one-of-1-items-children'), union, operation)).toEqual([])
  })
  it('proves nullable values and flattened allOf paths without covering null or missing branches', () => {
    const shell = childDisclosure().replace('<span data-component-part="field-name">configuration</span>', '').replace('data-component-part="expandable">', 'data-component-part="expandable" data-testid="response-optional-items-one-of-0-items-children">')
    const body = operationArticle(section('<div class="object-param-field">' + shell + '</div>', 'Response'))
    const document = spec(schema, { allOf: [{ properties: { optionalItems: { type: 'array', nullable: true, items: { properties: { enabled: { type: 'boolean' } } } } } }] })
    expect(apiSchemaDisclosureGroups(body, document, operation)).toEqual([0])
    expect(apiSchemaDisclosureGroups(body.replace('one-of-0', 'one-of-1'), document, operation)).toEqual([])
    expect(apiSchemaDisclosureGroups(body.replace('optional-items', 'unknown-items'), document, operation)).toEqual([])
    expect(apiSchemaDisclosureGroups(body, spec(schema, { properties: { optionalItems: { type: 'array', items: { properties: { enabled: { type: 'boolean' } } } } } }), operation)).toEqual([])
  })
  it('binds single status/media badges and typed dictionary children', () => {
    const body = operationArticle(section(childDisclosure(), 'Response').replace('<button aria-haspopup="menu"><span>200</span></button><span>application/json</span>', '<span>200 - application/json</span>'))
    const dictionary = { properties: { configuration: { type: ['object', 'null'], additionalProperties: { type: 'string' } } } }
    expect(apiSchemaDisclosureGroups(body, spec(schema, dictionary), operation)).toEqual([0])
    expect(apiSchemaDisclosureGroups(body.replace('200 - ', '404 - '), spec(schema, dictionary), operation)).toEqual([])
    expect(apiSchemaDisclosureGroups(body.replace('200 - ', 'Unknown - '), spec(schema, dictionary), operation)).toEqual([])
    expect(apiSchemaDisclosureGroups(body.replace('id="children" data-component-part="expandable-content"></div>', 'id="children" data-component-part="expandable-content"><custom-content></custom-content></div>'), spec(schema, dictionary), operation)).toEqual([])
  })
  it('follows nested local schema paths and exact parameter locations', () => {
    const nested = section(`<span data-component-part="field-name">configuration</span><div data-component-part="expandable-content"><div class="object-param-field">${childDisclosure('nested')}</div></div>`)
    const document = spec({ properties: { configuration: { $ref: '#/components/schemas/Configuration' } } })
    Object.assign(document, { components: { schemas: { Configuration: { properties: { nested: { properties: { enabled: { type: 'boolean' } } } } } } } })
    expect(apiSchemaDisclosureGroups(operationArticle(nested), document, operation)).toEqual([0])
    const parameter = operationArticle(section('<span class="param-head" id="query-configuration"></span>' + childDisclosure(), 'Parameters', '', ''))
    const parameterDocument = spec()
    Object.assign(parameterDocument.paths[operation.path].post, { parameters: [{ in: 'query', name: 'configuration', schema: childSchema }] })
    expect(apiSchemaDisclosureGroups(parameter, parameterDocument, operation)).toEqual([0])
    expect(apiSchemaDisclosureGroups(parameter.replace('query-configuration', 'header-configuration'), parameterDocument, operation)).toEqual([])
  })
})


function requestExamples(source = 'authored()', options: { foreign?: boolean; method?: string; changedPanel?: boolean; emptyPanel?: boolean } = {}) {
  const element = (kind: string, props: Record<string, unknown>) => ['$', kind, null, props]
  const panels = [element('div', { 'data-index': 0, children: element('pre', { children: element('code', { children: options.changedPanel ? 'different()' : source }) }) }), element('div', { 'data-index': -1, children: element('pre', { children: element('code', { children: options.emptyPanel ? '' : 'generated()' }) }) })]
  const group = element('div', { className: 'code-group', children: [element('div', { 'data-component-part': 'code-group-tab-bar', children: element('button', { 'aria-haspopup': 'menu', 'aria-expanded': false, children: 'Current language' }) }), ...panels] })
  const samples = [{ lang: 'typescript', source }]
  const provider = ['$', '$L1', null, { openApiReferenceData: { operation: { method: options.method ?? 'post', path: operation.path, codeSamples: samples, 'x-codeSamples': samples } }, children: group }]
  const root = options.foreign ? element('article', { options: [provider], children: 'Article' }) : provider
  const frames = '1:I[0,[],"OpenApiProvider"]\n0:' + JSON.stringify(root) + '\n'
  const script = `<script>self.__next_f.push(${JSON.stringify([1, frames])})</script>`
  const html = `<main><div class="code-group"><div data-component-part="code-group-tab-bar"><button aria-expanded="false" aria-haspopup="menu">Current language</button></div><div data-index="0"><pre><code>${options.changedPanel ? 'different()' : source}</code></pre></div><div data-index="-1"><pre><code>${options.emptyPanel ? '' : 'generated()'}</code></pre></div></div></main>${script}`
  const document = spec()
  Object.assign(document.paths[operation.path].post, { 'x-codeSamples': samples })
  return { html, document, script }
}
describe('registered generated API examples', () => {
  it('covers known provider examples while retaining every authored source byte', () => {
    const { html, document } = requestExamples()
    expect(apiOperationCodeControls(html, document, operation)).toEqual([0])
    const duplicate = html.slice(html.indexOf('<div class="code-group">'), html.indexOf('</main>'))
    expect(apiOperationCodeControls(html.replace('</main>', duplicate.replace('>Current language<', '>Unrelated alternative<') + '</main>'), document, operation)).toEqual([0])
    expect(apiOperationCodeControls(html.replace('</main>', duplicate + '</main>'), document, operation)).toEqual([])
  })
  it('bounds repeated transported source references before copying sample JSON', () => {
    const { html, document, script } = requestExamples()
    const literal = 'a'.repeat(140_000)
    const samples = Array.from({ length: 64 }, () => ({ lang: 'typescript', source: '$a' }))
    const frames = '1:I[0,[],"OpenApiProvider"]\n0:' + JSON.stringify(['$', '$L1', null, { openApiReferenceData: { operation: { method: 'post', path: operation.path, codeSamples: samples, 'x-codeSamples': samples } }, children: null }]) + '\na:T' + Buffer.byteLength(literal).toString(16) + ',' + literal
    const captured = html.replace(script, '<script>self.__next_f.push(' + JSON.stringify([1, frames]) + ')</script>')
    expect(apiOperationCodeControls(captured, document, operation)).toEqual([])
  })
  it('rejects metadata-only providers, wrong operations and missing or changed authored examples', () => {
    for (const options of [{ foreign: true }, { method: 'get' }, { changedPanel: true }, { emptyPanel: true }]) {
      const { html, document } = requestExamples('authored()', options)
      expect(apiOperationCodeControls(html, document, operation)).toEqual([])
    }
    const { html, document } = requestExamples()
    Object.assign(document.paths[operation.path].post, { 'x-codeSamples': [{ lang: 'typescript', source: 'foreign()' }] })
    expect(apiOperationCodeControls(html, document, operation)).toEqual([])
    expect(apiOperationCodeControls(html.replace('code-group-tab-bar', 'custom-control'), document, operation)).toEqual([])
  })
})

/** An anonymized client-rendered API page: inline and desktop request examples. */
function generatedRequestSlots(source = 'authored()') {
  const { html, document } = requestExamples(source)
  const group = html.slice(html.indexOf('<div class="code-group">'), html.indexOf('</main>'))
    .replace('<button aria-expanded="false"', '<span title="Widgets">Widgets</span><button aria-label="Select language" aria-expanded="false"')
  const metadata = { openapi: `post ${operation.path}`, href: '/reference/widgets' }
  const samples = [{ lang: 'typescript', source }]
  const renderer = ['$', '$L3', null, { mdxSource: { compiledSource: 'inert captured source', scope: { pageMetadata: metadata } } }]
  const controller = ['$', '$L2', null, { pageMetadata: metadata, children: renderer }]
  const provider = ['$', '$L1', null, { pageMetadata: metadata, openApiReferenceData: { operation: { method: 'post', path: operation.path, title: 'Widgets', codeSamples: samples, 'x-codeSamples': samples } }, children: controller }]
  const frames = '1:I[0,[],"OpenApiProvider"]\n2:I[0,[],"MDXContentController"]\n3:I[0,[],"default"]\n0:' + JSON.stringify(provider) + '\n'
  const slots = `<main id="content-container"><div id="content-area"><div id="api-playground-2-operation-page"><span class="method-pill">POST</span><div data-component-part="scroll-area-content">${operation.path}</div>${group}</div></div><div id="content-side-layout">${group}</div></main>`
  const script = '<script>self.__next_f.push(' + JSON.stringify([1, frames]) + ')</script>'
  return { html: slots + script, document, group, script }
}

describe('semantic request-example generator slots', () => {
  it('uses the complete operation only in the two uniquely owned client-rendered slots', () => {
    const { html, document } = generatedRequestSlots()
    expect(apiOperationCodeControls(html, document, operation)).toEqual([0, 1])
  })
  it('rejects an ordinary same-code picker, duplicate slot and missing ownership', () => {
    const { html, document, group } = generatedRequestSlots()
    for (const bad of [
      html.replace('</main>', group + '</main>'),
      html.replace('<div id="content-side-layout">', '<div id="content-side-layout">' + group),
      html.replace('id="content-side-layout"', 'id="unowned-sidebar"'),
      html.replace('MDXContentController', 'ForeignController'),
      html.replace('default', 'ForeignRenderer'),
      html.replace('title="Widgets">Widgets', 'title="Unrelated">Unrelated'),
      html.replace('<code>generated()</code>', '<code></code>'),
    ]) { expect(bad).not.toBe(html); expect(apiOperationCodeControls(bad, document, operation)).toEqual([]) }
  })
  it('rejects missing, cyclic and unsupported references anywhere in the rendered root', () => {
    const { html, document, script } = generatedRequestSlots()
    const envelope = JSON.parse(script.slice('<script>self.__next_f.push('.length, -')</script>'.length)) as [number, string]
    const line = envelope[1].match(/0:([^\n]+)\n/)![1]
    const provider = JSON.parse(line)
    for (const [reference, extra] of [['$99', ''], ['$@99', ''], ['$91', '91:"$92"\n92:"$91"\n']]) {
      const frames = envelope[1].replace('0:' + line, '0:' + JSON.stringify([provider, reference])) + extra
      const changed = html.replace(script, '<script>self.__next_f.push(' + JSON.stringify([1, frames]) + ')</script>')
      expect(apiOperationCodeControls(changed, document, operation)).toEqual([])
    }
  })
  it('allows only a single terminal display LF while preserving the exact registered source', () => {
    const { html, document } = generatedRequestSlots('authored()\n')
    const captured = html.replaceAll('<code>authored()\n</code>', '<code>authored()</code>')
    expect(apiOperationCodeControls(captured, document, operation)).toEqual([0, 1])
    expect(apiOperationCodeControls(captured.replaceAll('<code>authored()</code>', '<code>authored( )</code>'), document, operation)).toEqual([])
  })
  it('accepts only a same-href scope hint with an identical resolved route template', () => {
    const { html, document, script } = generatedRequestSlots()
    const envelope = JSON.parse(script.slice('<script>self.__next_f.push('.length, -')</script>'.length)) as [number, string]
    const line = envelope[1].match(/0:([^\n]+)\n/)![1]
    const provider = JSON.parse(line)
    const metadata = provider[3].children[3].children[3].mdxSource.scope.pageMetadata
    for (const [hint, href, expected] of [
      ['post /widgets/{oldId}', '/reference/widgets', [0, 1]],
      ['get /widgets/{oldId}', '/reference/widgets', []],
      ['post /other/{oldId}', '/reference/widgets', []],
      ['post /{oldId}/widgets', '/reference/widgets', []],
      ['post /widgets/{oldId}', '/reference/other', []],
    ] as const) {
      metadata.openapi = hint; metadata.href = href
      const frames = envelope[1].replace('0:' + line, '0:' + JSON.stringify(provider))
      const captured = html.replace(script, '<script>self.__next_f.push(' + JSON.stringify([1, frames]) + ')</script>')
      expect(apiOperationCodeControls(captured, document, operation)).toEqual(expected)
    }
  })
  it('preserves every explicitly declared same-language authored example behind its own chooser', () => {
    const fixture = generatedRequestSlots()
    const envelope = JSON.parse(fixture.script.slice('<script>self.__next_f.push('.length, -')</script>'.length)) as [number, string]
    const line = envelope[1].match(/0:([^\n]+)\n/)![1], provider = JSON.parse(line)
    const samples = [{ lang: 'typescript', label: 'Primary', source: 'authored()' }, { lang: 'typescript', label: 'Secondary', source: 'other()' }]
    provider[3].openApiReferenceData.operation.codeSamples = samples
    provider[3].openApiReferenceData.operation['x-codeSamples'] = samples
    const frames = envelope[1].replace('0:' + line, '0:' + JSON.stringify(provider))
    const document = structuredClone(fixture.document)
    Object.assign(document.paths[operation.path].post, { 'x-codeSamples': samples })
    const picker = '<button aria-label="Select authored example" aria-expanded="false" aria-haspopup="menu">Primary</button>'
    const html = fixture.html.replace(fixture.script, '<script>self.__next_f.push(' + JSON.stringify([1, frames]) + ')</script>')
      .replaceAll('>Current language</button>', '>Current language</button>' + picker)
      .replaceAll('<div data-index="-1">', '<div data-index="1"><pre><code>other()</code></pre></div><div data-index="-1">')
    expect(apiOperationCodeControls(html, document, operation)).toEqual([0, 1, 2, 3])
    expect(apiOperationCodeControls(html.replaceAll('>Primary</button>', '>Unregistered</button>'), document, operation)).toEqual([])
    expect(apiOperationCodeControls(html.replaceAll('<code>other()</code>', '<code>missing()</code>'), document, operation)).toEqual([])
    expect(apiOperationCodeControls(html.replaceAll(picker, picker + picker), document, operation)).toEqual([])
  })
  it('requires every authored snippet in the registered operation and captured panels', () => {
    const { html, document } = generatedRequestSlots()
    const foreign = structuredClone(document)
    Object.assign(foreign.paths[operation.path].post, { 'x-codeSamples': [{ lang: 'typescript', source: 'unmatched()' }] })
    expect(apiOperationCodeControls(html, foreign, operation)).toEqual([])
    expect(apiOperationCodeControls(html.replaceAll('<code>authored()</code>', '<code>changed()</code>'), document, operation)).toEqual([])
  })
})


function legacyRequestSlots() {
  const fixture = generatedRequestSlots()
  const envelope = JSON.parse(fixture.script.slice('<script>self.__next_f.push('.length, -')</script>'.length)) as [number, string]
  const line = envelope[1].match(/0:([^\n]+)\n/)![1], provider = JSON.parse(line)
  const samples = [{ lang: 'typescript', label: 'Primary', source: 'authored()' }, { lang: 'typescript', label: 'Secondary', source: 'hiddenAlternative()' }]
  provider[3].openApiReferenceData.operation.codeSamples = samples
  provider[3].openApiReferenceData.operation['x-codeSamples'] = samples
  const frames = envelope[1].replace('0:' + line, '0:' + JSON.stringify(provider))
  const script = '<script>self.__next_f.push(' + JSON.stringify([1, frames]) + ')</script>'
  const group = '<div data-testid="code-group-select"><div><button aria-expanded="false" aria-haspopup="menu">TypeScript</button><button aria-expanded="false" aria-haspopup="menu">Primary</button></div><div><pre><code>authored()</code></pre></div></div>'
  const document = structuredClone(fixture.document)
  Object.assign(document, { info: { title: 'Widgets', version: '1' } })
  Object.assign(document.paths[operation.path].post, { 'x-codeSamples': samples })
  return { html: fixture.html.replace(fixture.script, script).replaceAll(fixture.group, group), document, group }
}
describe('legacy selected authored request examples', () => {
  it('recovers inactive same-language alternatives from exact provider and registered inventories', () => {
    const { html, document, group } = legacyRequestSlots()
    expect(html).not.toContain('<code>hiddenAlternative()</code>')
    expect(apiOperationCodeControls(html, document, operation)).toEqual([0, 1, 2, 3])
    for (const bad of [
      html.replaceAll('<code>authored()</code>', '<code>unmatched()</code>'),
      html.replaceAll('>Primary</button>', '>Unregistered</button>'),
      html.replaceAll('>TypeScript</button>', '>Unrelated language</button>'),
      html.replace('</main>', group + '</main>'),
      html.replace('<div id="content-side-layout">', '<div id="content-side-layout">' + group),
    ]) expect(apiOperationCodeControls(bad, document, operation)).toEqual([])
  })
  it.each([false, true])('retains every inactive authored byte in the registered local specification (missing: %s)', async missing => {
    const { html, document } = legacyRequestSlots()
    if (missing) Object.assign(document.paths[operation.path].post, { 'x-codeSamples': [{ lang: 'typescript', label: 'Primary', source: 'authored()' }] })
    const result = await runUrlMigration({ sourceUrl: 'https://docs.example.test/reference/widgets', captureProvider: { capture: async ({ url }) => {
      if (url.pathname === '/reference/widgets.md') return { finalUrl: url, contentType: 'text/markdown', body: '# Widgets\n\n```json POST /widgets/{id}\n' + JSON.stringify(document) + '\n```' }
      if (url.pathname === '/reference/widgets') return { finalUrl: url, contentType: 'text/html', body: '<html><head><link rel="alternate" type="text/markdown" href="/reference/widgets.md"></head><body>' + html.replace('<div id="content-area">', '<div id="content-area"><h1>Widgets</h1><p>Complete widget request documentation.</p>') + '</body></html>' }
      throw new Error('Missing discovery index')
    } } })
    expect(result.validation.status).toBe(missing ? 'partial' : 'passed')
    const asset = result.bundle.assets.find(asset => asset.path.startsWith('openapi/'))!
    expect(asset).toBeTruthy()
    const stored = JSON.parse(Buffer.from(asset.content).toString())
    expect(stored.paths[operation.path].post['x-codeSamples']).toEqual(document.paths[operation.path].post['x-codeSamples'])
    if (!missing) expect(Buffer.from(asset.content).toString()).toContain('hiddenAlternative()')
    else expect(result.validation.issues.some(issue => issue.code === 'unsupported-component')).toBe(true)
  })
})
