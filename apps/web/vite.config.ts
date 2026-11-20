import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Dev API port = PORT in the root .env (default 18080; common dev ports are often taken).
const apiUrl = `http://localhost:${process.env.PORT ?? 18080}`;

/**
 * Writes /asset-manifest.json: every file of the build (the hashed scripts, styles, fonts, icons). The service worker
 * stores all of them when it installs, so the app runs offline even on screens that were never opened online.
 */
function assetManifest(): Plugin {
  let outDir = 'dist';
  return {
    name: 'erp-asset-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const root = path.resolve(outDir);
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else files.push(`/${path.relative(root, full).split(path.sep).join('/')}`);
        }
      };
      for (const d of ['assets', 'fonts'])
        if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
      for (const f of fs.readdirSync(root)) if (/^icon-.*.png$/.test(f)) files.push(`/${f}`);
      fs.writeFileSync(
        path.join(root, 'asset-manifest.json'),
        JSON.stringify({ files: files.filter((f) => !f.endsWith('.txt')) }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), assetManifest()],
  build: {
    rollupOptions: {
      output: {
        // libraries change rarely: separate files stay cached across deploys of the app code
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query', 'zustand'],
          i18n: ['i18next', 'react-i18next'],
        },
      },
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 15173),
    strictPort: true,
    // lets `pnpm tunnel` (a Cloudflare quick tunnel) reach the dev server by its public name
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': apiUrl, '/health': apiUrl },
  },
});
