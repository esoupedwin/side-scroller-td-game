import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: { port: 3000 },
  build: {
    rollupOptions: {
      input: {
        main:        resolve(__dirname, 'index.html'),
        mapBuilder:  resolve(__dirname, 'map-builder.html'),
      },
    },
  },
});
