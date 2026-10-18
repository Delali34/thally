/**
 * Analysis behind the migrator's extraction of a page's own inline
 * components into a `'use client'` module (see `components.ts`).
 *
 * A page component that calls a React hook cannot stay in the page: Next
 * compiles an MDX page as a Server Component. Moving only that component is
 * not enough, because it may use other declarations from the same page (a
 * sibling component, a helper, a data array) that the client module cannot
 * reach. This module computes what has to travel with it, what the page
 * still needs a copy of, and refuses (with a reason) when a dependency cannot
 * be made available in the client module, so a page is never left half moved.
 */

import ts from 'typescript'

import { isThallyBuiltinComponent } from './builtin-components.js'

export interface InlineDeclaration { start: number; end: number; source: string }

type RefKind = 'tag' | 'member' | 'prop' | 'typeof' | 'other'
interface Ref { name: string; kind: RefKind }

interface Unit {
  index: number
  source: string
  names: Array<string>
  refs: Array<Ref>
  /** Page-level names this declaration reassigns or mutates. */
  assigned: Array<string>
  hooks: boolean
  /** Handlers, browser globals: cannot render in a Server Component. */
  clientOnly: boolean
  componentLike: boolean
  blockers: Array<string>
}

/** Minimal MDX syntax-tree shape needed to find the page's own references. */
export interface InlineTree {
  type: string
  name?: string | null
  value?: string
  attributes?: Array<{ type: string; name?: string; value?: string | { type?: string; value?: string } | null }>
  children?: Array<InlineTree>
}

export interface InlinePlan {
  /** Blocked roots, each with the reason it was left in the page. */
  blocked: Array<{ name: string; reason: string }>
  /** Declarations deleted from the page (declaration indexes). */
  moved: Array<number>
  /** Declarations the page keeps and the client module also receives. */
  copied: Array<number>
  /** Names of every moved declaration. */
  movedNames: Array<string>
  /** Import statements the client module needs, in source order. */
  moduleImports: Array<string>
  /** Server-side helper declarations (page-level text) the module also needs. */
  moduleHelpers: Array<string>
  /** Moved names used as a JSX tag in the page body (registered, then renamed). */
  registryNames: Array<string>
  /** Moved names the page reaches by their real name (import statement needed). */
  pageImportNames: Array<string>
  /** Local names every module statement may reference without a built-in lookup. */
  moduleNames: Set<string>
  /** Names still referenced by the page after the move (drives import cleanup). */
  pageReferences: Set<string>
}

const SERVER_ONLY_IDENTIFIERS = new Set(['process', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer'])
const BROWSER_IDENTIFIERS = new Set([
  'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'matchMedia', 'requestAnimationFrame',
  'cancelAnimationFrame', 'alert', 'confirm', 'prompt', 'HTMLElement', 'Element', 'Node', 'Event',
  'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'FormData', 'File', 'FileReader', 'Image', 'Audio',
  'XMLHttpRequest', 'WebSocket', 'getComputedStyle', 'innerWidth', 'innerHeight', 'scrollTo',
])
/** Bare names any module may reference without declaring them. */
// An explicit list: the set of globals a Node process happens to have varies by
// version, and the answer must not depend on which one runs the migration.
const JS_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments',
  'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Date', 'RegExp',
  'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
  'JSON', 'Math', 'Intl', 'Reflect', 'Proxy', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'console', 'fetch', 'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal',
  'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'structuredClone', 'queueMicrotask', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'crypto', 'Blob', 'EventTarget', 'escape', 'unescape', 'eval', 'WebAssembly', 'Iterator', 'self', 'screen',
  'FinalizationRegistry', 'DOMException', 'ReadableStream', 'WritableStream', 'TransformStream', 'MessageChannel', 'BroadcastChannel',
])
const IMPLICIT_MODULE_NAMES = new Set(['React', 'MintlifyComponents'])

/** How a file is read: `.ts` is TypeScript without JSX (`<T>x` is an assertion there), anything else may hold JSX. */
export function scriptKindFor(fileName: string): ts.ScriptKind {
  return /\.[cm]?ts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.TSX
}

