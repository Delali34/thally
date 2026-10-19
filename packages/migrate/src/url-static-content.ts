/**
 * Preserve self-contained drawing assets and fully captured semantic tabs.
 * These projections prove their own source content; unknown or deferred UI
 * remains in the article so callers can require explicit review.
 */
import { createHash } from 'node:crypto'
import { load, type CheerioAPI } from 'cheerio'
import { isPassiveSvg } from './svg-policy.js'
import type { MigrationAsset } from './types.js'

type Selection = ReturnType<CheerioAPI>

/** An inert image projection and the exact independently validated bytes. */
export interface MigrationSvgProjection {
  asset: MigrationAsset
  alternative: string
}

/** Keep static SVG as an asset, never as executable inline MDX or a data URL. */
export function projectMigrationSvg(html: string): MigrationSvgProjection | null {
  const $ = load(html, { xmlMode: true }, false)
  const svg = $.root().children()
  if (svg.length !== 1 || !svg.is('svg')) return null
  // HTML SVG inherits its namespace. A standalone copied document must declare
  // it explicitly, while an authored foreign namespace still fails the policy.
  if (svg.attr('xmlns') === undefined) svg.attr('xmlns', 'http://www.w3.org/2000/svg')
  const content = Buffer.from($.xml(svg))
  if (!isPassiveSvg(content)) return null
  const sha256 = createHash('sha256').update(content).digest('hex')
  const labelled = (svg.attr('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
    .map(id => svg.find('[id]').filter((_index, node) => $(node).attr('id') === id).text().trim()).filter(Boolean)
  const alternative = svg.attr('aria-label')?.trim() || labelled.join(' ')
    || svg.children('title').text().trim() || svg.children('desc').text().trim()
    || svg.find('text').text().trim()
  return { asset: { path: `migration-assets/${sha256}.svg`, content }, alternative }
}

/** Decode only the provider's literal, bounded protected-email data contract. */
export function projectProtectedEmails($: CheerioAPI, root: Selection): void {
  root.find('[data-cfemail]').each((_index, node) => {
    const element = $(node)
    const anchor = element.is('a') ? element : element.closest('a')
    const href = anchor.attr('href') ?? ''
    if (!anchor.length || !/^\/cdn-cgi\/l\/email-protection(?:#[a-f\d]+)?$/i.test(href)) return
    const encoded = element.attr('data-cfemail') ?? ''
    if (!/^(?:[a-f\d]{2}){4,1024}$/i.test(encoded)) return
    const bytes = Buffer.from(encoded, 'hex')
    const payload = Uint8Array.from(bytes.subarray(1), byte => byte ^ bytes[0])
    let email: string
    try { email = new TextDecoder('utf-8', { fatal: true }).decode(payload) } catch { return }
    // The destination is an address only: controls, whitespace and mailto
    // query syntax must not turn encoded source data into message headers.
    if (!/^[^@\s<>?#[\]\u0000-\u001f\u007f]+@[^@\s<>?#[\]\u0000-\u001f\u007f]+\.[^@\s<>?#[\]\u0000-\u001f\u007f]+$/u.test(email)) return
    anchor.attr('href', `mailto:${email}`)
    if (/^\[email\s+protected\]$/i.test(element.text().trim())) element.text(email)
    element.removeAttr('data-cfemail')
  })
}

/** Nonempty content must be present now, including on the panel itself. */
export function hasCompleteCapturedPanel($: CheerioAPI, panel: Selection): boolean {
  const busy = '[aria-busy="true"],[role="progressbar"]'
  if (panel.is(busy) || panel.find(busy).length) return false
  const copy = panel.clone()
  copy.find('script,style,button,[role="tablist"]').remove()
  return Boolean(copy.text().trim() || copy.find('img[src],svg').length)
}

/** Expose an already loaded, uniquely owned native disclosure without its JS. */
export function projectCapturedDisclosures($: CheerioAPI, root: Selection): void {
  const ids = new Map<string, Selection>()
  root.find('[id]').each((_index, node) => {
    const id = $(node).attr('id')!
    ids.set(id, ids.has(id) ? ids.get(id)!.add(node) : $(node))
  })
  root.find('button[aria-expanded][aria-controls],summary[aria-expanded][aria-controls]').each((_index, node) => {
    const control = $(node)
    if (control.is('[role="tab"],[aria-haspopup],[aria-busy="true"]')) return
    const id = control.attr('id'), target = control.attr('aria-controls')
    const panel = target ? ids.get(target) : undefined
    const nativeSummary = control.is('summary') && control.parent().is('details')
    let owner = control.parent()
    if (owner.is('h1,h2,h3,h4,h5,h6')) owner = owner.parent()
    const labels = panel?.attr('aria-labelledby')?.trim().split(/\s+/)
    const ownedLabels = labels?.every(label => ids.get(label)?.length === 1
      && (label === id || (nativeSummary && control.find('[id]').toArray().some(element => $(element).attr('id') === label))))
    if ((!nativeSummary && !id) || (id && ids.get(id)?.length !== 1) || !panel || panel.length !== 1
      || (panel.attr('role') !== 'region' && !(nativeSummary && panel.is('[data-component-part="expandable-content"]')))
      || (labels && !ownedLabels)
      || !panel.parents().toArray().some(parent => parent === owner[0])
      || (nativeSummary && panel.parent()[0] !== owner[0])
      || !hasCompleteCapturedPanel($, panel)) return
    if (!nativeSummary) node.name = 'span'
    control.removeAttr('aria-expanded aria-controls role type')
    panel.removeAttr('hidden aria-hidden')
  })
}

/**
 * Mark exact, complete ARIA-linked tab groups for portable Tabs conversion.
 * Positional inference is restricted to existing publisher container markers;
 * unrelated controls cannot borrow a panel from another group or duplicate ID.
 */
export function projectCapturedTabs($: CheerioAPI, root: Selection): void {
  // Markers are internal evidence, never publisher-controlled declarations.
  root.find('[data-thally-static-tabs],[data-thally-static-tab]').removeAttr('data-thally-static-tabs data-thally-static-tab')
  const ids = new Map<string, Selection>()
  root.find('[id]').each((_index, node) => {
    const id = $(node).attr('id')!
    ids.set(id, ids.has(id) ? ids.get(id)!.add(node) : $(node))
  })
  const claimed = new Set<unknown>()
  const groups = root.find('[role="tablist"]').toArray()
  if (groups.length > 256 || root.find('[role="tab"]').length > 1_024) return
  for (const groupNode of groups.reverse()) {
    const group = $(groupNode)
    const tabs = group.find('[role="tab"]').toArray()
      .filter(node => $(node).closest('[role="tablist"]')[0] === groupNode)
    if (!tabs.length || group.is('[aria-busy="true"]')) continue
    // A custom picker may contain copy beyond its tab labels. Do not erase it.
    if (group.text().replace(/\s+/g, '') !== tabs.map(node => $(node).text()).join('').replace(/\s+/g, '')) continue
    let container: Selection = group.parent()
    const explicit = tabs.every(tab => Boolean($(tab).attr('aria-controls')))
    const panels: Array<Selection> = []
    if (explicit) {
      for (const tab of tabs) {
        const panel = ids.get($(tab).attr('aria-controls')!)
        const tabId = $(tab).attr('id')
        if (!panel || panel.length !== 1 || !panel.is('[role="tabpanel"]')
          || panel.find('[role="tablist"]').toArray().includes(groupNode)
          || (tabId && ids.get(tabId)?.length !== 1)
          || (panel.attr('aria-labelledby') !== undefined && panel.attr('aria-labelledby') !== tabId)) break
        panels.push(panel)
      }
      // Keep the smallest common owner. It may contain nested tab groups, but
      // no unrelated peer group may claim these same panels.
      for (let depth = 0; depth < 16 && container.length
        && panels.some(panel => !panel.parents().toArray().some(parent => parent === container[0])); depth += 1) container = container.parent()
      if (!container.length || !container.find('[role="tablist"]').toArray().includes(groupNode)) continue
    } else {
      if (tabs.some(tab => $(tab).attr('aria-controls'))) continue
      container = group.closest('.code-group,.tabs-container,.tabs.tab-container')
      if (!container.length) continue
      const owners = container.find('[role="tablist"]').toArray()
        .filter(node => $(node).closest('.code-group,.tabs-container,.tabs.tab-container')[0] === container[0])
      if (owners.length !== 1) continue
      panels.push(...container.find('[role="tabpanel"]').toArray()
        .filter(node => $(node).closest('.code-group,.tabs-container,.tabs.tab-container')[0] === container[0]).map(node => $(node)))
    }
    if (panels.length !== tabs.length || new Set(panels.map(panel => panel[0])).size !== panels.length
      || panels.some(panel => claimed.has(panel[0]) || !hasCompleteCapturedPanel($, panel))) continue
    // All of this group's direct panels must be assigned. Extra panels are
    // ambiguous alternatives rather than permission to discard their content.
    const unowned = container.find('[role="tabpanel"]').toArray().filter(node =>
      !panels.some(panel => panel[0] === node || $(node).parents().toArray().some(parent => parent === panel[0])))
    if (unowned.length) continue
    const residual = container.clone()
    residual.find('[role="tablist"],[role="tabpanel"]').remove()
    const hasSurroundingContent = Boolean(residual.text().trim()
      || residual.find('a[href],pre,img,svg,table,video,audio,iframe,form,input,textarea,select,object,embed,canvas,math').length)
    // A Tabs component consumes only its Tab children. When the common owner
    // also contains authored siblings, keep its exact document order and label
    // each panel in place instead of enclosing (and losing) that other content.
    if (!hasSurroundingContent) container.attr('data-thally-static-tabs', '')
    panels.forEach((panel, index) => {
      claimed.add(panel[0])
      const label = $(tabs[index]).text().trim() || `Tab ${index + 1}`
      if (hasSurroundingContent) panel.prepend($('<p></p>').append($('<strong></strong>').text(label)))
      else panel.attr('data-thally-static-tab', label)
      panel.removeAttr('role hidden aria-hidden aria-labelledby')
      const id = $(tabs[index]).attr('id')
      if (id) panel.prepend($('<span></span>').attr('id', id))
    })
    const groupId = group.attr('id')
    if (groupId) group.replaceWith($('<span></span>').attr('id', groupId))
    else group.remove()
  }
}
