'use client'

/** Schema-driven request fields and the real relay response, shared by modal and inline views. */
import { useId, useState } from 'react'
import { useApiLabels } from '@/components/api/api-locale'
import { BodyForm } from '@/components/api/body-form'
import { isFormEditable } from '@/lib/openapi/body-form'
import { isSendableScheme } from '@/lib/openapi/auth'
import { getTryItFields, parseBodyObject, usesStructuredBodyForm } from '@/components/api/try-it-fields'
import { MANUAL_NO_SERVER, type TryItController } from '@/components/api/use-try-it-controller'
import type { TryItField } from '@/components/api/try-it-fields'
import { useParameterLink } from '@/components/api/parameter-link'
import { CodeCard, CodeCardActions, CodeLines } from '@/components/docs/code-card'

interface TryItPanelProps {
  controller: TryItController
  variant?: 'inline' | 'dialog'
  showHeading?: boolean
  onSend?: () => void
}

/** Render only fields declared by the selected operation, preserving JSON types. */
export function TryItPanel({ controller, variant = 'inline', showHeading = true, onSend }: TryItPanelProps) {
  const t = useApiLabels()
  const fields = controller.fields ?? getTryItFields(controller.operation)
  const groups = [
    [t('authorization'), fields.filter((field) => field.isCredential)],
    [t('pathParameters'), fields.filter((field) => field.group === 'path')],
    [t('queryParameters'), fields.filter((field) => field.group === 'query')],
    [t('headers'), fields.filter((field) => field.group === 'header' && !field.isCredential)],
  ] as const

  return (
    <section className="pg-form" id={variant === 'inline' ? 'try-it' : undefined}>
      {showHeading ? <h2>{t('tryIt')}</h2> : null}
      <p className="pg-note">
        {controller.preparedRequest.isServerConfigured
          ? `Requests are sent to ${controller.operation.servers.find((server) => server.url === controller.serverUrl)?.description || controller.serverUrl}. ${['GET', 'HEAD', 'OPTIONS'].includes(controller.operation.method) ? 'Use credentials for this server.' : 'This request may change data on that server.'}`
          : controller.operation.manualPage ? MANUAL_NO_SERVER : 'Add a server URL to the OpenAPI spec to enable requests.'}
      </p>
      <form onSubmit={(event) => { event.preventDefault(); if (onSend) onSend(); else controller.requestSend() }} noValidate>
        {groups.filter(([, fields]) => fields.length).map(([title, fields]) => (
          <section className="pg-sec" key={title} aria-label={title}>
            <h3>{title}</h3>
            {fields.map((field) => <TryItFieldRow key={field.id} controller={controller} field={field} />)}
          </section>
        ))}
        {controller.operation.authSchemes.some((scheme) => !isSendableScheme(scheme)) ? <p role="note" className="pg-note">{controller.operation.authSchemes.filter((scheme) => !isSendableScheme(scheme)).map((scheme) => `${scheme.paramName} (${scheme.in})`).join(', ')} is not sent from the playground, so this request goes out without it. Copy the code sample to send it.</p> : null}
        {controller.canSendBody ? <BodySection controller={controller} fields={fields.filter((field) => field.group === 'body')} /> : null}
        {!fields.length ? <p className="pg-note">This operation has no request parameters.</p> : null}
        {variant === 'inline' ? <button className="pg-send" type="submit" disabled={controller.isSending || !controller.preparedRequest.isServerConfigured}>{controller.confirmingSend ? t('confirmDelete') : t('send')}</button> : null}
      </form>
      {variant === 'inline' ? <TryItResponse response={controller.response} isSending={controller.isSending} /> : null}
    </section>
  )
}

