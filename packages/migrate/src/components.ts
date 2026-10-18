/**
 * Move repository-owned MDX components into the customer component registry.
 * Source is parsed, never evaluated. Every dependency must remain inside the
 * documentation root and traverse only ordinary files (including its parents).
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, posix, relative, resolve } from 'node:path'
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import ts from 'typescript'
import { unified } from 'unified'

import { parseFrontmatter } from './frontmatter.js'
import { functionDeclaredNames, isFunctionInitializer, mdxComment, normalizeHtmlComments, normalizeExplicitHeadingIds, replaceOutsideCodeAndComments } from './mdx.js'
import { resolveWithin } from './path.js'
import { hoistedVarNames, planInlineExtraction, scriptKindFor, unboundBuiltinTags, unboundTags } from './inline-extraction.js'
import type { MigrationWarning, RenderedMigrationFile } from './types.js'

interface MdxNode {
  type: string
  name?: string | null
  value?: string
  attributes?: Array<{
    name?: string
    type: string
    value?: string | { type?: string; value?: string } | null
    position?: { start: { offset?: number }; end: { offset?: number } }
  }>
  children?: Array<MdxNode>
  position?: { start: { offset?: number }; end: { offset?: number } }
}

interface Replacement { start: number; end: number; value: string }
interface Binding { local: string; imported: string; source: string }

/** Make JSX-indented fences parse as code before MDX import analysis runs. */
export function normalizeIndentedFences(content: string): string {
  const lines = content.split('\n')
  let active: { indent: string; marker: string } | undefined
  let ordinaryFence: string | undefined
  let indentedJsx: { tag: string; indent: string } | undefined
  let listIndent: number | undefined
  return lines.map((line) => {
    const trimmed = line.trimStart()
    // A fenced example inside list-indented JSX must move together with its
    // container. Unindenting only the fence leaves the tag unclosed; keeping
    // everything indented lets textual import passes mistake example imports
    // for live MDX imports.
    if (indentedJsx) {
      const normalized = line.startsWith(indentedJsx.indent) ? line.slice(indentedJsx.indent.length) : line
      if (normalized.trimStart().startsWith(`</${indentedJsx.tag}>`)) indentedJsx = undefined
      return normalized
    }
    if (ordinaryFence) {
      const closing = trimmed.match(/^(`{3,}|~{3,})\s*$/)?.[1]
      if (closing && closing[0] === ordinaryFence[0] && closing.length >= ordinaryFence.length) ordinaryFence = undefined
      return line
    }
    if (!active) {
      const listItem = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s/)
      const indentation = line.length - trimmed.length
      if (listItem) listIndent = listItem[1].length
      else if (trimmed && listIndent !== undefined && indentation <= listIndent) listIndent = undefined
      const jsx = line.match(/^([ \t]{2,})<([A-Z][\w.]*)\b[^>]*>\s*$/)
      if (jsx && listIndent !== undefined && jsx[1].length > listIndent && !trimmed.endsWith('/>')) {
        indentedJsx = { tag: jsx[2], indent: jsx[1] }
        return line.slice(jsx[1].length)
      }
      const match = line.match(/^([ \t]{4,})(`{3,}|~{3,})/)
      if (match) {
        // A fence under a Markdown list is already valid. Moving it left
        // ends the list item and detaches its example from the numbered step.
        if (listIndent !== undefined && match[1].length > listIndent) {
          ordinaryFence = match[2]
          return line
        }
        active = { indent: match[1], marker: match[2] }
        return line.slice(match[1].length)
      }
      const ordinary = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
      if (ordinary) ordinaryFence = ordinary[1]
      return line
    }
    const normalized = line.startsWith(active.indent) ? line.slice(active.indent.length) : line
    const closing = normalized.trimStart().match(/^(`{3,}|~{3,})\s*$/)?.[1]
    if (closing && closing[0] === active.marker[0] && closing.length >= active.marker.length) active = undefined
    return normalized
  }).join('\n')
}

/** Lift a self-contained data helper out of a copied client module for server MDX expressions. */
function staticServerHelper(path: string, imported: string, local: string): string | null {
  if (imported === 'default') return null
  const parsed = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const isLiteral = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isLiteral(node.expression)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return true
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true
    if (ts.isPrefixUnaryExpression(node)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator) && ts.isNumericLiteral(node.operand)
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => ts.isExpression(element) && isLiteral(element))
    if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) => ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))
      && isLiteral(property.initializer))
    return false
  }
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== imported || !declaration.initializer || !ts.isArrowFunction(declaration.initializer)) continue
      const arrow = declaration.initializer
      if (arrow.parameters.length > 0) continue
      const result = ts.isBlock(arrow.body)
        ? arrow.body.statements.length === 1 && ts.isReturnStatement(arrow.body.statements[0]) ? arrow.body.statements[0].expression : undefined
        : arrow.body
      if (result && isLiteral(result)) return `export const ${local} = () => (${result.getText(parsed)});`
    }
  }
  return null
}

/** A bare `id`/`videoId`-style attribute value is safe to embed in an `iframe src` only when it looks like a real YouTube video id. */
const YOUTUBE_VIDEO_ID = /^[\w-]{1,64}$/
/** Packages known to take a literal YouTube video id prop (as opposed to a URL, or a non-YouTube player). */
const YOUTUBE_ID_PACKAGES = new Set(['react-lite-youtube-embed', 'react-youtube', '@justinribeiro/lite-youtube'])
const YOUTUBE_URL = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{1,64})/i

/**
 * Only a small, known set of YouTube embed packages get a working `<iframe>`
 * replacement; every other removed component (Vimeo, Loom, a bespoke
 * in-house player, or any package this doesn't recognize) falls back to the
 * plain comment stub, since guessing at an unfamiliar player's embed URL
 * shape would silently render the wrong video or nothing at all.
 */
function youtubeEmbedVideoId(node: MdxNode, specifier: string): string | undefined {
  const attribute = (attributeName: string): string | undefined => {
    const raw = node.attributes?.find((entry) => entry.name === attributeName)?.value
    return typeof raw === 'string' ? raw : undefined
  }
  if (YOUTUBE_ID_PACKAGES.has(specifier)) {
    const id = attribute('id') ?? attribute('videoId')
    return id && YOUTUBE_VIDEO_ID.test(id) ? id : undefined
  }
  if (specifier === 'react-player') {
    const url = attribute('url')
    const match = url ? YOUTUBE_URL.exec(url) : null
    return match ? match[1] : undefined
  }
  return undefined
}

const parser = unified().use(remarkParse).use(remarkMdx)
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs'])
const DATA_EXTENSIONS = new Set(['.json', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.woff', '.woff2'])
/**
 * Binary asset types a failed component/module import can still be rescued
 * as: copied verbatim to `public/` and bound to its URL string, rather than
 * losing the reference outright. Includes types `DATA_EXTENSIONS` already
 * lets `copyGraph` copy as a JS-module asset (an image can still fail that
 * path for other reasons — budget, a symlink) and types it never would
 * (`.docx`, `.pdf`: not importable as a JS module, but a real static file).
 */
const RESCUABLE_ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico', '.docx', '.pdf'])

/**
 * Tiny equivalents for the handful of Docusaurus theme/runtime imports a
 * copied component commonly uses, so the component still copies instead of
 * failing outright with "external package requires manual installation" —
 * the same reasoning as `SCAFFOLD_PROVIDED_IMPORTS`, just for names that
 * only exist inside a Docusaurus build. Deliberately small: anything else
 * Docusaurus-specific (`@docusaurus/Translate`, a theme-common hook, ...)
 * still fails copyGraph and is handled by the dead-import-removal fallback
 * (the catch block below) instead of growing this into a Docusaurus shim
 * layer.
 */
const DOCUSAURUS_THEME_SHIMS: Record<string, { filename: string; content: string }> = {
  '@theme/CodeBlock': {
    filename: 'docusaurus-code-block.tsx',
    content: [
      "import type { ReactNode } from 'react'",
      '',
      'export default function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {',
      '  return (',
      '    <pre className={className}>',
      '      <code>{children}</code>',
      '    </pre>',
      '  )',
      '}',
      '',
    ].join('\n'),
  },
  '@docusaurus/BrowserOnly': {
    filename: 'docusaurus-browser-only.tsx',
    content: [
      "'use client'",
      '',
      "import { useEffect, useState, type ReactNode } from 'react'",
      '',
      'export default function BrowserOnly({ children, fallback = null }: { children: () => ReactNode; fallback?: ReactNode }) {',
      '  const [mounted, setMounted] = useState(false)',
      '  useEffect(() => { setMounted(true) }, [])',
      '  return mounted ? <>{children()}</> : <>{fallback}</>',
      '}',
      '',
    ].join('\n'),
  },
}
const SHARED_IMPORTS = new Set(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'])
/**
 * Packages the standalone starter already installs as its own runtime
 * dependencies. An MDX page's import of one of these (or of a subpath such
 * as `next/navigation` or `lucide-react/dynamic`), even outside JSX, is not
 * "unavailable": the package is really there, so the page keeps the import
 * and any extracted client module gets a copy of it.
 *
 * `@/…` path aliases are deliberately absent: in a source repository they
 * point at that site's own code, not at Thally's.
 *
 * Drift-guarded by the "SCAFFOLD_PROVIDED_IMPORTS drift guard" test in
 * `packages/migrate/src/__tests__/components.test.ts`.
 */
export const SCAFFOLD_PROVIDED_IMPORTS: ReadonlySet<string> = new Set(['next', 'react-dom', 'clsx', 'lucide-react', 'tailwind-merge'])
function isScaffoldProvidedImport(specifier: string): boolean {
  // Next aliases react-dom/server so renderToString/renderToStaticMarkup throw
  // at render; treat it like an unavailable package rather than keep the page.
  if (/^react-dom\/server(?:[./]|$)/.test(specifier)) return false
  return [...SCAFFOLD_PROVIDED_IMPORTS].some((name) => specifier === name || specifier.startsWith(`${name}/`))
}
/** How a warning names an import that is not available in the migrated project. */
function unavailableImportLabel(specifier: string): string {
  return specifier.startsWith('@/')
    ? `the path alias '${specifier}' (the source site's own code, which the migration does not copy)`
    : `the npm package '${specifier}'`
}
const REACT_GLOBALS = new Set([
  'useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useRef',
  'useReducer', 'useContext', 'useId', 'useTransition', 'useDeferredValue',
  'useImperativeHandle', 'useSyncExternalStore', 'useInsertionEffect',
  'useOptimistic', 'useActionState', 'use', 'createContext', 'forwardRef', 'memo',
])
const MAX_COMPONENT_FILES = 300
const MAX_COMPONENT_BYTES = 20_000_000
const MAX_FILE_BYTES = 2_000_000

/**
 * Where each Thally built-in MDX component actually lives, for building the
 * `MintlifyComponents` shim (below). This must import each leaf module
 * directly rather than the app's `mdx-components.tsx` registry: that
 * registry pulls in `src/mdx/custom-components.tsx`, which re-exports every
 * migrated component — including this very generated file — so importing
 * it here would be circular (`ReferenceError: Cannot access 'X' before
 * initialization` at build time). Kept in sync with
 * `src/components/mdx/builtin-components.tsx`'s own imports by hand; a drift
 * here only means `MintlifyComponents.<Name>` is `undefined` for a name
 * added there, not a crash.
 */
const MINTLIFY_COMPONENT_MODULES: ReadonlyArray<{ module: string; names: ReadonlyArray<string> }> = [
  { module: '@/components/mdx/note', names: ['Note'] },
  { module: '@/components/mdx/agent-prompt', names: ['AgentPrompt'] },
  { module: '@/components/mdx/code-blocks', names: ['CodeGroup'] },
  { module: '@/components/mdx/rich-content', names: ['Columns', 'Frame', 'Hero'] },
  { module: '@/components/mdx/accordion', names: ['Accordion', 'AccordionGroup'] },
  { module: '@/components/mdx/content-cards', names: ['Card', 'CardGroup', 'Tile', 'TileGroup'] },
  { module: '@/components/mdx/content-icon', names: ['Icon'] },
  { module: '@/components/mdx/content-inline', names: ['Badge', 'Tooltip'] },
  { module: '@/components/mdx/color', names: ['Color'] },
  { module: '@/components/mdx/content-metadata', names: ['Update'] },
  { module: '@/components/mdx/panel', names: ['Panel', 'ContentPanel', 'InlinePanel'] },
  { module: '@/components/mdx/examples', names: ['RequestExample', 'ResponseExample', 'InlineRequestExample', 'InlineResponseExample'] },
  { module: '@/components/mdx/prompt', names: ['Prompt', 'PromptAssistant', 'PromptUser', 'Terminal', 'TerminalInput', 'TerminalOutput'] },
  { module: '@/components/mdx/file-tree', names: ['Tree', 'Folder', 'File'] },
  { module: '@/components/mdx/api-fields', names: ['ResponseField', 'ParamField', 'Expandable'] },
  { module: '@/components/mdx/mermaid', names: ['Mermaid'] },
  { module: '@/components/mdx/view', names: ['Embed', 'LegacyView', 'View'] },
  { module: '@/components/mdx/github-card', names: ['GitHub'] },
  { module: '@/components/mdx/visibility', names: ['Agent', 'Human', 'Visibility'] },
  { module: '@/components/mdx/steps', names: ['Steps', 'Step'] },
  { module: '@/components/mdx/content-tabs', names: ['Tabs', 'Tab'] },
]

/** Builtins mapped straight through to their same-named import (aliased, see below). */
const MINTLIFY_DIRECT_COMPONENTS = [
  'AccordionGroup', 'Hero', 'Card', 'CardGroup', 'Columns', 'Frame', 'Accordion', 'Tooltip',
  'Icon', 'Steps', 'Step', 'Tabs', 'Tab', 'Badge', 'Update', 'RequestExample', 'ResponseExample',
  'Panel', 'ContentPanel', 'InlinePanel', 'InlineRequestExample', 'InlineResponseExample',
  'Tile', 'TileGroup', 'Prompt', 'PromptUser', 'PromptAssistant', 'Terminal', 'TerminalInput',
  'TerminalOutput', 'AgentPrompt', 'Color', 'Tree', 'Folder', 'File', 'ResponseField',
  'ParamField', 'Expandable', 'Mermaid', 'View', 'Embed', 'LegacyView', 'GitHub', 'Visibility',
  'Human', 'Agent', 'CodeGroup',
]

/**
 * Mintlify's implicit `MintlifyComponents` global for a copied `.jsx`
 * snippet (`const { Card } = MintlifyComponents;`, no import) — an object
 * of Thally's built-in equivalents. Every import is aliased (`Card as
 * __mintlify_Card`) so none of ~50 bare names land in the snippet's own top
 * level scope and risk colliding with something it already declares; only
 * the single `MintlifyComponents` identifier is introduced unaliased.
 */
function mintlifyComponentsShim(): string {
  const alias = (name: string) => `__mintlify_${name}`
  const imports = MINTLIFY_COMPONENT_MODULES
    .map(({ module, names }) => `import { ${names.map((name) => `${name} as ${alias(name)}`).join(', ')} } from '${module}';`)
    .join('\n')
  const entries = [
    // The callout family all render through Note, whose `type` mdx-components.tsx
    // sets for each name; Callout and Latex mirror that file's own handling.
    `Info: (props) => <${alias('Note')} type="info" {...props} />`,
    `Warning: (props) => <${alias('Note')} type="warning" {...props} />`,
    `Check: (props) => <${alias('Note')} type="check" {...props} />`,
    `Danger: (props) => <${alias('Note')} type="danger" {...props} />`,
    `Error: (props) => <${alias('Note')} type="danger" {...props} />`,
    `Note: (props) => <${alias('Note')} type="note" {...props} />`,
    `Tip: (props) => <${alias('Note')} type="tip" {...props} />`,
    `Callout: (props) => <${alias('Note')} {...props} />`,
    `Latex: ({ children }) => <code>{children}</code>`,
    ...MINTLIFY_DIRECT_COMPONENTS.map((name) => `${name}: ${alias(name)}`),
    `Github: ${alias('GitHub')}`,
  ]
  return `${imports}\nconst MintlifyComponents = {\n  ${entries.join(',\n  ')},\n};`
}

function applyReplacements(source: string, replacements: Array<Replacement>): string {
  return replacements.sort((a, b) => b.start - a.start).reduce(
    (text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end), source,
  )
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function portableSpecifier(path: string): string {
  // Customer tsconfigs do not opt into allowImportingTsExtensions. Next's
  // bundler resolves these extensionless source imports without that flag.
  return path.replace(/\.tsx?$/, '')
}

/**
 * CSS Modules in the Thally scaffold require a local class or ID in each
 * selector branch. A global-only branch cannot be made local by wrapping it
 * in :global(...); Turbopack still rejects it. Omit those branches while
 * preserving local rules, and report the omission for manual review.
 */
function sanitizeCssModuleSelectors(css: string): { css: string; omitted: number } {
  const root = postcss.parse(css)
  let omitted = 0
  root.walkRules((rule) => {
    // Keyframe selectors and CSS Modules' value exports are not DOM
    // selectors; removing them breaks otherwise portable local styles.
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
    if (/^:export$|^:import\(/.test(rule.selector.trim())) return
    const selectors = selectorParser().astSync(rule.selector)
    selectors.each((selector) => {
      let hasLocalClassOrId = false
      selector.walk((node) => {
        if (node.type !== 'class' && node.type !== 'id') return
        let parent = node.parent
        while (parent) {
          if (parent.type === 'pseudo' && parent.value === ':global') return
          parent = parent.parent
        }
        hasLocalClassOrId = true
      })
      if (!hasLocalClassOrId) {
        selector.remove()
        omitted++
      }
    })
    if (selectors.nodes.length === 0) rule.remove()
    else rule.selector = selectors.toString()
  })
  return { css: root.toString(), omitted }
}

function sourceFile(source: string, filename: string): ts.SourceFile {
  return ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKindFor(filename))
}

function walk(node: MdxNode, visitor: (node: MdxNode) => void): void {
  visitor(node)
  for (const child of node.children ?? []) walk(child, visitor)
}

const BROWSER_GLOBALS = new Set(['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history', 'matchMedia',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'alert', 'confirm', 'prompt', 'self',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'addEventListener', 'removeEventListener', 'getComputedStyle', 'XMLHttpRequest', 'WebSocket'])

/**
 * Whether a copied module must run on the client: it declares `'use client'`,
 * calls a hook, attaches an event handler, touches a browser global, builds a
 * context, extends a class, or imports anything besides React (a package or
 * scaffold module may itself need the client). Relative imports are judged on
 * their own copy. Anything else is a pure server module.
 */
function needsClientBoundary(source: ts.SourceFile): boolean {
  let needed = false
  const isHook = (name: string): boolean => /^use(?:[A-Z0-9]|$)/.test(name) || name === 'createContext'
  function visitNode(node: ts.Node): void {
    if (needed) return
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'use client') needed = true
    else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (!specifier.startsWith('.') && !SHARED_IMPORTS.has(specifier)) needed = true
    } else if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : ''
      if (isHook(callee) || callee === 'forwardRef' || callee === 'addEventListener' || callee === 'removeEventListener' || node.expression.kind === ts.SyntaxKind.ImportKeyword) needed = true
    } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && (/^on[A-Z]/.test(node.name.text) || node.name.text === 'ref')) needed = true
    // Spread props can carry handlers into a DOM element; fail closed.
    else if (ts.isJsxSpreadAttribute(node) && (ts.isJsxOpeningLikeElement(node.parent.parent)) && ts.isIdentifier(node.parent.parent.tagName) && /^[a-z]/.test(node.parent.parent.tagName.text)) needed = true
    // A handler prop read or destructured, or a hook referenced without being called (`const h = React.useState`).
    else if (ts.isIdentifier(node) && (isHook(node.text) || /^on[A-Z]/.test(node.text)) && !ts.isJsxAttribute(node.parent)) needed = true
    else if (ts.isIdentifier(node) && BROWSER_GLOBALS.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) needed = true
    else if (ts.isClassLike(node) && node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) needed = true
    ts.forEachChild(node, visitNode)
  }
  visitNode(source)
  return needed
}

function implicitReactImports(source: ts.SourceFile, onShadowed?: (names: Array<string>) => void): string {
  const bindings = new Set<string>()
  const references = new Set<string>()
  function bind(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) bindings.add(name.text)
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name)
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause
      if (clause.name) bindings.add(clause.name.text)
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bindings.add(clause.namedBindings.name.text)
        else for (const element of clause.namedBindings.elements) bindings.add(element.name.text)
      }
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bind(declaration.name)
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) bindings.add(statement.name.text)
    // TypeScript-only declarations bind a value name too: `enum`, `namespace`, `import A = B`.
    if ((ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) && ts.isIdentifier(statement.name)) bindings.add(statement.name.text)
  }
  // A `var` in a block, loop, `try` or `switch` at module level is a module binding too.
  hoistedVarNames(source, bindings)
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) references.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  const hooks = [...REACT_GLOBALS].filter((name) => references.has(name) && !bindings.has(name)).sort()
  // Mintlify's own snippet convention exposes its built-in MDX components as
  // an implicit global too (`const { Card } = MintlifyComponents;`, no
  // import).
  const usesMintlifyComponents = references.has('MintlifyComponents') && !bindings.has('MintlifyComponents')
  // Mintlify also makes built-ins available as bare JSX names inside snippet
  // modules. A copied module runs outside Mintlify's MDX scope, so explicitly
  // import every unbound name it uses before the destination build renders it.
  const leafBound = new Set<string>()
  const implicitComponents = MINTLIFY_COMPONENT_MODULES.map(({ module, names }) => {
    // `Note` is bound from the registry below like the rest of the callout
    // family: the bare leaf component lacks the preset `type` the built-in sets.
    const needed = names.filter((name) => name !== 'Note' && references.has(name) && !bindings.has(name))
    for (const name of needed) leafBound.add(name)
    return needed.length ? `import { ${needed.join(', ')} } from '${module}';` : ''
  }).filter(Boolean)
  // Built-ins with no leaf module of their own (`Warning`, `Info`, ... render
  // through Note with a preset `type`) resolve from the registry, which is
  // scope-aware: a name the module declares, imports or takes as a parameter
  // is never rebound. Read in the file's own mode: a `.ts` module has no JSX but
  // can still pass a built-in as a value (`createElement(Note)`).
  const { bind: builtinTags, shadowed } = unboundBuiltinTags(source.text, bindings, source.fileName)
  const registryNames = builtinTags.filter((name) => !leafBound.has(name))
  if (shadowed.length) onShadowed?.(shadowed)
  return [
    references.has('React') && !bindings.has('React') ? "import * as React from 'react';" : '',
    hooks.length ? `import { ${hooks.join(', ')} } from 'react';` : '',
    ...implicitComponents,
    registryNames.length ? builtinRegistryBindings(registryNames, identifierNames(source)) : '',
    usesMintlifyComponents ? mintlifyComponentsShim() : '',
  ].filter(Boolean).join('\n')
}

