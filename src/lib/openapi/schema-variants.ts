/** Schema shapes shared by the API page and the Try it form: allOf merging and oneOf/anyOf variants. */

function isSchema(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

/** The object members of a schema's `oneOf` (else `anyOf`); null when it has none. */
function unionMembers(schema: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const list = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null
  const members = list?.filter(isSchema)
  return members?.length ? members : null
}

/** The part of a schema that fragments of an allOf contribute to the merged one. */
function structure({ properties, required, type }: Record<string, unknown>) {
  return { properties, required, type }
}

/** Adds the properties, required names and type of plain, already flat fragments to `base`. */
function mergeFragments(base: Record<string, unknown>, fragments: Array<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  const mergedProps: Record<string, unknown> = {}
  const mergedRequired: string[] = []

  for (const f of fragments) {
    if (f.properties && typeof f.properties === 'object') {
      Object.assign(mergedProps, f.properties as Record<string, unknown>)
    }
    if (Array.isArray(f.required)) {
      mergedRequired.push(...(f.required as string[]))
    }
    if (!merged.type && f.type) merged.type = f.type
  }

  if (Object.keys(mergedProps).length > 0) {
    merged.properties = { ...((merged.properties as Record<string, unknown>) ?? {}), ...mergedProps }
  }
  if (mergedRequired.length > 0) {
    const existing = Array.isArray(merged.required) ? (merged.required as string[]) : []
    merged.required = [...new Set([...existing, ...mergedRequired])]
  }
  return merged
}

/**
 * The most variants one schema is flattened to when unions are combined. The largest union in the Infisical spec has
 * 108 members, so a single union around shared fields keeps one tab per member. Combining unions multiplies their
 * members (24 unions of two make 16.7 million), so past this their fields are listed once instead.
 */
const MAX_VARIANTS = 128

function fragmentsOf({ allOf, anyOf, oneOf }: { allOf: Array<unknown>; anyOf?: unknown; oneOf?: unknown }) {
  return [...allOf, ...(anyOf || oneOf ? [{ anyOf, oneOf }] : [])].filter(isSchema)
}

const product = (counts: Array<number>) => counts.reduce((total, count) => total * count, 1)

/** Whether the unions among these fragments, whose members number `counts`, are too many to pair every member. */
const pairsTooMany = (counts: Array<number>) => counts.filter((count) => count > 1).length > 1 && product(counts) > MAX_VARIANTS

/** How many variants flattening gives a schema, counted without building them: members add up and combined unions multiply. */
function variantCount(schema: Record<string, unknown>): number {
  if (Array.isArray(schema.allOf)) {
    const counts = fragmentsOf(schema as { allOf: Array<unknown> }).map(variantCount)
    return pairsTooMany(counts) ? 1 : product(counts)
  }
  return unionMembers(schema)?.reduce((total, member) => total + variantCount(member), 0) ?? 1
}

/**
 * One schema that lists every field of a union's members once, for when pairing them is too much. A field is required
 * only when every member requires it, and a field two members share keeps the later member's schema.
 */
function alternatives(schema: Record<string, unknown>): Record<string, unknown> {
  const members = unionMembers(schema)
  if (!members) return schema
  const flats = members.map((member) => alternatives(flattenSchema(member)))
  const requiredBy = flats.map(({ required }) => (Array.isArray(required) ? (required as string[]) : []))
  const own: Record<string, unknown> = { ...schema, anyOf: undefined, oneOf: undefined }
  const required = [...(Array.isArray(own.required) ? (own.required as string[]) : []), ...requiredBy.reduce((a, b) => a.filter((name) => b.includes(name)))]
  return mergeFragments(required.length ? { ...own, required } : own, flats.map((flat) => ({ ...flat, required: undefined })))
}

/**
 * Merges allOf fragments into a single flat schema so the renderer can
 * iterate over a unified properties map instead of checking each fragment.
 *
 * A oneOf/anyOf that is a fragment of the allOf (or sits beside it) is never dropped. With one
 * member the schema is that member with the properties around it. With several, the result is a union whose members
 * each carry the properties around it, so the renderer lists them as it lists any other union.
 * Two unions give every pairing of their members, up to MAX_VARIANTS; beyond that the fields of all their members are
 * listed together, each once.
 */
export function flattenSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.allOf)) return schema

  const { allOf, ...own } = schema as { allOf: Array<unknown> } & Record<string, unknown>
  const { anyOf, oneOf, ...rest } = own
  const fragments = fragmentsOf({ allOf, anyOf, oneOf }).map(flattenSchema)
  if (pairsTooMany(fragments.map(variantCount))) return mergeFragments(rest, fragments.map(alternatives))
  const at = fragments.findIndex((fragment) => unionMembers(fragment))
  // Without members the anyOf or oneOf is kept as the schema had it.
  if (at < 0) return mergeFragments(own, fragments)

  const members = unionMembers(fragments[at]) as Array<Record<string, unknown>>
  // What the union fragment holds besides its members is shared by all of them.
  const shared = { ...fragments[at], anyOf: undefined, oneOf: undefined }
  const withMember = (member: Record<string, unknown>) => fragments.flatMap((fragment, index) => (index === at ? [shared, member] : [fragment]))

  // The union has no type or properties of its own: each member lists them, with its own title and description.
  const outer = { ...rest }
  for (const key of ['properties', 'required', 'type']) delete outer[key]
  const variants = members.map((member) => {
    const flat = flattenSchema(member)
    const memberOwn = { ...flat }
    for (const key of ['properties', 'required', 'type']) delete memberOwn[key]
    return flattenSchema({ ...memberOwn, allOf: [structure(rest), ...withMember(structure(flat))] })
  })
  // One member is no union: the schema is that member, with every keyword it has.
  return variants.length === 1 ? { ...variants[0], ...outer } : { ...outer, anyOf: variants }
}

export interface SchemaVariant {
  /** The variant's own title, or its discriminator value. */
  label?: string
  schema: Record<string, unknown>
}

export function unionVariants(schema: Record<string, unknown>): Array<SchemaVariant> | null {
  const entries = unionMembers(schema)
  if (!entries) return null
  const discriminator = (schema.discriminator as { propertyName?: unknown } | undefined)?.propertyName
  return entries.flatMap((entry) => {
    const flat = flattenSchema(entry)
    // A variant that is only a union itself is spread into this one, as live does.
    const inner = flat.properties ? null : unionVariants(flat)
    if (inner) return inner
    const property = typeof discriminator === 'string' ? (flat.properties as Record<string, Record<string, unknown>> | undefined)?.[discriminator] : undefined
    const value = property?.const ?? (Array.isArray(property?.enum) ? property.enum[0] : undefined)
    return [{
      label: typeof flat.title === 'string' ? flat.title : value !== undefined ? String(value) : undefined,
      schema: flat,
    }]
  })
}
