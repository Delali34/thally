/**
 * Eval-free MDX rendering for the assets content source.
 *
 * Cloudflare Workers forbid code generation from strings (`eval`,
 * `new Function`), so `compileMDX` — which compiles MDX to JavaScript and
 * executes it — cannot run there. This module renders MDX without any code
 * generation: it parses with remark-mdx, runs the exact same remark/rehype
 * pipeline the build uses (including Shiki highlighting), and converts the
 * resulting hast tree straight to React elements with
 * `hast-util-to-jsx-runtime`, resolving `<Component>` tags through the same
 * MDX components map the compiled path uses.
 *
 * The one MDX feature codegen provided that a tree walk cannot is arbitrary
 * JavaScript expressions (`{props.foo}`, `export const x = …`). Those are
 * evaluated statically: literal expressions (strings, numbers, booleans,
 * arrays, objects, negated numbers, expression-free template strings) produce
 * their value; anything else renders as nothing rather than failing the page.
 * Documentation content overwhelmingly uses JSX with literal attributes, so
 * in practice this renders identically to the compiled output.
 */
import type { Root } from 'hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { isValidElement, type ReactNode } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { SKIP, visit } from 'unist-util-visit'

import { parseFrontmatter } from '@/lib/frontmatter'
import { isRenderableNode, propContractOf } from '@/lib/mdx-prop-contract'
import { rehypePlugins } from '@/mdx/rehype'
import { remarkPlugins } from '@/mdx/remark'

/**
 * MDX node types that must survive remark → rehype so the JSX runtime
 * conversion can resolve them against the components map. This is the node
 * set `@mdx-js/mdx` itself passes through.
 */
const MDX_NODE_TYPES = [
  'mdxjsEsm',
  'mdxFlowExpression',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
  'mdxTextExpression',
] as const

interface InterpretMdxInput {
  source: string
  /**
   * The same MDX components map `compileMDX` receives. Typed loosely because
   * `MDXComponents` allows nested maps and intrinsic-element overrides that
   * `hast-util-to-jsx-runtime` types more narrowly; the runtime contract is
   * identical for the flat component names documentation content uses.
   */
  components: Record<string, unknown>
  /** Parse and strip YAML frontmatter before rendering (doc pages do; snippets don't). */
  parseFrontmatter?: boolean
}

interface InterpretMdxResult {
  content: ReactNode
  frontmatter: Record<string, unknown>
}

interface JsxEstree {
  type: string
  name?: string | JsxEstree
  object?: JsxEstree
  property?: JsxEstree
  value?: unknown
  expression?: unknown
  argument?: unknown
  openingElement?: { name: JsxEstree; attributes: Array<JsxEstree> }
  children?: Array<JsxEstree>
}

/** The text rules of JSX: lines are trimmed and blank lines vanish. */
function cleanJsxText(value: string): string {
  const lines = value.split(/\r\n|\n|\r/)
  const lastFilled = lines.findLastIndex((line) => /[^ \t]/.test(line))
  let text = ''
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/g, ' ')
    if (index > 0) trimmed = trimmed.replace(/^ +/, '')
    if (index < lines.length - 1) trimmed = trimmed.replace(/ +$/, '')
    if (trimmed) text += index === lastFilled ? trimmed : `${trimmed} `
  })
  return text
}

/** A lowercase name is an intrinsic tag; anything else resolves in the components map. */
function resolveJsxName(name: JsxEstree | undefined, scope: Record<string, unknown>): unknown {
  if (!name) return undefined
  if (name.type === 'JSXMemberExpression') {
    const object = resolveJsxName(name.object, scope)
    const key = (name.property as JsxEstree | undefined)?.name
    // Own properties only, as in `evaluateStaticExpression`.
    return typeof key === 'string' && (typeof object === 'function' || (typeof object === 'object' && object !== null)) && Object.hasOwn(object, key)
      ? (object as Record<string, unknown>)[key]
      : undefined
  }
  if (name.type !== 'JSXIdentifier' || typeof name.name !== 'string') return undefined
  if (/^[a-z]/.test(name.name)) return name.name
  return Object.hasOwn(scope, name.name) ? scope[name.name] : undefined
}

/**
 * Build the React element of a JSX expression such as `icon={<svg>…</svg>}`.
 * Component props like these are plain JSX in the compiled page, so the
 * interpreter builds them the same way, from the same literal-only attributes.
 */
