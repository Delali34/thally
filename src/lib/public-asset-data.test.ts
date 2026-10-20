/** Static branding loads never use network fetch or escape authored public files. */
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
    expect(await publicBrandImageDataUri('/logo.svg')).toMatch(/^data:image\/svg\+xml;base64,/)
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
