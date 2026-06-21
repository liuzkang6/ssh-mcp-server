import { Client, ConnectConfig } from "ssh2";
import { SocksClient } from "socks";
import { URL } from "node:url";
import { getServerManager } from "./server-manager.js";
import type { Server } from "../db/schema.js";
import { Logger } from "../utils/logger.js";

/**
 * 批量执行服务:为每台目标服务器创建临时 SSH Client,跑命令,清理。
 *
 * 设计原因:SSHConnectionManager 是单例,如果每次批量都 setConfig 会断开其他连接。
 * 这里新建独立 Client,完全独立,适合一次性批量任务。
 */

export interface BatchResult {
  serverId: string;
  serverName: string;
  status: "success" | "failed" | "cancelled";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
}

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
    if (u.protocol !== "socks5:" && u.protocol !== "socks5h:") {
      throw new Error("Only socks5:// proxies supported");
    }
    return {
      type: 5,
      host: u.hostname,
      port: Number(u.port || 1080),
      userId: u.username || undefined,
      password: u.password || undefined,
    };
  } catch (e) {
    Logger.log(`Invalid SOCKS proxy URL: ${(e as Error).message}`, "error");
    return undefined;
  }
}

function buildConnectConfig(
  server: Server,
  creds: { password: string | null; privateKey: string | null; passphrase: string | null },
): ConnectConfig {
  const cfg: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 30000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };
  if (creds.privateKey) {
    cfg.privateKey = creds.privateKey;
    if (creds.passphrase) cfg.passphrase = creds.passphrase;
  } else if (creds.password) {
    cfg.password = creds.password;
  }
  return cfg;
}

function connectWithSocks(
  cfg: ConnectConfig,
  socks: SocksConfig | undefined,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      reject(err);
    };
    client.on("error", onError);
    client.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });

    if (socks) {
      SocksClient.createConnection(
        {
          proxy: socks as any,
          command: "connect",
          destination: { host: cfg.host!, port: cfg.port! },
          timeout: 30000,
        },
        (err, info) => {
          if (err) return onError(err);
          if (!info?.socket) return onError(new Error("SOCKS connection had no socket"));
          client.connect({ ...cfg, sock: info.socket });
        },
      );
    } else {
      client.connect(cfg);
    }
  });
}

function execOne(
  client: Client,
  cmd: string,
  timeout: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { client.end(); } catch {}
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    client.exec(cmd, (err, channel) => {
      if (err) {
        clearTimeout(timer);
        if (!timedOut) reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      channel.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      channel.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });
      channel.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (timedOut) return;
        resolve({ exitCode: code, stdout, stderr });
      });
      channel.on("error", (e: Error) => {
        clearTimeout(timer);
        if (!timedOut) reject(e);
      });
    });
  });
}

export class BatchExecutor {
  /**
   * 并发执行同一条命令在多台机器。
   * - parallel: 并发上限
   * - failFast: true 时首个失败后取消其他进行中的调用
   * - 返回结果数组的顺序与 servers 输入顺序一致
   */
  async execute(
    servers: Server[],
    cmd: string,
    parallel: number,
    timeout: number,
    failFast: boolean,
  ): Promise<BatchResult[]> {
    if (servers.length === 0) return [];
    const abortController = new AbortController();
    const slots: BatchResult[] = new Array(servers.length);

    const runOne = async (index: number): Promise<void> => {
      const server = servers[index];
      const start = Date.now();
      const srvMgr = getServerManager();
      const creds = srvMgr.getDecryptedCredentials(server.id);
      if (!creds) {
        slots[index] = {
          serverId: server.id,
          serverName: server.name,
          status: "failed",
          error: "Server credentials not found",
          durationMs: Date.now() - start,
        };
        return;
      }

      if (abortController.signal.aborted) {
        slots[index] = {
          serverId: server.id,
          serverName: server.name,
          status: "cancelled",
          durationMs: 0,
        };
        return;
      }

      const cfg = buildConnectConfig(server, creds);
      const socks = parseSocksProxy(server.socksProxy);
      let client: Client | null = null;
      try {
        client = await connectWithSocks(cfg, socks);
        const { exitCode, stdout, stderr } = await execOne(client, cmd, timeout);
        const status: BatchResult["status"] =
          exitCode === 0 ? "success" : "failed";
        slots[index] = {
          serverId: server.id,
          serverName: server.name,
          status,
          exitCode: exitCode ?? undefined,
          stdout: stdout.substring(0, 64 * 1024),
          stderr: stderr.substring(0, 16 * 1024),
          durationMs: Date.now() - start,
        };
        if (failFast && status === "failed" && !abortController.signal.aborted) {
          abortController.abort();
        }
      } catch (e) {
        const isCancelled = abortController.signal.aborted;
        slots[index] = {
          serverId: server.id,
          serverName: server.name,
          status: isCancelled ? "cancelled" : "failed",
          error: (e as Error).message,
          durationMs: Date.now() - start,
        };
        if (failFast && !isCancelled) {
          abortController.abort();
        }
      } finally {
        try {
          client?.end();
        } catch {
          // ignore
        }
      }
    };

    const limit = Math.max(1, Math.min(parallel, servers.length));
    const indices = servers.map((_, i) => i);
    const workers: Promise<void>[] = [];
    for (let w = 0; w < limit; w++) {
      workers.push(
        (async () => {
          while (indices.length > 0) {
            if (abortController.signal.aborted) break;
            const idx = indices.shift()!;
            await runOne(idx);
          }
        })(),
      );
    }
    await Promise.all(workers);
    return slots;
  }
}

let _instance: BatchExecutor | null = null;
export function getBatchExecutor(): BatchExecutor {
  if (!_instance) _instance = new BatchExecutor();
  return _instance;
}