/** Keep the complete runtime schema editor for unions, nested arrays, and binary uploads. */
function BodySection({ controller, fields }: { controller: TryItController; fields: TryItField[] }) {
  const t = useApiLabels()
  const { operation, bodyValue, setBodyValue, setFile } = controller
  const schema = operation.requestBody?.contents[0]?.schema
  const editable = isFormEditable(schema)
  const [raw, setRaw] = useState(!editable)
  let parsed: unknown
  try { parsed = bodyValue.trim() ? JSON.parse(bodyValue) : {} } catch { parsed = undefined }
  const showForm = editable && !raw && parsed !== undefined && schema !== undefined
  const bodyError = controller.errors?.['body:__raw'] ?? ((raw || usesStructuredBodyForm(operation)) ? Object.entries(controller.errors ?? {}).find(([key]) => key.startsWith('body:'))?.map((entry, index) => index === 0 ? entry.replace(/^body:/, '') : entry).join(': ') : undefined)
  return <section className="pg-sec" aria-label={t('requestBody')}>
    <div className="flex items-center justify-between gap-2">
      <h3>{t('requestBody')}</h3>
      {editable ? <button type="button" aria-pressed={raw} disabled={raw && parsed === undefined} onClick={() => setRaw(!raw)} className="rounded-[7px] border border-border px-2 py-1 text-xs disabled:opacity-40">JSON</button> : null}
    </div>
    {showForm ? usesStructuredBodyForm(operation) ?
      <div className="pg-in" data-field-id="body:__raw" tabIndex={-1}><BodyForm schema={schema} value={parsed} onChange={(next) => setBodyValue(JSON.stringify(next, null, 2))} onFile={setFile} /></div>
      : fields.map((field) => <TryItFieldRow key={field.id} controller={controller} field={field} />)
      : <div className={`pg-in${bodyError ? ' err' : ''}`}>
          <textarea data-field-id="body:__raw" aria-label={t('requestBody')} aria-invalid={Boolean(bodyError) || (parsed === undefined && Boolean(bodyValue.trim()))} value={bodyValue} onChange={(event) => setBodyValue(event.target.value)} />
        </div>}
    {bodyError ? <p role="alert" className="text-xs text-rose-500">{bodyError === 'Required' ? t('requiredCap') : bodyError === 'Enter valid JSON' ? t('notValidJson') : bodyError}</p> : null}
  </section>
}

function TryItFieldRow({ controller, field }: { controller: TryItController; field: TryItField }) {
  const t = useApiLabels()
  const id = useId()
  const [isRevealed, setIsRevealed] = useState(false)
  const { active, ...linkEvents } = useParameterLink(field.name)
  const body = parseBodyObject(controller.bodyValue)
  const fallback = field.authSchemeName ? controller.authValues[field.authSchemeName] : field.group === 'body' ? body[field.name] : (field.group === 'path' ? controller.pathParams : field.group === 'query' ? controller.queryParams : controller.headerParams)[field.name]
  const value = controller.fieldValues?.[field.id] ?? (typeof fallback === 'string' ? fallback : fallback === undefined ? '' : JSON.stringify(fallback))
  const error = controller.errors?.[field.id]
  const values = Array.isArray(field.schema.enum) ? field.schema.enum.map(String) : field.type === 'boolean' ? ['true', 'false'] : []
  const isMultiline = ['json', 'object', 'array'].includes(field.type) || field.id === 'body:__raw' || field.schema.format === 'multiline' || (field.group === 'body' && (/content|description|markdown|body/i.test(field.name) || value.includes('\n')))
  const inputProps = {
    id,
    'data-field-id': field.id,
    'aria-invalid': Boolean(error),
    'aria-describedby': `${id}-hint`,
    'aria-required': field.required,
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => controller.setFieldValue(field, event.target.value),
    autoComplete: 'off',
    spellCheck: false,
  }
  return (
    <div className={`pg-row${active ? ' on' : ''}`} data-p={field.name} {...linkEvents}>
      <label className="pg-lab" htmlFor={id}>
        <b>{field.name}</b><span>{field.type}</span>{field.required ? <span className="req">{t('required')}</span> : null}
      </label>
      <div className={`pg-in${error ? ' err' : ''}`}>
        {values.length && values.length <= 5 ? (
          <div className="pg-seg" role="group" aria-labelledby={id}>
            <span id={id} className="sr-only">{field.name}</span>
            {values.map((option, index) => <button key={option} type="button" data-field-id={index === 0 ? field.id : undefined} aria-pressed={value === option} aria-describedby={`${id}-hint`} onClick={() => controller.setFieldValue(field, option)}>{option}</button>)}
          </div>
        ) : values.length ? (
          <select {...inputProps}><option value="">Choose a value</option>{values.map((option) => <option key={option} value={option}>{option}</option>)}</select>
        ) : isMultiline && !field.isCredential ? <textarea {...inputProps} placeholder={typeof field.schema.example === 'string' ? field.schema.example : undefined} /> : (
          <div className={field.isCredential ? 'pg-key' : undefined}>
            <input {...inputProps} type={field.isCredential && !isRevealed ? 'password' : 'text'} inputMode={field.type === 'integer' || field.type === 'number' ? 'decimal' : undefined} placeholder={field.isCredential ? field.type === 'Basic credentials' ? 'username:password' : field.type === 'Bearer token' ? t('bearerPlaceholder') : t('keyPlaceholder') : typeof field.schema.example === 'string' ? field.schema.example : undefined} />
            {field.isCredential ? <button type="button" aria-label={`${isRevealed ? 'Hide' : 'Show'} ${field.name}`} onClick={() => setIsRevealed(!isRevealed)}>{isRevealed ? 'Hide' : 'Show'}</button> : null}
          </div>
        )}
        <span id={`${id}-hint`} className="hint" aria-live="polite">{(error === 'Required' ? t('requiredCap') : error) || field.description || (field.isCredential ? 'Kept in this browser tab for this server.' : '')}</span>
      </div>
    </div>
  )
}

