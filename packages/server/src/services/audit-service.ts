import { ulid } from "ulid";
import { getDb } from "../db/index.js";
import { auditLogs, type NewAuditLog } from "../db/schema.js";
import { sanitizeAndTruncate } from "../security/sanitize.js";

/**
 * 审计日志服务。
 *
 * 提供统一的写入和查询接口。所有 MCP tool / API / WebSocket 调用完成后
 * 必须通过此服务写一行 audit_logs,字段自动脱敏。
 */

export interface AuditWriteInput {
  operatorId: string | null;
  operatorType: "human" | "agent";
  serverId?: string | null;
  action: string;
  input?: unknown;
  output?: string | null;
  exitCode?: number | null;
  status: "success" | "failed" | "denied" | "cancelled";
  errorMessage?: string | null;
  durationMs?: number | null;
  sessionId?: string | null;
}

export class AuditService {
  /**
   * 写入一条审计日志。
   * - output 自动截断 10KB
   * - errorMessage 自动过滤凭证
   */
  write(input: AuditWriteInput): string {
    const { db } = getDb();
    const id = ulid();
    const row: NewAuditLog = {
      id,
      sessionId: input.sessionId ?? null,
      operatorId: input.operatorId,
      operatorType: input.operatorType,
      serverId: input.serverId ?? null,
      action: input.action,
      input: input.input !== undefined ? (input.input as any) : null,
      output: input.output ? sanitizeAndTruncate(input.output, 10 * 1024) : null,
      exitCode: input.exitCode ?? null,
      status: input.status,
      errorMessage: input.errorMessage
        ? sanitizeAndTruncate(input.errorMessage, 4 * 1024)
        : null,
      durationMs: input.durationMs ?? null,
      createdAt: Date.now(),
    };
    try {
      db.insert(auditLogs).values(row).run();
    } catch (e) {
      // 审计失败不应阻塞主流程,只记日志
      const { Logger } = require("../utils/logger.js");
      Logger.log(
        `Failed to write audit log: ${(e as Error).message}`,
        "error",
      );
    }
    return id;
  }
}

let _instance: AuditService | null = null;
export function getAuditService(): AuditService {
  if (!_instance) _instance = new AuditService();
  return _instance;
}
