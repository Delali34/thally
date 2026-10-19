/**
 * Inline code in title strings (a component `title`, a page `description`).
 *
 * Mintlify renders the text between backticks as code. Renderers wrap the code
 * runs; anchors, outlines and meta tags read the plain text, so every consumer
 * agrees on what a title says.
 *
 * Kept here, dependency-free, because the MDX heading pass runs in the runtime
 * source generator, which cannot rely on `@thallylabs/core` being built. These
 * MUST stay identical to `inlineCodeParts` and `plainInlineText` in
 * `@thallylabs/core` (packages/core/src/slugify.ts): the content parser and
 * `thally check` use that copy, and a mismatch breaks in-page anchor links.
 */

/** One `code` span; the backticks are markup, the text between them is what renders. */
const INLINE_CODE = /`([^`\n]+)`/g

/** Split a title string into plain text and `inline code` runs, in order. */
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
