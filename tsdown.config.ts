import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/webhooks.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'node18',
  clean: true,
  // Never `exports: true`: it overwrites the hand-written exports map in
  // package.json, dropping the nested `types` conditions attw depends on.
});
