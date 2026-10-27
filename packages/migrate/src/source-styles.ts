/**
 * Keep source-authored component styling without importing selectors that
 * reach into a documentation platform's private DOM. The Thally shell owns
 * navigation, footer and card layout; imported CSS may style authored markup,
 * and only inside the page content: every rule it keeps is confined to the
 * container the runtime renders a page's content in.
 */

import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'
import ts from 'typescript'

const PLATFORM_CLASSES = new Set(['navbar-link'])
const PLATFORM_IDS = new Set(['footer', 'navbar', 'sidebar'])
const PLATFORM_CLASS_PREFIX = /^(?:mintlify[-_]|fern[-_]|docusaurus[-_]|theme-doc-|theme-code-block|DocSearch|pagination-nav|menu__)/i
const SHARED_THEME_CLASSES = new Set(['dark', 'light'])
// Framework utility selectors are unsafe global targets even when the same
// utility happens to occur in an authored example elsewhere in the site.
const UTILITY_CLASS = /^(?:[mp][trblxy]?|w|h|min-w|max-w|min-h|max-h|text|bg|border|rounded|flex|grid|gap|space-[xy]|items|justify|overflow|truncate|hidden|block|inline|relative|absolute|sticky|z|opacity)-/

function withoutFencedCode(content: string): string {
  let fence: { marker: string; length: number } | undefined
  return content.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (fence) {
      if (marker?.[0] === fence.marker && marker.length >= fence.length) fence = undefined
      return ''
    }
    if (marker) {
      fence = { marker: marker[0], length: marker.length }
      return ''
    }
    return line
  }).join('\n')
}

/**
 * Mintlify sites make a navbar link look like a button with a rule such as
 * `li.navbar-link a[href*="/signin"] { background-color: ... }`. Thally keeps
 * that intent as a link setting instead of importing the platform selector.
 */
export function navbarLinkButtons(css: string): Array<{ href: string; exact: boolean; background: string; color?: string }> {
  const buttons: Array<{ href: string; exact: boolean; background: string; color?: string }> = []
  postcss.parse(css).walkRules((rule) => {
    const match = /^(?:li)?\.navbar-link\s+a\[href(\*)?=["']([^"']+)["']\]$/.exec(rule.selector.trim())
    if (!match) return
    let background: string | undefined
    let color: string | undefined
    rule.walkDecls((decl) => {
      if (decl.prop === 'background-color' || decl.prop === 'background') background = decl.value
      else if (decl.prop === 'color') color = decl.value
    })
    if (background) buttons.push({ href: match[2], exact: !match[1], background, ...(color ? { color } : {}) })
  })
  return buttons
}

/** The least a family's name (`ifx-card` in `ifx-card--`) may be to speak for every class that starts with it. */
const MIN_FAMILY_NAME = 3

/** What a string says about the classes it names: whole names, the starts of names a template or a sum finishes, and the modifiers it adds. */
interface ClassNames { classes: Set<string>; prefixes: Set<string>; suffixes: Set<string> }

/**
 * Read class names off a string's text, where `\0` stands for a value the code fills in. A name that ends in `-` or `_` is the start of
 * a family (`ifx-card--${kind}`); it names the whole family only when it is long enough to be specific, since a short or bare start
 * (`s${size}`) would admit the rules of any class that begins the same way. A name a value follows (`ifx-card${wide ? " wide" : ""}`)
 * is that name when the value is empty, so it is taken as the name itself, and only when it reads as a name (it has a `-` or `_`).
 * A `--` or `__` suffix after a value (`${base}--dim`) is a modifier added to any name. Outside a `className`, a bare word is as likely
 * text as a class, so only a name with a dash or an underscore in it counts (`anyWord` is true for a `className` value, where every
 * word does).
 */
