import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAuthService } from '../../services/auth-service.js';
import { getServerManager } from '../../services/server-manager.js';
import { getSSHSessionService } from '../../services/ssh-session-service.js';
import { getAuditService } from '../../services/audit-service.js';
import { Logger } from '../../utils/logger.js';

/**
 * Phase 10: Web 终端 WebSocket 路由。
 *
 * 路径:`GET /ws/terminal/:serverId`
 * 鉴权:Query string `token=<jwt>`,浏览器 WebSocket API 不支持自定义 header
 *      所以用 token 而非 Authorization 头。
 *
 * 协议(JSON 文本帧 + 二进制流):
 * - S→C text  `{type:"ready"}` 桥接建立成功
 * - S→C text  `{type:"output", data:"..."}` 任何非 JSON 字符串视为 shell 输出
 * - S→C text  `{type:"error", message:"..."}` 错误
 * - S→C text  `{type:"close", reason:"..."}` 关闭
 * - C→S text  输入(纯文本,无 JSON 包装)
 * - C→S text  `{type:"resize", cols, rows}` 设置 PTY 大小
 * - C→S text  `{type:"ping"}` 客户端心跳(可选)
 *
 * Phase 10.7: 客户端断开后,SSH shell session 进入 30s 宽限期;
 *            期间内同一 operator 再次连接 → "复活"同一 entry,复用 stream。
 */
export function registerTerminalRoutes(app: FastifyInstance): void {
  app.get<{ Params: { serverId: string } }>(
    '/ws/terminal/:serverId',
    {
      websocket: true,
      // 鉴权:在 connection 阶段读 query.token
      preValidation: async (request, reply) => {
        const token = readToken(request);
        if (!token) {
          reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Missing token query param' });
          return;
        }
        const ctx = getAuthService().verifyBearer(`Bearer ${token}`);
        if (!ctx) {
          reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid token' });
          return;
        }
        // 校验 server 存在 + 操作员有访问权限
        const mgr = getServerManager();
        const server = mgr.getById(request.params.serverId) || mgr.getByName(request.params.serverId);
        if (!server) {
          reply.code(404).send({ code: 'NOT_FOUND', message: 'Server not found' });
          return;
        }
        if (!ctx.canAccessServer(server.id)) {
          reply.code(403).send({ code: 'SERVER_ACCESS_DENIED', message: 'No permission' });
          return;
        }
        // 挂到 request,handler 阶段取
        (request as any).operator = ctx;
        (request as any).resolvedServer = server;
      },
    },
    async (socket, request) => {
      const op = (request as any).operator;
      const server = (request as any).resolvedServer;
      if (!op || !server) {
        try {
          socket.close(1011, 'auth context missing');
        } catch {
          // ignore
        }
        return;
      }

      const audit = getAuditService();
      const log = (msg: string) =>
        Logger.log(`[ws-term:${server.id}:${op.operator.id}] ${msg}`, 'info');

      log('websocket connection established');

      // 1) 拿 / 建 shell session(30s 宽限期)
      let handle;
      try {
        handle = await getSSHSessionService().shell({
          operatorId: op.operator.id,
          serverId: server.id,
          graceMs: 30000,
        });
      } catch (e) {
        const err = e as Error;
        log(`shell open failed: ${err.message}`);
        try {
          socket.send(JSON.stringify({ type: 'error', message: err.message }));
          socket.close(1011, 'shell open failed');
        } catch {
          // ignore
        }
        audit.write({
          operatorId: op.operator.id,
          operatorType: 'human',
          serverId: server.id,
          action: 'terminal.open',
          status: 'failed',
          errorMessage: err.message,
        });
        return;
      }

      // 2) 写审计:开始
      audit.write({
        operatorId: op.operator.id,
        operatorType: 'human',
        serverId: server.id,
        action: 'terminal.open',
        status: 'success',
      });

      // 3) 桥接 stream ↔ ws
      const stream = handle.stream;
      const onStreamData = (chunk: Buffer) => {
        try {
          socket.send(chunk.toString('utf8'));
        } catch (e) {
          log(`socket send failed: ${(e as Error).message}`);
        }
      };
      const onStreamClose = () => {
        log('ssh stream closed');
        try {
          socket.send(JSON.stringify({ type: 'close', reason: 'ssh stream closed' }));
          socket.close(1000, 'ssh stream closed');
        } catch {
          // ignore
        }
      };
      const onStreamError = (err: Error) => {
        log(`ssh stream error: ${err.message}`);
        try {
          socket.send(JSON.stringify({ type: 'error', message: err.message }));
        } catch {
          // ignore
        }
      };
      stream.on('data', onStreamData);
      stream.once('close', onStreamClose);
      stream.once('error', onStreamError);

      // 4) 通知客户端:ready
      try {
        socket.send(JSON.stringify({ type: 'ready' }));
      } catch (e) {
        log(`send ready failed: ${(e as Error).message}`);
      }

      // 5) 处理客户端消息
      let closed = false;
      const cleanup = async (reason: string) => {
        if (closed) return;
        closed = true;
        log(`cleanup: ${reason}`);
        stream.off('data', onStreamData);
        stream.off('close', onStreamClose);
        stream.off('error', onStreamError);
        try {
          socket.close(1000, reason);
        } catch {
          // ignore
        }
        // 写审计:关闭
        audit.write({
          operatorId: op.operator.id,
          operatorType: 'human',
          serverId: server.id,
          action: 'terminal.close',
          status: 'success',
          input: { reason },
        });
        // 30s 宽限期:close() 不会立即断 SSH,池里 draining 等待 30s
        await handle.close();
      };

      socket.on('message', (raw: Buffer) => {
        if (closed) return;
        const text = raw.toString('utf8');
        // 尝试解析为 JSON 控制帧
        if (text.length > 0 && text[0] === '{') {
          try {
            const ctrl = JSON.parse(text);
            if (ctrl && typeof ctrl === 'object') {
              if (ctrl.type === 'resize') {
                const cols = Number(ctrl.cols);
                const rows = Number(ctrl.rows);
                if (
                  Number.isInteger(cols) &&
                  Number.isInteger(rows) &&
                  cols > 0 &&
                  rows > 0 &&
                  cols < 1000 &&
                  rows < 1000
                ) {
                  try {
                    stream.setWindow(rows, cols, 0, 0);
                  } catch (e) {
                    log(`setWindow failed: ${(e as Error).message}`);
                  }
                }
                return;
              }
              if (ctrl.type === 'ping') {
                try {
                  socket.send(JSON.stringify({ type: 'pong' }));
                } catch {
                  // ignore
                }
                return;
              }
            }
          } catch {
            // 非 JSON,继续当 stdin
          }
        }
        // 写到 SSH stream
        try {
          stream.write(text);
        } catch (e) {
          log(`stream write failed: ${(e as Error).message}`);
        }
      });

      socket.on('close', () => {
        void cleanup('client closed');
      });
      socket.on('error', (err: Error) => {
        log(`socket error: ${err.message}`);
        void cleanup(`socket error: ${err.message}`);
      });
    },
  );
}

function readToken(request: FastifyRequest): string | null {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const t = url.searchParams.get('token');
  return t && t.length > 0 ? t : null;
}
