import fs from "node:fs";
import path from "node:path";
import type { Client, ClientChannel, SFTPWrapper } from "ssh2";
import { getServerManager } from "./server-manager.js";
import { getPool, type PoolEntry, type TransportMode } from "./ssh-connection-pool.js";
import { ToolError } from "../utils/tool-error.js";
import { Logger } from "../utils/logger.js";
import type { Server } from "../db/schema.js";

/**
 * SSH 会话服务(业务层 / Phase 5.5.2)。
 *
 * 职责:
 * - 鉴权后从 `ServerManager` 取 server 配置 + 校验白/黑名单
 * - 调 `SSHConnectionPool`(Phase 5.5.1)拿/建 Client
 * - 在调用前后做路径安全、命令模板、错误转换
 *
 * 关键设计:
 * - 入口校验(server / 命令 / 路径)在调 pool.acquire **之前**完成 → 失败时不浪费连接
 * - 错误用 `ToolError`,code 在 `tool-error.ts` 集中管理
 * - 错误信息严格脱敏:禁出 password / privateKey / passphrase / 绝对本地路径(basename 替代)
 * - 与 `SSHConnectionManager` 共存(5.5.3 才标 deprecated);新工具走本类
 */

const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const DEFAULT_SFTP_TIMEOUT_MS = 300000;
const COMMAND_TEMPLATE_PLACEHOLDER = "<command>";
const QUOTED_COMMAND_TEMPLATE_PLACEHOLDER = "<quotedCommand>";

