#!/usr/bin/env node

import { SshMcpServer } from "./core/mcp-server.js";
import { SERVER_CONFIG } from "./config/server.js";
import { Logger } from "./utils/logger.js";
import { loadMasterKey } from "./security/crypto.js";
import { runMigrations } from "./db/migrate.js";
import { startHttpServer } from "./http/server.js";
import { getServerManager } from "./services/server-manager.js";
import { getOperatorManager } from "./services/operator-manager.js";

const HELP_TEXT = `Usage: ssh-mcp-server [options]

DevOps 中台模式(MVP):
  启动时:加载 ENCRYPTION_KEY → 跑 DB migration → 启 HTTP(3000)+MCP(stdio)
  服务器和操作者通过 Web UI 或 CLI 创建

Options:
  --config-file <path>             Load SSH server configs from a JSON file (legacy)
  --ssh <config>                   Add an SSH config (legacy, repeatable)
  -h, --host <host>                SSH host for single-host mode (legacy)
  -p, --port <port>                SSH port (default 22)
  -u, --username <name>            SSH username
  -w, --password <password>        SSH password
  -k, --privateKey <path>          SSH private key path
  -P, --passphrase <passphrase>    SSH private key passphrase
  -W, --whitelist <patterns>       Command whitelist regexes, comma-separated
  -B, --blacklist <patterns>       Command blacklist regexes, comma-separated
  -s, --socksProxy <url>           SOCKS proxy URL
  --allowed-local-paths <paths>    Extra allowed local paths
  --allowed-remote-paths <paths>   Allowed remote POSIX absolute paths
  --transport-mode <mode>          exec or shell (default: exec)
  --shell-ready-timeout <ms>       Shell readiness probe timeout
  --command-template <template>    Wrap commands with <command> or <quotedCommand>
  --pty                           Allocate pseudo-tty (default: true)
  --try-keyboard                  Enable keyboard-interactive auth
  --pre-connect                   Pre-connect to all SSH servers on startup
  --enable-web                    Start HTTP server (default: true)
  --mcp-only                      Start only MCP, no HTTP
  --port <port>                   HTTP port (default 3000)
  --api-key <key>                 Run as this agent (sk-xxx)
  --version, -v                   Print package version
  --help                          Print this help message

Environment:
  ENCRYPTION_KEY  base64 32 bytes (required for HTTP mode)
  JWT_SECRET      JWT signing key, min 16 chars (required for HTTP mode)
  PORT            HTTP port (default 3000)
  DATA_DIR        SQLite data directory (default ./data)`;

function hasArg(...names: string[]): boolean {
  return process.argv.slice(2).some((arg) => names.includes(arg));
}

function getArgValue(name: string, defaultValue?: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i === -1 || i === argv.length - 1) return defaultValue;
  return argv[i + 1];
}

async function seedIfEmpty() {
  const opMgr = getOperatorManager();
  const srvMgr = getServerManager();

  // 1. 首次启动:创建 admin 用户
  if (opMgr.list().length === 0) {
    const adminName = process.env.ADMIN_NAME || "admin";
    const adminPass = process.env.ADMIN_PASSWORD || "admin123";
    const result = opMgr.create({
      type: "human",
      name: adminName,
      credential: adminPass,
      scopes: ["admin", "read", "write"],
      serverPermissions: [],
    });
    void result; // 显式标记 unused
    Logger.log(
      `Default admin created: name=${adminName} password=${adminPass} (CHANGE THIS!)`,
    );
  }

  // 2. 若启用了 legacy CLI 参数,导入为 server
  const legacyHost = getArgValue("-h", getArgValue("--host"));
  if (legacyHost) {
    const existing = srvMgr.list();
    if (existing.length === 0) {
      srvMgr.create({
        name: legacyHost,
        host: legacyHost,
        port: Number(getArgValue("-p", getArgValue("--port")) || 22),
        username: getArgValue("-u", getArgValue("--username")) || "root",
        password: getArgValue("-w", getArgValue("--password")),
        privateKey: getArgValue("-k", getArgValue("--privateKey")),
        passphrase: getArgValue("-P", getArgValue("--passphrase")),
        socksProxy: getArgValue("-s", getArgValue("--socksProxy")),
        transportMode: (getArgValue("--transport-mode") as "exec" | "shell") || "exec",
        commandWhitelist: (getArgValue("-W", getArgValue("--whitelist")) || "")
          .split(",")
          .filter(Boolean),
        commandBlacklist: (getArgValue("-B", getArgValue("--blacklist")) || "")
          .split(",")
          .filter(Boolean),
        allowedRemotePaths: (getArgValue("--allowed-remote-paths") || "")
          .split(",")
          .filter(Boolean),
      });
      Logger.log(`Imported legacy server config: ${legacyHost}`);
    }
  }
}

/**
 * Main program entry
 */
async function main(): Promise<void> {
  if (hasArg("--help")) {
    console.log(HELP_TEXT);
    return;
  }

  if (hasArg("--version", "-v")) {
    console.log(SERVER_CONFIG.version);
    return;
  }

  const mcpOnly = hasArg("--mcp-only");
  const enableWeb = !mcpOnly; // 默认启用 Web,除非 --mcp-only

  // 1. 启动 HTTP 必须有加密密钥
  if (enableWeb) {
    try {
      loadMasterKey();
    } catch (e) {
      Logger.log((e as Error).message, "error");
      Logger.log("Set ENCRYPTION_KEY (use: openssl rand -base64 32)", "error");
      process.exit(1);
    }
    if (!process.env.JWT_SECRET) {
      Logger.log("Set JWT_SECRET (use: openssl rand -hex 32)", "error");
      process.exit(1);
    }
  }

  // 2. 跑 migration
  runMigrations();

  // 3. 种子数据
  if (enableWeb) {
    await seedIfEmpty();
  }

  // 4. 启 HTTP(可选)
  let httpServer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  if (enableWeb) {
    process.env.SSH_MCP_HTTP_MODE = "true";
    const port = Number(getArgValue("--port") || process.env.PORT || 3000);
    httpServer = await startHttpServer({ port, host: "0.0.0.0", enableCors: true });
    Logger.log(`HTTP server listening on http://0.0.0.0:${port}`);
  }

  // 5. 启 MCP(总是)
  const sshMcpServer = new SshMcpServer();
  await sshMcpServer.run();

  // 6. 优雅退出
  const shutdown = async () => {
    Logger.log("Shutting down...");
    if (httpServer) await httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => Logger.handleError(error, "【SSH MCP Server Error】", true));
