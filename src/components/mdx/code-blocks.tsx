'use client'

/**
 * Interactive code panels for authored MDX, including language/framework
 * labels, synchronized language menus, syntax output, and reader actions.
 */

import clsx from 'clsx'
import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react'
import { CopyButton as SharedCopyButton } from '@/components/api/copy-button'
import { LanguageMenu, useDocsLanguage } from '@/components/docs/code-card'
import { useCompiledParameterLinks } from '@/components/api/parameter-link'
import { useApiLabels } from '@/components/api/api-locale'
import { normalizeDocsLanguage } from '@/lib/openapi/code-snippets'

import { useDocsCodeActions } from '@/components/docs/code-actions-provider'
import { Icon } from '@/components/mdx/content-icon'
import { Tag } from '@/components/ui/tag'
import { Mermaid } from '@/components/mdx/mermaid'

const languageNames: Record<string, string> = {
  bash: 'Shell',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  sh: 'Shell',
  shell: 'Shell',
  zsh: 'Shell',
  css: 'CSS',
  diff: 'Diff',
  docker: 'Dockerfile',
  dockerfile: 'Dockerfile',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  hcl: 'HCL',
  html: 'HTML',
  http: 'HTTP',
  java: 'Java',
  js: 'JavaScript',
  ts: 'TypeScript',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  json: 'JSON',
  jsonc: 'JSONC',
  kotlin: 'Kotlin',
  md: 'Markdown',
  markdown: 'Markdown',
  mdx: 'MDX',
  plaintext: 'Plain text',
  text: 'Plain text',
  txt: 'Plain text',
  yaml: 'YAML',
  yml: 'YAML',
  php: 'PHP',
  python: 'Python',
  ruby: 'Ruby',
  go: 'Go',
  rust: 'Rust',
  sql: 'SQL',
  svelte: 'Svelte',
  swift: 'Swift',
  toml: 'TOML',
  vue: 'Vue',
}

/** Resolve authored labels and known fence grammars consistently across sample wrappers. */
export function getPanelTitle({
  title,
  tag,
  language,
}: {
  title?: string
  tag?: string
  language?: string
}) {
  if (title) {
    return title
  }
  if (tag) {
    return tag
  }
  if (language && language in languageNames) {
    return languageNames[language]
  }
  if (language) {
    return language.toUpperCase()
  }
  return 'Code'
}

function CodeActions({ code, nocopy }: { code: string; nocopy?: boolean }) {
  const t = useApiLabels()
  const { canReportCode, hasAssistantEntryPoint, assistantLabel, reportCode, askAssistant } = useDocsCodeActions()

  return (
    <span className="ml-auto flex items-center gap-0.5">
      <button type="button" onClick={() => reportCode(code)} disabled={!canReportCode} className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35" aria-label="Report incorrect code" title="Report incorrect code">
        <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2L8.2 3z"/><path d="M12 7.5V13" strokeLinecap="round"/><path d="M12 16.2v.1" strokeLinecap="round" strokeWidth="2.2"/></svg>
      </button>
      {!nocopy && <SharedCopyButton value={code} label={t('copy') === 'Copy' ? 'Copy code' : t('copy')} />}
      {hasAssistantEntryPoint && <button type="button" onClick={() => askAssistant(code)} className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="Ask assistant about this code" title={assistantLabel}>
        <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8L12 3.5z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/></svg>
      </button>}
    </span>
  )
}

function CodePanelHeader({ tag, label, code, icon, nocopy }: { tag?: string; label?: string; code: string; icon?: string; nocopy?: boolean }) {
  return (
    <div className="thally-code-header">
      {tag && (
        <div className="flex shrink-0">
          <Tag variant="small">{tag}</Tag>
        </div>
      )}
      {tag && label && (
        <span className="h-0.5 w-0.5 rounded-full bg-zinc-500" />
      )}
      {icon && <Icon icon={icon} size={14} className="h-3.5 w-3.5 text-muted-foreground" />}
      {label && (
        <span className="thally-code-title min-w-0 truncate font-mono text-xs text-muted-foreground" title={label}>{label}</span>
      )}
      <CodeActions code={code} nocopy={nocopy} />
    </div>
  )
}

function getRenderableChildren(children: ReactNode) {
  return Children.toArray(children).filter((child) => {
    if (child === null || typeof child === 'undefined') {
      return false
    }
    if (typeof child === 'boolean') {
      return false
    }
    if (typeof child === 'string') {
      return child.trim().length > 0
    }
    return true
  })
}

/** MDX serializes boolean fence flags as empty-string attributes. */
function isFlagOn(value: boolean | string | undefined): boolean {
  return value === true || value === ''
}