function evaluateJsxElement(estree: unknown, scope: Record<string, unknown>): unknown {
  const node = estree as JsxEstree
  const children: Array<unknown> = []
  for (const child of node.children ?? []) {
    if (child.type === 'JSXText') {
      const text = cleanJsxText(String(child.value ?? ''))
      if (text) children.push(text)
    } else if (child.type === 'JSXExpressionContainer') {
      const value = evaluateStaticExpression(child.expression, scope)
      if (value !== undefined && isRenderableNode(value)) children.push(value)
    } else if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
      children.push(evaluateJsxElement(child, scope))
    }
  }
  const type = node.type === 'JSXFragment' ? Fragment : resolveJsxName(node.openingElement?.name, scope)
  const props: Record<string, unknown> = {}
  for (const attribute of node.openingElement?.attributes ?? []) {
    if (attribute.type === 'JSXSpreadAttribute') {
      const spread = evaluateStaticExpression(attribute.argument, scope)
      if (typeof spread === 'object' && spread !== null && !Array.isArray(spread) && !isValidElement(spread)) Object.assign(props, spread)
      continue
    }
    if (attribute.type !== 'JSXAttribute' || typeof attribute.name !== 'object' || attribute.name.type !== 'JSXIdentifier') continue
    const value = attribute.value as JsxEstree | null | undefined
    props[attribute.name.name as string] =
      value == null ? true
        : value.type === 'JSXExpressionContainer' ? evaluateStaticExpression(value.expression, scope)
          : evaluateStaticExpression(value, scope)
  }
  if (children.length === 1) props.children = children[0]
  else if (children.length > 1) props.children = children
  return (children.length > 1 ? lenientJsxs : lenientJsx)(
    (type ?? Fragment) as Parameters<typeof jsx>[0],
    props as Parameters<typeof jsx>[1],
  )
}

/**
 * Statically evaluate an estree expression produced by remark-mdx.
 * Only literal shapes are supported — there is deliberately no code
 * execution. Unsupported expressions yield `undefined`, which drops the
 * attribute or renders nothing for a braced expression.
 */
function evaluateStaticExpression(node: unknown, scope: Record<string, unknown>): unknown {
  if (!node || typeof node !== 'object') return undefined
  const expression = node as {
    type: string
    value?: unknown
    name?: string
    operator?: string
    argument?: unknown
    object?: unknown
    property?: { type: string; name?: string; value?: unknown }
    computed?: boolean
    elements?: Array<unknown>
    properties?: Array<unknown>
    quasis?: Array<{ value?: { cooked?: string } }>
    expressions?: Array<unknown>
  }

  switch (expression.type) {
    case 'Literal':
      return expression.value
    // `hast-util-to-jsx-runtime` resolves capitalized MDX JSX names
    // (`<Note>`, `<Steps.Item>`) through the evaluater as Identifier /
    // MemberExpression estrees — never through its `components` option, which
    // only covers literal lowercase tag names. The components map is
    // therefore the identifier scope here.
    case 'Identifier':
      return expression.name !== undefined && Object.hasOwn(scope, expression.name)
        ? scope[expression.name]
        : undefined
    case 'MemberExpression': {
      const object = evaluateStaticExpression(expression.object, scope)
      // Components are functions carrying sub-components as properties
      // (`<Group.Item>`), so functions are valid member-access targets too.
      if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined
      const property = expression.property
      const key = expression.computed
        ? property?.type === 'Literal'
          ? String(property.value)
          : undefined
        : property?.type === 'Identifier'
          ? property.name
          : undefined
      // Own properties only. An inherited lookup would hand content authors
      // `Function` via `<Anything.constructor>`, which React then calls with
      // an attacker-influenced string — the exact code-generation primitive
      // this module exists to avoid.
      if (key === undefined || !Object.hasOwn(object, key)) return undefined
      return (object as Record<string, unknown>)[key]
    }
    case 'UnaryExpression': {
      const argument = evaluateStaticExpression(expression.argument, scope)
      if (expression.operator === '-' && typeof argument === 'number') return -argument
      if (expression.operator === '+' && typeof argument === 'number') return argument
      if (expression.operator === '!') return !argument
      return undefined
    }
    case 'TemplateLiteral':
      if ((expression.expressions?.length ?? 0) > 0) return undefined
      return (expression.quasis ?? []).map((quasi) => quasi.value?.cooked ?? '').join('')
    case 'JSXElement':
    case 'JSXFragment':
      return evaluateJsxElement(expression, scope)
    case 'ArrayExpression':
      return (expression.elements ?? []).map((element) => evaluateStaticExpression(element, scope))
    case 'ObjectExpression': {
      const result: Record<string, unknown> = {}
      for (const property of expression.properties ?? []) {
        const entry = property as {
          type: string
          computed?: boolean
          key?: { type: string; name?: string; value?: unknown }
          value?: unknown
        }
        if (entry.type !== 'Property' || !entry.key) return undefined
        // A computed key (`{[name]: 1}`) depends on a runtime binding. Reading
        // the identifier's text as the literal key would fabricate a prop the
        // author never wrote, so the whole object degrades instead.
        if (entry.computed && entry.key.type !== 'Literal') return undefined
        const key =
          entry.key.type === 'Identifier'
            ? entry.key.name
            : entry.key.type === 'Literal'
              ? String(entry.key.value)
              : undefined
        if (key === undefined || key === '__proto__' || key === '$$typeof') return undefined
        result[key] = evaluateStaticExpression(entry.value, scope)
      }
      return result
    }
    default:
      return undefined
  }
}

