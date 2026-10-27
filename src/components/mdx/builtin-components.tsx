/**
 * Thally's built-in MDX component registry, with no dependency on
 * `src/mdx/custom-components.tsx` (the migration-generated, customer-owned
 * registry). Keeping that dependency out of this file matters: a component
 * migration extracts into its own client module, and that module resolves
 * a built-in it references by importing from here directly (see
 * `packages/migrate/src/components.ts`'s `resolveInlineBuiltinReferences`).
 * `custom-components.tsx` itself imports every such extracted module, so if
 * this file also imported `custom-components.tsx` (as `mdx-components.tsx`
 * does, to merge in customer-registered components), that extracted module
 * would close a circular import back to the registry that is still loading
 * it — which throws a "cannot access before initialization" error at
 * runtime once bundled. `mdx-components.tsx` is the one place that merges
 * this map with the customer registry.
 */

import type { MDXComponents } from 'mdx/types'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Note, type NoteProps } from '@/components/mdx/note'
import { AgentPrompt } from '@/components/mdx/agent-prompt'
import { Code, CodeBlock, CodeGroup, Pre } from '@/components/mdx/code-blocks'
import {
  Column, Columns, Frame, Hero,
} from '@/components/mdx/rich-content'
import { Video, YouTube, LiteYouTubeEmbed } from '@/components/mdx/video'
import { Latex } from '@/components/mdx/latex'
import { Accordion, AccordionGroup } from '@/components/mdx/accordion'
import { Card, CardGroup, Tile, TileGroup } from '@/components/mdx/content-cards'
import { Icon } from '@/components/mdx/content-icon'
import { Badge, Tooltip } from '@/components/mdx/content-inline'
import { Color } from '@/components/mdx/color'
import { Update } from '@/components/mdx/content-metadata'
import { Panel, ContentPanel, InlinePanel } from '@/components/mdx/panel'
import {
  RequestExample,
  ResponseExample,
  InlineRequestExample,
  InlineResponseExample,
} from '@/components/mdx/examples'
import {
  Prompt,
  PromptAssistant,
  PromptUser,
  Terminal,
  TerminalInput,
  TerminalOutput,
} from '@/components/mdx/prompt'
import { Tree, Folder, File } from '@/components/mdx/file-tree'
import { ResponseField, ParamField, Expandable } from '@/components/mdx/api-fields'
import { Mermaid } from '@/components/mdx/mermaid'
import { Embed, LegacyView, View } from '@/components/mdx/view'
import { GitHub } from '@/components/mdx/github-card'
import { Agent, Human, Visibility } from '@/components/mdx/visibility'
import { BannerPreview } from '@/components/layout/site-banner'
import { Steps, Step } from '@/components/mdx/steps'
import { Tabs, Tab } from '@/components/mdx/content-tabs'
import { HeadingAnchor } from '@/components/mdx/heading-anchor'
import { node, oneOf, requiredText, text, textList, textOrList, withPropContract, type PropContract } from '@/lib/mdx-prop-contract'
import { cn, slugify } from '@/lib/utils'

function flattenText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (typeof node === 'object' && node && 'props' in node) {
    return flattenText((node as { props?: { children?: ReactNode } }).props?.children ?? '')
  }
  return ''
}

function createHeading(level: 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const
  return function Heading({ children, id: authoredId }: { children: ReactNode; id?: string }) {
    const text = flattenText(children)
    const id = authoredId ?? slugify(text)
    return (
      // Size, weight, color, and rhythm come from the prose config in
      // tailwind.config.ts so MDX and plain-markdown headings share one scale.
      <Tag
        id={id}
        data-heading={text}
        data-level={level}
        className="scroll-mt-24"
      >
        <HeadingAnchor id={id}>
          {children}
        </HeadingAnchor>
      </Tag>
    )
  }
}

type CodeGroupProps = ComponentPropsWithoutRef<typeof CodeGroup>

// Migrated content may pass `type` as anything; Note normalises it.
interface CalloutProps extends Omit<NoteProps, 'type' | 'children'> {
  type?: unknown
  children?: ReactNode
}

