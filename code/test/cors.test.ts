import { describe, expect, it } from 'vitest';
import request from 'supertest';

// Config reads env at import time, so set the allowlist before importing the app.
process.env.CORS_ORIGINS = 'https://app.example.com';
const { createApp } = await import('../src/app.js');
const app = createApp();

describe('CORS', () => {
  it('allows a configured origin', async () => {
    const res = await request(app)
      .get('/healthz')
      .set('Origin', 'https://app.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('does not allow an unconfigured origin', async () => {
    const res = await request(app)
      .get('/healthz')
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight without requiring auth', async () => {
    const res = await request(app)
      .options('/api/items')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });
});
