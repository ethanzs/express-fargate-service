import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** CloudWatch namespace these metrics land under. */
export const METRICS_NAMESPACE = 'ExpressFargateService';

export interface RequestMetric {
  method: string;
  /** Route TEMPLATE (e.g. /api/items/:id), not the raw URL — keeps cardinality low. */
  routePath: string;
  statusCode: number;
  latencyMs: number;
}

/**
 * Builds a CloudWatch Embedded Metric Format (EMF) log object for one completed
 * request. When this is written to stdout and shipped to CloudWatch Logs by the
 * ECS awslogs driver, CloudWatch automatically extracts the embedded values as
 * metrics — no PutMetricData calls, no extra IAM.
 *
 * Dimensions must stay low-cardinality (templated route + status class), or each
 * unique value spawns its own metric stream and cost balloons.
 */
export function buildRequestEmf(m: RequestMetric): Record<string, unknown> {
  const route = `${m.method} ${m.routePath}`;
  const statusClass = `${Math.floor(m.statusCode / 100)}xx`;
  return {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: [
            ['service', 'env'],
            ['service', 'env', 'route', 'statusClass'],
          ],
          Metrics: [
            { Name: 'RequestCount', Unit: 'Count' },
            { Name: 'RequestLatency', Unit: 'Milliseconds' },
            { Name: 'HttpServerErrorCount', Unit: 'Count' },
          ],
        },
      ],
    },
    // Dimension + property values referenced by the metadata above.
    service: config.serviceName,
    env: config.env,
    route,
    statusClass,
    statusCode: String(m.statusCode),
    // Metric values.
    RequestCount: 1,
    RequestLatency: m.latencyMs,
    HttpServerErrorCount: m.statusCode >= 500 ? 1 : 0,
  };
}

/**
 * Express middleware that emits one EMF line per completed request. Mount it
 * after routing has a chance to populate req.route (it reads it on 'finish').
 */
export function emfMetrics(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    const routePath = req.route?.path
      ? `${req.baseUrl}${req.route.path as string}`
      : 'unmatched';

    logger.info(
      buildRequestEmf({
        method: req.method,
        routePath,
        statusCode: res.statusCode,
        latencyMs,
      }),
      'emf',
    );
  });

  next();
}
