/* eslint-disable @next/next/no-css-tags -- docs.json selects local CSS at runtime. */
import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import Script from 'next/script'
import './globals.css'
import '@/styles/docs-handoff.css'
import '@/styles/docs-navigation-update.css'
import '@/styles/docs-code-update.css'
import '@/styles/docs-endpoint-update.css'
import '@/styles/docs-try-it-update.css'
import { Providers } from '@/app/providers'
import { siteConfig } from '@/data/site'
import {
  getBannerConfig,
  getBrandColors,
  getContentIconTone,
  getCustomScriptsConfig,
  getFontsConfig,
  getSeoConfig,
  getStylesheetsConfig,
  getIntegrationsConfig,
  getStructuralTheme,
} from '@/data/docs'
import { getBuildIconLibrary } from '@/lib/cloud-link/icon-library'
import { cn } from '@/lib/utils'
import { toHslValue, THEME_VARS } from '@thallylabs/core/theme'
import { buildOgImageUrl } from '@/lib/og'
import { buildSiteJsonLd } from '@/lib/json-ld'
import { getSiteUrl } from '@/lib/site-url'
import { JsonLdScript } from '@/components/seo/json-ld-script'
import { WebMcpDiscovery } from '@/components/agent/web-mcp-discovery'
import { AnalyticsProvider, GtmNoScript } from '@/components/analytics/analytics-provider'
import { resolveAnalyticsConfig } from '@/lib/analytics-config'
import { SiteBanner } from '@/components/layout/site-banner'
import { WebMcpTools } from '@/components/agent/web-mcp-tools'
import { CloudHandshake } from '@/components/cloud/cloud-handshake'
import { localeDirection } from '@/lib/i18n/config'
import { getEffectiveI18nConfig } from '@/lib/i18n/request'
import { resolveBuildSiteConfig } from '@/lib/site-config'
import { validMetatags } from '@/lib/metatags'
import { getBuildSiteAppearance } from '@/lib/cloud-link/appearance'
import { lockedAppearanceScript } from '@/lib/site-appearance'
import { brandRuntimeCss } from '@/lib/brand-runtime-css'

// Default fonts via next/font (optimal performance — preloaded, no FOUC).
// Inter covers both reading and display text so the public docs keep one
// consistent typographic voice; JetBrains Mono covers machine-facing text.
const fontSans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  // Code appears below the initial documentation heading on most pages. Keep
  // it in a separate font file, but do not compete with body/display fonts in
  // the critical preload queue.
  preload: false,
})

// ---------------------------------------------------------------------------
// Custom font injection from docs.json
// ---------------------------------------------------------------------------

function buildGoogleFontsUrl(family: string, weights: string[]): string {
  const familyParam = family.replace(/ /g, '+')
  // Google Fonts v2 format: family=Name:wght@400;600;700
  const weightParam = weights.join(';')
  return `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${weightParam}&display=swap`
}

function resolveFontPresentation(): {
  googleFontUrls: Array<string>
  fontOverrides: string
} {
  const fontsConfig = getFontsConfig()
  const googleFontUrlSet = new Set<string>()
  let bodyFontFamily: string | null = null
  let headingFontFamily: string | null = null

  if (fontsConfig.body?.family) {
    bodyFontFamily = fontsConfig.body.family
    googleFontUrlSet.add(
      buildGoogleFontsUrl(fontsConfig.body.family, fontsConfig.body.weight ?? ['400', '500', '600', '700']),
    )
  }
  if (fontsConfig.heading?.family) {
    headingFontFamily = fontsConfig.heading.family
    googleFontUrlSet.add(buildGoogleFontsUrl(fontsConfig.heading.family, fontsConfig.heading.weight ?? ['600', '700']))
  }

  return {
    googleFontUrls: Array.from(googleFontUrlSet),
    fontOverrides: [
      bodyFontFamily ? `--font-sans: '${bodyFontFamily}', sans-serif;` : '',
      headingFontFamily ? `--font-heading: '${headingFontFamily}', sans-serif;` : '',
    ]
      .filter(Boolean)
      .join(' '),
  }
}

