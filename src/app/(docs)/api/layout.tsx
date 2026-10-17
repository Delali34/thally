/** The catch-all API page owns scoped navigation because it receives the leaf slug. */
export default function ApiLayoutProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
