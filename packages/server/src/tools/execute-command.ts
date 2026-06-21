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
import { getSSHSessionService, type ExecResult } from "../services/ssh-session-service.js";
import { Logger } from "../utils/logger.js";
import { ToolError, toToolError } from "../utils/tool-error.js";

/**
 * Phase 6.5.2:execute-command 工具对接 SSHSessionService + RBAC + audit。
 *
 * 数据流:
 * 1. 从 extra.requestInfo.headers.authorization 取 Bearer token
 * 2. AuthService.verifyBearer → OperatorContext
 * 3. ServerManager.getByName(args.serverName) 拿 server
 * 4. 校验 RBAC:ctx.canAccessServer(server.id) + scope('write' 或 'admin')
 * 5. 调 SSHSessionService.exec({operatorId, serverId, cmdString, options})
 * 6. 写 audit_logs(成功/失败/拒绝)
 *
 * 不再依赖 SSHConnectionManager.getInstance() 单例(Phase 5.5.3 已废弃)。
 * Spec 6.5.2 / 6.5.2.2:命令不在 whitelist 时返回 COMMAND_VALIDATION_FAILED,
 * 审计 status='denied'。
 */

const ExecuteCommandArgsSchema = z.object({
  command: z.string().min(1).max(1024).describe("Command to execute on the remote server"),
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
  directory: z
    .string()
    .optional()
    .describe("Working directory for command execution"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Command execution timeout in milliseconds (default 30000)"),
  pty: z
    .boolean()
    .optional()
    .describe("Allocate pseudo-tty (default true)"),
});

export type ExecuteCommandArgs = z.infer<typeof ExecuteCommandArgsSchema>;

/**
 * 公开视图(MCP 客户端可见)。故意省略所有加密字段(命令输出除外)。
 */
export interface ExecuteCommandResult {
  serverName: string;
  command: string;
  directory?: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
  durationMs: number;
}

/**
 * 人类可读 + 原始 JSON 双视图(保留 Phase 6.5 之前的风格,数据源换为 DB)。
 */
export function formatExecResult(
  args: { serverName: string; command: string; directory?: string },
  result: ExecResult,
): string {
  const lines: string[] = [];
  lines.push(`Command executed on ${args.serverName}:`);
  lines.push(`  command: ${args.command}`);
  if (args.directory) lines.push(`  directory: ${args.directory}`);
  lines.push(`  exitCode: ${result.exitCode}`);
  lines.push(`  durationMs: ${result.durationMs}`);
  lines.push("");
  if (result.stdout) {
    lines.push("--- stdout ---");
    lines.push(result.stdout);
  }
  if (result.stderr) {
    lines.push("");
    lines.push("--- stderr ---");
    lines.push(result.stderr);
  }
  lines.push("");
  lines.push("Raw JSON:");
  lines.push(
    JSON.stringify(
      {
        serverName: args.serverName,
        command: args.command,
        directory: args.directory,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      } satisfies ExecuteCommandResult,
      null,
      2,
    ),
  );
  return lines.join("\n");
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
  exitCode?: number | null;
  durationMs: number;
}): void {
  getAuditService().write({
    operatorId: params.operatorId,
    operatorType: params.operatorType,
    serverId: params.serverId ?? null,
    action: "execute_command",
    input: params.input,
    output: params.output,
    exitCode: params.exitCode ?? null,
    status: params.status,
    errorMessage: params.errorMessage,
    durationMs: params.durationMs,
  });
}

/**
 * 核心 handler。单独导出,方便测试时直接调,不必经过 McpServer 反射。
 */
export async function executeCommandHandler(
  args: ExecuteCommandArgs,
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
    command: args.command,
    serverName: targetServerName,
    ...(args.directory !== undefined ? { directory: args.directory } : {}),
  };

  // 1. 鉴权
  const authHeader = extractAuthHeader(extra);
  const ctx = auth.verifyBearer(authHeader);
  if (!ctx) {
    audit.write({
      operatorId: null,
      operatorType: "human",
      action: "execute_command",
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

  // 4. scope 校验:execute_command 需 write 或 admin
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

  // 5. 执行命令
  try {
    const result = await getSSHSessionService().exec({
      operatorId: ctx.operator.id,
      serverId: server.id,
      cmdString: args.command,
      options: {
        ...(args.directory !== undefined ? { directory: args.directory } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.pty !== undefined ? { pty: args.pty } : {}),
      },
    });

    // 成功 audit
    const output = result.stderr
      ? `${result.stdout}\n${result.stderr}`
      : result.stdout;
    writeAudit({
      operatorId: ctx.operator.id,
      operatorType: ctx.isAgent ? "agent" : "human",
      serverId: server.id,
      input: baseInput,
      output,
      exitCode: result.exitCode,
      status: "success",
      durationMs: result.durationMs,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: formatExecResult(
            { serverName: targetServerName, command: args.command, ...(args.directory !== undefined ? { directory: args.directory } : {}) },
            result,
          ),
        },
      ],
    };
  } catch (error) {
    // 失败 audit + 重新抛错
    if (error instanceof ToolError) {
      const status: "denied" | "failed" =
        error.code === "COMMAND_VALIDATION_FAILED" ? "denied" : "failed";
      writeAudit({
        operatorId: ctx.operator.id,
        operatorType: ctx.isAgent ? "agent" : "human",
        serverId: server.id,
        input: baseInput,
        status,
        errorMessage: error.message,
        exitCode: error.code === "COMMAND_TIMEOUT" ? null : null,
        durationMs: Date.now() - start,
      });
      throw error;
    }
    const toolError = toToolError(error, "UNKNOWN_ERROR");
    Logger.handleError(toolError, "execute-command failed");
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
export function registerExecuteCommandTool(server: McpServer): void {
  server.registerTool(
    "execute-command",
    {
      description:
        "Execute a command on a registered SSH server. Requires authentication (Bearer token) and write/admin scope.",
      inputSchema: {
        command: ExecuteCommandArgsSchema.shape.command,
        serverName: ExecuteCommandArgsSchema.shape.serverName,
        connectionName: ExecuteCommandArgsSchema.shape.connectionName,
        directory: ExecuteCommandArgsSchema.shape.directory,
        timeoutMs: ExecuteCommandArgsSchema.shape.timeoutMs,
        pty: ExecuteCommandArgsSchema.shape.pty,
      },
    },
    async (args, extra) => executeCommandHandler(args, extra),
  );
}
