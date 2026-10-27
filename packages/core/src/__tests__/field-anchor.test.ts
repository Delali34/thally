/** `<ParamField>` and `<ResponseField>` anchors follow the ids Mintlify serves, checked against live pages. */

import { describe, expect, it } from 'vitest'
import { accordionAnchorId, componentIds, constantString, fieldAnchorBase, fieldAnchorName, numberFieldIds, numberHeadingIds, uniqueFieldId } from '@thallylabs/core/slugify'

describe('fieldAnchorBase', () => {
  // Each name and id below was read from a live Mintlify page (dub.co, unkey.com, mintlify.com docs).
  it.each([
    ['expiresInDays', 'param-expires-in-days'],
    ['data-attribution-model', 'param-data-attribution-model'],
    ['domain', 'param-domain'],
    ['GitHub', 'param-git-hub'],
    ['autoApply', 'param-auto-apply'],
    ['utm_campaign', 'param-utm-campaign'],
    ['--root-key', 'param-root-key'],
    ['Workspace name', 'param-workspace-name'],
    ['API ID', 'param-api-id'],
    ['IP allow list', 'param-ip-allow-list'],
    ['HTTP', 'param-http'],
    ['pagination.hasMore', 'param-pagination-has-more'],
    ['ratelimits[].name', 'param-ratelimits-name'],
    ['latency_p75', 'param-latency-p75'],
    ['integrations.ga4', 'param-integrations-ga4'],
    ['errors.404', 'param-errors-404'],
    ['variables.[variableName]', 'param-variables-variable-name'],
    ['<custom>', 'param-custom'],
  ])('turns the name %s into %s', (name, id) => {
    expect(fieldAnchorBase(name)).toBe(id)
  })

  // No live page has an acronym run before a capitalised word: these follow the usual camel-case split and are not verified.
  it.each([
    ['userID', 'param-user-id'],
    ['APIKey', 'param-api-key'],
  ])('splits the acronym in %s as %s', (name, id) => {
    expect(fieldAnchorBase(name)).toBe(id)
  })

  it('has no anchor for a name with nothing to spell it', () => {
    for (const name of ['', '  ', '---', '[]']) expect(fieldAnchorBase(name)).toBeUndefined()
  })
})

describe('uniqueFieldId', () => {
  it('numbers repeats from -1 in document order, as Mintlify does for app-id, app-id-1, app-id-2', () => {
    const used = new Set<string>()
    expect(['param-app-id', 'param-app-id', 'param-api-key', 'param-app-id'].map((base) => uniqueFieldId(base, used)))
      .toEqual(['param-app-id', 'param-app-id-1', 'param-api-key', 'param-app-id-2'])
  })

  it('skips an id the page already uses, such as a heading', () => {
    const used = new Set(['param-name', 'param-name-1'])
    expect(uniqueFieldId('param-name', used)).toBe('param-name-2')
    expect(used.has('param-name-2')).toBe(true)
  })
})

describe('numberFieldIds', () => {
  it('skips every authored id and the ids headings took, and records the fields in `used`', () => {
    const used = new Set(['param-name'])
    expect(numberFieldIds(['param-name', 'param-name', 'param-id'], used, ['param-name-1', 'param-id'])).toEqual(['param-name-2', 'param-name-3', 'param-id-1'])
    expect([...used]).toEqual(['param-name', 'param-name-1', 'param-id', 'param-name-2', 'param-name-3', 'param-id-1'])
  })

  it('gives nothing to a page with no field', () => {
    expect(numberFieldIds([], new Set(), ['param-name'])).toEqual([])
  })
})

describe('fieldAnchorName', () => {
  const attributes = (values: Record<string, string | null>) => (name: string) => values[name]

  it('reads a ParamField location before its name, in the order the component shows it', () => {
    expect(fieldAnchorName('ParamField', attributes({ body: 'b', header: 'h', query: 'q', path: 'p', name: 'n' }))).toBe('p')
    expect(fieldAnchorName('ParamField', attributes({ body: 'b', header: 'h', query: 'q' }))).toBe('q')
    expect(fieldAnchorName('ParamField', attributes({ body: 'b', header: 'h' }))).toBe('h')
    expect(fieldAnchorName('ParamField', attributes({ body: 'b', name: 'n' }))).toBe('b')
    expect(fieldAnchorName('ParamField', attributes({ name: 'n' }))).toBe('n')
  })

  it('reads only a ResponseField name, and ignores empty and non-literal values', () => {
    expect(fieldAnchorName('ResponseField', attributes({ name: 'status', body: 'x' }))).toBe('status')
    expect(fieldAnchorName('ParamField', attributes({ body: '', name: null }))).toBeUndefined()
    expect(fieldAnchorName('ParamField', attributes({ path: null, body: 'id' }))).toBe('id')
    expect(fieldAnchorName('Other', attributes({ name: 'n' }))).toBeUndefined()
  })
})

