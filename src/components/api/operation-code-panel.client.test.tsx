/** Reader language menus retain every canonical generator and authored override after hydration. */

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedOperation } from '@/lib/openapi/types'
import { usePreferredLanguageStore } from '@/lib/preferred-language'

vi.mock('@/components/docs/code-actions-provider', () => ({
  useDocsCodeActions: () => ({ hasAssistantEntryPoint: false }),
}))

import { OperationCodePanel } from '@/components/api/operation-code-panel'
import { useTryItController } from '@/components/api/use-try-it-controller'
import { operationFrom } from '@/components/api/test-fixtures'

function operation(samples?: Array<{ lang: string; source: string }>) {
  return operationFrom({
    openapi: '3.1.0',
    info: { title: 'Pages', version: '1' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/pages': {
        get: {
          summary: 'List pages',
          ...(samples ? { 'x-codeSamples': samples } : {}),
          responses: { '200': { description: 'Pages returned.' } },
        },
      },
    },
  })
}

function CodePanel({ value }: { value: NormalizedOperation }) {
  const controller = useTryItController(value)
  return <OperationCodePanel controller={controller} />
}

let root: Root
let container: HTMLElement

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.localStorage.clear()
  usePreferredLanguageStore.setState({ preferredLanguages: [] })
  document.body.innerHTML = '<div id="root"></div>'
  container = document.getElementById('root') as HTMLElement
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  window.localStorage.clear()
  usePreferredLanguageStore.setState({ preferredLanguages: [] })
})

async function click(button: HTMLButtonElement) {
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
}

async function openLanguages() {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Select language"]')
  expect(trigger).not.toBeNull()
  await click(trigger!)
  expect(trigger?.getAttribute('aria-expanded')).toBe('true')
  // The real menu portals outside the card to avoid clipping at its rounded edge.
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
}

describe('OperationCodePanel language menu', () => {
  it('opens all seven canonical choices, renames JavaScript, and selects Java', async () => {
    await act(async () => { root.render(<CodePanel value={operation()} />) })
    const choices = await openLanguages()
    expect(choices.map((button) => button.textContent)).toEqual(['cURL', 'Python', 'Node.js', 'PHP', 'Go', 'Java', 'Ruby'])
    expect(choices.find((button) => button.textContent === 'cURL')?.getAttribute('aria-checked')).toBe('true')
    expect(choices.some((button) => button.textContent === 'JavaScript')).toBe(false)

    await click(choices.find((button) => button.textContent === 'Java')!)
    expect(container.querySelector('button[aria-label="Select language"]')?.textContent).toBe('Java')
    expect(container.querySelector('pre')?.textContent).toContain('Unirest.get')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(window.localStorage.getItem('thallyDocsLang')).toBe('Java')
  })

  it('retains authored custom languages and overrides the generated JavaScript sample once', async () => {
    const authored = operation([
      { lang: 'JavaScript', source: 'customApi.pages.list()' },
      { lang: 'Rust', source: 'client::list_pages();' },
    ])
    await act(async () => { root.render(<CodePanel value={authored} />) })
    expect(container.querySelector('pre')?.textContent).toBe('customApi.pages.list()')
    const choices = await openLanguages()
    expect(choices.map((button) => button.textContent)).toEqual(['Node.js', 'Rust', 'cURL', 'Python', 'PHP', 'Go', 'Java', 'Ruby'])
    expect(choices.filter((button) => button.textContent === 'Node.js')).toHaveLength(1)

    await click(choices.find((button) => button.textContent === 'Rust')!)
    expect(container.querySelector('pre')?.textContent).toBe('client::list_pages();')
    expect(container.querySelector('button[aria-label="Select language"]')?.textContent).toBe('Rust')
    expect(window.localStorage.getItem('thallyDocsLang')).toBe('Rust')
  })
})
