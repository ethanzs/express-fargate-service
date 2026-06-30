import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { emfMetrics } from './middleware/metrics.js';
import { healthRouter } from './routes/health.js';
import { itemsRouter } from './routes/items.js';
import { meRouter } from './routes/me.js';

/**
 * Builds the Express app with no network side effects (no listen()).
 * This keeps the app importable in tests via supertest.
 */
export function createApp(): Express {
  const app = express();

  // Behind an ALB, trust the proxy so req.ip / protocol reflect the client.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // Security headers + request logging + JSON body parsing.
  app.use(helmet());
  // CORS for the browser SPA. Allowlist from config; deny all cross-origin when
  // unset. Preflight (OPTIONS) is handled here and short-circuits before auth.
  app.use(
    cors({
      origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    }),
  );
  // Log every request except the health check, which the ALB polls constantly
  // and would otherwise dominate log volume (and cost) and skew metrics.
  app.use(
    pinoHttp({
      logger,
      // Correlation id: reuse the ALB's trace id (or an upstream request id) so
      // a request can be followed across services; fall back to a fresh UUID.
      genReqId: (req) =>
        (req.headers['x-amzn-trace-id'] as string | undefined) ??
        (req.headers['x-request-id'] as string | undefined) ??
        randomUUID(),
      autoLogging: { ignore: (req) => req.url?.split('?')[0] === '/healthz' },
    }),
  );
  app.use(express.json({ limit: config.jsonBodyLimit }));

  // Emit CloudWatch EMF metrics per request (skip the health check, like logging).
  app.use((req, res, next) =>
    req.path === '/healthz' ? next() : emfMetrics(req, res, next),
  );

  // Public routes (health check must stay unauthenticated for the ALB/ECS).
  app.use('/', healthRouter);

  // Protected API: every /api route requires a valid Entra ID access token.
  const api = Router();
  api.use(requireAuth);
  api.use(meRouter);
  api.use(itemsRouter);
  app.use('/api', api);

  // 404 + centralized error handling (must be registered last).
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