// Collapsed height for `expandable` fences (Mintlify documents no threshold).
const EXPANDABLE_COLLAPSED_LINES = 10
// The pre clips at its padding box, so the cap is its top padding (py-4 =
// 1rem) plus exactly N lines of `text-[0.84rem] leading-[1.7]`.
const EXPANDABLE_COLLAPSED_HEIGHT = `${EXPANDABLE_COLLAPSED_LINES * 0.84 * 1.7 + 1}rem`

/** Find the compiler's source-code payload through MDX/client wrappers. */
export function findCodePayload(node: ReactNode): string | undefined {
  if (!isValidElement(node)) return undefined
  const props = node.props as { code?: unknown; children?: ReactNode; language?: unknown; filename?: unknown; className?: unknown }
  if (typeof props.code === 'string' && props.code.length > 0) return props.code
  if ((node.type === CodeBlock || node.type === Pre || node.type === 'pre' || node.type === 'code') && typeof props.children === 'string') return props.children
  // Across a Server Component boundary, a client element's type can be a lazy
  // reference rather than this module's function identity. Its authored raw
  // string remains source. Compiler Code nodes instead carry highlighted HTML
  // under a language class and must use their enclosing pre's plain `code` prop.
  const isCompilerCode = node.type === Code || (typeof props.className === 'string' && /\blanguage-/.test(props.className) && props.language === undefined && props.filename === undefined)
  if (!isCompilerCode && typeof props.children === 'string') return props.children
  for (const child of Children.toArray(props.children)) {
    const nested = findCodePayload(child)
    if (nested) return nested
  }
  return undefined
}

function CodePanel({
  children,
  tag,
  label,
  code,
  language,
  wrap,
  icon,
  lines,
  expandable,
  nocopy,
  lastmarked,
  hasGroupHeader,
}: {
  children: ReactNode
  tag?: string
  label?: string
  code?: string
  language?: string
  wrap?: boolean | string
  icon?: string
  lines?: boolean | string
  expandable?: boolean | string
  nocopy?: boolean | string
  /** Highest 1-based line carrying a focus/highlight/diff mark (set by rehype). */
  lastmarked?: string
  hasGroupHeader?: boolean
}) {
  // Inactive panels remain mounted, so each sample preserves its expansion state.
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const preId = useId()
  const preRef = useRef<HTMLPreElement>(null)
  useCompiledParameterLinks(preRef, code ?? findCodePayload(children) ?? '')
  const renderableChildren = getRenderableChildren(children)
  if (!renderableChildren.length) {
    return null
  }

  const primaryChild = renderableChildren[0]
  const content =
    renderableChildren.length === 1 ? primaryChild : <>{renderableChildren}</>

  function getLanguageClassName() {
    const probe = renderableChildren.find((child) => isValidElement(child))
    if (!probe) return ''
    const className = (probe.props as { className?: string }).className ?? ''
    const match = className.match(/language-[\w-]+/)
    return match?.[0] ?? ''
  }

  const languageClass = getLanguageClassName()

  let resolvedTag = tag
  let resolvedLabel = label
  let resolvedCode = code
  let resolvedLanguage = language
  let resolvedWrap = isFlagOn(wrap)
  let resolvedIcon = icon
  let resolvedLines = isFlagOn(lines)
  let resolvedExpandable = isFlagOn(expandable)
  let resolvedNocopy = isFlagOn(nocopy)
  let resolvedLastMarked = Number(lastmarked) || 0

  const referenceElement = renderableChildren.find((child) =>
    isValidElement(child),
  )

  if (referenceElement) {
    const props = referenceElement.props as {
      tag?: string
      label?: string
      title?: string
      code?: string
      language?: string
      wrap?: boolean | string
      icon?: string
      lines?: boolean | string
      expandable?: boolean | string
      nocopy?: boolean | string
      lastmarked?: string
    }
    resolvedTag = props.tag ?? resolvedTag
    resolvedLabel = props.label ?? props.title ?? resolvedLabel
    resolvedCode = props.code ?? resolvedCode
    resolvedLanguage = props.language ?? resolvedLanguage
    resolvedWrap = resolvedWrap || isFlagOn(props.wrap)
    resolvedIcon = props.icon ?? resolvedIcon
    resolvedLines = resolvedLines || isFlagOn(props.lines)
    resolvedExpandable = resolvedExpandable || isFlagOn(props.expandable)
    resolvedNocopy = resolvedNocopy || isFlagOn(props.nocopy)
    resolvedLastMarked = Number(props.lastmarked) || resolvedLastMarked
  } else if (!resolvedCode) {
    const extractedText = renderableChildren
      .map((child) => (typeof child === 'string' ? child : ''))
      .join('')
      .trim()
    if (extractedText) {
      resolvedCode = extractedText
    }
  }

  // Client-component serialization may place the compiler-added `code` prop
  // one wrapper below the direct child. Search recursively before treating the
  // block as malformed; a bad authoring example should never take the entire
  // pre-rendered documentation site offline.
  resolvedCode = resolvedCode ?? findCodePayload(content) ?? ''
  resolvedTag =
    resolvedTag ??
    (resolvedLanguage
      ? getPanelTitle({ language: resolvedLanguage })
      : 'Code')

  // A trailing newline is not a visible line.
  const lineCount = resolvedCode.replace(/\n$/, '').split('\n').length
  const collapsible = resolvedExpandable && lineCount > EXPANDABLE_COLLAPSED_LINES
  // A marked line hidden below the fold would defeat the mark, so those
  // fences start expanded.
  const isExpanded = expanded ?? resolvedLastMarked > EXPANDABLE_COLLAPSED_LINES
  const collapsed = collapsible && !isExpanded

  return (
    <div className="group">
      {hasGroupHeader ? <span className="absolute right-2 top-[10px] z-10 max-[560px]:top-[51px]">
          <CodeActions code={resolvedCode} nocopy={resolvedNocopy} />
        </span> : <CodePanelHeader
          tag={resolvedTag}
          label={resolvedLabel}
          code={resolvedCode}
          icon={resolvedIcon}
          nocopy={resolvedNocopy}
        />}
      <div className="relative">
        <pre
          ref={preRef}
          id={collapsible ? preId : undefined}
          style={
            collapsed || resolvedLines
              ? ({
                  ...(collapsed ? { maxHeight: EXPANDABLE_COLLAPSED_HEIGHT } : {}),
                  // Gutter width follows the digit count so 3+ digit numbers do not shift code.
                  ...(resolvedLines ? { '--thally-line-digits': Math.max(2, String(lineCount).length) } : {}),
                } as CSSProperties)
              : undefined
          }
          className={clsx(
            resolvedLines && 'thally-code-lines',
            resolvedLines && resolvedWrap && 'thally-code-hang',
            collapsed && 'thally-code-collapsed overflow-hidden',
            'px-[18px] py-4 font-mono text-[0.84rem] leading-[1.7] text-foreground',
            resolvedWrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto',
            languageClass,
          )}
          suppressHydrationWarning
        >
          {content}
        </pre>
      </div>
      {collapsible && (
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={preId}
          onClick={() => setExpanded(!isExpanded)}
          className="thally-code-toggle w-full border-t border-border py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {isExpanded ? 'Collapse' : 'Expand'}
        </button>
      )}
    </div>
  )
}

