/** No-JavaScript regression coverage for the precompiled documentation home. */

import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'

import { runtimeDocs } from '@/generated/runtime-docs'
import { useMDXComponents } from '@/components/mdx/mdx-components'

// Client navigation helpers need the App Router; static rendering has none.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ prefetch: () => undefined, push: () => undefined }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

const inertWindow = new Window({ settings: {
  enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true,
  disableCSSFileLoading: true, enableImageFileLoading: false,
} })
afterAll(() => inertWindow.happyDOM.close())

describe('documentation homepage SSR', () => {
  it('ships a substantive H1-led heading hierarchy in raw HTML', () => {
    const Introduction = runtimeDocs['src/content/introduction.mdx'].component
    const html = renderToStaticMarkup(
      <Introduction components={useMDXComponents({})} />,
    )
    const document = new inertWindow.DOMParser().parseFromString(html, 'text/html')
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()

    expect(document.querySelectorAll('h1')).toHaveLength(1)
    expect(document.querySelectorAll('h2').length).toBeGreaterThanOrEqual(2)
    expect(text.length).toBeGreaterThanOrEqual(500)
    // Each site authors its own homepage copy. Assert the compiled Hero's
    // semantic content and usable actions instead of the public site's slogan.
    const heading = document.querySelector('h1')!
    expect(heading.textContent.trim().length).toBeGreaterThan(0)
    const hero = heading.closest('section')!
    expect(hero).not.toBeNull()
    expect((hero.querySelector('p')?.textContent ?? '').trim().length).toBeGreaterThan(0)
    const actions = hero.querySelectorAll('a[href]')
    expect(actions.length).toBeGreaterThanOrEqual(1)
    for (const action of actions) {
      expect(action.textContent.trim().length).toBeGreaterThan(0)
      expect(action.getAttribute('href')).toBeTruthy()
      expect(action.getAttribute('href')).not.toBe('#')
    }
  })
})
