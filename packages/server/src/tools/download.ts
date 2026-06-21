import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { getServerManager } from "../services/server-manager.js";
import { getAuthService } from "../services/auth-service.js";
import { getAuditService } from "../services/audit-service.js";
import { getSSHSessionService } from "../services/ssh-session-service.js";
import { Logger } from "../utils/logger.js";
import { ToolError, toToolError } from "../utils/tool-error.js";

/**
 * Phase 6.5.3:download 工具对接 SSHSessionService + RBAC + audit。
 *
 * 数据流:
 * 1. 从 extra.requestInfo.headers.authorization 取 Bearer token
 * 2. AuthService.verifyBearer → OperatorContext
 * 3. ServerManager.getByName(args.serverName) 拿 server
 * 4. 校验 RBAC:ctx.canAccessServer(server.id) + scope('write' 或 'admin')
 * 5. 调 SSHSessionService.download({operatorId, serverId, options: {remotePath, localPath}})
 * 6. 写 audit_logs(成功/失败/拒绝)
 *
 * 不再依赖 SSHConnectionManager.getInstance() 单例(Phase 5.5.3 已废弃)。
 * 路径合法性、目的端父目录存在性等均由 SSHSessionService 内部校验
 * (validateLocalPath 用 'write' purpose),失败抛 ToolError。
 */

const DownloadArgsSchema = z
  .object({
    remotePath: z
      .string()
      .min(1)
      .max(1024)
      .describe("Absolute POSIX path on the remote server"),
    localPath: z
      .string()
      .min(1)
      .max(1024)
      .describe("Local filesystem path where the file will be written"),
    // 主字段:从 DB servers.name 匹配
    serverName: z
      .string()
      .min(1)
      .optional()
      .describe("Server name (matches servers.name in DB)"),
    // 兼容老 CLI / 外部调用方:老 API 用 connectionName
    // Phase 8 CLI 改造后会移除
    connectionName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy alias for serverName (backward compat, prefer serverName)"),
  })
  .refine((d) => d.serverName || d.connectionName, {
    message: "serverName or connectionName is required",
  });

export type DownloadArgs = z.infer<typeof DownloadArgsSchema>;

/**
 * 公开视图(MCP 客户端可见)。仅 metadata,不含 server 凭证。
 */
export interface DownloadResult {
  success: true;
  bytesTransferred: number;
  durationMs: number;
  localPath: string;
}

/**
 * 人类可读 + 原始 JSON 双视图。
 */
export function formatDownloadResult(
  args: { serverName: string; localPath: string },
  result: { bytesTransferred: number; durationMs: number },
): string {
  return [
    `Downloaded ${result.bytesTransferred} bytes to ${args.localPath} in ${result.durationMs}ms`,
    "",
    "Raw JSON:",
    JSON.stringify(
      {
        success: true as const,
        bytesTransferred: result.bytesTransferred,
        durationMs: result.durationMs,
        localPath: args.localPath,
      } satisfies DownloadResult,
      null,
      2,
    ),
  ].join("\n");
}

/**
 * 兼容 streamable HTTP / stdio 两种 transport 的 header 提取。
 * IsomorphicHeaders 允许 string | string[] | undefined。
 */
