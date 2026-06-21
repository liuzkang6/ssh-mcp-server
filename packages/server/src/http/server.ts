import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerAuthRoutes } from './routes/auth.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerTerminalRoutes } from './routes/terminal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 兼容 source 直跑 / build 后跑
//   - build 后: packages/server/dist/http/server.js → ../../../web-dist
//   - source:   packages/server/src/http/server.ts  → ../../web-dist
//   - 工作目录: cwd/web-dist
const webDistCandidates = [
  join(__dirname, '..', '..', '..', 'web-dist'),
  join(__dirname, '..', '..', 'web-dist'),
  join(process.cwd(), 'web-dist'),
];

function findWebDist(): string | null {
  for (const p of webDistCandidates) {
    if (existsSync(join(p, 'index.html'))) return p;
  }
  return null;
}

export interface HttpServerOptions {
  port?: number;
  host?: string;
  enableCors?: boolean;
  logger?: boolean;
  serveWeb?: boolean;
}

export async function createHttpServer(opts: HttpServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    disableRequestLogging: true,
  });

  if (opts.enableCors !== false) {
    await app.register(cors, { origin: true, credentials: true });
  }

  // 路由注册
  await app.register(fastifyWebsocket);
  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerServerRoutes(app);
  registerAuditRoutes(app);
  registerTerminalRoutes(app);

  // 托管 Web UI 静态资源
  if (opts.serveWeb !== false) {
    const webDist = findWebDist();
    if (webDist) {
      await app.register(fastifyStatic, {
        root: webDist,
        prefix: '/',
      });
      // SPA 兜底:任何未匹配的非 /api 路径都返回 index.html
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/')) {
          reply.code(404).send({ code: 'NOT_FOUND', message: 'Endpoint not found' });
          return;
        }
        if (webDist) {
          return reply.sendFile('index.html', webDist);
        }
        reply.code(404).send({ code: 'NOT_FOUND' });
      });
    }
  }

  return app;
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<FastifyInstance> {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const host = opts.host ?? '0.0.0.0';

  const app = await createHttpServer(opts);
  await app.listen({ port, host });
  return app;
}
