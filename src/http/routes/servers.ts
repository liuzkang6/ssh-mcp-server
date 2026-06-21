import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getServerManager } from '../../services/server-manager.js';
import { authMiddleware, requireScope } from '../middleware/auth.js';

const CreateServerBody = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  group: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  transportMode: z.enum(['exec', 'shell']).optional(),
  commandWhitelist: z.array(z.string()).optional(),
  commandBlacklist: z.array(z.string()).optional(),
  allowedRemotePaths: z.array(z.string()).optional(),
  socksProxy: z.string().optional(),
});

const UpdateServerBody = CreateServerBody.partial();

const ListQuery = z.object({
  group: z.string().optional(),
  tag: z.string().optional(),
  nameLike: z.string().optional(),
});

export function registerServerRoutes(app: FastifyInstance) {
  const mgr = getServerManager();

  // 列表(所有已登录用户可读)
  app.get('/api/v1/servers', { preHandler: authMiddleware }, async (request) => {
    const q = ListQuery.parse(request.query);
    const operator = request.operator!;
    const all = mgr.list(q);
    // RBAC:filter 到 operator 有权限的
    return all.filter((s) => operator.canAccessServer(s.id));
  });

  // 详情
  app.get<{ Params: { id: string } }>(
    '/api/v1/servers/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const op = request.operator!;
      const server = mgr.getById(request.params.id) || mgr.getByName(request.params.id);
      if (!server) {
        reply.code(404).send({ code: 'NOT_FOUND', message: 'Server not found' });
        return;
      }
      if (!op.canAccessServer(server.id)) {
        reply.code(403).send({ code: 'SERVER_ACCESS_DENIED', message: 'No permission' });
        return;
      }
      return server;
    }
  );

  // 创建(admin only)
  app.post(
    '/api/v1/servers',
    { preHandler: [authMiddleware, requireScope('admin')] },
    async (request, reply) => {
      try {
        const body = CreateServerBody.parse(request.body);
        const server = mgr.create(body);
        reply.code(201);
        return server;
      } catch (e: any) {
        if (e.name === 'ZodError') {
          reply.code(400).send({ code: 'VALIDATION_ERROR', message: e.message });
          return;
        }
        if (e.message?.includes('UNIQUE') || e.message?.includes('exists')) {
          reply.code(409).send({ code: 'CONFLICT', message: e.message });
          return;
        }
        throw e;
      }
    }
  );

  // 更新
  app.put<{ Params: { id: string } }>(
    '/api/v1/servers/:id',
    { preHandler: [authMiddleware, requireScope('admin')] },
    async (request, reply) => {
      try {
        const body = UpdateServerBody.parse(request.body);
        const server = mgr.update(request.params.id, body);
        if (!server) {
          reply.code(404).send({ code: 'NOT_FOUND', message: 'Server not found' });
          return;
        }
        return server;
      } catch (e: any) {
        if (e.name === 'ZodError') {
          reply.code(400).send({ code: 'VALIDATION_ERROR', message: e.message });
          return;
        }
        throw e;
      }
    }
  );

  // 删除
  app.delete<{ Params: { id: string } }>(
    '/api/v1/servers/:id',
    { preHandler: [authMiddleware, requireScope('admin')] },
    async (request, reply) => {
      const ok = mgr.delete(request.params.id);
      if (!ok) {
        reply.code(404).send({ code: 'NOT_FOUND', message: 'Server not found' });
        return;
      }
      reply.code(204);
      return null;
    }
  );
}