/**
 * The evaluater `hast-util-to-jsx-runtime` consults for component names, MDX
 * expression nodes, and expression-valued JSX attributes. Identifiers resolve
 * against the components map; static literals evaluate; programs (leftover
 * `export` statements — imports are stripped before parsing) and everything
 * dynamic evaluate to nothing instead of throwing.
 *
 * `childExpressions` holds the expressions authored in child position
 * (`{…}` between tags). Only those must be renderable nodes: attribute values
 * such as `style={{ … }}` are objects by design and are vetted per prop name
 * by `sanitizeProps`.
 */
function createStaticEvaluater(components: Record<string, unknown>, childExpressions: WeakSet<object>) {
  return () => ({
    evaluateExpression: (expression: unknown) => {
      const value = evaluateStaticExpression(expression, components)
      // React throws on a plain object in child position ("Objects are not
      // valid as a React child"), which would take the whole route down over
      // one authored `{{ a: 1 }}`. Such values render as nothing, matching
      // this module's failure contract.
      if (childExpressions.has(expression as object) && !isRenderableNode(value)) return undefined
      return value
    },
    evaluatePattern: () => undefined,
    evaluateProgram: () => undefined,
  })
}

/**
 * Remove MDX expressions that carry no expression — `{/* a comment *\/}`
 * parses to an estree Program with an empty body, and
 * `hast-util-to-jsx-runtime` reads `program.body[0].type` unguarded, throwing
 * before the evaluater is ever consulted. Comments are ordinary in authored
 * content, so they must render as nothing rather than 500 the page. Returns
 * the expressions that remain in child position for the evaluater.
 */
function dropEmptyExpressions(tree: Root): WeakSet<object> {
  const childExpressions = new WeakSet<object>()
  visit(tree, (node, index, parent) => {
    if (index === undefined || !parent) return
    if (node.type !== 'mdxFlowExpression' && node.type !== 'mdxTextExpression') return
    const program = (node.data as { estree?: { body?: Array<{ expression?: object }> } } | undefined)?.estree
    const expression = program?.body?.[0]?.expression
    if (expression) {
      childExpressions.add(expression)
      return
    }
    parent.children.splice(index, 1)
    return [SKIP, index]
  })
  return childExpressions
}

/** Props the builtin components call string methods on; an object or array there fails the page. */
const STRING_PROPS = new Set([
  'code', 'color', 'colorDark', 'content', 'date', 'filename', 'href', 'img', 'language',
  'name', 'placeholder', 'repo', 'src', 'tag', 'titleSize', 'type',
])
/** Props components draw directly as a node, which React can only do for a renderable value. */
const NODE_PROPS = new Set([
  'children', 'icon', 'cta', 'tip', 'headline', 'title', 'description', 'default',
  'fallback', 'footer', 'subtitle', 'caption', 'heading', 'label',
])
/** Text that is displayed, never loaded, so a leading scheme-like word is only words. */
const DISPLAY_TEXT_PROPS = new Set(['title', 'description', 'label', 'alt'])
/** Schemes a browser would run, or frame as markup authored in the URL. */
const UNSAFE_SCHEME = /^(?:javascript:|vbscript:|data:text\/html)/i
/** Elements React refuses to render with children. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const ANIMATION_TAGS = new Set(['animate', 'set', 'animatetransform', 'animatemotion'])

/** Browsers ignore ASCII whitespace and control characters around and inside a URL scheme. */
function hasUnsafeScheme(value: string): boolean {
  return UNSAFE_SCHEME.test(value.replace(/[\u0000-\u0020]/g, ''))
}

