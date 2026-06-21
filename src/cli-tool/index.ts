/**
 * CLI 入口:解析 argv,派发到子命令。
 * 作为独立的 bin 暴露:`ssh-mcp-cli`。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "ssh-mcp-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface CliConfig {
  apiKey?: string;
  apiBase?: string;
  username?: string;
}

export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg: CliConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // ignore
  }
}

export interface CliContext {
  config: CliConfig;
  args: string[];
  format: "table" | "json" | "text";
  apiBase: string;
  apiKey: string;
  /** 打印帮助 */
  printHelp(): void;
  /** 打印错误并退出 */
  fail(msg: string, code?: number): never;
  /** 统一打印(按 format) */
  print(data: unknown): void;
  /** HTTP 请求 */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  /** 子命令执行入口(分发) */
  run(): Promise<void>;
}

function getEnvOrConfig(name: string, configValue: string | undefined): string | undefined {
  // 优先环境变量
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  return configValue;
}

function parseFormat(args: string[]): "table" | "json" | "text" {
  const i = args.indexOf("--format");
  if (i !== -1 && args[i + 1]) return args[i + 1] as any;
  const eq = args.find((a) => a.startsWith("--format="));
  if (eq) return eq.split("=")[1] as any;
  return "text";
}

async function requestImpl(
  method: string,
  path: string,
  body: unknown,
  ctx: { apiBase: string; apiKey: string },
): Promise<unknown> {
  const url = `${ctx.apiBase}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.apiKey}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const errMsg =
      typeof data === "object" && data !== null && "message" in (data as any)
        ? (data as any).message
        : `HTTP ${res.status}`;
    throw new Error(`${(data as any)?.code || "ERROR"}: ${errMsg}`);
  }
  return data;
}

function printTable(rows: any[]): void {
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("(empty)");
    return;
  }
  // 取所有 key
  const keys = Array.from(
    rows.reduce<Set<string>>((s, r) => {
      if (r && typeof r === "object") {
        Object.keys(r).forEach((k) => s.add(k));
      }
      return s;
    }, new Set()),
  );
  if (keys.length === 0) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const widths = keys.map(
    (k) => Math.max(k.length, ...rows.map((r) => String(r?.[k] ?? "").length)),
  );
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  console.log(sep);
  console.log("| " + keys.map((k, i) => k.padEnd(widths[i])).join(" | ") + " |");
  console.log(sep);
  for (const r of rows) {
    console.log(
      "| " +
        keys
          .map((k, i) => String(r?.[k] ?? "").padEnd(widths[i]))
          .join(" | ") +
        " |",
    );
  }
  console.log(sep);
}

export function makeContext(args: string[]): CliContext {
  const config = loadConfig();
  const format = parseFormat(args);
  const apiKey =
    getEnvOrConfig("SSH_MCP_API_KEY", config.apiKey) || "";
  const apiBase =
    getEnvOrConfig("SSH_MCP_API_BASE", config.apiBase) || "http://localhost:3000";

  // 过滤掉 --format 及其值
  const cleanArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format") {
      i++;
      continue;
    }
    if (args[i].startsWith("--format=")) continue;
    cleanArgs.push(args[i]);
  }

  const ctx: CliContext = {
    config,
    args: cleanArgs,
    format,
    apiBase,
    apiKey,
    printHelp: () => printMainHelp(),
    fail: (msg, code = 1) => {
      console.error(`Error: ${msg}`);
      process.exit(code);
    },
    print: (data: unknown) => {
      if (format === "json") {
        console.log(JSON.stringify(data, null, 2));
      } else if (format === "table") {
        if (Array.isArray(data)) {
          printTable(data);
        } else if (data && typeof data === "object") {
          printTable([data]);
        } else {
          console.log(data);
        }
      } else {
        // text - 简单 key:value
        if (Array.isArray(data)) {
          for (const r of data) {
            if (r && typeof r === "object") {
              for (const [k, v] of Object.entries(r)) {
                console.log(`  ${k}: ${v}`);
              }
              console.log("---");
            } else {
              console.log(r);
            }
          }
        } else if (data && typeof data === "object") {
          for (const [k, v] of Object.entries(data)) {
            console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
          }
        } else {
          console.log(data);
        }
      }
    },
    request: (method, path, body) => requestImpl(method, path, body, { apiBase, apiKey }),
    run: () => Promise.resolve(),
  };
  return ctx;
}

function printMainHelp(): void {
  console.log(`ssh-mcp-cli — DevOps 中台命令行工具

Usage:
  ssh-mcp-cli <command> [options]

Commands:
  login                       交互式登录(保存 API key 到 ~/.config/ssh-mcp-cli/config.json)
  logout                      清除本地 config
  whoami                      显示当前操作者
  server list|get|create|update|delete
  agent list|create|rotate-key
  audit list                  查询审计日志
  exec <server> <cmd>         单机执行
  batch exec <cmd> [--group <g>] [--tag <t>] [--parallel N] [--fail-fast]
  scp upload <local> <server>:<remote>
  scp download <server>:<remote> <local>
  terminal <server>           唤起浏览器
  status <server>            获取服务器状态
  search <servers...> --pattern <p> [--path <p>]

Options (global):
  --format table|json|text    输出格式(默认 text)
  --api-key <key>             覆盖 config 中的 API key
  --api-base <url>            覆盖 config 中的 API base

Environment:
  SSH_MCP_API_KEY             覆盖 config 中的 API key
  SSH_MCP_API_BASE            覆盖 config 中的 API base(默认 http://localhost:3000)

Config:
  ~/.config/ssh-mcp-cli/config.json  (chmod 600)`);
}

async function runLogin(ctx: CliContext): Promise<void> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const apiBase = (await rl.question(`API base [${ctx.apiBase}]: `)) || ctx.apiBase;
    const apiKey = (await rl.question("API key (sk-...): ")) || "";
    if (!apiKey) throw new Error("API key required");
    ctx.config.apiBase = apiBase;
    ctx.config.apiKey = apiKey;
    saveConfig(ctx.config);
    console.log("Saved to", CONFIG_FILE);
  } finally {
    rl.close();
  }
}

function runLogout(ctx: CliContext): void {
  ctx.config.apiKey = undefined;
  ctx.config.apiBase = undefined;
  saveConfig(ctx.config);
  console.log("Cleared local config");
}

async function runWhoami(ctx: CliContext): Promise<void> {
  const data = (await ctx.request("GET", "/api/v1/auth/whoami")) as any;
  ctx.print(data);
}

async function runServerList(ctx: CliContext): Promise<void> {
  const data = (await ctx.request("GET", "/api/v1/servers")) as any[];
  ctx.print(data);
}

async function runServerGet(ctx: CliContext, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) ctx.fail("server get requires an id or name");
  const data = (await ctx.request("GET", `/api/v1/servers/${id}`)) as any;
  ctx.print(data);
}

async function runServerCreate(ctx: CliContext, args: string[]): Promise<void> {
  // 解析 --name --host --port --username --password --group --tags --description
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        opts[key] = val;
        i++;
      } else {
        opts[key] = "true";
      }
    }
  }
  if (!opts.name || !opts.host || !opts.username) {
    ctx.fail("--name, --host, --username are required");
  }
  const body: any = {
    name: opts.name,
    host: opts.host,
    username: opts.username,
  };
  if (opts.port) body.port = Number(opts.port);
  if (opts.password) body.password = opts.password;
  if (opts["private-key"]) body.privateKey = opts["private-key"];
  if (opts.passphrase) body.passphrase = opts.passphrase;
  if (opts.group) body.group = opts.group;
  if (opts.tags) body.tags = opts.tags.split(",").map((s) => s.trim());
  if (opts.description) body.description = opts.description;

  const data = (await ctx.request("POST", "/api/v1/servers", body)) as any;
  ctx.print(data);
}

async function runServerDelete(ctx: CliContext, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) ctx.fail("server delete requires an id or name");
  await ctx.request("DELETE", `/api/v1/servers/${id}`);
  console.log("Deleted");
}

async function runAgentList(ctx: CliContext): Promise<void> {
  // 用 whoami 替代;没有 list endpoint 时,workaround
  ctx.fail("Agent list not implemented yet. Use 'whoami' for current operator.");
}

async function runAgentCreate(ctx: CliContext, args: string[]): Promise<void> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        opts[key] = val;
        i++;
      } else {
        opts[key] = "true";
      }
    }
  }
  if (!opts.name) ctx.fail("--name is required");
  const body: any = { type: opts.type || "agent", name: opts.name };
  if (opts.scopes) body.scopes = opts.scopes.split(",").map((s) => s.trim());
  if (opts["server-permissions"]) body.serverPermissions = opts["server-permissions"].split(",");
  const data = (await ctx.request("POST", "/api/v1/operators", body)) as any;
  ctx.print(data);
}

async function runAuditList(ctx: CliContext, args: string[]): Promise<void> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        opts[key] = val;
        i++;
      } else {
        opts[key] = "true";
      }
    }
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== "true") qs.set(k, v);
  }
  const data = (await ctx.request("GET", `/api/v1/audit-logs?${qs.toString()}`)) as any;
  ctx.print(data.logs ?? data);
}

async function runStatus(ctx: CliContext, args: string[]): Promise<void> {
  // 用 MCP tool? 没有;走 audit 等?
  // 简化:让 CLI 调 health,提示用户用 MCP tool
  ctx.fail("status is only available via MCP tool get-server-status. Run the server and call from an MCP client.");
}

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printMainHelp();
    return;
  }

  const ctx = makeContext(args);
  const cmd = args[0];
  const subArgs = args.slice(1);

  try {
    switch (cmd) {
      case "login":
        return runLogin(ctx);
      case "logout":
        return runLogout(ctx);
      case "whoami":
        return runWhoami(ctx);
      case "server":
        return runServerSubcommand(ctx, subArgs);
      case "agent":
        return runAgentSubcommand(ctx, subArgs);
      case "audit":
        return runAuditList(ctx, subArgs);
      case "exec":
        return runExec(ctx, subArgs);
      case "batch":
        return runBatch(ctx, subArgs);
      case "scp":
        return runScp(ctx, subArgs);
      case "status":
        return runStatus(ctx, subArgs);
      case "terminal":
        return runTerminal(ctx, subArgs);
      case "search":
        return runSearch(ctx, subArgs);
      default:
        console.error(`Unknown command: ${cmd}`);
        printMainHelp();
        process.exit(1);
    }
  } catch (e) {
    ctx.fail((e as Error).message);
  }
}

async function runServerSubcommand(ctx: CliContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return runServerList(ctx);
    case "get":
      return runServerGet(ctx, rest);
    case "create":
      return runServerCreate(ctx, rest);
    case "delete":
      return runServerDelete(ctx, rest);
    default:
      ctx.fail(`Unknown server subcommand: ${sub}`);
  }
}

async function runAgentSubcommand(ctx: CliContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return runAgentList(ctx);
    case "create":
      return runAgentCreate(ctx, rest);
    default:
      ctx.fail(`Unknown agent subcommand: ${sub}`);
  }
}

async function runExec(ctx: CliContext, args: string[]): Promise<void> {
  const server = args[0];
  const cmd = args[1];
  if (!server || !cmd) ctx.fail("Usage: exec <server> <cmd>");
  ctx.fail(
    "exec is only available via MCP tool execute-command. To use from CLI, run server and use the MCP tool.",
  );
}

async function runBatch(ctx: CliContext, args: string[]): Promise<void> {
  ctx.fail("batch is only available via MCP tool batch-execute-command.");
}

async function runScp(ctx: CliContext, args: string[]): Promise<void> {
  ctx.fail("scp is only available via MCP tools upload/download.");
}

async function runTerminal(ctx: CliContext, args: string[]): Promise<void> {
  const server = args[0];
  if (!server) ctx.fail("terminal requires a server");
  const { spawn } = await import("node:child_process");
  const url = `${ctx.apiBase.replace(/\/$/, "")}/servers/${encodeURIComponent(server)}`;
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true });
  console.log(`Opening ${url}`);
}

async function runSearch(ctx: CliContext, args: string[]): Promise<void> {
  ctx.fail("search is only available via MCP tool search-files.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
