// @deprecated Use SSHSessionService directly. This singleton is kept for
// backward compatibility and forwards to SSHSessionService.
//
// Phase 5.5.3: 把 `executeCommand` / `upload` / `download` / `shell` 等老公共方法
// 内部转发到 `SSHSessionService`,删掉老的连接管理、凭证处理、白/黑名单、SFTP、shell
// marker 等逻辑(共 ~1700 行)。老调用方(`mcp-server.ts` / `tools/execute-command.ts`
// / `tools/upload.ts` / `tools/download.ts`)继续通过 `SSHConnectionManager.getInstance()`
// 调用,行为保持向后兼容。
//
// 关键映射:
// - 老 `connectionName` → `ServerManager.getByName(name)` 拿 serverId
// - 老 `directory` / `timeout` / `commandTemplate` → `SSHSessionService.ExecOptions`
// - 老 `sshConfig`(直接传 SSHConfig 对象)fallback 路径已删除:spec 接受破坏性变更,
//   调 `executeCommand('ls', '/tmp', 'unregistered', { sshConfig })` 时,若
//   'unregistered' 不在 `servers` 表,抛 `SERVER_NOT_FOUND` 而不再尝试直接
//   用 sshConfig 建 Client。
// - 老 `legacy CLI` 模式下没有 operator 概念,统一用 `legacy-cli`(可被
//   `SSH_MCP_LEGACY_OPERATOR_ID` 覆盖)作为 operatorId 占位。

import { ToolError } from "../utils/tool-error.js";
import { getSSHSessionService } from "./ssh-session-service.js";
import { getServerManager } from "./server-manager.js";
import type { ServerStatus } from "../models/types.js";
import type { Server } from "../db/schema.js";

const DEFAULT_LEGACY_OPERATOR_ID = "legacy-cli";

/**
 * @deprecated Use SSHSessionService directly. This singleton is kept for
 * backward compatibility and forwards to SSHSessionService.
 */
export class SSHConnectionManager {
  private static instance: SSHConnectionManager;

  private constructor() {}

  /**
   * Get singleton instance.
   * @deprecated
   */
  public static getInstance(): SSHConnectionManager {
    if (!SSHConnectionManager.instance) {
      SSHConnectionManager.instance = new SSHConnectionManager();
    }
    return SSHConnectionManager.instance;
  }

  // ────────── 旧配置/连接管理 API(均为 no-op,保留签名避免破坏老调用方) ──────────

  /**
   * @deprecated 配置走 `servers` 表(由 `ServerManager` 管理)。本方法仅保留签名,
   * 不再有任何行为。
   */
  public setConfig(
    _configs: Record<string, unknown> = {},
    _defaultName?: string,
  ): void {
    // No-op:配置改由 ServerManager 管理。
  }

  /**
   * @deprecated 配置走 `servers` 表(由 `ServerManager` 管理)。本方法保留签名
   * 但抛错,引导调用方迁移到 `ServerManager.getByName` / `getById`。
   */
  public getConfig(_name?: string): never {
    throw new ToolError(
      "SERVER_NOT_FOUND",
      "SSHConnectionManager.getConfig is deprecated. Use ServerManager.getByName/getById instead.",
      false,
    );
  }

  /**
   * @deprecated 改用 `ServerManager.list` 读 server 列表;本方法保留老返回
   * 形状以兼容调用方(`name` / `host` / `port` / `username` / `connected`
   * / `status`),`connected` 始终为 false(单例池已删除,语义不再成立)。
   */
  public getAllServerInfos(): Array<{
    name: string;
    host: string;
    port: number;
    username: string;
    connected: boolean;
    status?: ServerStatus;
  }> {
    const servers = getServerManager().list();
    return servers.map((s: Server) => ({
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      connected: false,
      status: undefined,
    }));
  }

