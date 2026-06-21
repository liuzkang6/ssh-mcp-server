import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { CommandLineParser } from "../cli/command-line-parser.js";
import { Logger } from "../utils/logger.js";
import { registerAllTools } from "../tools/index.js";
import { SERVER_CONFIG } from "../config/server.js";

/**
 * MCP Server class
 */
export class SshMcpServer {
  private server: McpServer;
  private sshManager: SSHConnectionManager;
  private shutdownHandlersRegistered = false;
  private shutdownPromise?: Promise<void>;

  constructor() {
    this.server = new McpServer(SERVER_CONFIG);

    this.sshManager = SSHConnectionManager.getInstance();
  }

  /**
   * Register tools
   */
  private registerTools(): void {
    registerAllTools(this.server);
  }

  private async shutdown(reason: string, exitCode?: number): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => {
        Logger.log(`Received ${reason}, shutting down SSH MCP server...`, "info");

        this.sshManager.disconnect();

        try {
          await this.server.close();
        } catch (error) {
          Logger.log(
            `Failed to close MCP server cleanly: ${(error as Error).message}`,
            "error",
          );
        }
      })();
    }

    await this.shutdownPromise;

    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  }

  private registerShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) {
      return;
    }

    const handleSignal = (signal: NodeJS.Signals) => {
      void this.shutdown(signal, 0);
    };

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    // 仅在纯 MCP 模式下监听 stdin 关闭(平台模式 HTTP + MCP 一起跑,stdin 可能未连客户端)
    if (process.env.SSH_MCP_HTTP_MODE !== "true") {
      process.stdin.resume();
      process.stdin.once("end", () => void this.shutdown("stdin end", 0));
      process.stdin.once("close", () => void this.shutdown("stdin close", 0));
    }

    this.shutdownHandlersRegistered = true;
  }

  /**
   * Run the server
   */
  public async run(): Promise<void> {
    // 过滤掉平台级 CLI 参数(只保留 legacy SSH 参数)
    const platformArgs = new Set([
      "--enable-web",
      "--mcp-only",
      "--port",
      "--api-key",
      "--import-config",
    ]);
    const originalArgv = process.argv;
    const args = process.argv.slice(2);
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (platformArgs.has(arg)) {
        i++; // 跳过值
        continue;
      }
      let isPlatform = false;
      for (const platformArg of platformArgs) {
        if (arg.startsWith(platformArg + "=")) {
          isPlatform = true;
          break;
        }
      }
      if (!isPlatform) filtered.push(arg);
    }
    const filteredArgv = [process.argv[0], process.argv[1], ...filtered];
    process.argv = filteredArgv;
    const allConfigs: any[] = [];
    let preConnect = false;
    try {
      // 平台模式下可能没有 legacy SSH 参数
      const hasLegacyArgs = filtered.some(
        (a) =>
          a.startsWith("--config-file") ||
          a.startsWith("--ssh") ||
          a.startsWith("--host") ||
          a.startsWith("-h") ||
          a.startsWith("--ssh-config-file"),
      );
      if (hasLegacyArgs) {
        // Initialize SSH configuration
        const parsedArgs = CommandLineParser.parseArgs();
        this.sshManager.setConfig(parsedArgs.configs);
        allConfigs.push(...Object.values(parsedArgs.configs));
        preConnect = parsedArgs.preConnect;
      } else {
        // 平台模式:不抛错,空配置
        this.sshManager.setConfig({});
      }
    } finally {
      process.argv = originalArgv;
    }
    this.registerShutdownHandlers();

    // Security warning
    if (
      allConfigs.some(
        (c) => !c.commandWhitelist || c.commandWhitelist.length === 0
      )
    ) {
      Logger.log(
        "WARNING: Running without a command whitelist is strongly discouraged. Please configure a whitelist to restrict the commands that can be executed.",
        "info"
      );
    }
    if (
      allConfigs.some(
        (c) =>
          (c.transportMode || "exec") === "exec" &&
          (!c.allowedRemotePaths || c.allowedRemotePaths.length === 0)
      )
    ) {
      Logger.log(
        "WARNING: Running without allowedRemotePaths is strongly discouraged. SFTP upload/download can read or write any path on the remote server. Configure allowedRemotePaths to restrict the SFTP surface.",
        "info"
      );
    }

    // Pre-connect to all servers if flag is set
    if (preConnect) {
      Logger.log("Pre-connecting to all configured SSH servers...", "info");
      try {
        await this.sshManager.connectAll();
        Logger.log("Successfully pre-connected to all SSH servers", "info");
      } catch (error) {
        Logger.log(
          `Warning: Some SSH connections failed during pre-connect: ${(error as Error).message}`,
          "error"
        );
      }
    }

    // Register tools
    this.registerTools();

    // Create transport instance and connect
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    Logger.log("MCP server connection established");
  }
}