function extractAuthHeader(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): string | undefined {
  const headers = extra.requestInfo?.headers;
  if (!headers) return undefined;
  const raw = headers["authorization"] ?? headers["Authorization"];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Audit 写入辅助。统一字段,避免每次重复拼。
 */
function writeAudit(params: {
  operatorId: string | null;
  operatorType: "human" | "agent";
  serverId?: string | null;
  input: unknown;
  status: "success" | "failed" | "denied" | "cancelled";
  errorMessage?: string;
  output?: string;
  durationMs: number;
}): void {
  getAuditService().write({
    operatorId: params.operatorId,
    operatorType: params.operatorType,
    serverId: params.serverId ?? null,
    action: "download_file",
    input: params.input,
    output: params.output,
    exitCode: null,
    status: params.status,
    errorMessage: params.errorMessage,
    durationMs: params.durationMs,
  });
}

/**
 * 核心 handler。单独导出,方便测试时直接调,不必经过 McpServer 反射。
 */
export async function downloadHandler(
  args: DownloadArgs,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const start = Date.now();
  const audit = getAuditService();
  const auth = getAuthService();

  // 解析 serverName(优先 serverName,fallback 到 connectionName)
  const targetServerName = args.serverName ?? args.connectionName;
  if (!targetServerName) {
    throw new ToolError(
      "UNKNOWN_ERROR",
      "Either serverName or connectionName is required",
      false,
    );
  }

  const baseInput = {
    remotePath: args.remotePath,
    localPath: args.localPath,
    serverName: targetServerName,
  };

  // 1. 鉴权
  const authHeader = extractAuthHeader(extra);
  const ctx = auth.verifyBearer(authHeader);
  if (!ctx) {
    audit.write({
      operatorId: null,
      operatorType: "human",
      action: "download_file",
      input: baseInput,
      status: "denied",
      errorMessage: "Missing or invalid credentials",
      durationMs: Date.now() - start,
    });
    throw new ToolError(
      "UNAUTHORIZED",
      "Missing or invalid credentials",
      false,
    );
  }

  // 2. server 解析
  const server = getServerManager().getByName(targetServerName);
  if (!server) {
    writeAudit({
      operatorId: ctx.operator.id,
      operatorType: ctx.isAgent ? "agent" : "human",
      serverId: null,
      input: baseInput,
      status: "failed",
      errorMessage: `Server not found: ${targetServerName}`,
      durationMs: Date.now() - start,
    });
    throw new ToolError(
      "SERVER_NOT_FOUND",
      `Server not found: ${targetServerName}`,
      false,
    );
  }

  // 3. RBAC:server 级访问
  if (!ctx.canAccessServer(server.id)) {
    writeAudit({
      operatorId: ctx.operator.id,
      operatorType: ctx.isAgent ? "agent" : "human",
      serverId: server.id,
      input: baseInput,
      status: "denied",
      errorMessage: `No permission to access server: ${server.id}`,
      durationMs: Date.now() - start,
    });
    throw new ToolError(
      "SERVER_ACCESS_DENIED",
      `No permission to access server: ${server.id}`,
      false,
    );
  }

  // 4. scope 校验:download 需 write 或 admin
  if (!ctx.hasScope("write") && !ctx.hasScope("admin")) {
    writeAudit({
      operatorId: ctx.operator.id,
      operatorType: ctx.isAgent ? "agent" : "human",
      serverId: server.id,
      input: baseInput,
      status: "denied",
      errorMessage: "Scope 'write' or 'admin' is required",
      durationMs: Date.now() - start,
    });
    throw new ToolError(
      "INSUFFICIENT_SCOPE",
      "Scope 'write' or 'admin' is required",
      false,
    );
  }

  // 5. 下载文件
  try {
    const result = await getSSHSessionService().download({
      operatorId: ctx.operator.id,
      serverId: server.id,
      options: {
        remotePath: args.remotePath,
        localPath: args.localPath,
      },
    });

    // 成功 audit
    const outputText = `Downloaded ${result.bytesTransferred} bytes to ${args.localPath} in ${result.durationMs}ms`;
    writeAudit({
      operatorId: ctx.operator.id,
      operatorType: ctx.isAgent ? "agent" : "human",
      serverId: server.id,
      input: baseInput,
      output: outputText,
      status: "success",
      durationMs: result.durationMs,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: formatDownloadResult(
            { serverName: targetServerName, localPath: args.localPath },
            result,
          ),
        },
      ],
    };
  } catch (error) {
    // 失败 audit + 重新抛错
    if (error instanceof ToolError) {
      const status: "denied" | "failed" =
        error.code === "LOCAL_PATH_NOT_ALLOWED" ||
        error.code === "REMOTE_PATH_NOT_ALLOWED"
          ? "denied"
          : "failed";
      writeAudit({
        operatorId: ctx.operator.id,
        operatorType: ctx.isAgent ? "agent" : "human",
        serverId: server.id,
        input: baseInput,
        status,
        errorMessage: error.message,
        durationMs: Date.now() - start,
      });
      throw error;
    }
    const toolError = toToolError(error, "UNKNOWN_ERROR");
    Logger.handleError(toolError, "download failed");
    writeAudit({
      operatorId: ctx.operator.id,
      operatorType: ctx.isAgent ? "agent" : "human",
      serverId: server.id,
      input: baseInput,
      status: "failed",
      errorMessage: toolError.message,
      durationMs: Date.now() - start,
    });
    throw toolError;
  }
}

/**
 * 注册到 McpServer。第二个参数 args 由 SDK 通过 zod 验证,extra 由 SDK 注入。
 */
export function registerDownloadTool(server: McpServer): void {
  server.registerTool(
    "download",
    {
      description:
        "Download a file from a registered SSH server via SFTP to the local filesystem. Requires authentication (Bearer token) and write/admin scope.",
      inputSchema: {
        remotePath: DownloadArgsSchema.shape.remotePath,
        localPath: DownloadArgsSchema.shape.localPath,
        serverName: DownloadArgsSchema.shape.serverName,
        connectionName: DownloadArgsSchema.shape.connectionName,
      },
    },
    async (args, extra) => downloadHandler(args, extra),
  );
}