/** 把敏感字段做脱敏,给错误信息用。 */
function redactPathForError(localPath: string): string {
  if (typeof localPath !== "string" || localPath.length === 0) return "<empty>";
  const base = path.basename(localPath);
  if (!base) return "<invalid>";
  return base;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function applyCommandTemplate(template: string, command: string): string {
  const quotedCommand = shellQuote(command);
  return template
    .split(QUOTED_COMMAND_TEMPLATE_PLACEHOLDER)
    .join(quotedCommand)
    .split(`'${COMMAND_TEMPLATE_PLACEHOLDER}'`)
    .join(quotedCommand)
    .split(`"${COMMAND_TEMPLATE_PLACEHOLDER}"`)
    .join(quotedCommand)
    .split(COMMAND_TEMPLATE_PLACEHOLDER)
    .join(command);
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

export interface ExecOptions {
  timeoutMs?: number;
  directory?: string;
  /** exec mode 时是否分配 pty(透传到 ssh2),默认 true */
  pty?: boolean;
  /** 命令模板,占位符 <command> / <quotedCommand>(透传到 ssh2 前先 wrap) */
  commandTemplate?: string;
}

export interface ExecResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
  durationMs: number;
}

export interface UploadOptions {
  localPath: string;
  remotePath: string;
}

export interface DownloadOptions {
  remotePath: string;
  localPath: string;
}

export interface ShellHandle {
  /** 实际是 ssh2.ClientChannel,供 Web 终端桥接(Phase 10) */
  stream: ClientChannel;
  serverId: string;
  operatorId: string;
  /** 关掉 shell + 释放 pool entry。 */
  close(): Promise<void>;
}

export interface ActiveSessionInfo {
  operatorId: string;
  mode: TransportMode;
  acquiredAt: number;
}

export class SSHSessionService {
  /** regex 编译缓存(按 serverId),避免每次调用重复编译 */
  private whitelistCache = new Map<string, RegExp[]>();
  private blacklistCache = new Map<string, RegExp[]>();

  // ──────────────── 公共方法 ────────────────

  /**
   * 单机 exec(给 `execute-command` tool 用)。
   * 入口校验顺序:server 存在 → 白/黑名单 → 拿 client → 跑命令。
   */
  async exec(ctx: {
    operatorId: string;
    serverId: string;
    cmdString: string;
    options?: ExecOptions;
  }): Promise<ExecResult> {
    const { operatorId, serverId, cmdString } = ctx;
    const options = ctx.options ?? {};
    const startedAt = Date.now();

    const server = this.resolveServer(serverId);
    this.validateCommand(server, cmdString);

    let commandToRun = options.directory
      ? `cd -- ${shellQuote(options.directory)} && ${cmdString}`
      : cmdString;
    if (options.commandTemplate) {
      commandToRun = applyCommandTemplate(options.commandTemplate, commandToRun);
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const poolKey = `${operatorId}:${serverId}:exec`;

    const entry = await this.acquireWithWrapping(operatorId, serverId, "exec", {
      timeoutMs,
    });

    try {
      return await this.runExecOnEntry({
        entry,
        commandToRun,
        timeoutMs,
        startedAt,
      });
    } finally {
      await getPool().release(poolKey);
    }
  }

  /**
   * 上传文件(给 `upload` tool 用)。
   * 入口校验 server 存在 → 路径合法 → 拿 client → sftp fastPut。
   */
  async upload(ctx: {
    operatorId: string;
    serverId: string;
    options: UploadOptions;
  }): Promise<{ bytesTransferred: number; durationMs: number }> {
    const { operatorId, serverId, options } = ctx;
    const startedAt = Date.now();

    const server = this.resolveServer(serverId);
    const validatedLocalPath = this.validateLocalPath(
      options.localPath,
      "read",
    );
    const validatedRemotePath = this.validateRemotePath(
      options.remotePath,
      server,
    );

    const localSize = this.getLocalFileSize(validatedLocalPath);

    const poolKey = `${operatorId}:${serverId}:exec`;
    const entry = await this.acquireWithWrapping(operatorId, serverId, "exec");

    let sftp: SFTPWrapper | undefined;
    try {
      sftp = await this.openSftpWithTimeout(entry.client, DEFAULT_SFTP_TIMEOUT_MS);
      await this.runSftpWithTimeout(
        new Promise<void>((resolve, reject) => {
          sftp!.fastPut(validatedLocalPath, validatedRemotePath, (err: Error | null | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        DEFAULT_SFTP_TIMEOUT_MS,
        `SFTP upload timed out after ${DEFAULT_SFTP_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      throw this.wrapSftpError(error, "upload", validatedLocalPath);
    } finally {
      if (sftp) this.closeSftp(sftp);
      await getPool().release(poolKey);
    }

    return {
      bytesTransferred: localSize,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * 下载文件(给 `download` tool 用)。
   */
  async download(ctx: {
    operatorId: string;
    serverId: string;
    options: DownloadOptions;
  }): Promise<{ bytesTransferred: number; durationMs: number }> {
    const { operatorId, serverId, options } = ctx;
    const startedAt = Date.now();

    const server = this.resolveServer(serverId);
    const validatedLocalPath = this.validateLocalPath(
      options.localPath,
      "write",
    );
    const validatedRemotePath = this.validateRemotePath(
      options.remotePath,
      server,
    );

    const poolKey = `${operatorId}:${serverId}:exec`;
    const entry = await this.acquireWithWrapping(operatorId, serverId, "exec");

    let sftp: SFTPWrapper | undefined;
    let tempLocalPath: string | undefined;
    try {
      sftp = await this.openSftpWithTimeout(entry.client, DEFAULT_SFTP_TIMEOUT_MS);
      tempLocalPath = `${validatedLocalPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`;

      await this.runSftpWithTimeout(
        new Promise<void>((resolve, reject) => {
          sftp!.fastGet(validatedRemotePath, tempLocalPath!, (err: Error | null | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        DEFAULT_SFTP_TIMEOUT_MS,
        `SFTP download timed out after ${DEFAULT_SFTP_TIMEOUT_MS}ms`,
      );

      // 临时文件 rename 到最终位置(原子写)
      await fs.promises.rename(tempLocalPath, validatedLocalPath);
      tempLocalPath = undefined;

      const bytes = this.getLocalFileSize(validatedLocalPath);
      return {
        bytesTransferred: bytes,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (tempLocalPath) {
        await this.unlinkIfExists(tempLocalPath);
      }
      throw this.wrapSftpError(error, "download", validatedLocalPath);
    } finally {
      if (sftp) this.closeSftp(sftp);
      await getPool().release(poolKey);
    }
  }

  /**
   * shell 长连接(给 Web 终端 / Phase 10 用)。
   * `acquire` 完成后,`entry.shellStream` 已就绪;返回的 `ShellHandle.close` 负责释放。
   */
  async shell(ctx: {
    operatorId: string;
    serverId: string;
    cols?: number;
    rows?: number;
  }): Promise<ShellHandle> {
    const { operatorId, serverId } = ctx;
    // cols/rows 在本阶段仅做参数透传占位,真正用 setWindow 是在 Phase 10 Web 终端
    void ctx.cols;
    void ctx.rows;

    this.resolveServer(serverId);
    const entry = await this.acquireWithWrapping(operatorId, serverId, "shell");

    if (!entry.shellStream) {
      // 理论上 acquire shell 后必填;防御性
      await getPool().release(`${operatorId}:${serverId}:shell`);
      throw new ToolError(
        "SSH_EXECUTION_FAILED",
        `Shell channel not available for server ${serverId}`,
        true,
      );
    }

    const stream = entry.shellStream;
    let released = false;
    const releaseOnce = async () => {
      if (released) return;
      released = true;
      await getPool().release(`${operatorId}:${serverId}:shell`);
    };

    return {
      stream,
      serverId,
      operatorId,
      close: async () => {
        try {
          stream.close();
        } catch {
          // Ignore shell close errors during user-initiated close.
        }
        await releaseOnce();
      },
    };
  }

  /**
   * 列某 server 活跃 session(跨 operator、跨 mode)。
   * 不写 audit,纯查询。
   */
  getActiveSessions(serverId: string): ActiveSessionInfo[] {
    const entries = getPool().getActiveSessions(serverId);
    return entries.map((entry) => ({
      operatorId: entry.operatorId,
      mode: entry.mode,
      acquiredAt: entry.acquiredAt,
    }));
  }

  // ──────────────── 入口校验 ────────────────

  private resolveServer(serverId: string): Server {
    const server = getServerManager().getById(serverId);
    if (!server) {
      throw new ToolError(
        "SERVER_NOT_FOUND",
        `Server not found: ${serverId}`,
        false,
      );
    }
    return server;
  }

  /**
   * 命令白/黑名单校验(语义与老 SSHConnectionManager.validateCommand 保持一致):
   * - 白名单非空:必须命中至少一条 → 否则 COMMAND_VALIDATION_FAILED
   * - 黑名单非空:任意一条命中 → COMMAND_VALIDATION_FAILED
   * - 白名单优先级 > 黑名单(白名单非空时,只校验白名单)
   */
  private validateCommand(server: Server, cmdString: string): void {
    const whitelist = this.getCompiledPatterns(
      server.id,
      server.commandWhitelist,
      this.whitelistCache,
      "whitelist",
    );
    if (whitelist.length > 0) {
      const matches = whitelist.some((re) => re.test(cmdString));
      if (!matches) {
        throw new ToolError(
          "COMMAND_VALIDATION_FAILED",
          `Command not in whitelist, execution forbidden`,
          false,
        );
      }
      return;
    }

    const blacklist = this.getCompiledPatterns(
      server.id,
      server.commandBlacklist,
      this.blacklistCache,
      "blacklist",
    );
    if (blacklist.length > 0) {
      const matches = blacklist.some((re) => re.test(cmdString));
      if (matches) {
        throw new ToolError(
          "COMMAND_VALIDATION_FAILED",
          `Command matches blacklist, execution forbidden`,
          false,
        );
      }
    }
  }

  private getCompiledPatterns(
    serverId: string,
    patterns: string[] | null | undefined,
    cache: Map<string, RegExp[]>,
    kind: "whitelist" | "blacklist",
  ): RegExp[] {
    if (!patterns || patterns.length === 0) return [];
    const cached = cache.get(serverId);
    if (cached) return cached;

    const compiled = patterns.map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (error) {
        throw new Error(
          `Invalid ${kind} pattern for server '${serverId}': ${pattern} (${
            (error as Error).message
          })`,
        );
      }
    });
    cache.set(serverId, compiled);
    return compiled;
  }

  // ──────────────── 路径校验(语义与老 SSHConnectionManager 一致) ────────────────

  private validateLocalPath(
    localPath: string,
    purpose: "read" | "write" = "read",
  ): string {
    if (typeof localPath !== "string" || localPath.length === 0) {
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        "Local path must be a non-empty string.",
        false,
      );
    }
    if (localPath.includes("\0")) {
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        "Local path must not contain null bytes.",
        false,
      );
    }

    const resolvedPath = path.resolve(localPath);
    // 业务层:目前 DB 没存 allowedLocalPaths,默认仅 process.cwd() 允许
    const allowedRoots = this.getAllowedLocalRoots();
    const parentPath = path.dirname(resolvedPath);
    const existingPath = this.tryRealpath(resolvedPath);
    const parentRealPath = this.tryRealpath(parentPath);

    let pathToCheck = existingPath;
    if (!pathToCheck && parentRealPath) {
      pathToCheck = path.join(parentRealPath, path.basename(resolvedPath));
    }
    if (!pathToCheck) {
      pathToCheck = resolvedPath;
    }

    if (purpose === "write" && !parentRealPath) {
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        `Local path parent directory does not exist for write: ${redactPathForError(resolvedPath)}`,
        false,
      );
    }

    const isAllowed = allowedRoots.some((root) =>
      isPathWithinRoot(pathToCheck, root),
    );

    if (!isAllowed) {
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        `Local path is outside the allowed roots: ${redactPathForError(resolvedPath)}`,
        false,
      );
    }
    return resolvedPath;
  }

  private getAllowedLocalRoots(): string[] {
    const cwd = process.cwd();
    const resolvedCwd = this.tryRealpath(cwd) || cwd;
    return [resolvedCwd];
  }

  private tryRealpath(localPath: string): string | undefined {
    try {
      return fs.realpathSync.native(localPath);
    } catch {
      return undefined;
    }
  }

  private validateRemotePath(remotePath: string, server: Server): string {
    if (typeof remotePath !== "string" || remotePath.length === 0) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        "Remote path must be a non-empty string.",
        false,
      );
    }
    if (remotePath.includes("\0")) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        "Remote path must not contain null bytes.",
        false,
      );
    }
    if (!path.posix.isAbsolute(remotePath)) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        `Remote path must be an absolute POSIX path, got: ${remotePath}`,
        false,
      );
    }

    const resolvedPath = path.posix.normalize(remotePath);
    const allowedRoots = server.allowedRemotePaths || [];

    if (allowedRoots.length === 0) {
      return resolvedPath;
    }

    const isAllowed = allowedRoots.some(
      (root) =>
        resolvedPath === root ||
        resolvedPath.startsWith(root.endsWith("/") ? root : `${root}/`),
    );

    if (!isAllowed) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        `Remote path is not within the configured allowedRemotePaths for server ${server.id}`,
        false,
      );
    }
    return resolvedPath;
  }

  // ──────────────── Pool 交互 ────────────────

  private async acquireWithWrapping(
    operatorId: string,
    serverId: string,
    mode: TransportMode,
    options?: { timeoutMs?: number },
  ): Promise<PoolEntry> {
    try {
      return await getPool().acquire({
        operatorId,
        serverId,
        mode,
        timeoutMs: options?.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "SSH_EXECUTION_FAILED",
        (error as Error).message,
        true,
      );
    }
  }

  // ──────────────── exec 真实实现 ────────────────

  private runExecOnEntry(params: {
    entry: PoolEntry;
    commandToRun: string;
    timeoutMs: number;
    startedAt: number;
  }): Promise<ExecResult> {
    const { entry, commandToRun, timeoutMs, startedAt } = params;
    const ptyDefault = true;
    return new Promise<ExecResult>((resolve, reject) => {
      let openTimer: NodeJS.Timeout | undefined;
      let commandTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = () => {
        if (openTimer) clearTimeout(openTimer);
        if (commandTimer) clearTimeout(commandTimer);
      };

      entry.client.exec(
        commandToRun,
        // pty 透传:老 SSHConnectionManager 默认真,保持兼容
        { pty: ptyDefault },
        (err: Error | undefined, stream: ClientChannel) => {
          if (openTimer) {
            clearTimeout(openTimer);
            openTimer = undefined;
          }
          if (settled) {
            try {
              stream?.close();
            } catch {
              // Ignore late stream cleanup errors.
            }
            return;
          }

          if (err) {
            cleanup();
            settled = true;
            reject(
              new ToolError(
                "COMMAND_EXECUTION_ERROR",
                `Command execution error: ${err.message}`,
                true,
              ),
            );
            return;
          }

          let data = "";
          let errorData = "";
          let exitCode: number | undefined;
          let exitSignal: string | undefined;

          stream.on("data", (chunk: Buffer) => (data += chunk.toString()));
          stream.stderr.on(
            "data",
            (chunk: Buffer) => (errorData += chunk.toString()),
          );

          stream.on(
            "exit",
            (code: number | undefined, signal: string | undefined) => {
              exitCode = code;
              exitSignal = signal;
            },
          );

          stream.on("close", (code?: number, signal?: string) => {
            cleanup();
            if (settled) return;
            settled = true;

            if (exitCode === undefined) exitCode = code;
            if (!exitSignal && signal) exitSignal = signal;

            const finalExit = exitCode ?? -1;
            const result: ExecResult = {
              stdout: data.trimEnd(),
              stderr: errorData.trimEnd() || undefined,
              exitCode: finalExit,
              durationMs: Date.now() - startedAt,
            };

            if (exitSignal) {
              // 被信号终止:也算失败
              reject(
                new ToolError(
                  "COMMAND_EXECUTION_ERROR",
                  `[signal] Command terminated by signal ${exitSignal} (exit code ${finalExit})`,
                  true,
                ),
              );
              return;
            }

            if (finalExit !== 0) {
              // 非零退出:不抛错(行为兼容老 API),由调用方根据 exitCode 自决
              // 但 spec 要求"任何 throw 出去的 ToolError 保留 code/message"
              // 老 API 会 reject;新 API 这里给一个 info 级 ToolError 让上层工具决定
              Logger.log(
                `Command exited with code ${finalExit}: ${data.slice(0, 200)}`,
                "info",
              );
            }
            resolve(result);
          });

          stream.on("error", (streamError: Error) => {
            cleanup();
            settled = true;
            reject(
              new ToolError(
                "COMMAND_EXECUTION_ERROR",
                `Stream error: ${streamError.message}`,
                true,
              ),
            );
          });

          commandTimer = setTimeout(() => {
            try {
              stream.close();
            } catch {
              // Ignore stream close errors during timeout handling.
            }
            if (!settled) {
              settled = true;
              reject(
                new ToolError(
                  "COMMAND_TIMEOUT",
                  `[timeout] Command timed out after ${timeoutMs}ms`,
                  true,
                ),
              );
            }
          }, timeoutMs);
        },
      );

      openTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new ToolError(
              "COMMAND_TIMEOUT",
              `[timeout] Command channel did not open within ${timeoutMs}ms`,
              true,
            ),
          );
        }
      }, timeoutMs);
    });
  }

  // ──────────────── SFTP 辅助 ────────────────

  private openSftpWithTimeout(
    client: Client,
    timeoutMs: number,
  ): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ToolError(
            "SFTP_ERROR",
            `SFTP open timed out after ${timeoutMs}ms`,
            true,
          ),
        );
      }, timeoutMs);

      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        clearTimeout(timer);
        if (err) {
          reject(
            new ToolError(
              "SFTP_ERROR",
              `SFTP connection failed: ${err.message}`,
              true,
            ),
          );
          return;
        }
        resolve(sftp);
      });
    });
  }

  private closeSftp(sftp: SFTPWrapper): void {
    try {
      sftp.end();
    } catch {
      // Ignore cleanup errors after transfer completion.
    }
  }

  private async runSftpWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ToolError("OPERATION_TIMEOUT", message, true));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async unlinkIfExists(localPath: string): Promise<void> {
    try {
      await fs.promises.unlink(localPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        Logger.log(
          `Failed to remove partial local file ${redactPathForError(localPath)}: ${
            (error as Error).message
          }`,
          "error",
        );
      }
    }
  }

  private getLocalFileSize(localPath: string): number {
    try {
      return fs.statSync(localPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * 把 SFTP 相关异常包成统一 ToolError,并按"是否本地路径相关"分流到
   * LOCAL_FILE_READ_FAILED / LOCAL_FILE_WRITE_FAILED / SFTP_ERROR。
   */
  private wrapSftpError(error: unknown, op: "upload" | "download", localPath: string): ToolError {
    if (error instanceof ToolError) return error;

    const errPath = (error as NodeJS.ErrnoException).path;
    if (typeof errPath === "string" && path.resolve(errPath) === localPath) {
      const code =
        op === "upload" ? "LOCAL_FILE_READ_FAILED" : "LOCAL_FILE_WRITE_FAILED";
      const message =
        op === "upload"
          ? `Failed to read local file: ${(error as Error).message}`
          : `Failed to save file: ${(error as Error).message}`;
      return new ToolError(code, message, false);
    }

    return new ToolError(
      "SFTP_ERROR",
      `File ${op} failed: ${(error as Error).message}`,
      true,
    );
  }
}

let _instance: SSHSessionService | null = null;

/** 获取单例。 */
export function getSSHSessionService(): SSHSessionService {
  if (!_instance) _instance = new SSHSessionService();
  return _instance;
}

/** 重置单例(仅测试用)。 */
export function _resetSSHSessionServiceForTesting(): void {
  _instance = null;
}