function parse(source: string, fileName = 'inline.tsx'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName))
}

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text)
  else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, into)
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
}

/**
 * Adds each `var` a scope declares to `into`: `var` is function-scoped wherever
 * it sits (any block, loop, `try`, `switch` or label, destructured or not) and is
 * not visible past a nested function, class (its methods and static blocks) or
 * namespace. `let`, `const`, `class` and `function` declarations belong to the
 * block that holds them: see `lexicalNames`.
 */
export function hoistedVarNames(root: ts.Node, into: Set<string>): void {
  const collect = (node: ts.Node): void => {
    if (isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node)) return
    if (ts.isVariableDeclaration(node) && !ts.isCatchClause(node.parent) && !(ts.getCombinedNodeFlags(node) & ts.NodeFlags.BlockScoped)) bindingNames(node.name, into)
    ts.forEachChild(node, collect)
  }
  collect(root)
}

/**
 * The names the parameter list binds: the function's own name and its parameters.
 * Parameter initialisers run in this scope alone: the body's `var`s, functions and
 * lexical declarations live in scopes of their own that those initialisers cannot see
 * (`function f(C = Note) { var Note }` reads the outer `Note`).
 */
function functionScope(fn: ts.FunctionLikeDeclaration): Set<string> {
  const scope = new Set<string>()
  if ((ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) && fn.name) scope.add(fn.name.text)
  for (const parameter of fn.parameters) bindingNames(parameter.name, scope)
  return scope
}

/**
 * Names a statement list declares for itself: `let`, `const`, `class` and
 * `function` (module code is strict, so a function in a block stays in it).
 * They are visible from the start of the list to its end, and nowhere else.
 */
function lexicalNames(statements: ReadonlyArray<ts.Statement>): Set<string> {
  const names = new Set<string>()
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.flags & ts.NodeFlags.BlockScoped) for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names)
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text)
  }
  return names
}

/** The scope a statement opens around its own children, when it opens one: a block, a `switch` body, a `for` loop's declarations, a `catch` parameter. */
function ownScope(node: ts.Node): Set<string> | undefined {
  if (ts.isBlock(node)) return lexicalNames(node.statements)
  if (ts.isCaseBlock(node)) return lexicalNames(node.clauses.flatMap((clause) => [...clause.statements]))
  if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    const names = new Set<string>()
    if (node.initializer.flags & ts.NodeFlags.BlockScoped) for (const declaration of node.initializer.declarations) bindingNames(declaration.name, names)
    return names
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    const names = new Set<string>()
    bindingNames(node.variableDeclaration.name, names)
    return names
  }
  return undefined
}

