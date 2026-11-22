import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Relative base so the build works from any static host path (root or sub-folder).
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Prompt instead of auto-reloading so an update never wipes a running simulation.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Physics Playground',
        short_name: 'Playground',
        description: 'Touch-first 3D rigid-body physics sandbox. Works offline.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#03050a',
        theme_color: '#03050a',
        categories: ['education', 'entertainment', 'games'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Icons, favicon and the manifest are added by includeAssets / the manifest itself.
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // Only the Latin font subsets are needed; skip the rest to keep the offline cache lean.
        globIgnores: ['**/*-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese,latin-ext}-*.woff2'],
        // Rapier ships its WASM inlined as base64 inside the JS chunk (~4 MB raw).
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
    }),
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
  },
})
