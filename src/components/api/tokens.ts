/** Shared method colors keep navigation, endpoint bars and Try It consistent. */

export const methodTokens: Record<
  string,
  {
    text: string
    bg: string
    ring: string
  }
> = {
  get: {
    text: 'text-[var(--docs-method-get)]',
    bg: 'bg-[color-mix(in_oklab,var(--docs-method-get)_11%,transparent)]',
    ring: 'ring-[color-mix(in_oklab,var(--docs-method-get)_20%,transparent)]',
  },
  post: {
    text: 'text-[var(--docs-method-post)]',
    bg: 'bg-[color-mix(in_oklab,var(--docs-method-post)_11%,transparent)]',
    ring: 'ring-[color-mix(in_oklab,var(--docs-method-post)_20%,transparent)]',
  },
  put: {
    text: 'text-[var(--docs-method-put)]',
    bg: 'bg-[color-mix(in_oklab,var(--docs-method-put)_11%,transparent)]',
    ring: 'ring-[color-mix(in_oklab,var(--docs-method-put)_20%,transparent)]',
  },
  patch: {
    text: 'text-[var(--docs-method-patch)]',
    bg: 'bg-[color-mix(in_oklab,var(--docs-method-patch)_11%,transparent)]',
    ring: 'ring-[color-mix(in_oklab,var(--docs-method-patch)_20%,transparent)]',
  },
  delete: {
    text: 'text-[var(--docs-method-delete)]',
    bg: 'bg-[color-mix(in_oklab,var(--docs-method-delete)_11%,transparent)]',
    ring: 'ring-[color-mix(in_oklab,var(--docs-method-delete)_20%,transparent)]',
  },
  options: {
    text: 'text-violet-500',
    bg: 'bg-violet-500/10',
    ring: 'ring-violet-500/20',
  },
  head: {
    text: 'text-zinc-500',
    bg: 'bg-zinc-500/10',
    ring: 'ring-zinc-500/20',
  },
  trace: {
    text: 'text-lime-500',
    bg: 'bg-lime-500/10',
    ring: 'ring-lime-500/20',
  },
}

/** Resolve documented method colors with a neutral fallback for extension verbs. */
export function getMethodToken(method: string) {
  const token = methodTokens[method.toLowerCase()]
  if (token) {
    return token
  }
  return {
    text: 'text-foreground',
    bg: 'bg-foreground/10',
    ring: 'ring-foreground/20',
  }
}

/** Text colour for an HTTP status code: green 2xx, sky 3xx, amber 4xx, rose 5xx. */
export function statusColorClass(code: string) {
  if (code.startsWith('2')) return 'text-green-600 dark:text-green-400'
  if (code.startsWith('3')) return 'text-sky-600 dark:text-sky-400'
  if (code.startsWith('4')) return 'text-amber-600 dark:text-amber-400'
  if (code.startsWith('5')) return 'text-rose-600 dark:text-rose-400'
  return 'text-foreground'
}

/** Underline colour for the active response-status tab, by status class. */
export function statusUnderlineClass(code: string) {
  if (code.startsWith('2')) return 'bg-green-500'
  if (code.startsWith('3')) return 'bg-sky-500'
  if (code.startsWith('4')) return 'bg-amber-500'
  if (code.startsWith('5')) return 'bg-rose-500'
  return 'bg-accent'
}
