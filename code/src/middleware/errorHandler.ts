import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config.js';
import { logger } from '../logger.js';

/** Reads a numeric `status`/`statusCode` off library errors (body-parser, etc.). */
function statusFromError(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const e = err as { status?: unknown; statusCode?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return 500;
}

/** Thrown by route handlers to return a specific HTTP status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 404 fallthrough for any unmatched route. */
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not Found' });
}

/**
 * Central error handler. Express 5 forwards rejected promises from async
 * handlers here automatically, so route code can simply `throw`.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 4-arg signature required by Express
  _next: NextFunction,
): void {
  // Validation failures (thrown by the validate middleware) → 400 with detail.
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  const status = statusFromError(err);
  // Client errors (4xx) are safe to surface; hide 5xx internals in production.
  const message =
    status < 500
      ? (err as Error).message
      : isProduction
        ? 'Internal Server Error'
        : (err as Error).message;

  if (status >= 500) {
    logger.error({ err }, 'Unhandled error');
  }

  res.status(status).json({ error: message });
}
