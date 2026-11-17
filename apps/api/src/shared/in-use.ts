import { AppError } from '../http/errors';

/**
 * A row that history points at (an order line, a bill, an order at a table) is never deleted, so the
 * past stays complete. Say so in words the person can act on: switch it off instead.
 */
export const inUse = (what: string, detail?: string): AppError =>
  new AppError(
    409,
    'IN_USE',
    `${what} is used${detail ? ` (${detail})` : ' by earlier records'}, so it cannot be deleted. Switch it off instead.`,
  );

/** Runs a delete; a foreign-key refusal from the database becomes the IN_USE answer above. */
export async function orInUse<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if ((e as { code?: string }).code === '23503') throw inUse(what);
    throw e;
  }
}
