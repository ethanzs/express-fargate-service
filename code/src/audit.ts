import type { Request } from 'express';
import { logger } from './logger.js';

/**
 * Audit log — a deliberate, separate stream from operational/debug logs.
 * Every line is tagged `log_type: "audit"` so it can be filtered in Logs
 * Insights or routed to a dedicated log group / S3 via a CloudWatch
 * subscription filter (with its own retention and access controls).
 *
 * The level is pinned to 'info' so audit events are never silenced by a higher
 * LOG_LEVEL (e.g. 'warn') in production.
 *
 * This is the seam for the upcoming admin/RBAC work: call recordAudit() on any
 * security-relevant action (role change, admin mutation, access denied).
 */
const auditLogger = logger.child({ log_type: 'audit' }, { level: 'info' });

export interface AuditDetails {
  /** Dotted action name, e.g. 'item.delete' or 'role.grant'. */
  action: string;
  /** What was acted on, e.g. an item id. */
  target?: string;
  outcome?: 'success' | 'failure' | 'denied';
  /** Any extra, non-PII context. */
  [key: string]: unknown;
}

/**
 * Records an audit event, deriving the actor (pseudonymous oid/tid) and
 * correlation id from the authenticated request.
 */
export function recordAudit(req: Request, details: AuditDetails): void {
  auditLogger.info(
    {
      actorId: req.auth?.oid,
      tenantId: req.auth?.tid,
      requestId: req.id,
      outcome: 'success',
      ...details,
    },
    'audit',
  );
}
