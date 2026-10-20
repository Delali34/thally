'use client'

/** Documentation assistant dock; its scoped header offset follows wrapped navigation. */

import { useState, useRef, useEffect, useCallback } from 'react'
import NextImage from 'next/image'
import { SiteBrandMark } from '@/components/layout/site-brand-mark'
import { X, ArrowUp, Square, Maximize2, Minimize2, BookOpen, ChevronDown, ArrowUpRight, Paperclip, Copy, ThumbsUp, ThumbsDown, RefreshCw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { DEFAULT_AI_DISCLAIMER } from '@/lib/ai-defaults'
import {
  MAX_AI_CHAT_IMAGES,
  MAX_AI_CHAT_IMAGE_BYTES,
  createAiChatRequestMessages,
  isAiChatImageMediaType,
  type AiChatImage,
} from '@/lib/ai-chat-messages'
import {
  AI_ANSWER_SOURCES_HEADER,
  parseAiAnswerSources,
  type AiAnswerSource,
} from '@/lib/ai-answer-sources'
import {
  AI_FOLLOW_UPS_HEADER,
  deriveFollowUpSuggestions,
  normalizeAiSuggestions,
  parseAiFollowUps,
} from '@/lib/ai-chat-suggestions'

interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Array<AiAnswerSource>
  /** Model-written next questions supplied with this answer, when available. */
  followUps?: Array<string>
  images?: Array<ChatImage>
}

interface ChatImage extends AiChatImage {
  id: string
  name: string
}

const SCREENSHOT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

function screenshotSrc(image: AiChatImage): string {
  return `data:${image.mediaType};base64,${image.data}`
}

function screenshotId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `screenshot-${Date.now()}-${Math.random()}`
}

function readScreenshot(file: File): Promise<ChatImage> {
  const mediaType = file.type
  if (!isAiChatImageMediaType(mediaType)) {
    return Promise.reject(new Error('Use a PNG, JPEG, GIF, or WebP image.'))
  }
  if (file.size > MAX_AI_CHAT_IMAGE_BYTES) {
    return Promise.reject(new Error('Each screenshot must be 3 MB or smaller.'))
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('This screenshot could not be read.'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const marker = ';base64,'
      const markerIndex = result.indexOf(marker)
      if (markerIndex < 0) {
        reject(new Error('This screenshot could not be read.'))
        return
      }
      resolve({
        id: screenshotId(),
        name: file.name || 'Pasted screenshot',
        mediaType,
        data: result.slice(markerIndex + marker.length),
      })
    }
    reader.readAsDataURL(file)
  })
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
        />
      ))}
    </span>
  )
}

/**
 * Suggested questions. The list is always supplied by the caller — opening
 * questions from the site's navigation, follow-ups from the conversation — and
 * the block disappears entirely when there is nothing relevant to offer.
 */
export function SuggestionLinks({
  label,
  suggestions,
  onSelect,
}: {
  label: string
  suggestions: ReadonlyArray<string>
  onSelect: (suggestion: string) => void
}) {
  if (suggestions.length === 0) return null
  return (
    <nav className="mt-6 border-t border-border/60 pt-4" aria-label={label}>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-col items-start gap-1.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSelect(suggestion)}
            className="text-left text-sm text-accent transition-colors hover:text-foreground"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </nav>
  )
}

/** Compact evidence drawer shown before each grounded assistant answer. */
export function AnswerSources({ sources }: { sources: Array<AiAnswerSource> }) {
  if (sources.length === 0) return null
  const label = `Read ${sources.length} ${sources.length === 1 ? 'page' : 'pages'}`

  return (
    <details className="thally-docs-chat-sources group mb-3 border-b text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-border/60 py-1.5">
        {sources.map((source) => (
          <a
            key={source.url}
            href={source.url}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground"
          >
            <span className="min-w-0 flex-1 truncate">{source.title}</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </a>
        ))}
      </div>
    </details>
  )
}

interface DocsChatProps {
  label?: string
  icon?: string
  /** False when this deployment cannot currently answer questions. */
  enabled?: boolean
  /** Explains why this site cannot currently answer questions. */
  unavailableMessage?: string
  /** Status was already resolved by the lazy loader. */
  skipStatusCheck?: boolean
  /** Opening questions derived from this site's navigation by the status route. */
  starterSuggestions?: ReadonlyArray<string>
  /** Code-sample action awaiting display when this lazy panel mounts. */
  initialPrompt?: string | null
  /** Increments for each external request to open the chat panel. */
  openRequestId?: number
}

