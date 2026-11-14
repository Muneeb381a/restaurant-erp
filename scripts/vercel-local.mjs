/**
 * Serves the output of `pnpm vercel:build` the way Vercel will: static files first, `/api` and
 * `/health` to the bundled function, every other address to index.html, with the same headers.
 * It runs the very same bundle that gets deployed, so what works here works there (apart from
 * Vercel's own network). Needs the cloud-mode environment (CONTROL_DATABASE_URL …) in the shell/.env.
 *
 *   pnpm vercel:build && pnpm vercel:local        then open http://127.0.0.1:3000/
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.vercel', 'output');
const config = JSON.parse(readFileSync(path.join(out, 'config.json'), 'utf8'));
const staticDir = path.join(out, 'static');
const port = Number(process.env.VERCEL_LOCAL_PORT ?? 3000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const { default: api } = await import(
  pathToFileURL(path.join(out, 'functions', 'api.func', 'index.mjs')).href
);

function staticFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const file = path.normalize(path.join(staticDir, clean));
  if (!file.startsWith(staticDir)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

createServer((req, res) => {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];
  let dest = null;
  for (const rule of config.routes) {
    if (rule.handle === 'filesystem') {
      const file = staticFile(pathname);
      if (file) {
        res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        return createReadStream(file).pipe(res);
      }
      continue;
    }
    if (rule.src && new RegExp(`^${rule.src}$`).test(pathname)) {
      for (const [k, v] of Object.entries(rule.headers ?? {})) res.setHeader(k, v);
      if (rule.continue) continue;
      dest = rule.dest;
      break;
    }
  }
  if (dest === '/api') return api(req, res);
  const index = staticFile('/index.html');
  if (dest === '/index.html' && index) {
    res.setHeader('content-type', TYPES['.html']);
    return createReadStream(index).pipe(res);
  }
  res.statusCode = 404;
  res.end('not found');
}).listen(port, '127.0.0.1', () => {
  console.log(`Vercel output served at http://127.0.0.1:${port}/`);
});