function addClassNames(text: string, into: ClassNames, anyWord: boolean): void {
  for (const token of text.split(/\s+/)) {
    const hole = token.indexOf('\0')
    const head = hole < 0 ? token : token.slice(0, hole)
    const tail = hole < 0 ? '' : token.slice(token.lastIndexOf('\0') + 1)
    if (/^(?:--|__)[\w-]+$/.test(tail)) into.suffixes.add(tail)
    if (!/^[A-Za-z_][\w-]*$/.test(head) || (!anyWord && !/[-_]/.test(head))) continue
    if (/[-_]$/.test(head)) {
      if (head.replace(/[-_]+$/, '').length >= MIN_FAMILY_NAME) into.prefixes.add(head)
    } else if (hole < 0 || /[-_]/.test(head)) into.classes.add(head)
  }
}

/** The text of a string literal, or of a template with `\0` where it has a value; undefined for any other node. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\0${span.literal.text}`).join('')
  return undefined
}

/**
 * Find classes and IDs actually authored in migrated pages and components. `modules` are the scripts and component modules: any string
 * they hold may be a class name (the code builds `className` from parts), and a template or a sum names the start of a family
 * (`ifx-card--${kind}`), which `prefixes` carries, or a modifier (`${base}--dim`), which `suffixes` does.
 */
export function authoredStyleNames(contents: ReadonlyArray<string>, modules: ReadonlyArray<string> = []): { classes: Set<string>; ids: Set<string>; prefixes: Set<string>; suffixes: Set<string> } {
  const names: ClassNames = { classes: new Set(), prefixes: new Set(), suffixes: new Set() }
  const ids = new Set<string>()
  for (const { original, isModule } of [...contents.map((original) => ({ original, isModule: false })), ...modules.map((original) => ({ original, isModule: true }))]) {
    const content = withoutFencedCode(original)
    // MDX pages can contain ordinary Markdown, so use attribute spans rather
    // than interpreting a fenced example as a source of shell selectors.
    for (const match of content.matchAll(/\b(?:className|class)\s*=\s*["']([^"']+)["']/g)) {
      for (const name of match[1].split(/\s+/)) if (name) names.classes.add(name)
    }
    for (const match of content.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) ids.add(match[1])

    if (!isModule && !content.includes('className={')) continue
    const source = ts.createSourceFile('component.tsx', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node, inClassName: boolean): void => {
      const text = literalText(node)
      if (text !== undefined && (inClassName || isModule)) addClassNames(text, names, inClassName)
      const inside = inClassName || (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'className' && node.initializer !== undefined)
      ts.forEachChild(node, (child) => { visit(child, inside) })
    }
    visit(source, false)
  }
  return { ...names, ids }
}

/**
 * The element that wraps a page's rendered content in the Thally runtime (`Prose`, src/components/mdx/prose.tsx), as the released runtime
 * does too. The navbar, sidebar, table of contents, breadcrumbs, pagination, search and footer are never inside it, so a rule that can
 * only match inside it cannot restyle them, whatever classes, ids or variables the site shares with the runtime.
 */
export const CONTENT_CONTAINER = '.thally-docs-prose'
/**
 * A page in `mode: custom` is rendered with no such element, so the migration wraps its content in one that carries this attribute: it
 * is part of the page, wherever the runtime puts the page, and holds nothing of the shell either.
 */
export const SOURCE_PAGE_ATTRIBUTE = 'data-thally-source-page'
const SCOPE = `:where(${CONTENT_CONTAINER}, [${SOURCE_PAGE_ATTRIBUTE}])`

/** The alternatives of a compound that is a lone `:is()` or `:where()`, or none. */
function alternativesOf(compound: ReadonlyArray<selectorParser.Node>): ReadonlyArray<selectorParser.Selector> {
  const [only] = compound
  return compound.length === 1 && only.type === 'pseudo' && /^:(?:is|where)$/i.test(only.value) ? only.nodes : []
}

/** An alternative of `:is()` that is a single page-root compound (`.dark`, `:root`), not a longer selector that merely starts at one. */
function isPageRootAlternative(alternative: selectorParser.Selector): boolean {
  return !alternative.nodes.some((node) => node.type === 'combinator') && isPageRoot(alternative.nodes)
}