/**
 * A component extracted into its own client module (see `createComponentMigrator`'s
 * inline-hook extraction below) loses the page's implicit access to Thally's
 * built-in MDX components: unlike a component that stays inline in the page,
 * this module never receives a `components` prop to read a name such as
 * `CodeBlock` from. Any JSX tag it uses that isn't locally declared or
 * imported is resolved instead from `builtinMdxComponents`, the same
 * built-in registry every MDX page reads from — imported directly rather
 * than through `useMDXComponents`, which in turn imports the customer
 * registry that imports every extracted module, closing an import cycle
 * that throws at runtime once bundled.
 */
function resolveInlineBuiltinReferences(source: string, moduleNames: ReadonlySet<string>): string {
  const unresolved = unboundTags(source, moduleNames)
  if (unresolved.length === 0) return source
  return [builtinRegistryBindings(unresolved, identifierNames(sourceFile(source, 'inline.jsx'))), source].join('\n')
}

/** Every identifier a module spells anywhere, so a name it declares, imports or reads as a global is among them. */
function identifierNames(root: ts.Node): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return names
}

/**
 * Bind built-in components by name from the registry, the same way for every module the migration writes.
 * The registry is imported as `builtinMdxComponents` unless the module (`used`) already spells that name,
 * as its own declaration, an import or a global it reads: it then takes the first free numeric suffix, so
 * the import can neither redeclare the module's name nor capture a global it reads.
 */
function builtinRegistryBindings(names: ReadonlyArray<string>, used: ReadonlySet<string>): string {
  const registry = 'builtinMdxComponents'
  let alias = registry
  for (let suffix = 2; used.has(alias); suffix++) alias = `${registry}${suffix}`
  return [
    `import { ${alias === registry ? registry : `${registry} as ${alias}`} } from '@/components/mdx/builtin-components';`,
    `const { ${names.join(', ')} } = ${alias};`,
  ].join('\n')
}

/** Warning for a built-in tag that cannot be bound without replacing a JS global the module also uses. */
function shadowedBuiltinMessage(file: string, names: ReadonlyArray<string>): string {
  const tags = names.map((name) => `<${name}>`).join(', ')
  return `${file} renders ${tags} as a Thally built-in component but also uses the JavaScript global of the same name, so the tag was left unbound. Rename the component or the global use in the source.`
}

function imports(statement: ts.ImportDeclaration): Array<Binding> {
  if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) return []
  const clause = statement.importClause
  if (clause.isTypeOnly) return []
  const source = statement.moduleSpecifier.text
  const bindings: Array<Binding> = clause.name ? [{ local: clause.name.text, imported: 'default', source }] : []
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) bindings.push({ local: element.name.text, imported: element.propertyName?.text ?? element.name.text, source })
    }
  }
  return bindings
}

