import type { Logger } from 'pino';
import type { Principal } from './context';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      /** Set by `authenticate`. */
      principal?: Principal;
      /** Effective branch for this request, set by `resolveBranch`. */
      branchId?: string;
    }
  }
}
