import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: resolve('index.html') },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
});
