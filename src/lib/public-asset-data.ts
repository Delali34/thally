/** Read bounded public bytes without network requests or filesystem escapes. */

import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { getContentAssetFetcher } from '@/lib/content-source/runtime'
import { publicBrandAssetPath } from '@/lib/public-brand-asset'

/** Read this deployment's static asset binding, or a real file within public/. */
export async function readPublicAsset(assetPath: string, maxBytes: number): Promise<Buffer | null> {
  const safePath = publicBrandAssetPath(assetPath)
  if (!safePath) return null
  try {
    const fetchAsset = getContentAssetFetcher()
    if (fetchAsset) {
      // The binding serves only this deployment's assets; never follow its redirect.
      const response = await fetchAsset(safePath.split('/').map(encodeURIComponent).join('/'))
      if (!response.ok || !response.body) return null
      const reader = response.body.getReader()
      const chunks: Array<Uint8Array> = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) return null
          chunks.push(value)
        }
        return Buffer.concat(chunks)
      } finally {
        await reader.cancel()
      }
    }

    const root = await realpath(path.join(process.cwd(), 'public'))
    const file = await realpath(path.join(root, safePath.slice(1)))
    const relative = path.relative(root, file)
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
    const info = await stat(file)
    if (!info.isFile() || info.size > maxBytes) return null
    const bytes = await readFile(file)
    return bytes.length <= maxBytes ? bytes : null
  } catch {
    return null
  }
}

/** Embed portable artwork only; SVG resource loads, script, and entities are forbidden. */
export async function publicBrandImageDataUri(assetPath: string): Promise<string | null> {
  const extension = path.extname(assetPath).toLowerCase()
  const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension]
  if (!mime) return null
  const bytes = await readPublicAsset(assetPath, 512 * 1024)
  if (!bytes?.length) return null
  if (extension === '.svg') {
    const svg = bytes.toString('utf8').replace(/^\s*<\?xml\s[^?]*\?>/i, '').replace(/<!--[\s\S]*?-->/g, '')
    // SVG is parsed solely by the image renderer, never evaluated. Refuse even
    // passive references so custom images cannot cause external resource fetches.
    if (!/<svg[\s>]/i.test(svg) || /<!|<\?|<\s*(?:script|foreignObject|image|use|style|animate\w*|set)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|[\\&]|url\s*\((?!\s*['"]?#[\w.-]+['"]?\s*\))/i.test(svg)) return null
    return `data:${mime};base64,${Buffer.from(svg).toString('base64')}`
  }
  return `data:${mime};base64,${bytes.toString('base64')}`
}
