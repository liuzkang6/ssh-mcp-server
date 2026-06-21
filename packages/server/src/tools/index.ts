import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCommandTool } from "./execute-command.js";
import { registerUploadTool } from "./upload.js";
import { registerDownloadTool } from "./download.js";
import { registerListServersTool } from "./list-servers.js";
import { registerGetServerStatusTool } from "./get-server-status.js";
import { registerBatchExecuteCommandTool } from "./batch-execute-command.js";
import { registerSearchFilesTool } from "./search-files.js";
import { registerQueryAuditLogsTool } from "./query-audit-logs.js";

/**
 * Register all tools
 * @param server MCP server instance
 */
export function registerAllTools(server: McpServer): void {
  registerExecuteCommandTool(server);
  registerUploadTool(server);
  registerDownloadTool(server);
  registerListServersTool(server);
  registerGetServerStatusTool(server);
  registerBatchExecuteCommandTool(server);
  registerSearchFilesTool(server);
  registerQueryAuditLogsTool(server);
}