import { describe, expect, it } from 'vitest';
import { buildRequestEmf, METRICS_NAMESPACE } from '../src/middleware/metrics.js';

describe('buildRequestEmf', () => {
  it('produces a valid EMF envelope', () => {
    const emf = buildRequestEmf({
      method: 'GET',
      routePath: '/api/items/:id',
      statusCode: 200,
      latencyMs: 12.5,
    });

    const meta = (emf._aws as { CloudWatchMetrics: { Namespace: string }[] })
      .CloudWatchMetrics[0];
    expect(meta.Namespace).toBe(METRICS_NAMESPACE);
    expect(emf.route).toBe('GET /api/items/:id');
    expect(emf.statusClass).toBe('2xx');
    expect(emf.RequestCount).toBe(1);
    expect(emf.RequestLatency).toBe(12.5);
    expect(emf.HttpServerErrorCount).toBe(0);
  });

  it('flags 5xx as a server error', () => {
    const emf = buildRequestEmf({
      method: 'POST',
      routePath: '/api/items',
      statusCode: 503,
      latencyMs: 3,
    });
    expect(emf.statusClass).toBe('5xx');
    expect(emf.HttpServerErrorCount).toBe(1);
  });

  it('does not flag 4xx as a server error', () => {
    const emf = buildRequestEmf({
      method: 'GET',
      routePath: '/api/items/:id',
      statusCode: 404,
      latencyMs: 1,
    });
    expect(emf.statusClass).toBe('4xx');
    expect(emf.HttpServerErrorCount).toBe(0);
  });
});
