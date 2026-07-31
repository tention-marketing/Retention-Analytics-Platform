import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// The backend origin the dev proxy forwards to. NOT reachable from browser code:
// application code only ever calls the same-origin `/api` prefix, and this value
// exists solely so the dev server knows where to forward it. Nothing here is
// inlined into the bundle (only `VITE_`-prefixed vars are), so the backend origin
// never ships to a browser.
const DEV_API_TARGET = process.env.DEV_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // GET /api/auth/me  ->  GET http://localhost:3000/auth/me
      //
      // The prefix is stripped by the rewrite below. Going through the proxy
      // keeps every request same-origin, which is what lets the httpOnly
      // `tention_sid` cookie work with SameSite=Lax and Secure=false in
      // development — and is why the backend needs no CORS configuration at all.
      '/api': {
        target: DEV_API_TARGET,
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    clearMocks: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