export const builtinMdxComponents: MDXComponents = {
  h2: createHeading(2),
  h3: createHeading(3),
  h4: createHeading(4),
  h5: createHeading(5),
  h6: createHeading(6),
  pre: (props) => <Pre {...(props as CodeGroupProps)} />,
  code: (props) => <Code {...props} />,
  CodeGroup: (props) => <CodeGroup {...(props as CodeGroupProps)} />,
  CodeBlock: (props) => <CodeBlock {...(props as ComponentPropsWithoutRef<typeof CodeBlock>)} />,
  Info: (props) => <Note type="info" {...props} />,
  Warning: (props) => <Note type="warning" {...props} />,
  Check: (props) => <Note type="check" {...props} />,
  Danger: (props) => <Note type="danger" {...props} />,
  Error: (props) => <Note type="danger" {...props} />,
  Note: (props) => <Note type="note" {...props} />,
  Tip: (props) => <Note type="tip" {...props} />,
  // Callout: the generic form. Authors use it for custom callouts
  // (`<Callout icon="key" color="#C77DFF">`); migrated content uses it with a
  // `type`, which Note resolves through its alias map (`success`, `error`) or
  // infers from the wording when the value is unknown.
  Callout: ({ type, children, ...props }: CalloutProps) => {
    if (!children) return null
    return <Note type={typeof type === 'string' ? type : undefined} {...props}>{children}</Note>
  },
  AccordionGroup: (props) => <AccordionGroup {...props} />,
  Latex: (props) => <Latex {...(props as ComponentPropsWithoutRef<typeof Latex>)} />,
  // MDX: Mintlify pass-through wrapper — children are already compiled MDX.
  MDX: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Hero: (props) => <Hero {...props} />,
  Card: (props) => <Card {...props} />,
  CardGroup: (props) => <CardGroup {...props} />,
  Columns: (props) => <Columns {...props} />,
  Column: (props) => <Column {...props} />,
  Frame: (props) => <Frame {...props} />,
  Video: (props) => <Video {...(props as ComponentPropsWithoutRef<typeof Video>)} />,
  YouTube: (props) => <YouTube {...(props as ComponentPropsWithoutRef<typeof YouTube>)} />,
  LiteYouTubeEmbed: (props) => <LiteYouTubeEmbed {...(props as ComponentPropsWithoutRef<typeof LiteYouTubeEmbed>)} />,
  Accordion: (props) => <Accordion {...props} />,
  Tooltip: (props) => <Tooltip {...props} />,
  Icon: (props) => <Icon {...props} />,
  Steps: (props) => <Steps {...props} />,
  Step: (props) => <Step {...props} />,
  Tabs: (props) => <Tabs {...props} />,
  Tab: (props) => <Tab {...props} />,
  // Phase 1 additions
  Badge: (props) => <Badge {...props} />,
  Update: (props) => <Update {...props} />,
  RequestExample: (props) => <RequestExample {...props} />,
  ResponseExample: (props) => <ResponseExample {...props} />,
  Panel: (props) => <Panel {...props} />,
  ContentPanel: (props) => <ContentPanel {...props} />,
  InlinePanel: (props) => <InlinePanel {...props} />,
  InlineRequestExample: (props) => <InlineRequestExample {...props} />,
  InlineResponseExample: (props) => <InlineResponseExample {...props} />,
  Tile: (props) => <Tile {...props} />,
  TileGroup: (props) => <TileGroup {...props} />,
  Prompt: (props) => <Prompt {...props} />,
  PromptUser: (props) => <PromptUser {...props} />,
  PromptAssistant: (props) => <PromptAssistant {...props} />,
  Terminal: (props) => <Terminal {...props} />,
  TerminalInput: (props) => <TerminalInput {...props} />,
  TerminalOutput: (props) => <TerminalOutput {...props} />,
  AgentPrompt: (props) => <AgentPrompt {...props} />,
  // Preserve compound members used by generated MDX (`Color.Item` and
  // `Color.Row`). A wrapper component would discard those static properties.
  Color,
  'Color.Item': (props) => <Color.Item {...props} />,
  'Color.Row': (props) => <Color.Row {...props} />,
  Tree: (props) => <Tree {...props} />,
  // Mintlify treats `<FileTree>` as an alias of `<Tree>`.
  FileTree: (props) => <Tree {...props} />,
  Folder: (props) => <Folder {...props} />,
  File: (props) => <File {...props} />,
  ResponseField: (props) => <ResponseField {...props} />,
  ParamField: (props) => <ParamField {...props} />,
  Expandable: (props) => <Expandable {...props} />,
  Mermaid: (props) => <Mermaid {...(props as { children: string })} />,
  View: (props) => <View {...props} />,
  Embed: (props) => <Embed {...props} />,
  LegacyView: (props) => <LegacyView {...props} />,
  // Preserve the compound member used by generated MDX (`GitHub.Repo`). A
  // wrapper component would discard that static property.
  GitHub,
  Github: GitHub,
  'GitHub.Repo': (props) => <GitHub.Repo {...props} />,
  Visibility: (props) => <Visibility {...props} />,
  Human: (props) => <Human {...props} />,
  Agent: (props) => <Agent {...props} />,
  BannerPreview: (props) => <BannerPreview {...props} />,
  // Mintlify-parity alias: an inline banner announcement in MDX.
  Banner: (props) => <BannerPreview {...props} />,
  // Documentation screenshots are commonly below the fold. Native lazy
  // loading keeps them out of the critical request queue while preserving
  // standard Markdown image authoring and Frame zoom behavior.
  img: ({ alt = '', ...props }) => (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary MDX image sources cannot use a fixed Next loader.
    <img alt={alt} loading="lazy" decoding="async" {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-6 overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  ),
  th: (props) => <th className="border-b border-border py-2 pr-4 text-left font-mono text-[0.68rem] font-medium uppercase tracking-[0.12em] text-foreground/55" {...props} />,
  td: (props) => <td className="border-b border-border py-3 pr-4 text-[0.88rem] leading-[1.6] text-foreground/80" {...props} />,
}

/**
 * The props these entries read as something other than a node: string methods,
 * URL checks, ids, `.map`, a tag name. The MDX interpreter holds each entry to
 * its contract, so JSX, a number, a bare attribute or an object under one of
 * these names is dropped instead of reaching `.trim()` and taking the page
 * down. The node-valued props (`Card`'s `title`, `Tooltip`'s `tip`) are not
 * listed: they keep the interpreter's global rules, so JSX still renders there.
 * Declared on the function the interpreter receives, which for the wrappers
 * above is the wrapper itself.
 */
const noteContract = { icon: text, color: text, colorDark: text }
const codeContract = { icon: text, language: text, code: text }
const cardContract = { href: text, img: text }
const colorContract = { hex: text }
const stepTitleSize = oneOf('p', 'h2', 'h3', 'h4')
const embedContract = { src: requiredText }
const bannerContract = { content: requiredText }

const propContracts: Array<[unknown, PropContract]> = [
  ...(['Info', 'Warning', 'Check', 'Danger', 'Error', 'Note', 'Tip', 'Callout'] as const)
    .map((name): [unknown, PropContract] => [builtinMdxComponents[name], noteContract]),
  // A code panel reads its source, language and icon from the first element it holds, which is
  // a `code` element or a CodeBlock, so those carry the same contract as the panel itself.
  [builtinMdxComponents.pre, codeContract],
  [builtinMdxComponents.code, codeContract],
  [builtinMdxComponents.CodeGroup, codeContract],
  [builtinMdxComponents.CodeBlock, codeContract],
  [builtinMdxComponents.Prompt, { icon: text, actions: textOrList }],
  [builtinMdxComponents.Tooltip, { href: text }],
  [builtinMdxComponents.Card, cardContract],
  [builtinMdxComponents.Tile, cardContract],
  [builtinMdxComponents.Hero, { primaryHref: text, secondaryHref: text, primaryLabel: node, secondaryLabel: node }],
  [builtinMdxComponents.Video, { src: requiredText, poster: text }],
  [builtinMdxComponents.Accordion, { icon: text, title: requiredText }],
  [builtinMdxComponents.Icon, { icon: text, src: text }],
  [builtinMdxComponents.Steps, { titleSize: stepTitleSize }],
  [builtinMdxComponents.Step, { title: text, titleSize: stepTitleSize }],
  [builtinMdxComponents.Update, { label: text, date: text, tags: textOrList }],
  [builtinMdxComponents.ResponseField, { pre: textList, post: textList }],
  [builtinMdxComponents.Embed, embedContract],
  [builtinMdxComponents.LegacyView, embedContract],
  [builtinMdxComponents.View, { icon: text }],
  [builtinMdxComponents.Banner, bannerContract],
  [builtinMdxComponents.BannerPreview, bannerContract],
  // `GitHub`, `Github` and `GitHub.Repo` resolve to this one function.
  [GitHub, { repo: requiredText, title: text }],
  // `Color` and the `Color.Item` MDX resolves are the components themselves, not the wrappers keyed above.
  [Color, colorContract],
  [Color.Item, colorContract],
]
for (const [component, contract] of propContracts) withPropContract(component, contract)
