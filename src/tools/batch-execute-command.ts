import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { getServerManager } from "../services/server-manager.js";
import { getBatchExecutor, type BatchResult } from "../services/batch-executor.js";
import { getAuditService } from "../services/audit-service.js";
import { Logger } from "../utils/logger.js";

export interface BatchExecuteCommandArgs {
  servers?: string[];
  group?: string;
  tag?: string;
  cmdString: string;
  parallel?: number;
  timeout?: number;
  failFast?: boolean;
}

/**
 * 核心 handler。单独导出,方便测试时直接调,不必经过 McpServer 反射。
 *
 * 现有实现未做 Bearer 鉴权(工具由 trust 的 stdio transport 调用),
 * 因此 `extra` 参数被忽略;写 audit 时 `operatorId=null / operatorType='agent'`。
 */
export async function batchExecuteCommandHandler(
  args: BatchExecuteCommandArgs,
  _extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const { servers, group, tag, cmdString, parallel, timeout, failFast } = args;
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
            type: "text" as const,
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
          type: "text" as const,
          text: JSON.stringify({ summary, results }, null, 2),
        },
      ],
    };
  } catch (e) {
    Logger.handleError(e, "batch_execute_command failed");
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ code: "INTERNAL_ERROR", message: (e as Error).message }),
        },
      ],
      isError: true,
    };
  }
}

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
    async (args, extra) => batchExecuteCommandHandler(args, extra),
  );
}
