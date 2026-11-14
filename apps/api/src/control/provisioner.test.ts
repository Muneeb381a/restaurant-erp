import { describe, expect, it, vi } from 'vitest';
import { createNeonProvisioner, ProvisionError } from './provisioner';

const ok = {
  project: { id: 'gentle-river-202020' },
  connection_uris: [
    {
      connection_parameters: {
        database: 'neondb',
        role: 'neondb_owner',
        password: 'p@ss/w:rd',
        host: 'ep-cool-darkness-a5b6c7d8.c-4.us-east-2.aws.neon.tech',
        pooler_host: 'ep-cool-darkness-a5b6c7d8-pooler.c-4.us-east-2.aws.neon.tech',
      },
    },
  ],
};
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Neon provisioner', () => {
  it('creates one project per restaurant and returns pooled and direct URLs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(201, ok));
    const p = createNeonProvisioner({
      apiKey: 'secret-key',
      regionId: 'aws-us-east-2',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await p.provision('lahore-karahi');

    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://console.neon.tech/api/v2/projects');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    const sent = JSON.parse(init.body as string).project;
    expect(sent).toMatchObject({
      name: 'erp-lahore-karahi',
      region_id: 'aws-us-east-2',
      default_endpoint_settings: { autoscaling_limit_max_cu: 1 },
    });
    expect(sent.org_id).toBeUndefined();

    expect(out.providerRef).toBe('gentle-river-202020');
    expect(out.url).toContain('-pooler.'); // the API uses the pooled endpoint
    expect(out.directUrl).not.toContain('-pooler.'); // migrations go direct
    // special characters in the password survive a round trip through a URL
    expect(decodeURIComponent(new URL(out.url).password)).toBe('p@ss/w:rd');
    expect(new URL(out.directUrl).searchParams.get('sslmode')).toBe('require');
  });

  it('passes the organisation when one is given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(201, ok));
    await createNeonProvisioner({
      apiKey: 'k',
      regionId: 'aws-eu-central-1',
      orgId: 'org-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).provision('x-y');
    expect(
      JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string).project.org_id,
    ).toBe('org-123');
  });

  it('says whether a failure may have left a project behind, and never leaks the key', async () => {
    const refused = createNeonProvisioner({
      apiKey: 'secret-key',
      regionId: 'r',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(json(401, { message: 'bad key' })) as unknown as typeof fetch,
    });
    await expect(refused.provision('abc')).rejects.toMatchObject({
      mayHaveCreated: false,
      message: 'Neon refused to create the project (HTTP 401): bad key',
    });

    const timedOut = createNeonProvisioner({
      apiKey: 'secret-key',
      regionId: 'r',
      fetchImpl: vi.fn().mockRejectedValue(new Error('socket hang up')) as unknown as typeof fetch,
    });
    const err = await timedOut.provision('abc').catch((e) => e as ProvisionError);
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).mayHaveCreated).toBe(true);
    expect((err as ProvisionError).message).not.toContain('secret-key');

    const malformed = createNeonProvisioner({
      apiKey: 'k',
      regionId: 'r',
      fetchImpl: vi.fn().mockResolvedValue(json(201, { project: {} })) as unknown as typeof fetch,
    });
    await expect(malformed.provision('abc')).rejects.toMatchObject({ mayHaveCreated: true });
  });
});
