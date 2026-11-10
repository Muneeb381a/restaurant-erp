import type { FiscalProvider } from '@erp/fiscal-adapters';
import type { AppContext } from '../../http/context';
import { defaultFiscalProviders, processFiscalJobs } from './fiscal.service';

/**
 * Reports queued bills and credit notes to the tax authority every few seconds. Safe next to other
 * workers (the claim is transactional) and safe to stop at any time: unreported documents stay queued.
 */
export function startFiscalWorker(
  ctx: AppContext,
  resolve: (code: string) => FiscalProvider | undefined = defaultFiscalProviders,
  intervalMs = 5000,
): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const tick = (): void => {
    if (running) return;
    running = processFiscalJobs(ctx, resolve)
      .then((r) => {
        if (r.submitted || r.retrying || r.rejected) ctx.logger.info(r, 'fiscal queue pass');
      })
      .catch((err: unknown) => ctx.logger.error({ err }, 'fiscal worker pass failed'))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
