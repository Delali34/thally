/** Static responsive-image projection; source attributes never become expressions. */
export interface MigrationImageCandidate {
  url: string
  descriptor: string
}

/** Resolve an image URL without accepting credentials or active URL schemes. */
export function migrationImageUrl(value: string, base: URL): string {
  const url = new URL(value, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Responsive image URL is not a credential-free HTTP(S) URL.')
  return url.toString()
}

/**
 * Parse URL tokens before descriptors, preserving commas inside URL tokens.
 * Data URLs are intentionally rejected by migrationImageUrl rather than split.
 */
export function migrationImageCandidates(value: string, base: URL, resolve = true): Array<MigrationImageCandidate> {
  if (value.length > 64_000) throw new Error('Responsive image candidate list exceeds its safety bound.')
  const result: Array<MigrationImageCandidate> = []
  let index = 0
  while (index < value.length) {
    while (index < value.length && /[\t\n\f\r ,]/.test(value[index])) index++
    if (index === value.length) break
    const start = index
    while (index < value.length && !/[\t\n\f\r ]/.test(value[index])) index++
    let url = value.slice(start, index)
    const hasTerminatingComma = url.endsWith(',')
    if (hasTerminatingComma) url = url.replace(/,+$/, '')
    const descriptorStart = index
    if (!hasTerminatingComma) while (index < value.length && value[index] !== ',') index++
    const descriptor = hasTerminatingComma ? '' : value.slice(descriptorStart, index).trim()
    if (descriptor && !/^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) throw new Error('Responsive image has an unsupported descriptor.')
    if (descriptor.endsWith('x') && Number(descriptor.slice(0, -1)) <= 0) throw new Error('Responsive image density must be positive.')
    const resolved = migrationImageUrl(url, base)
    result.push({ url: resolve ? resolved : url, descriptor })
    if (result.length > 128) throw new Error('Responsive image has too many candidates.')
    if (value[index] === ',') index++
  }
  if (!result.length) throw new Error('Responsive image has no candidates.')
  return result
}

/** Serialize normalized candidates with their authored width/density choices. */
export function renderMigrationSrcset(candidates: Array<MigrationImageCandidate>): string {
  return candidates.map((candidate) => `${candidate.url}${candidate.descriptor ? ` ${candidate.descriptor}` : ''}`).join(', ')
}

/** Encode literal JSX attributes; entity decoding happens after syntax parsing. */
export function migrationImageAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;')
}
