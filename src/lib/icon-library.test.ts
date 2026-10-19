/**
 * Icons must never render blank. These are the 91 icon names the Trigger.dev
 * docs use, grouped by what Font Awesome Free (7.3.1) actually ships for them,
 * so an asset URL can be checked without a network request.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Icon } from '@/components/mdx/content-icon'
import { badgeGlyph, type IconStyle } from '@/lib/icon-library'

const words = (list: string) => list.split(/\s+/).filter(Boolean)

/** In the Free `regular` set. */
const FREE_REGULAR = words('circle-check circle-question circle-xmark clock comments file-lines hand hourglass pen-to-square rectangle-list star trash-can')
/** In the Free `solid` set only. */
const FREE_SOLID = words(`arrows-to-dot ban bolt book book-open brain bug bullhorn chart-column clock-rotate-left code compress database
  dharmachakra diagram-project f film filter fingerprint fire graduation-cap inbox key layer-group list-check magnifying-glass
  magnifying-glass-chart microphone pen-nib phone play plug puzzle-piece r robot rocket s scale-balanced screwdriver-wrench scroll
  server shield-halved table terminal user-check wand-magic-sparkles wrench`)
const BRANDS = words('aws discord docker github js node-js react')
/** Pro only: no asset exists in Free under any style. */
const PRO_ONLY = words(`alarm-exclamation books browser bullseye-pointer circle-1 circle-2 circle-3 circle-4 circle-5 circle-6 circle-7
  diagram-subtask gauge-simple-low message-bot message-lines microchip-ai rectangle-history shield-check snake sparkles spinner-third
  square-e triangle wave-pulse webhook`)

const STYLES: Array<IconStyle | undefined> = [undefined, 'regular', 'solid', 'outline']
const ASSET = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:@fortawesome\/fontawesome-free@[\d.]+\/svgs\/(regular|solid|brands)|lucide-static@[\d.]+\/icons)\/([a-z0-9-]+)\.svg$/

/**
 * What the rendered `Icon` shows under Font Awesome: the asset its mask requests, or the glyph or
 * inline mark it draws instead. Rendering the component covers every caller, since the content,
 * navigation and tab icons all go through it.
 */
function resolution(name: string, style: IconStyle | undefined) {
  const markup = renderToStaticMarkup(createElement(Icon, { icon: name, iconType: style }))
  const source = /data-icon-source="(\w+)"/.exec(markup)?.[1]
  if (source === 'badge') return { kind: 'glyph' as const }
  if (source === 'brand') return { kind: 'inline' as const }
  const url = /--thally-icon-fontawesome:url\(&quot;([^&]+)&quot;\)/.exec(markup)?.[1]
  if (!url) throw new Error(`No Font Awesome asset in the markup for ${name}: ${markup}`)
  const match = ASSET.exec(url)
  if (!match) throw new Error(`Unexpected asset URL for ${name}: ${url}`)
  return match[1] ? { kind: match[1] as 'regular' | 'solid' | 'brands', file: match[2] } : { kind: 'lucide' as const, file: match[2] }
}

