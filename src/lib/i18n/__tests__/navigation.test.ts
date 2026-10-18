/** Reader navigation follows authored translations and preserves untranslated source destinations. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NavContext } from '@/data/docs'

const mocks = vi.hoisted(() => ({ hasDocTranslation: vi.fn() }))
vi.mock('@/lib/i18n/translation-source', () => ({ hasDocTranslation: mocks.hasDocTranslation }))

import { localizeDocNavigation } from '../navigation'

const navigation: NavContext = {
  tab: 'Guides', group: 'Integration tips', groupPath: ['Integration tips'],
  prev: { title: 'Slippage', href: '/guides/slippage' },
  next: { title: 'Routing', href: '/guides/routing' },
  breadcrumb: [{ label: 'Guides', href: '/guides/fees' }, { label: 'Integration tips' }, { label: 'FAQ' }],
}

describe('localized reader navigation', () => {
  beforeEach(() => {
    mocks.hasDocTranslation.mockReset()
    mocks.hasDocTranslation.mockImplementation(async (slug: Array<string>) => slug.join('/') !== 'guides/routing')
  })

  it('keeps translated collection/previous links in the requested locale and falls back for missing translations', async () => {
    const result = await localizeDocNavigation(navigation, 'zh-Hans', 'en')
    expect(result.prev).toEqual({ title: 'Slippage', href: '/zh-Hans/guides/slippage' })
    expect(result.next).toEqual(navigation.next)
    expect(result.breadcrumb).toEqual([{ label: 'Guides', href: '/zh-Hans/guides/fees' }, ...navigation.breadcrumb.slice(1)])
    expect(navigation.prev?.href).toBe('/guides/slippage')
    expect(mocks.hasDocTranslation).toHaveBeenCalledWith(['guides', 'fees'], 'zh-Hans')
  })

  it('preserves primary-language navigation without looking up translations', async () => {
    expect(await localizeDocNavigation(navigation, 'fr', 'fr')).toBe(navigation)
    expect(mocks.hasDocTranslation).not.toHaveBeenCalled()
  })

  it('handles translated home links, URL suffixes, duplicate destinations, and external links', async () => {
    const result = await localizeDocNavigation({
      ...navigation,
      prev: { title: 'Home', href: '/?ref=guide#start' },
      next: null,
      breadcrumb: [{ label: 'Home', href: '/?ref=guide#start' }, { label: 'External', href: 'https://example.com' }],
    }, 'fr', 'en')
    expect(result.prev?.href).toBe('/fr?ref=guide#start')
    expect(result.next).toBeNull()
    expect(result.breadcrumb.map((item) => item.href)).toEqual(['/fr?ref=guide#start', 'https://example.com'])
    expect(mocks.hasDocTranslation).toHaveBeenCalledExactlyOnceWith([], 'fr')
  })

  it('accepts locale-prefixed navigation without adding the locale twice', async () => {
    const result = await localizeDocNavigation({
      ...navigation,
      prev: { title: 'Anterior', href: '/es/guides/slippage' },
      next: { title: 'Siguiente', href: '/es/guides/routing' },
      breadcrumb: [{ label: 'Documentación', href: '/es/guides/fees' }],
    }, 'es', 'en')
    expect(result.prev?.href).toBe('/es/guides/slippage')
    expect(result.next?.href).toBe('/guides/routing')
    expect(result.breadcrumb[0].href).toBe('/es/guides/fees')
  })
})
