'use client'

/** Handoff code cards preserve authored samples, media examples, and the latest live result. */
import { useId, useState } from 'react'
import type { TryItController } from '@/components/api/use-try-it-controller'
import { useApiLabels } from '@/components/api/api-locale'
import { CodeCard, CodeCardActions, CodeLines, LanguageMenu, useDocsLanguage } from '@/components/docs/code-card'
import { buildCodeSamples } from '@/lib/openapi/code-samples'
import { normalizeDocsLanguage, requestSnippetLineParameters } from '@/lib/openapi/code-snippets'
import { formatExample, responseExamples } from '@/lib/openapi/response-examples'

/** Use the credential-free sample projection; the modal owns editable request values. */
export function OperationCodePanel({ controller }: { controller: TryItController }) {
  const t = useApiLabels()
  const { operation, sampleRequest, response } = controller
  // An authored sample wins when two labels resolve to the same language.
  const availableSamples = buildCodeSamples(sampleRequest, operation.codeSamples).map((sample) => ({ ...sample, label: normalizeDocsLanguage(sample.label) }))
  const samples = availableSamples.filter((sample, index) => availableSamples.findIndex((candidate) => candidate.label === sample.label) === index)
  const [preferredLanguage, setLanguage] = useDocsLanguage(samples.map((sample) => sample.label))
  const sample = samples.find((item) => item.label === normalizeDocsLanguage(preferredLanguage)) ?? samples[0]
  const requestCode = sample?.source ?? t('noServer')
  const fields = controller.fields
  const parameters = fields.map((field) => field.name)
  const lineParameters = requestSnippetLineParameters(requestCode, sampleRequest, fields)
  const sent = response && 'body' in response ? response : null
  const [pick, setPick] = useState<{ code: string; at: unknown } | null>(null)
  const [exampleKeys, setExampleKeys] = useState<Record<string, string>>({})
  const activeCode = pick && pick.at === response ? pick.code : sent ? 'sent' : operation.responses[0]?.code ?? ''
  const activeResponse = operation.responses.find((item) => item.code === activeCode)
  const examples = activeResponse ? responseExamples(activeResponse) : []
  const example = examples.find((item) => item.key === exampleKeys[activeCode]) ?? examples[0]
  const responseCode = activeCode === 'sent' && sent ? sent.body : example ? formatExample(example.value) : t('noResponseBody')
  const tabs = [...(sent ? [{ code: 'sent', status: String(sent.status), label: `${t('result')} ${sent.status}` }] : []), ...operation.responses.map((item) => ({ code: item.code, status: item.code, label: item.code }))]
  const id = useId()
  return <div className="epcode">
    <CodeCard title={t('request')} tools={<>
      {sample ? <LanguageMenu value={sample.label} options={samples.map((item) => item.label)} onChange={setLanguage} label={t('selectLanguage')} /> : null}
      <CodeCardActions code={requestCode} language={sample?.label} />
    </>}><CodeLines code={requestCode} parameters={parameters} lineParameters={lineParameters} /></CodeCard>
    <CodeCard title={t('response')} className="tc-res" tools={<>
      {tabs.length ? <div className="tc-statuses" role="tablist" aria-label={t('responseStatus')}>
        {tabs.map((tab, index) => <button type="button" role="tab" id={`${id}-tab-${tab.code}`} aria-controls={`${id}-response`} aria-selected={activeCode === tab.code} tabIndex={activeCode === tab.code ? 0 : -1}
          key={tab.code} className={`tc-st${/^[45]/.test(tab.status) ? ' err' : ''}`} onClick={() => setPick({ code: tab.code, at: response })}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            setPick({ code: tabs[next].code, at: response })
            document.getElementById(`${id}-tab-${tabs[next].code}`)?.focus()
          }}><i aria-hidden="true" />{tab.label}</button>)}
      </div> : null}
      <CodeCardActions code={responseCode} ask={false} />
    </>}>
      {examples.length > 1 ? <select aria-label={t('selectExample')} value={example?.key} onChange={(event) => setExampleKeys((previous) => ({ ...previous, [activeCode]: event.target.value }))} className="m-3 rounded-md border border-border bg-background px-2 py-1 text-xs">
        {examples.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select> : null}
      <div id={`${id}-response`} role={tabs.length ? 'tabpanel' : undefined} aria-labelledby={tabs.length ? `${id}-tab-${activeCode}` : undefined} tabIndex={tabs.length ? 0 : undefined} key={`${activeCode}:${example?.key ?? ''}`}>
        <CodeLines code={responseCode} parameters={parameters} animate />
      </div>
    </CodeCard>
  </div>
}
