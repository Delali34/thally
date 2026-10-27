/**
 * Heading ids, the anchors of `<ParamField>` and `<ResponseField>` (as Mintlify
 * serves them), and the ids other components give themselves, which those
 * anchors must not repeat.
 *
 * Kept here, dependency-free, because the MDX heading pass runs in the runtime
 * source generator, which cannot rely on `@thallylabs/core` being built. These
 * MUST stay identical to `numberHeadingIds`, `fieldAnchorBase`, `fieldAnchorName`,
 * `uniqueFieldId`, `numberFieldIds`, `accordionAnchorId`, `accordionChildrenId`,
 * `componentIds` and `constantString` in `@thallylabs/core` (packages/core/src/slugify.ts):
 * `thally check` uses that copy, and a mismatch breaks links to a heading or field.
 */

import { plainInlineText } from './inline-code'

/**
 * Ids for a page's headings, in document order: `foo`, `foo-2`, `foo-3`. Each
 * target's `base` is the id its author fixed (`explicit`) or the slug of its
 * text. An explicit id keeps its spelling and is reserved for the whole page, so
 * a generated id never takes it, wherever it sits. A target with no base (text
 * that slugifies to nothing) gets none. `used` holds every id given, which a
 * page's fields are numbered against.
 */
export function numberHeadingIds(targets: ReadonlyArray<{ base: string; explicit: boolean }>): { ids: Array<string | undefined>; used: Set<string> } {
  const reserved = new Set(targets.flatMap(({ base, explicit }) => (explicit && base ? [base] : [])))
  const used = new Set<string>()
  const occurrences = new Map<string, number>()
  const ids = targets.map(({ base, explicit }) => {
    if (!base) return undefined
    let id = base
    let occurrence = 1
    if (explicit) {
      while (used.has(id)) id = `${base}-${++occurrence}`
    } else {
      occurrence = occurrences.get(base) ?? 0
      do id = ++occurrence === 1 ? base : `${base}-${occurrence}`
      while (used.has(id) || reserved.has(id))
      occurrences.set(base, occurrence)
    }
    used.add(id)
    return id
  })
  return { ids, used }
}

/**
 * Anchor base of a `<ParamField>` or `<ResponseField>`, as Mintlify serves it:
 * `param-` and the field's name in kebab case, for both components. A camel-case
 * boundary starts a new word (`expiresInDays`, `GitHub`), any run of characters
 * that are not letters or digits separates words (`ratelimits[].name`,
 * `--root-key`, `utm_campaign`), and digits stay with the letters before them
 * (`latency_p75`). Undefined when the name leaves nothing to spell.
 */
export function fieldAnchorBase(name: string): string | undefined {
  const words = name
    .normalize('NFC')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/(^-|-$)/g, '')
  return words ? `param-${words}` : undefined
}

/** The part of an MDX `{…}` node that `constantString` reads: MDX keeps the expression's syntax tree in `data.estree`. */
interface ExpressionNode {
  data?: {
    estree?: {
      body?: Array<{
        type?: string
        expression?: { type?: string; value?: unknown; expressions?: Array<unknown>; quasis?: Array<{ value?: { cooked?: string | null } }> }
      }>
    }
  }
}

/**
 * The string a `{…}` node always evaluates to, when its whole content is a string
 * literal or a template literal with no `${}`: `title={"Param name"}` hands a
 * component the same string as `title="Param name"`, and `{"Param name"}` in a
 * heading renders the same text as `Param name`. Null for any other expression,
 * a comment, a number, or a node that carries no syntax tree.
 */
export function constantString(node: unknown): string | null {
  const body = (node as ExpressionNode | null | undefined)?.data?.estree?.body
  if (body?.length !== 1 || body[0].type !== 'ExpressionStatement') return null
  const expression = body[0].expression
  if (expression?.type === 'Literal' && typeof expression.value === 'string') return expression.value
  if (expression?.type === 'TemplateLiteral' && expression.expressions?.length === 0) return expression.quasis?.[0]?.value?.cooked ?? null
  return null
}

