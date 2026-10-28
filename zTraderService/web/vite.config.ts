/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Nest backend (port 6500) owns every /api route and /health. In dev the
// SPA runs on Vite and forwards those paths, so the browser stays same-origin
// and the session cookie + Origin check behave exactly as in production.
const backend = 'http://localhost:6500';

export default defineConfig({
  plugins: [react()],
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
