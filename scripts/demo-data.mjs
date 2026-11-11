// Loads sample data into a freshly reset dev database: the desi menu (CSV import) and some tables.
// Usage: pnpm demo:data   (API must be running; dev only)
import { readFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://127.0.0.1:18080/api/v1';
const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'owner', password: 'Dev#Passw0rd' }),
});
if (!login.ok) throw new Error(`owner login failed: ${login.status}`);
const auth = { Authorization: `Bearer ${(await login.json()).accessToken}` };
const post = (path, body, headers = {}) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', ...headers },
    body,
  });

const imp = await post('/menu/import?dryRun=false', readFileSync('docs/samples/desi-menu.csv'), {
  'content-type': 'text/csv; charset=utf-8',
});
console.log('menu import:', imp.status);

for (const [name, codes] of [
  ['Main Hall', ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']],
  ['Terrace', ['E1', 'E2', 'E3', 'E4']],
]) {
  const area = await (await post('/areas', JSON.stringify({ name }))).json();
  for (const code of codes) {
    const r = await post('/tables', JSON.stringify({ code, seats: 4, area_id: area.id }));
    if (!r.ok) console.log('table', code, r.status);
  }
}
console.log('done: menu + tables. Sign in as cashier / PIN 1234.');