/**
 * Every component this migrator actually renders in a client boundary — a
 * copied import (`register`, always prefixed 'use client' by `copyGraph`) or
 * an inline-extracted interactive block (`Inline<n>`) — is renamed to one of
 * these two shapes in the transformed body. No other JSX tag (a Thally
 * built-in, an unregistered/removed component) ever matches.
 */
const EXTRACTED_CLIENT_COMPONENT_TAG = /^(?:Migrated[0-9a-f]+|Inline\d+)$/

/**
 * Thally's own runtime `src/components/mdx/builtin-components.tsx` registry names
 * whose backing module is a 'use client' file under `src/components/mdx/`.
 * Passing a page-authored function as a prop into any of these also throws
 * "Functions cannot be passed directly to Client Components" at render, the
 * same as an extracted component — so they are confirmed exclusion targets
 * too, not just unconfirmed-and-warned.
 *
 * This list is a snapshot, not a live read of the app (a published migrate
 * package cannot import from the app's `src/`). It is drift-guarded by
 * `src/components/mdx/client-registry.test.ts`, which recomputes the same
 * set from `src/components/mdx/*.tsx` and `builtin-components.tsx` and fails CI
 * if this snapshot goes stale.
 *
 * Source file per name (all under `src/components/mdx/`):
 *   Accordion, AccordionGroup      -> accordion.tsx
 *   AgentPrompt                    -> agent-prompt.tsx
 *   ResponseField, ParamField,
 *   Expandable                     -> api-fields.tsx
 *   CodeGroup                      -> code-blocks.tsx
 *   Badge, Tooltip                 -> content-inline.tsx
 *   Tabs, Tab                      -> content-tabs.tsx
 *   RequestExample, ResponseExample,
 *   InlineRequestExample,
 *   InlineResponseExample          -> examples.tsx
 *   Tree, Folder, File             -> file-tree.tsx
 *   Mermaid                        -> mermaid.tsx
 *   Panel, ContentPanel,
 *   InlinePanel                    -> panel.tsx
 *   Prompt, PromptUser,
 *   PromptAssistant, Terminal,
 *   TerminalInput, TerminalOutput  -> prompt.tsx
 *   View, Embed, LegacyView        -> view.tsx
 *   Color, Color.Item              -> color.tsx (server) spreads props into
 *                                      color-item.tsx's 'use client'
 *                                      ColorItemClient — a re-export, not a
 *                                      direct 'use client' file, so it is
 *                                      listed by hand (see the override map
 *                                      in client-registry.test.ts)
 */
export const CLIENT_BUILTIN_COMPONENT_TAGS: ReadonlySet<string> = new Set([
  'Accordion', 'AccordionGroup',
  'AgentPrompt',
  'ResponseField', 'ParamField', 'Expandable',
  'CodeGroup', 'CodeBlock',
  'Badge', 'Tooltip',
  'Tabs', 'Tab',
  'Steps', 'Step',
  'RequestExample', 'ResponseExample', 'InlineRequestExample', 'InlineResponseExample',
  'Tree', 'FileTree', 'Folder', 'File',
  'Mermaid',
  'Panel', 'ContentPanel', 'InlinePanel',
  'Prompt', 'PromptUser', 'PromptAssistant', 'Terminal', 'TerminalInput', 'TerminalOutput',
  'View', 'Embed', 'LegacyView',
  'Color', 'Color.Item',
])

function isConfirmedClientBoundaryTag(name: string): boolean {
  return EXTRACTED_CLIENT_COMPONENT_TAG.test(name) || CLIENT_BUILTIN_COMPONENT_TAGS.has(name)
}

/**
 * A JSX attribute's raw expression source (`prop={<this>}`), for the two
 * shapes that end up passing a function value: a bare reference to a
 * page-declared function (`declaredNames`), or a function written inline
 * right there (`() => ...`, `function () { ... }`). Only `mdxJsxAttribute`
 * nodes with an expression value carry a source string here; a string
 * literal attribute (`title="x"`) or a spread (`mdxJsxExpressionAttribute`)
 * never does, so this returns `undefined` for those.
 */
function functionValuedAttribute(node: MdxNode, declaredNames: ReadonlySet<string>): string | undefined {
  const isFunctionValue = (value: string) => declaredNames.has(value.trim()) || isFunctionInitializer(value.trim(), 0)
  for (const attribute of node.attributes ?? []) {
    const raw = attribute.value
    const value = raw && typeof raw === 'object' ? raw.value : undefined
    if (typeof value !== 'string') continue
    if (isFunctionValue(value)) return value
  }
  // Function-as-children (`<Accordion>{() => 'x'}</Accordion>`) is passed as
  // the `children` prop, so it crosses the same boundary. Inline children sit
  // inside a paragraph node; look one level into it.
  const children = (node.children ?? []).flatMap((child) => child.type === 'paragraph' ? child.children ?? [] : [child])
  for (const child of children) {
    if (['mdxFlowExpression', 'mdxTextExpression'].includes(child.type) && child.value && isFunctionValue(child.value)) return child.value
  }
  return undefined
}

/**
 * True when a name in `declaredNames` (typically a page's `export const`/
 * `export function` identifiers) is passed as a bare JSX prop
 * (`prop={Name}`), or a function is written inline as a prop value
 * (`prop={() => ...}`, `prop={function () { ... }}`), into a component
 * confirmed to cross the server/client boundary: one this migrator extracted
 * as a 'use client' module, or a Thally runtime built-in already backed by
 * one (`CLIENT_BUILTIN_COMPONENT_TAGS`). This is the only shape that really
 * throws "Functions cannot be passed directly to Client Components" at
 * render — the same check against an unconfirmed tag would over-fire and
 * drop pages that render just fine.
 *
 * JSX written inside a page's own `export const Name = () => <...>` (bound
 * for client extraction itself) is never visited here: `remark-mdx` parses
 * that whole declaration as a single `mdxjsEsm` text node, not as MDX JSX
 * element nodes, so `walk`'s `.children` traversal never reaches it — the
 * same reason fenced/inline code samples (parsed as `code`/`inlineCode` text
 * nodes) never reach it either.
 */
export function propsTargetExtractedClientComponent(body: string, declaredNames: ReadonlySet<string>): boolean {
  const tree = parser.parse(body) as MdxNode
  let found = false
  walk(tree, (node) => {
    if (found || !node.name || !isConfirmedClientBoundaryTag(node.name)) return
    if (functionValuedAttribute(node, declaredNames) !== undefined) found = true
  })
  return found
}

/**
 * Broader, unconfirmed signal: true when *any* JSX tag on the page (not
 * just a confirmed client boundary) receives a function-valued prop, the
 * same shapes `propsTargetExtractedClientComponent` looks for. Callers use
 * this to decide whether the page is worth a "might throw at render, review
 * manually" warning even when the receiving tag's own client/server status
 * cannot be confirmed.
 */
export function hasAnyFunctionValuedProp(body: string, declaredNames: ReadonlySet<string>): boolean {
  const tree = parser.parse(body) as MdxNode
  let found = false
  walk(tree, (node) => {
    if (found || !node.name) return
    if (functionValuedAttribute(node, declaredNames) !== undefined) found = true
  })
  return found
}

/**
 * True when a page's own inline `export const`/`export function` declaration
 * (kept in place, not extracted into a 'use client' module — see the
 * `mdxjsEsm` note above) references `document` or `window` as an identifier.
 * Next renders an MDX page as a Server Component by default, where neither
 * global exists; callers use this to warn rather than let the page fail at
 * render. Identifiers are found via the TS AST, so a string, comment, or
 * fenced code sample using the same words never counts.
 */
export function declarationsReferenceBrowserGlobal(body: string): boolean {
  const tree = parser.parse(body) as MdxNode
  let found = false
  function inspect(node: ts.Node): void {
    if (ts.isIdentifier(node) && (node.text === 'document' || node.text === 'window')) found = true
    ts.forEachChild(node, inspect)
  }
  for (const node of tree.children ?? []) {
    if (found || node.type !== 'mdxjsEsm' || node.value === undefined) continue
    for (const statement of sourceFile(node.value, 'inline.tsx').statements) {
      if (ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement)) inspect(statement)
    }
  }
  return found
}

/**
 * Relative code-module specifiers (`./metadata`, `../lib/x.js`) that a page's
 * own top-level `import`/`export ... from` still names after migration. The
 * migrator rewrites every component or data import it copies to an `@/mdx/
 * migrated/...` path, so a relative one that survives points at a file that is
 * never shipped beside the page (for example a Next.js app's `metadata.ts`)
 * and fails the site build with "Module not found". `.md`/`.mdx` specifiers
 * are left out: snippet imports are inlined or rewritten elsewhere.
 */
