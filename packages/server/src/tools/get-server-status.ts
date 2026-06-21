import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, ConnectConfig } from "ssh2";
import { SocksClient } from "socks";
import { URL } from "node:url";
import { getServerManager } from "../services/server-manager.js";
import { collectSystemStatus } from "../utils/status-collector.js";
import { Logger } from "../utils/logger.js";
import { getAuditService } from "../services/audit-service.js";

interface SocksConfig {
  type?: 5;
  host: string;
  port: number;
  userId?: string;
  password?: string;
}

function parseSocksProxy(proxyUrl: string | null): SocksConfig | undefined {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    if (u.protocol !== "socks5:" && u.protocol !== "socks5h:") return undefined;
    return {
      type: 5,
      host: u.hostname,
      port: Number(u.port || 1080),
      userId: u.username || undefined,
      password: u.password || undefined,
    };
  } catch {
    return undefined;
  }
}

async function runCommand(
  serverId: string,
  cmd: string,
  timeout: number,
): Promise<string> {
  const srvMgr = getServerManager();
  const server = srvMgr.getById(serverId);
  if (!server) throw new Error(`Server not found: ${serverId}`);
  const creds = srvMgr.getDecryptedCredentials(serverId);
  if (!creds) throw new Error("Server credentials not found");

  const cfg: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 30000,
  };
  if (creds.privateKey) {
    cfg.privateKey = creds.privateKey;
    if (creds.passphrase) cfg.passphrase = creds.passphrase;
  } else if (creds.password) {
    cfg.password = creds.password;
  }

  const socks = parseSocksProxy(server.socksProxy);
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      try { client.end(); } catch {}
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    client.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });

    const onReady = () => {
      client.exec(cmd, (err, channel) => {
        if (err) {
          clearTimeout(timer);
          client.end();
          reject(err);
          return;
        }
        let stdout = "";
        channel.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        channel.stderr.on("data", () => {});
        channel.on("close", () => {
          clearTimeout(timer);
          client.end();
          resolve(stdout);
        });
        channel.on("error", (e: Error) => {
          clearTimeout(timer);
          client.end();
          reject(e);
        });
      });
    };
    client.on("ready", onReady);

    if (socks) {
      SocksClient.createConnection(
        {
          proxy: socks as any,
          command: "connect",
          destination: { host: server.host, port: server.port },
          timeout: 30000,
        },
        (err: Error | null, info: any) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          if (!info?.socket) {
            clearTimeout(timer);
            reject(new Error("SOCKS connection had no socket"));
            return;
          }
          client.connect({ ...cfg, sock: info.socket });
        },
      );
    } else {
      client.connect(cfg);
    }
  });
}

export interface GetServerStatusArgs {
  serverName: string;
  timeout?: number;
}

/**
 * 核心 handler。单独导出,方便测试时直接调,不必经过 McpServer 反射。
 *
 * 现有实现未做 Bearer 鉴权(工具由 trust 的 stdio transport 调用),
 * 因此 `extra` 参数被忽略;写 audit 时 `operatorId=null / operatorType='agent'`。
 */
export async function getServerStatusHandler(
  args: GetServerStatusArgs,
  _extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const { serverName, timeout } = args;
  const start = Date.now();
  const audit = getAuditService();
  try {
    const srvMgr = getServerManager();
    const server = srvMgr.getByName(serverName);
    if (!server) {
      throw new Error(`Server not found: ${serverName}`);
    }
    const effectiveTimeout = timeout ?? 30000;
    const status = await collectSystemStatus(
      (cmd) => runCommand(server.id, cmd, effectiveTimeout),
      server.name,
    );
    const durationMs = Date.now() - start;
    audit.write({
      operatorId: null,
      operatorType: "agent",
      serverId: server.id,
      action: "get_server_status",
      input: { serverName, timeout: effectiveTimeout },
      output: JSON.stringify(status),
      status: "success",
      durationMs,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
    };
  } catch (e: unknown) {
    const durationMs = Date.now() - start;
    audit.write({
      operatorId: null,
      operatorType: "agent",
      action: "get_server_status",
      input: { serverName },
      status: "failed",
      errorMessage: (e as Error).message,
      durationMs,
    });
    Logger.handleError(e, "get_server_status failed");
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

export function registerGetServerStatusTool(server: McpServer): void {
  server.registerTool(
    "get-server-status",
    {
      description:
        "Get system status (CPU/memory/disk/network/services) of a server.",
      inputSchema: {
        serverName: z.string().describe("Server name (must exist in DB)"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default 30000)"),
      },
    },
    async (args, extra) => getServerStatusHandler(args, extra),
  );
}
