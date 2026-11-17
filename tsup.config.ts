import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', node: 'src/node.ts' },
  format: ['esm', 'cjs'],
  target: 'es2020',
  platform: 'neutral',
  external: ['node:async_hooks', 'node:diagnostics_channel'],
  removeNodeProtocol: false,
  dts: true,
  clean: true,
  splitting: true,
  treeshake: true,
  minify: false,
  sourcemap: false,
})
