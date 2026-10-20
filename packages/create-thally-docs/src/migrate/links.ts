/** Diagnose imported internal links against the destination's actual route inventory. */
import { literalRoute, migrationApiRoutes, pageEntryRoutes, type MigrationBundle } from '@thallylabs/migrate'

const machineRoutes = new Set(['/llms.txt', '/llms-full.txt', '/openapi.json', '/openapi.yaml', '/robots.txt', '/sitemap.xml', '/skill.md', '/AGENTS.md', '/auth.md'])

/** Keep unknown destinations visible for review without inventing endpoint routes. */
export function reportUnresolvedMigrationLinks(bundle: MigrationBundle): void {
  const routes = new Set([...bundle.pages.flatMap((page) => [...pageEntryRoutes(page), `/${page.navigationId}`, `/${page.id}.md`, `/api/docs/${page.id}`, `/api/markdown/${page.id}`]), ...migrationApiRoutes(bundle)].map((route) => literalRoute(route) ?? route))
  routes.add('/')
  for (const redirect of bundle.docsConfig.redirects ?? []) routes.add(literalRoute(redirect.source) ?? redirect.source)
  for (const asset of bundle.assets) if (!asset.projectRelative) routes.add(literalRoute(`/${asset.path}`) ?? `/${asset.path}`)
  for (const page of bundle.pages) {
    const unknown = new Set<string>()
    let fence: string | undefined
    for (const line of page.body.split('\n')) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
      if (marker) {
        if (!fence) fence = marker[1]
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = undefined
        continue
      }
      if (fence) continue
      const prose = line.replace(/`[^`]*`/g, '')
      for (const match of prose.matchAll(/(?:\]\(|\bhref=["'])(\/(?!\/)[^\s)"']+)/g)) {
        const target = match[1].split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/'
        if (!routes.has(literalRoute(target) ?? target) && !machineRoutes.has(target)) unknown.add(target)
      }
    }
    if (unknown.size) bundle.warnings.push({ code: 'unsupported-config', source: page.id, message: `Internal links have no imported destination and require review: ${[...unknown].slice(0, 20).join(', ')}${unknown.size > 20 ? `, and ${unknown.size - 20} more` : ''}.` })
  }
}
