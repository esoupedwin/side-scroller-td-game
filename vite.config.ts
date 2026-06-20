import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: { port: 3000 },
  build: {
    // es2022 so the top-level `await preloadAllSprites()` in main.ts survives the
    // build — the default 'es2020' target rejects top-level await and fails the build.
    target: 'es2022',
    rollupOptions: {
      input: {
        main:        resolve(__dirname, 'index.html'),
        mapBuilder:  resolve(__dirname, 'map-builder.html'),
      },
    },
  },
});
