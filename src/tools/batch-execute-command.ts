import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerManager } from "../services/server-manager.js";
import { getBatchExecutor, type BatchResult } from "../services/batch-executor.js";
import { getAuditService } from "../services/audit-service.js";
import { Logger } from "../utils/logger.js";

export function registerBatchExecuteCommandTool(server: McpServer): void {
  server.registerTool(
    "batch-execute-command",
    {
      description:
        "Execute the same command on multiple servers in parallel and collect results.",
      inputSchema: {
        servers: z
          .array(z.string())
          .optional()
          .describe("Specific server names (mutually exclusive with group/tag)"),
        group: z.string().optional().describe("Filter by server group"),
        tag: z.string().optional().describe("Filter by server tag"),
        cmdString: z.string().describe("Command to execute"),
        parallel: z
          .number()
          .optional()
          .describe("Max concurrent connections (default 5)"),
        timeout: z
          .number()
          .optional()
          .describe("Per-server timeout in ms (default 30000)"),
        failFast: z
          .boolean()
          .optional()
          .describe("Stop all on first failure (default false)"),
      },
    },
    async ({ servers, group, tag, cmdString, parallel, timeout, failFast }) => {
      const start = Date.now();
      const audit = getAuditService();
      try {
        const srvMgr = getServerManager();
        // 解析目标服务器:三个过滤源互斥,servers 优先
        let targets;
        if (servers && servers.length > 0) {
          targets = servers
            .map((n) => srvMgr.getByName(n))
            .filter((s): s is NonNullable<typeof s> => !!s);
        } else if (group) {
          targets = srvMgr.list({ group });
        } else if (tag) {
          targets = srvMgr.list({ tag });
        } else {
          targets = srvMgr.list();
        }

        if (targets.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  summary: { total: 0, success: 0, failed: 0, cancelled: 0 },
                  results: [],
                }),
              },
            ],
          };
        }

        const effParallel = parallel ?? 5;
        const effTimeout = timeout ?? 30000;
        const effFailFast = failFast ?? false;

        const results: BatchResult[] = await getBatchExecutor().execute(
          targets,
          cmdString,
          effParallel,
          effTimeout,
          effFailFast,
        );

        // 每台机器写一行 audit
        for (const r of results) {
          audit.write({
            operatorId: null,
            operatorType: "agent",
            serverId: r.serverId,
            action: "batch_execute_command",
            input: { cmdString, parallel: effParallel, timeout: effTimeout },
            output: r.stdout?.substring(0, 4096),
            exitCode: r.exitCode ?? null,
            status: r.status,
            errorMessage: r.error ?? null,
            durationMs: r.durationMs,
          });
        }

        const summary = {
          total: results.length,
          success: results.filter((r) => r.status === "success").length,
          failed: results.filter((r) => r.status === "failed").length,
          cancelled: results.filter((r) => r.status === "cancelled").length,
          durationMs: Date.now() - start,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ summary, results }, null, 2),
            },
          ],
        };
      } catch (e) {
        Logger.handleError(e, "batch_execute_command failed");
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