export function unresolvedRelativeModuleSpecifiers(body: string): Array<string> {
  const tree = parser.parse(body) as MdxNode
  const specifiers = new Set<string>()
  const add = (specifier: string): void => {
    if (/^\.\.?\//.test(specifier) && !/\.mdx?$/i.test(specifier)) specifiers.add(specifier)
  }
  walk(tree, (node) => {
    if (node.type !== 'mdxjsEsm' || node.value === undefined) return
    for (const statement of sourceFile(node.value, 'inline.tsx').statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue
      const specifier = statement.moduleSpecifier
      if (specifier && ts.isStringLiteral(specifier)) add(specifier.text)
    }
  })
  for (const { specifier } of dynamicImportLiterals(body, tree)) add(specifier)
  return [...specifiers]
}

/**
 * Every dynamic `import('<literal>')` in a page's ESM blocks, expressions and
 * JSX expression attributes. `start`/`end` locate the string literal in `body`
 * (so it can be rewritten in place) and are omitted when that location cannot
 * be confirmed against the source text.
 */
function dynamicImportLiterals(body: string, tree: MdxNode): Array<{ specifier: string; start?: number; end?: number }> {
  const found: Array<{ specifier: string; start?: number; end?: number }> = []
  // `origin` is where `code` starts in `body`; `prefix` is any wrapper length
  // added in front of it when it was parsed.
  const scan = (code: string, origin: number | undefined, prefix: number): void => {
    const source = sourceFile(prefix ? `(${code})` : code, 'inline.tsx')
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteralLike(argument)) {
          const start = origin === undefined ? undefined : origin + argument.getStart(source) - prefix
          const end = start === undefined ? undefined : start + argument.getWidth(source)
          const confirmed = start !== undefined && end !== undefined && body.slice(start, end) === argument.getText(source)
          found.push(confirmed ? { specifier: argument.text, start, end } : { specifier: argument.text })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  walk(tree, (node) => {
    if (node.type === 'mdxjsEsm' && node.value !== undefined) {
      scan(node.value, node.position?.start.offset, 0)
      return
    }
    if ((node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') && node.value !== undefined) {
      scan(node.value, node.position?.start.offset === undefined ? undefined : node.position.start.offset + 1, 1)
    }
    for (const attribute of node.attributes ?? []) {
      // A plain string attribute is text; only expression values are code.
      if (attribute.type === 'mdxJsxExpressionAttribute' && typeof attribute.value === 'string') {
        scan(attribute.value, attribute.position?.start.offset === undefined ? undefined : attribute.position.start.offset + 1, 1)
      } else if (typeof attribute.value === 'object' && attribute.value?.value !== undefined) {
        scan(attribute.value.value, attribute.position?.end.offset === undefined ? undefined : attribute.position.end.offset - 1 - attribute.value.value.length, 1)
      }
    }
  })
  return found
}

/** Create one bounded component graph and registry for a repository migration. */
/**
 * `siteRoot` (a Mintlify/Docusaurus project root, when one was detected —
 * `repositoryDir` otherwise) is what `@site/...`/root-relative (`/...`)
 * specifiers resolve against, matching Docusaurus' own alias semantics; a
 * warning's reported `source` and the generated destination paths stay
 * relative to it too, unchanged from before this parameter split. A plain
 * relative import (`../../components/X`), though, is written relative to
 * the importing *page*, which — in a monorepo where docs/ is a sibling of
 * website/ rather than nested under it (Redux) — can resolve outside
 * `siteRoot` even for a component the repository legitimately owns.
 * `confinementRoot` (always `repositoryDir`) is the actual security
 * boundary for that resolution and for `checkedFile`'s symlink safety walk,
 * so such an import still copies instead of throwing "path escapes its
 * root" for a component this migration should have imported.
 */

/**
 * Text-only safety net for a page whose MDX can't be parsed at all (see the
 * catch below `transform`'s own `parser.parse` call): with no AST to drive a
 * real copy/removal, this only guarantees the page still builds by dropping
 * a `@site/...`/relative component import and blanking its JSX usage,
 * narrowly matching the single-binding default/named-as-default shape
 * `SNIPPET_IMPORT_PATTERN` (repository.ts) already uses for the same reason.
 * A bare npm-package import is left alone — that failure mode ("module not
 * installed") is unrelated to why this page's MDX didn't parse, and this
 * pass has no way to tell whether it is actually used anywhere.
 */
function neutralizeUnresolvableImportsWithoutAst(content: string, currentFile: string, warn: (message: string, source: string) => void): string {
  const importPattern = /^import\s+(?:\{\s*(?:default\s+as\s+)?([A-Z][A-Za-z0-9_]*)\s*\}|([A-Z][A-Za-z0-9_]*))\s+from\s+(['"])((?:@site\/|\.\.?\/|\/)[^'"]+)\3\s*;?[ \t]*$/gm
  const dropped: Array<{ name: string; specifier: string }> = []
  let result = content.replace(importPattern, (_match, namedComponent: string | undefined, defaultComponent: string | undefined, _quote: string, specifier: string) => {
    dropped.push({ name: (namedComponent ?? defaultComponent) as string, specifier })
    return ''
  })
  for (const { name, specifier } of dropped) {
    warn(`Component import ${JSON.stringify(specifier)} could not be resolved because this page has invalid MDX (see the previous warning), so the import and its usage were removed to keep the site building.`, currentFile)
    const removed = mdxComment(` Removed <${name}>: unresolved during fallback migration `)
    result = replaceOutsideCodeAndComments(result, (segment) => segment
      .replace(new RegExp(`<${name}(?:\\s[^>]*)?/>`, 'g'), removed)
      .replace(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`, 'g'), removed))
  }
  return result
}

export function createComponentMigrator(siteRoot: string, confinementRoot: string, warnings: Array<MigrationWarning>, sourceIdentity: string): {
  transform: (raw: string, currentFile: string) => string
  files: () => Array<RenderedMigrationFile>
  /** Merge the component files of another migrated bundle (a sourceRef sub-site) into this one. */
  adopt: (incoming: ReadonlyArray<RenderedMigrationFile>) => void
} {
  const root = resolve(siteRoot)
  const confined = resolve(confinementRoot)
  // A destination can contain imports from several repositories with identical
  // snippet names. Stable source identity isolates their graphs without tying
  // registry names to a temporary checkout path or changing repeat imports.
  const destinationRoot = `src/mdx/migrated/${hash(sourceIdentity)}`
  const copied = new Map<string, RenderedMigrationFile>()
  const registrations = new Map<string, { path: string; imported: string }>()
  let copiedBytes = 0

  function warn(message: string, source: string): void {
    warnings.push({ code: 'unsupported-config', message, source: relative(root, source).replace(/\\/g, '/') })
  }

  function checkedFile(path: string): string {
    const local = relative(confined, path)
    resolveWithin(confined, local)
    let current = confined
    if (lstatSync(current).isSymbolicLink()) throw new Error('symbolic links are not imported')
    for (const segment of local.split(/[\\/]/)) {
      current = resolveWithin(current, segment)
      if (lstatSync(current).isSymbolicLink()) throw new Error('symbolic links are not imported')
    }
    if (!lstatSync(path).isFile()) throw new Error('dependency is not a regular file')
    return path
  }

  function expandCandidates(candidate: string): Array<string> {
    const candidates = [candidate]
    if (!extname(candidate)) {
      candidates.push(...['.tsx', '.jsx', '.ts', '.js', '.mjs', '.json', '.d.ts'].map((extension) => candidate + extension))
      candidates.push(...['index.tsx', 'index.jsx', 'index.ts', 'index.js'].map((name) => resolve(candidate, name)))
    } else if (extname(candidate) === '.js') {
      candidates.push(candidate.slice(0, -3) + '.ts', candidate.slice(0, -3) + '.tsx')
    }
    return candidates
  }

  /**
   * `allowFlattenedMirror` gates the repository-root retry for a *plain
   * relative* specifier (`./x`, `../x`) below. It must stay narrow: a
   * relative import resolves relative to the importing file by standard
   * Node semantics, full stop — rebasing that resolution onto the
   * repository root for every project with a nested docs directory (the
   * ordinary case, not a monorepo) let a missing/broken import like
   * `./bogus` silently resolve to an unrelated same-named file that
   * happens to live at the mirrored repository-root path, instead of
   * being reported as unresolvable. The one real need for a mirror is
   * Playwright's own build (`cp -r nodejs/* .` flattens the `nodejs/`
   * project root's contents, including its shared `images/`, up into the
   * repository root before the site is generated), reached only through
   * the `require('../asset.ext')` idiom below — so only that call site
   * passes `true`. Every ordinary component/`import` resolution passes
   * `false` (the default) and never rebases.
   */
  function resolveDependency(specifier: string, importer: string, allowFlattenedMirror = false): string {
    if (specifier.includes('\\') || specifier.includes('\0') || /[?#]/.test(specifier)) throw new Error('unsupported component dependency path')
    const candidates = specifier.startsWith('/')
      ? expandCandidates(resolveWithin(root, specifier.slice(1)))
      : expandCandidates(resolveWithin(confined, relative(confined, resolve(dirname(importer), specifier))))
    // A root-relative `@site/...`/`/...` specifier is Docusaurus' own alias
    // for its *project* root; when the shared component it names isn't
    // nested under the narrower detected project root, it can still be a
    // real, unambiguous repository-root path (Playwright's shared
    // `src/components` tree is a sibling of the `nodejs/` project, not
    // nested under it) — tried only after the direct, project-rooted path
    // fails. This is safe even outside a flattened-build layout: the
    // specifier itself names an absolute-from-some-root path, so the retry
    // can't be fooled into matching an unrelated file the way a *relative*
    // import's rebase (below) can.
    if (root !== confined && specifier.startsWith('/')) {
      candidates.push(...expandCandidates(resolveWithin(confined, specifier.slice(1))))
    }
    if (root !== confined && !specifier.startsWith('/') && allowFlattenedMirror) {
      try {
        const rebasedImporter = resolveWithin(confined, relative(root, importer))
        candidates.push(...expandCandidates(resolveWithin(confined, relative(confined, resolve(dirname(rebasedImporter), specifier)))))
      } catch {
        // Importer itself is outside the project root; nothing to rebase.
      }
    }
    for (const path of candidates) {
      if (existsSync(path) && lstatSync(path).isFile()) return checkedFile(path)
    }
    throw new Error(`component dependency ${specifier} was not found`)
  }

  function outputPath(path: string): string {
    // Must be `confined`, not `root`: a component reached via a relative
    // import from outside `root` (see `resolveDependency`) is still inside
    // `confined`, and a `../`-containing destination path would risk
    // writing outside `destinationRoot`.
    return `${destinationRoot}/source/${relative(confined, path).replace(/\\/g, '/')}`
  }

  function copyGraph(entry: string): string {
    // Stage the entire graph in memory. A missing leaf must not leave a partly
    // registered component or consume the successful-copy budget.
    const staged = new Map<string, RenderedMigrationFile>()
    const stagedWarnings: Array<{ path: string; omitted: number }> = []
    const stagedShadowed: Array<{ path: string; names: Array<string> }> = []
    /** Code modules awaiting their final prologue: client-ness is settled over the whole graph (see below). */
    const modules = new Map<string, { local: boolean; dependencies: Array<string>; render: (client: boolean) => string }>()
    let stagedBytes = 0
    /** Stage a small fixed-content shim module (see `DOCUSAURUS_THEME_SHIMS`) once, reused across every component that imports it. */
    function stageShim(filename: string, content: string): string {
      const shimDestination = `${destinationRoot}/shims/${filename}`
      if (!copied.has(shimDestination) && !staged.has(shimDestination)) staged.set(shimDestination, { path: shimDestination, content })
      return shimDestination
    }
    function visit(path: string): void {
      const destination = outputPath(path)
      if (copied.has(destination) || staged.has(destination)) return
      checkedFile(path)
      const size = lstatSync(path).size
      if (size > MAX_FILE_BYTES || copiedBytes + stagedBytes + size > MAX_COMPONENT_BYTES
        || copied.size + staged.size >= MAX_COMPONENT_FILES) throw new Error('component migration budget exceeded')
      const extension = extname(path).toLowerCase()
      if (!CODE_EXTENSIONS.has(extension) && !DATA_EXTENSIONS.has(extension)) throw new Error(`unsupported dependency file type ${extension}`)
      stagedBytes += size
      const content = readFileSync(path)
      staged.set(destination, { path: destination, content })
      if (!CODE_EXTENSIONS.has(extension)) {
        if (extension === '.css' && /@import\b|url\s*\(/i.test(content.toString('utf8'))) throw new Error('CSS resource dependencies require manual migration')
        if (extension === '.css' && path.toLowerCase().endsWith('.module.css')) {
          // A parse failure here (malformed CSS, an SCSS-only construct that
          // isn't valid CSS, ...) is treated the same as any other copy
          // failure: throw, so the dead-import-removal fallback in the
          // caller can neutralize its usage instead of shipping CSS
          // Turbopack would reject anyway.
          let sanitized: { css: string; omitted: number }
          try {
            sanitized = sanitizeCssModuleSelectors(content.toString('utf8'))
          } catch {
            throw new Error('CSS module could not be parsed to check for Turbopack-safe selectors')
          }
          if (sanitized.omitted > 0) stagedWarnings.push({ path, omitted: sanitized.omitted })
          staged.set(destination, { path: destination, content: sanitized.css })
        }
        return
      }
      const text = content.toString('utf8')
      // transpileModule cannot emit declaration files; parse their syntax as TS.
      const syntax = ts.transpileModule(text, { fileName: path.replace(/\.d\.ts$/, '.ts'), reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } })
      if (syntax.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error('component source contains unsupported JavaScript or TypeScript syntax')
      const ast = sourceFile(text, path)
      if (ast.statements.some((statement) => ts.isExpressionStatement(statement)
        && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use server')) throw new Error('server-only component modules require manual migration')
      const edits: Array<Replacement> = []
      const dependencies: Array<string> = []
      // Our own prologue re-adds the directive, so drop the source's to avoid a duplicate.
      for (const statement of ast.statements) {
        if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client') {
          edits.push({ start: statement.getStart(ast), end: statement.end, value: '' })
        }
      }
      function dependency(literal: ts.StringLiteralLike, importDeclaration?: ts.ImportDeclaration): void {
        const specifier = literal.text
        if (SHARED_IMPORTS.has(specifier) || isScaffoldProvidedImport(specifier)) return
        // `@docusaurus/Link` maps onto `next/link` (already scaffold-provided)
        // rather than a shim module: same default export, only its `to` prop
        // is renamed to `href` wherever the copied file itself uses the tag.
        if (specifier === '@docusaurus/Link') {
          edits.push({ start: literal.getStart(ast), end: literal.end, value: '"next/link"' })
          const localName = importDeclaration?.importClause?.name?.text
          if (localName) {
            function renameToProp(node: ts.Node): void {
              if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'to'
                && ts.isJsxOpeningLikeElement(node.parent.parent)
                && node.parent.parent.tagName.getText(ast) === localName) {
                edits.push({ start: node.name.getStart(ast), end: node.name.end, value: 'href' })
              }
              ts.forEachChild(node, renameToProp)
            }
            renameToProp(ast)
          }
          return
        }
        const shim = DOCUSAURUS_THEME_SHIMS[specifier]
        if (shim) {
          const shimPath = stageShim(shim.filename, shim.content)
          dependencies.push(shimPath)
          const nextPath = relative(dirname(destination), shimPath).replace(/\\/g, '/')
          edits.push({ start: literal.getStart(ast), end: literal.end, value: JSON.stringify(portableSpecifier(nextPath.startsWith('.') ? nextPath : `./${nextPath}`)) })
          return
        }
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
          throw new Error(specifier.startsWith('@/')
            ? `path alias ${specifier} points to source-site code the migration does not copy`
            : `external package ${specifier} requires manual installation and review`)
        }
        const target = resolveDependency(specifier, path)
        visit(target)
        dependencies.push(outputPath(target))
        const nextPath = relative(dirname(destination), outputPath(target)).replace(/\\/g, '/')
        edits.push({ start: literal.getStart(ast), end: literal.end, value: JSON.stringify(portableSpecifier(nextPath.startsWith('.') ? nextPath : `./${nextPath}`)) })
      }
      function inspect(node: ts.Node): void {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          dependency(node.moduleSpecifier, ts.isImportDeclaration(node) ? node : undefined)
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          const argument = node.arguments[0]
          if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) throw new Error('computed component imports require manual migration')
          dependency(argument)
        }
        ts.forEachChild(node, inspect)
      }
      inspect(ast)
      // Mark copied code as client-owned when it needs the browser (see
      // `needsClientBoundary`); browser hooks must never run in MDX's server
      // scope. A pure component stays a server module: as 'use client' it
      // would only see its server-rendered children as opaque references,
      // so a site component that walks `children` (a `{{KEY}}` template)
      // could not read the code it wraps.
      // The source site never ran `next build`'s full `tsc --noEmit` type
      // check (Docusaurus/Mintlify/Fern don't gate their own build on it),
      // so loose types, `window.ethereum`-style ambient globals, and
      // implicit `any` parameters that were fine there fail it here.
      // `@ts-nocheck` is valid in both `.ts(x)` and `.js(x)` files (a no-op
      // unless `checkJs` is on) and is the least invasive fix: it preserves
      // the component's real behavior instead of stripping or rewriting it.
      const replaced = applyReplacements(text, edits)
      // A `#!/...` shebang is only special on line 1 of the file (Node
      // strips it before parsing only there); inserting the `@ts-nocheck`
      // prologue above it would both break that and, since `// @ts-nocheck`
      // isn't itself a shebang, leave a dead shebang-looking comment mid
      // file. If the copied source starts with one, keep it first and
      // insert the prologue right after instead.
      const shebangMatch = /^#!.*\r?\n/.exec(replaced)
      modules.set(destination, {
        local: needsClientBoundary(ast),
        dependencies,
        render: (client) => {
          const prologue = `// @ts-nocheck\n${client ? "'use client';\n" : ''}\n`
          const implicit = implicitReactImports(ast, (names) => stagedShadowed.push({ path, names }))
          return shebangMatch
            ? shebangMatch[0] + prologue + implicit + '\n' + replaced.slice(shebangMatch[0].length)
            : prologue + implicit + '\n' + replaced
        },
      })
    }
    visit(entry)
    // A client module's importers must be client modules too: a server module
    // calling a function exported by a client module fails at render ("Attempted
    // to call fmt() from the server"). Settle that to a fixpoint over the graph;
    // a module imported from an earlier graph is judged by its emitted directive.
    const clientModules = new Set([...modules].filter(([, module]) => module.local).map(([path]) => path))
    const isClient = (path: string): boolean => clientModules.has(path)
      || (!modules.has(path) && /^\s*(?:\/\/[^\n]*\n\s*)*['"]use client['"]/.test(String((copied.get(path) ?? staged.get(path))?.content ?? '')))
    for (let changed = true; changed;) {
      changed = false
      for (const [path, module] of modules) {
        if (!clientModules.has(path) && module.dependencies.some(isClient)) {
          clientModules.add(path)
          changed = true
        }
      }
    }
    for (const [path, module] of modules) staged.set(path, { path, content: module.render(clientModules.has(path)) })
    for (const [path, file] of staged) copied.set(path, file)
    for (const { path, names } of stagedShadowed) warn(shadowedBuiltinMessage(relative(root, path).replace(/\\/g, '/'), names), path)
    for (const { path, omitted } of stagedWarnings) {
      warn(`Site-authored CSS module ${relative(root, path).replace(/\\/g, '/')} has ${omitted} global-only selector branch(es) that cannot be copied into Thally CSS Modules; those styles were omitted.`, path)
    }
    copiedBytes += stagedBytes
    return outputPath(entry)
  }

  /**
   * Copy a binary asset verbatim to a stable `public/` path (bypassing
   * `copyGraph`'s JS-module handling entirely — the asset is bound to its
   * URL string, never imported as a module) and return that URL. Used when
   * an import couldn't be copied as a component but names a real file the
   * page only ever references by URL (`src={Logo}`), never as a JSX tag.
   */
  function copyPublicAsset(path: string): string {
    checkedFile(path)
    const size = lstatSync(path).size
    if (size > MAX_FILE_BYTES || copiedBytes + size > MAX_COMPONENT_BYTES || copied.size >= MAX_COMPONENT_FILES) {
      throw new Error('component migration budget exceeded')
    }
    const publicName = `migrated-${hash(relative(confined, path))}${extname(path).toLowerCase()}`
    const destination = `public/${publicName}`
    if (!copied.has(destination)) {
      copied.set(destination, { path: destination, content: readFileSync(path) })
      copiedBytes += size
    }
    return `/${publicName}`
  }

  /**
   * Docusaurus ships SVGR out of the box, so `import Foo from './foo.svg';
   * <Foo />` renders the SVG as a real component there. The migrated
   * project has no SVGR loader, so importing an `.svg` file the ordinary
   * way (`copyGraph`'s ordinary path, used below) yields whatever the
   * bundler's default asset handling returns for it — a URL string or a
   * `{ src }` object, either way not a valid React element type — and
   * `<Foo />` throws "Element type is invalid" at render. Used only when
   * the import is actually rendered as a JSX tag (an attribute-only usage,
   * `src={Foo}`, needs no wrapper and is left as the plain import): stage a
   * tiny companion module next to the copied SVG that imports it as a URL
   * either way and renders a plain `<img>`, and register that instead of
   * the raw file.
   */
  function wrapSvgAsComponent(svgOutputPath: string): string {
    const wrapperPath = `${svgOutputPath}.component.tsx`
    if (!copied.has(wrapperPath)) {
      const content = [
        "'use client'",
        '',
        `import svgSource from ${JSON.stringify(`./${basename(svgOutputPath)}`)}`,
        '',
        'export default function SvgImage(props: Record<string, unknown>) {',
        '  const src = typeof svgSource === "string" ? svgSource : (svgSource as { src: string }).src',
        '  // eslint-disable-next-line @next/next/no-img-element -- no SVGR loader is configured; this renders the raw file.',
        '  return <img src={src} alt="" {...props} />',
        '}',
        '',
      ].join('\n')
      copied.set(wrapperPath, { path: wrapperPath, content })
    }
    return wrapperPath
  }

  function register(path: string, imported: string): string {
    const name = `Migrated${hash(`${path}:${imported}`)}`
    registrations.set(name, { path, imported })
    return name
  }

  function transform(raw: string, currentFile: string): string {
    const parsedFrontmatter = parseFrontmatter(raw).content
    const frontmatter = raw.slice(0, raw.length - parsedFrontmatter.length)
    // remark-mdx does not parse a raw HTML comment (`<!-- ... -->`) at all —
    // a real source page commonly has one (Docusaurus' own
    // `<!-- prettier-ignore -->` ahead of a snippet import) and it
    // otherwise throws here before this pass ever runs, leaving whatever
    // import that comment sits near completely untouched. `normalizeMdx`
    // converts the same syntax later in the pipeline anyway, so doing it
    // here too (on this function's own working copy) is never wasted work.
    // Likewise a heading's explicit `{#custom-id}` suffix is never valid MDX
    // (a bare `{...}` in prose is always parsed as a JS expression, and no
    // JS expression starts with `#`) regardless of platform, so converting
    // it up front is always safe — and it must happen before this
    // function's own parse below, or that parse throws first and this
    // whole page's import analysis is skipped instead of just this one
    // page's expression.
    // A `{/* #id */}` comment already on a heading is a Mintlify heading id and
    // is valid MDX, so it is kept rather than rewritten to an anchor.
    const content = normalizeExplicitHeadingIds(normalizeIndentedFences(normalizeHtmlComments(parsedFrontmatter)), undefined, { keepIdComments: true })
    let tree: MdxNode
    try {
      tree = parser.parse(content) as MdxNode
    } catch {
      warn('Custom component analysis could not parse this MDX; its source was preserved for manual migration.', currentFile)
      // The AST walk below is how every `@site/...`/relative component
      // import normally gets copied or removed; none of that runs on a page
      // that can't even be parsed. Left alone, an import like that survives
      // verbatim and breaks `next build` with "Module not found" for the
      // whole site, not just this page — the same failure mode the AST path
      // already guards against everywhere else. This is a text-only,
      // best-effort safety net (no AST here to drive a real copy), narrow by
      // design: only the single-binding default/named-as-default import
      // shape actually seen in practice, mirroring `SNIPPET_IMPORT_PATTERN`.
      return frontmatter + neutralizeUnresolvableImportsWithoutAst(content, currentFile, warn)
    }
    const aliases = new Map<string, string>()
    const unsupportedImports = new Map<string, string>()
    // Local names dropped by the lowercase-named `.mdx?` import case below
    // (Docusaurus' auto-generated per-file `toc` export, merged into
    // another page's own `toc` via `...viewsToc`) — collected here so the
    // spread-removal pass after the main walk can find every one of them,
    // regardless of which esmNode declared the import vs. used it.
    const droppedMdxDataBindings = new Set<string>()
    const edits: Array<Replacement> = []
    const declarations: Array<{ start: number; end: number; source: string }> = []
    const moduleImports: Array<string> = []
    const realPageImports: Array<string> = []
    const serverPageDeclarations: Array<string> = []
    const sharedImportEdits: Array<Replacement> = []
    let hasUnsupportedImports = false
    function hasExpressionReference(names: Set<string>, options: {
      excludedNodes?: Array<MdxNode>
      includeDeclarations?: boolean
      includeDirectTags?: boolean
    } = {}): boolean {
      let found = false
      function inspect(node: ts.Node): void {
        if (ts.isIdentifier(node) && names.has(node.text)) found = true
        ts.forEachChild(node, inspect)
      }
      walk(tree, (node) => {
        if (options.excludedNodes?.some((excluded) => node.position?.start.offset !== undefined
          && node.position.end.offset !== undefined
          && node.position.start.offset >= excluded.position!.start.offset!
          && node.position.end.offset <= excluded.position!.end.offset!)) return
        if (node.name && [...names].some((name) => node.name!.startsWith(`${name}.`)
          || (options.includeDirectTags && node.name === name))) found = true
        if (options.includeDeclarations !== false && node.type === 'mdxjsEsm' && node.value) {
          for (const statement of sourceFile(node.value, 'expression.tsx').statements) {
            if (!ts.isImportDeclaration(statement)) inspect(statement)
          }
        }
        const expressions = [
          ...(['mdxFlowExpression', 'mdxTextExpression'].includes(node.type) ? [node.value ?? ''] : []),
          ...(node.attributes ?? []).flatMap((attribute) => {
            if (attribute.type === 'mdxJsxExpressionAttribute' && typeof attribute.value === 'string') return [attribute.value]
            return attribute.value && typeof attribute.value === 'object' ? [attribute.value.value ?? ''] : []
          }),
        ]
        for (const expression of expressions) inspect(sourceFile(expression, 'expression.tsx'))
      })
      return found
    }
    /** True when `name` is ever a JSX tag's own root name (`<name ...>`), regardless of any other usage — narrower than `hasExpressionReference`'s combined signal, needed where a string binding (an asset's URL) is fine for any *other* usage but not this one. */
    function usedAsJsxTagName(name: string): boolean {
      let found = false
      walk(tree, (node) => { if (node.name === name) found = true })
      return found
    }
    // Docusaurus allows a real `import`/`export` ESM block anywhere in the
    // body, not just at the top of the file — a documentation page
    // demonstrating a live code example commonly nests one inside a JSX
    // wrapper (`<BrowserWindow>\nimport Foo from './foo.svg'\n\n<Foo
    // /></BrowserWindow>`, straight from Docusaurus' own docs). remark-mdx
    // still parses each as its own `mdxjsEsm` node, just nested under that
    // wrapper's `children` instead of `tree.children` directly, so this
    // must walk the whole tree to find every one of them; a scan of only
    // `tree.children` silently skips a nested import, leaving the page
    // referencing a path the migrated project never has ("Module not
    // found") without any warning at all.
    const esmNodes: Array<MdxNode> = []
    walk(tree, (node) => { if (node.type === 'mdxjsEsm') esmNodes.push(node) })
    for (const node of esmNodes) {
      if (node.value === undefined || node.position?.start.offset === undefined) continue
      const ast = sourceFile(node.value, 'inline.tsx')
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement)) {
          // `export ... from './x'` of a file the migration copies points at
          // the copied module; one that cannot be copied falls through and the
          // page is excluded afterwards (repository.ts).
          const reexport = ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            && /^\.\.?\//.test(statement.moduleSpecifier.text) && !/\.mdx?$/i.test(statement.moduleSpecifier.text)
            ? statement.moduleSpecifier : undefined
          if (reexport) {
            try {
              const path = copyGraph(resolveDependency(reexport.text, currentFile))
              edits.push({
                start: node.position.start.offset + reexport.getStart(ast),
                end: node.position.start.offset + reexport.end,
                value: JSON.stringify(portableSpecifier(`@/${path.replace(/^src\//, '').replace(/\\/g, '/')}`)),
              })
              continue
            } catch {
              // Not shipped: handled below.
            }
          }
          let unsupportedDependency = ts.isExportDeclaration(statement) && !!statement.moduleSpecifier
          function inspect(node: ts.Node): void {
            if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
              || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) unsupportedDependency = true
            ts.forEachChild(node, inspect)
          }
          inspect(statement)
          if (unsupportedDependency) {
            hasUnsupportedImports = true
            warn('Inline MDX module dependencies require manual extraction; source was preserved.', currentFile)
          }
          declarations.push({
            start: node.position.start.offset + statement.getStart(ast),
            end: node.position.start.offset + statement.end,
            source: statement.getText(ast),
          })
          continue
        }
        const bindings = imports(statement)
        const rawSpecifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
        // `@site/...` is Docusaurus' and Mintlify's shared alias for the
        // project root; treat it exactly like the root-relative `/...` form
        // `resolveDependency` already understands, so a locally-owned
        // component copies the same way a relative import would.
        const specifier = rawSpecifier.startsWith('@site/') ? `/${rawSpecifier.slice('@site/'.length)}` : rawSpecifier
        if (isScaffoldProvidedImport(specifier)) {
          // Some translated Mintlify pages place a React hook import above a
          // fenced example. Keeping that unused import turns server MDX into
          // a module that illegally imports a client-only hook.
          if (specifier === 'react' && bindings.length > 0
            && bindings.every((binding) => REACT_GLOBALS.has(binding.imported))
            && !hasExpressionReference(new Set(bindings.map((binding) => binding.local)))) {
            edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
            continue
          }
          // Installed in the migrated project: keep it on the page (content
          // outside an extracted block may use it) and copy it into any
          // extracted client module, whose moved declarations may use it too.
          moduleImports.push(statement.getText(ast))
          continue
        }
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
          if (SHARED_IMPORTS.has(specifier)) {
            const isUnusedReactHookImport = specifier === 'react' && bindings.length > 0
              && bindings.every((binding) => REACT_GLOBALS.has(binding.imported))
              && !hasExpressionReference(new Set(bindings.map((binding) => binding.local)))
            if (!isUnusedReactHookImport) moduleImports.push(statement.getText(ast))
            // A shared React import is normally retained in server MDX. An
            // unused hook import belongs only to a fenced example and would
            // cause Next's server-component build to reject the whole page.
            if (isUnusedReactHookImport) edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
            else sharedImportEdits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
          } else if (specifier.startsWith('@theme/') || specifier.startsWith('@docusaurus/')) {
            // Docusaurus' own theme/runtime components (Tabs, TabItem, Link,
            // useBaseUrl, ...) are converted to Thally's equivalents by
            // normalizeMdx right after this pass; just drop the now-redundant
            // import and leave JSX usage untouched for that pass to rewrite.
            edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
          } else if (hasExpressionReference(new Set(bindings.map((binding) => binding.local)))) {
            // Only JSX usage (`<Widget />`) is rewritten below; a reference
            // in `{pkg.fn()}`, a prop, or an inline `export const` cannot be
            // rewritten the same way. Dropping the import would leave an
            // undefined identifier; keeping it imports a package that is not
            // installed in the migrated project, which fails `next build`
            // for the *whole* site with "Module not found" — not just this
            // page. Excluding the page is the only option that keeps the
            // rest of the site building; `pruneMissingNavigationPages` (see
            // repository.ts) then drops it from navigation too.
            warnings.push({
              code: 'skipped-file',
              message: `This page was excluded because it uses '${bindings.map((binding) => binding.local).join(', ')}' from ${unavailableImportLabel(rawSpecifier)} outside JSX (in an expression, prop, or inline declaration), and that import isn't available in the migrated project. Make '${rawSpecifier}' available and add the import back manually, or rewrite the page to avoid it.`,
              source: relative(root, currentFile).replace(/\\/g, '/'),
            })
            hasUnsupportedImports = true
          } else {
            // An npm package Thally's runtime does not ship is not installed
            // in the migrated project; leaving the import in place breaks
            // `next build` with "Module not found". Drop the import and
            // replace its JSX usage with a safe fallback instead (see the
            // `unsupportedImports` walk below) rather than shipping a page
            // that cannot compile.
            warn(`MDX import of ${unavailableImportLabel(rawSpecifier)} is not available in the migrated project; the import was removed and its usage replaced.`, currentFile)
            edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
            for (const binding of bindings) unsupportedImports.set(binding.local, rawSpecifier)
          }
          continue
        }
        if (/\.mdx?$/.test(specifier)) {
          // A capitalized default/named import here is a JSX-usable
          // partial (`import Partial from './x.mdx'`, `<Partial />`) — the
          // earlier text-level snippet-inlining pass (`inlineMdxSnippets`,
          // repository.ts) already resolved and removed those before this
          // AST walk ever runs, so reaching this point with only lowercase
          // bindings means every one is a plain named value that pass
          // can't touch: Docusaurus' own convention of auto-generating a
          // `toc` export per `.mdx` file, commonly re-exported by spreading
          // it into another page's `toc` (`export const toc = [...viewsToc,
          // ...]`). The migrated project has no such module to import from
          // ("Module not found"), and no way to compute the value, so the
          // import and that one safe, common usage shape are both removed;
          // anything shaped differently is left for the npm-style
          // expression-reference check below to exclude the page instead of
          // guessing at a replacement.
          if (bindings.length > 0 && bindings.every((binding) => !/^[A-Z]/.test(binding.local))) {
            warn(`MDX named import of ${JSON.stringify(rawSpecifier)} isn't a component and has no equivalent in the migrated site (for example Docusaurus's generated 'toc' export), so it was removed, along with any '...${bindings.map((binding) => binding.local).join(", '...")}' spread of it.`, currentFile)
            edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
            for (const binding of bindings) droppedMdxDataBindings.add(binding.local)
          }
          continue
        }
        // A binary asset (`docusaurusLogo.svg`, a `.docx` handout, ...) is
        // never really "a component" — it's fine bound to any identifier
        // shape and referenced from an expression (`src={docusaurusLogo}`),
        // unlike the component-alias mechanism below, which can only
        // rewrite a literal JSX tag name, not an arbitrary expression
        // reference. Handle it before the component-shaped checks reject it
        // for the wrong reason (a lowercase local name, expression usage)
        // and leave a dead import behind. Only bail out of this path (to
        // the ordinary handling below, which removes the import either way)
        // when the same local name is *also* used as a JSX tag — a string
        // URL bound there would throw just as hard as the missing import.
        if (bindings.length && RESCUABLE_ASSET_EXTENSIONS.has(extname(specifier).toLowerCase())
          && !bindings.some((binding) => usedAsJsxTagName(binding.local))) {
          try {
            const href = copyPublicAsset(resolveDependency(specifier, currentFile))
            edits.push({
              start: node.position.start.offset + statement.getStart(ast),
              end: node.position.start.offset + statement.end,
              // `export`, not a bare `const`: this replaces an `import`
              // statement in place, and the final MDX compile (a fresh
              // parse of this text, not a reuse of this pass's own AST)
              // only recognizes a top-level JS block as ESM — evaluated and
              // its bindings put in scope — when it starts with `import` or
              // `export`. A bare `const` there is just prose to that parser
              // and renders as literal paragraph text instead, leaving
              // every reference to this binding a `ReferenceError` at
              // render (reproduced against hasura/graphql-engine's
              // databases/overview.mdx, which binds asset URLs this way).
              value: bindings.map((binding) => `export const ${binding.local} = ${JSON.stringify(href)};`).join('\n'),
            })
            warn(`Asset import ${JSON.stringify(rawSpecifier)} was copied to ${href} and bound to that URL instead of importing it as a component.`, currentFile)
            continue
          } catch {
            // Not actually resolvable/copyable (missing file, budget) —
            // fall through to the ordinary handling below.
          }
        }
        if (!statement.importClause) {
          // Same treatment as a side-effect import of an npm package above:
          // stylesheets and setup scripts have no effect on the migrated
          // page, and leaving the import would reference a file that is not
          // shipped beside it.
          warn(`MDX side-effect import of ${JSON.stringify(rawSpecifier)} has no effect in the migrated site (stylesheets and setup scripts are not copied); the import was removed.`, currentFile)
          edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
          continue
        }
        if (statement.importClause.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)) {
          // A namespace import cannot be registered as a JSX tag, but it can
          // be imported for real from the copied file, like an expression-used
          // named import. When the target cannot be copied the import is left
          // alone and the page is excluded afterwards (repository.ts).
          try {
            const path = copyGraph(resolveDependency(specifier, currentFile))
            const aliasSpecifier = portableSpecifier(`@/${path.replace(/^src\//, '').replace(/\\/g, '/')}`)
            realPageImports.push(`import ${statement.importClause.getText(ast)} from ${JSON.stringify(aliasSpecifier)};`)
            edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
          } catch {
            hasUnsupportedImports = true
          }
          continue
        }
        // Unlike the unavailable-npm-package case above, a local/relative
        // import is fully owned by the migration: `copyGraph` below moves
        // the whole file (and its own local dependency graph) into the
        // project, and the statement it emits keeps every binding's original
        // local name (`as ${binding.local}`) — only the module specifier
        // changes. Nothing in the page body needs renaming, so it makes no
        // difference whether a binding is used as a bare JSX tag or only
        // referenced elsewhere (an enum member on a sibling prop, a member
        // tag, a wrapping declaration, ...): the copy is attempted either
        // way, and the page is excluded only if that copy genuinely fails
        // (an unsupported dependency inside the local graph — see the catch
        // below), not merely because of how the binding is used.
        try {
          const sourcePath = resolveDependency(specifier, currentFile)
          const path = copyGraph(sourcePath)
          const isSvgUsedAsTag = extname(path).toLowerCase() === '.svg' && bindings.some((binding) => usedAsJsxTagName(binding.local))
          for (const binding of bindings) {
            const registerPath = isSvgUsedAsTag ? wrapSvgAsComponent(path) : path
            const registerImported = isSvgUsedAsTag ? 'default' : binding.imported
            // MDX's own component-injection pass (recma-jsx-rewrite) only
            // rewrites a JSX tag it finds as a genuine, direct mdast JSX
            // node (`<Foo>` as its own markdown/JSX child) to pull from the
            // shared `_components` scope (the customComponents registry
            // below) — the alias-rename walk further down can likewise only
            // text-replace that same direct form. Any other shape —
            // `Capability.ToolUse` in a sibling prop's object literal,
            // `<Widget />` nested inside a `{...}` expression or an
            // `export const` declaration, a member tag `<Widget.Item />`,
            // a plain value passed as a prop (`as={Widget}`) — is invisible
            // to both, and registering it under an aliased key would leave
            // the literal reference an unresolved free variable
            // (`ReferenceError` at render; reproduced against a real
            // Cohere build for both an enum-in-a-prop and a component
            // nested in a `.map()` callback). Give any such binding a real
            // import instead, keeping its original local name and using the
            // project's `@/` alias so the specifier resolves regardless of
            // where the generated runtime module that embeds this page
            // ends up on disk.
            if (!isSvgUsedAsTag && hasExpressionReference(new Set([binding.local]))) {
              const helper = staticServerHelper(sourcePath, binding.imported, binding.local)
              if (helper) {
                serverPageDeclarations.push(helper)
                continue
              }
              const aliasSpecifier = portableSpecifier(`@/${registerPath.replace(/^src\//, '').replace(/\\/g, '/')}`)
              realPageImports.push(`import { ${registerImported} as ${binding.local} } from ${JSON.stringify(aliasSpecifier)};`)
              continue
            }
            const name = register(registerPath, registerImported)
            aliases.set(binding.local, name)
            moduleImports.push(`import { ${registerImported} as ${binding.local} } from ${JSON.stringify(portableSpecifier(`./${relative(destinationRoot, registerPath).replace(/\\/g, '/')}`))};`)
          }
          edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
        } catch (error) {
          if (hasExpressionReference(new Set(bindings.map((binding) => binding.local)))) {
            warnings.push({
              code: 'skipped-file',
              message: `This page was excluded because local import ${JSON.stringify(rawSpecifier)} could not be copied and is used in an expression: ${error instanceof Error ? error.message : 'unsupported dependency'}.`,
              source: relative(root, currentFile).replace(/\\/g, '/'),
            })
            hasUnsupportedImports = true
            continue
          }
          const failedPackage = error instanceof Error
            ? error.message.match(/^external package (\S+) requires manual installation and review$/)?.[1]
            : undefined
          if (failedPackage && YOUTUBE_ID_PACKAGES.has(failedPackage)) {
            // The local wrapper's own body just re-exports a known
            // YouTube-embed package one level down (Playwright's
            // `LiteYouTube` wraps `react-lite-youtube-embed` this way); the
            // wrapper itself can't be copied, but its usage is id-prop-shaped
            // exactly like a direct import of that package, so the same
            // working `<iframe>` fallback below applies instead of losing
            // the embed to the generic unknown-component neutralization.
            for (const binding of bindings) unsupportedImports.set(binding.local, failedPackage)
            edits.push({ start: node.position.start.offset + statement.getStart(ast), end: node.position.start.offset + statement.end, value: '' })
            continue
          }
          hasUnsupportedImports = true
          const importStart = node.position.start.offset + statement.getStart(ast)
          const importEnd = node.position.start.offset + statement.end
          // The component itself couldn't be copied (unsupported syntax, a
          // budget limit, a missing file, ...). Leaving the import in place
          // referenced a module that will never exist in the migrated
          // project, which fails `next build` for the *whole* site with
          // "Module not found" — not just this page (the same reasoning as
          // the unsupported-npm-import case above). Remove it. Its bindings
          // are known to be used only as JSX tags here (any expression/prop
          // usage already excluded this import from reaching this try, via
          // the `hasExpressionReference` check above), so a plain-page
          // rescan (`replaceUnknownComponents`, mdx.ts, run by repository.ts
          // after this transform) will find each now-undeclared tag and
          // neutralize it (a paired tag keeps its children in a `<div>`; a
          // self-closing one is removed) rather than leave a dangling
          // reference.
          let rescuedAssetHref: string | undefined
          if (RESCUABLE_ASSET_EXTENSIONS.has(extname(specifier).toLowerCase())) {
            // Only worth rescuing as a URL string when nothing ever renders
            // it as a JSX tag (`<Logo />`) — a string bound to a component
            // reference would throw just as hard as the missing import did.
            const usedAsJsxTag = bindings.some((binding) => hasExpressionReference(new Set([binding.local]), { includeDirectTags: true }))
            if (!usedAsJsxTag) {
              try {
                rescuedAssetHref = copyPublicAsset(resolveDependency(specifier, currentFile))
              } catch {
                rescuedAssetHref = undefined
              }
            }
          }
          if (rescuedAssetHref !== undefined) {
            edits.push({
              start: importStart,
              end: importEnd,
              // See the identical `export const` note on the other asset
              // rescue above — same reason.
              value: bindings.map((binding) => `export const ${binding.local} = ${JSON.stringify(rescuedAssetHref)};`).join('\n'),
            })
            warn(`Asset import ${JSON.stringify(rawSpecifier)} could not be copied as a component; it was copied to ${rescuedAssetHref} and bound to that URL instead.`, currentFile)
          } else {
            edits.push({ start: importStart, end: importEnd, value: '' })
            warn(`Site-authored component import ${JSON.stringify(rawSpecifier)} could not be copied and was removed: ${error instanceof Error ? error.message : 'unsupported dependency'}. Its usage on this page was neutralized; review this custom implementation manually.`, currentFile)
          }
        }
      }
    }

    // Extract a page's own inline component that calls a React hook (Mintlify
    // treats hooks as pre-injected globals for such components, but Thally's
    // page module is a Server Component and cannot import a hook itself) into
    // a client module, together with every page-local declaration it uses.
    // `planInlineExtraction` decides what moves, what the page keeps a copy
    // of, and whether the move is safe at all; an unsafe one is left in place
    // and reported. Whatever the page still renders is wired back as a
    // registered tag, or a real import when it is reached by name.
    const refusedInlineComponents = new Set<string>()
    {
      const plan = planInlineExtraction({
        declarations,
        tree,
        copyableImports: [...moduleImports, ...realPageImports],
        helperDeclarations: serverPageDeclarations,
        unavailableImports: unsupportedImports,
        reactGlobals: REACT_GLOBALS,
      })
      for (const { name, reason } of plan.blocked) {
        refusedInlineComponents.add(name)
        warn(`Inline component "${name}" calls a React hook but was left in the page: ${reason}. Move it and everything it uses into a client component manually.`, currentFile)
      }
      const moduleSource = plan.moved.length === 0 ? '' : [
        ...plan.moduleImports, ...plan.moduleHelpers,
        ...[...plan.moved, ...plan.copied].sort((a, b) => a - b).map((index) => declarations[index].source),
      ].join('\n\n')
      if (plan.moved.length > 0
        && (copied.size >= MAX_COMPONENT_FILES || Buffer.byteLength(moduleSource) > MAX_FILE_BYTES
          || copiedBytes + Buffer.byteLength(moduleSource) > MAX_COMPONENT_BYTES)) {
        warn(`Inline component "${plan.movedNames[0]}" exceeded the component migration budget; source was preserved.`, currentFile)
      } else if (plan.moved.length > 0) {
        const path = `${destinationRoot}/inline-${hash(`${relative(root, currentFile)}:components`)}.jsx`
        const inlineSource = `${resolveInlineBuiltinReferences(moduleSource, plan.moduleNames)}\n`
        copied.set(path, { path, content: `'use client';\n${implicitReactImports(sourceFile(inlineSource, 'inline.jsx'))}\n${inlineSource}` })
        copiedBytes += Buffer.byteLength(inlineSource)
        const movedIndexes = new Set(plan.moved)
        for (const index of plan.moved) edits.push({ start: declarations[index].start, end: declarations[index].end, value: '' })
        for (const name of plan.registryNames) {
          const registered = register(path, name)
          aliases.set(name, registered)
          // A root the page still extracts as interactive JSX (below) imports
          // the moved component from this module by its real name.
          moduleImports.push(`import { ${name} } from ${JSON.stringify(portableSpecifier(`./${relative(destinationRoot, path).replace(/\\/g, '/')}`))};`)
        }
        if (plan.pageImportNames.length > 0) {
          realPageImports.push(`import { ${plan.pageImportNames.join(', ')} } from ${JSON.stringify(portableSpecifier(`@/${path.replace(/^src\//, '').replace(/\\/g, '/')}`))};`)
        }
        // A React import the page only kept for the code that just moved would
        // make the page itself import a hook; drop it once nothing else uses it.
        for (const entry of [...sharedImportEdits]) {
          const locals = [...sourceFile(content.slice(entry.start, entry.end), 'shared.tsx').statements]
            .flatMap((statement) => ts.isImportDeclaration(statement) ? imports(statement).map((binding) => binding.local) : [])
          if (locals.length === 0 || locals.some((local) => plan.pageReferences.has(local))) continue
          edits.push(entry)
          sharedImportEdits.splice(sharedImportEdits.indexOf(entry), 1)
        }
        for (let index = declarations.length - 1; index >= 0; index -= 1) {
          if (movedIndexes.has(index)) declarations.splice(index, 1)
        }
      }
    }

    // Remove every `...name` spread of a dropped MDX data import (see the
    // lowercase-binding `.mdx?` case above) from any array literal it
    // appears in, so the export that merges it (`export const toc =
    // [...viewsToc, ...]`) stays valid instead of throwing on the now-
    // undefined identifier. Only the spread element itself is touched
    // (plus one adjacent comma, so the array literal it lived in stays
    // syntactically valid); a bare reference to the same name elsewhere is
    // intentionally left alone for `hasExpressionReference`'s excluded-page
    // path elsewhere in this function to catch instead of guessing at it.
    if (droppedMdxDataBindings.size > 0) {
      for (const node of esmNodes) {
        if (node.value === undefined || node.position?.start.offset === undefined) continue
        const nodeStart = node.position.start.offset
        const nodeText = node.value
        const ast = sourceFile(nodeText, 'inline.tsx')
        function stripDroppedSpreads(inner: ts.Node): void {
          if (ts.isSpreadElement(inner) && ts.isIdentifier(inner.expression) && droppedMdxDataBindings.has(inner.expression.text)) {
            const start = nodeStart + inner.getStart(ast)
            let end = nodeStart + inner.end
            const following = nodeText.slice(inner.end).match(/^\s*,/)
            if (following) end += following[0].length
            edits.push({ start, end, value: '' })
            return
          }
          ts.forEachChild(inner, stripDroppedSpreads)
        }
        for (const statement of ast.statements) stripDroppedSpreads(statement)
      }
    }

    // Docusaurus' own docs teach `require('./relative/asset.ext').default`
    // as the idiom for linking a JSX attribute (`href={...}`) straight to a
    // static asset — real, working MDX on the source site, but a dangling
    // `require()` of a path the migrated project never has once copied
    // verbatim ("Module not found" at build time). Only a JSX *attribute*
    // expression is handled here (`mdxFlowExpression`/`mdxTextExpression`
    // bodies never hit this shape in practice and the ESM-import loop above
    // already covers a bare top-level `require()`); each attribute's own
    // `position` bounds the replacement to just that attribute's text, so
    // this can never match the identical-looking call inside a *fenced code
    // example* documenting the very same idiom (a real risk here, since
    // Docusaurus' own assets.mdx page shows both side by side).
    walk(tree, (node) => {
      for (const attribute of node.attributes ?? []) {
        if (attribute.type !== 'mdxJsxAttribute' || !attribute.value || typeof attribute.value !== 'object') continue
        const start = attribute.position?.start.offset
        const end = attribute.position?.end.offset
        if (start === undefined || end === undefined) continue
        const attributeText = content.slice(start, end)
        const match = attributeText.match(/require\(\s*(['"])((?:\.\.?\/|\/|@site\/)[^'"]+?\.(?:svg|png|jpe?g|webp|gif|avif|ico|docx|pdf))\1\s*\)(?:\.default|\.src)?/)
        if (!match || match.index === undefined) continue
        try {
          const specifier = match[2]
          const normalized = specifier.startsWith('@site/') ? `/${specifier.slice('@site/'.length)}` : specifier
          // `true`: this is exactly the Playwright `require('../images/...')`
          // idiom (a page under a flattened project root reaching a shared
          // asset that only exists at the mirrored repository-root path) —
          // see `resolveDependency`'s `allowFlattenedMirror` doc.
          const resolvedPath = normalized.startsWith('/') ? resolveWithin(root, normalized.slice(1)) : resolveDependency(normalized, currentFile, true)
          const href = copyPublicAsset(resolvedPath)
          const replaced = attributeText.slice(0, match.index) + JSON.stringify(href) + attributeText.slice(match.index + match[0].length)
          edits.push({ start, end, value: replaced })
        } catch {
          // Not actually resolvable/copyable, even after the repository-root
          // fallback above. Leaving the dangling `require()` in place would
          // break the whole site's build ("Module not found"), so replace it
          // with an empty string (a broken image is degraded, not fatal) and
          // warn instead.
          const replaced = attributeText.slice(0, match.index) + JSON.stringify('') + attributeText.slice(match.index + match[0].length)
          edits.push({ start, end, value: replaced })
          warn(`Asset require(${JSON.stringify(match[2])}) could not be resolved and was removed; the reference was replaced with an empty string.`, currentFile)
        }
      }
    })

    // A page-local declaration (not imported) that uses a hook or an event
    // handler must move to the client module along with its invocation: left
    // inline, it compiles into the page's own server-rendered module, where
    // `useState` and friends are never in scope (see `implicitReactImports`,
    // only applied to extracted client files).
    // A component the extraction above refused (and warned about) stays where
    // it is; this pass must not move it, and the dependency that blocked it,
    // behind that decision.
    const statefulDeclarationNames = new Set(
      declarations
        .filter(({ source }) => /\bon[A-Z]\w*\s*=|\buse[A-Z]\w*\s*\(/.test(source))
        .map(({ source }) => source.match(/^export const (\w+)/)?.[1])
        .filter((name): name is string => !!name && !refusedInlineComponents.has(name)),
    )

    // Extract whole HTML JSX roots with event handlers. Markdown and global
    // built-ins remain server-rendered; React functions stay inside the client
    // module, so no function is serialized across a server/client boundary.
    const extracted: Array<{ node: MdxNode; name: string; jsx: string }> = []
    for (const candidate of tree.children ?? []) {
      const node = candidate.type === 'paragraph' && candidate.children?.length === 1 ? candidate.children[0] : candidate
      if (!['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node.type) || node.position?.start.offset === undefined || node.position.end.offset === undefined) continue
      let interactive = statefulDeclarationNames.has(node.name ?? '')
      let supported = true
      walk(node, (child) => {
        if (child.attributes?.some((attribute) => /^on[A-Z]/.test(attribute.name ?? ''))) interactive = true
        if (child.name && /^[A-Z]/.test(child.name) && !aliases.has(child.name) && !statefulDeclarationNames.has(child.name)) supported = false
        if (!['mdxJsxFlowElement', 'mdxJsxTextElement', 'mdxFlowExpression', 'mdxTextExpression', 'text', 'paragraph'].includes(child.type)) supported = false
      })
      if (!interactive) continue
      if (!supported || hasUnsupportedImports) {
        warn('Interactive MDX containing Markdown or unregistered components requires manual extraction; source was preserved.', currentFile)
        continue
      }
      const jsx = content.slice(node.position.start.offset, node.position.end.offset)
      // The JSX compiler is the final syntax gate: Markdown embedded in JSX
      // must not accidentally become JavaScript in the generated module.
      const result = ts.transpileModule(`export default function Inline() { return (${jsx}); }`, {
        fileName: 'inline.jsx', compilerOptions: { jsx: ts.JsxEmit.Preserve }, reportDiagnostics: true,
      })
      if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
        warn('Interactive MDX could not be safely extracted as JSX; source was preserved.', currentFile)
        continue
      }
      extracted.push({ node, name: `Inline${extracted.length}`, jsx })
    }
    if (extracted.length && declarations.length) {
      const declared = new Set<string>()
      function bind(name: ts.BindingName): void {
        if (ts.isIdentifier(name)) declared.add(name.text)
        else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name)
      }
      for (const declaration of declarations) {
        for (const statement of sourceFile(declaration.source, 'declaration.tsx').statements) {
          if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declared.add(statement.name.text)
          if (ts.isVariableStatement(statement)) for (const variable of statement.declarationList.declarations) bind(variable.name)
        }
      }
      const hasSharedDeclarations = hasExpressionReference(declared, {
        excludedNodes: extracted.map((entry) => entry.node),
        includeDeclarations: false,
        includeDirectTags: true,
      })
      if (hasSharedDeclarations) {
        warn('Interactive MDX shares declarations with remaining page content; source was preserved for manual extraction.', currentFile)
        extracted.length = 0
      }
    }
    if (extracted.length && (copied.size >= MAX_COMPONENT_FILES
      || Buffer.byteLength(content) > MAX_FILE_BYTES
      || copiedBytes + Buffer.byteLength(content) > MAX_COMPONENT_BYTES)) {
      warn('Interactive MDX exceeded the component migration budget; source was preserved.', currentFile)
      extracted.length = 0
    }
    if (extracted.length) {
      const path = `${destinationRoot}/inline-${hash(relative(root, currentFile))}.jsx`
      let declarationSource = [...new Set(declarations.map((entry) => entry.source))].join('\n\n')
      // Mintlify exposes this DOM id as its documented search trigger. Thally
      // opens search through the same keyboard event handled by CommandSearch.
      declarationSource = declarationSource.replace(/document\.getElementById\(\s*(['"])search-bar-entry\1\s*\)\.click\(\s*\)/g,
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
      const inlineSource = [
        ...moduleImports, '', declarationSource, '',
        ...extracted.map(({ name, jsx }) => `export function ${name}() {\n  return (${jsx});\n}`), '',
      ].join('\n')
      // A single leading directive: `inlineSource` no longer carries its own,
      // or Next rejects the file ("use client" must be the first statement).
      const implicit = implicitReactImports(sourceFile(inlineSource, 'inline.jsx'),
        (names) => warn(shadowedBuiltinMessage(relative(root, currentFile).replace(/\\/g, '/'), names), currentFile))
      copied.set(path, { path, content: `'use client';\n${implicit}\n${inlineSource}` })
      copiedBytes += Buffer.byteLength(inlineSource)
      for (const { node, name } of extracted) {
        edits.push({ start: node.position!.start.offset!, end: node.position!.end.offset!, value: `<${register(path, name)} />` })
      }
      edits.push(...declarations.map(({ start, end }) => ({ start, end, value: '' })), ...sharedImportEdits)
    }
    // A page-local callback cannot cross into a copied client component. Move
    // a self-contained JSX callback into a thin client adapter while keeping
    // the MDX children on the page. More complex callbacks remain passive.
    const pageFunctions = functionDeclaredNames(content)
    const passiveRoots: Array<MdxNode> = []
    const wrappedRoots = new Set<MdxNode>()
    walk(tree, (node) => {
      if (!node.name || !aliases.has(node.name) || !functionValuedAttribute(node, pageFunctions)
        || node.position?.start.offset === undefined || node.position.end.offset === undefined) return
      if (passiveRoots.some((root) => node.position!.start.offset! >= root.position!.start.offset!
        && node.position!.end.offset! <= root.position!.end.offset!)) return
      const functionAttributes = (node.attributes ?? []).filter((attribute) => {
        const value = attribute.value && typeof attribute.value === 'object' ? attribute.value.value?.trim() : undefined
        return !!value && pageFunctions.has(value)
      })
      if (functionAttributes.length === 1 && functionAttributes[0].name
        && functionAttributes[0].position?.start.offset !== undefined
        && functionAttributes[0].position.end.offset !== undefined) {
        const functionName = (functionAttributes[0].value as { value: string }).value.trim()
        const declaration = declarations.find((entry) => new RegExp(`^export const ${functionName}\\s*=`).test(entry.source))
        const safeDeclaration = declaration?.source.match(/^export const \w+\s*=\s*\(\s*\{\s*children(?:\s*,\s*\.\.\.props)?\s*\}\s*\)\s*=>\s*\([\s\S]*\)\s*;?$/)
          && !/\b(?:window|document|process|fetch|use[A-Z]\w*)\b/.test(declaration.source)
          && [...declaration.source.matchAll(/<([A-Z]\w*)\b/g)].every((match) => match[1] === 'CodeBlock')
          && [...declaration.source.matchAll(/\{([^{}]*)\}/g)].every((match) =>
            ['children', '...props', 'children, ...props'].includes(match[1].trim()))
        const binding = registrations.get(aliases.get(node.name)!)
        if (safeDeclaration && binding) {
          const fallbackDeclaration = declaration!.source.replace(/<CodeBlock\b[^>]*>/g, '<pre><code>').replace(/<\/CodeBlock>/g, '</code></pre>')
          const wrapperPath = `${destinationRoot}/callback-${hash(`${currentFile}:${node.position.start.offset}`)}.jsx`
          const imported = binding.imported === 'default' ? 'default' : binding.imported
          const importClause = imported === 'default' ? 'import Original' : `import { ${imported} as Original }`
          const specifier = portableSpecifier(`./${relative(destinationRoot, binding.path).replace(/\\/g, '/')}`)
          const wrapperName = register(wrapperPath, 'CallbackWrapper')
          copied.set(wrapperPath, { path: wrapperPath, content: [
            "'use client';", `${importClause} from ${JSON.stringify(specifier)};`,
            fallbackDeclaration,
            `export function CallbackWrapper({ children, ...props }) { return <Original {...props} ${functionAttributes[0].name}={${functionName}}>{children}</Original>; }`,
          ].join('\n') })
          const start = node.position.start.offset
          const end = node.position.end.offset
          const source = content.slice(start, end)
          const opening = source.indexOf(`<${node.name}`)
          const closing = source.lastIndexOf(`</${node.name}`)
          if (opening >= 0) edits.push({ start: start + opening + 1, end: start + opening + 1 + node.name.length, value: wrapperName })
          if (closing >= 0) edits.push({ start: start + closing + 2, end: start + closing + 2 + node.name.length, value: wrapperName })
          edits.push({ start: functionAttributes[0].position!.start.offset!, end: functionAttributes[0].position!.end.offset!, value: '' })
          wrappedRoots.add(node)
          if (declaration!.source.includes('<CodeBlock')) warn(`Interactive <${node.name}> was retained with a basic code block in place of Mintlify's CodeBlock.`, currentFile)
          return
        }
      }
      const source = content.slice(node.position.start.offset, node.position.end.offset)
      const openingEnd = source.indexOf('>')
      const closingStart = source.lastIndexOf(`</${node.name}`)
      const children = openingEnd >= 0 && closingStart > openingEnd ? source.slice(openingEnd + 1, closingStart) : ''
      edits.push({ start: node.position.start.offset, end: node.position.end.offset,
        value: `<div data-migration-interactive-fallback="${node.name}">${children}</div>` })
      passiveRoots.push(node)
      warn(`Interactive <${node.name}> passes a page-local function into a client component; its child content was retained without the interactive control. Move the callback into a client component to restore it.`, currentFile)
    })
    walk(tree, (node) => {
      const replacement = node.name ? aliases.get(node.name) : undefined
      if (!replacement || node.position?.start.offset === undefined || node.position.end.offset === undefined) return
      if (wrappedRoots.has(node)) return
      if (passiveRoots.some((root) => node.position!.start.offset! >= root.position!.start.offset!
        && node.position!.end.offset! <= root.position!.end.offset!)) return
      const start = node.position.start.offset
      const end = node.position.end.offset
      if (extracted.some((item) => start >= item.node.position!.start.offset! && end <= item.node.position!.end.offset!)) return
      const text = content.slice(start, end)
      const opening = text.indexOf(`<${node.name}`)
      if (opening >= 0) edits.push({ start: start + opening + 1, end: start + opening + 1 + node.name!.length, value: replacement })
      const closing = text.lastIndexOf(`</${node.name}`)
      if (closing >= 0) edits.push({ start: start + closing + 2, end: start + closing + 2 + node.name!.length, value: replacement })
    })
    // Every usage of a removed npm-package import is replaced whole (tag,
    // props, and children) rather than just its name: nothing in the
    // migrated project can render it. A video-embed-shaped usage (an `id`
    // prop, a name suggesting an embedded player) gets a trivial working
    // `<iframe>`; anything else becomes a visible, greppable MDX comment.
    walk(tree, (node) => {
      const specifier = node.name ? unsupportedImports.get(node.name) : undefined
      if (!specifier || node.position?.start.offset === undefined || node.position.end.offset === undefined) return
      const start = node.position.start.offset
      const end = node.position.end.offset
      const videoId = youtubeEmbedVideoId(node, specifier)
      const value = videoId
        ? `<iframe width="560" height="315" src="https://www.youtube.com/embed/${videoId}" title="Embedded video" allowFullScreen />`
        : mdxComment(` Removed <${node.name}>: unsupported import '${specifier}' `)
      edits.push({ start, end, value })
    })
    // Dynamic `import('./x')` of a file the migration copies points at the
    // copied module instead. Located on the edited text, so the offsets
    // never overlap the edits above; one that cannot be copied is left as
    // written and the page is excluded afterwards (repository.ts).
    const edited = applyReplacements(content, edits)
    const dynamicEdits: Array<Replacement> = []
    try {
      for (const { specifier: rawDynamic, start, end } of dynamicImportLiterals(edited, parser.parse(edited) as MdxNode)) {
        if (start === undefined || end === undefined || !/^\.\.?\//.test(rawDynamic) || /\.mdx?$/i.test(rawDynamic)) continue
        try {
          const path = copyGraph(resolveDependency(rawDynamic, currentFile))
          dynamicEdits.push({ start, end, value: JSON.stringify(portableSpecifier(`@/${path.replace(/^src\//, '').replace(/\\/g, '/')}`)) })
        } catch {
          // Not shipped: reported by the caller's exclusion check.
        }
      }
    } catch {
      // The edited text does not parse; the caller reports it.
    }
    const rendered = applyReplacements(edited, dynamicEdits)
    // Inserted after all offset-based edits (it has no position in the
    // original source) so it lands once, at the very top of the body.
    const pageStatements = [...new Set([...realPageImports, ...serverPageDeclarations])]
    const realImportsBlock = pageStatements.length ? `${pageStatements.join('\n')}\n\n` : ''
    return frontmatter + realImportsBlock + rendered
  }

  function files(): Array<RenderedMigrationFile> {
    // A rescued asset (`copyPublicAsset`) lands in `copied` without ever
    // registering a component; it still needs emitting even when nothing
    // was registered.
    if (!copied.size) return []
    if (!registrations.size) return [...copied.values()]
    const entries = [...registrations.entries()].sort(([a], [b]) => a.localeCompare(b))
    return [...copied.values(), {
      path: 'src/mdx/custom-components.tsx',
      content: [
        '/** Repository components preserved by migration; this registry is customer-owned. */',
        "import type { MDXComponents } from 'mdx/types'", ...entries.map(([name, binding]) => {
          const path = portableSpecifier(`./${relative('src/mdx', binding.path).replace(/\\/g, '/')}`)
          return `import { ${binding.imported} as ${name} } from ${JSON.stringify(path)}`
        }), '',
        // Not every registered local binding is JSX-taggable — a companion
        // value from the same import (an enum used only as `Foo.Bar` inside
        // another component's prop, e.g.) is registered too, so the whole
        // MDX scope resolves it. `MDXComponents`' index signature expects a
        // component at every key, which such a value structurally is not;
        // cast rather than exclude it, since excluding it would leave a
        // dangling reference in the page that DOES need it.
        'export const customComponents = {',
        ...entries.map(([name]) => `  ${name},`), '} as unknown as MDXComponents', '',
      ].join('\n'),
    }]
  }
  // Rendered registry lines look like `import { Imported as MigratedAbc } from "./migrated/<id>/x"`.
  const REGISTRY_IMPORT = /^import \{ (\w+) as (Migrated[0-9a-f]+) \} from "(\.\/[^"]+)"$/gm
  function adopt(incoming: ReadonlyArray<RenderedMigrationFile>): void {
    for (const file of incoming) {
      if (file.path !== 'src/mdx/custom-components.tsx') {
        if (!copied.has(file.path)) copied.set(file.path, file)
        continue
      }
      if (typeof file.content !== 'string') continue
      for (const [, imported, name, specifier] of file.content.matchAll(REGISTRY_IMPORT)) {
        const base = posix.join('src/mdx', specifier)
        const path = [...copied.keys()].find((candidate) => candidate.replace(/\.tsx?$/, '') === base) ?? base
        registrations.set(name, { path, imported })
      }
    }
  }
  return { transform, files, adopt }
}

/** Preserve an authored component registry while adding an isolated import map. */
export function mergeComponentRegistry(existing: string, incoming: string): Array<RenderedMigrationFile> {
  const fingerprint = hash(incoming)
  const name = `MigratedRegistry${fingerprint}`
  const registryPath = `./migrated-components-${fingerprint}`
  const source = sourceFile(existing, 'custom-components.tsx')
  const alreadyImported = source.statements.some((statement) => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === registryPath)
  let initializer: ts.Expression | undefined
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'customComponents') initializer = declaration.initializer
    }
  }
  while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    throw new Error('Cannot safely merge src/mdx/custom-components.tsx: export customComponents as an object literal before importing components. The existing registry was preserved.')
  }
  const content = alreadyImported ? existing : applyReplacements(existing, [
    { start: source.statements.filter((statement) => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)).at(-1)?.end ?? 0,
      end: source.statements.filter((statement) => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)).at(-1)?.end ?? 0,
      value: `\nimport { customComponents as ${name} } from ${JSON.stringify(registryPath)}\n` },
    { start: initializer.getStart(source) + 1, end: initializer.getStart(source) + 1, value: `\n  ...${name},` },
  ])
  return [
    { path: `src/mdx/migrated-components-${fingerprint}.tsx`, content: incoming },
    { path: 'src/mdx/custom-components.tsx', content },
  ]
}
