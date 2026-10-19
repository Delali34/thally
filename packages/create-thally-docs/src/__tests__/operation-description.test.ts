/** `thally check` reads the description of the one operation the site resolves a page's `openapi:` reference to, never another's. */

import { describe, expect, it } from 'vitest'

import { operationDescription, parseDocReference, type CheckSpec } from '../openapi-publication.js'

const ok = { responses: { 200: { description: 'ok' } } }
const spec = (source: string, document: Record<string, unknown>, extra: Partial<CheckSpec> = {}): CheckSpec => ({
  source,
  document: { openapi: '3.1.0', info: { title: 't', version: '1' }, ...document },
  ...extra,
})
const describe_ = (reference: string, specs: Array<CheckSpec>) => operationDescription(parseDocReference(reference)!, specs)

describe('operationDescription across specs', () => {
  const primary = spec('openapi/api.yaml', { paths: { '/status': { get: { operationId: 'getStatus', ...ok } } } })
  const secondary = spec('openapi/other.yaml', { paths: { '/status': { get: { description: 'Secondary status.', ...ok } }, '/only-secondary': { get: { description: 'Only here.', ...ok } } } })

  it('does not borrow a later spec\'s description for an undescribed operation of the default spec', () => {
    expect(describe_('GET /status', [primary, secondary])).toBeUndefined()
  })

  it('reads the later spec when the default does not list the operation', () => {
    expect(describe_('GET /only-secondary', [primary, secondary])).toBe('Only here.')
  })

  it('reads only the spec a prefix pins', () => {
    expect(describe_('openapi/other.yaml GET /status', [primary, secondary])).toBe('Secondary status.')
    expect(describe_('openapi/api.yaml GET /status', [primary, secondary])).toBeUndefined()
    expect(describe_('openapi/other.yaml GET /only-secondary', [secondary, primary])).toBe('Only here.')
    expect(describe_('openapi/api.yaml GET /only-secondary', [primary, secondary])).toBeUndefined()
  })

  it('reads the first spec in route order when several describe the operation', () => {
    expect(describe_('GET /status', [secondary, primary])).toBe('Secondary status.')
  })

  it('skips a spec it cannot read and reads the next', () => {
    expect(describe_('GET /only-secondary', [{ source: 'https://example.com/spec.yaml' }, secondary])).toBe('Only here.')
  })
})

describe('operationDescription for hidden and excluded operations', () => {
  const described = (extra: Record<string, unknown>) => ({ description: 'Withheld text.', ...extra, ...ok })

  it('gives no text from an excluded operation', () => {
    const only = spec('openapi.yaml', { paths: { '/a': { get: described({ 'x-excluded': true }) } } })
    expect(describe_('GET /a', [only])).toBeUndefined()
  })

  it('gives no text from a hidden operation, flagged on the operation, the entry or an override', () => {
    const operation = spec('openapi.yaml', { paths: { '/a': { get: described({ 'x-hidden': true }) } } })
    const entry = spec('openapi.yaml', { paths: { '/a': { 'x-hidden': true, get: described({}) } } })
    const overridden = spec('openapi.yaml', { paths: { '/a': { get: described({}) } } }, { overrides: { 'GET /a': { hidden: true } } })
    for (const only of [operation, entry, overridden]) expect(describe_('GET /a', [only])).toBeUndefined()
  })

  it('reads an operation an override reveals', () => {
    const revealed = spec('openapi.yaml', { paths: { '/a': { get: described({ 'x-hidden': true }) } } }, { overrides: { 'GET /a': { hidden: false } } })
    expect(describe_('GET /a', [revealed])).toBe('Withheld text.')
  })

  it('moves on to the next spec when the default spec hides the operation, as the site does', () => {
    const hiding = spec('openapi/api.yaml', { paths: { '/a': { get: described({ 'x-hidden': true }) } } })
    const showing = spec('openapi/other.yaml', { paths: { '/a': { get: { description: 'Visible text.', ...ok } } } })
    expect(describe_('GET /a', [hiding, showing])).toBe('Visible text.')
    expect(describe_('openapi/api.yaml GET /a', [hiding, showing])).toBeUndefined()
  })
})

describe('operationDescription for a webhook with several methods', () => {
  const webhooks = (entry: Record<string, unknown>, extra: Partial<CheckSpec> = {}) => spec('openapi.yaml', { webhooks: { 'order.updated': entry } }, extra)

  it('takes the first method the site lists, sorted by title, not the first method that has text', () => {
    // The site titles a method by summary, else operationId; "alpha" sorts before "zeta" whatever the method order.
    const putFirst = webhooks({ post: { operationId: 'zeta', ...ok }, put: { operationId: 'alpha', description: 'Put text.', ...ok } })
    expect(describe_('webhook order.updated', [putFirst])).toBe('Put text.')
    const postFirst = webhooks({ post: { operationId: 'alpha', ...ok }, put: { operationId: 'zeta', description: 'Put text.', ...ok } })
    expect(describe_('webhook order.updated', [postFirst])).toBeUndefined()
  })

  it('keeps method order for methods tied on group and title', () => {
    const tied = webhooks({ put: { operationId: 'same', description: 'Put text.', ...ok }, post: { operationId: 'same', ...ok } })
    expect(describe_('webhook order.updated', [tied])).toBeUndefined()
  })

  it('sorts by group before title, a method\'s override group included', () => {
    const grouped = webhooks(
      { post: { operationId: 'alpha', ...ok }, put: { operationId: 'zeta', description: 'Put text.', ...ok } },
      { overrides: { 'WEBHOOK PUT order.updated': { group: 'A group' } } },
    )
    expect(describe_('webhook order.updated', [grouped])).toBe('Put text.')
    const named = webhooks(
      { post: { operationId: 'alpha', ...ok }, put: { operationId: 'zeta', description: 'Put text.', ...ok } },
      { webhookGroup: 'Events', overrides: { 'WEBHOOK POST order.updated': { group: 'Zeta group' } } },
    )
    expect(describe_('webhook order.updated', [named])).toBe('Put text.')
  })

  it('skips a hidden or excluded method', () => {
    const hiddenPost = webhooks({ post: { operationId: 'alpha', 'x-hidden': true, description: 'Hidden text.', ...ok }, put: { operationId: 'zeta', ...ok } })
    expect(describe_('webhook order.updated', [hiddenPost])).toBeUndefined()
    const excludedPost = webhooks({ post: { operationId: 'alpha', 'x-excluded': true, description: 'Excluded text.', ...ok }, put: { operationId: 'zeta', description: 'Put text.', ...ok } })
    expect(describe_('webhook order.updated', [excludedPost])).toBe('Put text.')
  })
})
