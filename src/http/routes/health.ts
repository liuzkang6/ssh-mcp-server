import type { FastifyInstance } from 'fastify';
import { closeDb, getDb } from '../../db/index.js';

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
      activeSessions: 0, // TODO: Phase 10 实现
    };
  });
}
