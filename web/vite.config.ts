import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into ../public so the Fastify server can serve the app and the API from one origin, which
// keeps the production path free of CORS. In dev, Vite proxies /api to Fastify for the same reason.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
