import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'openclaw/plugin-sdk': resolve(__dirname, 'types/openclaw/plugin-sdk.d.ts'),
    },
  },
});
