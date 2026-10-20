/**
 * Normalize Mintlify-only fence metadata on Markdown AST code nodes. Token
 * boundaries mirror src/mdx/rehype.ts's renderer lexer; source offsets keep
 * quoted titles, balanced values and every byte of example code intact.
 */
import remarkParse from 'remark-parse'
import { unified } from 'unified'

interface FenceNode {
  type: string
  children?: FenceNode[]
  position?: { start: { offset?: number } }
}
interface MetaToken { start: number; end: number; key?: string; value: string; quoted?: boolean; group?: boolean }

/** Read the same quoted and balanced groups that the runtime metadata lexer accepts. */
function delimitedEnd(meta: string, start: number): number | undefined {
  const opening = meta[start]
  if (opening === '"' || opening === "'") {
    let close = start + 1
    while (close < meta.length && meta[close] !== opening) close += meta[close] === '\\' && meta[close + 1] === opening ? 2 : 1
    return close < meta.length ? close + 1 : close
  }
  if (opening !== '{') return undefined
  let depth = 0
  let quote = ''
  for (let index = start; index < meta.length; index++) {
    const char = meta[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return index + 1
  }
  return meta.length
}

function tokens(meta: string): MetaToken[] {
  const result: MetaToken[] = []
  let index = 0
  while (index < meta.length) {
    if (/\s/.test(meta[index])) { index++; continue }
    const start = index
    const delimited = delimitedEnd(meta, index)
    if (delimited !== undefined) {
      result.push({ start, end: delimited, value: meta.slice(start, delimited), quoted: meta[start] !== '{', group: meta[start] === '{' })
      index = delimited
      continue
    }
    const key = /^([A-Za-z][\w-]*)=/.exec(meta.slice(index))
    if (key) {
      index += key[0].length
      const groupEnd = delimitedEnd(meta, index)
      if (groupEnd !== undefined) index = groupEnd
      else while (index < meta.length && !/\s/.test(meta[index])) index++
      result.push({ start, end: index, key: key[1], value: meta.slice(start, index) })
      continue
    }
    while (index < meta.length && !/\s/.test(meta[index])) {
      if (index > start && meta[index] === '{' && /^\{[\d,\s-]*\}/.test(meta.slice(index))) break
      index++
    }
    result.push({ start, end: index, value: meta.slice(start, index) })
  }
  return result
}

/** Drop known renderer-only knobs while retaining unknown options for explicit review. */
export function normalizeMintlifyCodeFences(body: string, warn?: (message: string) => void): string {
  const tree = unified().use(remarkParse).parse(body) as FenceNode
  const edits: Array<{ start: number; end: number; value: string }> = []
  const removed = new Set<string>()
  const unknown = new Set<string>()
  const supported = new Set(['title', 'filename', 'framework', 'tag', 'icon', 'highlight', 'focus', 'wrap', 'lines', 'expandable', 'nocopy'])
  function visit(node: FenceNode): void {
    if (node.type === 'code' && node.position?.start.offset !== undefined) {
      const start = node.position.start.offset
      const lineEnd = body.indexOf('\n', start)
      const end = lineEnd < 0 ? body.length : lineEnd
      const line = body.slice(start, end)
      const opening = /^([`~]{3,}[^\s]*)([ \t]+)(.*?)(\r?)$/.exec(line)
      if (opening) {
        const meta = opening[3]
        const kept = tokens(meta).filter((token) => {
          if (token.key === 'theme' || (!token.key && !token.quoted && !token.group && token.value === 'twoslash')) {
            removed.add(token.key ?? token.value)
            return false
          }
          if (token.key && !supported.has(token.key)) unknown.add(token.key)
          return true
        })
        const normalized = kept.map((token) => meta.slice(token.start, token.end)).join(' ')
        if (normalized !== meta && kept.length !== tokens(meta).length) edits.push({ start, end, value: `${opening[1]}${normalized ? ` ${normalized}` : ''}${opening[4]}` })
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  if (removed.size) warn?.(`Removed unsupported Mintlify code-fence options: ${[...removed].join(', ')}. Code examples and supported display options were preserved.`)
  if (unknown.size) warn?.(`Unsupported Mintlify code-fence options are ignored: ${[...unknown].join(', ')}. Review these renderer-specific options.`)
  return edits.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end), body)
}
