import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAuthService } from '../../services/auth-service.js';
import { getOperatorManager } from '../../services/operator-manager.js';

const LoginBody = z.object({
  name: z.string().min(1),
  password: z.string().min(1),
});

const CreateOperatorBody = z.object({
  type: z.enum(['human', 'agent']),
  name: z.string().min(1),
  credential: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  serverPermissions: z.array(z.string()).optional(),
});

export function registerAuthRoutes(app: FastifyInstance) {
  // 登录
  app.post('/api/v1/auth/login', async (request, reply) => {
    try {
      const body = LoginBody.parse(request.body);
      const result = getAuthService().loginAsHuman(body.name, body.password);
      if (!result) {
        reply.code(401).send({
          code: 'UNAUTHORIZED',
          message: 'Invalid credentials',
          retriable: false,
        });
        return;
      }
      return {
        token: result.token,
        operator: {
          id: result.operator.id,
          name: result.operator.name,
          type: result.operator.type,
          scopes: result.operator.scopes,
        },
      };
    } catch (e: any) {
      if (e.name === 'ZodError') {
        reply.code(400).send({ code: 'VALIDATION_ERROR', message: e.message });
        return;
      }
      throw e;
    }
  });

  // 当前操作者
  app.get('/api/v1/auth/whoami', { preHandler: [] }, async (request, reply) => {
    const ctx = getAuthService().verifyBearer(request.headers.authorization);
    if (!ctx) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }
    return {
      id: ctx.operator.id,
      name: ctx.operator.name,
      type: ctx.operator.type,
      scopes: ctx.scopes,
    };
  });

  // 创建 operator(人类或 Agent,admin only)
  app.post('/api/v1/operators', { preHandler: [] }, async (request, reply) => {
    const ctx = getAuthService().verifyBearer(request.headers.authorization);
    if (!ctx || !ctx.hasScope('admin')) {
      reply.code(403).send({ code: 'INSUFFICIENT_SCOPE', message: 'admin scope required' });
      return;
    }
    try {
      const body = CreateOperatorBody.parse(request.body);
      const result = getOperatorManager().create(body);
      reply.code(201);
      return {
        operator: {
          id: result.operator.id,
          name: result.operator.name,
          type: result.operator.type,
          scopes: result.operator.scopes,
          enabled: result.operator.enabled,
        },
        // plainCredential 仅在创建时返回一次
        plainCredential: result.plainCredential,
      };
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
  });

  // 轮换 API Key(Agent,admin only)
  app.post<{ Params: { id: string } }>('/api/v1/operators/:id/rotate-key', async (request, reply) => {
    const ctx = getAuthService().verifyBearer(request.headers.authorization);
    if (!ctx || !ctx.hasScope('admin')) {
      reply.code(403).send({ code: 'INSUFFICIENT_SCOPE', message: 'admin scope required' });
      return;
    }
    const result = getOperatorManager().rotateApiKey(request.params.id);
    if (!result) {
      reply.code(404).send({ code: 'NOT_FOUND', message: 'Agent operator not found' });
      return;
    }
    return {
      id: result.operator.id,
      name: result.operator.name,
      plainCredential: result.plainCredential,
    };
  });
}
