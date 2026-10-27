import { describe, expect, it } from 'vitest'
import { flattenSchema, unionVariants } from '@/lib/openapi/schema-variants'

// The shapes a generated spec gives a connection endpoint: the credentials sit in a union (one member or several) that
// is one fragment of an allOf, the name and description in another.
const shared = { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] }
const assumeRole = {
  type: 'object',
  properties: { method: { type: 'string', enum: ['assume-role'] }, credentials: { type: 'object', properties: { roleArn: { type: 'string' } } } },
  required: ['method', 'credentials'],
}
const accessKey = {
  type: 'object',
  properties: { method: { type: 'string', enum: ['access-key'] }, credentials: { type: 'object', properties: { accessKeyId: { type: 'string' } } } },
  required: ['method', 'credentials'],
}

describe('flattenSchema with a union inside allOf', () => {
  it('merges a union that has one variant, so its properties are listed with the rest', () => {
    const flat = flattenSchema({ allOf: [{ anyOf: [assumeRole] }, shared] })
    expect(Object.keys(flat.properties as object)).toEqual(['method', 'credentials', 'name', 'description'])
    expect(flat.required).toEqual(['method', 'credentials', 'name'])
    expect(flat.type).toBe('object')
  })

  it('gives every variant of a union the properties around it', () => {
    const flat = flattenSchema({ allOf: [{ anyOf: [assumeRole, accessKey] }, shared] })
    expect(flat.properties).toBeUndefined()
    expect(flat.type).toBeUndefined()
    const variants = unionVariants(flat)
    expect(variants).toHaveLength(2)
    for (const { schema } of variants ?? []) {
      expect(Object.keys(schema.properties as object).sort()).toEqual(['credentials', 'description', 'method', 'name'])
      expect(schema.required).toEqual(['method', 'credentials', 'name'])
    }
    expect((variants?.[1].schema.properties as Record<string, { enum: string[] }>).method.enum).toEqual(['access-key'])
  })

  it('does the same when the union comes after the shared object, and for oneOf', () => {
    const flat = flattenSchema({ allOf: [shared, { oneOf: [assumeRole, accessKey] }] })
    expect(unionVariants(flat)?.map(({ schema }) => Object.keys(schema.properties as object).sort())).toEqual([
      ['credentials', 'description', 'method', 'name'],
      ['credentials', 'description', 'method', 'name'],
    ])
  })

  it('keeps the title of a variant as its label and the description of the union', () => {
    const flat = flattenSchema({
      description: 'The connection.',
      allOf: [{ anyOf: [{ ...assumeRole, title: 'Assume role' }, { ...accessKey, title: 'Access key' }] }, shared],
    })
    expect(flat.description).toBe('The connection.')
    expect(unionVariants(flat)?.map((variant) => variant.label)).toEqual(['Assume role', 'Access key'])
  })

  it('combines two unions into every pairing of their variants', () => {
    const flat = flattenSchema({
      allOf: [
        { anyOf: [assumeRole, accessKey] },
        { anyOf: [{ type: 'object', properties: { region: { type: 'string' } } }, { type: 'object', properties: { zone: { type: 'string' } } }] },
      ],
    })
    expect(unionVariants(flat)?.map(({ schema }) => Object.keys(schema.properties as object).sort())).toEqual([
      ['credentials', 'method', 'region'],
      ['credentials', 'method', 'zone'],
      ['credentials', 'method', 'region'],
      ['credentials', 'method', 'zone'],
    ])
  })

  it('flattens an allOf inside a variant and one inside a nested allOf fragment', () => {
    const flat = flattenSchema({
      allOf: [
        { allOf: [{ anyOf: [{ allOf: [{ type: 'object', properties: { a: {} } }, { type: 'object', properties: { b: {} } }] }, accessKey] }] },
        shared,
      ],
    })
    expect(unionVariants(flat)?.map(({ schema }) => Object.keys(schema.properties as object).sort())).toEqual([
      ['a', 'b', 'description', 'name'],
      ['credentials', 'description', 'method', 'name'],
    ])
  })

  it('keeps the own properties of a schema that has both allOf and a union', () => {
    const flat = flattenSchema({ type: 'object', properties: { id: { type: 'string' } }, allOf: [{ anyOf: [assumeRole, accessKey] }] })
    expect(unionVariants(flat)?.every(({ schema }) => 'id' in (schema.properties as object))).toBe(true)
  })

  it('leaves an allOf of plain objects as one object', () => {
    const flat = flattenSchema({ allOf: [assumeRole, shared] })
    expect(Object.keys(flat.properties as object)).toEqual(['method', 'credentials', 'name', 'description'])
    expect(flat.anyOf).toBeUndefined()
  })
})

