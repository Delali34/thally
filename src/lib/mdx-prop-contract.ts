/**
 * What the props of a registered MDX component may hold.
 *
 * The MDX interpreter evaluates attributes statically, so an author can pass
 * JSX, a number, a bare attribute or an object to any prop. A global list of
 * prop names cannot say which of those a given component survives: `title` is
 * drawn as a node by `Card` but trimmed as text by `GitHub.Repo`, and a
 * `.trim()` on an element takes the whole page down. The component's own
 * contract can, so the registry declares one for each component that reads a
 * prop as something other than a node, and the interpreter's sanitizer
 * consults it. A component without a contract keeps the global rules, which
 * is what site-registered components get.
 *
 * The contract rides on the component function itself, under a registry
 * symbol, so it is found by identity: a site component that reuses a built-in
 * name does not inherit it, and it is found even if this module is bundled
 * twice.
 */
import { isValidElement } from 'react'

/** What one prop accepts. A rejected value is dropped unless the rule has a `fallback`. */
export interface PropRule {
  accepts: (value: unknown) => boolean
  /** Stands in for a rejected value, for a prop the component cannot render without. */
  fallback?: string
}

export type PropContract = Readonly<Record<string, PropRule>>

const CONTRACT = Symbol.for('thally.mdx.propContract')

/** What React accepts as a child; any other object throws when it is rendered. */
export function isRenderableNode(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.every(isRenderableNode)
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || isValidElement(value)
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every(isString)

/** A string, for a prop the component calls string methods on or builds a URL or an id from. */
export const text: PropRule = { accepts: isString }
/** Text the component cannot render without: a rejected value becomes the empty string an authored `src=""` gives. */
export const requiredText: PropRule = { accepts: isString, fallback: '' }
/** An array of strings, for a prop the component maps over. */
export const textList: PropRule = { accepts: isStringList }
/** One string or an array of strings. */
export const textOrList: PropRule = { accepts: (value) => isString(value) || isStringList(value) }
/** Anything React can draw, for a prop the component renders as a node under a name the global node list lacks. */
export const node: PropRule = { accepts: isRenderableNode }
/** One of a fixed set of words, for a prop that picks a tag or a variant. */
export function oneOf(...words: Array<string>): PropRule {
  return { accepts: (value) => isString(value) && words.includes(value) }
}

/** Declare the contract of `component`; returns it for chaining. */
export function withPropContract<T>(component: T, contract: PropContract): T {
  if (typeof component === 'function' || (typeof component === 'object' && component !== null)) {
    Object.defineProperty(component, CONTRACT, { value: contract, configurable: true })
  }
  return component
}

/** The contract declared on an element type, if any. */
export function propContractOf(type: unknown): PropContract | undefined {
  if (typeof type !== 'function' && (typeof type !== 'object' || type === null)) return undefined
  return (type as { [CONTRACT]?: PropContract })[CONTRACT]
}
