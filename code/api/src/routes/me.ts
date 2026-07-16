import { Router } from 'express';

/**
 * Returns the authenticated caller's identity, derived from the verified token
 * claims. Useful for the frontend to confirm who it's signed in as.
 */
export const meRouter: Router = Router();

meRouter.get('/me', (req, res) => {
  const claims = req.auth ?? {};
  res.json({
    id: claims.oid,
    name: claims.name,
    username: claims.preferred_username,
    tenantId: claims.tid,
    roles: claims.roles ?? [],
  });
});
