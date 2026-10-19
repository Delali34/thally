/**
 * Icon library selection shared by the layout, the docs.json reader, and the
 * content Icon component.
 *
 * Site owners pick one library in docs.json (`icons.library`). Bundled Lucide
 * glyphs and inline brand marks render offline; every other name resolves to
 * the selected library's SVG on jsDelivr through a CSS mask, so no library has
 * to ship in the Worker bundle. Versions are pinned so a site never changes
 * glyphs without a runtime release.
 */

export const ICON_LIBRARIES = ['lucide', 'fontawesome', 'tabler'] as const

export type IconLibrary = (typeof ICON_LIBRARIES)[number]

export const DEFAULT_ICON_LIBRARY: IconLibrary = 'lucide'

/** Authoring style hints. Font Awesome and Tabler map these onto their own sets. */
export type IconStyle = 'regular' | 'solid' | 'outline' | 'brands'

const CDN_BASE = 'https://cdn.jsdelivr.net/npm'
const LUCIDE_STATIC_VERSION = '1.47.0'
const FONT_AWESOME_VERSION = '7.3.1'
const TABLER_ICONS_VERSION = '3.46.0'

/** Icon names are lowercase kebab-case slugs; anything else never reaches a URL. */
export const ICON_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isIconLibrary(value: unknown): value is IconLibrary {
  return typeof value === 'string' && (ICON_LIBRARIES as readonly string[]).includes(value)
}

/** Resolve a docs.json value to a supported library, defaulting to Lucide. */
export function resolveIconLibrary(value: unknown): IconLibrary {
  return isIconLibrary(value) ? value : DEFAULT_ICON_LIBRARY
}

/**
 * Font Awesome brand slugs that have no inline equivalent yet. They resolve to
 * the Font Awesome brands set under every library so migrated Mintlify content
 * keeps its logos.
 */
export const FONT_AWESOME_BRAND_NAMES: ReadonlySet<string> = new Set([
  'amazon', 'atlassian', 'aws', 'behance', 'bitcoin', 'chrome', 'codepen', 'confluence', 'dev',
  'dribbble', 'dropbox', 'edge', 'ethereum', 'facebook', 'firefox', 'google', 'google-drive',
  'hashnode', 'instagram', 'jira', 'linkedin', 'medium', 'microsoft', 'openai', 'paypal',
  'pinterest', 'reddit', 'safari', 'salesforce', 'slack', 'spotify', 'stack-overflow', 'telegram',
  'tiktok', 'trello', 'twitch', 'unity', 'whatsapp', 'windows',
])

/**
 * Font Awesome Pro-only names (Mintlify's default set is Pro) mapped to the
 * closest asset that exists. A value starting with `lucide:` is a Lucide name,
 * anything else is a Font Awesome Free solid name. The Font Awesome library
 * resolves these instead of requesting a Pro file that does not exist.
 */
export const FONT_AWESOME_PRO_FALLBACKS: Readonly<Record<string, string>> = {
  'barcode-read': 'barcode', 'text-size': 'text-height', messages: 'comments', lobster: 'shrimp',
  radar: 'lucide:radar', browser: 'lucide:app-window', 'brain-circuit': 'lucide:brain-circuit',
  'spider-web': 'lucide:network', sparkles: 'lucide:sparkles', 'file-magnifying-glass': 'lucide:file-search',
  'chart-mixed': 'lucide:chart-no-axes-combined', webhook: 'lucide:webhook', triangle: 'lucide:triangle',
  'square-code': 'lucide:square-code', 'shield-check': 'lucide:shield-check',
  'rectangle-terminal': 'lucide:square-terminal', 'messages-question': 'lucide:message-circle-question',
  'message-bot': 'lucide:bot-message-square', books: 'lucide:library',
  'code-change': 'code-compare',
  'alarm-exclamation': 'lucide:alarm-clock', 'bullseye-pointer': 'lucide:target', 'diagram-subtask': 'lucide:list-tree',
  'gauge-simple-low': 'lucide:gauge', 'message-lines': 'lucide:message-square-text', 'microchip-ai': 'lucide:cpu',
  'rectangle-history': 'lucide:gallery-vertical-end', snake: 'lucide:worm', 'spinner-third': 'lucide:loader',
  'wave-pulse': 'lucide:activity',
  // Pro names that are bundled as Lucide glyphs, so they stay visible when Font Awesome is selected.
  'rocket-launch': 'lucide:rocket', 'party-horn': 'lucide:party-popper', 'brackets-curly': 'lucide:braces',
  'code-simple': 'lucide:code', 'grid-round': 'lucide:grid-3x3', 'link-simple': 'lucide:link-2', 'circle-x': 'lucide:circle-x',
}

/**
 * The names Font Awesome Free 7.3.1 ships in its `regular` set (aliases included). Free's
 * `solid` set is far larger, and Pro's `regular` set is what Mintlify serves by default, so
 * a `regular` request for any other name would 404 and leave a blank icon. Those names use
 * the solid asset instead.
 */
