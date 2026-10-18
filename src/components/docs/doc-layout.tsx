/** Documentation page shell and its configurable reader feedback surfaces. */

import type { DocEntry, NavContext } from '@/data/docs'
import { getBreadcrumbs, getBreadcrumbsEnabled, getEyebrowMode, getNavCategory, getNavGroupPath, getPrevNextLinks, getFeedbackConfig } from '@/data/docs'
import { DocBreadcrumbs } from '@/components/docs/doc-breadcrumbs'
import { DocHeader } from '@/components/docs/doc-header'
import { DocPagination } from '@/components/docs/doc-pagination'
import { EditOnGithub } from '@/components/docs/edit-on-github'
import { Feedback } from '@/components/docs/feedback'
import { ReportAnIssue } from '@/components/docs/report-an-issue'
import { TableOfContents } from '@/components/docs/table-of-contents'
import { ContentStack, DetailColumn, MainColumns } from '@/components/layout/sections'
import { Prose } from '@/components/mdx/prose'
import { getManagedSiteConfigSnapshot } from '@/lib/cloud-link/client'
import { getBuildContentControls } from '@/lib/cloud-link/content-controls'
import { resolveBuildSiteConfig } from '@/lib/site-config'
import { localeDirection } from '@/lib/i18n/config'
import { InlineUpdateFilters, PagePanelSlot, PageSlotsProvider } from '@/components/mdx/page-slots'

interface DocLayoutProps {
  doc: DocEntry
  locale?: string
  navigation?: Pick<NavContext, 'prev' | 'next' | 'breadcrumb' | 'group' | 'groupPath'>
  children: React.ReactNode
}

