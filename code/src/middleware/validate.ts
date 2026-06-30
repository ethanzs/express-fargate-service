import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

interface Schemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

/**
 * Validates request input against zod schemas. The sanitized body is written
 * back to req.body (so handlers get trimmed/coerced values); params and query
 * are validated in place — in Express 5 `req.query` is a read-only getter, so it
 * can't be reassigned. A failed parse throws ZodError, which the central error
 * handler turns into a 400 with field-level detail.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (schemas.body) req.body = schemas.body.parse(req.body);
    if (schemas.params) schemas.params.parse(req.params);
    if (schemas.query) schemas.query.parse(req.query);
    next();
  };
}