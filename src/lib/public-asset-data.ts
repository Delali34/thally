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
    const svg = bytes.toString('utf8')
    // Permit only an ordinary UTF-8 XML declaration at the start. Admission
    // inspects the remaining document, but embeds the original bytes unchanged.
    const declaration = /^\s*<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/i.exec(svg)
    const content = declaration ? svg.slice(declaration[0].length) : svg
    // SVG is parsed solely by the image renderer, never evaluated. Refuse even
    // passive references so custom images cannot cause external resource fetches.
    // Comments are rejected rather than stripped: removing a comment can join
    // previously separate text into new markup or another comment delimiter.
    if (!/<svg[\s>]/i.test(content) || /<!|<\?|<\s*(?:script|foreignObject|image|use|style|animate\w*|set)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|[\\&]|url\s*\((?!\s*['"]?#[\w.-]+['"]?\s*\))/i.test(content)) return null
  }
  return `data:${mime};base64,${bytes.toString('base64')}`
}
