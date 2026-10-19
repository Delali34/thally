/**
 * Library-aware icon rendering for documentation content.
 *
 * Resolution order for a name: an inline brand mark, a drawn badge (a number in
 * a circle, a letter in a square), a Font Awesome brand fallback, then the
 * site's icon library. Bundled Lucide glyphs render inline
 * and stay hidden when the owner selects Font Awesome or Tabler, where the
 * same name resolves through a CSS mask to the pinned CDN asset. The layout
 * sets `html[data-icon-library]`, so client components never need the config.
 */
import type { CSSProperties } from 'react'
import {
  Activity, AlertCircle, Archive, ArrowRight, Award, Ban, Bell, BellRing, Book, BookOpen, Bookmark,
  Bot, Box, Boxes, Braces, Briefcase, Brush, Bug, Building2, Calendar, ChartBar, ChartLine, ChartPie,
  Check, CheckCircle, CircleCheck, CircleHelp, CircleX, Clipboard, ClipboardCheck, Clock, Cloud,
  CloudUpload, Code2, CodeXml, Cog, Command, Compass, Copy, Cpu, CreditCard, Database, DollarSign,
  Download, Droplet, ExternalLink, Eye, EyeOff, File, FileCode, FileText, Files, Filter, Fingerprint,
  Flag, Flame, FlaskConical, Folder, FolderOpen, Gauge, Gem, Gift, GitBranch, GitCommit, GitMerge,
  GitPullRequest, Github, Globe, GraduationCap, Grid3X3, Hammer, HardDrive, Hash, Heart, History,
  Home, Hourglass, Image, Inbox, Info, Key, KeyRound, Languages, Layers, LayoutGrid, Leaf, LibraryBig,
  Lightbulb, Link2, List, ListChecks, ListOrdered, Lock, Mail, Map, Megaphone, Menu, MessageCircle,
  MessageSquare, Monitor, Moon, Network, Newspaper, Package, PackageOpen, Palette, Paperclip,
  PartyPopper, Pen, Phone, Play, Plug, Plus, Power, Puzzle, Receipt, RefreshCw, Repeat, Rocket,
  RotateCw, Route, Rss, Save, Scale, Search, Send, Server, Settings, Share2, Shield, ShieldAlert,
  ShieldCheck, ShoppingCart, SlidersHorizontal, Smartphone, Sparkles, SquareTerminal, Star, Sun,
  Table, Tag, Terminal, ThumbsDown, ThumbsUp, Timer, Trash2, TrendingUp, TriangleAlert, Trophy,
  Twitter, Type, Unlock, Upload, User, Users, Video, Wallet, Wand2, Webhook, Wifi, Workflow, Wrench,
  Zap, ZoomIn,
  type LucideIcon,
} from 'lucide-react'
import { brandIconAliases, brandIcons } from '@/components/mdx/brand-icons'
import {
  FONT_AWESOME_BRAND_NAMES,
  ICON_NAME_PATTERN,
  badgeGlyph,
  fontAwesomeBrandUrl,
  iconLibraryAssetUrl,
  type IconStyle,
} from '@/lib/icon-library'
import { cn } from '@/lib/utils'

export type ContentIconTone = 'neutral' | 'accent'

/**
 * Bundled Lucide glyphs keyed by Lucide names plus the Font Awesome names
 * migrated content commonly uses. Anything absent still renders through the
 * library CDN, so this list only decides what works offline.
 */