const FREE_REGULAR_ICONS: ReadonlySet<string> = new Set(`
  address-book address-card alarm-clock angry arrow-alt-circle-down arrow-alt-circle-left arrow-alt-circle-right
  arrow-alt-circle-up bar-chart bell bell-slash bookmark building calendar calendar-alt calendar-check
  calendar-days calendar-minus calendar-plus calendar-times calendar-xmark camera camera-alt caret-square-down
  caret-square-left caret-square-right caret-square-up chart-bar check-circle check-square chess-bishop chess-king
  chess-knight chess-pawn chess-queen chess-rook circle circle-check circle-dot circle-down circle-left
  circle-pause circle-play circle-question circle-right circle-stop circle-up circle-user circle-xmark clipboard
  clock clock-four clone closed-captioning cloud comment comment-alt comment-dots commenting comments compass
  contact-book contact-card copy copyright credit-card credit-card-alt dizzy dot-circle drivers-license edit
  envelope envelope-open eye eye-slash face-angry face-dizzy face-flushed face-frown face-frown-open face-grimace
  face-grin face-grin-beam face-grin-beam-sweat face-grin-hearts face-grin-squint face-grin-squint-tears
  face-grin-stars face-grin-tears face-grin-tongue face-grin-tongue-squint face-grin-tongue-wink face-grin-wide
  face-grin-wink face-kiss face-kiss-beam face-kiss-wink-heart face-laugh face-laugh-beam face-laugh-squint
  face-laugh-wink face-meh face-meh-blank face-rolling-eyes face-sad-cry face-sad-tear face-smile face-smile-beam
  face-smile-wink face-surprise face-tired file file-alt file-archive file-audio file-clipboard file-code
  file-excel file-image file-lines file-pdf file-powerpoint file-text file-video file-word file-zipper flag
  floppy-disk flushed folder folder-blank folder-closed folder-open font-awesome font-awesome-flag
  font-awesome-logo-full frown frown-open futbol futbol-ball gem grimace grin grin-alt grin-beam grin-beam-sweat
  grin-hearts grin-squint grin-squint-tears grin-stars grin-tears grin-tongue grin-tongue-squint grin-tongue-wink
  grin-wink hand hand-back-fist hand-lizard hand-paper hand-peace hand-point-down hand-point-left hand-point-right
  hand-point-up hand-pointer hand-rock hand-scissors hand-spock handshake handshake-alt handshake-simple
  hard-drive hdd headphones headphones-alt headphones-simple heart home home-alt home-lg-alt hospital hospital-alt
  hospital-wide hourglass hourglass-2 hourglass-empty hourglass-half house id-badge id-card image images keyboard
  kiss kiss-beam kiss-wink-heart laugh laugh-beam laugh-squint laugh-wink lemon life-ring lightbulb list-alt map
  meh meh-blank meh-rolling-eyes message minus-square money-bill-1 money-bill-alt moon newspaper note-sticky
  object-group object-ungroup paper-plane paste pause-circle pen-to-square play-circle plus-square question-circle
  rectangle-list rectangle-times rectangle-xmark registered sad-cry sad-tear save share-from-square share-square
  smile smile-beam smile-wink snowflake soccer-ball square square-caret-down square-caret-left square-caret-right
  square-caret-up square-check square-full square-minus square-plus star star-half star-half-alt star-half-stroke
  sticky-note stop-circle sun surprise thumbs-down thumbs-up times-circle times-rectangle tired trash-alt
  trash-can truck user user-alt user-circle user-large vcard window-close window-maximize window-minimize
  window-restore xmark-circle
`.split(/\s+/).filter(Boolean))

/**
 * Pro draws a number in a circle (`circle-1`) and a letter in a square (`square-e`); Free has
 * neither, apart from `circle-h` and `square-h`. The content `Icon` draws them instead of
 * requesting an asset, under every library.
 */
export function badgeGlyph(name: string): { shape: 'circle' | 'square'; character: string } | null {
  const match = /^(circle|square)-([0-9a-z])$/.exec(name)
  if (!match || match[2] === 'h') return null
  return { shape: match[1] as 'circle' | 'square', character: match[2].toUpperCase() }
}

function fontAwesomeStyle(name: string, style: IconStyle | undefined): 'solid' | 'regular' | 'brands' {
  if (style === 'brands') return 'brands'
  // Free's regular set is small, so an explicit `regular` only gets it where it exists.
  if (style === 'regular' && FREE_REGULAR_ICONS.has(name)) return 'regular'
  // Font Awesome Free ships the broadest coverage in its solid set, so the
  // authoring default ("outline") lands there instead of a mostly-empty set.
  return 'solid'
}

/** Build the pinned CDN URL for one icon name in one library. */
export function iconLibraryAssetUrl(library: IconLibrary, name: string, style?: IconStyle): string {
  if (!ICON_NAME_PATTERN.test(name)) throw new Error(`Unsafe icon name: ${name}`)
  switch (library) {
    case 'fontawesome': {
      const fallback = FONT_AWESOME_PRO_FALLBACKS[name]
      if (fallback?.startsWith('lucide:')) return iconLibraryAssetUrl('lucide', fallback.slice(7))
      if (fallback) return iconLibraryAssetUrl('fontawesome', fallback, 'solid')
      return `${CDN_BASE}/@fortawesome/fontawesome-free@${FONT_AWESOME_VERSION}/svgs/${fontAwesomeStyle(name, style)}/${name}.svg`
    }
    case 'tabler':
      return `${CDN_BASE}/@tabler/icons@${TABLER_ICONS_VERSION}/icons/${style === 'solid' ? 'filled' : 'outline'}/${name}.svg`
    default:
      return `${CDN_BASE}/lucide-static@${LUCIDE_STATIC_VERSION}/icons/${name}.svg`
  }
}

/** Font Awesome brand URL used for the brand fallback under every library. */
export function fontAwesomeBrandUrl(name: string): string {
  return iconLibraryAssetUrl('fontawesome', name, 'brands')
}
