import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { queryAuditLogs } from '../../tools/query-audit-logs.js';

const ListQuery = z.object({
  serverId: z.string().optional(),
  operatorId: z.string().optional(),
  action: z.string().optional(),
  status: z.enum(['success', 'failed', 'denied', 'cancelled']).optional(),
  sinceMinutes: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

export function registerAuditRoutes(app: FastifyInstance) {
  // 查询审计日志(自动按 server_permissions 过滤)
  app.get('/api/v1/audit-logs', { preHandler: authMiddleware }, async (request, reply) => {
    try {
      const q = ListQuery.parse(request.query);
      const op = request.operator!;
      const serverIds = op.operator.serverPermissions && op.operator.serverPermissions.length > 0
        ? op.operator.serverPermissions
        : undefined; // undefined = 无限制
      const rows = await queryAuditLogs({
        ...q,
        serverPermissionFilter: serverIds,
      });
      return { count: rows.length, logs: rows };
    } catch (e: any) {
      if (e.name === 'ZodError') {
        reply.code(400).send({ code: 'VALIDATION_ERROR', message: e.message });
        return;
      }
      throw e;
    }
  });
}
