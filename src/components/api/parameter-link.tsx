'use client'

/** Coordinate parameter focus across documentation, request, and response lines. */
import { createContext, useContext, useCallback, useEffect, useState, type ReactNode, type RefObject } from 'react'
import { parametersForCodeLine } from '@/lib/code-parameter-links'

const ParameterLinkContext = createContext<{
  activeNames?: string[]
  knownNames?: string[]
  registerParameter: (name: string) => void
  setActiveName: (name?: string | string[]) => void
}>({ setActiveName: () => {}, registerParameter: () => {} })

/** Scope linking to one endpoint, including its portalled request dialog. */
export function ParameterLinkProvider({ children }: { children: ReactNode }) {
  const [knownNames, setKnownNames] = useState<string[]>([])
  const registerParameter = useCallback((name: string) => setKnownNames((previous) => previous.includes(name) ? previous : [...previous, name]), [])
  const [activeNames, updateActiveNames] = useState<string[]>([])
  const setActiveName = useCallback((name?: string | string[]) => updateActiveNames(Array.isArray(name) ? name : name ? [name] : []), [])
  return <ParameterLinkContext.Provider value={{ activeNames, setActiveName, knownNames, registerParameter }}>{children}</ParameterLinkContext.Provider>
}

/** Bind a parameter row or generated line to its matching documentation. */
export function useParameterLink(name?: string | string[]) {
  const { activeNames, setActiveName, registerParameter } = useContext(ParameterLinkContext)
  // Only documentation/form rows register fields. Generated code lines pass
  // arrays so inferred source associations never grow the known-field set.
  useEffect(() => { if (typeof name === 'string' && name) registerParameter(name) }, [name, registerParameter])
  return {
    active: Boolean(name && (Array.isArray(name) ? name.some((value) => activeNames?.includes(value)) : activeNames?.includes(name))),
    onMouseEnter: () => { if (name) setActiveName(name) },
    onMouseLeave: () => { if (name) setActiveName(undefined) },
    onFocus: () => { if (name) setActiveName(name) },
    onBlur: () => { if (name) setActiveName(undefined) },
  }
}

/** Link compiler-rendered code lines using their text, preserving Shiki token markup. */
export function useCompiledParameterLinks(ref: RefObject<HTMLPreElement | null>, source: string) {
  const { activeNames, setActiveName, knownNames } = useContext(ParameterLinkContext)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const lines = Array.from(element.querySelectorAll<HTMLElement>('code > span'))
    const cleanup: Array<() => void> = []
    for (const [index, line] of lines.entries()) {
      line.style.setProperty('--line-delay', `${Math.min(index, 30) * 28}ms`)
      const names = parametersForCodeLine(line.textContent ?? '', knownNames)
      if (!names.length) continue
      const previousP = line.getAttribute('data-p')
      const previousParameters = line.getAttribute('data-parameters')
      const previousTabIndex = line.getAttribute('tabindex')
      line.dataset.p = names[0]
      if (names.length > 1) line.dataset.parameters = JSON.stringify(names)
      line.classList.add('thally-code-linked-line')
      line.tabIndex = 0
      const activate = () => setActiveName(names)
      const deactivate = () => setActiveName(undefined)
      line.addEventListener('mouseenter', activate)
      line.addEventListener('mouseleave', deactivate)
      line.addEventListener('focus', activate)
      line.addEventListener('blur', deactivate)
      cleanup.push(() => {
        line.removeEventListener('mouseenter', activate)
        line.removeEventListener('mouseleave', deactivate)
        line.removeEventListener('focus', activate)
        line.removeEventListener('blur', deactivate)
        line.classList.remove('thally-code-linked-line', 'on')
        for (const [attribute, previous] of [['data-p', previousP], ['data-parameters', previousParameters], ['tabindex', previousTabIndex]] as const) {
          if (previous === null) line.removeAttribute(attribute)
          else line.setAttribute(attribute, previous)
        }
      })
    }
    return () => cleanup.forEach((remove) => remove())
  }, [ref, source, setActiveName, knownNames])
  useEffect(() => {
    for (const line of ref.current?.querySelectorAll<HTMLElement>('[data-p]') ?? []) {
      const names = parametersForCodeLine(line.textContent ?? '', knownNames)
      line.classList.toggle('on', names.some((name) => activeNames?.includes(name)))
    }
  }, [activeNames, ref, source, knownNames])
}
