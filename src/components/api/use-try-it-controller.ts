/** Editable playground state; encoding and authorization retain the runtime request contracts. */
import { useCallback, useMemo, useRef, useState } from 'react'
import { fieldJsonValue, getTryItFields, initialTryItBody, initialTryItParameters, parseBodyObject, validateTryItFields, type TryItField } from './try-it-fields'
import { authHeaders } from '@/lib/openapi/auth'
import { encodeUrlencoded, formPairs, isMultipart, isUrlencoded } from '@/lib/openapi/body-form'
import type { NormalizedOperation } from '@/lib/openapi/types'

export { buildCurlCommand } from '@/lib/openapi/code-samples'

export const MANUAL_NO_SERVER = 'No server URL for this page. Set api.mdx.server in docs.json or use a full URL in the api frontmatter.'

export interface TryItController {
  operation: NormalizedOperation
  serverUrl: string
  setServerUrl: (url: string) => void
  pathParams: Record<string, string>
  queryParams: Record<string, string>
  headerParams: Record<string, string>
  bodyValue: string
  setBodyValue: (value: string) => void
  /** Files chosen in the body form for binary fields, by field name. */
  setFile: (name: string, file: File | null) => void
  /** Typed credential per scheme; retained only in this tab for this operation and server. */
  authValues: Record<string, string>
  setAuthValue: (scheme: string, value: string) => void
  setParamValue: (group: 'path' | 'query' | 'header', key: string, value: string) => void
  preparedRequest: PreparedRequest
  /** The request as shown in code samples: a missing credential reads `<token>`. */
  sampleRequest: PreparedRequest
  response: ResponsePayload | { error: string } | null
  sendRequest: () => Promise<void>
  /** Send, but a DELETE first asks for a second click instead of a native confirm. */
  requestSend: () => void
  confirmingSend: boolean
  cancelSend: () => void
  isSending: boolean
  canSendBody: boolean
  fields: TryItField[]
  fieldValues: Record<string, string>
  errors: Record<string, string>
  setFieldValue: (field: TryItField, value: string) => void
  validateRequest: () => Record<string, string>
  restoreCredentials: () => void
}

export interface PreparedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  /** Multipart body fields; sent as multipart/form-data, with files from the form. */
  form?: Array<[string, string]>
  isServerConfigured: boolean
}

export interface ResponsePayload {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  duration: number
}

