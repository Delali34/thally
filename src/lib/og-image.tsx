/**
 * Handoff-aligned renderer for dynamic documentation social previews.
 */
import { ImageResponse } from 'next/og'

export const OG_IMAGE_SIZE = { width: 1200, height: 630 }

export interface OgImageFont {
  name: string
  data: ArrayBuffer
  weight: 400 | 700
  style: 'normal'
}

export interface DocsOgImageOptions {
  title: string
  description?: string
  crumb?: string
  url: string
  brandName: string
  logoUri?: string
  logoIsSquare: boolean
  palette: {
    background: string
    foreground: string
    muted: string
    faint: string
  }
  fonts: Array<OgImageFont>
}

function truncateAtWord(value: string, maxLength: number) {
  if (value.length <= maxLength) return value

  const slice = value.slice(0, maxLength - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const cutoff = lastSpace > maxLength * 0.6 ? lastSpace : slice.length
  return `${slice.slice(0, cutoff).trim()}…`
}

function balancedLines(value: string, lineCount: number) {
  if (lineCount === 1) return [value]

  const words = value.split(/\s+/)
  const lines: Array<string> = []
  let remaining = words

  for (let line = 0; line < lineCount - 1; line += 1) {
    const target = remaining.join(' ').length / (lineCount - line)
    let bestIndex = 1
    let smallestDifference = Number.POSITIVE_INFINITY

    for (let index = 1; index < remaining.length; index += 1) {
      const length = remaining.slice(0, index).join(' ').length
      const difference = Math.abs(length - target)
      if (difference < smallestDifference) {
        bestIndex = index
        smallestDifference = difference
      }
    }

    lines.push(remaining.slice(0, bestIndex).join(' '))
    remaining = remaining.slice(bestIndex)
  }

  if (remaining.length) lines.push(remaining.join(' '))
  return lines
}

/**
 * Render a 1200 by 630 docs image using the exact layout and typography from the OG handoff.
 */
export function renderDocsOgImage({
  title,
  description,
  crumb,
  url,
  brandName,
  logoUri,
  logoIsSquare,
  palette,
  fonts,
}: DocsOgImageOptions) {
  const shortTitle = truncateAtWord(title, 96)
  const lineCount = shortTitle.length > 68 ? 3 : shortTitle.length > 34 ? 2 : 1
  const titleLines = balancedLines(shortTitle, lineCount)
  const titleSize = lineCount === 3 ? 46 : 54
  const shortDescription = description ? truncateAtWord(description, 124) : ''
  const shortCrumb = crumb ? truncateAtWord(crumb, 72) : ''
  const shortUrl = truncateAtWord(url, 92)

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '76px 88px',
        backgroundColor: palette.background,
        color: palette.foreground,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontFamily: 'Jakarta',
          fontSize: 19,
          fontWeight: 400,
          letterSpacing: '-0.02em',
          color: palette.muted,
        }}
      >
        {logoUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUri}
            alt=""
            height={26}
            {...(logoIsSquare ? { width: 26 } : {})}
            style={{ ...(logoIsSquare ? { width: 26 } : {}), height: 26, objectFit: 'contain' }}
          />
        ) : null}
        <div style={{ display: 'flex' }}>
          <span style={{ color: palette.foreground, fontWeight: 700 }}>{brandName}</span>
          <span>&nbsp;Docs</span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          flex: 1,
        }}
      >
        {shortCrumb ? (
          <div
            style={{
              marginBottom: 18,
              fontFamily: 'Inter',
              fontSize: 19,
              fontWeight: 400,
              color: palette.faint,
              whiteSpace: 'nowrap',
            }}
          >
            {shortCrumb}
          </div>
        ) : null}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            maxWidth: 860,
            fontFamily: 'Jakarta',
            fontSize: titleSize,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.12,
            color: palette.foreground,
          }}
        >
          {titleLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>

        {shortDescription ? (
          <div
            style={{
              marginTop: 20,
              maxWidth: 590,
              fontFamily: 'Inter',
              fontSize: 22,
              fontWeight: 400,
              lineHeight: 1.55,
              color: palette.muted,
            }}
          >
            {shortDescription}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          fontFamily: 'Mono',
          fontSize: 15,
          fontWeight: 400,
          color: palette.faint,
        }}
      >
        {shortUrl}
      </div>
    </div>,
    {
      ...OG_IMAGE_SIZE,
      fonts,
      headers: { 'cache-control': 'public, max-age=3600, s-maxage=3600' },
    },
  )
}
