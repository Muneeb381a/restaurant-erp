import type { Queryable } from '../../shared/tx';
import { AppError } from '../../http/errors';

/**
 * Replay guard for commands a till may send twice (see migration 0017). Call `replayOf` right after the
 * order is locked: if the key was used before, return what the first try answered and change nothing.
 * Call `rememberCommand` as the last step of the same transaction.
 */
export async function replayOf<T>(trx: Queryable, key: string, orderId: string): Promise<T | null> {
  const row = await trx
    .selectFrom('order_command_keys')
    .select(['order_id', 'result'])
    .where('key', '=', key)
    .executeTakeFirst();
  if (!row) return null;
  // the same key on a different order is a mistake in the caller, never a replay
  if (row.order_id !== orderId)
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'That Idempotency-Key belongs to another order',
    );
  return row.result as T;
}

export async function rememberCommand(
  trx: Queryable,
  key: string,
  orderId: string,
  command: string,
  result: unknown,
): Promise<void> {
  await trx
    .insertInto('order_command_keys')
    .values({ key, order_id: orderId, command, result: JSON.stringify(result) as never })
    .execute();
}
