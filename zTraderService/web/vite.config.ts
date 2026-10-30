/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Nest backend (port 6500) owns every /api route and /health. In dev the
// SPA runs on Vite and forwards those paths, so the browser stays same-origin
// and the session cookie + Origin check behave exactly as in production.
const backend = 'http://localhost:6500';

// The server swaps this placeholder for a fresh per-request nonce (src/common/http/web-app.ts).
// Vite writes it on the tags it emits and as <meta property="csp-nonce">, which the Emotion
// cache reads so MUI's injected <style> tags satisfy the strict style-src CSP.
const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__';

export default defineConfig({
  plugins: [react()],
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/health': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Emit every asset as a file (no data: URIs) so a strict production CSP holds.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    env: { TZ: 'UTC' },
    css: false,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
