'use client'

/** Generated API documentation keeps schema behavior while sharing handoff code/field focus. */
import { useState } from 'react'
import { ParameterLinkProvider } from '@/components/api/parameter-link'
import { CopyPageButton } from '@/components/docs/copy-page-button'
import { ExamplePanel } from '@/components/api/example-panel'
import { TryItDialog } from '@/components/api/try-it-dialog'
import { OperationCodePanel } from '@/components/api/operation-code-panel'
import { useTryItController } from '@/components/api/use-try-it-controller'
import { ParamField, ResponseField, Expandable } from '@/components/mdx/api-fields'
import type { PlaygroundDisplay } from '@/lib/openapi/playground-display'
import type { NormalizedOperation, NormalizedParameter, NormalizedResponse } from '@/lib/openapi/types'
import { EndpointBar } from '@/components/api/endpoint-bar'
import { statusColorClass, statusUnderlineClass } from '@/components/api/tokens'
import { flattenSchema, unionVariants, type SchemaVariant } from '@/lib/openapi/schema-variants'
import { ApiLocaleProvider, useApiLabels } from '@/components/api/api-locale'
import { apiLabel, type ApiLabelKey } from '@/lib/i18n/api-labels'
import { authDescription } from '@/lib/openapi/auth'
import { cn } from '@/lib/utils'
import Markdown from '@/components/mdx/markdown'
import { Prose } from '@/components/mdx/prose'

/** Prose typography for descriptions rendered outside a field row; the `prose` block trims its own outer margins. */
const markdownProse = 'prose prose-sm max-w-none dark:prose-invert'

interface OperationPanelProps {
  operation: NormalizedOperation
  /** The page's own MDX body, shown between the header and the schema. */
  children?: React.ReactNode
  /** False when the page header already shows the page's authored description. */
  showDescription?: boolean
  /** Renders the operation title as the page h1 (spec-only pages have no MDX header). */
  showTitle?: boolean
  /** Mintlify `playground` display; `simple` has no Try it, `none` hides the endpoint bar too. */
  playground?: PlaygroundDisplay
  /** Locale of the page, for the panel's own labels. */
  locale?: string
}

/** Keep operation-local state isolated when navigating between specs and endpoints. */
export function OperationPanel(props: OperationPanelProps) {
  return <ParameterLinkProvider key={`${props.operation.specId}:${props.operation.id}:${props.operation.key}`}><OperationPanelContent {...props} /></ParameterLinkProvider>
}

