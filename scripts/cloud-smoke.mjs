/**
 * Checks a running cloud deployment end to end: web app, platform admin sign-in, creating a
 * restaurant, the owner's forced password change, isolation from the platform, switching off.
 * It CREATES a real restaurant (a database) and ARCHIVES it at the end; on Neon the project stays
 * until you delete it in the Neon console. Run it after the first deploy and after big changes.
 *
 *   SMOKE_BASE=https://your-project.vercel.app SMOKE_ADMIN=root SMOKE_PASSWORD='…' node scripts/cloud-smoke.mjs
 *   (locally: pnpm vercel:build && pnpm vercel:local, then SMOKE_BASE=http://127.0.0.1:3000)
 */
const base = (process.env.SMOKE_BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const admin = process.env.SMOKE_ADMIN ?? 'root';
const adminPassword = process.env.SMOKE_PASSWORD;
if (!adminPassword) throw new Error('Set SMOKE_PASSWORD to the platform admin password');

const j = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 120);
  }
  return { status: res.status, data, headers: res.headers };
};
const ok = (cond, label, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  -> ' + JSON.stringify(extra)}`);
  if (!cond) process.exitCode = 1;
};

const slug = `smoke-${Date.now().toString(36)}`;
const index = await fetch(base + '/');
ok(
  index.status === 200 && (await index.text()).includes('<div id="root">'),
  'GET / serves the web app',
);
const deep = await fetch(`${base}/r/${slug}/kitchen`);
ok(
  deep.status === 200 && (await deep.text()).includes('<div id="root">'),
  'a deep restaurant link falls back to index.html',
);
ok(!!index.headers.get('content-security-policy'), 'security headers are present');
const health = await j('GET', '/health');
ok(health.status === 200 && health.data.mode === 'cloud', 'the API is up in cloud mode', health);

const login = await j('POST', '/api/v1/platform/auth/login', {
  username: admin,
  password: adminPassword,
});
ok(login.status === 200 && login.data.accessToken, 'platform admin signs in', login);
const token = login.data.accessToken;
if (!token) process.exit(1);

const t0 = Date.now();
const made = await j(
  'POST',
  '/api/v1/platform/tenants',
  { name: 'Smoke Test Grill', slug, ownerName: 'Smoke Owner' },
  token,
);
ok(
  made.status === 201 && made.data.tenant?.status === 'ACTIVE',
  `a restaurant is created (${Date.now() - t0} ms)`,
  made,
);
if (made.status !== 201) process.exit(1);
const temp = made.data.owner.temporaryPassword;

const info = await j('GET', `/api/v1/public/tenants/${slug}`);
ok(
  info.status === 200 && info.data.name === 'Smoke Test Grill' && info.data.available,
  'the restaurant code can be looked up',
  info,
);

const first = await j('POST', `/api/v1/r/${slug}/auth/login`, {
  username: 'owner',
  password: temp,
});
ok(first.status === 200, 'the owner signs in with the temporary password', first);
const blocked = await j('GET', `/api/v1/r/${slug}/branch`, null, first.data.accessToken);
ok(
  blocked.status === 403 && blocked.data.code === 'PASSWORD_CHANGE_REQUIRED',
  'everything else is refused until the password is changed',
  blocked,
);
const change = await j(
  'POST',
  `/api/v1/r/${slug}/auth/change-password`,
  { currentPassword: temp, newPassword: 'Smoke#Owner99' },
  first.data.accessToken,
);
ok(change.status === 204, 'the owner changes the password', change);
const second = await j('POST', `/api/v1/r/${slug}/auth/login`, {
  username: 'owner',
  password: 'Smoke#Owner99',
});
const branch = await j('GET', `/api/v1/r/${slug}/branch`, null, second.data.accessToken);
ok(
  branch.status === 200 && branch.data.name === 'Smoke Test Grill',
  'the owner reads the restaurant',
  branch,
);
const platformWithTenantToken = await j(
  'GET',
  '/api/v1/platform/tenants',
  null,
  second.data.accessToken,
);
ok(
  platformWithTenantToken.status === 401,
  "a restaurant's token does not open the platform API",
  platformWithTenantToken,
);
const events = await j('GET', `/api/v1/r/${slug}/events`, null, second.data.accessToken);
ok([501, 200].includes(events.status), 'the live stream answers (501 = off, screens poll)', events);

const off = await j(
  'POST',
  `/api/v1/platform/tenants/${made.data.tenant.id}/suspend`,
  { reason: 'smoke test' },
  token,
);
const gone = await j('GET', `/api/v1/r/${slug}/branch`, null, second.data.accessToken);
ok(
  off.status === 200 && gone.status === 403 && gone.data.code === 'TENANT_SUSPENDED',
  'switching off blocks the restaurant at once',
  gone,
);
const nope = await j('GET', '/api/v1/platform/tenants');
ok(nope.status === 401, 'the platform API needs a token', nope);
const hdr = await j('GET', '/api/v1/r/nowhere/branch');
ok(
  hdr.status === 404 && hdr.headers.get('cache-control') === 'no-store',
  'API answers are not cached',
  [hdr.status, hdr.headers.get('cache-control')],
);

const archived = await j(
  'POST',
  `/api/v1/platform/tenants/${made.data.tenant.id}/archive`,
  {},
  token,
);
ok(
  archived.status === 200 && archived.data.status === 'ARCHIVED',
  'the test restaurant is archived',
  archived,
);
console.log(
  `test restaurant: ${slug} (archived; on Neon delete its project "erp-${slug}" in the Neon console)`,
);