describe('flattenSchema with a union that has one member', () => {
  it('keeps every keyword of the member, not only its fields', () => {
    const member = {
      type: 'array',
      description: 'The ids.',
      nullable: true,
      items: { type: 'object', properties: { id: { type: 'string' } } },
    }
    const flat = flattenSchema({ allOf: [{ minItems: 1 }], oneOf: [member] })
    expect(flat).toMatchObject(member)
  })

  it('keeps enum, format, additionalProperties and the schema\'s own keywords', () => {
    const flat = flattenSchema({
      description: 'The mode.',
      allOf: [{ type: 'object' }],
      anyOf: [{ type: 'object', additionalProperties: { type: 'string' }, properties: { mode: { type: 'string', format: 'slug', enum: ['a', 'b'] } } }],
    })
    expect(flat.description).toBe('The mode.')
    expect(flat.additionalProperties).toEqual({ type: 'string' })
    expect((flat.properties as Record<string, unknown>).mode).toEqual({ type: 'string', format: 'slug', enum: ['a', 'b'] })
  })

  it('keeps an anyOf or oneOf that has no schema to merge', () => {
    expect(flattenSchema({ allOf: [{ type: 'object' }], oneOf: [] }).oneOf).toEqual([])
  })
})

// Each fragment is a union of two objects: n fragments make 2^n pairings of members.
const pairings = (count: number, extra: Array<Record<string, unknown>> = []) => ({
  allOf: [
    ...Array.from({ length: count }, (_, i) => ({
      anyOf: [
        { type: 'object', properties: { ['a' + i]: { type: 'string' } }, required: ['a' + i] },
        { type: 'object', properties: { ['b' + i]: { type: 'string' } } },
      ],
    })),
    ...extra,
  ],
})
const names = (count: number) => Array.from({ length: count }, (_, i) => ['a' + i, 'b' + i]).flat()

describe('flattenSchema with many unions inside allOf', () => {
  it('still gives every pairing when there are few enough to read as tabs', () => {
    expect(unionVariants(flattenSchema(pairings(7)))).toHaveLength(128)
  })

  it('lists every field once instead of every pairing when the pairings pass the budget', () => {
    const flat = flattenSchema(pairings(8))
    expect(unionVariants(flat)).toBeNull()
    expect(Object.keys(flat.properties as object)).toEqual(names(8))
    expect(flat.type).toBe('object')
  })

  it('does not build 65,536 variants for sixteen unions, nor 16.7 million for twenty-four', () => {
    for (const count of [16, 24]) {
      const flat = flattenSchema(pairings(count))
      expect(unionVariants(flat)).toBeNull()
      expect(Object.keys(flat.properties as object)).toEqual(names(count))
    }
  })

  it('requires a field only if every alternative and the schema around them require it', () => {
    const both = [{ required: ['kind'] }, { required: ['kind'] }]
    const flat = flattenSchema(
      pairings(8, [{ type: 'object', properties: { name: { type: 'string' }, kind: {} }, required: ['name'] }, { anyOf: both }]),
    )
    // a0 to a7 are required by one member of their union only; kind by every member of its own.
    expect([...(flat.required as string[])].sort()).toEqual(['kind', 'name'])
  })

  it('keeps a union with many members as tabs when it is the only one around the shared fields', () => {
    const members = Array.from({ length: 108 }, (_, i) => ({ type: 'object', properties: { ['kind' + i]: { type: 'string' } } }))
    const variants = unionVariants(flattenSchema({ allOf: [{ anyOf: members }, shared] }))
    expect(variants).toHaveLength(108)
    expect(Object.keys(variants?.[107].schema.properties as object).sort()).toEqual(['description', 'kind107', 'name'])
  })

  it('merges the members of a nested union as alternatives too', () => {
    const nested = { allOf: [{ anyOf: [{ properties: { x: {} } }, { properties: { y: {} } }] }, { anyOf: [{ properties: { z: {} } }, { properties: { w: {} } }] }] }
    const flat = flattenSchema({ allOf: [...pairings(8).allOf, { anyOf: [nested, { properties: { v: {} } }] }] })
    expect(Object.keys(flat.properties as object).sort()).toEqual([...names(8), 'x', 'y', 'z', 'w', 'v'].sort())
  })
})
