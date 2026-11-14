/**
 * Builds the Vercel deployment with the "Build Output API" (https://vercel.com/docs/build-output-api):
 *
 *   .vercel/output/static/             the web app (Vite build, cloud mode switched on)
 *   .vercel/output/functions/api.func/ the API as one function: a single bundled file + the SQL
 *                                      migration folders + the one native module (argon2)
 *   .vercel/output/config.json         routes: files first, then /api and /health to the function,
 *                                      everything else to index.html (the app's own router)
 *
 *   node scripts/vercel-build.mjs        (Vercel runs this as the build command; see vercel.json)
 *
 * Nothing here talks to Vercel or the network.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.vercel', 'output');
const fn = path.join(out, 'functions', 'api.func');

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

// 1. the web app, built for cloud mode (restaurant codes in the address, platform admin pages)
const web = spawnSync('pnpm', ['--filter', '@erp/web', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_MULTI_TENANT: 'true' },
});
if (web.status !== 0) throw new Error('web build failed');
cpSync(path.join(root, 'apps', 'web', 'dist'), path.join(out, 'static'), { recursive: true });

// 2. the API as one ES module. Everything is inlined except what cannot be: node built-ins, the
//    optional native Postgres client, and argon2 (a native module, copied below). The thermal-printer
//    drawing library is swapped for a stub.
await build({
  entryPoints: [path.join(root, 'apps', 'api', 'src', 'vercel.ts')],
  outfile: path.join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['pg-native', '@node-rs/argon2'],
  // a 50 MB native drawing library only used for thermal-printer bitmaps: replaced by a stub (see the file)
  alias: { '@napi-rs/canvas': path.join(root, 'scripts', 'stubs', 'canvas-stub.mjs') },
  // bundled CommonJS packages (express, pg) call require(): give them one that works inside an ES module
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
});

// 3. the SQL migrations the API applies when it creates a restaurant's database
const api = path.join(root, 'apps', 'api');
for (const dir of ['migrations', 'migrations-phase2', 'control-migrations'])
  cpSync(path.join(api, dir), path.join(fn, dir), { recursive: true });

// 4. argon2: its prebuilt binary for this platform sits next to it in pnpm's store. Copy the whole
//    @node-rs scope (the main package and the binding installed for this machine).
const argonPkg = createRequire(path.join(api, 'package.json')).resolve(
  '@node-rs/argon2/package.json',
);
const scope = path.resolve(path.dirname(argonPkg), '..');
const target = path.join(fn, 'node_modules', '@node-rs');
mkdirSync(target, { recursive: true });
for (const name of readdirSync(scope)) {
  if (!name.startsWith('argon2')) continue;
  cpSync(path.join(scope, name), path.join(target, name), { recursive: true, dereference: true });
}
if (!readdirSync(target).some((n) => n.startsWith('argon2-')))
  throw new Error(
    'No argon2 native binding found next to @node-rs/argon2: was pnpm install run on this platform?',
  );

writeFileSync(path.join(fn, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(
  path.join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      // creating a restaurant (a new database + all migrations) takes up to half a minute
      maxDuration: 120,
    },
    null,
    2,
  ),
);

// 5. routes and security headers
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
writeFileSync(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: '/(.*)',
          headers: {
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'referrer-policy': 'same-origin',
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'strict-transport-security': 'max-age=63072000; includeSubDomains',
            'content-security-policy': csp,
          },
          continue: true,
        },
        // the API answers with its own caching rules; never cache it at the edge
        { src: '/api/(.*)', headers: { 'cache-control': 'no-store' }, continue: true },
        { handle: 'filesystem' },
        { src: '/api/(.*)', dest: '/api' },
        { src: '/health', dest: '/api' },
        // the app's own router takes every other address (/r/<code>/…, /platform/…)
        { src: '/(.*)', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);

if (!existsSync(path.join(out, 'static', 'index.html')))
  throw new Error('web build has no index.html');
console.log(`Vercel output written to ${path.relative(root, out)}`);
