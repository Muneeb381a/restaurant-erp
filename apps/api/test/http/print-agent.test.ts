import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPrintJobs, TcpTransport } from '../../src/modules/printing/print.service';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let captain: string;
let cashier: string;
const api = (tok: string) => t.as(tok);
const V1 = '/api/v1';

let key = '';
let agentId = '';
const asAgent = (k = key) => ({
  post: (path: string, body: object = {}) =>
    request(t.app).post(`${V1}/print-agent${path}`).set('x-print-key', k).send(body),
});
const jobs = () => t.kdb.selectFrom('print_jobs').selectAll().orderBy('seq').execute();
const agentPrinter = (kind: 'RECEIPT' | 'KOT') =>
  t.kdb
    .selectFrom('printers')
    .select('id')
    .where('agent_id', '=', agentId)
    .where('kind', '=', kind)
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  captain = (await t.login('CAPTAIN')).token;
  cashier = (await t.login('CASHIER')).token;
}, 240_000);
afterAll(async () => {
  await t.stop();
});

describe('the print helper', () => {
  it('is set up by the owner only; its key is shown once and unknown keys are refused', async () => {
    expect((await api(captain).post('/print-agents', { name: 'Counter PC' })).status).toBe(403);
    const made = await api(owner).post('/print-agents', { name: 'Counter PC' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    key = made.body.key;
    agentId = made.body.id;
    expect(key.startsWith(`${agentId}.`)).toBe(true);

    expect((await asAgent('nonsense').post('/hello', { printers: [] })).status).toBe(401);
    expect((await asAgent(`${agentId}.wrongsecret`).post('/hello', { printers: [] })).status).toBe(
      401,
    );
    // the stored value is a hash, never the key
    const row = await t.kdb
      .selectFrom('print_agents')
      .selectAll()
      .where('id', '=', agentId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(key.split('.')[1]!);

    const list = (await api(owner).get('/print-agents')).body.items as Json[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Counter PC', online: false, printers: [] });
  });

  it('hello makes the receipt and kitchen printer on the chosen printer, once', async () => {
    const hello = {
      computer: 'COUNTER-PC',
      printers: [{ name: 'Microsoft Print to PDF' }, { name: 'POS-80', isDefault: true }],
      chosen: 'POS-80',
    };
    const first = await asAgent().post('/hello', hello);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.printers.map((p: Json) => p.kind).sort()).toEqual(['KOT', 'RECEIPT']);
    expect(first.body.printers.every((p: Json) => p.windowsName === 'POS-80')).toBe(true);

    const second = await asAgent().post('/hello', hello); // a restart changes nothing
    expect(second.body.printers).toHaveLength(2);
    const rows = await t.kdb
      .selectFrom('printers')
      .selectAll()
      .where('agent_id', '=', agentId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.conn_type === 'AGENT' && r.is_active)).toBe(true);

    const list = (await api(owner).get('/print-agents')).body.items as Json[];
    expect(list[0]).toMatchObject({ online: true, computer: 'COUNTER-PC' });
    expect(list[0].printersSeen.map((p: Json) => p.name)).toContain('POS-80');
  });

  it('hands out jobs one at a time in order, and the in-process worker leaves them alone', async () => {
    const receipt = (await agentPrinter('RECEIPT')).id;
    expect((await api(owner).post(`/printers/${receipt}/test`, {})).status).toBe(202);
    expect((await api(owner).post(`/printers/${receipt}/test`, {})).status).toBe(202);

    // the LAN worker must not touch (or give up on) a printer that the helper serves
    const pass = await processPrintJobs(t.ctx, new TcpTransport());
    expect(pass).toEqual({ printed: 0, failed: 0, dead: 0 });
    expect((await jobs()).every((j) => j.status === 'PENDING')).toBe(true);

    const first = await asAgent().post('/claim');
    expect(first.body.jobs).toHaveLength(1);
    const job = first.body.jobs[0];
    expect(job.printer).toBe('POS-80');
    expect(Buffer.from(job.payloadBase64, 'base64').length).toBeGreaterThan(10);

    // the second job waits until the first has an answer (a ticket never overtakes an older one)
    expect((await asAgent().post('/claim')).body.jobs).toHaveLength(0);
    expect((await asAgent().post(`/jobs/${job.id}/result`, { ok: true })).status).toBe(204);
    expect((await asAgent().post(`/jobs/${job.id}/result`, { ok: true })).status).toBe(204); // a repeat is harmless
    const second = await asAgent().post('/claim');
    expect(second.body.jobs).toHaveLength(1);
    expect(second.body.jobs[0].id).not.toBe(job.id);

    // a failure keeps the job, with a pause, and the printer shows as having a problem
    await asAgent().post(`/jobs/${second.body.jobs[0].id}/result`, {
      ok: false,
      error: 'printer is off',
    });
    const all = await jobs();
    expect(all.map((j) => j.status)).toEqual(['DONE', 'FAILED']);
    expect(all[1]!.last_error).toBe('printer is off');
    expect(all[1]!.next_attempt_at.getTime()).toBeGreaterThan(t.clock.now().getTime());
    const health = (await api(owner).get('/printers/health')).body.items as Json[];
    expect(health.find((p) => p.id === receipt)).toMatchObject({ state: 'OFFLINE' });

    // a helper cannot touch another helper's jobs
    const other = await api(owner).post('/print-agents', { name: 'Other PC' });
    const res = await asAgent(other.body.key).post(`/jobs/${second.body.jobs[0].id}/result`, {
      ok: true,
    });
    expect(res.status).toBe(404);
  });

  it("kitchen tickets of a station with no printer chosen go to the helper's kitchen printer", async () => {
    const lists: { id: string }[] = [];
    for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
      lists.push((await api(owner).post('/price-lists', { code, name: code })).body);
    const station = (await api(owner).post('/stations', { code: 'GRILL', name: 'Grill' })).body.id;
    const item = await api(owner).post('/items', {
      kind: 'STANDARD',
      name: 'Seekh',
      stationId: station,
    });
    for (const l of lists)
      await api(owner).put(`/variants/${item.body.variants[0].id}/prices/${l.id}`, {
        pricePaisa: 50000,
      });
    const day = await api(owner).post('/business-days/open', {});
    expect([200, 201, 409]).toContain(day.status);
    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: item.body.id,
      variantId: item.body.variants[0].id,
    });
    const sent = await api(captain).post(`/orders/${o.id}/send`, {});
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.unprinted).toEqual([]); // there is a printer for it

    const kot = await agentPrinter('KOT');
    const ticket = (await jobs()).find((j) => j.kind === 'KOT');
    expect(ticket?.printer_id).toBe(kot.id);
  });

  it('receipts go to the helper while it is online, and to the browser (no job, receipts = 0) once it is not', async () => {
    const lists = (await api(owner).get('/price-lists')).body.items as { id: string }[];
    const stations = (await api(owner).get('/stations')).body.items as { id: string }[];
    const item = await api(owner).post('/items', {
      kind: 'STANDARD',
      name: 'Naan',
      stationId: stations[0]!.id,
    });
    for (const l of lists)
      await api(owner).put(`/variants/${item.body.variants[0].id}/prices/${l.id}`, {
        pricePaisa: 10000,
      });
    const cash = (
      await api(owner).post('/payment-methods', {
        code: 'CASH',
        name: 'Cash',
        tender_class: 'CASH_OTHER',
        opens_drawer: true,
      })
    ).body;
    expect(
      (await api(cashier).post('/shifts/open', { openingFloatPaisa: 100000 })).status,
    ).toBeLessThan(300);

    const sell = async (): Promise<Json> => {
      const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
      await api(captain).post(`/orders/${o.id}/items`, {
        itemId: item.body.id,
        variantId: item.body.variants[0].id,
      });
      await api(captain).post(`/orders/${o.id}/send`, {});
      const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
      const res = await api(cashier)
        .post(`/bills/${bill.id}/settle`, {
          tenders: [
            { methodId: cash.id, amountPaisa: bill.totalPaisa, tenderedPaisa: bill.totalPaisa },
          ],
        })
        .set('Idempotency-Key', `k-${Math.random().toString(36).slice(2)}-${Date.now()}`);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    };

    await asAgent().post('/claim'); // the helper checks in: it is online
    const online = await sell();
    expect(online.receipts).toBe(1); // queued for the helper's receipt printer
    const receipt = await agentPrinter('RECEIPT');
    const queued = (await jobs()).filter(
      (j) => j.kind === 'RECEIPT' && j.printer_id === receipt.id,
    );
    expect(queued).toHaveLength(1);

    // the helper stops calling (the counter computer is off): after a minute and a half the till falls back to the browser
    t.clock.advance(120_000);
    const offline = await sell();
    expect(offline.receipts).toBe(0);
    expect((await jobs()).filter((j) => j.kind === 'RECEIPT')).toHaveLength(1); // no second receipt job was piled up

    // it comes back, and receipts go to it again
    await asAgent().post('/claim');
    expect((await sell()).receipts).toBe(1);
  });

  it('a removed helper stops working and its printers are gone', async () => {
    expect((await api(owner).patch(`/print-agents/${agentId}`, { printer: 'IT800' })).status).toBe(
      204,
    );
    const rows = await t.kdb
      .selectFrom('printers')
      .select('agent_printer')
      .where('agent_id', '=', agentId)
      .execute();
    expect(rows.every((r) => r.agent_printer === 'IT800')).toBe(true);

    expect((await api(owner).delete(`/print-agents/${agentId}`)).status).toBe(204);
    expect((await asAgent().post('/claim')).status).toBe(401);
    const list = (await api(owner).get('/print-agents')).body.items as Json[];
    expect(list.some((a) => a.id === agentId)).toBe(false);
    const gone = await t.kdb
      .selectFrom('printers')
      .select(['is_active', 'archived_at'])
      .where('agent_id', '=', agentId)
      .execute();
    expect(gone.every((p) => !p.is_active && p.archived_at !== null)).toBe(true);
  });
});
