/**
 * Runtime checks for the quiet, content-first documentation chrome.
 *
 * These assertions protect the visual invariants that are easy to regress
 * when brand colors or navigation treatments change: cards keep neutral
 * icons, and the desktop sidebar remains rail-free without losing a visible
 * current-page state.
 */

import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  usePathname: () => '/guides/quickstart',
  useRouter: () => ({ prefetch: vi.fn() }),
}))

import { Card, Tile } from '@/components/mdx/rich-content'
import { AgentPrompt } from '@/components/mdx/agent-prompt'
import { DocHeader } from '@/components/docs/doc-header'
import { Footer } from '@/components/layout/footer'
import { Sidebar } from '@/components/navigation/sidebar'
import type { DocEntry } from '@/data/docs'

describe('documentation visual system', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the default mark square without constraining custom wordmarks', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile('src/styles/docs-handoff.css', 'utf8')
    expect(css).toContain('.thally-docs-brand img:not([data-custom-logo])')
    expect(css).not.toMatch(/\.thally-docs-brand (?:img|svg)\s*[,\{]/)
  })

  it('offsets every in-content anchor target below the sticky header', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile('src/styles/docs-handoff.css', 'utf8')
    expect(css).toMatch(/\.thally-docs-prose \[id\] \{\s*scroll-margin-top: 6rem;/)
    expect(css).toMatch(/:is\(\[data-heading\], \.scroll-mt-24, \.thally-docs-prose \[id\]\)/)
  })

  it('brands only the active collection underline, not its neutral label', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile('src/styles/docs-handoff.css', 'utf8')
    const rule = css.match(/\.thally-docs-tabs \.thally-nav-tab-item\[aria-current='page'\] \{([^}]+)\}/)?.[1]
    expect(rule).toContain('border-bottom-color: var(--docs-accent)')
    expect(rule).not.toMatch(/(?:^|[;\n])\s*color\s*:/)
  })

  it('brands the active page-outline label and indicator with the live theme accent', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile('src/styles/docs-handoff.css', 'utf8')
    const rule = css.match(/\.thally-docs-toc a\[aria-current='location'\][^{]*\{([^}]+)\}/)?.[1]
    expect(rule).toContain('color: var(--docs-accent)')
    expect(rule).toContain('border-inline-start-color: var(--docs-accent)')
    expect(css).toContain('--docs-accent: hsl(var(--thally-accent))')
  })

  it.each([
    ['card', Card],
    ['tile', Tile],
  ])('keeps %s icons token-driven while preserving border-only surfaces', (_, Component) => {
    const markup = renderToStaticMarkup(
      createElement(
        Component,
        { title: 'Quickstart', icon: 'book-open' },
        createElement('p', null, 'Publish the first useful page.'),
      ),
    )

    expect(markup).toContain('thally-content-icon')
    expect(markup).toContain('data-content-icon-tone="site"')
    expect(markup).toContain('border border-border')
    expect(markup).toContain('hover:border-accent')
    expect(markup).not.toContain('hover:bg-')
    expect(markup).not.toContain('shadow-')
  })

  it.each([
    ['card', Card],
    ['tile', Tile],
  ])('lets %s icons inherit the live brand accent', (_, Component) => {
    const markup = renderToStaticMarkup(
      createElement(Component, { title: 'Quickstart', icon: 'book-open', iconColor: 'accent' }),
    )

    expect(markup).toContain('data-content-icon-tone="accent"')
    expect(markup).toContain('data-card-tone="accent"')
  })

  it.each([
    ['card', Card],
    ['tile', Tile],
  ])('tags the %s surface with the resolved tone for accent-aware chrome', (_, Component) => {
    const site = renderToStaticMarkup(createElement(Component, { title: 'A', icon: 'book-open' }))
    const neutral = renderToStaticMarkup(
      createElement(Component, { title: 'A', icon: 'book-open', iconColor: 'neutral' }),
    )

    expect(site).toContain('data-card-tone="site"')
    expect(neutral).toContain('data-card-tone="neutral"')
  })

  it('derives accent card chrome from the live accent token, never a fixed color', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile('src/styles/docs-handoff.css', 'utf8')

    // Site-wide accent opt-in and per-card override both restyle the border.
    expect(css).toContain("[data-content-icons='accent'] .thally-docs-card[data-card-tone='site']")
    expect(css).toContain(".thally-docs-card[data-card-tone='accent']")
    // Neutral opt-out restores the quiet chrome on accent sites.
    expect(css).toContain(".thally-docs-card[data-card-tone='neutral']")

    // The treatment must flow through the theme token so owner accent changes
    // (and Cloud branding) apply — a hardcoded color would freeze the default
    // green and break locale/theme consistency guarantees.
    const cardChrome = css.slice(css.indexOf("[data-content-icons='accent'] .thally-docs-card"))
    const firstBlock = cardChrome.slice(0, cardChrome.indexOf('.thally-docs-card-body'))
    expect(firstBlock).toContain('hsl(var(--thally-accent)')
    expect(firstBlock).not.toContain('background-color')
    expect(firstBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('selects the icon library mask from the html attribute the layout stamps', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile('src/styles/docs-handoff.css', 'utf8')

    expect(css).toContain("html[data-icon-library='fontawesome'] .thally-icon {")
    expect(css).toContain("html[data-icon-library='tabler'] .thally-icon {")
    expect(css).toContain('--thally-icon-mask: var(--thally-icon-lucide)')
    // Bundled Lucide glyphs hide only when another library is active.
    expect(css).toContain("html[data-icon-library='fontawesome'] .thally-icon[data-icon-source='lucide'] > .thally-icon-glyph")
  })

  it('renders the category eyebrow above the page title', () => {
    const doc = {
      id: 'guides/writing-content',
      title: 'Write great content',
      description: 'How to structure pages.',
      href: '/guides/writing-content',
    } as DocEntry

    const markup = renderToStaticMarkup(createElement(DocHeader, { doc, eyebrow: 'Create content' }))

    expect(markup).toContain('thally-docs-eyebrow')
    // The eyebrow precedes the H1 so it reads as a category label, not a crumb.
    expect(markup.indexOf('Create content')).toBeLessThan(markup.indexOf('Write great content'))

    const withoutEyebrow = renderToStaticMarkup(createElement(DocHeader, { doc }))
    expect(withoutEyebrow).not.toContain('thally-docs-eyebrow')
  })

  it('stacks the copy action under the title on small screens', () => {
    const doc = { id: 'a', title: 'Single Sign-On', description: 'd', href: '/a' } as DocEntry
    const markup = renderToStaticMarkup(createElement(DocHeader, { doc }))
    expect(markup).toContain('flex-col')
    expect(markup).toContain('sm:flex-row')
    expect(markup).not.toMatch(/class="flex items-start justify-between/)
  })

  it('can remove the copy action without removing the document header', () => {
    const doc = {
      id: 'guides/writing-content',
      title: 'Write great content',
      description: 'How to structure pages.',
      href: '/guides/writing-content',
    } as DocEntry

    const markup = renderToStaticMarkup(
      createElement(DocHeader, { doc, showCopyPage: false }),
    )

    expect(markup).toContain(doc.title)
    expect(markup).not.toContain('Copy page')
  })

  it('renders the eyebrow as semibold sentence case, never uppercase', () => {
    const doc = {
      id: 'guides/writing-content',
      title: 'Write great content',
      description: 'How to structure pages.',
      href: '/guides/writing-content',
    } as DocEntry

    const markup = renderToStaticMarkup(
      createElement(DocHeader, { doc, eyebrow: 'Design your docs' }),
    )

    expect(markup).toContain('font-semibold')
    expect(markup).not.toContain('uppercase')
  })

  it('keeps agent prompts as two-line callouts with a secondary copy action', () => {
    const props: ComponentProps<typeof AgentPrompt> = {
      title: 'Copy a complete prompt to write a page',
      children: createElement('p', null, 'Write one task-focused page.'),
    }
    const markup = renderToStaticMarkup(
      createElement(AgentPrompt, props),
    )

    expect(markup).toContain('Prefer to let an agent do it?')
    expect(markup).toContain('Copy a complete prompt to write a page')
    expect(markup).toContain('border border-input bg-background')
    expect(markup).not.toContain('bg-primary')
  })

  it('omits repeated collection headings beneath tabs while preserving groups and links', () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        title: 'Get started',
        sections: [
          {
            title: 'Get started',
            items: [{ id: 'introduction', title: 'Introduction', href: '/' }],
          },
          {
            title: 'Design your docs',
            items: [{ id: 'components', title: 'Components', href: '/components' }],
          },
        ],
      }),
    )

    // The header tab supplies the collection label; the sidebar starts at its links.
    expect(markup).not.toContain('Get started')
    expect(markup).toContain('Design your docs')
    expect(markup).toContain('href="/"')
    expect(markup).toContain('href="/components"')
  })

  it('keeps a group heading named after its collection when the site asks for every heading', () => {
    const sections = [
      { id: 'nav-root-get-started', title: 'Get started', items: [{ id: 'welcome', title: 'Welcome', href: '/welcome' }] },
      { id: 'nav-group-0-get-started', title: 'Get started', items: [{ id: 'introduction', title: 'Introduction', href: '/' }] },
      { id: 'nav-group-1-design', title: 'Design your docs', items: [{ id: 'components', title: 'Components', href: '/components' }] },
    ]
    const render = (navigationPresentation?: ComponentProps<typeof Sidebar>['navigationPresentation']) =>
      renderToStaticMarkup(createElement(Sidebar, { title: 'Get started', sections, navigationPresentation }))
    const headings = (markup: string) => [...markup.matchAll(/<p class="[^"]*font-semibold leading-6[^"]*">(?:<svg.*?<\/svg>)?<span>([^<]+)<\/span><\/p>/g)].map((match) => match[1])

    // By default every section named after the collection loses its heading.
    expect(headings(render())).toEqual(['Design your docs'])
    expect(headings(render({ display: 'dropdown' }))).toEqual(['Design your docs'])
    // `groupHeadings: all` restores the authored group's heading, but never the collection's own root section.
    expect(headings(render({ display: 'dropdown', groupHeadings: 'all' }))).toEqual(['Get started', 'Design your docs'])
    expect(render({ display: 'tabs', groupHeadings: 'all' })).toContain('href="/welcome"')
  })

  it('renders a rail-free sidebar with a visible current-page state', () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        title: 'Guides',
        sections: [
          {
            title: 'Getting started',
            items: [
              { id: 'quickstart', title: 'Quickstart', href: '/guides/quickstart' },
              { id: 'configuration', title: 'Configuration', href: '/guides/configuration' },
            ],
          },
        ],
      }),
    )

    expect(markup).not.toContain('border-r')
    expect(markup).not.toContain('thally-sidebar-indicator')
    expect(markup).not.toContain('bg-border')
    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('bg-accent/10')
    expect(markup).toContain('text-accent')
    expect(markup).toContain('text-sm')
  })

  it('renders nested groups recursively instead of flattening duplicate headings', () => {
    const triggering = { id: 'triggering', title: 'Triggering', href: '/triggering' }
    const overview = { id: 'tasks-overview', title: 'Overview', href: '/tasks/overview' }
    const runs = { id: 'runs', title: 'Runs', href: '/runs' }
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        title: 'Documentation',
        sections: [{
          id: 'fundamentals',
          title: 'Fundamentals',
          items: [triggering, overview, runs],
          nodes: [
            { type: 'page', item: triggering },
            {
              type: 'group',
              group: {
                id: 'fundamentals-tasks',
                title: 'Tasks',
                nodes: [{ type: 'page', item: overview }],
              },
            },
            { type: 'page', item: runs },
          ],
        }],
      }),
    )

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('Tasks')
    expect(markup).not.toContain('Fundamentals • Tasks')
    expect(markup.indexOf('Triggering')).toBeLessThan(markup.indexOf('Tasks'))
    expect(markup.indexOf('Tasks')).toBeLessThan(markup.indexOf('Runs'))
  })

  it('can suppress authored group icons without removing group headings', () => {
    const sections = [{
      id: 'guides',
      title: 'Guides',
      icon: 'book-open',
      items: [{ id: 'quickstart', title: 'Quickstart', href: '/guides/quickstart' }],
      nodes: [{
        type: 'group' as const,
        group: {
          id: 'tools',
          title: 'Developer tools',
          icon: 'code',
          nodes: [{
            type: 'page' as const,
            item: { id: 'quickstart', title: 'Quickstart', href: '/guides/quickstart' },
          }],
        },
      }],
    }]
    const withIcons = renderToStaticMarkup(
      createElement(Sidebar, { title: 'Documentation', sections }),
    )
    const withoutIcons = renderToStaticMarkup(
      createElement(Sidebar, {
        title: 'Documentation',
        sections,
        showGroupIcons: false,
      }),
    )

    expect(withIcons).toContain('data-icon-name="book-open"')
    expect(withIcons).toContain('data-icon-name="code"')
    expect(withoutIcons).not.toContain('data-icon-name="book-open"')
    expect(withoutIcons).not.toContain('data-icon-name="code"')
    expect(withoutIcons).toContain('Developer tools')
  })

  it('renders source dropdown metadata as a sidebar collection selector', () => {
    const sections = [{
      id: 'start',
      title: 'Getting started',
      items: [{ id: 'introduction', title: 'Introduction', href: '/' }],
    }]
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        title: 'Documentation',
        sections,
        collections: [
          {
            id: 'documentation',
            label: 'Documentation',
            description: 'Resources for developers',
            icon: 'book-open',
            sections,
          },
          {
            id: 'api-reference',
            label: 'API reference',
            description: 'The product API',
            icon: 'code',
            sections: [{
              id: 'api',
              title: 'API reference',
              items: [{ id: 'api-overview', title: 'Overview', href: '/api/overview' }],
            }],
          },
        ],
        activeCollectionId: 'documentation',
        onCollectionChange: vi.fn(),
        navigationPresentation: { display: 'dropdown' },
      }),
    )

    expect(markup).toContain('thally-collection-selector')
    expect(markup).toContain('Resources for developers')
    expect(markup).toContain('href="/api/overview"')
  })

  it('keeps a readable sidebar title when a dropdown has only one collection', () => {
    const sections = [{
      id: 'start',
      title: 'Getting started',
      items: [{ id: 'introduction', title: 'Introduction', href: '/' }],
    }]
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        title: 'Documentation',
        sections,
        collections: [{ id: 'documentation', label: 'Documentation', sections }],
        activeCollectionId: 'documentation',
        onCollectionChange: vi.fn(),
        navigationPresentation: { display: 'dropdown' },
      }),
    )

    expect(markup).not.toContain('thally-collection-selector')
    expect(markup).toContain('Documentation')
  })

  it('keeps the standard navbar spacious and reserves compaction for dense navigation', async () => {
    const { readFile } = await import('node:fs/promises')
    const [topBar, css, layout, shell, sidebar] = await Promise.all([
      readFile('src/components/layout/top-bar.tsx', 'utf8'),
      readFile('src/styles/docs-handoff.css', 'utf8'),
      readFile('src/config/layout.ts', 'utf8'),
      readFile('src/components/layout/site-shell.tsx', 'utf8'),
      readFile('src/components/navigation/sidebar.tsx', 'utf8'),
    ])

    expect(topBar).toContain("data-density={isCrowded ? 'compact' : 'comfortable'}")
    expect(topBar).not.toContain('data-navigation-mode')
    expect(topBar).not.toContain('isNavigationCompact')
    expect(topBar).toContain("className={cn('thally-docs-topbar-inner flex h-[60px]")
    expect(topBar).toContain('thally-docs-primary inline-flex h-9 shrink-0')
    expect(css).toMatch(/\.thally-docs-search \{\s*width: 230px;/)
    expect(css).toContain("[data-density='compact'] .thally-docs-search")
    expect(css).toContain('padding-inline: 12px 44px')
    expect(css).toMatch(
      /\.thally-docs-search > button:first-of-type kbd \{[\s\S]*?position: absolute;[\s\S]*?inset-inline-end: 4px;/,
    )
    expect(css).toMatch(
      /@media \(max-width: 880px\) \{[\s\S]*?\.thally-docs-topbar-inner > button\[aria-haspopup='dialog'\][\s\S]*?display: inline-flex;/,
    )
    expect(css).not.toContain("[data-navigation-mode='compact']")
    expect(css).toMatch(
      /@media \(max-width: 880px\) \{[\s\S]*?\.thally-docs-brand > span:last-child[\s\S]*?\.thally-docs-search,[\s\S]*?width: 36px;/,
    )
    expect(css).toMatch(
      /\.thally-callout-content > :not\(\.thally-callout-title\):last-child \{\s*margin-bottom: 0;/,
    )
    expect(layout).toContain("topbarHeight: 'h-[60px]'")
    expect(shell).toContain('calc(100dvh-var(--docs-header-height,60px))')
    expect(sidebar).toContain('sticky top-[var(--docs-header-height,60px)]')
    expect(css).toContain('--docs-header-height: 60px')
    expect(css).toMatch(/@media \(min-width: 881px\) \{\s*\.thally-docs-root\[data-header-layout='stacked'\] \{\s*--docs-header-height: 104px;/)
    expect(css).not.toContain(".thally-docs-root[data-navigation='tabs']")
    expect(css).toMatch(/@media \(max-width: 880px\) \{[\s\S]*?\.thally-docs-collection-row \{\s*display: none;/)
    expect(css).not.toContain('thally-docs-inline-collections')
    expect(css).toContain('scroll-margin-top: calc(var(--docs-header-height, 104px) + 24px)')
    expect(css).toMatch(/\.thally-docs-tabs \.thally-nav-tab-item \{[^}]*flex: 0 0 auto;[^}]*min-width: 0;[^}]*max-width: 100%;/)
    expect(css).toMatch(/\.thally-docs-tabs \.thally-nav-tab-item \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/)
    expect(css).toContain('calc(280px / var(--collection-count))')
    expect(css).toMatch(/\.thally-docs-topbar-inner,\s*\.thally-docs-collection-row \{[^}]*max-width: 1280px;[^}]*padding-inline: 28px;/)
    expect(css).not.toMatch(/\.thally-docs-collection-row \{[^}]*max-width: none;/)
    expect(css).toMatch(/\.thally-docs-tabs \{[^}]*font-size: 0.875rem;/)
    expect(css).toMatch(/\.thally-docs-tabs \{[^}]*flex-wrap: wrap;/)
    expect(css).not.toMatch(/\.thally-docs-tabs \{[^}]*overflow-x:/)
    expect(css).toMatch(/\.thally-docs-tabs \.thally-nav-tab-item \{[^}]*min-height: 44px;/)
  })

  it('moves legacy navbar GitHub destinations into the footer', async () => {
    const { readFile } = await import('node:fs/promises')
    const topBar = await readFile('src/components/layout/top-bar.tsx', 'utf8')
    expect(topBar).toContain("filter((link) => link.type !== 'github')")

    const markup = renderToStaticMarkup(createElement(Footer, {
      footerConfig: null,
      githubHref: 'https://github.com/example/docs',
      siteName: 'Example',
      siteLinks: [{ label: 'Support', href: '/support' }],
    }))

    expect(markup).toContain('href="https://github.com/example/docs"')
    expect(markup).toContain('href="/support"')
  })

  it('docks chat below the top bar with the fixed Thally identity', async () => {
    const { readFile } = await import('node:fs/promises')
    const [chat, provider, statusRoute] = await Promise.all([
      readFile('src/components/docs/docs-chat.tsx', 'utf8'),
      readFile('src/components/docs/code-actions-provider.tsx', 'utf8'),
      readFile('src/app/api/chat-status/route.ts', 'utf8'),
    ])

    expect(chat).not.toContain('thally-docs-chat-scrim')
    expect(chat).toContain('top-[var(--docs-header-height,60px)]')
    expect(chat).not.toContain('top-[60px]')
    expect(provider).toContain('<div className="contents" data-docs-layout>')
    expect(chat).toContain("event.key === 'Escape'")
    expect(chat).toContain('/brand/default-favicon-light.svg')
    expect(chat).toContain("width: expanded ? 'min(680px, 100vw)' : 'min(420px, 100vw)'")
    expect(chat).not.toContain('<FabIcon')
    expect(provider).toContain('icon={chatStatus.icon ?? icon}')
    expect(statusRoute).toContain("/^\\/[A-Za-z0-9._/-]+$/")
    expect(statusRoute).toContain('{ show, label, disclaimer, icon, suggestions }')
  })

  it('never ships a fixed list of assistant suggestions', async () => {
    const { readFile } = await import('node:fs/promises')
    const [chat, provider, statusRoute, css] = await Promise.all([
      readFile('src/components/docs/docs-chat.tsx', 'utf8'),
      readFile('src/components/docs/code-actions-provider.tsx', 'utf8'),
      readFile('src/app/api/chat-status/route.ts', 'utf8'),
      readFile('src/styles/docs-handoff.css', 'utf8'),
    ])

    // Opening questions come from the site's navigation and follow-ups from
    // the conversation; product-specific copy must not be compiled in.
    expect(chat).not.toContain('How does navigation work?')
    expect(chat).not.toContain('How do I add an API reference?')
    expect(statusRoute).toContain('deriveStarterSuggestions')
    expect(provider).toContain('starterSuggestions={chatStatus.suggestions}')
    expect(chat).toContain('AI_FOLLOW_UPS_HEADER')
    expect(chat).toContain('deriveFollowUpSuggestions')
    // Focus is a soft halo on the composer, not a saturated accent outline.
    const composerFocus = css.slice(css.indexOf('.thally-docs-chat-composer:focus-within'))
    expect(composerFocus.slice(0, composerFocus.indexOf('}'))).toContain('color-mix')
  })
})

describe('Card title cascade', () => {
  // The prose heading rule styles every h2; a Card title (an h2 inside the prose) must out-rank it.
  const specificity = async (selector: string): Promise<number> => {
    const { default: parser } = await import('postcss-selector-parser')
    let score = 0
    parser((root) => {
      root.walk((node) => {
        if (node.type === 'class' || node.type === 'attribute') score += 10
        if (node.type === 'tag') score += 1
        if (node.type === 'pseudo' && node.value === ':where') node.empty()
      })
    }).processSync(selector)
    return score
  }

  it('out-ranks the prose h2 rule and sets the card size and margins', async () => {
    const { readFile } = await import('node:fs/promises')
    const { default: postcss } = await import('postcss')
    const root = postcss.parse(await readFile('src/styles/docs-handoff.css', 'utf8'))
    const rules = new Map<string, Map<string, string>>()
    root.walkRules((rule) => {
      const declarations = new Map<string, string>()
      rule.walkDecls((decl) => { declarations.set(decl.prop, decl.value) })
      for (const selector of rule.selectors) rules.set(selector.trim().replace(/\s+/g, ' '), declarations)
    })
    const prose = '.thally-docs-prose :where(h2)'
    const title = '.thally-docs-prose .thally-docs-card-title'
    expect(rules.has(prose)).toBe(true)
    expect(await specificity(title)).toBeGreaterThan(await specificity(prose))
    expect(rules.get(title)?.get('font-size')).toBe('1rem')
    expect(rules.get(title)?.get('line-height')).toBe('1.5rem')
    expect(rules.get(title)?.get('margin-block')).toBe('0')
    // The stacked-icon gap comes from an attribute rule, which also out-ranks the prose margin.
    expect(await specificity(`${title}[data-icon-stacked]`)).toBeGreaterThan(await specificity(prose))
    expect(rules.get(`${title}[data-icon-stacked]`)?.get('margin-top')).toBe('1rem')
  })

  it('renders a stacked icon card title without heading ids, anchors or TOC markers', () => {
    const html = renderToStaticMarkup(createElement(Card, { title: 'Scrape', icon: 'flame', href: '/scrape' }, 'Body'))
    const title = html.match(/<h2[^>]*>/)?.[0] ?? ''
    expect(title).toContain('thally-docs-card-title')
    expect(title).toContain('data-icon-stacked')
    expect(title).not.toMatch(/\bid=|data-heading/)
  })
})