/** Free (unbound) identifier references in one declaration, with how each is used. */
function collectRefs(root: ts.Node): { refs: Array<Ref>; assigned: Array<string>; awaitOutsideAsync: boolean; dynamicImport: boolean } {
  const refs: Array<Ref> = []
  const assigned: Array<string> = []
  let awaitOutsideAsync = false
  let dynamicImport = false
  function bound(name: string, scopes: Array<Set<string>>): boolean {
    return scopes.some((scope) => scope.has(name))
  }
  function push(name: string, kind: RefKind, scopes: Array<Set<string>>): void {
    if (!bound(name, scopes)) refs.push({ name, kind })
  }
  function walkNode(node: ts.Node, scopes: Array<Set<string>>, inAsync: boolean): void {
    if (ts.isTypeNode(node)) return
    if (isFunctionLike(node)) {
      const parameterScopes = [...scopes, functionScope(node)]
      const async = !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      for (const parameter of node.parameters) {
        if (!ts.isIdentifier(parameter.name)) walkNode(parameter.name, parameterScopes, async)
        if (parameter.initializer) walkNode(parameter.initializer, parameterScopes, async)
      }
      if (node.body) {
        // Only the body sees its own `var`s; its other declarations join through `ownScope`.
        const hoisted = new Set<string>()
        hoistedVarNames(node.body, hoisted)
        walkNode(node.body, [...parameterScopes, hoisted], async)
      }
      return
    }
    const own = ownScope(node)
    if (own) {
      ts.forEachChild(node, (child) => walkNode(child, [...scopes, own], inAsync))
      return
    }
    if (ts.isAwaitExpression(node) && !inAsync) awaitOutsideAsync = true
    const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ? node.left
      : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        ? node.operand
        : undefined
    if (target) {
      let base: ts.Node = target
      while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = base.expression
      if (ts.isIdentifier(base) && !bound(base.text, scopes)) assigned.push(base.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImport = true
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      let operandOf = parent
      while (ts.isParenthesizedExpression(operandOf)) operandOf = operandOf.parent
      const kind: RefKind = ts.isTypeOfExpression(operandOf)
        ? 'typeof'
        : ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent) ? 'prop' : 'other'
      push(node.text, kind, scopes)
      return
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let tag: ts.Node = node.tagName
      while (ts.isPropertyAccessExpression(tag)) tag = tag.expression
      if (ts.isIdentifier(tag)) {
        // A lowercase, non-member tag is an intrinsic element, not a reference.
        if (node.tagName !== tag || /^[A-Z]/.test(tag.text)) push(tag.text, node.tagName === tag ? 'tag' : 'member', scopes)
      }
      walkNode(node.attributes, scopes, inAsync)
      return
    }
    if (ts.isJsxClosingElement(node)) return
    if (ts.isJsxAttribute(node)) {
      if (node.initializer) walkNode(node.initializer, scopes, inAsync)
      return
    }
    if (ts.isPropertyAccessExpression(node)) {
      walkNode(node.expression, scopes, inAsync)
      return
    }
    if (ts.isQualifiedName(node)) return
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) walkNode(node.name.expression, scopes, inAsync)
      walkNode(node.initializer, scopes, inAsync)
      return
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      push(node.name.text, 'other', scopes)
      if (node.objectAssignmentInitializer) walkNode(node.objectAssignmentInitializer, scopes, inAsync)
      return
    }
    if (ts.isBindingElement(node)) {
      if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) walkNode(node.propertyName.expression, scopes, inAsync)
      if (node.initializer) walkNode(node.initializer, scopes, inAsync)
      if (!ts.isIdentifier(node.name)) walkNode(node.name, scopes, inAsync)
      return
    }
    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) walkNode(node.name, scopes, inAsync)
      if (node.initializer) walkNode(node.initializer, scopes, inAsync)
      return
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      // A class expression's own name is bound inside the class only.
      const inner = ts.isClassExpression(node) && node.name ? [...scopes, new Set([node.name.text])] : scopes
      node.members.forEach((member) => walkNode(member, inner, inAsync))
      for (const clause of node.heritageClauses ?? []) for (const type of clause.types) walkNode(type.expression, scopes, inAsync)
      return
    }
    // `import.meta` / `new.target` carry a keyword-like name, not a reference.
    if (ts.isMetaProperty(node)) return
    if (ts.isPropertyDeclaration(node)) {
      if (node.initializer) walkNode(node.initializer, scopes, inAsync)
      return
    }
    if (ts.isLabeledStatement(node)) {
      walkNode(node.statement, scopes, inAsync)
      return
    }
    if (ts.isBreakOrContinueStatement(node)) return
    ts.forEachChild(node, (child) => walkNode(child, scopes, inAsync))
  }
  // A top-level declaration's own name is module-level, so a self-reference
  // (recursion) is reported like any other page-level name.
  walkNode(root, [], false)
  return { refs, assigned, awaitOutsideAsync, dynamicImport }
}

function declaredNames(statement: ts.Statement): { names: Array<string>; componentLike: boolean; defaultExport: boolean } {
  const isDefault = !!(ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    || ts.isExportAssignment(statement)
  const names = new Set<string>()
  let componentLike = false
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      bindingNames(declaration.name, names)
      const initializer = declaration.initializer && unwrap(declaration.initializer)
      if (ts.isIdentifier(declaration.name) && /^[A-Z]/.test(declaration.name.text) && initializer
        && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isClassExpression(initializer))) {
        componentLike = true
      }
    }
  } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
    names.add(statement.name.text)
    componentLike = /^[A-Z]/.test(statement.name.text)
  }
  return { names: [...names], componentLike, defaultExport: isDefault }
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression
  return current
}