/** Builds a multipart body in the browser (the browser picks the boundary) and returns it base64-encoded for the relay. */
async function encodeMultipart(request: PreparedRequest, bodyValue: string, files: Record<string, File>) {
  if (!request.form) return null
  const data = new FormData()
  const names = new Set(Object.keys(files))
  for (const [name, value] of formPairs(JSON.parse(bodyValue))) {
    if (names.has(name)) data.append(name, files[name])
    else data.append(name, value)
  }
  const encoded = new Response(data)
  const bytes = new Uint8Array(await encoded.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { base64: btoa(binary), headers: { 'Content-Type': encoded.headers.get('content-type') ?? 'multipart/form-data' } }
}

/** Preserve one request projection for execution, safe examples, and all form controls. */
export function useTryItController(operation: NormalizedOperation): TryItController {
  const [serverUrl, updateServerUrl] = useState(operation.servers[0]?.url ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pathParams, setPathParams] = useState<Record<string, string>>(() => initialTryItParameters(operation, 'path'))
  const [queryParams, setQueryParams] = useState<Record<string, string>>(() => initialTryItParameters(operation, 'query'))
  const [headerParams, setHeaderParams] = useState<Record<string, string>>(() => initialTryItParameters(operation, 'header'))
  const [bodyValue, updateBodyValue] = useState(() => initialTryItBody(operation))
  const [bodyDrafts, setBodyDrafts] = useState<Record<string, string>>({})
  const setBodyValue = useCallback((value: string) => {
    updateBodyValue(value)
    setBodyDrafts({})
    if (value.trim()) setErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith('body:'))))
  }, [])
  const [authValues, setAuthValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(operation.authSchemes.flatMap((scheme) => (scheme.prefill ? [[scheme.name, scheme.prefill]] : []))),
  )
  const [response, setResponse] = useState<ResponsePayload | { error: string } | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [confirmingSend, setConfirmingSend] = useState(false)
  const sendingRef = useRef(false)
  const fields = useMemo(() => getTryItFields(operation), [operation])
  const fieldValues = useMemo(() => {
    const body = parseBodyObject(bodyValue)
    return Object.fromEntries(fields.map((field) => {
      if (field.authSchemeName) return [field.id, authValues[field.authSchemeName] ?? '']
      if (field.group === 'body') {
        const value = body[field.name]
        return [field.id, bodyDrafts[field.id] ?? (field.id === 'body:__raw' ? bodyValue : typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2))]
      }
      const values = field.group === 'path' ? pathParams : field.group === 'query' ? queryParams : headerParams
      return [field.id, values[field.name] ?? '']
    }))
  }, [fields, bodyValue, bodyDrafts, authValues, pathParams, queryParams, headerParams])
  const validateRequest = useCallback(() => {
    const next = validateTryItFields(fields, fieldValues, { isBodyOmitted: !operation.requestBody?.required && !bodyValue.trim() })
    if (bodyValue.trim() && (/json/i.test(operation.requestBody?.contents[0]?.mediaType ?? '') || isMultipart(operation.requestBody?.contents[0]?.mediaType) || isUrlencoded(operation.requestBody?.contents[0]?.mediaType))) {
      try { JSON.parse(bodyValue) } catch { next['body:__raw'] = 'Enter valid JSON' }
    }
    setErrors(next)
    return next
  }, [fields, fieldValues, operation.requestBody, bodyValue])
  const restoreForServer = useCallback((url: string) => {
    const values: Record<string, string> = {}
    for (const scheme of operation.authSchemes) {
      // Query/cookie credentials never enter the URL or the relay's blocked Cookie header.
      if (scheme.in !== 'header') continue
      const fallback = url === operation.servers[0]?.url ? scheme.prefill ?? '' : ''
      try { values[scheme.name] = sessionStorage.getItem(`thallyPgKey:${operation.specId}:${operation.id}:${url}:${scheme.name}`) ?? fallback }
      catch { values[scheme.name] = fallback }
    }
    setAuthValues(values)
  }, [operation.authSchemes, operation.id, operation.servers, operation.specId])
  const restoreCredentials = useCallback(() => restoreForServer(serverUrl), [restoreForServer, serverUrl])
  const setServerUrl = useCallback((url: string) => {
    updateServerUrl(url)
    setResponse(null)
    setConfirmingSend(false)
    restoreForServer(url)
  }, [restoreForServer])

  const [files, setFiles] = useState<Record<string, File>>({})
  const setFile = useCallback(
    (name: string, file: File | null) =>
      setFiles((prev) => {
        const next = { ...prev }
        if (file) next[name] = file
        else delete next[name]
        return next
      }),
    [],
  )
  const canSendBody =
    !['GET', 'HEAD'].includes(operation.method.toUpperCase()) && (Boolean(operation.requestBody) || operation.prefill.body !== undefined)
  const mediaType = operation.requestBody?.contents[0]?.mediaType
  const isServerConfigured = Boolean(serverUrl)

  const buildResolvedUrl = useCallback(() => {
    const populatedPath = operation.path.replace(/{([^}]+)}/g, (_match, key) => {
      // An empty path value keeps its visible `{name}` placeholder instead of
      // silently turning `/monitor/{id}` into the list endpoint `/monitor/`.
      const value = pathParams[key]
      return value ? encodeURIComponent(value) : `{${key}}`
    })
    const searchParams = new URLSearchParams()
    Object.entries(queryParams).forEach(([key, value]) => {
      if (value) {
        searchParams.append(key, value)
      }
    })
    const queryString = searchParams.toString()
    const base = serverUrl?.replace(/\/$/, '') ?? ''
    return `${base}${populatedPath.startsWith('/') ? populatedPath : `/${populatedPath}`}${queryString ? `?${queryString}` : ''}`
  }, [operation.path, pathParams, queryParams, serverUrl])

  const buildRequest = useCallback(
    (placeholders: boolean): PreparedRequest => {
      const url = isServerConfigured ? buildResolvedUrl() : ''
      let parsed: unknown
      try {
        parsed = JSON.parse(bodyValue)
      } catch {
        parsed = undefined
      }
      const multipart = canSendBody && isMultipart(mediaType) && parsed !== undefined
      const form = multipart ? formPairs(parsed).map(([name, value]): [string, string] => [name, files[name] ? `@${files[name].name}` : value]) : undefined
      const body = !canSendBody || multipart ? undefined : isUrlencoded(mediaType) && parsed !== undefined ? encodeUrlencoded(parsed) : bodyValue || undefined
      const withAuth = { ...headerParams, ...authHeaders(operation.authSchemes, authValues, placeholders) }
      // A multipart request carries its own boundary in Content-Type, set when it is sent.
      const headers =
        body && mediaType && !Object.keys(withAuth).some((key) => key.toLowerCase() === 'content-type')
          ? { ...withAuth, 'Content-Type': mediaType }
          : withAuth
      return { url, method: operation.method, headers, body, form, isServerConfigured }
    },
    [authValues, buildResolvedUrl, headerParams, operation.authSchemes, operation.method, mediaType, canSendBody, bodyValue, files, isServerConfigured],
  )
  const preparedRequest = useMemo(() => buildRequest(false), [buildRequest])
  const sampleRequest = useMemo(() => buildRequest(true), [buildRequest])

  const setAuthValue = useCallback((scheme: string, value: string) => {
    setAuthValues((previous) => ({ ...previous, [scheme]: value }))
    try {
      const key = `thallyPgKey:${operation.specId}:${operation.id}:${serverUrl}:${scheme}`
      // Persist an empty marker too: clearing a configured credential must not restore it on reopen.
      sessionStorage.setItem(key, value)
    } catch { /* Storage can be blocked; the in-memory credential still works. */ }
  }, [operation.id, operation.specId, serverUrl])

  const setParamValue = useCallback(
    (group: 'path' | 'query' | 'header', key: string, value: string) => {
      const setter =
        group === 'path'
          ? setPathParams
          : group === 'query'
            ? setQueryParams
            : setHeaderParams

      setter((prev) => ({
        ...prev,
        [key]: value,
      }))
    },
    [],
  )

  const setFieldValue = useCallback((field: TryItField, value: string) => {
    setErrors((previous) => {
      if (!previous[field.id] || !value.trim()) return previous
      const next = { ...previous }
      delete next[field.id]
      return next
    })
    if (field.authSchemeName) setAuthValue(field.authSchemeName, value)
    else if (field.group === 'body') {
      setBodyDrafts((previous) => ({ ...previous, [field.id]: value }))
      if (field.id === 'body:__raw') updateBodyValue(value)
      else updateBodyValue((previous) => {
        const next = parseBodyObject(previous)
        if (value === '') delete next[field.name]
        else next[field.name] = fieldJsonValue(field, value)
        return !Object.keys(next).length && !operation.requestBody?.required ? '' : JSON.stringify(next, null, 2)
      })
    } else setParamValue(field.group, field.name, value)
  }, [operation.requestBody?.required, setAuthValue, setParamValue])

  const sendRequest = useCallback(async () => {
    if (sendingRef.current || Object.keys(validateRequest()).length) return
    if (!preparedRequest.isServerConfigured) {
      setResponse({ error: operation.manualPage ? MANUAL_NO_SERVER : 'No server URL available for this spec. Update your OpenAPI servers array.' })
      return
    }
    sendingRef.current = true
    setIsSending(true)
    setResponse(null)
    try {
      const encoded = await encodeMultipart(preparedRequest, bodyValue, files)
      const res = await fetch('/api/try-it', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          specId: operation.specId,
          ...(operation.manualPage ? { page: operation.manualPage } : {}),
          ...(operation.manualLocale ? { locale: operation.manualLocale } : {}),
          operationPath: operation.path,
          url: preparedRequest.url,
          method: preparedRequest.method,
          headers: { ...preparedRequest.headers, ...encoded?.headers },
          body: preparedRequest.body,
          ...(encoded ? { bodyBase64: encoded.base64 } : {}),
        }),
      })
      const payload = (await res.json()) as ResponsePayload | { error: string }
      setResponse(payload)
    } catch (error) {
      setResponse({ error: error instanceof Error ? error.message : 'Failed to execute request' })
    } finally {
      sendingRef.current = false
      setIsSending(false)
    }
  }, [bodyValue, files, operation.manualLocale, operation.manualPage, operation.path, operation.specId, preparedRequest, validateRequest])

  const requestSend = useCallback(() => {
    if (sendingRef.current || Object.keys(validateRequest()).length) return
    if (operation.method.toUpperCase() === 'DELETE' && !confirmingSend) {
      setConfirmingSend(true)
      return
    }
    setConfirmingSend(false)
    void sendRequest()
  }, [confirmingSend, operation.method, sendRequest, validateRequest])
  const cancelSend = useCallback(() => setConfirmingSend(false), [])

  return {
    operation,
    serverUrl,
    setServerUrl,
    pathParams,
    queryParams,
    headerParams,
    bodyValue,
    setBodyValue,
    setFile,
    authValues,
    setAuthValue,
    setParamValue,
    preparedRequest,
    sampleRequest,
    response,
    sendRequest,
    requestSend,
    confirmingSend,
    cancelSend,
    isSending,
    canSendBody,
    fields,
    fieldValues,
    errors,
    setFieldValue,
    validateRequest,
    restoreCredentials,
  }
}
