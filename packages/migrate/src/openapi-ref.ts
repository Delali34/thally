/** Page `openapi:` frontmatter helpers: the optional spec prefix and its rewrite. */

export interface OpenApiPageRef {
  /** Spec file/URL as authored, without surrounding quotes. */
  specRef?: string
  /** `METHOD /path` or `webhook name`. */
  operation: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  return (quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)
    ? trimmed.slice(1, -1).trim()
    : trimmed
}

/** Split `openapi: "[spec] METHOD /path"` or `openapi: "[spec] webhook name"`. */
export function splitOpenApiRef(raw: string): OpenApiPageRef | null {
  const value = unquote(raw)
  const match = /^(?:(.+?)\s+)?((?:webhook\s+[^\s/]\S*)|(?:[A-Za-z]+\s+\/.*))$/i.exec(value)
  if (!match) return null
  const specRef = match[1] ? unquote(match[1]) : undefined
  return { ...(specRef ? { specRef } : {}), operation: match[2] }
}

/**
 * A local spec reference in its one comparable spelling: no query or fragment,
 * `/` separators, no leading `./` or `/`. Letter case is kept; each comparison
 * decides its own case rule. Page resolution and operation withholding both
 * read refs through this, so a spelling one of them accepts cannot slip past
 * the other. Not for URLs, whose query can be part of the address.
 */
export function canonicalSpecRef(specRef: string): string {
  return specRef.trim().split(/[?#]/, 1)[0].replace(/\\/g, '/').replace(/^(?:\.?\/+)+/, '')
}

/** A spec reference with a URL scheme: matched by its address, never as a repository path. */
export function isRemoteSpecRef(specRef: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(specRef)
}

/** The name the renderer matches a spec by: the lowercase file name, without directories. */
export function specRefBaseName(specRef: string): string {
  return canonicalSpecRef(specRef).split('/').filter(Boolean).pop()?.toLowerCase() ?? ''
}

/**
 * A spec a page's `openapi:` prefix can name. Pages name the file as it is in
 * the source, so a spec is matched by `sourcePath` (`filename` stands in only
 * when that is unknown); `filename`, the name it was migrated under, may have
 * been changed to avoid a collision and is never matched.
 */
export interface SpecCandidate {
  sourcePath?: string
  filename: string
}

export type SpecRefResolution<T extends SpecCandidate> =
  | { kind: 'match'; spec: T }
  | { kind: 'ambiguous'; candidates: Array<T> }
  | { kind: 'none' }

/** `v3-openapi.yaml` -> `v3-openapi`: Mintlify's `openapi: "v3-openapi POST /x"` leaves the extension out. */
export function withoutSpecExtension(value: string): string {
  return value.replace(/\.(?:json|ya?ml)$/i, '')
}

/**
 * The spec a page's `openapi:` prefix names. Tried in order: the exact path;
 * the one file with that name (any letter case, any directory); the one file
 * whose name has that stem. A tier that fits several files is `ambiguous`,
 * never a guess. Specs sharing a source path are one candidate. With
 * `anyFolder` off, a prefix that names a folder must match its path exactly.
 */
export function resolveSpecRef<T extends SpecCandidate>(specRef: string, candidates: ReadonlyArray<T>, anyFolder = true): SpecRefResolution<T> {
  const key = canonicalSpecRef(specRef)
  const byId = new Map<string, T>()
  for (const candidate of candidates) {
    const id = candidate.sourcePath ?? candidate.filename
    if (!byId.has(id)) byId.set(id, candidate)
  }
  const unique = [...byId.values()]
  const exact = unique.find((candidate) => candidate.sourcePath === key)
  if (exact) return { kind: 'match', spec: exact }
  if (!anyFolder && key.includes('/')) return { kind: 'none' }
  const name = specRefBaseName(key)
  const names = unique.map((candidate) => specRefBaseName(candidate.sourcePath ?? candidate.filename))
  for (const fits of [unique.filter((_, index) => names[index] === name), unique.filter((_, index) => withoutSpecExtension(names[index]) === name)]) {
    if (fits.length === 1) return { kind: 'match', spec: fits[0] }
    if (fits.length > 1) return { kind: 'ambiguous', candidates: fits }
  }
  return { kind: 'none' }
}

/** The local spec prefix of a page's `openapi:` value (a remote spec is matched by its URL elsewhere). */
function localSpecRef(openapi: string | undefined): string | undefined {
  const specRef = openapi ? splitOpenApiRef(openapi)?.specRef : undefined
  return specRef && !isRemoteSpecRef(specRef) ? specRef : undefined
}

/** The one of `specs` a page's `openapi:` prefix names; none for a bare operation, a remote spec, or a name that fits no spec or several. */
export function specNamedByPage<T extends SpecCandidate>(openapi: string | undefined, specs: ReadonlyArray<T>): T | undefined {
  const specRef = localSpecRef(openapi)
  const resolved = specRef ? resolveSpecRef(specRef, specs) : undefined
  return resolved?.kind === 'match' ? resolved.spec : undefined
}

/** Whether a page's `openapi:` prefix fits more than one of `specs`. */
export function namesSeveralSpecs(openapi: string | undefined, specs: ReadonlyArray<SpecCandidate>): boolean {
  const specRef = localSpecRef(openapi)
  return Boolean(specRef) && resolveSpecRef(specRef!, specs).kind === 'ambiguous'
}

/** Rewrite a page's spec prefix to the location the migrated spec was written to. */
export function withSpecRef(ref: OpenApiPageRef, specRef: string): string {
  return `${specRef} ${ref.operation}`
}
