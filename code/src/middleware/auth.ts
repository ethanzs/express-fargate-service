import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from './errorHandler.js';

/**
 * Claims we care about from an Entra ID (Azure AD) access token.
 * See: https://learn.microsoft.com/entra/identity-platform/access-token-claims-reference
 */
export interface AuthClaims extends JWTPayload {
  /** Immutable user object id — the stable key to use for app data. */
  oid?: string;
  /** Tenant id. */
  tid?: string;
  name?: string;
  preferred_username?: string;
  /** Delegated permission scopes (space-separated). */
  scp?: string;
  /** App roles — used later for role-based access (admins, etc.). */
  roles?: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express augmentation requires the namespace form
  namespace Express {
    interface Request {
      /** Verified token claims, present after requireAuth. */
      auth?: AuthClaims;
    }
  }
}

/**
 * Remote JWK Set, built lazily so importing this module (e.g. in tests) does no
 * network I/O and doesn't require Azure config. jose caches the keys and
 * refreshes them on rotation automatically.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    if (!config.auth.tenantId) {
      throw new Error('Auth is not configured (AZURE_TENANT_ID is missing)');
    }
    jwks = createRemoteJWKSet(new URL(config.auth.jwksUri));
  }
  return jwks;
}

function getBearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new HttpError(401, 'Empty bearer token');
  return token;
}

/**
 * Express middleware that validates a Microsoft Entra ID access token:
 * signature (via JWKS), issuer, audience, and expiry. On success it attaches
 * the verified claims to req.auth; otherwise responds 401.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = getBearerToken(req);
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
    });
    req.auth = payload as AuthClaims;
    // Bind the actor to this request's logger so every subsequent line carries
    // who it belongs to. We log the immutable, pseudonymous oid/tid — never the
    // name/email PII from the token.
    req.log = req.log.child({ userId: payload.oid, tenantId: payload.tid });
    next();
  } catch (err) {
    if (err instanceof HttpError) return next(err);
    logger.debug({ err }, 'Token validation failed');
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

// Role-based access (admins, etc.) will build on req.auth.roles here later.