interface OptionalPrimaryPalette {
  primary?: string
  primaryForeground?: string
}

/**
 * Reads the expanded theme colors without requiring older, user-authored
 * site config types to declare them. Generated starters keep their own
 * `src/data/site.ts`, so runtime-owned code must remain compatible with the
 * narrower palette contract already present in existing sites.
 */
function resolvePrimaryPalette(
  palette: { foreground: string; background: string; accent: string; accentForeground: string },
  fallback: { primary: string; primaryForeground: string },
): { primary: string; primaryForeground: string } {
  const optionalPalette = palette as typeof palette & OptionalPrimaryPalette

  return {
    primary: optionalPalette.primary ?? fallback.primary,
    primaryForeground: optionalPalette.primaryForeground ?? fallback.primaryForeground,
  }
}

// ---------------------------------------------------------------------------

export async function generateMetadata(): Promise<Metadata> {
  const effectiveSite = resolveBuildSiteConfig()
  const siteUrl = getSiteUrl()
  const defaultOgImage = buildOgImageUrl({})
  // A site name that already ends in "Documentation" must not be doubled.
  const defaultTitle = /documentation$/i.test(effectiveSite.name.trim())
    ? effectiveSite.name
    : `${effectiveSite.name} Documentation`
  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: defaultTitle,
      template: `%s | ${effectiveSite.name}`,
    },
    description: effectiveSite.description,
    other: validMetatags(getSeoConfig().metatags),
    // Derived from the request-bound site config so a fork never inherits
    // the baseline's marketing keywords.
    keywords: [effectiveSite.name, `${effectiveSite.name} documentation`, 'docs'],
    icons: {
      // Media supplies the pre-hydration/no-JavaScript fallback. ThemeFavicon
      // then follows the reader's resolved mode, including manual and locked
      // modes. The route falls back to the light upload when dark is absent.
      icon: [
        { url: '/api/brand/favicon', media: '(prefers-color-scheme: light)' },
        {
          url: '/api/brand/favicon?mode=dark',
          media: '(prefers-color-scheme: dark)',
        },
      ],
      shortcut: '/api/brand/favicon',
    },
    openGraph: {
      title: defaultTitle,
      description: effectiveSite.description,
      url: siteUrl,
      siteName: effectiveSite.name,
      images: [{ url: defaultOgImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: defaultTitle,
      description: effectiveSite.description,
      images: [defaultOgImage],
    },
  }
}

const lightPrimaryPalette = resolvePrimaryPalette(siteConfig.brand.light, {
  primary: siteConfig.brand.light.foreground,
  primaryForeground: siteConfig.brand.light.background,
})
const darkPrimaryPalette = resolvePrimaryPalette(siteConfig.brand.dark, {
  primary: siteConfig.brand.dark.accent,
  primaryForeground: siteConfig.brand.dark.accentForeground,
})