describe('Font Awesome icon resolution', () => {
  it.each(STYLES)('uses the regular set only where Free ships it (style %s)', (style) => {
    for (const name of FREE_REGULAR) {
      expect(resolution(name, style)).toEqual({ kind: style === 'regular' ? 'regular' : 'solid', file: name })
    }
  })

  it.each(STYLES)('falls back to the solid set when an explicit regular style has no Free asset (style %s)', (style) => {
    for (const name of FREE_SOLID) expect(resolution(name, style), name).toEqual({ kind: 'solid', file: name })
  })

  it.each(STYLES)('never builds a Font Awesome URL for a Pro-only name (style %s)', (style) => {
    for (const name of PRO_ONLY) {
      const result = resolution(name, style)
      expect(['lucide', 'glyph', 'inline'], name).toContain(result.kind)
      if (result.kind === 'lucide') expect(result.file.length, name).toBeGreaterThan(2)
    }
  })

  it('maps Pro-only names to the nearest outlined Lucide icon', () => {
    expect(Object.fromEntries(['alarm-exclamation', 'bullseye-pointer', 'diagram-subtask', 'gauge-simple-low', 'message-lines', 'microchip-ai', 'rectangle-history', 'snake', 'spinner-third', 'wave-pulse', 'books', 'browser', 'message-bot', 'shield-check', 'sparkles', 'triangle', 'webhook'].map((name) => [name, resolution(name, undefined)]))).toEqual({
      'alarm-exclamation': { kind: 'lucide', file: 'alarm-clock' },
      'bullseye-pointer': { kind: 'lucide', file: 'target' },
      'diagram-subtask': { kind: 'lucide', file: 'list-tree' },
      'gauge-simple-low': { kind: 'lucide', file: 'gauge' },
      'message-lines': { kind: 'lucide', file: 'message-square-text' },
      'microchip-ai': { kind: 'lucide', file: 'cpu' },
      'rectangle-history': { kind: 'lucide', file: 'gallery-vertical-end' },
      snake: { kind: 'lucide', file: 'worm' },
      'spinner-third': { kind: 'lucide', file: 'loader' },
      'wave-pulse': { kind: 'lucide', file: 'activity' },
      books: { kind: 'lucide', file: 'library' },
      browser: { kind: 'lucide', file: 'app-window' },
      'message-bot': { kind: 'lucide', file: 'bot-message-square' },
      'shield-check': { kind: 'lucide', file: 'shield-check' },
      sparkles: { kind: 'lucide', file: 'sparkles' },
      triangle: { kind: 'lucide', file: 'triangle' },
      webhook: { kind: 'lucide', file: 'webhook' },
    })
  })

  it('keeps Pro names that are bundled Lucide glyphs visible under Font Awesome', () => {
    expect(Object.fromEntries(['rocket-launch', 'party-horn', 'brackets-curly', 'code-simple', 'grid-round', 'link-simple', 'circle-x'].map((name) => [name, resolution(name, 'regular')]))).toEqual({
      'rocket-launch': { kind: 'lucide', file: 'rocket' },
      'party-horn': { kind: 'lucide', file: 'party-popper' },
      'brackets-curly': { kind: 'lucide', file: 'braces' },
      'code-simple': { kind: 'lucide', file: 'code' },
      'grid-round': { kind: 'lucide', file: 'grid-3x3' },
      'link-simple': { kind: 'lucide', file: 'link-2' },
      'circle-x': { kind: 'lucide', file: 'circle-x' },
    })
  })

  it('draws numbered circles and lettered squares as glyphs, except names Free ships itself', () => {
    expect(badgeGlyph('circle-3')).toEqual({ shape: 'circle', character: '3' })
    expect(badgeGlyph('square-e')).toEqual({ shape: 'square', character: 'E' })
    for (const name of ['circle-h', 'square-h', 'circle-check', 'circle-10', 'square', 'circle', 'r', 'f']) expect(badgeGlyph(name), name).toBeNull()
  })

  it('renders a badge as an inline svg that follows the icon colour, with no asset request', () => {
    const circle = renderToStaticMarkup(createElement(Icon, { icon: 'circle-7', size: 24, color: '#0ea5e9' }))
    expect(circle).toContain('data-icon-source="badge"')
    expect(circle).toContain('<circle cx="12" cy="12" r="10"></circle>')
    expect(circle).toMatch(/<text[^>]*>7<\/text>/)
    expect(circle).toContain('stroke="currentColor"')
    expect(circle).toContain('width:24px;height:24px;color:#0ea5e9')
    expect(circle).not.toMatch(/jsdelivr|thally-icon-mask/)
    const square = renderToStaticMarkup(createElement(Icon, { icon: 'fa-regular fa-square-e' }))
    expect(square).toContain('<rect')
    expect(square).toMatch(/<text[^>]*>E<\/text>/)
    // Names Free ships, and bundled glyphs, keep their own rendering.
    expect(renderToStaticMarkup(createElement(Icon, { icon: 'circle-h' }))).toContain('svgs/solid/circle-h.svg')
    expect(renderToStaticMarkup(createElement(Icon, { icon: 'circle-x' }))).toContain('data-icon-source="lucide"')
  })

  it.each(STYLES)('resolves every brand to an inline mark or the brands set (style %s)', (style) => {
    for (const name of BRANDS) {
      const kind = resolution(name, style).kind
      expect(['inline', 'brands'], name).toContain(kind)
    }
  })

  it('resolves all 91 names to an asset that exists or a glyph, whatever style is requested', () => {
    const all = [...FREE_REGULAR, ...FREE_SOLID, ...BRANDS, ...PRO_ONLY]
    expect(all).toHaveLength(91)
    expect(new Set(all).size).toBe(91)
    const regularOk = new Set(FREE_REGULAR)
    const solidOk = new Set(FREE_SOLID.concat(FREE_REGULAR))
    for (const style of STYLES) {
      for (const name of all) {
        const result = resolution(name, style)
        if (result.kind === 'regular') expect(regularOk.has(name), `${name} regular`).toBe(true)
        else if (result.kind === 'solid') expect(solidOk.has(name), `${name} solid`).toBe(true)
        else if (result.kind === 'brands') expect(BRANDS, name).toContain(name)
        else expect(['lucide', 'glyph', 'inline']).toContain(result.kind)
      }
    }
  })
})
