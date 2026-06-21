import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getServerManager } from '../../services/server-manager.js';
import { getPool } from '../../services/ssh-connection-pool.js';
import { getSSHSessionService } from '../../services/ssh-session-service.js';
import { getAuditService } from '../../services/audit-service.js';
import { ToolError, toToolError } from '../../utils/tool-error.js';
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

  // 当前活跃 sessions(Web 终端"当前连接"列表用)
  app.get<{ Params: { id: string } }>(
    '/api/v1/servers/:id/active-sessions',
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
      const entries = getPool().getActiveSessions(server.id);
      return {
        count: entries.length,
        sessions: entries.map((e) => ({
          sessionId: e.sessionId ?? null,
          operatorId: e.operatorId,
          mode: e.mode,
          acquiredAt: e.acquiredAt,
          lastUsedAt: e.lastUsedAt,
          refCount: e.refCount,
        })),
      };
    }
  );

  // 单机执行命令(给 Web ServerDetail "命令" Tab 用)
  // 等价于 MCP tool execute-command,直接调 SSHSessionService.exec + 写 audit
  const ExecBody = z.object({
    command: z.string().min(1).max(1024),
    directory: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    pty: z.boolean().optional(),
  });
  app.post<{ Params: { id: string } }>(
    '/api/v1/servers/:id/exec',
    { preHandler: [authMiddleware, requireScope('write')] },
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
      const parsed = ExecBody.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
        return;
      }
      const body = parsed.data;
      const audit = getAuditService();
      const start = Date.now();
      try {
        const result = await getSSHSessionService().exec({
          operatorId: op.operator.id,
          serverId: server.id,
          cmdString: body.command,
          options: {
            ...(body.directory !== undefined ? { directory: body.directory } : {}),
            ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
            ...(body.pty !== undefined ? { pty: body.pty } : {}),
          },
        });
        const output = result.stderr
          ? `${result.stdout}\n${result.stderr}`
          : result.stdout;
        audit.write({
          operatorId: op.operator.id,
          operatorType: op.isAgent ? 'agent' : 'human',
          serverId: server.id,
          action: 'execute_command',
          input: { command: body.command, ...(body.directory !== undefined ? { directory: body.directory } : {}) },
          output,
          exitCode: result.exitCode,
          status: 'success',
          durationMs: result.durationMs,
        });
        return {
          command: body.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        };
      } catch (e) {
        const err = e instanceof ToolError ? e : toToolError(e, 'UNKNOWN_ERROR');
        const status: 'denied' | 'failed' =
          err.code === 'COMMAND_VALIDATION_FAILED' ? 'denied' : 'failed';
        audit.write({
          operatorId: op.operator.id,
          operatorType: op.isAgent ? 'agent' : 'human',
          serverId: server.id,
          action: 'execute_command',
          input: { command: body.command, ...(body.directory !== undefined ? { directory: body.directory } : {}) },
          status,
          errorMessage: err.message,
          durationMs: Date.now() - start,
        });
        const httpCode = err.code === 'COMMAND_VALIDATION_FAILED' ? 403 : 500;
        reply.code(httpCode);
        return { code: err.code, message: err.message };
      }
    }
  );

  // 上传文件(给 Web ServerDetail "文件" Tab 用)
  const UploadBody = z.object({
    localPath: z.string().min(1).max(1024),
    remotePath: z.string().min(1).max(1024),
  });
  app.post<{ Params: { id: string } }>(
    '/api/v1/servers/:id/upload',
    { preHandler: [authMiddleware, requireScope('write')] },
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
      const parsed = UploadBody.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
        return;
      }
      const body = parsed.data;
      const audit = getAuditService();
      const start = Date.now();
      try {
        const result = await getSSHSessionService().upload({
          operatorId: op.operator.id,
          serverId: server.id,
          options: { localPath: body.localPath, remotePath: body.remotePath },
        });
        audit.write({
          operatorId: op.operator.id,
          operatorType: op.isAgent ? 'agent' : 'human',
          serverId: server.id,
          action: 'upload_file',
          input: { localPath: body.localPath, remotePath: body.remotePath },
          output: `Uploaded ${result.bytesTransferred} bytes to ${body.remotePath}`,
          status: 'success',
          durationMs: result.durationMs,
        });
        return {
          success: true,
          bytesTransferred: result.bytesTransferred,
          durationMs: result.durationMs,
          remotePath: body.remotePath,
        };
      } catch (e) {
        const err = e instanceof ToolError ? e : toToolError(e, 'UNKNOWN_ERROR');
        const status: 'denied' | 'failed' =
          err.code === 'LOCAL_PATH_NOT_ALLOWED' || err.code === 'REMOTE_PATH_NOT_ALLOWED'
            ? 'denied'
            : 'failed';
        audit.write({
          operatorId: op.operator.id,
          operatorType: op.isAgent ? 'agent' : 'human',
          serverId: server.id,
          action: 'upload_file',
          input: { localPath: body.localPath, remotePath: body.remotePath },
          status,
          errorMessage: err.message,
          durationMs: Date.now() - start,
        });
        reply.code(err.code === 'LOCAL_PATH_NOT_ALLOWED' || err.code === 'REMOTE_PATH_NOT_ALLOWED' ? 403 : 500);
        return { code: err.code, message: err.message };
      }
    }
  );

  // 下载文件(给 Web ServerDetail "文件" Tab 用)
  const DownloadBody = z.object({
    remotePath: z.string().min(1).max(1024),
    localPath: z.string().min(1).max(1024),
  });
  app.post<{ Params: { id: string } }>(
    '/api/v1/servers/:id/download',
    { preHandler: [authMiddleware, requireScope('write')] },
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
      const parsed = DownloadBody.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
        return;
      }
      const body = parsed.data;
      const audit = getAuditService();
      const start = Date.now();
      try {
        const result = await getSSHSessionService().download({
          operatorId: op.operator.id,
          serverId: server.id,
          options: { remotePath: body.remotePath, localPath: body.localPath },
        });
        audit.write({
          operatorId: op.operator.id,
          operatorType: op.isAgent ? 'agent' : 'human',
          serverId: server.id,
          action: 'download_file',
          input: { remotePath: body.remotePath, localPath: body.localPath },
          output: `Downloaded ${result.bytesTransferred} bytes to ${body.localPath}`,
          status: 'success',
          durationMs: result.durationMs,
        });
        return {
          success: true,
          bytesTransferred: result.bytesTransferred,
          durationMs: result.durationMs,
          localPath: body.localPath,
        };
      } catch (e) {
        const err = e instanceof ToolError ? e : toToolError(e, 'UNKNOWN_ERROR');
        const status: 'denied' | 'failed' =
          err.code === 'LOCAL_PATH_NOT_ALLOWED' || err.code === 'REMOTE_PATH_NOT_ALLOWED'
            ? 'denied'
            : 'failed';
        audit.write({
          operatorId: op.operator.id,
          operatorType: op.isAgent ? 'agent' : 'human',
          serverId: server.id,
          action: 'download_file',
          input: { remotePath: body.remotePath, localPath: body.localPath },
          status,
          errorMessage: err.message,
          durationMs: Date.now() - start,
        });
        reply.code(err.code === 'LOCAL_PATH_NOT_ALLOWED' || err.code === 'REMOTE_PATH_NOT_ALLOWED' ? 403 : 500);
        return { code: err.code, message: err.message };
      }
    }
  );
}
