import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { validate } from '../src/middleware/validate.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const Body = z.object({ name: z.string().trim().min(1) });

function run(reqLike: Partial<Request>) {
  const req = reqLike as Request;
  const next = vi.fn() as unknown as NextFunction;
  validate({ body: Body })(req, {} as Response, next);
  return { req, next };
}

describe('validate middleware', () => {
  it('passes and sanitizes a valid body', () => {
    const { req, next } = run({ body: { name: '  hi  ' } });
    expect(next).toHaveBeenCalledOnce();
    expect(req.body.name).toBe('hi'); // trimmed
  });

  it('throws ZodError on an invalid body', () => {
    expect(() => run({ body: {} })).toThrow(ZodError);
  });
});

describe('errorHandler ZodError mapping', () => {
  it('turns a ZodError into a 400 with field details', () => {
    let err: unknown;
    try {
      Body.parse({ name: '' });
    } catch (e) {
      err = e;
    }

    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json } as unknown as Response;
    errorHandler(err, {} as Request, res, vi.fn() as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({ path: 'name' }),
        ]),
      }),
    );
  });
});