function analyzeUnit(index: number, source: string, reactGlobals: ReadonlySet<string>): Unit {
  const sf = parse(source)
  const statement = sf.statements[0]
  const blockers: Array<string> = []
  if (!statement || sf.statements.length !== 1) {
    return { index, source, names: [], refs: [], assigned: [], hooks: false, clientOnly: false, componentLike: false, blockers: ['is not a single declaration'] }
  }
  const { names, componentLike, defaultExport } = declaredNames(statement)
  if (defaultExport) blockers.push('is a default export')
  const { refs, assigned, awaitOutsideAsync, dynamicImport } = collectRefs(statement)
  if (awaitOutsideAsync) blockers.push('uses await outside an async function')
  if (dynamicImport) blockers.push('uses a dynamic import()')
  // An async component is a Server Component; it has no client equivalent.
  const initializer = ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    ? statement.declarationList.declarations[0].initializer && unwrap(statement.declarationList.declarations[0].initializer)
    : statement
  if (initializer && isFunctionLike(initializer) && initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    blockers.push('is an async (server) component')
  }
  for (const { name } of refs) {
    if (SERVER_ONLY_IDENTIFIERS.has(name)) blockers.push(`uses the server-only \`${name}\``)
  }
  let handlers = false
  function scanHandlers(node: ts.Node): void {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && /^on[A-Z]/.test(node.name.text)) handlers = true
    ts.forEachChild(node, scanHandlers)
  }
  scanHandlers(statement)
  return {
    index,
    source,
    names,
    refs,
    assigned,
    hooks: refs.some(({ name }) => reactGlobals.has(name)) || /\bReact\.(?:use[A-Z]\w*|createContext|forwardRef|memo)\b/.test(source),
    clientOnly: handlers || refs.some(({ name }) => BROWSER_IDENTIFIERS.has(name)),
    componentLike,
    blockers: [...new Set(blockers)],
  }
}

function helperNames(source: string): Array<string> {
  const statement = parse(source).statements[0]
  return statement ? declaredNames(statement).names : []
}

function importLocals(statementText: string): Array<string> {
  const sf = parse(statementText)
  const locals: Array<string> = []
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const clause = statement.importClause
    if (clause.name) locals.push(clause.name.text)
    const named = clause.namedBindings
    if (named && ts.isNamespaceImport(named)) locals.push(named.name.text)
    if (named && ts.isNamedImports(named)) for (const element of named.elements) locals.push(element.name.text)
  }
  return locals
}

/** Free identifier references in an MDX expression string (`{...}` body or attribute value). */
function expressionRefs(expression: string): Array<Ref> {
  const sf = parse(`const __expression = (${expression})`)
  const statement = sf.statements[0]
  return statement ? collectRefs(statement).refs : []
}

