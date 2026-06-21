import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "../db/schema.js";
import { getServerManager } from "../services/server-manager.js";
import { getAuthService } from "../services/auth-service.js";
import { getAuditService } from "../services/audit-service.js";
import { Logger } from "../utils/logger.js";
import { ToolError, toToolError } from "../utils/tool-error.js";

/**
 * Phase 6.5.1:list-servers 工具对接 ServerManager + RBAC + audit。
 *
 * 数据流:
 * 1. 从 extra.requestInfo.headers.authorization 取 Bearer token
 * 2. AuthService.verifyBearer → OperatorContext
 * 3. ServerManager.list({}) 拿全表 → 按 ctx.canAccessServer 过滤
 * 4. 返回公开视图(不含加密字段)
 * 5. 写 audit_logs
 *
 * 注意:不再依赖 SSHConnectionManager.getAllServerInfos(),也不再暴露
 * 任何 encrypted_password / encrypted_private_key / encrypted_passphrase。
 */

/**
 * 公开视图(MCP 客户端可见)。故意省略所有加密字段。
 */
export interface ServerListItem {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group: string | null;
  tags: string[];
  description: string | null;
  transportMode: "exec" | "shell";
  commandWhitelistCount: number;
  commandBlacklistCount: number;
}

export function toServerListItem(s: Server): ServerListItem {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    group: s.group,
    tags: s.tags ?? [],
    description: s.description,
    transportMode: s.transportMode,
    commandWhitelistCount: (s.commandWhitelist ?? []).length,
    commandBlacklistCount: (s.commandBlacklist ?? []).length,
  };
}

/**
 * 摘要 + 原始 JSON 双视图(保留 Phase 6.5 之前的风格,数据源换为 DB)。
 */
export function formatServerList(items: ServerListItem[]): string {
  if (items.length === 0) {
    return "No SSH servers visible to the current operator.";
  }

  const summary = items.map((server) => {
    const parts = [
      `${server.name}`,
      `${server.username}@${server.host}:${server.port}`,
    ];
    if (server.group) parts.push(`group=${server.group}`);
    if (server.description) parts.push(`desc=${server.description}`);
    parts.push(
      `transport=${server.transportMode}`,
      `whitelist=${server.commandWhitelistCount}`,
      `blacklist=${server.commandBlacklistCount}`,
    );
    return parts.join(" | ");
  });

  return [
    "Visible SSH servers (RBAC filtered):",
    ...summary,
    "",
    "Raw JSON:",
    JSON.stringify(items, null, 2),
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
 * 核心 handler。单独导出,方便测试时直接调,不必经过 McpServer 反射。
 */
export async function listServersHandler(
  _args: undefined,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const start = Date.now();
  const authHeader = extractAuthHeader(extra);
  const auth = getAuthService();
  const audit = getAuditService();

  // 1. 鉴权
  const ctx = auth.verifyBearer(authHeader);
  if (!ctx) {
    audit.write({
      operatorId: null,
      operatorType: "human",
      action: "list_servers",
      input: { filter: {} },
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

  // 2. RBAC 过滤
  try {
    const allServers = getServerManager().list({});
    const visible = allServers.filter((s) => ctx.canAccessServer(s.id));
    const items = visible.map(toServerListItem);

    // 3. 审计
    audit.write({
      operatorId: ctx.operator.id,
      operatorType: ctx.isAgent ? "agent" : "human",
      action: "list_servers",
      input: { filter: {} },
      output: JSON.stringify({ count: items.length }),
      status: "success",
      durationMs: Date.now() - start,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: formatServerList(items),
        },
      ],
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const toolError = toToolError(error, "UNKNOWN_ERROR");
    Logger.handleError(toolError, "list-servers failed");
    audit.write({
      operatorId: ctx.operator.id,
      operatorType: ctx.isAgent ? "agent" : "human",
      action: "list_servers",
      input: { filter: {} },
      status: "failed",
      errorMessage: toolError.message,
      durationMs: Date.now() - start,
    });
    throw toolError;
  }
}

/**
 * 注册到 McpServer。第二个参数 extra 由 SDK 注入,含 requestInfo.headers。
 * 当前工具无 inputSchema,SDK 回调只传 extra。
 */
export function registerListServersTool(server: McpServer): void {
  server.registerTool(
    "list-servers",
    {
      description:
        "List all visible SSH server configurations for the current operator (RBAC filtered)",
    },
    async (extra) => listServersHandler(undefined, extra),
  );
}