const brandStyle: Record<string, string> = {
  '--brand-light-background': toHslValue(siteConfig.brand.light.background),
  '--brand-light-card': toHslValue(siteConfig.brand.light.card ?? siteConfig.brand.light.background),
  '--brand-light-foreground': toHslValue(siteConfig.brand.light.foreground),
  '--brand-light-muted': toHslValue(siteConfig.brand.light.muted),
  '--brand-light-muted-foreground': toHslValue(
    siteConfig.brand.light.mutedForeground ?? siteConfig.brand.light.foreground,
  ),
  '--brand-light-border': toHslValue(siteConfig.brand.light.border),
  '--brand-light-accent': toHslValue(siteConfig.brand.light.accent),
  '--brand-light-accent-foreground': toHslValue(siteConfig.brand.light.accentForeground),
  '--brand-light-accent-2': toHslValue(siteConfig.brand.light.accent2 ?? siteConfig.brand.light.accent),
  '--brand-light-accent-2-foreground': toHslValue(
    siteConfig.brand.light.accent2Foreground ?? siteConfig.brand.light.accentForeground,
  ),
  '--brand-light-primary': toHslValue(lightPrimaryPalette.primary),
  '--brand-light-primary-foreground': toHslValue(lightPrimaryPalette.primaryForeground),
  '--brand-light-input': toHslValue(siteConfig.brand.light.input ?? siteConfig.brand.light.border),
  '--brand-light-sidebar': toHslValue(siteConfig.brand.light.sidebar ?? siteConfig.brand.light.background),
  '--brand-light-ring': toHslValue(siteConfig.brand.light.ring),
  '--brand-sidebar-active-bg-light': toHslValue(siteConfig.brand.light.sidebarActiveBg),
  '--brand-sidebar-active-text-light': toHslValue(siteConfig.brand.light.sidebarActiveText),
  '--brand-dark-background': toHslValue(siteConfig.brand.dark.background),
  '--brand-dark-card': toHslValue(siteConfig.brand.dark.card ?? siteConfig.brand.dark.background),
  '--brand-dark-foreground': toHslValue(siteConfig.brand.dark.foreground),
  '--brand-dark-muted': toHslValue(siteConfig.brand.dark.muted),
  '--brand-dark-muted-foreground': toHslValue(
    siteConfig.brand.dark.mutedForeground ?? siteConfig.brand.dark.foreground,
  ),
  '--brand-dark-border': toHslValue(siteConfig.brand.dark.border),
  '--brand-dark-accent': toHslValue(siteConfig.brand.dark.accent),
  '--brand-dark-accent-foreground': toHslValue(siteConfig.brand.dark.accentForeground),
  '--brand-dark-accent-2': toHslValue(siteConfig.brand.dark.accent2 ?? siteConfig.brand.dark.accent),
  '--brand-dark-accent-2-foreground': toHslValue(
    siteConfig.brand.dark.accent2Foreground ?? siteConfig.brand.dark.accentForeground,
  ),
  '--brand-dark-primary': toHslValue(darkPrimaryPalette.primary),
  '--brand-dark-primary-foreground': toHslValue(darkPrimaryPalette.primaryForeground),
  '--brand-dark-input': toHslValue(siteConfig.brand.dark.input ?? siteConfig.brand.dark.border),
  '--brand-dark-sidebar': toHslValue(siteConfig.brand.dark.sidebar ?? siteConfig.brand.dark.background),
  '--brand-dark-ring': toHslValue(siteConfig.brand.dark.ring),
  '--brand-sidebar-active-bg-dark': toHslValue(siteConfig.brand.dark.sidebarActiveBg),
  '--brand-sidebar-active-text-dark': toHslValue(siteConfig.brand.dark.sidebarActiveText),
}

// The brand palette must live in a :root <style> (NOT inline on <html>): inline
// styles beat every stylesheet, so /api/brand.css could never override the
// dashboard accent. As a :root rule, brand.css's :root:root wins.
const brandCss = Object.entries(brandStyle)
  .map(([k, v]) => `${k}:${v}`)
  .join(';')

// OpenNext's production transform can add esbuild's `__name` calls to the
// serialized next-themes bootstrap. The bootstrap runs before client bundles,
// so provide the tiny helper first or one missing global prevents the entire
// React tree from hydrating and disables every interactive control. This must
// be a native inline script: Next Script beforeInteractive queues execution
// until the client bootstrap, after next-themes has already run its script.
const runtimeNameShim =
  "globalThis.__name ??= (target, value) => Object.defineProperty(target, 'name', { value, configurable: true });"