function bodyReferences(tree: InlineTree): { mdastTags: Set<string>; refs: Array<Ref> } {
  const mdastTags = new Set<string>()
  const refs: Array<Ref> = []
  function visit(node: InlineTree): void {
    if (node.type === 'mdxjsEsm') return
    if (['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node.type) && node.name) {
      const root = node.name.split('.')[0]
      if (node.name.includes('.')) refs.push({ name: root, kind: 'member' })
      else mdastTags.add(root)
    }
    if (['mdxFlowExpression', 'mdxTextExpression'].includes(node.type) && node.value) refs.push(...expressionRefs(node.value))
    for (const attribute of node.attributes ?? []) {
      const value = attribute.value
      if (attribute.type === 'mdxJsxExpressionAttribute' && typeof value === 'string') {
        refs.push(...expressionRefs(`{${value}}`))
      } else if (value && typeof value === 'object' && typeof value.value === 'string') {
        refs.push(...expressionRefs(value.value).map((ref, _index, all) => (
          all.length === 1 && value.value!.trim() === ref.name ? { name: ref.name, kind: 'prop' as const } : ref
        )))
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return { mdastTags, refs }
}

export function planInlineExtraction(input: {
  declarations: Array<InlineDeclaration>
  tree: InlineTree
  /** Import statements the client module may copy verbatim (already valid from the module's own directory). */
  copyableImports: Array<string>
  /** Page-level declarations synthesized by the migrator (static helpers), by source text. */
  helperDeclarations: Array<string>
  /** Local names of imports the migration removed, with their package. */
  unavailableImports: Map<string, string>
  reactGlobals: ReadonlySet<string>
}): InlinePlan {
  const units = input.declarations.map((declaration, index) => analyzeUnit(index, declaration.source, input.reactGlobals))
  const owner = new Map<string, number>()
  for (const unit of units) for (const name of unit.names) owner.set(name, unit.index)
  // A page-level custom hook (`useTheme`) makes whatever calls it a hook user too.
  for (let changed = true; changed;) {
    changed = false
    for (const unit of units) {
      if (unit.hooks) continue
      if (unit.refs.some(({ name }) => /^use[A-Z]/.test(name) && units[owner.get(name) ?? -1]?.hooks)) { unit.hooks = true; changed = true }
    }
  }

  const importByLocal = new Map<string, string>()
  for (const statement of input.copyableImports) for (const local of importLocals(statement)) importByLocal.set(local, statement)
  const helperByName = new Map<string, string>()
  for (const helper of input.helperDeclarations) {
    for (const name of helperNames(helper)) helperByName.set(name, helper)
  }

  const body = bodyReferences(input.tree)

  const dependencies = (unit: Unit): Set<number> => {
    const found = new Set<number>()
    for (const { name } of unit.refs) {
      const target = owner.get(name)
      if (target !== undefined && target !== unit.index) found.add(target)
    }
    return found
  }
  const closureOf = (rootIndex: number): Set<number> => {
    const seen = new Set<number>([rootIndex])
    const queue = [rootIndex]
    while (queue.length) for (const next of dependencies(units[queue.pop()!])) {
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
    return seen
  }

  /** Why one declaration can never live in the client module, whatever the page does. */
  const intrinsicBlocker = (unit: Unit): string | undefined => {
    if (unit.blockers.length > 0) return `\`${unit.names[0] ?? 'a dependency'}\` ${unit.blockers[0]}`
    for (const { name, kind } of unit.refs) {
      if (owner.has(name) || importByLocal.has(name) || helperByName.has(name)) continue
      if (input.unavailableImports.has(name)) {
        return `\`${unit.names[0]}\` uses \`${name}\`, imported from ${input.unavailableImports.get(name)}, which is not available in the migrated project`
      }
      if (input.reactGlobals.has(name) || IMPLICIT_MODULE_NAMES.has(name) || JS_GLOBALS.has(name) || BROWSER_IDENTIFIERS.has(name)) continue
      if ((kind === 'tag' || kind === 'member') && isThallyBuiltinComponent(name)) continue
      return `\`${unit.names[0]}\` uses \`${name}\`, which is not declared or imported on the page`
    }
    return undefined
  }

  const roots = units
    .filter((unit) => unit.hooks && unit.names.some((name) => /^[A-Z]/.test(name)))
    .map((unit) => unit.index)
  const blocked: Array<{ name: string; reason: string }> = []
  const active = new Set(roots)

  const block = (rootIndex: number, reason: string): void => {
    active.delete(rootIndex)
    blocked.push({ name: units[rootIndex].names.find((name) => /^[A-Z]/.test(name)) ?? units[rootIndex].names[0], reason })
  }
  for (const rootIndex of roots) {
    for (const member of closureOf(rootIndex)) {
      const reason = intrinsicBlocker(units[member])
      if (reason) { block(rootIndex, reason); break }
    }
  }

  for (let round = 0; round <= units.length + 1; round += 1) {
    const inModule = new Set<number>()
    for (const rootIndex of active) for (const member of closureOf(rootIndex)) inModule.add(member)

    // A declaration that cannot render on the server, or that calls one that
    // cannot, must be moved; everything else the page still uses stays too.
    const clientSide = new Set<number>()
    for (const index of inModule) if (units[index].hooks || units[index].clientOnly) clientSide.add(index)
    for (let changed = true; changed;) {
      changed = false
      for (const index of inModule) {
        if (clientSide.has(index)) continue
        const unit = units[index]
        const callsClient = unit.refs.some(({ name, kind }) => {
          const target = owner.get(name)
          return target !== undefined && clientSide.has(target) && kind !== 'tag' && kind !== 'prop'
        })
        if (callsClient) { clientSide.add(index); changed = true }
      }
    }
    for (const rootIndex of active) clientSide.add(rootIndex)

    const nonModuleRefs: Array<Ref> = [...body.refs]
    for (const unit of units) if (!inModule.has(unit.index)) nonModuleRefs.push(...unit.refs)
    const referencedByPage = (index: number): boolean => units[index].names.some((name) => (
      body.mdastTags.has(name) || nonModuleRefs.some((ref) => ref.name === name)
    ))

    const kept = new Set<number>()
    for (const index of inModule) {
      if (clientSide.has(index)) continue
      if (!units[index].componentLike || referencedByPage(index)) kept.add(index)
    }
    for (let changed = true; changed;) {
      changed = false
      for (const index of kept) for (const dependency of dependencies(units[index])) {
        if (inModule.has(dependency) && !clientSide.has(dependency) && !kept.has(dependency)) { kept.add(dependency); changed = true }
      }
    }
    const moved = new Set<number>([...inModule].filter((index) => !kept.has(index)))

    // Page code that stays behind may only render a moved declaration, or hand
    // it to a client component; calling or reading it would run it on the server.
    const pageRefs: Array<Ref> = [...nonModuleRefs]
    for (const index of kept) pageRefs.push(...units[index].refs)
    const violation = [...moved].find((index) => clientSide.has(index) && units[index].names.some((name) => (
      pageRefs.some((ref) => ref.name === name && ref.kind !== 'tag' && ref.kind !== 'prop')
    )))
    if (violation !== undefined) {
      const names = units[violation].names
      const readsIt = (ref: Ref): boolean => names.includes(ref.name) && ref.kind !== 'tag' && ref.kind !== 'prop'
      // A component that only reads the moved value (a context provider next
      // to its consumer) can travel with it, so the value keeps one identity.
      const readers = units.filter((unit) => !moved.has(unit.index) && unit.refs.some(readsIt))
      const promotable = !body.refs.some(readsIt) && readers.every((unit) => (
        unit.componentLike && !active.has(unit.index)
        && [...closureOf(unit.index)].every((member) => !intrinsicBlocker(units[member]))
      ))
      if (promotable && readers.length > 0) {
        for (const unit of readers) active.add(unit.index)
        continue
      }
      for (const rootIndex of [...active]) {
        if (closureOf(rootIndex).has(violation)) {
          block(rootIndex, `\`${names[0]}\` is also read or called by page code that stays on the server`)
        }
      }
      continue
    }

    // A copy of mutable state would diverge: the page and the client module
    // would each count on their own. Refuse when page code reaches it.
    const reachable = new Set<number>([...kept].filter(referencedByPage))
    for (let changed = true; changed;) {
      changed = false
      for (const index of [...reachable]) for (const dependency of dependencies(units[index])) {
        if (kept.has(dependency) && !reachable.has(dependency)) { reachable.add(dependency); changed = true }
      }
    }
    const mutated = [...reachable].find((index) => units.some((unit) => unit.assigned.some((name) => units[index].names.includes(name))))
    if (mutated !== undefined) {
      for (const rootIndex of [...active]) {
        if (closureOf(rootIndex).has(mutated)) {
          block(rootIndex, `\`${units[mutated].names[0]}\` is mutable state that page code also uses, so a copy in the client module would diverge`)
        }
      }
      continue
    }

    const movedNames = [...moved].flatMap((index) => units[index].names)
    const registryNames = movedNames.filter((name) => body.mdastTags.has(name))
    const importNames = movedNames.filter((name) => pageRefs.some((ref) => ref.name === name))
    const moduleMembers = [...inModule].sort((a, b) => a - b)
    const moduleNames = new Set<string>(moduleMembers.flatMap((index) => units[index].names))
    const usedImports: Array<string> = []
    const usedHelpers: Array<string> = []
    for (const index of moduleMembers) {
      for (const { name } of units[index].refs) {
        const statement = importByLocal.get(name)
        if (statement && !usedImports.includes(statement)) usedImports.push(statement)
        const helper = helperByName.get(name)
        if (helper && !usedHelpers.includes(helper)) usedHelpers.push(helper)
      }
    }
    for (const statement of usedImports) for (const local of importLocals(statement)) moduleNames.add(local)
    for (const helper of usedHelpers) for (const name of helperNames(helper)) moduleNames.add(name)
    const pageReferences = new Set<string>(pageRefs.map((ref) => ref.name))
    for (const tag of body.mdastTags) pageReferences.add(tag)
    return {
      blocked,
      moved: [...moved].sort((a, b) => a - b),
      copied: [...kept].sort((a, b) => a - b),
      movedNames,
      moduleImports: usedImports,
      moduleHelpers: usedHelpers,
      registryNames: [...new Set(registryNames)],
      pageImportNames: [...new Set(importNames)],
      moduleNames,
      pageReferences,
    }
  }
  return { blocked, moved: [], copied: [], movedNames: [], moduleImports: [], moduleHelpers: [], registryNames: [], pageImportNames: [], moduleNames: new Set(), pageReferences: new Set() }
}

/** JSX tag names (capitalized, unbound) a module's source uses, for built-in lookup. */
export function unboundTags(moduleSource: string, boundNames: ReadonlySet<string>): Array<string> {
  const sf = parse(moduleSource)
  const tags = new Set<string>()
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) continue
    for (const ref of collectRefs(statement).refs) {
      if ((ref.kind === 'tag' || ref.kind === 'member') && /^[A-Z]/.test(ref.name) && !boundNames.has(ref.name)) tags.add(ref.name)
    }
  }
  return [...tags].sort()
}

/**
 * Thally built-ins a module uses without declaring or importing the name: as a
 * JSX tag, or as a plain value (`React.createElement(Note)`, `const Box =
 * Note`). Mintlify resolves such a bare name from its global component scope;
 * a copied module has none, so it needs a binding. A name that is also a JS,
 * browser or Node global (`Error`, `File`) is bound only when the module renders
 * it as a tag and never reads the global: a binding would replace the global, so
 * a module that uses both is left alone and the name comes back in `shadowed`.
 */
export function unboundBuiltinTags(moduleSource: string, boundNames: ReadonlySet<string>, fileName?: string): { bind: Array<string>; shadowed: Array<string> } {
  const tags = new Set<string>()
  const values = new Set<string>()
  for (const statement of parse(moduleSource, fileName).statements) {
    if (ts.isImportDeclaration(statement)) continue
    for (const { name, kind } of collectRefs(statement).refs) {
      if (boundNames.has(name)) continue
      if (kind === 'tag' || kind === 'member') tags.add(name)
      else values.add(name)
    }
  }
  const isGlobal = (name: string): boolean => JS_GLOBALS.has(name) || BROWSER_IDENTIFIERS.has(name) || SERVER_ONLY_IDENTIFIERS.has(name)
  const builtinTags = [...tags].filter(isThallyBuiltinComponent)
  const shadowed = builtinTags.filter((name) => JS_GLOBALS.has(name) && values.has(name)).sort()
  const builtinValues = [...values].filter((name) => isThallyBuiltinComponent(name) && !isGlobal(name))
  return { bind: [...new Set([...builtinTags.filter((name) => !shadowed.includes(name)), ...builtinValues])].sort(), shadowed }
}

/**
 * Globals a function may use when its source is copied into another module.
 * Deliberately narrower than JS_GLOBALS: `Function`, `globalThis`, `Reflect`,
 * `Proxy`, `fetch`, `console` and timers reach code execution or the network.
 */
const INLINE_SAFE_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'Math', 'JSON', 'String', 'Number', 'Boolean', 'Array', 'Date', 'Intl',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
])
const FORBIDDEN_MEMBERS = new Set(['constructor', 'prototype'])

/** True when a node sits where an object literal acts as a destructuring target (`({ a: x } = y)`, `[{ a: x }] = y`, `for ({ a: x } of y)`). */
function isAssignmentTarget(node: ts.Node): boolean {
  let child = node
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return parent.left === child
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child) return true
    if (!(ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent)
      || ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent) || ts.isParenthesizedExpression(parent) || ts.isObjectLiteralExpression(parent))) return false
  }
  return false
}

