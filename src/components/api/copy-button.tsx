'use client'

/** Shared copy action; its success timeout is reset by each successful copy. */
import { useEffect, useRef, useState } from 'react'
import { useApiLabels } from '@/components/api/api-locale'
import { Check, Copy } from 'lucide-react'

/** Copy plain source, using a selection fallback for embedded documentation previews. */
export async function copyPlainText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.readOnly = true
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    const previousFocus = document.activeElement
    // Keep the selection inside a modal focus trap in embedded previews.
    const container = previousFocus instanceof Element
      ? previousFocus.closest('[role="dialog"]') ?? document.body
      : document.body
    container.append(textarea)
    textarea.select()
    try { return document.execCommand('copy') } catch { return false } finally {
      textarea.remove()
      if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true })
    }
  }
}

/** Icon action with accessible feedback lasting the handoff's 1.6 seconds. */
export function CopyButton({ value, className = 'tc-action', disabled, iconClassName = 'h-[15px] w-[15px]', label }: {
  value: string
  className?: string
  disabled?: boolean
  iconClassName?: string
  label?: string
}) {
  const t = useApiLabels()
  const actionLabel = label ?? t('copy')
  const [copied, setCopied] = useState(false)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timeout.current), [])
  return (
    <button type="button" disabled={disabled} onClick={() => {
      void copyPlainText(value).then((success) => {
        if (!success) return
        clearTimeout(timeout.current)
        setCopied(true)
        timeout.current = setTimeout(() => setCopied(false), 1600)
      })
    }} className={`${className}${copied ? ' done' : ''}`} aria-label={copied ? t('copied') : actionLabel} title={copied ? t('copied') : actionLabel}>
      {copied ? <Check className={iconClassName} /> : <Copy className={iconClassName} />}
      <span className="sr-only" aria-live="polite">{copied ? t('copied') : ''}</span>
    </button>
  )
}
