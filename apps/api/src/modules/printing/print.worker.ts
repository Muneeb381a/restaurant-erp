import type { AppContext } from '../../http/context';
import { processPrintJobs, type PrintTransport } from './print.service';

/**
 * Runs the print queue every `intervalMs`. Passes never overlap in one process; several
 * processes (API + worker) are safe too because the claim is transactional.
 * Returns a function that stops the loop and waits for the pass in progress.
 */
export function startPrintWorker(
  ctx: AppContext,
  transport: PrintTransport,
  intervalMs = 1000,
): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const tick = (): void => {
    if (running) return;
    running = processPrintJobs(ctx, transport)
      .then((r) => {
        if (r.printed || r.failed || r.dead) ctx.logger.info(r, 'print queue pass');
      })
      .catch((err: unknown) => ctx.logger.error({ err }, 'print worker pass failed'))
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
