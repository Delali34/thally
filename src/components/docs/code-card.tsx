'use client'

/** Shared code-card chrome, language preference, and parameter-aware source lines. */
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Sparkles } from 'lucide-react'
import { resolvePreferredLanguage, usePreferredLanguageStore } from '@/lib/preferred-language'
import { useApiLabels } from '@/components/api/api-locale'
import { CopyButton } from '@/components/api/copy-button'
import { useParameterLink } from '@/components/api/parameter-link'
import { useDocsCodeActions } from '@/components/docs/code-actions-provider'
import { parametersForCodeLine } from '@/lib/code-parameter-links'
export { parametersForCodeLine, parameterForCodeLine } from '@/lib/code-parameter-links'
import { DOCS_LANGUAGES, normalizeDocsLanguage } from '@/lib/openapi/code-snippets'

/** Keep the most recent compatible preference while treating request-language aliases alike. */
export function resolveDocsLanguage(availableLanguages: readonly string[] | undefined, preferredLanguages: readonly string[]): string {
  const preferred = preferredLanguages.map(normalizeDocsLanguage)
  const available = availableLanguages?.map(normalizeDocsLanguage)
  return available ? resolvePreferredLanguage(available, preferred) ?? 'cURL' : preferred.at(-1) ?? 'cURL'
}

/** Share the existing preference history and persist its latest choice across page reloads. */
export function useDocsLanguage(availableLanguages?: readonly string[]): [string, (language: string) => void] {
  const { preferredLanguages, addPreferredLanguage } = usePreferredLanguageStore()
  const setLanguage = (language: string) => {
    const normalized = normalizeDocsLanguage(language)
    addPreferredLanguage(normalized)
    try { localStorage.setItem('thallyDocsLang', normalized) } catch { /* Reader storage may be disabled. */ }
  }
  useEffect(() => {
    try {
      const saved = localStorage.getItem('thallyDocsLang')
      if (saved) addPreferredLanguage(normalizeDocsLanguage(saved))
    } catch { /* A blocked store must never prevent rendering documentation. */ }
    const sync = (event: StorageEvent) => {
      if (event.key === 'thallyDocsLang' && event.newValue) addPreferredLanguage(normalizeDocsLanguage(event.newValue))
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [addPreferredLanguage])
  return [resolveDocsLanguage(availableLanguages, preferredLanguages), setLanguage]
}

/** Keyboard-accessible menu portalled beyond a code card's rounded clipping boundary. */
export function LanguageMenu({ value, onChange, options = DOCS_LANGUAGES, label }: {
  value: string
  onChange: (value: string) => void
  options?: readonly string[]
  label?: string
}) {
  const t = useApiLabels()
  const resolvedLabel = label ?? t('selectLanguage')
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const [portalContainer, setPortalContainer] = useState<Element | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const shouldFocus = useRef(false)
  const open = Boolean(position)
  const close = (restoreFocus = false) => {
    setPosition(null)
    if (restoreFocus) trigger.current?.focus()
  }
  const show = (keyboard: boolean) => {
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    shouldFocus.current = keyboard
    setPortalContainer(trigger.current?.closest('[role="dialog"]') ?? document.body)
    if (keyboard && open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    // The menu always stays within the viewport, including inside the dialog.
    const height = options.length * 34 + 12
    setPosition({ top: rect.bottom + height + 8 > window.innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
  }
  useEffect(() => {
    if (!open) return
    if (shouldFocus.current) {
      const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
      items?.[Math.max(0, options.indexOf(value))]?.focus()
    }
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setPosition(null)
    }
    const reposition = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setPosition(null) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPosition(null); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, options, value])
  return <div className="tc-lang">
    <button ref={trigger} type="button" className="tc-lb" aria-label={resolvedLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={(event) => open ? close() : show(event.detail === 0)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(true) }
      }}><span className="tc-language-label">{value}</span><ChevronDown size={12} aria-hidden="true" /></button>
    {position && portalContainer && createPortal(<div ref={menu} id={menuId} className="tc-menu open" role="menu" aria-label={resolvedLabel} style={{ position: 'fixed', ...position }}
      onKeyDown={(event) => {
        if (event.key === 'Tab') { close(); return }
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[index]?.focus()
        }
      }}>
      {options.map((option) => <button type="button" className="tc-opt" role="menuitemradio" aria-checked={value === option} key={option} tabIndex={-1}
        onClick={(event) => { onChange(option); close(event.detail === 0) }}>{option}</button>)}
    </div>, portalContainer)}
  </div>
}

/** Separate request/response surface; controls are supplied by the calling example. */
export function CodeCard({ title, tools, children, className = '' }: { title: ReactNode; tools?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`tc not-prose ${className}`}><div className="tc-h"><div className="tc-t">{title}</div><div className="tc-tools">{tools}</div></div>{children}</section>
}

/** Optional assistant entry point uses the existing provider and its availability gate. */
export function CodeCardActions({ code, language, ask = true, nocopy = false }: { code: string; language?: string; ask?: boolean; nocopy?: boolean }) {
  const { hasAssistantEntryPoint, askAssistant } = useDocsCodeActions()
  return <div className="tc-acts">
    {!nocopy && <CopyButton value={code} />}
    {ask && hasAssistantEntryPoint && <button type="button" className="tc-action" aria-label="Ask assistant about this code" title="Ask AI" onClick={() => askAssistant(`Explain this ${language ?? ''} request`)}><Sparkles size={15} aria-hidden="true" /></button>}
  </div>
}

function tokenizedLine(line: string): ReactNode {
  // Source remains React text throughout: untrusted API examples never become HTML.
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:true|false|null|None|True|False|const|await|import|from|return|func|package|require|end|do)\b|\b\d+(?:\.\d+)?\b|(?:\/\/|#).*$)/g
  const result: ReactNode[] = []
  let previous = 0
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0
    result.push(line.slice(previous, index))
    const token = match[0]
    const type = /^[/#]/.test(token) ? 'c' : /^['"]/.test(token) ? /^\s*:/.test(line.slice(index + token.length)) ? 'p' : 's' : /^\d/.test(token) ? 'n' : 'k'
    result.push(<span key={index} className={`sx-${type}`}>{token}</span>)
    previous = index + token.length
  }
  result.push(line.slice(previous))
  return result
}

function CodeLine({ line, parameters, index, animate }: { line: string; parameters: string[]; index: number; animate?: boolean }) {
  const { active, ...events } = useParameterLink(parameters)
  return <span className={`l${active ? ' on' : ''}${animate ? ' in' : ''}`} data-p={parameters[0]} data-parameters={parameters.length > 1 ? JSON.stringify(parameters) : undefined} tabIndex={parameters.length ? 0 : undefined} {...events} style={animate ? { '--line-delay': `${Math.min(index, 30) * 28}ms` } as CSSProperties : undefined}>{tokenizedLine(line) || ' '}</span>
}

/** Line numbers are CSS counters; copy actions receive only the original source. */
export function CodeLines({ code, parameters, lineParameters, animate = false }: { code: string; parameters?: string[]; lineParameters?: Record<number, string[]>; animate?: boolean }) {
  return <pre className="tc-source"><code>{code.replace(/\n$/, '').split('\n').map((line, index) => <CodeLine key={index} line={line} parameters={[...new Set([...parametersForCodeLine(line, parameters), ...(lineParameters?.[index] ?? [])])]} index={index} animate={animate} />)}</code></pre>
}
