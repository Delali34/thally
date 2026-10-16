import { defineConfig } from 'tsup'

export default defineConfig({
  // Server consumers can load narrow, independent modules without tracing the
  // repository importer and its filesystem/child-process capabilities.
  entry: { index: 'src/index.ts', 'svg-policy': 'src/svg-policy.ts', 'url-migration': 'src/url-migration.ts' },
  splitting: false,
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  dts: true,
  clean: true,
  sourcemap: true,
})
