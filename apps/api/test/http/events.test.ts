import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hub, topicOf } from '../../src/http/events';
import { startApp, type TestApp } from './app-harness';

let t: TestApp;
let server: Server;
let base: string;
let owner: string;
let manager: string;
let manager2: string;

beforeAll(async () => {
  t = await startApp();
  server = t.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  manager2 = (await t.login('MANAGER2')).token;
}, 180_000);

afterAll(async () => {
  server.closeAllConnections(); // open event streams would keep close() waiting
  await new Promise((resolve) => server.close(resolve));
  await t.stop();
});

/** Opens the stream and collects the text it receives. */
async function listen(token: string, branchId?: string) {
  const ac = new AbortController();
  const res = await fetch(`${base}/events`, {
    headers: { authorization: `Bearer ${token}`, ...(branchId ? { 'x-branch-id': branchId } : {}) },
    signal: ac.signal,
  });
  const decoder = new TextDecoder();
  let text = '';
  const reader = res.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    text: () => text,
    close: () => ac.abort(),
  };
}
const until = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('topics', () => {
  it('maps a request path to the part of the screen it touches', () => {
    expect(topicOf('/orders/abc/items')).toBe('orders');
    expect(topicOf('/bills/x/settle')).toBe('orders');
    expect(topicOf('/shifts/open')).toBe('day');
    expect(topicOf('/business-days/close')).toBe('day');
    expect(topicOf('/khata/accounts')).toBe('khata');
    expect(topicOf('/items/1')).toBe('menu');
    expect(topicOf('/printers')).toBe('printers');
    expect(topicOf('/users')).toBe('misc');
    expect(topicOf('/')).toBe('misc');
  });
});

describe('GET /events', () => {
  it('needs a signed-in user', async () => {
    const res = await fetch(`${base}/events`);
    expect(res.status).toBe(401);
  });

  it('streams a ready event, then a change after a write in the same branch', async () => {
    const stream = await listen(manager);
    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain('text/event-stream');
    await until(() => stream.text().includes('event: ready'));
    expect(hub.count(t.branchId)).toBeGreaterThan(0);

    // a write by somebody else in the branch
    const res = await fetch(`${base}/areas`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner}`,
        'x-branch-id': t.branchId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Garden' }),
    });
    expect(res.status).toBe(201);
    await until(() => stream.text().includes('event: change'));
    expect(stream.text()).toContain('"topic":"misc"');
    stream.close();
  });

  it('does not tell another branch, and a failed write sends nothing', async () => {
    const other = await listen(manager2);
    await until(() => other.text().includes('event: ready'));
    const mine = await listen(manager);
    await until(() => mine.text().includes('event: ready'));

    await fetch(`${base}/areas`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner}`,
        'x-branch-id': t.branchId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Rooftop' }),
    });
    await until(() => mine.text().includes('event: change'));
    const bad = await fetch(`${base}/areas`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner}`,
        'x-branch-id': t.branchId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    await new Promise((r) => setTimeout(r, 300));
    expect(other.text()).not.toContain('event: change');
    expect(mine.text().match(/event: change/g)).toHaveLength(1); // the 400 did not publish
    other.close();
    mine.close();
  });

  it('forgets a client that disconnects', async () => {
    await until(() => hub.count(t.branchId) === 0); // earlier streams finish closing
    const before = 0;
    const s = await listen(manager);
    await until(() => s.text().includes('event: ready'));
    expect(hub.count(t.branchId)).toBe(before + 1);
    s.close();
    await until(() => hub.count(t.branchId) === before);
  });
});