function DocLayoutContent({ doc, locale = 'en', navigation, children }: DocLayoutProps) {
  const { prev, next, breadcrumb: breadcrumbs } = navigation ?? {
    ...getPrevNextLinks(doc.href),
    breadcrumb: getBreadcrumbs(doc.href),
  }
  const eyebrow = getEyebrowMode() === 'path'
    ? (navigation ? navigation.groupPath : getNavGroupPath(doc.href))
    : (navigation ? navigation.group : getNavCategory(doc.href))
  const mode = doc.mode ?? 'default'
  const feedbackConfig = getFeedbackConfig()
  // Managed releases already carry an immutable, release-scoped settings
  // snapshot. Reading it here keeps article rendering deterministic and
  // cacheable; live settings changes take effect with the next atomic release.
  const cloud = getManagedSiteConfigSnapshot()
  const contentControls = getBuildContentControls()
  const showBreadcrumbs = contentControls.showBreadcrumbs && getBreadcrumbsEnabled()
  const effectiveSite = resolveBuildSiteConfig()
  const cloudFeedback = cloud?.siteConfig.portable.feedback
  const hasThumbsRating = cloud ? Boolean(cloudFeedback?.thumbsRating) : true
  const hasEditSuggestions = cloud ? Boolean(cloudFeedback?.editSuggestions) : true
  const hasIssueReporting = cloud ? Boolean(cloudFeedback?.issueReporting) : true
  // The card only carries the rating. Repository links ("Edit this page",
  // "Report an issue") live once, in the page-actions rail below, so the two
  // surfaces never show the same actions side by side.
  const feedback = hasThumbsRating ? (
    <Feedback
      endpoint={feedbackConfig.endpoint ?? '/api/feedback'}
      thumbsRating
      pageFeedback={Boolean(cloudFeedback?.pageFeedback)}
    />
  ) : null
  // Placeholder repo URLs from a fresh scaffold must not produce dead links.
  const repoUrl =
    effectiveSite.repoUrl && !effectiveSite.repoUrl.includes('your-org')
      ? effectiveSite.repoUrl
      : null
  const pageSourceActions = repoUrl && (hasEditSuggestions || hasIssueReporting) ? (
    <div className="flex flex-col items-start gap-1.5">
      {hasEditSuggestions ? (
        <EditOnGithub
          pageId={doc.id}
          repoUrl={repoUrl}
          label="Edit this page"
          className="text-sm leading-6 text-foreground/55"
        />
      ) : null}
      {hasIssueReporting ? (
        <ReportAnIssue
          pagePath={doc.href}
          repoUrl={repoUrl}
          className="text-sm leading-6 text-foreground/55"
        />
      ) : null}
    </div>
  ) : null
  const pageActionsRail = pageSourceActions ? (
    <div className="mt-5 border-t border-border pt-4">{pageSourceActions}</div>
  ) : null

  // custom mode: render children directly, no shell chrome
  if (mode === 'custom') {
    return (
      <div lang={locale} dir={localeDirection(locale)}>
        {children}
      </div>
    )
  }

  // home mode: a landing moment — no breadcrumbs, header, or TOC. The page's
  // own <Hero> and card grid carry the art direction; only the "next" link
  // remains at the foot to keep readers moving into the docs.
  if (mode === 'home') {
    return (
      <article className="thally-docs-article flex-1" lang={locale} dir={localeDirection(locale)}>
        <div className="space-y-16">
          <Prose className="thally-docs-hero max-w-none">{children}</Prose>
          <div className="not-prose">
            <DocPagination prev={prev} next={next} />
          </div>
        </div>
      </article>
    )
  }

  // center mode: single centered column, no sidebar-style TOC
  if (mode === 'center') {
    return (
      <article className="thally-docs-article mx-auto w-full max-w-2xl" lang={locale} dir={localeDirection(locale)}>
        <ContentStack>
          <div className="not-prose space-y-4">
            {showBreadcrumbs ? <DocBreadcrumbs items={breadcrumbs} /> : null}
            <DocHeader doc={doc} eyebrow={eyebrow} showCopyPage={contentControls.showCopyPage} />
          </div>
          <InlineUpdateFilters railVisible={false} />
          <Prose className="flex-auto w-full">{children}</Prose>
          <div className="not-prose space-y-6">
            {feedback}
            {pageSourceActions}
            <DocPagination prev={prev} next={next} />
          </div>
        </ContentStack>
      </article>
    )
  }

  // wide mode: no TOC column, full-width content
  if (mode === 'wide') {
    return (
      <article className="thally-docs-article flex-1" lang={locale} dir={localeDirection(locale)}>
        <ContentStack>
          <div className="not-prose space-y-4">
            {showBreadcrumbs ? <DocBreadcrumbs items={breadcrumbs} /> : null}
            <DocHeader doc={doc} eyebrow={eyebrow} showCopyPage={contentControls.showCopyPage} />
          </div>
          <InlineUpdateFilters railVisible={false} />
          <Prose className="flex-auto w-full">{children}</Prose>
          <div className="not-prose space-y-6">
            {feedback}
            {pageSourceActions}
            <DocPagination prev={prev} next={next} />
          </div>
        </ContentStack>
      </article>
    )
  }

  // default: two-column with TOC
  return (
    <MainColumns>
      <article className="thally-docs-article flex-1" lang={locale} dir={localeDirection(locale)}>
        <ContentStack>
          <div className="not-prose space-y-4">
            {showBreadcrumbs ? <DocBreadcrumbs items={breadcrumbs} /> : null}
            <DocHeader doc={doc} eyebrow={eyebrow} showCopyPage={contentControls.showCopyPage} />
          </div>
          <InlineUpdateFilters railVisible={true} />
          <Prose className="flex-auto w-full">{children}</Prose>
          <div className="not-prose space-y-6">
            {feedback}
            <DocPagination prev={prev} next={next} />
          </div>
        </ContentStack>
      </article>
      <DetailColumn>
        <PagePanelSlot
          fallback={contentControls.showTableOfContents ? <TableOfContents /> : null}
          footer={pageActionsRail}
        />
      </DetailColumn>
    </MainColumns>
  )
}

/** Layouts that render the update filter controls; any other layout ignores `?tags=`. */
const MODES_WITH_UPDATE_FILTERS = new Set(['default', 'wide', 'center'])

/** Render a documentation page with page-scoped MDX coordination. */
export function DocLayout(props: DocLayoutProps) {
  return (
    <PageSlotsProvider urlFilters={MODES_WITH_UPDATE_FILTERS.has(props.doc.mode ?? 'default')}>
      <DocLayoutContent {...props} />
    </PageSlotsProvider>
  )
}
