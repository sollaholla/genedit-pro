import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import type { ProxyOptions } from 'vite';

// Deployed at https://<owner>.github.io/genedit-pro/ — override with VITE_BASE for custom domains.
const base = process.env.VITE_BASE ?? '/genedit-pro/';
const proxyHeaders = {
  // Enables SharedArrayBuffer; lets us upgrade to multi-threaded ffmpeg later
  // without code changes. Safe for the single-thread core too.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const klingProxy: Record<string, ProxyOptions> = {
  '/kling-api': {
    target: 'https://api-singapore.klingai.com',
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath) => requestPath.replace(/^\/kling-api/, ''),
  },
};

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    headers: proxyHeaders,
    proxy: klingProxy,
  },
  preview: {
    headers: proxyHeaders,
    proxy: klingProxy,
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  worker: {
    format: 'es',
  },
});
