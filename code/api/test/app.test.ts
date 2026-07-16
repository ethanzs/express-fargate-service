import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

describe('health (public)', () => {
  it('GET /healthz returns ok without auth', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// The /api surface is protected by Entra ID JWT validation. Without a valid
// bearer token every route returns 401. Exercising the success path requires a
// real token from your tenant (or a mocked JWKS) and is covered by integration
// tests against a running Azure app registration.
describe('protected API requires a bearer token', () => {
  it('GET /api/me returns 401 without a token', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('GET /api/items returns 401 without a token', async () => {
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await request(app).get('/api/items').set('Authorization', 'token abc');
    expect(res.status).toBe(401);
  });
});

describe('not found', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});