/** Present upstream status, duration, UTF-8 body size, and returned headers honestly. */
export function TryItResponse({ response, isSending = false }: { response: TryItController['response']; isSending?: boolean }) {
  const t = useApiLabels()
  const [selection, setSelection] = useState<{ response: TryItController['response']; view: 'body' | 'headers' }>({ response: null, view: 'body' })
  const view = selection.response === response ? selection.view : 'body'
  const setView = (next: 'body' | 'headers') => setSelection({ response, view: next })
  const id = useId()
  const payload = response && 'status' in response ? response : null
  const code = payload ? view === 'headers' ? Object.entries(payload.headers).map(([key, value]) => `${key}: ${value}`).join('\n') : formatBody(payload.body) : ''
  const size = payload ? new TextEncoder().encode(payload.body).length : 0
  const sizeLabel = size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`
  return (
    <CodeCard title={t('response')} className="pg-res" tools={payload ? <CodeCardActions code={code} ask={false} /> : undefined}>
      <div className={`pg-response${isSending ? ' busy' : ''}`} aria-busy={isSending}>
        {payload ? <>
          <div className="pg-response-meta">
            <span role="status" className={`pg-stat${payload.status >= 400 ? ' err' : ''}`}><i />{payload.status} {payload.statusText}<em>· {payload.duration} ms · {sizeLabel}</em></span>
            <div className="pg-tabs" role="tablist" aria-label="Response view">
              {(['body', 'headers'] as const).map((tab) => <button key={tab} id={`${id}-${tab}`} type="button" role="tab" aria-selected={view === tab} aria-controls={`${id}-panel`} tabIndex={view === tab ? 0 : -1} onClick={() => setView(tab)} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'body' : event.key === 'End' ? 'headers' : tab === 'body' ? 'headers' : 'body'; setView(next); document.getElementById(`${id}-${next}`)?.focus() } }}>{tab === 'body' ? t('body') : t('headers')}</button>)}
            </div>
          </div>
          <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${view}`} tabIndex={0}><CodeLines code={code || '(Empty response body)'} animate /></div>
        </> : response && 'error' in response ? <p className="pg-response-error" role="alert">{response.error}</p> : <div className="pg-empty" role="status"><b>{isSending ? 'Sending request…' : t('sendToPreview')}</b><span>{isSending ? 'Waiting for the selected server.' : 'Fill in the required fields, then send.'}</span><kbd>⌘ / Ctrl + ↵</kbd></div>}
      </div>
    </CodeCard>
  )
}

function formatBody(body: string) {
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}

/** Backwards-compatible response renderer for existing API cards. */
export function ResponseBody({ body }: { body: string }) {
  return <CodeLines code={formatBody(body)} />
}