/** Attributes that name a field, in the order the component shows them. */
const FIELD_NAME_ATTRIBUTES = new Map([
  ['ParamField', ['path', 'query', 'header', 'body', 'name']],
  ['ResponseField', ['name']],
])

/**
 * The name a field element shows, which its anchor is made from. `attribute`
 * reads one literal attribute: a string, or `null` for a value that is not one
 * (an expression). Undefined for any other tag and for a field with no name.
 */
export function fieldAnchorName(tag: string, attribute: (name: string) => string | null | undefined): string | undefined {
  for (const name of FIELD_NAME_ATTRIBUTES.get(tag) ?? []) {
    const value = attribute(name)
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * The anchor of one field on a page, given the ids the page already uses. A
 * repeat is numbered from `-1` in document order (`param-app-id`,
 * `param-app-id-1`, `param-app-id-2`), and the numbering is shared by both
 * components. The id is recorded in `used`.
 */
export function uniqueFieldId(base: string, used: Set<string>): string {
  let id = base
  for (let occurrence = 1; used.has(id); occurrence++) id = `${base}-${occurrence}`
  used.add(id)
  return id
}

/**
 * The anchors of a page's fields, in document order. `bases` are the fields'
 * anchor bases and `used` the ids the page's headings already took. `authored`
 * holds every `id` an author wrote on the page (a field, a Step whose title is
 * plain text, a Card, an HTML element); each is reserved here, after the
 * headings are numbered, so a generated id never repeats one and no heading id
 * moves. An authored id itself is kept as written by the caller.
 */
export function numberFieldIds(bases: Iterable<string>, used: Set<string>, authored: Iterable<string>): Array<string> {
  for (const id of authored) used.add(id)
  return [...bases].map((base) => uniqueFieldId(base, used))
}

/** ASCII-only kebab case, how an `<Accordion>` spells an id from its title and an `<Update>` from its label. */
function asciiAnchor(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Id of an `<Accordion>`'s `<details>`: the `id` its author gave, else its
 * title in ASCII kebab case. Undefined with neither (a title with no ASCII
 * letters, say), where the component falls back to a React id.
 */
export function accordionAnchorId(props: { id?: string; title?: string }): string | undefined {
  return props.id || asciiAnchor(plainInlineText(props.title ?? '')) || undefined
}

/** Id of the body of the `<Accordion>` whose own id is `accordionId`. */
export function accordionChildrenId(accordionId: string): string {
  return `${accordionId}-accordion-children`
}

/** Id of an `<Update>` entry, as `updateAnchorId` in `@thallylabs/core` spells it: an explicit `id`, else its label, else its date. */
function updateAnchorId(props: { id?: string; label?: string; date?: string }): string | undefined {
  return props.id || (props.label ? asciiAnchor(props.label) : '') || (props.date ? asciiAnchor(props.date) : '') || undefined
}

/**
 * The ids a component gives its own elements from its literal attributes, which a
 * `<ParamField>` or `<ResponseField>` anchor must not repeat: an `<Accordion>`'s
 * and its body's, and an `<Update>`'s. `attribute` reads one literal attribute as
 * in `fieldAnchorName`; a value MDX computes is unknown here, so the id it would
 * make is not listed. No other built-in component derives an id from text: the
 * rest set none or take a React `useId()` (`:r1:`, `_R_0_`), which never reads
 * like a field's `param-…`.
 */
export function componentIds(tag: string, attribute: (name: string) => string | null | undefined): Array<string> {
  const literal = (name: string): string | undefined => {
    const value = attribute(name)
    return typeof value === 'string' ? value : undefined
  }
  // An `id` that is an expression holds something only the page knows, and it replaces the id the title or label would make.
  if (attribute('id') === null) return []
  if (tag === 'Accordion') {
    const id = accordionAnchorId({ id: literal('id'), title: literal('title') })
    return id ? [id, accordionChildrenId(id)] : []
  }
  if (tag === 'Update') {
    const id = updateAnchorId({ id: literal('id'), label: literal('label'), date: literal('date') })
    return id ? [id] : []
  }
  return []
}