  /**
   * @deprecated 改用 `SSHConnectionPool.disconnectAll()` 显式断开;本方法保留
   * 签名,作为 no-op。
   */
  public async connectAll(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * @deprecated 改用 `SSHSessionService.exec` 触发 lazy 连接;本方法保留签名,
   * 作为 no-op。
   */
  public async connect(_name?: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * @deprecated 直接拿到 `ssh2.Client` 的能力已删除;本方法保留签名但抛错。
   */
  public getClient(_name?: string): never {
    throw new ToolError(
      "SSH_CONNECTION_FAILED",
      "SSHConnectionManager.getClient is deprecated. Use SSHSessionService instead.",
      false,
    );
  }

  /**
   * @deprecated 改用 `SSHConnectionPool.disconnectAll()`。本方法保留签名,
   * 作为 no-op。
   */
  public disconnect(): void {
    // No-op:实际连接由 SSHConnectionPool 管理;server 进程退出时由 OS 关闭 socket。
  }

  // ────────── 转发到 SSHSessionService(新主路径) ──────────

  /**
   * @deprecated Use `SSHSessionService.exec` directly. This method forwards
   * to the new service for backward compatibility.
   */
  public async executeCommand(
    cmdString: string,
    directory?: string,
    name?: string,
    options: { timeout?: number } = {},
  ): Promise<string> {
    const ctx = this.resolveLegacyContext(name);
    const result = await getSSHSessionService().exec({
      operatorId: ctx.operatorId,
      serverId: ctx.serverId,
      cmdString,
      options: {
        ...(directory ? { directory } : {}),
        ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
      },
    });
    return result.stdout;
  }

  /**
   * @deprecated Use `SSHSessionService.upload` directly.
   */
  public async upload(
    localPath: string,
    remotePath: string,
    name?: string,
  ): Promise<string> {
    const ctx = this.resolveLegacyContext(name);
    const result = await getSSHSessionService().upload({
      operatorId: ctx.operatorId,
      serverId: ctx.serverId,
      options: { localPath, remotePath },
    });
    return `File uploaded successfully (${result.bytesTransferred} bytes, ${result.durationMs}ms)`;
  }

  /**
   * @deprecated Use `SSHSessionService.download` directly.
   */
  public async download(
    remotePath: string,
    localPath: string,
    name?: string,
  ): Promise<string> {
    const ctx = this.resolveLegacyContext(name);
    const result = await getSSHSessionService().download({
      operatorId: ctx.operatorId,
      serverId: ctx.serverId,
      options: { remotePath, localPath },
    });
    return `File downloaded successfully (${result.bytesTransferred} bytes, ${result.durationMs}ms)`;
  }

  /**
   * @deprecated Use `SSHSessionService.shell` directly. Old API 并没有公共
   * `shell` 方法,本方法仅作为 spec 5.5.3 要求的转发入口保留。
   */
  public async shell(
    name?: string,
    options: { cols?: number; rows?: number } = {},
  ): Promise<unknown> {
    const ctx = this.resolveLegacyContext(name);
    return getSSHSessionService().shell({
      operatorId: ctx.operatorId,
      serverId: ctx.serverId,
      ...(options.cols !== undefined ? { cols: options.cols } : {}),
      ...(options.rows !== undefined ? { rows: options.rows } : {}),
    });
  }

  // ────────── 私有辅助 ──────────

  /**
   * 把老 `connectionName` 映射成 `{ operatorId, serverId }`:
   * 1) operatorId 来自 `process.env.SSH_MCP_LEGACY_OPERATOR_ID`,fallback `'legacy-cli'`
   * 2) connectionName 通过 `ServerManager.getByName` 拿 serverId;拿不到抛 `SERVER_NOT_FOUND`
   * 3) 不再做"直接用 sshConfig 建连接"的 fallback(spec 接受破坏性变更)
   */
  private resolveLegacyContext(name?: string): {
    operatorId: string;
    serverId: string;
  } {
    const operatorId =
      process.env.SSH_MCP_LEGACY_OPERATOR_ID || DEFAULT_LEGACY_OPERATOR_ID;
    const serverName = name || "default";
    const server = getServerManager().getByName(serverName);
    if (!server) {
      throw new ToolError(
        "SERVER_NOT_FOUND",
        `Server not found by name: '${serverName}'. Legacy sshConfig fallback is no longer supported; register the server in ServerManager first.`,
        false,
      );
    }
    return { operatorId, serverId: server.id };
  }
}
