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

const MAX_RESULTS_PER_SERVER = 1000;

/**
 * find 命令构造器
 * - name pattern 转义
 * - type f|d
 * - maxDepth 控制
 */
function buildFindCommand(pattern: string, searchPath: string, type?: string, maxDepth?: number): string {
  // 简单转义单引号
  const safePattern = pattern.replace(/'/g, "'\\''");
  const parts = ["find", `'${searchPath}'`];
  if (maxDepth !== undefined && maxDepth > 0) {
    parts.push(`-maxdepth ${Math.floor(maxDepth)}`);
  }
  parts.push(`-name '${safePattern}'`);
  if (type === "f" || type === "d") {
    parts.push(`-type ${type}`);
  }
  return parts.join(" ");
}

export interface SearchFilesArgs {
  servers: string[];
  pattern: string;
  path?: string;
  type?: "f" | "d";
  maxDepth?: number;
  timeout?: number;
}

/**
 * 核心 handler。单独导出,方便测试时直接调,不必经过 McpServer 反射。
 *
 * 现有实现未做 Bearer 鉴权(工具由 trust 的 stdio transport 调用),
 * 因此 `extra` 参数被忽略;写 audit 时 `operatorId=null / operatorType='agent'`。
 */
export async function searchFilesHandler(
  args: SearchFilesArgs,
  _extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const { servers, pattern, path, type, maxDepth, timeout } = args;
  const start = Date.now();
  const audit = getAuditService();
  try {
    const srvMgr = getServerManager();
    const targets = servers
      .map((n) => srvMgr.getByName(n))
      .filter((s): s is NonNullable<typeof s> => !!s);

    if (targets.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "No valid servers found" }),
          },
        ],
        isError: true,
      };
    }

    const searchPath = path || "/";
    const cmd = buildFindCommand(pattern, searchPath, type, maxDepth) + ` 2>/dev/null | head -n ${MAX_RESULTS_PER_SERVER}`;
    const effTimeout = timeout ?? 30000;

    const results: BatchResult[] = await getBatchExecutor().execute(
      targets,
      cmd,
      Math.min(5, targets.length),
      effTimeout,
      false,
    );

    // 把 stdout 解析为文件列表
    const output = results.map((r) => ({
      serverName: r.serverName,
      serverId: r.serverId,
      status: r.status,
      files: r.stdout
        ? r.stdout.split("\n").filter((line) => line.trim()).slice(0, MAX_RESULTS_PER_SERVER)
        : [],
      truncated: (r.stdout?.split("\n").filter((l) => l.trim()).length ?? 0) >= MAX_RESULTS_PER_SERVER,
      error: r.error,
    }));

    // 审计
    audit.write({
      operatorId: null,
      operatorType: "agent",
      action: "search_files",
      input: { servers, pattern, path, type, maxDepth, timeout: effTimeout },
      status: "success",
      durationMs: Date.now() - start,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ results: output }, null, 2),
        },
      ],
    };
  } catch (e) {
    Logger.handleError(e, "search_files failed");
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

export function registerSearchFilesTool(server: McpServer): void {
  server.registerTool(
    "search-files",
    {
      description:
        "Search files across multiple servers (wraps the find command).",
      inputSchema: {
        servers: z.array(z.string()).describe("Server names to search"),
        pattern: z.string().describe("File name pattern (passed to find -name)"),
        path: z
          .string()
          .optional()
          .describe("Search root path (default /)"),
        type: z
          .enum(["f", "d"])
          .optional()
          .describe("File type: f (file) or d (directory)"),
        maxDepth: z
          .number()
          .optional()
          .describe("Max directory depth (passed to -maxdepth)"),
        timeout: z
          .number()
          .optional()
          .describe("Per-server timeout in ms (default 30000)"),
      },
    },
    async (args, extra) => searchFilesHandler(args, extra),
  );
}
