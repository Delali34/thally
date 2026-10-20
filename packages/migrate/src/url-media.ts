/** Project known rendered media into inert built-ins; unknown controls stay reviewable. */

import { load } from 'cheerio'

import { migrationImageAttribute, migrationImageUrl } from './url-images.js'

const VIDEO_ATTRIBUTES = new Set([
  'src', 'title', 'poster', 'controls', 'muted', 'autoplay', 'loop', 'playsinline',
  'class', 'id', 'width', 'height', 'preload', 'aria-label',
  // Publisher asset provenance does not change playback and is never emitted.
  // Keep this explicit: arbitrary data attributes may drive custom controls.
  'data-path',
])
const YOUTUBE_ATTRIBUTES = new Set([
  'src', 'title', 'width', 'height', 'allow', 'allowfullscreen', 'referrerpolicy',
  'frameborder', 'loading', 'class', 'id', 'aria-label',
])
const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
])

/**
 * Return a safe static embed only when its source and playback behavior are
 * representable by the existing runtime. URLs remain remote media
 * references; callers must not fetch a video to prove this content projection.
 */
export function projectMigrationMedia(html: string, base: URL): string | null {
  const $ = load(html, undefined, false)
  const nodes = $.root().contents().filter((_index, node) => node.type !== 'text' || Boolean(node.data.trim()))
  if (nodes.length !== 1) return null
  const element = nodes.first()
  const node = element[0]
  if (node.type !== 'tag' || !['video', 'iframe'].includes(node.name)) return null
  // Fallback copy, source alternatives and custom controls need a richer
  // projection. Never silently discard them while claiming media fidelity.
  if (element.children().length || element.text().trim()) return null
  const allowed = node.name === 'video' ? VIDEO_ATTRIBUTES : YOUTUBE_ATTRIBUTES
  if (Object.keys(node.attribs).some((name) => !allowed.has(name))) return null
  const source = element.attr('src')
  if (!source) return null
  try {
    let src = migrationImageUrl(source, base)
    let component = 'Video'
    const props: Array<string> = []
    if (node.name === 'video') {
      // The built-in chooses native playback from the suffix. Keep authored
      // native video semantics for extensionless attachment URLs rather than
      // letting that built-in turn them into an iframe.
      if (!/\.(?:mp4|webm|ogg|mov|m4v)(?:[?#]|$)/i.test(src)) component = 'video'
      const isMuted = element.attr('muted') !== undefined
      const hasAutoplay = element.attr('autoplay') !== undefined
      if (hasAutoplay && !isMuted) return null
      props.push('controls={true}')
      for (const [attribute, prop] of [['muted', 'muted'], ['loop', 'loop'], ['playsinline', 'playsInline'], ['autoplay', 'autoPlay']]) {
        if (element.attr(attribute) !== undefined) props.push(`${prop}={true}`)
      }
      const poster = element.attr('poster')
      if (poster) props.push(`poster="${migrationImageAttribute(migrationImageUrl(poster, base))}"`)
    } else {
      const url = new URL(src)
      if (url.protocol !== 'https:' || url.port || !YOUTUBE_HOSTS.has(url.hostname)) return null
      const id = url.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})$/)?.[1]
      // The runtime normalizes embed URLs. Only the nonsemantic share token
      // may disappear; timestamp/playback query options still need review.
      if (!id || url.hash || [...url.searchParams.keys()].some((name) => name !== 'si')) return null
      src = `https://www.youtube-nocookie.com/embed/${id}`
    }
    const title = element.attr('title') ?? element.attr('aria-label')
    if (title !== undefined) props.push(`title="${migrationImageAttribute(title)}"`)
    return `<${component} src="${migrationImageAttribute(src)}"${props.length ? ` ${props.join(' ')}` : ''} />`
  } catch {
    return null
  }
}
