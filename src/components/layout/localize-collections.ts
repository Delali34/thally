/** Locale-prefixed navigation links for the server-rendered sidebar of a translated route. */

import type { NavigationItem, NavigationNode, NavigationSection, SidebarCollection } from '@/data/docs'

function localizeHref(href: string, locale: string): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href
  return href === '/' ? `/${locale}` : `/${locale}${href}`
}

function localizeItem(item: NavigationItem, locale: string): NavigationItem {
  return { ...item, href: localizeHref(item.href, locale), ...(item.redirectTo ? { redirectTo: localizeHref(item.redirectTo, locale) } : {}) }
}

function localizeNode(node: NavigationNode, locale: string): NavigationNode {
  return node.type === 'page'
    ? { ...node, item: localizeItem(node.item, locale) }
    : { ...node, group: { ...node.group, nodes: node.group.nodes.map((child) => localizeNode(child, locale)) } }
}

function localizeSection(section: NavigationSection, locale: string): NavigationSection {
  return {
    ...section,
    items: section.items.map((item) => localizeItem(item, locale)),
    ...(section.nodes ? { nodes: section.nodes.map((node) => localizeNode(node, locale)) } : {}),
  }
}

/**
 * The shell renders before the page that knows its locale installs the translated tree,
 * so server HTML would otherwise link out of the locale. Prefixing the default tree keeps
 * those links inside it; the translated labels replace them once the snapshot hydrates.
 */
export function localizeCollectionHrefs(collections: Array<SidebarCollection>, locale: string): Array<SidebarCollection> {
  return collections.map((collection) => {
    // Mirrors LocalizedSidebarHydrator: source-owned API collection destinations stay as authored.
    const keepsHref = collection.api && collection.api.navigation !== false
    return {
      ...collection,
      ...(collection.href && !keepsHref ? { href: localizeHref(collection.href, locale) } : {}),
      sections: collection.sections.map((section) => localizeSection(section, locale)),
    }
  })
}
