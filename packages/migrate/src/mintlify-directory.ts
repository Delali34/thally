/**
 * Mintlify's group `directory`: the group's root page ends with its pages as
 * cards (`card` and `accordion` alike; Thally has no accordion list). Child
 * pages come first, in order, then each nested group: a group one level below
 * the root as a label followed by its own cards, a deeper group as one card
 * that gives its page count.
 */

import type { MintlifyDirectory, MintlifyDirectoryGroup, MintlifyDirectoryItem } from './navigation.js'
import { stripControlCharacters } from './source-refs.js'
import type { MigrationPage, MigrationWarning } from './types.js'

/** Written ahead of a root page's cards, so a page that already has them gets none again; groups sharing the root add theirs after it. */
export const MINTLIFY_DIRECTORY_MARKER = '{/* thally:directory */}'

const LISTED = 10

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** Text for a JSX attribute value or an element body: markup characters become entities, which MDX decodes. */
const markup = (value: string): string => oneLine(value)
  .replace(/[&<>{}]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '{': '&#123;', '}': '&#125;' })[char]!)

const attribute = (value: string): string => markup(value).replace(/"/g, '&quot;')

/** Text for an element body: also keeps Markdown from reading emphasis, code or links into it. */
const text = (value: string): string => markup(value).replace(/[\\`*_[\]~]/g, '\\$&')

/** A path as the target of a Markdown link. */
const linkTarget = (value: string): string => value
  .replace(/[()]/g, (char) => (char === '(' ? '%28' : '%29'))
  .replace(/[\s<>\\]/g, encodeURIComponent)

const href = (page: MigrationPage): string => (page.id === 'introduction' ? '/' : `/${page.id}`)

const cardGroup = (cards: Array<string>): string => `<CardGroup cols={1}>\n${cards.join('\n')}\n</CardGroup>`

function card(title: string, to: string | undefined, page: MigrationPage | undefined, body: string): string {
  const icon = page?.icon ? ` icon="${attribute(page.icon)}"${page.iconType ? ` iconType="${page.iconType}"` : ''}` : ''
  return `  <Card title="${attribute(title)}"${to ? ` href="${attribute(to)}"` : ''}${icon}${body ? `>${text(body)}</Card>` : ' />'}`
}

/** Add each directory's cards to its root page, once however often the pass runs; what cannot be listed is reported, never guessed at. */
export function appendMintlifyDirectories(
  pages: Array<MigrationPage>,
  directories: ReadonlyArray<MintlifyDirectory>,
  warnings: Array<MigrationWarning>,
): void {
  const byId = new Map(pages.map((page) => [`${page.locale ?? ''}\n${page.navigationId}`, page]))
  const warn = (message: string): void => { warnings.push({ code: 'unsupported-config', message }) }
  // Root pages this pass added cards to: a marker found on any other was left by an earlier pass, which listed every group sharing it.
  const written = new Set<MigrationPage>()
  for (const directory of directories) {
    const find = (id: string): MigrationPage | undefined => byId.get(`${directory.locale ?? ''}\n${id}`)
    const label = stripControlCharacters(directory.group)
    const root = find(directory.root)
    if (!root) {
      if (!directory.otherLanguage) {
        warn(`Group "${label}" sets directory, but its root page ${stripControlCharacters(directory.root)} was not migrated, so its page cards were not added. Check that the page exists and can be read.`)
      }
      continue
    }
    if (!written.has(root) && root.body.includes(MINTLIFY_DIRECTORY_MARKER)) continue
    if (directory.hidden) {
      warn(`Group "${label}" is hidden, so the page cards on its root page ${stripControlCharacters(directory.root)} were not added.`)
      continue
    }
    if (directory.operations) {
      warn(`Group "${label}" sets directory and lists ${directory.operations} API operation${directory.operations === 1 ? '' : 's'} (entries such as "GET /path"), which Thally does not show as cards: the cards on its root page ${href(root)} list pages only. Link to the operations from that page if they should be listed.`)
    }

    // A hidden or access-restricted page is never advertised to readers who cannot open it.
    const skipped = new Set<string>()
    const openPage = (id: string): MigrationPage | undefined => {
      const page = find(id)
      if (!page) return undefined // Not a migrated page: its own warning says why.
      if (page.hidden || page.public === false || page.groups?.length) {
        skipped.add(id)
        return undefined
      }
      return page
    }
    const skipGroup = (group: MintlifyDirectoryGroup): void => {
      for (const item of group.items) {
        if (typeof item !== 'string') skipGroup(item)
        else if (find(item)) skipped.add(item)
      }
    }
    const countPages = (group: MintlifyDirectoryGroup): number => group.items.reduce((count, item) => {
      if (typeof item === 'string') return count + (openPage(item) ? 1 : 0)
      if (item.hidden) { skipGroup(item); return count }
      return count + countPages(item)
    }, 0)
    const itemCard = (item: MintlifyDirectoryItem): Array<string> => {
      if (typeof item === 'string') {
        const page = openPage(item)
        return page ? [card(page.title, href(page), page, page.descriptionPlacement === 'body' ? '' : page.description)] : []
      }
      if (item.hidden) { skipGroup(item); return [] }
      const count = countPages(item)
      if (count === 0) return []
      const landing = item.root ? openPage(item.root) : undefined
      return [card(item.group, landing && href(landing), undefined, `${count} ${count === 1 ? 'page' : 'pages'}`)]
    }

    const blocks: Array<string> = []
    const direct = directory.items.flatMap((item) => (typeof item === 'string' ? itemCard(item) : []))
    if (direct.length > 0) blocks.push(cardGroup(direct))
    for (const item of directory.items) {
      if (typeof item === 'string') continue
      if (item.hidden) { skipGroup(item); continue }
      const landing = item.root ? openPage(item.root) : undefined
      const cards = item.items.flatMap(itemCard)
      if (cards.length === 0) continue
      blocks.push(landing ? `**[${text(item.group)}](${linkTarget(href(landing))})**` : `**${text(item.group)}**`, cardGroup(cards))
    }

    const cards = blocks.join('\n\n')
    // The same group listed again (a page in two versions, say) adds nothing.
    if (blocks.length > 0 && root.body.includes(cards)) continue
    if (blocks.length > 0) {
      const body = root.body.trimEnd()
      const marker = root.body.includes(MINTLIFY_DIRECTORY_MARKER) ? '' : `${MINTLIFY_DIRECTORY_MARKER}\n\n`
      root.body = `${body}${body ? '\n\n' : ''}${marker}${cards}\n`
      written.add(root)
      if (directory.mode === 'accordion') {
        warn(`Group "${label}" sets directory to accordion, which Thally does not have. Its pages are listed as cards on ${href(root)} instead.`)
      }
    }
    if (skipped.size > 0) {
      const names = [...skipped].map(stripControlCharacters)
      warn(`Group "${label}" sets directory; the cards on ${href(root)} leave out ${names.length} hidden or access-restricted page${names.length === 1 ? '' : 's'} so readers are not shown links to pages they cannot open: ${names.slice(0, LISTED).join(', ')}${names.length > LISTED ? ', ...' : ''}. Remove hidden or restricted from those pages if they should be listed.`)
    }
  }
}
