import { Client, ClientChannel, ConnectConfig } from "ssh2";
import { SocksClient } from "socks";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { getServerManager } from "./server-manager.js";
import { getOperatorManager } from "./operator-manager.js";
import { getDb } from "../db/index.js";
import { sessions, type Server } from "../db/schema.js";
import { ToolError } from "../utils/tool-error.js";
import { Logger } from "../utils/logger.js";

/**
 * SSH 连接传输模式。
 * - `exec`: 每次命令走独立 channel(默认)
 * - `shell`: 复用持久 shell session(给 Web 终端用)
 */
export type TransportMode = "exec" | "shell";

/**
 * Pool 内部条目。
 *
 * key = `${operatorId}:${serverId}:${mode}`,**绝不**包含明文凭证。
 * 同 key 可被多次 acquire,refCount 累加;release 归零后调用 client.end() 并从 map 删除。
 */
export interface PoolEntry {
  client: Client;
  operatorId: string;
  serverId: string;
  mode: TransportMode;
  acquiredAt: number;
  refCount: number;
  lastUsedAt: number;
  /** 仅 mode='shell' 时存在;SessionService 会用它来读 PTY 数据 */
  shellStream?: ClientChannel;
  /**
   * sessions.id ULID。Phase 5.6:每次 buildEntry 开始时就 INSERT 一行 sessions
   * (status='active'),连接异常断开 → UPDATE 'failed';release 归零 → UPDATE 'closed'。
   * 若 INSERT 失败(FK 错误 / 临时 DB 故障)则为 undefined,不阻塞 SSH 主流程。
   */
  sessionId?: string;
  /**
   * Phase 5.6:release() 归零时 / disconnectAll() 时置 true,表示"已正常关闭",
   * 用于阻止 attachLifecycleCleanup 的 'end'/'close' 事件把 status='closed'
   * 覆盖成 'failed'。
   */
  released?: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_MAX_PER_SERVER = 50;

function readMaxPerServer(): number {
  const raw = process.env.SSH_MCP_MAX_PER_SERVER;
  if (!raw) return DEFAULT_MAX_PER_SERVER;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    Logger.log(
      `Invalid SSH_MCP_MAX_PER_SERVER=${raw}, falling back to ${DEFAULT_MAX_PER_SERVER}`,
      "info",
    );
    return DEFAULT_MAX_PER_SERVER;
  }
  return parsed;
}

function readConnectTimeoutMs(): number {
  const raw = process.env.SSH_MCP_CONNECT_TIMEOUT_MS;
  if (!raw) return DEFAULT_CONNECT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    Logger.log(
      `Invalid SSH_MCP_CONNECT_TIMEOUT_MS=${raw}, falling back to ${DEFAULT_CONNECT_TIMEOUT_MS}`,
      "info",
    );
    return DEFAULT_CONNECT_TIMEOUT_MS;
  }
  return parsed;
}

function redactProxyUrl(proxyUrl: URL): string {
  const redacted = new URL(proxyUrl.toString());
  if (redacted.username) redacted.username = "***";
  if (redacted.password) redacted.password = "***";
  return redacted.toString();
}

/**
 * Per-Operator SSH 隔离池(技术层)。
 *
 * 仅负责 Client 生命周期 + ref-count,不含任何业务/审计/Session 表写入。
 * 业务层 SSHSessionService(Phase 5.5.2)再叠加 RBAC / 白名单 / 审计 / Sessions 表。
 */
export class SSHConnectionPool {
  private entries = new Map<string, PoolEntry>();
  /** 同 key 并发 acquire 时复用同一个连接 Promise,防 thundering herd */
  private pendingConnections = new Map<string, Promise<PoolEntry>>();

