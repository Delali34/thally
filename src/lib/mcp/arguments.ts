/** Validate the registry's flat browser inputs before any credentialed request. */

interface ArgumentMetadata { inputSchema: Record<string, unknown> }

/** Enforce supported schema kinds; unknown kinds fail closed as tools evolve. */
export function validateToolArguments(metadata: ArgumentMetadata, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object.')
  const args = value as Record<string, unknown>
  const properties = (metadata.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = (metadata.inputSchema.required ?? []) as Array<string>
  for (const key of required) if (!Object.hasOwn(args, key)) throw new Error(`Provide "${key}".`)
  for (const [key, input] of Object.entries(args)) {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (!property) throw new Error(`Unknown argument "${key}".`)
    if (property.type === 'string') {
      if (typeof input !== 'string') throw new Error(`"${key}" must be a string.`)
      if ((required.includes(key) || property.minLength) && !input.trim()) throw new Error(`"${key}" must not be empty.`)
      if (typeof property.minLength === 'number' && input.trim().length < property.minLength) throw new Error(`"${key}" is too short.`)
      if (typeof property.maxLength === 'number' && input.length > property.maxLength) throw new Error(`"${key}" is too long.`)
    } else if (property.type === 'number' || property.type === 'integer') {
      if (typeof input !== 'number' || !Number.isFinite(input) || (property.type === 'integer' && !Number.isSafeInteger(input))) throw new Error(`"${key}" must be a finite ${property.type}.`)
    } else throw new Error(`Unsupported argument schema for "${key}".`)
  }
  return args
}