/**
 * True when no member access in the node can walk to `Function`: `x.constructor`, `x['constructor']`, `x[key]`,
 * `__proto__`, and the same keys read through destructuring (`const { constructor: C } = String`, `({ [key]: C } = x)`).
 */
function hasOnlySafeMemberAccess(root: ts.Node): boolean {
  const unsafeName = (name: string) => FORBIDDEN_MEMBERS.has(name) || name.startsWith('__')
  /** A property key is safe when it is a plain name or a static string/number that is not forbidden; any other computed key is not. */
  const safeKey = (name: ts.PropertyName | undefined, computedAllowed: boolean): boolean => {
    if (!name) return true
    if (ts.isComputedPropertyName(name)) {
      const expression = name.expression
      if (ts.isStringLiteralLike(expression)) return !unsafeName(expression.text)
      return ts.isNumericLiteral(expression) || computedAllowed
    }
    return !unsafeName(name.text)
  }
  let safe = true
  function visit(node: ts.Node): void {
    if (!safe) return
    if (ts.isPropertyAccessExpression(node) && unsafeName(node.name.text)) safe = false
    else if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression
      const literal = ts.isNumericLiteral(argument) || (ts.isStringLiteralLike(argument) && !unsafeName(argument.text))
      if (!literal) safe = false
    } else if (ts.isBindingElement(node)) {
      // `{ constructor }` has no propertyName; the bound identifier is the key.
      if (ts.isObjectBindingPattern(node.parent) && !safeKey(node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined), false)) safe = false
    } else if (ts.isObjectLiteralExpression(node)) {
      const target = isAssignmentTarget(node)
      for (const property of node.properties) {
        if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && !safeKey(property.name, !target)) safe = false
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return safe
}

