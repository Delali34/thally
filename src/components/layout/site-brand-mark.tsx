'use client'

/** Small theme-aware site identity shared by admin chrome and the docs assistant. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useReaderTheme } from '@/components/theme/reader-theme'

const emptySubscribe = () => () => {}

interface SiteBrandMarkProps {
  kind?: 'logo' | 'favicon'
  size?: number
  className?: string
}

function BrandImage({ kind, mode, size, className }: Required<Pick<SiteBrandMarkProps, 'kind' | 'size'>> & {
  mode: 'light' | 'dark'
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const [hidden, setHidden] = useState(false)
  const image = useRef<HTMLImageElement>(null)
  const source = failed ? `/brand/default-${kind}-${mode}.svg` : `/api/brand/${kind}?mode=${mode}`

  useEffect(() => {
    // Cached images can fail before hydration attaches onError. Inspect the
    // active source again whenever it changes, including the bundled fallback.
    let cancelled = false
    queueMicrotask(() => {
      const element = image.current
      if (!cancelled && element?.complete && element.naturalWidth === 0) {
        if (failed) setHidden(true)
        else setFailed(true)
      }
    })
    return () => { cancelled = true }
  }, [failed])

  if (hidden) return null
  return (
    // The route negotiates site branding itself; image optimization would
    // obscure runtime updates and is unnecessary for these tiny identity marks.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={image}
      src={source}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      onError={() => failed ? setHidden(true) : setFailed(true)}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
    />
  )
}

/** Resolve the same brand routes as the browser tab and header, with safe fallback. */
export function SiteBrandMark({ kind = 'favicon', size = 24, className }: SiteBrandMarkProps) {
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false)
  const { resolvedTheme } = useReaderTheme()
  const mode = mounted && resolvedTheme === 'dark' ? 'dark' : 'light'
  // A theme change retries its own artwork even if the previous variant failed.
  return <BrandImage key={`${kind}-${mode}`} kind={kind} mode={mode} size={size} className={className} />
}
