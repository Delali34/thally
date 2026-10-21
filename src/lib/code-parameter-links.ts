/** Safely associate displayed source with documented field names without evaluating code. */

/** Match JSON keys first, then explicit header/query/path/assignment name positions. */
export function parametersForCodeLine(line: string, parameters: string[] = []): string[] {
  const keys = [...line.matchAll(/\\?["']([\w.-]+)\\?["']\s*:/g)].map((match) => match[1])
  if (keys.length) return [...new Set(keys)]
  const bareKey = /^\s*([\w.-]+)\s*:/.exec(line)?.[1]
  if (bareKey) return [bareKey]
  return [...new Set(parameters.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Only syntactic name positions count. A query value or an opaque path
    // literal cannot establish which parameter it represents.
    return [
      `(?:[?&]|%3[fF]|%26)${escaped}(?:=|%3[dD])`,
      `(?:\\{|%7[bB])${escaped}(?:\\}|%7[dD])`,
      `(?:--header|-H)\\s+["']?${escaped}\\s*:`,
      `(?:--data-urlencode|--url-query)\\s+["']?${escaped}=`,
      `(?:^|[\\s{,])${escaped}\\s*(?::|=>|=(?!=))`,
      `/:${escaped}(?=/|["'?\\s]|$)`,
    ].some((pattern) => new RegExp(pattern).test(line))
  }))]
}

/** Return the primary association for consumers displaying a single field label. */
export function parameterForCodeLine(line: string, parameters: string[] = []): string | undefined {
  return parametersForCodeLine(line, parameters)[0]
}
