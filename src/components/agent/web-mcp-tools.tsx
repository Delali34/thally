'use client'

/** Native WebMCP ships in every documentation shell and is inert in unsupported browsers. */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createWebMcpTools, registerWebMcpTools, type WebModelContext } from '@/lib/mcp/web-mcp'

interface WebMcpToolsProps {
  defaultLocale: string
  locales: Array<string>
}

/** Expose all deployed-site tools without customer configuration or API keys. */
export function WebMcpTools({ defaultLocale, locales }: WebMcpToolsProps) {
  const router = useRouter()
  const localeKey = locales.join(',')
  useEffect(() => {
    const context = (document as Document & { modelContext?: WebModelContext }).modelContext
    if (!context) return
    const tools = createWebMcpTools({
      fetch: window.fetch.bind(window),
      location: () => window.location,
      navigate: (href) => router.push(href),
      defaultLocale,
      locales: localeKey.split(','),
    })
    return registerWebMcpTools(context, tools)
  }, [router, defaultLocale, localeKey])
  return null
}
