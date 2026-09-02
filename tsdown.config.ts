import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/webhooks.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'node18',
  clean: true,
  // Deliberately NOT `exports: true`. It emits an exports map with no `types`
  // conditions, writes a wrong top-level `types`, re-adds `module`, and
  // overwrites the hand-written map in package.json on every build.
});
