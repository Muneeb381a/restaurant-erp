import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import {
  agentHello,
  agentJobResult,
  authenticateAgent,
  claimAgentJobs,
  createAgent,
  listAgents,
  revokeAgent,
  setAgentPrinter,
} from './agent.service';

const seen = z.object({
  name: z.string().trim().min(1).max(200),
  isDefault: z.boolean().optional(),
});

/** What the print helper program calls. It signs in with its own key, not with a person's PIN. */
export function printAgentRouter(ctx: AppContext): Router {
  const r = Router();
  const agentOf = (req: Request) => authenticateAgent(ctx, req.header('x-print-key'));

  r.post(
    '/hello',
    asyncHandler(async (req, res) => {
      const agent = await agentOf(req);
      const body = z
        .object({
          computer: z.string().trim().max(120).optional(),
          printers: z.array(seen).max(50),
          chosen: z.string().trim().min(1).max(200).optional(),
        })
        .strict()
        .parse(req.body);
      res.json(await agentHello(ctx, agent, body));
    }),
  );
  r.post(
    '/claim',
    asyncHandler(async (req, res) => {
      const agent = await agentOf(req);
      res.json({ jobs: await claimAgentJobs(ctx, agent) });
    }),
  );
  r.post(
    '/jobs/:id/result',
    asyncHandler(async (req, res) => {
      const agent = await agentOf(req);
      const { id } = idParam.parse(req.params);
      const body = z
        .object({ ok: z.boolean(), error: z.string().max(500).optional() })
        .strict()
        .parse(req.body);
      await agentJobResult(ctx, agent, id, body);
      res.status(204).end();
    }),
  );
  return r;
}

/** What the owner uses in the app: set a helper up, see whether it is online, pick its printer, remove it. */
export function printAgentsAdminRouter(ctx: AppContext): Router {
  const r = Router();
  const write = [authenticate(ctx), resolveBranch(ctx), requirePermission(ctx, 'settings.manage')];
  const who = (req: Request) => ({ branchId: req.branchId!, userId: req.principal!.userId });

  r.get(
    '/print-agents',
    ...write,
    asyncHandler(async (req, res) => {
      res.json({ items: await listAgents(ctx, req.branchId!) });
    }),
  );
  r.post(
    '/print-agents',
    ...write,
    asyncHandler(async (req, res) => {
      const { name } = z
        .object({ name: z.string().trim().min(1).max(80) })
        .strict()
        .parse(req.body);
      res.status(201).json(await createAgent(ctx, who(req), name));
    }),
  );
  r.patch(
    '/print-agents/:id',
    ...write,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const { printer } = z
        .object({ printer: z.string().trim().min(1).max(200) })
        .strict()
        .parse(req.body);
      await setAgentPrinter(ctx, who(req), id, printer);
      res.status(204).end();
    }),
  );
  r.delete(
    '/print-agents/:id',
    ...write,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      await revokeAgent(ctx, who(req), id);
      res.status(204).end();
    }),
  );
  return r;
}