function responseStatusLabel(label: string) {
  const match = /^(\d{3})(?:\s+(.+))?$/.exec(label)
  if (!match?.[2]) return label
  return <>{match[1]}<span className="tc-status-description">{match[2]}</span></>
}

const CodeGroupContext = createContext(false)

/** Render authored alternatives with one persistent language menu or response-status tabs. */
export function CodeGroup({
  children,
  title,
  selection = 'language',
  menuLabel,
  ...props
}: ComponentPropsWithoutRef<typeof CodePanel> & { title?: string; selection?: 'language' | 'status'; menuLabel?: string }) {
  const t = useApiLabels()
  const items = useMemo(() => getRenderableChildren(children), [children])
  const languages = useMemo(() => items.map((child) => getPanelTitle(isValidElement(child) ? child.props as { title?: string; tag?: string; language?: string } : {})), [items])
  const aliases = items.map((child, index) => [languages[index], isValidElement(child) ? (child.props as { language?: string }).language : undefined].filter((value): value is string => Boolean(value)).map(normalizeDocsLanguage))
  const [preferredLanguage, setPreferredLanguage] = useDocsLanguage(aliases.flat())
  const matchingIndex = aliases.findIndex((names) => names.includes(preferredLanguage))
  const [selectedStatus, setSelectedStatus] = useState(0)
  const groupId = useId()
  const selectedIndex = selection === 'status' ? Math.min(selectedStatus, Math.max(0, items.length - 1)) : matchingIndex >= 0 ? matchingIndex : 0
  const selected = items[selectedIndex]
  const hasVariants = items.length > 1
  const hasGroupHeader = Boolean(title || hasVariants)
  const selectedProps = isValidElement(selected) ? selected.props as { code?: string; nocopy?: boolean | string; language?: string; icon?: string } : {}

  return (
    <CodeGroupContext.Provider value={true}>
      <div className={`thally-docs-code relative my-5 overflow-hidden rounded-xl border${selection === 'status' ? ' thally-response-example' : ''}`}>
        <div className="not-prose">
          {hasGroupHeader && <div className="thally-code-header thally-code-group-header !pr-[104px]">
            {selectedProps.icon && <Icon icon={selectedProps.icon} size={14} className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="thally-code-title text-xs font-semibold">{title ?? 'Code'}</span>
            {hasVariants && selection === 'status' && <div role="tablist" aria-label={t('responseStatus')} className="tc-statuses">{languages.map((label, index) => <button type="button" role="tab" key={index} id={`${groupId}-tab-${index}`} aria-controls={`${groupId}-panel-${index}`} aria-selected={index === selectedIndex} tabIndex={index === selectedIndex ? 0 : -1} className={`tc-st${/^[45]/.test(label) ? ' err' : ''}`} onClick={() => setSelectedStatus(index)} onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? languages.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + languages.length) % languages.length
              setSelectedStatus(next)
              const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              tabs?.[next]?.focus()
            }}><i aria-hidden="true" />{responseStatusLabel(label)}</button>)}</div>}
            {hasVariants && selection === 'language' && <LanguageMenu label={menuLabel ?? (title === 'Request' ? 'Request example' : 'Code language')} value={languages[selectedIndex]} options={languages} onChange={setPreferredLanguage} />}
          </div>}
          {items.map((child, index) => <div key={index} role={hasVariants ? 'tabpanel' : undefined} hidden={hasVariants && index !== selectedIndex} id={hasVariants ? `${groupId}-panel-${index}` : undefined} aria-label={hasVariants ? languages[index] : undefined}>
            <CodePanel {...props} hasGroupHeader={hasGroupHeader}>{child}</CodePanel>
          </div>)}
        </div>
      </div>
    </CodeGroupContext.Provider>
  )
}