function documentLocaleScript(locales: ReadonlyArray<{ code: string }>, defaultLocale: string): string {
  // The root layout is shared with admin and unprefixed routes, so Next cannot
  // receive the child catch-all's locale as a root param. Set the document
  // language before the body renders while the article itself stays SSR-tagged.
  const directions = Object.fromEntries(locales
    .filter((locale) => locale.code !== defaultLocale)
    .map((locale) => [locale.code, localeDirection(locale.code)]))
  const serialized = JSON.stringify(directions).replace(/</g, '\\u003c')
  return `(() => { const locales = ${serialized}; const code = location.pathname.split('/')[1]; if (Object.hasOwn(locales, code)) { document.documentElement.lang = code; document.documentElement.dir = locales[code]; } })();`
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // These values belong to the immutable release binding, not the compiled
  // module. Resolve them during rendering so content-only publishes can reuse
  // Worker code while presenting the new docs.json immediately.
  const { googleFontUrls, fontOverrides } = resolveFontPresentation()
  const structuralTheme = getStructuralTheme()
  const { appearance, background } = getBuildSiteAppearance()
  const hasBackground = Boolean(background.image || background.imageDark || background.decoration !== 'none')
  const runtimeBrandCss = brandRuntimeCss({ colors: getBrandColors(), ...(hasBackground ? { background } : {}) })
  const contentIconTone = getContentIconTone()
  const iconLibrary = getBuildIconLibrary()
  const themeVars = THEME_VARS[structuralTheme] ?? ''
  const bannerConfig = getBannerConfig()
  const customScripts = getCustomScriptsConfig()
  const stylesheets = getStylesheetsConfig()
  const analyticsConfig = resolveAnalyticsConfig(siteConfig.analytics, getIntegrationsConfig())
  const i18n = await getEffectiveI18nConfig()
  const effectiveSite = resolveBuildSiteConfig()
  const siteUrl = getSiteUrl()
  const defaultLang = i18n.defaultLocale
  const siteJsonLd = buildSiteJsonLd({
    siteUrl,
    siteName: effectiveSite.name,
    description: effectiveSite.description,
    repoUrl: effectiveSite.repoUrl,
    locale: defaultLang,
  })

  return (
    // Font variables live on <html> (not <body>) so :root-level rules — the
    // globals.css --font-heading default and docs.json font overrides — can
    // reference and override them.
    <html
      lang={defaultLang}
      dir={localeDirection(defaultLang)}
      suppressHydrationWarning
      data-theme={structuralTheme}
      data-content-icons={contentIconTone}
      data-icon-library={iconLibrary}
      data-site-background={hasBackground ? 'enabled' : undefined}
      data-site-background-image={background.image || background.imageDark ? 'enabled' : undefined}
      className={cn(fontSans.variable, fontMono.variable)}
    >
      <head>
        <script id="thally-runtime-name-shim" dangerouslySetInnerHTML={{ __html: runtimeNameShim }} />
        <Script id="thally-document-locale" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: documentLocaleScript(i18n.locales, defaultLang) }} />
        {!appearance.showToggle && (
          <Script id="thally-locked-appearance" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: lockedAppearanceScript(appearance.default) }} />
        )}
        <JsonLdScript data={siteJsonLd} />
        <WebMcpDiscovery />
        {/* Google Fonts for custom body/heading fonts set in docs.json */}
        {googleFontUrls.length > 0 && (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
            {googleFontUrls.map((url) => (
              <link key={url} rel="stylesheet" href={url} />
            ))}
          </>
        )}
        {/* Brand palette (default) — a :root rule so /api/brand.css can override it */}
        <style>{`:root { ${brandCss} }`}</style>
        {runtimeBrandCss && <style>{runtimeBrandCss}</style>}
        {/* CSS variable overrides for custom fonts */}
        {fontOverrides && <style>{`:root { ${fontOverrides} }`}</style>}
        {/* CSS variable overrides for structural theme (radius, sidebar, nav tabs) */}
        {themeVars && <style>{`:root { ${themeVars} }`}</style>}
        {/* Live admin branding override (theme + accent from the dashboard) — last so it wins */}
        <link rel="stylesheet" href="/api/brand.css" />
        {stylesheets.map((href) => <link key={href} rel="stylesheet" href={href} />)}
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <GtmNoScript config={analyticsConfig} />
        {bannerConfig && (
          <SiteBanner
            banner={bannerConfig}
            defaultLocale={i18n.defaultLocale}
            locales={i18n.locales.map((locale) => locale.code)}
          />
        )}
        <Providers appearance={appearance}>{children}</Providers>
        <CloudHandshake />
        <AnalyticsProvider config={analyticsConfig} />
        <WebMcpTools defaultLocale={defaultLang} locales={i18n.locales.map((locale) => locale.code)} />
        {customScripts.map((script) => (
          <Script key={script.src} src={script.src} strategy={script.strategy ?? 'afterInteractive'} />
        ))}
      </body>
    </html>
  )
}