/** A compound that can only be the page root or an ancestor of everything on the page: `html`, `body`, `:root`, `.dark`, `.light`, or `:is()` of those. */
function isPageRoot(compound: ReadonlyArray<selectorParser.Node>): boolean {
  if (compound.some((node) => (node.type === 'tag' && /^(?:html|body)$/i.test(node.value)) || (node.type === 'pseudo' && node.value.toLowerCase() === ':root'))) return true
  const alternatives = alternativesOf(compound)
  if (alternatives.length > 0) return alternatives.every(isPageRootAlternative)
  return compound.length > 0 && compound.every((node) => node.type === 'class' && SHARED_THEME_CLASSES.has(node.value))
}

/**
 * `selector` as a selector that matches only inside the page content, or undefined when it styles the page (`html.x`, `body > .x`)
 * instead of anything inside it. A leading `html`, `body`, `:root` or theme class stays where it is, above the container. What follows
 * the container is read from inside it, so its alternatives (`:is(.x, :root)`) can only match there; a leading `:is()` is the exception,
 * since the container goes before the alternatives that are the page and after the rest, and it cannot be both: such a selector is left out.
 */
function confine(selector: selectorParser.Selector): string | undefined {
  const nodes = selector.nodes as Array<selectorParser.Node>
  let at = 0
  for (;;) {
    let end = at
    while (end < nodes.length && nodes[end].type !== 'combinator') end += 1
    const compound = nodes.slice(at, end)
    if (!isPageRoot(compound)) {
      if (alternativesOf(compound).some(isPageRootAlternative)) return undefined
      break
    }
    // The content is a descendant of the root: what follows must be too, or the rule is about the page, not the content.
    if (end === nodes.length || nodes[end].toString().trim() !== '') return undefined
    at = end + 1
  }
  return `${nodes.slice(0, at).join('')}${SCOPE} ${nodes.slice(at).join('').trimStart()}`.trim()
}

/** The selector of a block that holds a theme's design tokens: `:root` and `html` for light, and `.dark` (or `html.dark`) for dark. */
const THEME_SELECTOR = /^(?::root|html)(?:\.(?:dark|light))?$|^\.(?:dark|light)$/

export interface StyleProjection {
  css: string
  /** Selectors left out: platform or unreferenced markup, and the page itself (`html.x`), which no content container holds. */
  omittedSelectors: number
  /** At-rules left out that hold no style rule (`@page`, an unreferenced `@counter-style`): they apply to the whole page, or are used by nothing kept. */
  omittedAtRules: Array<string>
  /** Rules written inside another rule (CSS nesting) that were left out: read relative to what they are in, they can match outside the content. */
  omittedNestedRules: number
  /** Custom properties whose `@property` registration was left out: it applies to the whole page, so it could change a property the shell uses. */
  skippedProperties: Array<string>
  /** Custom properties left out of a theme block because no imported rule reads them. */
  skippedVariables: Array<string>
  /** Declarations left out of a theme block that are not custom properties (`:root { background: ... }`): they would restyle the page. */
  skippedThemeDeclarations: number
}

/**
 * `value` with each top-level word or string that is a key of `names` replaced by its value, the way `animation: spin 1s` names a
 * keyframes rule. A function's name and arguments (`steps(4, end)`) are left alone, and a name has to be the whole word (`spinner` is not
 * `spin`).
 */
function renameWords(value: string, names: ReadonlyMap<string, string>): string {
  let depth = 0
  return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[()]|[^\s,()"']+/g, (token, offset: number) => {
    if (token === '(') depth += 1
    else if (token === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && value[offset + token.length] !== '(') {
      const quote = /^["']/.test(token) ? token[0] : ''
      const renamed = names.get(quote ? token.slice(1, -1) : token)
      if (renamed !== undefined) return `${quote}${renamed}${quote}`
    }
    return token
  })
}

/** At-rules that hold other rules, so one left empty is what its rules' removal made it, and ones whose removal is not worth a mention. */
const UNCOUNTED_AT_RULES = /^(?:media|supports|container|scope|starting-style|charset|(?:-[a-z]+-)?keyframes)$/i

/** Whether `node` is written inside a rule, directly or through a condition (`.a { @media (...) { .b {} } }`). */
function isInRule(node: postcss.Node): boolean {
  for (let ancestor: postcss.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) if (ancestor.type === 'rule') return true
  return false
}

