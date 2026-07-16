import { describe, expect, it } from 'vitest';
import { buildRunEmf, METRICS_NAMESPACE } from '../src/metrics.js';

describe('buildRunEmf', () => {
  it('produces a valid EMF envelope for a successful run', () => {
    const emf = buildRunEmf({
      outcome: 'success',
      durationMs: 1234.5,
      rowsWritten: 2,
      keysWritten: 2,
    });

    const meta = (emf._aws as { CloudWatchMetrics: { Namespace: string }[] }).CloudWatchMetrics[0];
    expect(meta.Namespace).toBe(METRICS_NAMESPACE);
    expect(emf.outcome).toBe('success');
    expect(emf.HydrationRunCount).toBe(1);
    expect(emf.HydrationFailureCount).toBe(0);
    expect(emf.HydrationDuration).toBe(1234.5);
    expect(emf.RowsWritten).toBe(2);
    expect(emf.KeysWritten).toBe(2);
  });

  it('counts a failed run', () => {
    const emf = buildRunEmf({
      outcome: 'failure',
      durationMs: 10,
      rowsWritten: 0,
      keysWritten: 0,
    });
    expect(emf.HydrationFailureCount).toBe(1);
    expect(emf.RowsWritten).toBe(0);
  });
});
