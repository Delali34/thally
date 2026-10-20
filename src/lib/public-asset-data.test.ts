/** Static branding loads never use network fetch or escape authored public files. */
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { ImageResponse } from 'next/og'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setContentAssetFetcher } from './content-source/runtime'
import { publicBrandImageDataUri, readPublicAsset } from './public-asset-data'

let temporary: string | undefined
const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path fill="#ff0000" d="M0 0h20v20H0z"/></svg>'

afterEach(async () => {
  setContentAssetFetcher(null)
  vi.restoreAllMocks()
  if (temporary) await rm(temporary, { recursive: true, force: true })
  temporary = undefined
})

describe('bounded deployment assets', () => {
  it('embeds this deployment\'s SVG bytes without a network request', async () => {
    const network = vi.spyOn(globalThis, 'fetch')
    const assets = vi.fn(async () => new Response(safeSvg))
    setContentAssetFetcher(assets)
    const uri = await publicBrandImageDataUri('/custom mark.svg')
    expect(uri).toBe(`data:image/svg+xml;base64,${Buffer.from(safeSvg).toString('base64')}`)
    expect(assets).toHaveBeenCalledWith('/custom%20mark.svg')
    expect(network).not.toHaveBeenCalled()
  })

  it.each(['https://evil.example/a.svg', '//evil.example/a.svg', '/../private.svg', '/%2e%2e/private.svg'])('rejects unsafe paths before reading %s', async source => {
    const assets = vi.fn()
    setContentAssetFetcher(assets)
    expect(await publicBrandImageDataUri(source)).toBeNull()
    expect(assets).not.toHaveBeenCalled()
  })

  it.each([
    '<script>alert(1)</script>', '<image href="https://evil.example/a"/>', '<foreignObject/>',
    '<path onload="alert(1)"/>', '<style>@import "https://evil.example"</style>',
    '<path fill="url(https://evil.example/a)"/>', '<!DOCTYPE svg>',
    '<animate attributeName="href" values="https://evil.example"/>',
  ])('declines executable or resource-bearing SVG content: %s', async content => {
    setContentAssetFetcher(async () => new Response(`<svg>${content}</svg>`))
    expect(await publicBrandImageDataUri('/logo.svg')).toBeNull()
  })

  it('supports ordinary XML prologs and local paint gradients', async () => {
    const svg = '<?xml version="1.0"?><svg><defs><linearGradient id="a"/></defs><path fill="url(#a)"/></svg>'
    setContentAssetFetcher(async () => new Response(svg))
    const uri = await publicBrandImageDataUri('/logo.svg')
    expect(uri).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  })

  it.each([
    '<svg><!-- Ordinary export comment --><path d="M0 0"/></svg>',
    '<svg><!-- <!-- nested --> comment --></svg>',
    '<svg><!----><!-->',
    '<svg><scr<!-- comment -->ipt>alert(1)</scr<!-- comment -->ipt></svg>',
    '<svg><path o<!-- comment -->nload="alert(1)"/></svg>',
    '<svg><path fill="u<!-- comment -->rl(https://evil.example/a)"/></svg>',
    '<svg><image hr<!-- comment -->ef="https://evil.example/a"/></svg>',
    '<svg><!-- unterminated comment</svg>',
    '<?xml version="1.0"?><!-- comment before root --><svg/>',
  ])('rejects comment-bearing SVG without joining or rewriting source tokens: %s', async svg => {
    setContentAssetFetcher(async () => new Response(svg))
    expect(await publicBrandImageDataUri('/logo.svg')).toBeNull()
  })

  it.each([
    '<?xml arbitrary="metadata"?><svg/>',
    '<?xml version="1.0" encoding="UTF-16"?><svg/>',
    '<?xml version="1.0"?><!DOCTYPE svg><svg/>',
    '<?xml version="1.0"?><?xml version="1.0"?><svg/>',
    '<?xml version="1.0" <?xml version="1.0"?><svg/>',
    '<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/a"?><svg/>',
  ])('rejects malformed, repeated, or resource-bearing XML declarations: %s', async svg => {
    setContentAssetFetcher(async () => new Response(svg))
    expect(await publicBrandImageDataUri('/logo.svg')).toBeNull()
  })

  it('renders accepted original SVG bytes with a complete XML declaration into a PNG', async () => {
    const svg = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${safeSvg}`
    setContentAssetFetcher(async () => new Response(svg))
    const uri = await publicBrandImageDataUri('/logo.svg')
    expect(uri).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    const response = new ImageResponse(createElement('img', { src: uri, width: 20, height: 20 }), { width: 20, height: 20 })
    const png = Buffer.from(await response.arrayBuffer())
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('does not follow asset redirects or trust oversized bodies', async () => {
    setContentAssetFetcher(async () => Response.redirect('https://evil.example/a.svg'))
    expect(await publicBrandImageDataUri('/logo.svg')).toBeNull()
    setContentAssetFetcher(async () => new Response('12345'))
    expect(await readPublicAsset('/font.woff', 4)).toBeNull()
  })

  it('reads confined public files on self-hosted sites and rejects escaping symlinks', async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'thally-brand-'))
    await mkdir(path.join(temporary, 'public'))
    await writeFile(path.join(temporary, 'public', 'logo.svg'), safeSvg)
    await writeFile(path.join(temporary, 'private.svg'), safeSvg)
    await symlink(path.join(temporary, 'private.svg'), path.join(temporary, 'public', 'outside.svg'))
    vi.spyOn(process, 'cwd').mockReturnValue(temporary)
    expect(await publicBrandImageDataUri('/logo.svg')).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(await publicBrandImageDataUri('/outside.svg')).toBeNull()
    expect(await readPublicAsset('/missing.svg', 200)).toBeNull()
  })
})
