import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev API port = PORT in the root .env (default 18080; common dev ports are often taken).
const apiUrl = `http://localhost:${process.env.PORT ?? 18080}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 15173),
    strictPort: true,
    // lets `pnpm tunnel` (a Cloudflare quick tunnel) reach the dev server by its public name
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': apiUrl, '/health': apiUrl },
  },
});
