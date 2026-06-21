import type { FastifyInstance } from 'fastify';
import { closeDb, getDb } from '../../db/index.js';
import { getPool } from '../../services/ssh-connection-pool.js';

const startTime = Date.now();

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/v1/health', async () => {
    let dbStatus = 'ok';
    try {
      const { sqlite } = getDb();
      sqlite.prepare('SELECT 1').get();
    } catch (e: any) {
      dbStatus = `error: ${e.message}`;
    }
    return {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      version: process.env.npm_package_version || '2.0.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      db: dbStatus,
      // 全局当前活跃 SSH session 数(来自 SSHConnectionPool,跨 server 聚合)
      activeSessions: getPool().size(),
    };
  });
}
