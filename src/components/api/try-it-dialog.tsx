'use client'

/** Focus-contained API playground backed by the existing bounded request relay. */
import { useEffect, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, X } from 'lucide-react'
import { useApiLabels } from '@/components/api/api-locale'
import { CopyButton } from '@/components/api/copy-button'
import { TryItPanel, TryItResponse } from '@/components/api/try-it-panel'
import { Markdown } from '@/components/mdx/markdown'
import { CodeCard, CodeCardActions, CodeLines, LanguageMenu, useDocsLanguage } from '@/components/docs/code-card'
import { ParameterLinkProvider } from '@/components/api/parameter-link'
import { normalizeDocsLanguage, requestSnippetLineParameters } from '@/lib/openapi/code-snippets'
import { buildCodeSamples } from '@/lib/openapi/code-samples'
import { getTryItFields } from '@/components/api/try-it-fields'
import { getMethodToken } from '@/components/api/tokens'
import type { TryItController } from '@/components/api/use-try-it-controller'

interface TryItDialogProps {
  controller: TryItController
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Keep the runtime's second-click DELETE confirmation in both responsive toolbars. */
export function SendButton({ controller, mobile = false, onSend }: { controller: TryItController; mobile?: boolean; onSend?: () => void }) {
  const t = useApiLabels()
  return <button type="button" className="pg-send" style={controller.confirmingSend ? { background: 'var(--sx-k)', color: 'var(--docs-bg)' } : undefined} onClick={onSend ?? controller.requestSend} onBlur={controller.cancelSend} aria-busy={controller.isSending} disabled={controller.isSending || !controller.preparedRequest.isServerConfigured}>
    {controller.isSending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
    {controller.isSending ? t('sending') : controller.confirmingSend ? t('confirmDelete') : t('send')}
    {!mobile ? <kbd>⌘ / Ctrl ↵</kbd> : null}
  </button>
}

/** Open an operation as a responsive modal, preserving the invoking control's focus. */
export function TryItDialog({ controller, open, onOpenChange }: TryItDialogProps) {
  const t = useApiLabels()
  const sampleRequest = controller.sampleRequest ?? controller.preparedRequest
  const fields = controller.fields ?? getTryItFields(controller.operation)
  const samples = buildCodeSamples(sampleRequest, controller.operation.codeSamples)
  const [selectedLanguage, setLanguage] = useDocsLanguage(samples.map((sample) => sample.label))
  const currentSample = samples.find((sample) => normalizeDocsLanguage(sample.label) === normalizeDocsLanguage(selectedLanguage)) ?? samples[0]
  const language = currentSample?.label ?? 'cURL'
  const triggerRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const responseRef = useRef<HTMLDivElement>(null)
  const code = currentSample?.source ?? ''
  const lineParameters = requestSnippetLineParameters(code, sampleRequest, fields)

  function send() {
    if (controller.isSending || !controller.preparedRequest.isServerConfigured) return
    const errors = controller.validateRequest()
    const firstError = Object.keys(errors)[0]
    if (firstError) {
      const inputs = contentRef.current?.querySelectorAll<HTMLElement>('[data-field-id]')
      const target = Array.from(inputs ?? []).find((input) => input.dataset.fieldId === firstError) ?? (firstError.startsWith('body:') ? contentRef.current?.querySelector<HTMLElement>('[data-field-id="body:__raw"]') : undefined)
      target?.focus()
      return
    }
    controller.requestSend()
  }

  useEffect(() => {
    if (open && controller.response && window.matchMedia('(max-width: 980px)').matches) {
      responseRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    }
  }, [controller.response, open])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) controller.cancelSend(); onOpenChange(next) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="pg-scrim" />
        <ParameterLinkProvider>
          <Dialog.Content
            ref={contentRef}
            className="pg"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
              controller.restoreCredentials()
              event.preventDefault()
              requestAnimationFrame(() => {
                const content = contentRef.current
                const firstField = content?.querySelector<HTMLElement>('.pg-form input, .pg-form textarea, .pg-form select, .pg-form button[data-field-id]')
                const target = firstField ?? content?.querySelector<HTMLElement>('select, .pg-send:not(:disabled), .pg-x') ?? content
                target?.focus()
              })
            }}
            onEscapeKeyDown={(event) => {
              // The language menu consumes the first Escape before the modal closes.
              if (contentRef.current?.querySelector('[role="menu"]')) event.preventDefault()
            }}
            onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus() }}
            onChangeCapture={controller.cancelSend}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send() }
            }}
          >
            <header className="pg-top">
              <div className="pg-env">
                {controller.operation.servers.length > 1 ? <select aria-label={t('apiServer')} value={controller.serverUrl} disabled={controller.isSending} onChange={(event) => controller.setServerUrl(event.target.value)}>
                  {controller.operation.servers.map((server) => <option key={server.url} value={server.url}>{server.description || server.url}</option>)}
                </select> : <span>{controller.operation.servers[0]?.description || t('apiServer')}</span>}
              </div>
              <div className="pg-url">
                <b className={`m ${getMethodToken(controller.operation.method).text}`}>{controller.operation.method}</b>
                <div className="pg-addr" aria-label="Request URL" title={controller.preparedRequest.url}>
                  <RequestAddress controller={controller} />
                </div>
                <CopyButton value={controller.preparedRequest.url} label={`${t('copy')} URL`} disabled={!controller.preparedRequest.isServerConfigured} />
              </div>
              <SendButton controller={controller} onSend={send} />
              <Dialog.Close className="pg-x" aria-label={t('close')}><X aria-hidden="true" /></Dialog.Close>
            </header>
            <div className="pg-body">
              <div className="pg-form-pane">
                <div className="pg-head"><Dialog.Title>{controller.operation.title}</Dialog.Title>{controller.operation.description ? <div className="pg-summary"><Markdown>{controller.operation.description}</Markdown></div> : null}</div>
                <TryItPanel controller={controller} variant="dialog" showHeading={false} onSend={() => void send()} />
              </div>
              <aside className="pg-side" aria-label="Request and response">
                <CodeCard title={t('request')} tools={<><LanguageMenu value={language} onChange={setLanguage} options={samples.map((sample) => sample.label)} label={t('selectLanguage')} /><CodeCardActions code={code} language={language} ask={false} /></>}>
                  <CodeLines code={code || 'Configure an API server to preview the request.'} parameters={fields.map((field) => field.name)} lineParameters={lineParameters} />
                </CodeCard>
                <div ref={responseRef}><TryItResponse response={controller.response} isSending={controller.isSending} /></div>
              </aside>
            </div>
            <footer className="pg-foot"><SendButton controller={controller} onSend={send} mobile /></footer>
          </Dialog.Content>
        </ParameterLinkProvider>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RequestAddress({ controller }: { controller: TryItController }) {
  const path = controller.operation.path.split(/({[^}]+})/g)
  const query = controller.preparedRequest.url.split('?')[1]
  return <>{controller.serverUrl.replace(/\/$/, '')}{path.map((part, index) => {
    const match = /^{([^}]+)}$/.exec(part)
    if (!match) return <span key={index}>{part}</span>
    const value = controller.pathParams[match[1]]
    return <span key={index} className={`pg-tok${value ? ' set' : controller.errors?.[`path:${match[1]}`] ? ' miss' : ''}`}>{value ? encodeURIComponent(value) : part}</span>
  })}{query ? `?${query}` : ''}</>
}
