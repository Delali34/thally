/**
 * Slug helper for heading anchors and page ids.
 *
 * Kept dependency-free (no clsx/tailwind-merge) so the framework-agnostic core
 * carries no UI-layer imports. The root app re-exports this from
 * `src/lib/utils` so the whole codebase shares one slugify implementation —
 * heading ids emitted by the content parser must match the ids the MDX renderer
 * assigns to `<h2>`…`<h6>`, or in-page anchor links break.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/(^-|-$)/g, '')
}

/** One `code` span in a title string; the backticks are markup, the text between them is what renders. */
const INLINE_CODE = /`([^`\n]+)`/g

/**
 * Split a title string (a component `title`, a page `description`) into plain
 * text and `inline code` runs, as Mintlify renders them. Renderers wrap the code
 * runs; anchors, outlines and meta tags read {@link plainInlineText}, so every
 * consumer agrees on what the title says.
 */
export function inlineCodeParts(value: string): Array<{ text: string; code: boolean }> {
  const parts: Array<{ text: string; code: boolean }> = []
  let end = 0
  for (const match of value.matchAll(INLINE_CODE)) {
    if (match.index > end) parts.push({ text: value.slice(end, match.index), code: false })
    parts.push({ text: match[1], code: true })
    end = match.index + match[0].length
  }
  if (end < value.length) parts.push({ text: value.slice(end), code: false })
  return parts
}

/** A title string as plain text: each code span without its backticks. */
export function plainInlineText(value: string): string {
  return value.replace(INLINE_CODE, '$1')
}

/** ASCII-only anchor normalization the `<Update>` timeline has always used. */
function normalizeUpdateId(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Anchor id of one `<Update>` changelog entry. The renderer (the `Update` MDX
 * component) and every machine projection (RSS, JSON Feed, MCP `list_changes`)
 * call this one function, so a feed item's `#anchor` always lands on the
 * rendered entry. An explicit `id` wins; otherwise the label is normalized
 * exactly as before (existing deep links keep working). A label with no ASCII
 * letters (e.g. a Japanese release name) falls back to the date, so the entry
 * is still linkable. Undefined when nothing usable remains.
 */
export function updateAnchorId(props: { id?: string; label?: string; date?: string }): string | undefined {
  if (props.id) return props.id
  const fromLabel = props.label ? normalizeUpdateId(props.label) : ''
  if (fromLabel) return fromLabel
  const fromDate = props.date ? normalizeUpdateId(props.date) : ''
  return fromDate || undefined
}