export function DocsChat({
  label = 'Ask AI',
  enabled = true,
  unavailableMessage = 'AI chat is unavailable. Try searching the documentation.',
  skipStatusCheck = false,
  starterSuggestions,
  initialPrompt,
  openRequestId,
}: DocsChatProps) {
  // Set only when this component resolves status itself; otherwise the lazy
  // loader's prop is the source, including when it arrives after mount.
  const [fetchedStarters, setFetchedStarters] = useState<Array<string> | null>(null)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Keep the optional widget out of first paint. The tiny status endpoint is
  // deliberately separate so live admin toggles do not make docs pages
  // dynamic or delay navigation.
  const [chatShown, setChatShown] = useState(skipStatusCheck)
  // Live admin overrides — SSR'd prop is the first-paint value; the chat-status
  // fetch swaps in the admin's custom name / disclaimer when set. Disclaimer
  // starts on its generic default so a safety notice always shows, even if the
  // fetch is slow or fails.
  const [liveLabel, setLiveLabel] = useState(label)
  const [disclaimer, setDisclaimer] = useState(DEFAULT_AI_DISCLAIMER)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<Array<ChatImage>>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<number, 'up' | 'down'>>({})
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }, [input])

  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 60)
  }, [open])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('thally-docs-ai-open', open && chatShown)
    root.classList.toggle('thally-docs-ai-expanded', open && chatShown && expanded)
    return () => {
      root.classList.remove('thally-docs-ai-open', 'thally-docs-ai-expanded')
    }
  }, [chatShown, expanded, open])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [open])

  useEffect(() => {
    if (!openRequestId) return
    if (initialPrompt) setInput(initialPrompt)
    setOpen(true)
  }, [initialPrompt, openRequestId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setLoading(false)
  }, [])

  const addScreenshots = useCallback(async (files: ReadonlyArray<File>) => {
    if (files.length === 0) return
    const availableSlots = MAX_AI_CHAT_IMAGES - pendingImages.length
    if (availableSlots <= 0) {
      setAttachmentError(`You can attach up to ${MAX_AI_CHAT_IMAGES} screenshots.`)
      return
    }
    if (files.length > availableSlots) {
      setAttachmentError(`You can attach up to ${MAX_AI_CHAT_IMAGES} screenshots.`)
    } else {
      setAttachmentError('')
    }

    const selected = files.slice(0, availableSlots)
    const results = await Promise.allSettled(selected.map(readScreenshot))
    const images = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') {
      setAttachmentError(
        failure.reason instanceof Error
          ? failure.reason.message
          : 'This screenshot could not be attached.',
      )
    }
    if (images.length > 0) {
      setPendingImages((current) => [...current, ...images].slice(0, MAX_AI_CHAT_IMAGES))
    }
  }, [pendingImages.length])

  const removeScreenshot = useCallback((id: string) => {
    setPendingImages((current) => current.filter((image) => image.id !== id))
    setAttachmentError('')
  }, [])

  // Respect the admin's live enable/disable toggle (hide if off) and pick up the
  // admin's custom assistant name + disclaimer.
  useEffect(() => {
    if (skipStatusCheck) return
    let active = true
    fetch('/api/chat-status')
      .then((r) => (r.ok ? r.json() : { show: false }))
      .then((d) => {
        if (!active || !d) return
        setChatShown(d.show === true)
        if (typeof d.label === 'string' && d.label) setLiveLabel(d.label)
        if (typeof d.disclaimer === 'string') setDisclaimer(d.disclaimer)
        setFetchedStarters(normalizeAiSuggestions(d.suggestions))
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [skipStatusCheck])

  const send = useCallback(async (text?: string) => {
    const typedContent = (text ?? input).trim()
    if (!enabled || !chatShown || (!typedContent && pendingImages.length === 0) || loading) return

    const images = pendingImages
    const content = typedContent || (
      images.length === 1
        ? 'What should I know about this screenshot?'
        : 'What should I know about these screenshots?'
    )

    const userMsg: Message = { role: 'user', content, images }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setPendingImages([])
    setAttachmentError('')
    setLoading(true)

    const assistantMsg: Message = { role: 'assistant', content: '', sources: [] }
    setMessages((prev) => [...prev, assistantMsg])

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: createAiChatRequestMessages([...messages, userMsg]),
        }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const errText = await res.text()
        setMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = { role: 'assistant', content: errText || 'Something went wrong.' }
          return next
        })
        return
      }

      const sources = parseAiAnswerSources(
        res.headers.get(AI_ANSWER_SOURCES_HEADER),
      )
      const followUps = parseAiFollowUps(res.headers.get(AI_FOLLOW_UPS_HEADER))
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { ...next[next.length - 1], sources, followUps }
        return next
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        setMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = {
            ...next[next.length - 1],
            content: next[next.length - 1].content + chunk,
          }
          return next
        })
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { role: 'assistant', content: 'Failed to connect. Please try again.' }
        return next
      })
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }, [chatShown, enabled, input, loading, messages, pendingImages])

  if (!chatShown) return null

  const starters = fetchedStarters ?? normalizeAiSuggestions(starterSuggestions ?? [])
  // Follow-ups belong to the latest finished answer. Prefer the questions the
  // answer service wrote for this conversation; otherwise derive them from the
  // pages retrieved for the latest question, which already track the topic.
  const latest = messages[messages.length - 1]
  const followUps = !loading && latest?.role === 'assistant' && latest.content
    ? latest.followUps?.length
      ? latest.followUps
      : deriveFollowUpSuggestions({
          sources: latest.sources ?? [],
          asked: messages.filter((message) => message.role === 'user').map((message) => message.content),
        })
    : []

  return open ? (
    <>
      {/* The dock starts below the shared top bar so navigation stays usable. */}
      <aside
          className="thally-docs-chat-panel fixed bottom-0 right-0 top-[var(--docs-header-height,60px)] z-[60] flex flex-col overflow-hidden border-l border-border"
          aria-label={liveLabel}
          style={{
            width: expanded ? 'min(680px, 100vw)' : 'min(420px, 100vw)',
            transition: 'width 0.2s var(--ds-ease-out, ease)',
          }}
        >
          {/* Header */}
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-5">
            <div className="flex items-center gap-2.5">
              <SiteBrandMark size={20} className="thally-docs-chat-brand h-5 w-5" />
              <span className="text-sm font-semibold">{liveLabel}</span>
              <span className="text-[10px] font-medium text-muted-foreground">
                Beta
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
                className="hidden h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
              >
                {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          {disclaimer ? (
            <p className="shrink-0 border-b border-border/60 px-5 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {disclaimer}
            </p>
          ) : null}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 pb-2 pt-6">
            {messages.length === 0 ? (
              /* Welcome state */
              <div className="flex h-full flex-col items-center justify-center gap-6 pb-4">
                <div className="flex flex-col items-center gap-3 text-center">
                  <SiteBrandMark size={32} className="thally-docs-chat-brand h-8 w-8" />
                  <div>
                    <p className="font-semibold">How can I help?</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Ask anything about the documentation.
                    </p>
                  </div>
                </div>
                <SuggestionLinks label="Suggestions" suggestions={starters} onSelect={(suggestion) => void send(suggestion)} />
              </div>
            ) : (
              <div className="flex flex-col gap-[22px]">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex min-w-0 gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'assistant' && (
                      <SiteBrandMark className="thally-docs-chat-brand mt-0.5 h-6 w-6 shrink-0" />
                    )}

                    {msg.role === 'user' ? (
                      /* User bubble */
                      <div className="thally-docs-chat-user max-w-[78%] overflow-hidden text-sm leading-relaxed">
                        {msg.images?.length ? (
                          <div className={`grid gap-1.5 p-1.5 pb-0 ${msg.images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                            {msg.images.map((image) => (
                              <NextImage
                                key={image.id}
                                src={screenshotSrc(image)}
                                alt={image.name}
                                width={280}
                                height={180}
                                unoptimized
                                className="max-h-44 w-full rounded-xl object-cover object-top"
                              />
                            ))}
                          </div>
                        ) : null}
                        <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          <span className="block px-4 py-2.5">{msg.content}</span>
                        </span>
                      </div>
                    ) : (
                      /* Assistant — no bubble, full prose */
                      <div className="min-w-0 flex-1 text-sm leading-relaxed">
                        <AnswerSources sources={msg.sources ?? []} />
                        {msg.content ? (
                          <>
                          <div className="prose prose-sm dark:prose-invert max-w-none break-words
                            [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_:not(pre)>code]:break-words
                            prose-p:leading-relaxed prose-p:my-2 first:prose-p:mt-0
                            prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-1
                            prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
                            prose-code:rounded prose-code:bg-zinc-100 prose-code:dark:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
                            prose-pre:rounded-xl prose-pre:bg-zinc-100 prose-pre:dark:bg-zinc-800 prose-pre:text-zinc-800 prose-pre:dark:text-zinc-100 prose-pre:text-xs prose-pre:p-4
                            [&_pre]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:border-0 [&_pre_code]:text-inherit [&_pre_code]:rounded-none [&_pre_*]:!no-underline [&_pre_*]:!border-0 [&_pre_*]:!decoration-transparent [&_pre_*]:!shadow-none
                            prose-blockquote:border-l-accent/40 prose-blockquote:text-muted-foreground
                            [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                          >
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
                          <div className="thally-docs-chat-feedback mt-2 flex items-center gap-0.5" aria-label="Answer actions">
                            <button type="button" onClick={() => void navigator.clipboard?.writeText(msg.content)} aria-label="Copy response" title="Copy response" className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"><Copy className="h-3.5 w-3.5" aria-hidden="true" /></button>
                            <button type="button" onClick={() => setFeedbackByMessage((current) => ({ ...current, [i]: 'up' }))} aria-label="Helpful response" title="Helpful response" aria-pressed={feedbackByMessage[i] === 'up'} className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"><ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
                            <button type="button" onClick={() => setFeedbackByMessage((current) => ({ ...current, [i]: 'down' }))} aria-label="Unhelpful response" title="Unhelpful response" aria-pressed={feedbackByMessage[i] === 'down'} className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"><ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
                            <button type="button" onClick={() => {
                              const previousQuestion = messages.slice(0, i).reverse().find((message) => message.role === 'user')
                              if (previousQuestion) void send(previousQuestion.content)
                            }} disabled={loading} aria-label="Regenerate response" title="Regenerate response" className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors disabled:opacity-35"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /></button>
                          </div>
                          </>
                        ) : loading && i === messages.length - 1 ? (
                          <TypingDots />
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
                <SuggestionLinks label="Follow-ups" suggestions={followUps} onSelect={(suggestion) => void send(suggestion)} />
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="shrink-0 px-4 pb-4 pt-2">
            {!enabled ? (
              <p className="mb-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {unavailableMessage}
              </p>
            ) : null}
            {/* The question sits on its own full-width line; attach and send share
                the row beneath it, so a long draft never crowds the controls. */}
            <div className="thally-docs-chat-composer rounded-[18px] border px-3 pb-2.5 pt-3">
              {pendingImages.length > 0 ? (
                <div className="mb-1.5">
                  <div className="flex gap-2 overflow-x-auto px-1 pt-1">
                    {pendingImages.map((image) => (
                      <div
                        key={image.id}
                        className="group/image relative h-14 w-20 shrink-0 overflow-hidden rounded-xl border border-border bg-background"
                      >
                        <NextImage
                          src={screenshotSrc(image)}
                          alt={image.name}
                          width={80}
                          height={56}
                          unoptimized
                          className="h-full w-full object-cover object-top"
                        />
                        <button
                          type="button"
                          onClick={() => removeScreenshot(image.id)}
                          aria-label={`Remove ${image.name}`}
                          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-foreground opacity-80 shadow-sm backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100"
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="px-2 pt-1.5 text-[10px] text-muted-foreground">
                    Screenshots are sent with this chat and not saved by Thally.
                  </p>
                </div>
              ) : null}
              {attachmentError ? (
                <p className="px-2 pb-1 text-[11px] text-destructive" role="status">
                  {attachmentError}
                </p>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                accept={SCREENSHOT_ACCEPT}
                multiple
                tabIndex={-1}
                className="sr-only"
                onChange={(event) => {
                  void addScreenshots(Array.from(event.target.files ?? []))
                  event.target.value = ''
                }}
              />
              <textarea
                  ref={textareaRef}
                  value={input}
                  rows={2}
                  aria-label={`Message ${liveLabel}`}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.items)
                      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                      .flatMap((item) => {
                        const file = item.getAsFile()
                        return file ? [file] : []
                      })
                    if (files.length > 0) void addScreenshots(files)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (enabled) void send()
                    }
                  }}
                  placeholder={enabled ? 'Ask a question…' : 'AI chat is unavailable.'}
                  disabled={loading || !enabled}
                  className="block w-full resize-none bg-transparent px-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-50"
                  style={{ maxHeight: '160px' }}
                />
              <div className="mt-2 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading || !enabled || pendingImages.length >= MAX_AI_CHAT_IMAGES}
                  aria-label="Attach screenshots"
                  title="Attach or paste screenshots"
                  className="thally-docs-chat-attach -ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-35"
                >
                  <Paperclip className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={loading ? stop : () => void send()}
                  disabled={!loading && (!enabled || (!input.trim() && pendingImages.length === 0))}
                  aria-label={loading ? 'Stop' : 'Send'}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all disabled:opacity-30"
                >
                  {loading
                    ? <Square className="h-3 w-3 fill-current" />
                    : <ArrowUp className="h-4 w-4" />
                  }
                </button>
              </div>
            </div>
          </div>
      </aside>
    </>
  ) : null
}
