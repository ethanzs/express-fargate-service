import { config } from './config.js';
import { logger } from './logger.js';

/** CloudWatch namespace these metrics land under. */
export const METRICS_NAMESPACE = 'HydratorService';

export interface RunMetric {
  outcome: 'success' | 'failure';
  durationMs: number;
  rowsWritten: number;
  keysWritten: number;
}

/**
 * Builds a CloudWatch Embedded Metric Format (EMF) log object for one hydration
 * run. When this is written to stdout and shipped to CloudWatch Logs by the ECS
 * awslogs driver, CloudWatch automatically extracts the embedded values as
 * metrics — no PutMetricData calls, no extra IAM.
 *
 * One line per run keeps volume trivial; dimensions stay low-cardinality
 * (service + env only — the outcome rides along as a queryable property, with
 * failures also counted as a dedicated metric for alarming).
 */
export function buildRunEmf(m: RunMetric): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: [['service', 'env']],
          Metrics: [
            { Name: 'HydrationRunCount', Unit: 'Count' },
            { Name: 'HydrationFailureCount', Unit: 'Count' },
            { Name: 'HydrationDuration', Unit: 'Milliseconds' },
            { Name: 'RowsWritten', Unit: 'Count' },
            { Name: 'KeysWritten', Unit: 'Count' },
          ],
        },
      ],
    },
    // Dimension + property values referenced by the metadata above.
    service: config.serviceName,
    env: config.env,
    outcome: m.outcome,
    // Metric values.
    HydrationRunCount: 1,
    HydrationFailureCount: m.outcome === 'failure' ? 1 : 0,
    HydrationDuration: m.durationMs,
    RowsWritten: m.rowsWritten,
    KeysWritten: m.keysWritten,
  };
}

/** Emits the EMF line for a completed (or failed) run. */
export function emitRunMetric(m: RunMetric): void {
  logger.info(buildRunEmf(m), 'emf');
}
