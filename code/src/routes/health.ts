import { Router } from 'express';

/**
 * Liveness/health endpoint. Point the ALB target group health check and the
 * ECS container healthCheck at GET /healthz. Keep it cheap and dependency-free
 * so a slow database never marks the task unhealthy and triggers a needless
 * restart.
 */
export const healthRouter: Router = Router();

healthRouter.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
