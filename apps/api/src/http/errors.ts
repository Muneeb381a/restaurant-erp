import {
  BillError,
  DealError,
  DrawerError,
  LineError,
  ModifierError,
  MoneyError,
  PriceError,
  TenderError,
} from '@erp/domain';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Stable, documented error codes (docs/ERROR-CODES.md). Never rename; only add. */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'REFRESH_REUSED'
  | 'DEVICE_INVALID'
  | 'PERMISSION_DENIED'
  | 'BRANCH_REQUIRED'
  | 'CONFLICT'
  | 'REFERENCE_VIOLATION'
  | 'CONSTRAINT_VIOLATION'
  | 'ROLE_PROTECTED'
  | 'LAST_OWNER'
  | 'DAY_NOT_OPEN'
  | 'DAY_ALREADY_OPEN'
  | 'SHIFT_ALREADY_OPEN'
  | 'TABLE_OCCUPIED'
  | 'ORDER_NOT_EDITABLE'
  | 'ORDER_HELD'
  | 'ORDER_HAS_SENT_ITEMS'
  | 'ITEM_NOT_EDITABLE'
  | 'ITEM_UNAVAILABLE'
  | 'ITEM_NOT_ON_MENU'
  | 'EMPTY_ORDER'
  | 'UNSENT_ITEMS'
  | 'BILL_NOT_PAYABLE'
  | 'BILL_ALREADY_SETTLED'
  | 'DISCOUNT_APPROVAL_REQUIRED'
  | 'APPROVER_INVALID'
  | 'SHIFT_NOT_OPEN'
  | 'TENDER_UNSUPPORTED'
  | 'VARIANCE_NOTE_REQUIRED'
  | 'SHIFTS_STILL_OPEN'
  | 'ORDERS_STILL_OPEN'
  | 'NOTHING_TO_SEND'
  | 'STATION_MISSING'
  | 'NO_PRINTER'
  | 'VERSION_CONFLICT'
  | 'PRECONDITION_REQUIRED';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** RFC 7807 problem+json body. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  [extra: string]: unknown;
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

function isDomainError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof DealError ||
    err instanceof LineError ||
    err instanceof BillError ||
    err instanceof DrawerError ||
    err instanceof TenderError ||
    err instanceof ModifierError ||
    err instanceof PriceError ||
    err instanceof MoneyError
  );
}

interface PgError {
  code: string;
  constraint?: string;
}

function isPgIntegrityError(err: unknown): err is PgError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    /^23[0-9A-Z]{3}$/.test((err as { code: string }).code)
  );
}

/** Maps Postgres integrity violations (SQLSTATE class 23) to stable API errors. */
function fromPg(err: PgError): AppError {
  const extra = err.constraint ? { constraint: err.constraint } : undefined;
  switch (err.code) {
    case '23505':
      return new AppError(
        409,
        'CONFLICT',
        'A record with the same unique value already exists',
        extra,
      );
    case '23P01': // exclusion constraint (e.g. overlapping price periods)
      return new AppError(409, 'CONFLICT', 'Overlaps an existing record', extra);
    case '23503':
      return new AppError(
        409,
        'REFERENCE_VIOLATION',
        'Referenced or referencing record conflict',
        extra,
      );
    case '23514':
      return new AppError(
        400,
        'CONSTRAINT_VIOLATION',
        'Value violates a database constraint',
        extra,
      );
    default: // 23001 restrict (append-only / immutable guards), 23502 not-null, ...
      return new AppError(
        409,
        'CONSTRAINT_VIOLATION',
        'Operation blocked by a database guard',
        extra,
      );
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appErr = isPgIntegrityError(err) ? fromPg(err) : err;
  let problem: Problem;
  if (appErr instanceof AppError) {
    problem = {
      type: `urn:erp:error:${appErr.code}`,
      title: appErr.message,
      status: appErr.status,
      code: appErr.code,
      ...appErr.extra,
    };
  } else if (isDomainError(err)) {
    // Pure-domain rule violations (bad deal pick, missing price, invalid amount, …).
    problem = {
      type: 'urn:erp:error:VALIDATION_FAILED',
      title: err.message,
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: err.code,
    };
  } else if (err instanceof ZodError) {
    problem = {
      type: 'urn:erp:error:VALIDATION_FAILED',
      title: 'Request validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      issues: err.issues,
    };
  } else if (err instanceof SyntaxError && 'body' in err) {
    problem = {
      type: 'urn:erp:error:VALIDATION_FAILED',
      title: 'Malformed JSON body',
      status: 400,
      code: 'VALIDATION_FAILED',
    };
  } else {
    req.log?.error({ err }, 'unhandled error');
    problem = {
      type: 'urn:erp:error:INTERNAL_ERROR',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL_ERROR',
    };
  }
  problem.requestId = req.id;
  res.status(problem.status).type('application/problem+json').json(problem);
};