const lucideIconMap: Record<string, LucideIcon> = {
  activity: Activity, alert: AlertCircle, 'alert-circle': AlertCircle, archive: Archive, 'box-archive': Archive,
  arrow: ArrowRight, 'arrow-right': ArrowRight, award: Award, ban: Ban, bell: Bell, 'bell-ring': BellRing,
  book: Book, 'book-open': BookOpen, books: LibraryBig, bookmark: Bookmark, bot: Bot, robot: Bot, box: Box,
  boxes: Boxes, 'boxes-stacked': Boxes, braces: Braces, 'brackets-curly': Braces, briefcase: Briefcase,
  brush: Brush, paintbrush: Brush, bug: Bug, building: Building2, calendar: Calendar, 'calendar-days': Calendar,
  'chart-bar': ChartBar, 'bar-chart': ChartBar, 'chart-simple': ChartBar, 'chart-line': ChartLine,
  'line-chart': ChartLine, 'chart-pie': ChartPie, 'pie-chart': ChartPie, check: Check, 'check-circle': CheckCircle,
  'circle-check': CircleCheck, 'circle-xmark': CircleX, 'circle-x': CircleX, help: CircleHelp,
  'circle-question': CircleHelp, question: CircleHelp, clipboard: Clipboard, 'clipboard-check': ClipboardCheck,
  clock: Clock, cloud: Cloud, 'cloud-arrow-up': CloudUpload, 'cloud-upload': CloudUpload, code: Code2,
  'code-simple': Code2, 'code-xml': CodeXml, cog: Cog, gears: Cog, command: Command, compass: Compass, copy: Copy,
  cpu: Cpu, microchip: Cpu, 'credit-card': CreditCard, database: Database, 'dollar-sign': DollarSign,
  dollar: DollarSign, download: Download, droplet: Droplet, external: ExternalLink, 'external-link': ExternalLink,
  eye: Eye, 'eye-off': EyeOff, 'eye-slash': EyeOff, file: File, 'file-code': FileCode, 'file-text': FileText,
  'file-lines': FileText, files: Files, filter: Filter, fingerprint: Fingerprint, flag: Flag, flame: Flame,
  fire: Flame, flask: FlaskConical, 'flask-conical': FlaskConical, folder: Folder, 'folder-open': FolderOpen,
  gauge: Gauge, 'gauge-high': Gauge, gear: Settings, gem: Gem, gift: Gift, 'git-branch': GitBranch,
  'code-branch': GitBranch, 'git-commit': GitCommit, 'code-commit': GitCommit, 'git-merge': GitMerge,
  'code-merge': GitMerge, 'git-pull-request': GitPullRequest, 'code-pull-request': GitPullRequest, github: Github,
  globe: Globe, 'graduation-cap': GraduationCap, grid: Grid3X3, 'grid-round': Grid3X3, hammer: Hammer,
  'hard-drive': HardDrive, hash: Hash, hashtag: Hash, heart: Heart, history: History,
  'clock-rotate-left': History, home: Home, house: Home, hourglass: Hourglass, image: Image, inbox: Inbox,
  info: Info, 'circle-info': Info, key: Key, 'key-round': KeyRound, languages: Languages, language: Languages,
  layers: Layers, 'layer-group': Layers, 'layout-grid': LayoutGrid, 'table-cells': LayoutGrid, leaf: Leaf,
  lightbulb: Lightbulb, link: Link2, 'link-simple': Link2, list: List, 'list-check': ListChecks,
  'list-checks': ListChecks, 'list-ol': ListOrdered, 'list-ordered': ListOrdered, lock: Lock, envelope: Mail,
  mail: Mail, map: Map, megaphone: Megaphone, bullhorn: Megaphone, menu: Menu, 'message-circle': MessageCircle,
  comment: MessageCircle, message: MessageSquare, comments: MessageSquare, monitor: Monitor, desktop: Monitor,
  display: Monitor, moon: Moon, network: Network, 'network-wired': Network, newspaper: Newspaper, package: Package,
  'package-open': PackageOpen, palette: Palette, paperclip: Paperclip, 'party-horn': PartyPopper,
  'party-popper': PartyPopper, pen: Pen, pencil: Pen, 'pen-to-square': Pen, phone: Phone, play: Play, plug: Plug,
  plus: Plus, power: Power, 'power-off': Power, puzzle: Puzzle, 'puzzle-piece': Puzzle, receipt: Receipt,
  'refresh-cw': RefreshCw, 'arrows-rotate': RefreshCw, repeat: Repeat, rocket: Rocket, 'rocket-launch': Rocket,
  rotate: RotateCw, 'rotate-cw': RotateCw, route: Route, rss: Rss, save: Save, 'floppy-disk': Save, scale: Scale,
  'scale-balanced': Scale, search: Search, 'magnifying-glass': Search, telegram: Send, send: Send,
  'paper-plane': Send, server: Server, settings: Settings, share: Share2, 'share-nodes': Share2, shield: Shield,
  'shield-halved': Shield, 'shield-alert': ShieldAlert, 'shield-check': ShieldCheck, 'shopping-cart': ShoppingCart,
  'cart-shopping': ShoppingCart, sliders: SlidersHorizontal, smartphone: Smartphone, mobile: Smartphone,
  'mobile-screen': Smartphone, sparkles: Sparkles, 'square-terminal': SquareTerminal, star: Star, sun: Sun,
  table: Table, tag: Tag, terminal: Terminal, 'thumbs-down': ThumbsDown, 'thumbs-up': ThumbsUp, timer: Timer,
  stopwatch: Timer, 'trash-2': Trash2, trash: Trash2, 'trash-can': Trash2, 'trending-up': TrendingUp,
  'arrow-trend-up': TrendingUp, 'triangle-alert': TriangleAlert, 'triangle-exclamation': TriangleAlert,
  warning: TriangleAlert, trophy: Trophy, twitter: Twitter, type: Type, font: Type, unlock: Unlock,
  'lock-open': Unlock, upload: Upload, user: User, 'circle-user': User, users: Users, 'user-group': Users,
  'people-group': Users, video: Video, wallet: Wallet, wand: Wand2, 'wand-magic': Wand2,
  'wand-magic-sparkles': Wand2, webhook: Webhook, wifi: Wifi, workflow: Workflow, 'diagram-project': Workflow,
  wrench: Wrench, 'screwdriver-wrench': Wrench, zap: Zap, bolt: Zap, 'bolt-lightning': Zap, 'zoom-in': ZoomIn,
  'magnifying-glass-plus': ZoomIn,
}

