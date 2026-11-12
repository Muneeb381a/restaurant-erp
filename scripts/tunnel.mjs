/**
 * Puts the local app on a public https address with a Cloudflare "quick tunnel" (free, no account, no
 * domain), for showing it to a client or testing on a phone away from the till.
 *
 *   pnpm dev            (API + web running)
 *   pnpm tunnel         prints https://<random>.trycloudflare.com
 *
 * The address changes every run and works only while this command is running. Do not put real customer
 * data behind it, and change the dev PINs first: anyone with the link can reach the sign-in screen.
 */
import { spawn, spawnSync } from 'node:child_process';

const port = Number(process.env.WEB_PORT ?? 15173);
const target = `http://127.0.0.1:${port}`;

const found = spawnSync('cloudflared', ['--version'], { shell: true, encoding: 'utf8' });
if (found.status !== 0) {
  console.error(
    'cloudflared is not installed.\n  Windows:  winget install --id Cloudflare.cloudflared\n  macOS:    brew install cloudflared\nThen open a new terminal and run `pnpm tunnel` again.',
  );
  process.exit(1);
}

try {
  const res = await fetch(`${target}/health`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
} catch {
  console.error(
    `The app does not answer on ${target}. Start it first (pnpm dev), then run \`pnpm tunnel\`.`,
  );
  process.exit(1);
}

console.log(`Starting a public tunnel to ${target} ...`);
console.log(
  'Look for the https://....trycloudflare.com address below. Press Ctrl+C to close it.\n',
);
const child = spawn('cloudflared', ['tunnel', '--url', target, '--no-autoupdate'], {
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
