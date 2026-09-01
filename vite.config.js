import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative, so the same build runs from a Pages project sub-path or a domain
  // root. Everything below stays relative for the same reason.
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: resolve('index.html') },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
  plugins: [
    VitePWA({
      // A dice roller has no state worth a "reload?" prompt: take the new version
      // on the next launch and say nothing.
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Dicer',
        short_name: 'Dicer',
        description:
          'A physically simulated RPG dice roller. Real dice tumble in a leather tray and the number that lands face up is read off the model.',
        // Relative so the installed app points at wherever this was deployed.
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#07070a',
        theme_color: '#07070a',
        categories: ['games', 'entertainment', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Launchers crop this one to their own shape, so the mark sits inside
          // the safe zone with the background bled to the edges.
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything the app needs to run, including all seven colourways: the
        // point of installing is that it works with no network at all, and a
        // colourway fetched on demand would fail exactly when it was needed.
        globPatterns: ['**/*.{js,css,html,svg,png,webp,glb,json,woff2}'],
        // Rapier inlines its wasm as base64 and lands near 3MB, well past the
        // 2MB default, which would silently drop it from the precache.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
