/**
 * Text equivalence for starter three-way decisions only. Cryptographic release
 * identity and mutation preconditions always retain their exact-byte checks.
 */
const textPolicies = new Set(['.gitignore', '.gitattributes'])

/** Ignore CRLF checkout conversion in known, valid UTF-8 text files only. */
export function areStarterFileContentsEquivalent(path: string, left?: Buffer, right?: Buffer): boolean {
  if (!left || !right) return left === right
  if (left.equals(right)) return true
  const filename = path.split(/[\\/]/).at(-1) ?? ''
  if (!/\.(?:[cm]?[jt]sx?|jsonc?|mdx?|ya?ml|css|html|svg|txt)$/.test(filename) && !textPolicies.has(filename)) return false
  if (left.includes(0) || right.includes(0)) return false
  const leftText = left.toString('utf8')
  const rightText = right.toString('utf8')
  // Reject malformed UTF-8 rather than making replacement characters equal.
  if (!Buffer.from(leftText).equals(left) || !Buffer.from(rightText).equals(right)) return false
  return leftText.replace(/\r\n/g, '\n') === rightText.replace(/\r\n/g, '\n')
}
