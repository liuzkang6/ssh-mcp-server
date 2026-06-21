import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { auditLogs } from "../db/schema.js";
import { Logger } from "../utils/logger.js";

export interface QueryAuditLogsInput {
  serverId?: string;
  operatorId?: string;
  action?: string;
  status?: "success" | "failed" | "denied" | "cancelled";
  sinceMinutes?: number;
  limit?: number;
  offset?: number;
  /** 限制可访问的 server ID 列表(空表示无限制) */
  serverPermissionFilter?: string[];
}

export async function queryAuditLogs(input: QueryAuditLogsInput) {
  const { db } = getDb();
  const conds = [];
  if (input.serverId) conds.push(eq(auditLogs.serverId, input.serverId));
  if (input.operatorId) conds.push(eq(auditLogs.operatorId, input.operatorId));
  if (input.action) conds.push(eq(auditLogs.action, input.action));
  if (input.status) conds.push(eq(auditLogs.status, input.status));
  if (input.sinceMinutes) {
    const sinceMs = Date.now() - input.sinceMinutes * 60 * 1000;
    conds.push(gte(auditLogs.createdAt, sinceMs));
  }
  if (input.serverPermissionFilter && input.serverPermissionFilter.length > 0) {
    const placeholders = input.serverPermissionFilter.map(() => "?").join(",");
    conds.push(
      sql`(${auditLogs.serverId} IS NULL OR ${auditLogs.serverId} IN (${sql.raw(placeholders)}))`,
    );
  }

  const where = conds.length > 0 ? and(...conds) : undefined;
  const limit = Math.min(input.limit ?? 100, 1000);
  const offset = input.offset ?? 0;

  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  return rows;
}

export function registerQueryAuditLogsTool(server: McpServer): void {
  server.registerTool(
    "query-audit-logs",
    {
      description:
        "Query audit logs with filters. Returns logs in reverse chronological order.",
      inputSchema: {
        serverId: z.string().optional().describe("Filter by server ID"),
        operatorId: z.string().optional().describe("Filter by operator ID"),
        action: z.string().optional().describe("Filter by action (e.g. execute_command)"),
        status: z
          .enum(["success", "failed", "denied", "cancelled"])
          .optional()
          .describe("Filter by status"),
        sinceMinutes: z
          .number()
          .optional()
          .describe("Time window in minutes (default 60)"),
        limit: z.number().optional().describe("Max results (default 100, max 1000)"),
        offset: z.number().optional().describe("Pagination offset (default 0)"),
      },
    },
    async (args) => {
      try {
        const rows = await queryAuditLogs(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { count: rows.length, logs: rows },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        Logger.handleError(e, "query_audit_logs failed");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ code: "INTERNAL_ERROR", message: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
