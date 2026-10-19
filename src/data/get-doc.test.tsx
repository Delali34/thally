/** Document identity must remain independent of author-controlled display titles. */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { compileMDX } from 'next-mdx-remote/rsc'
import { describe, expect, it, vi } from 'vitest'
import { getDocFromParams } from './get-doc'
import { interpretMDX } from '@/lib/mdx-interpret'
import { EditOnGithub } from '@/components/docs/edit-on-github'
import { ReportAnIssue } from '@/components/docs/report-an-issue'

const contentSourceState = vi.hoisted(() => ({ kind: 'filesystem' as 'filesystem' | 'assets' }))

vi.mock('@/data/docs', () => ({
  deriveTitleFromSlug: (slug: string) => slug,
  getI18nConfig: () => ({ defaultLocale: 'en' }),
}))
vi.mock('next-mdx-remote/rsc', () => ({ compileMDX: vi.fn() }))
vi.mock('@/lib/mdx-interpret', () => ({ interpretMDX: vi.fn() }))
vi.mock('@/mdx/remark', () => ({ remarkPlugins: [] }))
vi.mock('@/mdx/rehype', () => ({ rehypePlugins: [] }))
vi.mock('@/components/mdx/mdx-components', () => ({ useMDXComponents: () => ({}) }))
vi.mock('@/mdx/snippet-registry', () => ({ resolveSnippetComponent: vi.fn() }))
vi.mock('@/lib/runtime-sources', () => ({
  runtimeSourceExists: () => true,
  readRuntimeSource: () => '# Content',
}))
vi.mock('@/lib/content-source', () => ({
  getContentSource: () => ({
    kind: contentSourceState.kind,
    exists: async (path: string) => ['src/content/introduction.mdx', 'src/content/events.mdx', 'src/content/endpoint.mdx', 'src/content/inline-component.mdx', 'src/content/remote-inline.mdx'].includes(path),
    read: async (path: string) => ({ content: path === 'src/content/inline-component.mdx'
      ? '---\ntitle: Inline component\n---\n\nexport const HeroCard = ({ title }) => <div>{title}</div>\n\n<HeroCard title={`Preview ${1 + 1}`} />'
      : '# Content' }),
  }),
}))
vi.mock('@/generated/runtime-docs', () => ({
  runtimeDocs: {
    'src/content/introduction.mdx': {
      component: () => null,
      frontmatter: { title: 'Product documentation', headingTitle: 'Display heading' },
    },
    'src/content/events.mdx': {
      component: () => null,
      frontmatter: { title: 'Event delivery' },
    },
    'src/content/endpoint.mdx': {
      component: () => null,
      frontmatter: { title: 'Create a key', description: 'Short metadata summary.', descriptionPlacement: 'operation' },
    },
  },
}))

describe('document source identity', () => {
  it('preserves an operation description placement from compiled frontmatter', async () => {
    expect(await getDocFromParams(['endpoint'])).toMatchObject({ description: 'Short metadata summary.', descriptionPlacement: 'operation' })
  })
  it('preserves a display heading from compiled metadata without changing the SEO title', async () => {
    const doc = await getDocFromParams([])
    expect(doc).toMatchObject({ title: 'Product documentation', headingTitle: 'Display heading' })
  })

  it.each([{ slug: undefined }, { slug: [] }])('uses introduction for the root route $slug', async ({ slug }) => {
    const doc = await getDocFromParams(slug)
    expect(doc).toMatchObject({ id: 'introduction', title: 'Product documentation', href: '/', slug: [] })
    const html = renderToStaticMarkup(createElement(EditOnGithub, {
      pageId: doc!.id,
      repoUrl: 'https://github.com/example/docs',
    }))
    expect(html).toContain('href="https://github.com/example/docs/edit/main/src/content/introduction.mdx"')

    const issueHtml = renderToStaticMarkup(createElement(ReportAnIssue, {
      pagePath: doc!.href,
      repoUrl: 'https://github.com/example/docs',
    }))
    expect(issueHtml).toContain('href="https://github.com/example/docs/issues/new?title=Docs%20feedback%3A%20%2F"')
  })

  it('keeps non-root identity separate from the display title', async () => {
    const doc = await getDocFromParams(['events'])
    expect(doc).toMatchObject({ id: 'events', title: 'Event delivery', href: '/events', slug: ['events'] })
  })

  it('renders authored MDX exports and expressions in development', async () => {
    const realMdx = await vi.importActual<typeof import('next-mdx-remote/rsc')>('next-mdx-remote/rsc')
    vi.mocked(compileMDX).mockImplementation(realMdx.compileMDX)
    vi.stubEnv('NODE_ENV', 'development')
    try {
      const doc = await getDocFromParams(['inline-component'])
      expect(renderToStaticMarkup(createElement(doc!.component))).toContain('<div>Preview 2</div>')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps remote MDX eval-free even in development', async () => {
    contentSourceState.kind = 'assets'
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(compileMDX).mockClear()
    vi.mocked(interpretMDX).mockResolvedValue({ content: null, frontmatter: { title: 'Remote page' } })
    try {
      const doc = await getDocFromParams(['remote-inline'])
      expect(doc?.title).toBe('Remote page')
      expect(interpretMDX).toHaveBeenCalledOnce()
      expect(compileMDX).not.toHaveBeenCalled()
    } finally {
      contentSourceState.kind = 'filesystem'
      vi.unstubAllEnvs()
    }
  })
})
