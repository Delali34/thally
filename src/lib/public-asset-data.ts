/** Read bounded public bytes without network requests or filesystem escapes. */

import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { getContentAssetFetcher } from '@/lib/content-source/runtime'
import { publicBrandAssetPath } from '@/lib/public-brand-asset'

/** Validate XML comments in place; deleting them could create new source tokens. */
function hasValidSvgComments(content: string): boolean {
  let inTag = false
  let quote: '"' | "'" | undefined
  for (let offset = 0; offset < content.length; offset += 1) {
    const character = content[offset]
    if (character === '<') {
      // Comments cannot splice tag names, attribute names, or quoted values.
      // XML disallows a literal '<' anywhere inside an opening/closing tag.
      if (inTag) return false
      if (content.startsWith('<!--', offset)) {
        const end = content.indexOf('-->', offset + 4)
        if (end === -1) return false
        const body = content.slice(offset + 4, end)
        // XML forbids double hyphens within comments, including nested openers,
        // and a trailing hyphen would combine with the terminator into `--->`.
        if (body.includes('--') || body.endsWith('-')) return false
        offset = end + 2
      } else inTag = true
    } else if (inTag) {
      if (quote) {
        if (character === quote) quote = undefined
      } else if (character === '"' || character === "'") quote = character
      else if (character === '>') inTag = false
    }
  }
  return !inTag
}

/** Comments may precede the root, but a commented-out root is not artwork. */
function hasSvgRoot(content: string): boolean {
  let offset = 0
  while (offset < content.length) {
    while (/\s/.test(content[offset] ?? '') && offset < content.length) offset += 1
    if (!content.startsWith('<!--', offset)) break
    // Comment syntax has already been validated, so its terminator exists.
    offset = content.indexOf('-->', offset + 4) + 3
  }
  return /^<svg(?:\s|\/?>)/i.test(content.slice(offset))
}

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
    // Harmless exporter comments remain intact. Other declarations and unsafe
    // resource/script constructs are rejected even when written in a comment.
    if (!hasValidSvgComments(content) || !hasSvgRoot(content) || /<!(?!--)|<\?|<\s*(?:script|foreignObject|image|use|style|animate\w*|set)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|[\\&]|url\s*\((?!\s*['"]?#[\w.-]+['"]?\s*\))/i.test(content)) return null
  }
  return `data:${mime};base64,${bytes.toString('base64')}`
}