function OperationPanelContent({ operation, children, showDescription = true, showTitle = false, playground = 'interactive', locale }: OperationPanelProps) {
  const t = (key: ApiLabelKey, n?: number) => apiLabel(locale, key, n)
  const controller = useTryItController(operation)
  const interactive = playground === 'interactive' && !operation.isWebhook
  // `?playground=open` opens the playground straight away, as on live. The
  // dialog renders in a client-only portal, so reading the URL here is safe.
  const [isDialogOpen, setDialogOpen] = useState(
    () => interactive && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('playground') === 'open',
  )

  type ParamLocation = 'path' | 'query' | 'header' | 'cookie'
  const parameterGroups: Array<{ title: string; location: ParamLocation; parameters: Array<NormalizedParameter> }> = [
    { title: t('pathParameters'), location: 'path' as const, parameters: operation.parameters.path },
    { title: t('queryParameters'), location: 'query' as const, parameters: operation.parameters.query },
    { title: t('headers'), location: 'header' as const, parameters: operation.parameters.header },
    { title: t('cookieParameters'), location: 'cookie' as const, parameters: operation.parameters.cookie },
  ].filter((group) => group.parameters.length > 0)

  const description = !showDescription ? null : operation.description ? (
    <div className="prose prose-neutral dark:prose-invert max-w-none text-base text-foreground/70">
      <Markdown>{operation.description}</Markdown>
    </div>
  ) : (
    <p className="text-base text-foreground/70">
      This endpoint handles {operation.method} requests for <code className="font-mono text-sm">{operation.path}</code>.
      Review the request parameters and response schema below.
    </p>
  )

  return (
    <ApiLocaleProvider value={locale}>
    <div className="thally-endpoint">
        {/* Header */}
        <header className="thally-endpoint-header">
          {showTitle ? (
            <div className="thally-endpoint-title"><h1 className="break-words font-heading text-4xl font-semibold leading-10 tracking-[-0.025em] text-foreground">
              {operation.title}
            </h1><CopyPageButton /></div>
          ) : null}
          {showTitle ? description : null}
          <EndpointBar operation={operation} display={playground} onTryIt={() => setDialogOpen(true)} />
          {showTitle ? null : description}
        </header>

        <div className="thally-endpoint-grid">
        <div className="thally-endpoint-doc">
        {children ? <Prose>{children}</Prose> : null}

        {/* Authorizations */}
        {operation.authSchemes.length ? (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">{t('authorizations')}</h2>
            <div className="border-y border-border">
              {operation.authSchemes.map((scheme) => (
                <ParamField
                  key={scheme.name}
                  name={scheme.paramName}
                  type="string"
                  required
                  header={scheme.in === 'header'}
                  query={scheme.in === 'query'}
                >
                  <Markdown>{authDescription(scheme)}</Markdown>
                </ParamField>
              ))}
            </div>
          </section>
        ) : null}

        {/* Servers */}
        {operation.servers.length > 1 ? (
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-foreground/50">{t('servers')}</p>
            <div className="border-y border-border">
              {operation.servers.map((server) => (
                <div key={server.url} className="flex flex-wrap items-baseline gap-x-4 border-b border-border px-0 py-3 last:border-b-0">
                  <p className="text-sm font-semibold text-foreground break-all">{server.url}</p>
                  {server.description ? <p className="text-xs text-foreground/60">{server.description}</p> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Parameters */}
        {parameterGroups.length ? (
          <section className="space-y-6">
            {parameterGroups.map((group) => (
              <div key={group.title}>
                <h2>{group.title}</h2>
                <div className="border-y border-border">
                  {group.parameters.map((param) => (
                    <ParamField
                      key={param.name}
                      name={param.name}
                      type={resolveSchemaType(param.schema)}
                      required={param.required}
                      query={group.location === 'query'}
                      path={group.location === 'path'}
                      header={group.location === 'header'}
                      default={resolveDefault(param.schema)}
                    >
                      {param.description ? <Markdown>{param.description}</Markdown> : null}
                    </ParamField>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {/* Request body */}
        {operation.requestBody ? (
          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-foreground">{t('requestBody')}</h2>
              {operation.requestBody.description ? <Markdown className={cn(markdownProse, 'text-sm text-foreground/70')}>{operation.requestBody.description}</Markdown> : null}
            </div>
            {operation.requestBody.contents.map((content) => (
              <div key={content.mediaType}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded border border-border/40 bg-muted px-2 py-0.5 font-mono text-xs text-foreground/70">{content.mediaType}</span>
                  <span className="text-xs text-foreground/50">{operation.requestBody?.required ? t('requiredCap') : t('optional')}</span>
                </div>
                <div className="border-y border-border">
                  <SchemaAsParamFields schema={content.schema} />
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {/* Responses */}
        {operation.responses.length ? (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-foreground">{t('responses')}</h2>
            <ResponseTabs responses={operation.responses} />
          </section>
        ) : null}
      </div>

        <div className="thally-endpoint-code">{operation.isWebhook ? (
          <WebhookExample body={operation.prefill.body} />
        ) : <OperationCodePanel controller={controller} />}</div>
        </div>
        {interactive ? <TryItDialog controller={controller} open={isDialogOpen} onOpenChange={setDialogOpen} /> : null}
    </div>
    </ApiLocaleProvider>
  )
}

/** Webhooks are received, not called: show the payload we send instead of a request sample. */
function WebhookExample({ body }: { body?: string }) {
  const t = useApiLabels()
  if (!body) return <div />
  return (
    <div className="overflow-hidden rounded-[11px] border border-border bg-muted/40">
      <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/60">{t('example')}</div>
      <pre className="scrollbar-hide max-h-[480px] overflow-auto bg-transparent p-4 font-mono text-[0.82rem] leading-[1.65] text-foreground/80">{body}</pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SchemaAsParamFields — renders object properties as ParamField rows
// ---------------------------------------------------------------------------

function SchemaAsParamFields({ schema }: { schema?: Record<string, unknown> }) {
  const t = useApiLabels()
  if (!schema) return null

  const flat = flattenSchema(schema)
  const properties = flat.properties as Record<string, Record<string, unknown>> | undefined
  if (!properties || typeof properties !== 'object') {
    const variants = unionVariants(flat)
    if (variants) return <SchemaVariants variants={variants} depth={0} />
    return (
      <ParamField name="(body)" type={resolveSchemaType(flat)}>
        {typeof flat.description === 'string' ? <Markdown>{flat.description}</Markdown> : null}
      </ParamField>
    )
  }

  const required = Array.isArray(flat.required) ? (flat.required as string[]) : []

  return (
    <>
      {Object.entries(properties).map(([name, propSchema]) => {
        const flatProp = flattenSchema(propSchema)
        const type = resolveSchemaType(flatProp)
        const description = typeof flatProp.description === 'string' ? flatProp.description : undefined
        const defaultVal = resolveDefault(flatProp)
        const isRequired = required.includes(name)
        const nested = getNestedProperties(flatProp)
        const enumValues = Array.isArray(flatProp.enum) ? (flatProp.enum as unknown[]).map(String) : null

        return (
          <ParamField
            key={name}
            name={name}
            type={type}
            required={isRequired}
            deprecated={flatProp.deprecated === true}
            default={defaultVal}
            body
          >
            {description ? <Markdown>{description}</Markdown> : null}
            {enumValues ? (
              <p className="mt-1 text-xs text-foreground/50">
                {t('allowed')}: {enumValues.join(', ')}
              </p>
            ) : null}
            {flatProp.const !== undefined ? (
              <p className="mt-1 text-xs text-foreground/50">
                {t('allowedValue')}: <code>{JSON.stringify(flatProp.const)}</code>
              </p>
            ) : null}
            {nested ? (
              <Expandable title={`${name} ${t('properties')}`}>
                <NestedFields schema={flatProp} depth={1} />
              </Expandable>
            ) : null}
          </ParamField>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// ResponseTabs — status-code tab bar, one tab per response
// ---------------------------------------------------------------------------

function ResponseTabs({ responses }: { responses: Array<NormalizedResponse> }) {
  const t = useApiLabels()
  const [activeCode, setActiveCode] = useState(responses[0]?.code ?? '')
  const active = responses.find((r) => r.code === activeCode) ?? responses[0]

  return (
    <div className="overflow-hidden border-y border-border">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border px-3 pt-1">
        {responses.map((response) => {
          const isActive = response.code === activeCode
          const colorClass = statusColorClass(response.code)
          return (
            <button
              key={response.code}
              type="button"
              onClick={() => setActiveCode(response.code)}
              className={cn(
                'relative px-3 py-2 text-xs font-semibold transition',
                isActive ? colorClass : 'text-foreground/40 hover:text-foreground/70',
              )}
            >
              {response.code}
              {isActive ? <span className={cn('absolute inset-x-0 -bottom-px h-0.5 rounded-full', statusUnderlineClass(response.code))} /> : null}
            </button>
          )
        })}
      </div>

      {/* Active response content */}
      {active ? (
        <div className="px-4 py-3">
          {active.description ? (
            <Markdown className={cn(markdownProse, 'mb-3 text-sm text-foreground/60')}>{active.description}</Markdown>
          ) : null}
          {active.contents.length ? (
            active.contents.map((content) => (
              <div key={content.mediaType}>
                <SchemaAsResponseFields schema={content.schema} />
                <ExamplePanel title={t('example')} mediaType={content.mediaType} example={content.example} examples={content.examples} />
              </div>
            ))
          ) : (
            <p className="text-sm text-foreground/50">{t('noResponseBody')}</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SchemaAsResponseFields — renders object properties as ResponseField rows
// ---------------------------------------------------------------------------

function SchemaAsResponseFields({ schema, depth = 0 }: { schema?: Record<string, unknown>; depth?: number }) {
  const t = useApiLabels()
  if (!schema) return null

  const flat = flattenSchema(schema)
  const properties = flat.properties as Record<string, Record<string, unknown>> | undefined
  if (!properties || typeof properties !== 'object') {
    const variants = unionVariants(flat)
    return variants ? <SchemaVariants variants={variants} depth={depth} /> : null
  }

  const required = Array.isArray(flat.required) ? (flat.required as string[]) : []

  return (
    <>
      {Object.entries(properties).map(([name, propSchema]) => {
        const flatProp = flattenSchema(propSchema)
        const type = resolveSchemaType(flatProp)
        const description = typeof flatProp.description === 'string' ? flatProp.description : undefined
        const isRequired = required.includes(name)
        const nested = depth < MAX_NESTING && getNestedProperties(flatProp)
        const enumValues = Array.isArray(flatProp.enum) ? (flatProp.enum as unknown[]).map(String) : null

        return (
          <ResponseField key={name} name={name} type={type} required={isRequired} deprecated={flatProp.deprecated === true}>
            {description ? <Markdown>{description}</Markdown> : null}
            {enumValues ? (
              <p className="mt-1 text-xs text-foreground/50">
                {t('allowed')}: {enumValues.join(', ')}
              </p>
            ) : null}
            {flatProp.const !== undefined ? (
              <p className="mt-1 text-xs text-foreground/50">
                {t('allowedValue')}: <code>{JSON.stringify(flatProp.const)}</code>
              </p>
            ) : null}
            {nested ? (
              <Expandable title={`${name} ${t('properties')}`}>
                <NestedFields schema={flatProp} depth={depth + 1} />
              </Expandable>
            ) : null}
          </ResponseField>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// oneOf / anyOf — a tab per variant, each with its own fields
// ---------------------------------------------------------------------------

/** Nested levels expanded before a schema is cut off, so a deeply recursive one stays finite. */
const MAX_NESTING = 6

function unionType(variants: Array<SchemaVariant>): string {
  return variants
    .map((variant) => {
      const type = resolveSchemaType(variant.schema) ?? 'any'
      return variant.label ? `${variant.label} · ${type}` : type
    })
    .join(' | ')
}

function NestedFields({ schema, depth }: { schema: Record<string, unknown>; depth: number }) {
  const nested = getNestedSchema(schema)
  const variants = unionVariants(nested)
  return variants ? <SchemaVariants variants={variants} depth={depth} /> : <SchemaAsResponseFields schema={nested} depth={depth} />
}

function SchemaVariants({ variants, depth }: { variants: Array<SchemaVariant>; depth: number }) {
  const t = useApiLabels()
  const [active, setActive] = useState(0)
  const current = variants[active] ?? variants[0]
  const description = typeof current.schema.description === 'string' ? current.schema.description : undefined
  const hasFields = getNestedProperties(current.schema)

  return (
    <div>
      {variants.length > 1 ? (
        <div role="tablist" aria-label={t('variants')} className="mb-3 flex flex-wrap gap-1.5">
          {variants.map((variant, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => setActive(index)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs font-medium transition',
                index === active ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-foreground/60 hover:text-foreground',
              )}
            >
              {variant.label ?? t('option', index + 1)}
            </button>
          ))}
        </div>
      ) : null}
      {description ? <Markdown className={cn(markdownProse, 'mb-2 text-sm text-foreground/70')}>{description}</Markdown> : null}
      {hasFields ? (
        <SchemaAsResponseFields schema={current.schema} depth={depth} />
      ) : (
        <p className="text-xs text-foreground/60">
          {t('type')}: <code>{resolveSchemaType(current.schema) ?? 'any'}</code>
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function resolveSchemaType(schema?: Record<string, unknown>): string | undefined {
  if (!schema) return undefined
  if (typeof schema.$ref === 'string') {
    const parts = schema.$ref.split('/')
    return parts[parts.length - 1]
  }
  const variants = schema.type === undefined ? unionVariants(schema) : null
  if (variants) return unionType(variants)
  if (Array.isArray(schema.type)) {
    return (schema.type as string[]).join(' | ')
  }
  if (typeof schema.type === 'string') {
    if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
      const items = flattenSchema(schema.items as Record<string, unknown>)
      const itemType = resolveSchemaType(items)
      const several = (unionVariants(items)?.length ?? 0) > 1
      return itemType ? `${several ? `(${itemType})` : itemType}[]` : 'array'
    }
    if (Array.isArray(schema.enum)) return `enum<${schema.type}>`
    if (schema.type === 'string' && typeof schema.format === 'string') return `string<${schema.format}>`
    return schema.type
  }
  if (Array.isArray(schema.allOf)) return 'object'
  if (schema.properties) return 'object'
  if (schema.items) return 'array'
  return undefined
}

function resolveDefault(schema?: Record<string, unknown>): string | undefined {
  if (!schema || schema.default === undefined) return undefined
  return typeof schema.default === 'object' ? JSON.stringify(schema.default) : String(schema.default)
}

function getNestedProperties(schema: Record<string, unknown>): boolean {
  const flat = flattenSchema(schema)
  if (flat.properties) return true
  const variants = unionVariants(flat)
  if (variants) return variants.some((variant) => getNestedProperties(variant.schema))
  return flat.type === 'array' && Boolean(flat.items) && typeof flat.items === 'object' && getNestedProperties(flat.items as Record<string, unknown>)
}

function getNestedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const flat = flattenSchema(schema)
  if (flat.type === 'array' && flat.items && typeof flat.items === 'object') {
    return getNestedSchema(flat.items as Record<string, unknown>)
  }
  return flat
}
