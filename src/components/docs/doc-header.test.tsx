/** The page title wraps instead of overflowing on a long unbroken word; the eyebrow is a group name or a group path. */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/guide' }))

import { DocHeader } from './doc-header'

describe('DocHeader', () => {
  it('uses the authored display heading while retaining the metadata title', () => {
    const html = renderToStaticMarkup(<DocHeader doc={{ title: 'Long SEO title', headingTitle: 'Display title' } as never} showCopyPage={false} />)
    expect(html).toContain('Display title</h1>')
    expect(html).not.toContain('Long SEO title')
  })
  it('lets a long title break', () => {
    const html = renderToStaticMarkup(<DocHeader doc={{ title: 'Supercalifragilisticexpialidocious'.repeat(3) } as never} showCopyPage={false} />)
    expect(html).toMatch(/<h1 class="[^"]*break-words/)
  })

  describe('eyebrow', () => {
    const header = (eyebrow?: string | Array<string> | null) =>
      renderToStaticMarkup(<DocHeader doc={{ title: 'Page' } as never} eyebrow={eyebrow} showCopyPage={false} />)

    it('keeps the single group name as accent text', () => {
      expect(header('Capacity')).toContain('<p class="thally-docs-eyebrow mb-2.5 text-sm font-semibold leading-5 text-accent">Capacity</p>')
      expect(header('Capacity')).not.toContain('<ol')
    })

    it('renders a group path as a labelled list of plain text: no landmark, no links, no current page', () => {
      const html = header(['Errors', 'Frontline errors', 'Capacity'])
      expect(html).toMatch(/<div class="thally-docs-eyebrow[^"]*"><ol aria-label="Section path" /)
      expect(html.match(/<li /g)).toHaveLength(3)
      expect(html.match(/<svg /g)).toHaveLength(2)
      expect(html.match(/<svg[^>]*aria-hidden="true"/g)).toHaveLength(2)
      expect(html).not.toContain('<nav')
      expect(html).not.toContain('aria-current')
      expect(html).not.toContain('<a ')
      expect(html.indexOf('Errors')).toBeLessThan(html.indexOf('Frontline errors'))
      expect(html.indexOf('Frontline errors')).toBeLessThan(html.indexOf('Capacity'))
    })

    it('renders nothing for an empty path, no group or a missing eyebrow', () => {
      for (const eyebrow of [[], '', null, undefined]) expect(header(eyebrow)).not.toContain('thally-docs-eyebrow')
    })
  })
})
