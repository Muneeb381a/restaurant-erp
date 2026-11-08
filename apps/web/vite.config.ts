import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev API port = PORT in the root .env (default 18080; common dev ports are often taken).
const apiUrl = `http://localhost:${process.env.PORT ?? 18080}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 15173,
    strictPort: true,
    proxy: { '/api': apiUrl, '/health': apiUrl },
  },
});