/** A test for whether a string begins with any of `starts`, by one search instead of a pass over every one of them. */
function startsWithAny(starts: Iterable<string>): (text: string) => boolean {
  // With each start that another one begins left out, the only start that can begin a text is the last one in order that is not after it.
  const sorted: Array<string> = []
  for (const start of [...starts].sort()) if (sorted.length === 0 || !start.startsWith(sorted[sorted.length - 1])) sorted.push(start)
  return (text) => {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (sorted[middle] <= text) low = middle + 1
      else high = middle
    }
    return low > 0 && text.startsWith(sorted[low - 1])
  }
}

/** A test for whether a string ends with any of `ends`: a string ends with one when its reverse begins with that one's reverse. */
function endsWithAny(ends: Iterable<string>): (text: string) => boolean {
  const reverse = (text: string): string => text.split('').reverse().join('')
  const startsWith = startsWithAny([...ends].map(reverse))
  return (text) => startsWith(reverse(text))
}

/** Add `value` to the list `map` keeps under `key`, starting the list if it is the first. */
function pushTo<T>(map: Map<string, Array<T>>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** The first word of a custom property's name with its dashes (`--ifx-` of `--ifx-glow`), or nothing when the name is a single word. */
const propertyFamily = (name: string): string => name.slice(0, name.indexOf('-', 2) + 1)

/**
 * Remove platform DOM selectors while preserving CSS for authored widgets. `modules` are the component modules and scripts, whose
 * strings count as class names. Every rule kept is confined to the page content container (`CONTENT_CONTAINER`): the site's own
 * classes, ids and variables can match nothing in the Thally shell, however they are spelled. A theme block (`:root`, `.dark`) keeps
 * only the custom properties that an imported rule reads, directly or through another kept property, and declares them on that
 * container, under `.dark` for the dark theme; nothing else in it is taken. A rule nested in another rule is left out and counted: it is read
 * relative to the rule around it, where `&` and the theme blocks' own selectors can reach past the container. A condition written inside a
 * rule (`.a { @media (...) { color: red } }`) only changes that rule's declarations, so it stays. Keyframes names are global to the page, so
 * each `@keyframes` is renamed with `namespace` and the animations that name it follow, and none can replace one the runtime defines.
 */
export function projectAuthoredStyles(css: string, contents: ReadonlyArray<string>, modules: ReadonlyArray<string>, namespace: string): StyleProjection {
  const names = authoredStyleNames(contents, modules)
  const startsAuthoredFamily = startsWithAny(names.prefixes)
  const endsAuthoredModifier = endsWithAny(names.suffixes)
  const isAuthoredClass = (name: string): boolean => names.classes.has(name) || startsAuthoredFamily(name) || endsAuthoredModifier(name)
  const root = postcss.parse(css)
  let omittedSelectors = 0
  const themeRules: Array<postcss.Rule> = []
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
    if (isInRule(rule)) return
    if (rule.selectors.every((part) => THEME_SELECTOR.test(part.trim()))) { themeRules.push(rule); return }
    const retained: Array<string> = []
    try {
      selectorParser((selectors) => {
        selectors.each((selector) => {
          let hasAuthoredAnchor = false
          let hasPlatformAnchor = false
          selector.walk((node) => {
            // A class inside :not() or :has() does not constrain the element
            // being styled. Treating it as the only authored anchor could
            // retain a body-wide platform override.
            let ancestor = node.parent
            let isNestedInPseudo = false
            while (ancestor && ancestor !== selector) {
              if (ancestor.type === 'pseudo') isNestedInPseudo = true
              ancestor = ancestor.parent
            }
            if (node.type === 'class') {
              if (SHARED_THEME_CLASSES.has(node.value)) return
              if (PLATFORM_CLASSES.has(node.value) || PLATFORM_CLASS_PREFIX.test(node.value) || UTILITY_CLASS.test(node.value) || !isAuthoredClass(node.value)) hasPlatformAnchor = true
              else if (!isNestedInPseudo) hasAuthoredAnchor = true
            } else if (node.type === 'id') {
              if (PLATFORM_IDS.has(node.value) || !names.ids.has(node.value)) hasPlatformAnchor = true
              else if (!isNestedInPseudo) hasAuthoredAnchor = true
            } else if (node.type === 'nesting') {
              // `&` outside a rule stands for the page itself (`:scope`), not for anything in the content.
              hasPlatformAnchor = true
            } else if (node.type === 'attribute' && node.attribute === 'data-as') {
              // Mintlify adds this implementation detail to transformed MDX
              // paragraphs. Thally renders the native element and class. On
              // its own in a compound (`.x [data-as="p"]`) it stands for the
              // element, which is named instead; beside a class or tag it is
              // simply dropped. One that names no element has no stand-in, and
              // dropping it would style the whole ancestor, so the selector goes.
              // The marker is on the paragraphs MDX makes, which Thally renders
              // as a plain `<p>`; a paragraph a site component draws has a class
              // of its own, so `p` is named as `p:not([class])`. Headings and the
              // other elements have no such stand-in: Thally's own headings carry
              // a class, so a heading is named as it is.
              const alone = (!node.prev() || node.prev()?.type === 'combinator') && (!node.next() || node.next()?.type === 'combinator')
              const element = node.operator === '=' ? node.value : undefined
              if (!alone) node.remove()
              else if (element === 'p') node.replaceWith(...(selectorParser().astSync('p:not([class])').first.nodes))
              else if (element && /^[a-z][a-z0-9]*$/.test(element)) node.replaceWith(selectorParser.tag({ value: element }))
              else hasPlatformAnchor = true
            }
          })
          const confined = hasAuthoredAnchor && !hasPlatformAnchor ? confine(selector) : undefined
          if (confined === undefined) omittedSelectors += 1
          else retained.push(confined)
        })
      }).processSync(rule.selector)
    } catch {
      omittedSelectors += 1
    }
    if (retained.length) rule.selector = retained.join(', ')
    else rule.remove()
  })
  let omittedNestedRules = 0
  root.walkRules((rule) => {
    if (!isInRule(rule)) return
    omittedNestedRules += 1
    rule.remove()
  })
  // A theme block takes custom properties and nothing else, and a condition inside it can hold anything.
  for (const rule of themeRules) rule.each((node) => {
    if (node.type !== 'atrule') return
    omittedNestedRules += 1
    node.remove()
  })
  // The variables a kept rule reads, and those they read in turn through the properties kept for them. The theme declarations are indexed
  // by name and a name is looked up once, when it is first read, so each declaration is read once however long a chain of variables is.
  const themes = new Set(themeRules)
  const themeValues = new Map<string, Array<string>>()
  for (const rule of themeRules) rule.each((node) => { if (node.type === 'decl' && node.prop.startsWith('--')) pushTo(themeValues, node.prop, node.value) })
  const read = new Set<string>()
  const unvisited: Array<string> = []
  const readIn = (value: string): void => {
    for (const [, name] of value.matchAll(/var\(\s*(--[\w-]+)/g)) if (!read.has(name)) { read.add(name); unvisited.push(name) }
  }
  root.walkDecls((decl) => { if (!decl.parent || !themes.has(decl.parent as postcss.Rule)) readIn(decl.value) })
  for (let name = unvisited.pop(); name !== undefined; name = unvisited.pop()) for (const value of themeValues.get(name) ?? []) readIn(value)
  const isKept = (decl: postcss.Declaration): boolean => decl.prop.startsWith('--') && read.has(decl.prop)
  const skippedVariables = new Set<string>()
  let skippedThemeDeclarations = 0
  // The first words of the names the site's own theme blocks declare, whether or not a rule reads them: where the site's own prefix shows.
  const themeFamilies = new Set([...themeValues.keys()].map(propertyFamily))
  for (const rule of themeRules) {
    const dropped = rule.nodes.filter((node): node is postcss.Declaration => node.type === 'decl' && !isKept(node))
    for (const decl of dropped) {
      if (decl.prop.startsWith('--')) skippedVariables.add(decl.prop)
      else skippedThemeDeclarations += 1
      decl.remove()
    }
    if (rule.nodes.some((node) => node.type === 'decl')) rule.selectors = rule.selectors.map((part) => `${part.trim()} ${SCOPE}`)
    else {
      omittedSelectors += rule.selectors.length
      rule.remove()
    }
  }
  // A condition inside a rule (`@media`) holds declarations for that rule, which is what it is there to change. A layer, even an empty one
  // or a bare statement (`@layer a, b;`), sets the order its rules and the shell's compete in, so it stays whatever it holds.
  const hasStyleRule = (atRule: postcss.AtRule): boolean => atRule.name.toLowerCase() === 'layer' || Boolean(atRule.nodes?.some((node) =>
    node.type === 'rule' || (node.type === 'atrule' && hasStyleRule(node)) || (node.type === 'decl' && isInRule(atRule))))
  // A counter style or font palette is used by name, so a kept rule that names one needs its definition, and a definition may name another
  // (`fallback`, `system: extends`). Any word in a kept declaration counts as a name: keeping one too many does no harm.
  const definitions = new Set<postcss.AtRule>()
  root.walkAtRules(/^(?:counter-style|font-palette-values)$/i, (rule) => { definitions.add(rule) })
  const definitionsNamed = new Map<string, Array<postcss.AtRule>>()
  for (const rule of definitions) pushTo(definitionsNamed, rule.params.trim().toLowerCase(), rule)
  const named = new Set<string>()
  const unread: Array<string> = []
  const nameWords = (decl: postcss.Declaration): void => {
    for (const [word] of decl.value.matchAll(/[^\s,()"']+/g)) {
      const name = word.toLowerCase()
      if (!named.has(name)) { named.add(name); unread.push(name) }
    }
  }
  root.walkDecls((decl) => { if (!definitions.has(decl.parent as postcss.AtRule)) nameWords(decl) })
  for (let name = unread.pop(); name !== undefined; name = unread.pop()) for (const rule of definitionsNamed.get(name) ?? []) rule.walkDecls(nameWords)
  const omittedAtRules: Array<string> = []
  const describe = (rule: postcss.AtRule): string => `@${rule.name}${rule.params ? ` ${rule.params}` : ''}`
  const skippedProperties: Array<string> = []
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase()
    if (name === 'font-face') return
    if (definitions.has(rule)) {
      if (named.has(rule.params.trim().toLowerCase())) return
      omittedAtRules.push(describe(rule))
      rule.remove()
      return
    }
    if (name === 'property') {
      // A registration applies to the whole page, so it must be for a name the shell cannot be using: one a kept rule reads, and whose
      // first word (`--ifx-` in `--ifx-glow`) is one the site's own theme blocks use for its properties too.
      const property = rule.params.trim()
      const prefix = propertyFamily(property)
      if (read.has(property) && prefix && themeFamilies.has(prefix)) return
      skippedProperties.push(property)
      rule.remove()
      return
    }
    if (hasStyleRule(rule)) return
    if (!UNCOUNTED_AT_RULES.test(rule.name)) omittedAtRules.push(describe(rule))
    rule.remove()
  })
  const keyframes = new Map<string, string>()
  root.walkAtRules(/^(?:-[a-z]+-)?keyframes$/i, (rule) => {
    const quote = /^["']/.test(rule.params) ? rule.params[0] : ''
    const name = rule.params.trim().slice(quote ? 1 : 0, quote ? -1 : undefined)
    const renamed = `${namespace}-${name}`
    keyframes.set(name, renamed)
    rule.params = `${quote}${renamed}${quote}`
  })
  // A custom property can hold an animation (`--a: spin 1s` read by `animation: var(--a)`), so those follow too.
  if (keyframes.size > 0) root.walkDecls((decl) => {
    if (/^(?:-[a-z]+-)?animation(?:-name)?$/i.test(decl.prop) || decl.prop.startsWith('--')) decl.value = renameWords(decl.value, keyframes)
  })
  root.walkComments((comment) => { comment.remove() })
  return { css: root.toString(), omittedSelectors, omittedAtRules, omittedNestedRules, skippedProperties, skippedVariables: [...skippedVariables], skippedThemeDeclarations }
}
