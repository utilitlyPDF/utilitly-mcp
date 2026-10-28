import { defineConfig } from 'tsdown'

// An executable, not a library: one ESM entry point, run by Node.js.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: true,
  dts: false,
  clean: true,
  failOnWarn: true,
})
