/** A link to a field inside a collapsed Expandable opens it, as the <details> Mintlify renders does. */

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Expandable, ParamField } from '@/components/mdx/api-fields'

let container: HTMLElement
let root: Root
const scrolled: Array<string> = []

beforeEach(() => {
  scrolled.length = 0
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.id) }
  window.location.hash = ''
  document.body.innerHTML = '<div id="root"></div>'
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.getElementById('root') as HTMLElement
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  vi.restoreAllMocks()
})

const page = (
  <>
    <Expandable title="properties">
      <ParamField body="expiresInDays" id="param-expires-in-days" />
      <Expandable title="more">
        <ParamField body="nested" id="param-nested" />
      </Expandable>
    </Expandable>
    <Expandable title="other">
      <ParamField body="other" id="param-other" />
    </Expandable>
  </>
)

const expanded = () => Array.from(container.querySelectorAll('button')).map((button) => button.getAttribute('aria-expanded'))

async function mount(): Promise<void> {
  await act(async () => { root.render(page) })
}

describe('Expandable and a #fragment', () => {
  it('stays collapsed when the page has no fragment', async () => {
    await mount()
    expect(expanded()).toEqual(['false', 'false', 'false'])
    expect(scrolled).toEqual([])
  })

  it('opens the Expandable around the target on load, and scrolls to it', async () => {
    window.location.hash = '#param-expires-in-days'
    await mount()
    expect(expanded()).toEqual(['true', 'false', 'false'])
    expect(scrolled).toEqual(['param-expires-in-days'])
  })

  it('opens every Expandable around a nested target', async () => {
    window.location.hash = '#param-nested'
    await mount()
    expect(expanded()).toEqual(['true', 'true', 'false'])
    expect(scrolled).toContain('param-nested')
  })

  it('opens it when the fragment changes later, and leaves a target elsewhere alone', async () => {
    await mount()
    await act(async () => {
      window.location.hash = '#param-other'
      window.dispatchEvent(new Event('hashchange'))
    })
    expect(expanded()).toEqual(['false', 'false', 'true'])
    await act(async () => {
      window.location.hash = '#nowhere'
      window.dispatchEvent(new Event('hashchange'))
    })
    expect(expanded()).toEqual(['false', 'false', 'true'])
  })

  it('ignores a fragment that is not valid percent-encoding', async () => {
    window.location.hash = '#%E0%A4%A'
    await mount()
    expect(expanded()).toEqual(['false', 'false', 'false'])
  })
})