  /**
   * 拿/建一个 Client。
   * - 同 key 已存在:refCount++ + 更新 lastUsedAt,直接返回
   * - 同 key 不存在:建新 Client(走 ServerManager 拿凭证),失败 reject
   * - 同 server 跨 operator 总数超上限:抛 TOO_MANY_CONNECTIONS
   */
  async acquire(opts: {
    operatorId: string;
    serverId: string;
    mode: TransportMode;
    timeoutMs?: number;
  }): Promise<PoolEntry> {
    const { operatorId, serverId, mode } = opts;
    const key = this.buildKey(operatorId, serverId, mode);

    const existing = this.entries.get(key);
    if (existing) {
      existing.refCount += 1;
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const pending = this.pendingConnections.get(key);
    if (pending) {
      // 等同 key 的其他 caller 建好后,直接复用(refCount 由原始 caller 累加)
      return pending;
    }

    // 上限检查:跨 operator 统计同 server 活跃数
    const maxPerServer = readMaxPerServer();
    const activeForServer = this.countByServer(serverId);
    if (activeForServer >= maxPerServer) {
      throw new ToolError(
        "TOO_MANY_CONNECTIONS",
        `Server ${serverId} has reached the active connection limit (${maxPerServer})`,
        true,
      );
    }

    const buildPromise = this.buildEntry({
      operatorId,
      serverId,
      mode,
      key,
      timeoutMs: opts.timeoutMs,
    }).finally(() => {
      this.pendingConnections.delete(key);
    });
    this.pendingConnections.set(key, buildPromise);

    return buildPromise;
  }

  /**
   * 释放一个 ref-count。
   * 归零后调用 client.end() 并从 map 删除。
   * 若 key 不存在(已经被异常断开清理过),静默忽略。
   */
  async release(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;

    if (entry.refCount > 1) {
      entry.refCount -= 1;
      entry.lastUsedAt = Date.now();
      return;
    }

    // refCount 归零,真正断开。
    // Phase 5.6.2: 先标记 released + 写 sessions.status='closed',再删 map。
    // 注意:必须先置 released=true,再调 client.end()——后者会触发 'end' 事件,
    // 事件里的 cleanup 会读 entry.released,见 true 就不会再把 status 改成 'failed'。
    entry.released = true;
    if (entry.sessionId) {
      this.updateSessionStatus(entry.sessionId, "closed");
    }
    this.entries.delete(key);

    const { client, shellStream } = entry;
    if (shellStream) {
      try {
        shellStream.close();
      } catch {
        // Ignore shell close errors during release.
      }
    }
    try {
      client.end();
    } catch {
      // Ignore client end errors during release.
    }
  }

  /**
   * 列出某 server 上所有活跃 session(跨 operator、跨 mode)。
   * Phase 10 Web 终端"当前连接"列表会调它。
   */
  getActiveSessions(serverId: string): PoolEntry[] {
    const out: PoolEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.serverId === serverId) out.push(entry);
    }
    return out;
  }

  /**
   * 全部断开(优雅退出用)。
   */
  async disconnectAll(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    this.pendingConnections.clear();

    for (const entry of entries) {
      // Phase 5.6:把每个 session 也记为 'closed',并置 released 防止 'end' 事件覆盖。
      entry.released = true;
      if (entry.sessionId) {
        this.updateSessionStatus(entry.sessionId, "closed");
      }
      if (entry.shellStream) {
        try {
          entry.shellStream.close();
        } catch {
          // Ignore shell close errors during shutdown.
        }
      }
      try {
        entry.client.end();
      } catch {
        // Ignore client end errors during shutdown.
      }
    }
  }

  /** 当前活跃连接数。 */
  size(): number {
    return this.entries.size;
  }

  // ──────────────── 内部辅助 ────────────────

  private buildKey(
    operatorId: string,
    serverId: string,
    mode: TransportMode,
  ): string {
    return `${operatorId}:${serverId}:${mode}`;
  }

  private countByServer(serverId: string): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.serverId === serverId) n += 1;
    }
    return n;
  }

  private async buildEntry(params: {
    operatorId: string;
    serverId: string;
    mode: TransportMode;
    key: string;
    timeoutMs?: number;
  }): Promise<PoolEntry> {
    const { operatorId, serverId, mode, key } = params;
    const server = this.resolveServer(serverId);

    const client = new Client();
    const entry: PoolEntry = {
      client,
      operatorId,
      serverId,
      mode,
      acquiredAt: Date.now(),
      refCount: 1,
      lastUsedAt: Date.now(),
    };

    // Phase 5.6.1: 早早 INSERT sessions 行(在 client.connect 之前),这样:
    //   - 连接成功 → 走 release → 'closed'
    //   - 连接失败 / 异常断开 → attachLifecycleCleanup → 'failed'
    // INSERT 失败被 swallow(详细原因见 insertSession 注释),不阻塞 SSH 主流程。
    entry.sessionId = this.insertSession(operatorId, serverId, mode);

    // 异常断开自动清理(不影响同 server 的其他 operator)
    // 传入 entry 而不只是 key,这样 cleanup 可以读 entry.sessionId / entry.released
    this.attachLifecycleCleanup(client, key, entry);

    const config = await this.buildConnectConfig(server);
    const connectTimeoutMs =
      params.timeoutMs ?? readConnectTimeoutMs();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          client.destroy();
        } catch {
          // Ignore destroy errors during timeout.
        }
        reject(
          new ToolError(
            "SSH_CONNECTION_TIMEOUT",
            `SSH connection [${key}] timed out after ${connectTimeoutMs}ms`,
            true,
          ),
        );
      }, connectTimeoutMs);

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const settleReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      client.once("ready", () => {
        if (mode === "shell") {
          // shell 模式:在 ready 后启 shell session,挂到 entry.shellStream
          client.shell(
            { term: "xterm" },
            (err: Error | undefined, channel: ClientChannel) => {
              if (err) {
                settleReject(
                  new ToolError(
                    "SSH_CONNECTION_FAILED",
                    `Failed to open shell channel for [${key}]: ${err.message}`,
                    true,
                  ),
                );
                return;
              }
              entry.shellStream = channel;
              settleResolve();
            },
          );
        } else {
          settleResolve();
        }
      });

      client.once("error", (err: Error) => {
        settleReject(
          new ToolError(
            "SSH_CONNECTION_FAILED",
            `SSH connection [${key}] failed: ${err.message}`,
            true,
          ),
        );
      });

      try {
        client.connect(config);
      } catch (error) {
        settleReject(
          new ToolError(
            "SSH_CONNECTION_FAILED",
            `Failed to start SSH client for [${key}]: ${
              (error as Error).message
            }`,
            true,
          ),
        );
      }
    });

    // ready 后才放进 map(这样 acquire 的并发 caller 才能看到)
    this.entries.set(key, entry);
    Logger.log(
      `SSH pool entry ready [${key}] (active=${this.entries.size})`,
      "info",
    );
    return entry;
  }

  private resolveServer(serverId: string): Server {
    const server = getServerManager().getById(serverId);
    if (!server) {
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        `Server not found: ${serverId}`,
        false,
      );
    }
    return server;
  }

  private attachLifecycleCleanup(
    client: Client,
    key: string,
    entry: PoolEntry,
  ): void {
    const cleanup = (reason: string) => {
      // Phase 5.6:异常断开 → 把对应的 sessions 行标 'failed'。
      // 若 release() / disconnectAll() 已经把它标为 'closed',则 entry.released=true,
      // 跳过 UPDATE(否则会覆盖 'closed' 状态)。
      if (entry.sessionId && !entry.released) {
        this.updateSessionStatus(entry.sessionId, "failed");
      }
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
        Logger.log(
          `SSH pool entry removed [${key}] (${reason})`,
          "info",
        );
      }
    };

    client.once("end", () => cleanup("end"));
    client.once("close", () => cleanup("close"));
    client.once("error", () => cleanup("error"));
  }

  // ──────────────── Phase 5.6: sessions 表写入 ────────────────

  /**
   * INSERT 一行 sessions(status='active')。失败 swallow,返回 undefined。
   *
   * 失败场景:
   * - operatorId 不在 operators 表 → FK 错误(可能 operator 已被删)
   * - serverId 不在 servers 表 → FK 错误
   * - DB 临时不可用 → 抛错
   *
   * 这些情况下 SSH 主流程不能被阻塞,只 log 错误。
   */
  private insertSession(
    operatorId: string,
    serverId: string,
    mode: TransportMode,
  ): string | undefined {
    try {
      const id = ulid();
      // 拿 operatorType;拿不到用 'agent' 兜底(operatorId 已被删的边界)
      const operator = getOperatorManager().getById(operatorId);
      const operatorType: "human" | "agent" = operator?.type ?? "agent";
      const { db } = getDb();
      db.insert(sessions)
        .values({
          id,
          operatorId,
          operatorType,
          serverId,
          transportMode: mode,
          startTime: Date.now(),
          endTime: null,
          status: "active",
          remoteAddr: null,
          userAgent: null,
        })
        .run();
      return id;
    } catch (e) {
      Logger.log(
        `Failed to write session: ${(e as Error).message}`,
        "error",
      );
      return undefined;
    }
  }

  /**
   * UPDATE 一行 sessions 的 endTime + status。失败 swallow,不抛。
   */
  private updateSessionStatus(
    sessionId: string,
    status: "closed" | "failed",
  ): void {
    try {
      const { db } = getDb();
      db.update(sessions)
        .set({ endTime: Date.now(), status })
        .where(eq(sessions.id, sessionId))
        .run();
    } catch (e) {
      Logger.log(
        `Failed to update session ${sessionId} → ${status}: ${
          (e as Error).message
        }`,
        "error",
      );
    }
  }

  private async buildConnectConfig(server: Server): Promise<ConnectConfig> {
    const creds = getServerManager().getDecryptedCredentials(server.id);
    if (!creds) {
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        `Failed to resolve credentials for server ${server.id}`,
        true,
      );
    }

    const config: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: readConnectTimeoutMs(),
      keepaliveInterval: DEFAULT_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: DEFAULT_KEEPALIVE_COUNT_MAX,
    };

    if (creds.password) {
      config.password = creds.password;
    }
    if (creds.privateKey) {
      config.privateKey = creds.privateKey;
      if (creds.passphrase) {
        config.passphrase = creds.passphrase;
      }
    }

    // 凭证三选一都没拿到 → 拒连
    if (!creds.password && !creds.privateKey) {
      throw new ToolError(
        "SSH_AUTHENTICATION_MISSING",
        `No valid authentication credentials for server ${server.name}`,
        false,
      );
    }

    if (server.socksProxy) {
      const sock = await this.createSocksSocket(
        server.socksProxy,
        server.host,
        server.port,
        server.name,
      );
      config.sock = sock;
    }

    return config;
  }

  private async createSocksSocket(
    proxyUrlRaw: string,
    host: string,
    port: number,
    serverName: string,
  ): Promise<import("net").Socket> {
    let proxyUrl: URL;
    try {
      proxyUrl = new URL(proxyUrlRaw);
    } catch (error) {
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        `Invalid SOCKS proxy URL for server ${serverName}: ${
          (error as Error).message
        }`,
        true,
      );
    }

    const proxyHost = proxyUrl.hostname;
    const proxyPort = Number.parseInt(proxyUrl.port, 10);
    if (!proxyHost || !Number.isInteger(proxyPort) || proxyPort <= 0) {
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        `SOCKS proxy URL must include a valid host and positive port for server ${serverName}`,
        true,
      );
    }

    const proxy: {
      host: string;
      port: number;
      type: 5;
      userId?: string;
      password?: string;
    } = { host: proxyHost, port: proxyPort, type: 5 };
    if (proxyUrl.username) proxy.userId = decodeURIComponent(proxyUrl.username);
    if (proxyUrl.password) proxy.password = decodeURIComponent(proxyUrl.password);

    Logger.log(
      `Using SOCKS proxy for server ${serverName}: ${redactProxyUrl(proxyUrl)}`,
      "info",
    );

    try {
      const { socket } = await SocksClient.createConnection({
        proxy,
        command: "connect",
        destination: { host, port },
      });
      return socket;
    } catch (error) {
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        `Failed to create SOCKS proxy connection for server ${serverName}: ${
          (error as Error).message
        }`,
        true,
      );
    }
  }
}

let _instance: SSHConnectionPool | null = null;

/** 获取单例。 */
export function getPool(): SSHConnectionPool {
  if (!_instance) _instance = new SSHConnectionPool();
  return _instance;
}

/** 重置单例(仅测试用)。 */
export function _resetPoolForTesting(): void {
  _instance = null;
}