/** True when a function expression only reaches its own parameters, locals and a small set of pure built-ins, so its source can be copied verbatim to another module. */
export function isSelfContainedFunction(node: ts.Node): boolean {
  const { refs, assigned, awaitOutsideAsync, dynamicImport } = collectRefs(node)
  return assigned.length === 0 && !awaitOutsideAsync && !dynamicImport && refs.every((ref) => INLINE_SAFE_GLOBALS.has(ref.name))
    && hasOnlySafeMemberAccess(node)
}

/** Names a page's own ESM source (imports, top-level declarations and hoisted `var`s) makes available to its expressions. */
export function pageScopeNames(esmSources: ReadonlyArray<string>): Set<string> {
  const names = new Set<string>()
  for (const source of esmSources) {
    const sf = parse(source)
    for (const statement of sf.statements) {
      for (const local of importLocals(statement.getText())) names.add(local)
      if (ts.isImportDeclaration(statement)) continue
      const target = ts.isExportDeclaration(statement) || ts.isExportAssignment(statement) ? undefined : statement
      if (target) for (const name of declaredNames(target).names) names.add(name)
    }
    hoistedVarNames(sf, names)
  }
  return names
}

/**
 * Free identifiers in an MDX expression that neither the page, the expression
 * itself, a JS built-in nor the compiled-MDX scope (`props`) defines. Evaluating
 * one throws a ReferenceError at render time.
 */
export function unresolvedExpressionNames(expression: string, pageNames: ReadonlySet<string>): Array<string> {
  const names = new Set<string>()
  for (const { name, kind } of expressionRefs(expression)) {
    // `typeof missing` is safe at runtime; only a bare reference throws.
    if (kind === 'typeof') continue
    if (!name || pageNames.has(name) || JS_GLOBALS.has(name) || BROWSER_IDENTIFIERS.has(name) || SERVER_ONLY_IDENTIFIERS.has(name)
      || name === 'props' || name === 'React') continue
    if ((kind === 'tag' || kind === 'member') && isThallyBuiltinComponent(name)) continue
    names.add(name)
  }
  return [...names]
}