export interface IconProps {
  icon?: string
  src?: string
  iconType?: IconStyle
  className?: string
  color?: string
  size?: number | string
  'data-content-icon-tone'?: ContentIconTone | 'site'
}

function safeIconSource(src: string): boolean {
  return (src.startsWith('/') && !src.startsWith('//') && !src.includes('\\')) || /^https:\/\//i.test(src)
}

/** Strip Font Awesome class prefixes so `fa-solid fa-book` resolves like `book`. */
function normalizeIconName(icon: string): string {
  const tokens = icon.trim().toLowerCase().split(/\s+/)
  const last = tokens[tokens.length - 1] ?? ''
  return last.replace(/^fa-/, '')
}

function sizeStyle(size: number | string | undefined): CSSProperties | undefined {
  if (size === undefined) return undefined
  const value = typeof size === 'number' ? `${size}px` : size
  return { width: value, height: value }
}

/**
 * Render a named icon. Unknown names resolve through the configured library
 * and simply render nothing when the library has no such glyph.
 */
export function Icon({ icon, src: srcProp, iconType = 'outline', className, color, size, 'data-content-icon-tone': tone }: IconProps) {
  // Mintlify accepts an image path or URL anywhere an icon name is expected.
  const src = srcProp ?? (icon && /^(\/(?!\/)|https:\/\/)/i.test(icon) ? icon : undefined)
  if (src && safeIconSource(src)) {
    const resolvedSize = size ?? 20
    return (
      // eslint-disable-next-line @next/next/no-img-element -- authored icon sources are not constrained to a Next image loader.
      <img src={src} alt="" aria-hidden="true" width={resolvedSize} height={resolvedSize} className={cn('h-5 w-5 object-contain', className)} />
    )
  }

  const name = icon ? normalizeIconName(icon) : ''
  if (!name || !ICON_NAME_PATTERN.test(name)) return null

  const style: CSSProperties = { ...sizeStyle(size), ...(color ? { color } : {}) }
  const brand = brandIcons[brandIconAliases[name] ?? name]
  if (brand) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        className={cn('thally-icon h-5 w-5 shrink-0 text-accent', className)}
        style={style}
        data-icon-name={name}
        data-icon-source="brand"
        data-content-icon-tone={tone}
      >
        <path d={brand.path} />
      </svg>
    )
  }

  // Pro-only badge names (`circle-1`, `square-e`) have no asset in any library, so they are drawn.
  const badge = lucideIconMap[name] ? null : badgeGlyph(name)
  if (badge) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
        className={cn('thally-icon h-5 w-5 shrink-0 text-accent', className)}
        style={style}
        data-icon-name={name}
        data-icon-source="badge"
        data-content-icon-tone={tone}
      >
        {badge.shape === 'circle' ? <circle cx="12" cy="12" r="10" /> : <rect x="3" y="3" width="18" height="18" rx="3" />}
        <text x="12" y="12.5" textAnchor="middle" dominantBaseline="central" fill="currentColor" stroke="none" fontSize="12" fontWeight="600">
          {badge.character}
        </text>
      </svg>
    )
  }

  const fontAwesomeBrand = FONT_AWESOME_BRAND_NAMES.has(name)
  const Bundled: LucideIcon | undefined = fontAwesomeBrand ? undefined : lucideIconMap[name]
  const maskVars = fontAwesomeBrand
    ? { lucide: fontAwesomeBrandUrl(name), fontawesome: fontAwesomeBrandUrl(name), tabler: fontAwesomeBrandUrl(name) }
    : {
        lucide: iconLibraryAssetUrl('lucide', name),
        fontawesome: iconLibraryAssetUrl('fontawesome', name, iconType),
        tabler: iconLibraryAssetUrl('tabler', name, iconType),
      }
  const source = Bundled ? 'lucide' : 'library'

  return (
    <span
      aria-hidden="true"
      className={cn('thally-icon inline-flex h-5 w-5 shrink-0 items-center justify-center text-accent', className)}
      style={{
        ...style,
        ['--thally-icon-lucide' as string]: `url("${maskVars.lucide}")`,
        ['--thally-icon-fontawesome' as string]: `url("${maskVars.fontawesome}")`,
        ['--thally-icon-tabler' as string]: `url("${maskVars.tabler}")`,
      } as CSSProperties}
      data-icon-name={name}
      data-icon-source={source}
      data-content-icon-tone={tone}
    >
      {Bundled ? (
        <Bundled
          className={cn('thally-icon-glyph h-full w-full', iconType === 'solid' && 'fill-current')}
          color={color}
          strokeWidth={iconType === 'solid' ? 1.75 : 2}
          aria-hidden="true"
        />
      ) : null}
      <span className="thally-icon-mask" />
    </span>
  )
}