describe('componentIds', () => {
  const attributes = (values: Record<string, string | null>) => (name: string) => values[name]

  it('lists the id of an Accordion and of its body, from its id or else its title as the component spells it', () => {
    expect(componentIds('Accordion', attributes({ title: 'Param name' }))).toEqual(['param-name', 'param-name-accordion-children'])
    expect(componentIds('Accordion', attributes({ title: 'Run `init` first!', id: 'mine' }))).toEqual(['mine', 'mine-accordion-children'])
    expect(accordionAnchorId({ title: "Don't use `Promise.all()`" })).toBe('don-t-use-promise-all')
  })

  it('lists none when the id is an expression, which replaces the id the title or label would make', () => {
    expect(componentIds('Accordion', attributes({ title: 'Param name', id: null }))).toEqual([])
    expect(componentIds('Update', attributes({ label: 'v1.0', id: null }))).toEqual([])
  })

  it('lists none for an Accordion with no literal id and no title that spells one, where the component takes a React id', () => {
    for (const values of [{ title: '日本語' }, { title: null, id: null }, {}]) expect(componentIds('Accordion', attributes(values))).toEqual([])
  })

  it('lists the id of an Update from its id, else its label, else its date', () => {
    expect(componentIds('Update', attributes({ label: 'v1.0', date: '2024-01-01' }))).toEqual(['v1-0'])
    expect(componentIds('Update', attributes({ label: '日本語', date: '2024-01-01' }))).toEqual(['2024-01-01'])
    expect(componentIds('Update', attributes({ label: 'v1.0', id: 'mine' }))).toEqual(['mine'])
    expect(componentIds('Update', attributes({ label: null, date: null }))).toEqual([])
  })

  it('lists none for any other component, whose id is a React one or none', () => {
    for (const tag of ['Card', 'Tabs', 'Tab', 'Expandable', 'Step', 'Tooltip', 'ParamField', '']) {
      expect(componentIds(tag, attributes({ title: 'Param name', id: 'mine', label: 'v1' }))).toEqual([])
    }
  })
})

describe('numberHeadingIds', () => {
  const generated = (base: string) => ({ base, explicit: false })
  const explicit = (base: string) => ({ base, explicit: true })

  it('numbers repeats foo, foo-2, foo-3, keeps every explicit id and reserves it for the whole page', () => {
    const { ids, used } = numberHeadingIds([generated('a'), generated('a'), explicit('a-2'), generated(''), explicit('b'), explicit('b'), generated('a')])
    expect(ids).toEqual(['a', 'a-3', 'a-2', undefined, 'b', 'b-2', 'a-4'])
    expect([...used].sort()).toEqual(['a', 'a-2', 'a-3', 'a-4', 'b', 'b-2'])
  })

  it('gives nothing to a page with no heading', () => {
    expect(numberHeadingIds([])).toEqual({ ids: [], used: new Set() })
  })
})

describe('constantString', () => {
  const expression = (node: object) => ({ data: { estree: { body: [{ type: 'ExpressionStatement', expression: node }] } } })

  it('reads a string literal and a template literal with no ${}', () => {
    expect(constantString(expression({ type: 'Literal', value: 'Param name' }))).toBe('Param name')
    expect(constantString(expression({ type: 'TemplateLiteral', expressions: [], quasis: [{ value: { cooked: 'Param name' } }] }))).toBe('Param name')
  })

  it('reads nothing else', () => {
    expect(constantString(expression({ type: 'TemplateLiteral', expressions: [{ type: 'Identifier' }], quasis: [{ value: { cooked: 'a' } }, { value: { cooked: '' } }] }))).toBeNull()
    expect(constantString(expression({ type: 'Literal', value: 1 }))).toBeNull()
    expect(constantString(expression({ type: 'BinaryExpression' }))).toBeNull()
    expect(constantString({ data: { estree: { body: [] } } })).toBeNull()
    expect(constantString({})).toBeNull()
    expect(constantString(undefined)).toBeNull()
  })
})
