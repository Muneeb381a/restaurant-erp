import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Stable, documented error codes (docs/ERROR-CODES.md). Never rename; only add. */
export type ErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | (string & {}),
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

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let problem: Problem;
  if (err instanceof AppError) {
    problem = {
      type: `urn:erp:error:${err.code}`,
      title: err.message,
      status: err.status,
      code: err.code,
      ...err.extra,
    };
  } else if (err instanceof ZodError) {
    problem = {
      type: 'urn:erp:error:VALIDATION_FAILED',
      title: 'Request validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      issues: err.issues,
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