/**
 * Strings, numbers, booleans, null and arrays or plain objects of those. A
 * string under a URL-like key must also carry a safe scheme.
 */
function isPlainData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value !== 'object' || depth > 16) return false
  if (Array.isArray(value)) return value.every((item) => isPlainData(item, depth + 1))
  if ('$$typeof' in value) return false
  return Object.entries(value).every(
    ([key, entry]) =>
      key !== '__proto__' &&
      key !== 'constructor' &&
      !(typeof entry === 'string' && /href|src|url|action|link/i.test(key) && hasUnsafeScheme(entry)) &&
      isPlainData(entry, depth + 1),
  )
}

/**
 * The one gate every element and component created from remote content passes,
 * whether the tag is authored at the top level or nested in an attribute value.
 * Returns the props to render with, or null when the element must not exist.
 *
 * Content here is untrusted, so it must not be able to run script in the page's
 * origin or crash the render. MDX hands attribute names over exactly as
 * authored, while React only recognises the canonical spelling of a URL prop
 * and keeps `on*` strings on custom elements, so nothing here may depend on a
 * key's case: the surviving key is emitted unchanged, and the checks look at
 * the lowercased name and at the value.
 *
 * Dropped: every `on*` prop, `srcDoc`, raw-HTML props, any string value (under
 * any key, bar display text) that begins with `javascript:`, `vbscript:` or
 * `data:text/html` once whitespace and control characters are removed,
 * `<script>`, `<base>`, `<plaintext>`, `<meta http-equiv>`, and SVG animations
 * that retarget a link or event attribute. A component whose URL prop is
 * dropped receives an empty string, as it would for an authored empty value,
 * so it renders its fallback instead of failing on `undefined`. A string
 * `style` is dropped because React throws, and a style object keeps only its
 * string and number entries. A void element such as `<br>` loses its children,
 * which React refuses to render.
 *
 * Objects and arrays are the other way a page fails: React throws on one drawn
 * as a node, and a builtin component calls string methods on a prop it expects
 * to be text. So the node props (`children`, `icon`, ...) keep only renderable
 * values, the string props keep neither, any other component prop keeps plain
 * data (a carousel's `images`, a config object), and a DOM element keeps none
 * apart from `style`.
 *
 * Those lists are global, and one name means different things to different
 * components (`title` is a node to `Card` and text to `GitHub.Repo`), so a
 * component that declares a contract (`@/lib/mdx-prop-contract`) is held to it
 * first: a prop named there keeps only the values its rule accepts, and a
 * rejected value is dropped, so the component renders as it does without the
 * prop, or takes the rule's fallback where it cannot render without one.
 */
function sanitizeProps(type: unknown, props: Record<string, unknown>): Record<string, unknown> | null {
  const isElement = typeof type === 'string'
  const contract = propContractOf(type)
  // A namespace prefix does not make `<svg:script>` anything but a script.
  const tag = isElement ? type.toLowerCase().replace(/^.*:/, '') : ''
  if (tag === 'script' || tag === 'base' || tag === 'plaintext') return null
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    const name = key.toLowerCase()
    if (tag === 'meta' && name.replace('-', '') === 'httpequiv') return null
    if (name.startsWith('on') || name === 'srcdoc' || name === 'dangerouslysetinnerhtml') continue
    const rule = contract && Object.hasOwn(contract, key) ? contract[key] : undefined
    if (rule && !rule.accepts(value)) {
      if (rule.fallback !== undefined) clean[key] = rule.fallback
      continue
    }
    if (key === 'children' && VOID_TAGS.has(tag)) continue
    if (key === 'style') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isValidElement(value)) {
        clean[key] = Object.fromEntries(
          Object.entries(value).filter(([, entry]) => typeof entry === 'string' || typeof entry === 'number'),
        )
      }
      continue
    }
    if (typeof value === 'object' && value !== null) {
      const isNode = typeof (value as { $$typeof?: unknown }).$$typeof === 'symbol' || (NODE_PROPS.has(key) && isRenderableNode(value))
      if (isNode || (!isElement && !NODE_PROPS.has(key) && !STRING_PROPS.has(key) && isPlainData(value))) clean[key] = value
      continue
    }
    if (typeof value === 'string' && key !== 'children') {
      if (!DISPLAY_TEXT_PROPS.has(name) && hasUnsafeScheme(value)) {
        if (!isElement) clean[key] = ''
        continue
      }
      if (name === 'attributename' && ANIMATION_TAGS.has(tag) && /^(?:on|(?:xlink:)?href$)/i.test(value.trim())) continue
    }
    clean[key] = value
  }
  return clean
}