/** Preserve compiler-highlighted code inside panels and ordinary text for inline code. */
export function Code({
  children,
  ...props
}: ComponentPropsWithoutRef<'code'>) {

  return <code {...props}>{children}</code>
}

interface PreProps extends Omit<ComponentPropsWithoutRef<typeof CodeGroup>, 'children'> {
  children?: ReactNode
}

/** Render a fenced block through the shared card while preserving its authored options. */
export function Pre({
  children,
  title,
  ...props
}: PreProps) {
  const isGrouped = useContext(CodeGroupContext)

  // Mermaid fences are diagrams, not syntax-highlighted code panels. The
  // compiler lifts the untouched source onto `code`; the recursive fallback
  // preserves compatibility with content produced by older MDX pipelines.
  if (props.language === 'mermaid') {
    return <Mermaid chart={props.code ?? findCodePayload(children)} />
  }

  if (isGrouped) {
    return children
  }

  return <CodeGroup {...props} label={title}>{children}</CodeGroup>
}

interface CodeBlockProps extends Omit<PreProps, 'title'> {
  filename?: string
  /** Lines to tint, as Mintlify writes them: `"1,3-5"`, `"{1,3-5}"` or `"[1,3]"`. */
  highlight?: string
  /** Lines to keep in focus; every other line is dimmed. Same syntax as `highlight`. */
  focus?: string
}

/** 1-based line numbers from `1,3-5`, with optional `{}` or `[]` around them. */
function parseLineSpec(spec: unknown): Set<number> {
  const lines = new Set<number>()
  if (typeof spec !== 'string') return lines
  for (const part of spec.replace(/[{}[\]\s]/g, '').split(',')) {
    const [from, to = from] = part.split('-').map(Number)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) continue
    for (let line = from; line <= Math.min(to, from + 1000); line += 1) lines.add(line)
  }
  return lines
}

/**
 * Mintlify-parity standalone code block:
 * `<CodeBlock language="ts" filename="x.ts" lines highlight="2">{`const x = 1`}</CodeBlock>`.
 * A thin wrapper around `Pre`, so `lines`, `icon`, `expandable`, `nocopy` and
 * `wrap` behave exactly as on a fenced block. `highlight` and `focus` are
 * applied to a plain string child here (a fence has them applied at build
 * time). `children` may also be an already-rendered `<pre>`/`<code>` element
 * (e.g. from migrated content), which is passed through unchanged.
 */
export function CodeBlock({ children, filename, highlight, focus, ...props }: CodeBlockProps) {
  if (typeof children !== 'string') {
    return <Pre {...props} title={filename}>{children}</Pre>
  }
  const code = children.replace(/\n$/, '')
  const highlighted = parseLineSpec(highlight)
  const focused = parseLineSpec(focus)
  const marked = [...highlighted, ...focused]
  return (
    <Pre {...props} code={code} title={filename} lastmarked={marked.length ? String(Math.max(...marked)) : undefined}>
      <code className={props.language ? `language-${props.language}` : undefined}>
        {code.split('\n').map((line, index) => (
          <Fragment key={index}>
            {index > 0 && '\n'}
            <span
              className={clsx(
                highlighted.has(index + 1) && 'thally-line-highlight',
                focused.size > 0 && !focused.has(index + 1) && 'thally-line-dim',
              ) || undefined}
            >
              {line}
            </span>
          </Fragment>
        ))}
      </code>
    </Pre>
  )
}
