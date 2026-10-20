// @vitest-environment happy-dom
/** Client marks track the reader mode and recover cleanly after artwork failures. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const theme = vi.hoisted(() => ({ resolvedTheme: 'light' }))
vi.mock('@/components/theme/reader-theme', () => ({ useReaderTheme: () => theme }))
import { SiteBrandMark } from './site-brand-mark'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  theme.resolvedTheme = 'light'
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('SiteBrandMark', () => {
  it('uses a hydration-safe light image on the server and the selected mode after mount', async () => {
    theme.resolvedTheme = 'dark'
    expect(renderToStaticMarkup(<SiteBrandMark />)).toContain('/api/brand/favicon?mode=light')
    await act(async () => root.render(<SiteBrandMark />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/brand/favicon?mode=dark')
  })

  it('falls back on image failure, then retries the custom route on a mode change', async () => {
    await act(async () => root.render(<SiteBrandMark />))
    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/default-favicon-light.svg')
    theme.resolvedTheme = 'dark'
    await act(async () => root.render(<SiteBrandMark />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/brand/favicon?mode=dark')
  })

  it('handles failed cached probes before hydration and hides a missing bundled fallback', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0)
    await act(async () => root.render(<SiteBrandMark kind="logo" />))
    expect(container.querySelector('img')).toBeNull()
  })
})