/**
 * Wrap the JSX runtime so authored mistakes degrade instead of 500ing the
 * route. Under the assets source there is no build-time MDX validation
 * between an author's push and a live render, so an unknown component
 * (`<Nope>`) or an HTML-style string `style` attribute — both fatal to React —
 * must not be able to take a page down. Unknown types render their children;
 * props are vetted by `sanitizeProps`.
 */
function createLenientJsx<T extends typeof jsx>(create: T): T {
  return ((type: unknown, props: Record<string, unknown>, key?: string) => {
    const isRenderable =
      typeof type === 'string' ||
      typeof type === 'function' ||
      (typeof type === 'object' && type !== null && '$$typeof' in type)
    const safe = sanitizeProps(type, props ?? {})
    if (!safe) return null
    return create(
      (isRenderable ? type : Fragment) as Parameters<T>[0],
      safe as Parameters<T>[1],
      key,
    )
  }) as T
}

/**
 * A paragraph that holds only inline JSX and whitespace becomes flow content,
 * so `<text x="1">label</text>` between SVG tags is not wrapped in a `<p>`.
 * `@mdx-js/mdx` applies this rule in its own pipeline but keeps the plugin
 * internal, so the interpreter repeats it; without it a `<p>` inside `<svg>`
 * makes the browser end the SVG, and a `<p>` around a block element is
 * re-parented before hydration.
 */
function remarkUnravelJsxParagraphs() {
  type MdastNode = { type: string; value?: string; children?: Array<MdastNode> }
  const unravel = (parent: MdastNode) => {
    const siblings = parent.children
    if (!siblings) return
    for (let index = 0; index < siblings.length; index++) {
      const node = siblings[index]
      const children = node.children ?? []
      const holdsOnlyJsx =
        node.type === 'paragraph' &&
        children.some((child) => child.type === 'mdxJsxTextElement' || child.type === 'mdxTextExpression') &&
        children.every(
          (child) =>
            child.type === 'mdxJsxTextElement' ||
            child.type === 'mdxTextExpression' ||
            (child.type === 'text' && /^[\t\n\f\r ]*$/.test(child.value ?? '')),
        )
      if (!holdsOnlyJsx) {
        unravel(node)
        continue
      }
      const flow = children
        .filter((child) => child.type !== 'text')
        .map((child) => ({
          ...child,
          type: child.type === 'mdxJsxTextElement' ? 'mdxJsxFlowElement' : 'mdxFlowExpression',
        }))
      siblings.splice(index, 1, ...flow)
      index += flow.length - 1
    }
  }
  return unravel
}

const lenientJsx = createLenientJsx(jsx)
const lenientJsxs = createLenientJsx(jsxs)

const processor = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkUnravelJsxParagraphs)
  .use(remarkPlugins)
  .use(remarkRehype, { passThrough: [...MDX_NODE_TYPES] })
  .use(rehypePlugins)

/**
 * Render MDX to React without code generation. Drop-in replacement for the
 * request-time `compileMDX` path on runtimes where eval is unavailable
 * (Cloudflare Workers). The caller passes the same MDX components map the
 * compiled path uses; snippet imports must already have been extracted.
 */
export async function interpretMDX(input: InterpretMdxInput): Promise<InterpretMdxResult> {
  // `parseFrontmatter` is YAML-only: authored `---js` frontmatter stays opaque
  // instead of becoming a code-execution sink inside this static interpreter.
  const { content: body, data } = input.parseFrontmatter
    ? parseFrontmatter(input.source)
    : { content: input.source, data: {} }

  const parsed = processor.parse(body)
  const tree = (await processor.run(parsed)) as Root
  const childExpressions = dropEmptyExpressions(tree)

  const content = toJsxRuntime(tree, {
    Fragment,
    jsx: createLenientJsx(jsx),
    jsxs: createLenientJsx(jsxs),
    components: input.components as Parameters<typeof toJsxRuntime>[1]['components'],
    createEvaluater: createStaticEvaluater(input.components, childExpressions),
    elementAttributeNameCase: 'react',
  })

  // Copying keeps a downstream mutation from contaminating later renders.
  return { content, frontmatter: { ...(data as Record<string, unknown>) } }
}
