'use client'

/** Admin identity follows the site's managed, uploaded, or authored logo. */
import { SiteBrandMark } from '@/components/layout/site-brand-mark'

/** Keep workspace and login marks consistent with the documentation header. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return <SiteBrandMark kind="logo" size={size} />
}
