import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { getAuthService, type OperatorContext } from '../../services/auth-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    operator?: OperatorContext;
  }
}

/**
 * 鉴权中间件:从 Authorization: Bearer xxx 提取凭证,挂到 request.operator。
 * 失败返回 401。
 */
export const authMiddleware: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const ctx = getAuthService().verifyBearer(request.headers.authorization);
  if (!ctx) {
    reply.code(401).send({
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing credentials',
      retriable: false,
    });
    return reply;
  }
  request.operator = ctx;
};

/**
 * 工厂:要求指定 scope 才放行。
 */
export function requireScope(scope: string): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.operator) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return reply;
    }
    if (!request.operator.hasScope(scope)) {
      reply.code(403).send({
        code: 'INSUFFICIENT_SCOPE',
        message: `Scope '${scope}' is required`,
        retriable: false,
      });
      return reply;
    }
  };
}

/**
 * 工厂:校验 operator 对某 serverId 的访问权限。
 */
export function requireServerAccess(getServerId: (req: FastifyRequest) => string): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.operator) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return reply;
    }
    const serverId = getServerId(request);
    if (!request.operator.canAccessServer(serverId)) {
      reply.code(403).send({
        code: 'SERVER_ACCESS_DENIED',
        message: `No permission to access server: ${serverId}`,
        retriable: false,
      });
      return reply;
    }
  };
}
