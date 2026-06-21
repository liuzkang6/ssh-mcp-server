/**
 * @opsgate/cli — opsgate DevOps 中台 CLI 入口
 *
 * 22+ 子命令,基于 Commander.js 派发;通过 HTTP API 与 server 通信。
 * 配置文件:~/.config/opsgate/config.json(chmod 600)
 *
 * 环境变量:
 *   OPSGATE_API_KEY     — API key(优先级最高,覆盖 config 文件)
 *   OPSGATE_API_BASE    — API base URL
 */
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
// ============== 常量 ==============
const APP_NAME = "opsgate";
const CONFIG_DIR = join(homedir(), ".config", APP_NAME);
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const VERSION = "2.0.0";
const ENV_API_KEY = "OPSGATE_API_KEY";
const ENV_API_BASE = "OPSGATE_API_BASE";
const DEFAULT_API_BASE = "http://localhost:3000";
function loadConfig() {
    if (!existsSync(CONFIG_FILE))
        return {};
    try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
    catch {
        return {};
    }
}
function saveConfig(cfg) {
    if (!existsSync(CONFIG_DIR))
        mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    try {
        chmodSync(CONFIG_FILE, 0o600);
    }
    catch {
        // ignore on Windows
    }
}
async function request(method, path, body, ctx) {
    const url = `${ctx.apiBase.replace(/\/$/, "")}${path}`;
    const headers = {
        Authorization: `Bearer ${ctx.apiKey}`,
    };
    if (body !== undefined)
        headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    }
    catch {
        data = text;
    }
    if (!res.ok) {
        const errObj = data;
        throw new Error(`${errObj?.code || "ERROR"}: ${errObj?.message || `HTTP ${res.status}`}`);
    }
    return data;
}
function printTable(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        console.log(chalk.gray("(empty)"));
        return;
    }
    const keys = Array.from(rows.reduce((s, r) => {
        if (r && typeof r === "object") {
            Object.keys(r).forEach((k) => s.add(k));
        }
        return s;
    }, new Set()));
    if (keys.length === 0) {
        console.log(JSON.stringify(rows, null, 2));
        return;
    }
    const table = new Table({ head: keys.map((k) => chalk.cyan(k)) });
    for (const r of rows) {
        const obj = r;
        table.push(keys.map((k) => String(obj[k] ?? "")));
    }
    console.log(table.toString());
}
function printData(data, format) {
    if (format === "json") {
        console.log(JSON.stringify(data, null, 2));
        return;
    }
    if (format === "table") {
        if (Array.isArray(data)) {
            printTable(data);
        }
        else if (data && typeof data === "object") {
            printTable([data]);
        }
        else {
            console.log(String(data));
        }
        return;
    }
    // text
    if (Array.isArray(data)) {
        for (const r of data) {
            if (r && typeof r === "object") {
                for (const [k, v] of Object.entries(r)) {
                    console.log(`  ${chalk.gray(k)}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
                }
                console.log("---");
            }
            else {
                console.log(r);
            }
        }
    }
    else if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data)) {
            console.log(`  ${chalk.gray(k)}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
        }
    }
    else {
        console.log(String(data));
    }
}
async function listServers(ctx) {
    return (await request("GET", "/api/v1/servers", undefined, ctx));
}
function filterServers(servers, filter) {
    return servers.filter((s) => {
        if (filter.id && s.id !== filter.id && s.name !== filter.id)
            return false;
        if (filter.group && s.group !== filter.group)
            return false;
        if (filter.tag && !(s.tags ?? []).includes(filter.tag))
            return false;
        return true;
    });
}
// ============== Subcommand implementations ==============
async function cmdLogin(opts) {
    const cfg = loadConfig();
    if (opts.apiBase)
        cfg.apiBase = opts.apiBase;
    if (opts.username)
        cfg.username = opts.username;
    if (!cfg.apiBase)
        cfg.apiBase = DEFAULT_API_BASE;
    if (!opts.apiKey) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            const k = await rl.question(`API key (sk-...): `);
            cfg.apiKey = k.trim();
        }
        finally {
            rl.close();
        }
    }
    if (!cfg.apiKey)
        throw new Error("API key required");
    saveConfig(cfg);
    console.log(chalk.green("✓ Saved to"), CONFIG_FILE);
}
function cmdLogout() {
    const cfg = loadConfig();
    cfg.apiKey = undefined;
    cfg.apiBase = undefined;
    cfg.username = undefined;
    saveConfig(cfg);
    console.log(chalk.green("✓ Cleared local config"));
}
function cmdConfigShow() {
    const cfg = loadConfig();
    console.log(chalk.cyan("Config file:"), CONFIG_FILE);
    console.log(chalk.cyan("apiBase:  "), cfg.apiBase ?? chalk.gray(`(unset, default ${DEFAULT_API_BASE})`));
    console.log(chalk.cyan("apiKey:   "), cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}…` : chalk.gray("(unset)"));
    console.log(chalk.cyan("username: "), cfg.username ?? chalk.gray("(unset)"));
    console.log(chalk.cyan("output:   "), cfg.output ?? chalk.gray("(unset)"));
}
async function cmdConfigSet(key, value) {
    const allowed = ["apiKey", "apiBase", "username", "output"];
    if (!allowed.includes(key)) {
        throw new Error(`Unknown config key: ${key}. Allowed: ${allowed.join(", ")}`);
    }
    const cfg = loadConfig();
    cfg[key] = value;
    saveConfig(cfg);
    console.log(chalk.green(`✓ Set ${key}`));
}
async function cmdConfigUnset(key) {
    const cfg = loadConfig();
    delete cfg[key];
    saveConfig(cfg);
    console.log(chalk.green(`✓ Unset ${key}`));
}
async function cmdPing(ctx, format) {
    const data = await request("GET", "/api/v1/health", undefined, ctx);
    printData(data, format);
}
async function cmdWhoami(ctx, format) {
    const data = await request("GET", "/api/v1/auth/whoami", undefined, ctx);
    printData(data, format);
}
async function cmdServerList(ctx, format, filter) {
    const servers = await listServers(ctx);
    printData(filterServers(servers, filter), format);
}
async function cmdServerGet(ctx, format, id) {
    const data = await request("GET", `/api/v1/servers/${encodeURIComponent(id)}`, undefined, ctx);
    printData(data, format);
}
async function cmdServerCreate(ctx, format, opts) {
    if (!opts.name || !opts.host || !opts.username) {
        throw new Error("--name, --host, --username are required");
    }
    const body = {
        name: opts.name,
        host: opts.host,
        username: opts.username,
    };
    if (opts.port)
        body.port = Number(opts.port);
    if (opts.password)
        body.password = opts.password;
    if (opts.privateKey)
        body.privateKey = opts.privateKey;
    if (opts.passphrase)
        body.passphrase = opts.passphrase;
    if (opts.group)
        body.group = opts.group;
    if (opts.tags)
        body.tags = String(opts.tags).split(",").map((s) => s.trim());
    if (opts.description)
        body.description = opts.description;
    const data = await request("POST", "/api/v1/servers", body, ctx);
    printData(data, format);
}
async function cmdServerUpdate(ctx, format, id, opts) {
    const body = {};
    for (const [k, v] of Object.entries(opts)) {
        if (v === undefined)
            continue;
        if (k === "tags")
            body.tags = String(v).split(",").map((s) => s.trim());
        else if (k === "port")
            body[k] = Number(v);
        else
            body[k] = v;
    }
    const data = await request("PATCH", `/api/v1/servers/${encodeURIComponent(id)}`, body, ctx);
    printData(data, format);
}
async function cmdServerDelete(ctx, id) {
    await request("DELETE", `/api/v1/servers/${encodeURIComponent(id)}`, undefined, ctx);
    console.log(chalk.green("✓ Deleted"), id);
}
async function cmdAgentList(ctx, format) {
    const data = await request("GET", "/api/v1/operators", undefined, ctx);
    printData(data, format);
}
async function cmdAgentGet(ctx, format, name) {
    const data = await request("GET", `/api/v1/operators/${encodeURIComponent(name)}`, undefined, ctx);
    printData(data, format);
}
async function cmdAgentCreate(ctx, format, opts) {
    if (!opts.name)
        throw new Error("--name is required");
    const body = {
        type: opts.type || "agent",
        name: opts.name,
    };
    if (opts.scopes)
        body.scopes = String(opts.scopes).split(",").map((s) => s.trim());
    if (opts.serverPermissions)
        body.serverPermissions = String(opts.serverPermissions).split(",");
    const data = await request("POST", "/api/v1/operators", body, ctx);
    printData(data, format);
}
async function cmdAgentRotateKey(ctx, format, name) {
    const data = await request("POST", `/api/v1/operators/${encodeURIComponent(name)}/rotate-key`, undefined, ctx);
    printData(data, format);
}
async function cmdAgentDelete(ctx, name) {
    await request("DELETE", `/api/v1/operators/${encodeURIComponent(name)}`, undefined, ctx);
    console.log(chalk.green("✓ Deleted"), name);
}
async function cmdAuditList(ctx, format, opts) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined && v !== "")
            qs.set(k, String(v));
    }
    const q = qs.toString();
    const data = await request("GET", `/api/v1/audit-logs${q ? `?${q}` : ""}`, undefined, ctx);
    printData(data.logs ?? data, format);
}
async function cmdExec(ctx, format, args) {
    const servers = await listServers(ctx);
    const target = filterServers(servers, { id: args.server });
    if (target.length === 0)
        throw new Error(`Server not found or no access: ${args.server}`);
    const server = target[0];
    const body = { command: args.command };
    if (args.directory)
        body.directory = args.directory;
    if (args.timeoutMs)
        body.timeoutMs = args.timeoutMs;
    const data = (await request("POST", `/api/v1/servers/${encodeURIComponent(server.id)}/exec`, body, ctx));
    printData(data, format);
    process.exitCode = data.exitCode === 0 ? 0 : 1;
}
async function cmdBatch(ctx, format, args) {
    const servers = await listServers(ctx);
    const targets = filterServers(servers, {
        ...(args.group !== undefined ? { group: args.group } : {}),
        ...(args.tag !== undefined ? { tag: args.tag } : {}),
    });
    if (targets.length === 0)
        throw new Error("No servers matched --group/--tag");
    if (args.dryRun) {
        console.log(chalk.yellow("DRY-RUN: would execute on:"));
        for (const s of targets) {
            console.log(`  ${chalk.cyan(s.name)} (${s.id}) — ${chalk.gray(args.command)}`);
        }
        return;
    }
    console.log(chalk.gray(`Running on ${targets.length} server(s), parallel=${args.parallel}`));
    const results = [];
    const queue = [...targets];
    const inflight = [];
    const runOne = async (s) => {
        const start = Date.now();
        try {
            const r = (await request("POST", `/api/v1/servers/${encodeURIComponent(s.id)}/exec`, { command: args.command }, ctx));
            results.push({
                server: s.name,
                exitCode: r.exitCode,
                durationMs: r.durationMs,
                stdout: r.stdout,
            });
            if (args.failFast && r.exitCode !== 0)
                throw new Error(`${s.name} exit ${r.exitCode}`);
        }
        catch (e) {
            results.push({
                server: s.name,
                exitCode: -1,
                durationMs: Date.now() - start,
                stdout: "",
                error: e.message,
            });
            if (args.failFast)
                throw e;
        }
    };
    for (let i = 0; i < args.parallel; i++) {
        const tick = async () => {
            while (queue.length) {
                const next = queue.shift();
                await runOne(next);
            }
        };
        inflight.push(tick());
    }
    await Promise.all(inflight);
    printData(results, format);
    const failed = results.filter((r) => r.exitCode !== 0).length;
    process.exitCode = failed === 0 ? 0 : 1;
}
async function cmdScp(ctx, format, args) {
    // remote 形式 "<server>:<path>"
    const colonIdx = args.remote.indexOf(":");
    if (colonIdx < 0)
        throw new Error("remote must be '<server>:<path>'");
    const serverRef = args.remote.slice(0, colonIdx);
    const remotePath = args.remote.slice(colonIdx + 1);
    const servers = await listServers(ctx);
    const target = filterServers(servers, { id: serverRef });
    if (target.length === 0)
        throw new Error(`Server not found or no access: ${serverRef}`);
    const server = target[0];
    const body = args.direction === "upload"
        ? { localPath: args.local, remotePath }
        : { remotePath, localPath: args.local };
    const path = `/api/v1/servers/${encodeURIComponent(server.id)}/${args.direction}`;
    const data = (await request("POST", path, body, ctx));
    printData(data, format);
}
function cmdTerminal(ctx, server) {
    const url = `${ctx.apiBase.replace(/\/$/, "")}/servers/${encodeURIComponent(server)}`;
    const opener = process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
            ? "start"
            : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", detached: true });
    console.log(chalk.green("✓ Opening"), url);
}
async function cmdStatus(ctx, format, server) {
    const active = (await request("GET", `/api/v1/servers/${encodeURIComponent(server)}/active-sessions`, undefined, ctx));
    const health = (await request("GET", "/api/v1/health", undefined, ctx));
    printData({ server, activeSessions: active.count, sessions: active.sessions, health }, format);
}
async function cmdSearch(ctx, format, args) {
    const list = await listServers(ctx);
    const targets = args.servers.flatMap((ref) => filterServers(list, { id: ref }));
    if (targets.length === 0)
        throw new Error("No servers matched");
    const basePath = args.path ?? "/";
    const cmd = `grep -rn -- '${args.pattern.replace(/'/g, "'\\''")}' ${basePath}`;
    const results = [];
    const queue = [...targets];
    const inflight = [];
    const runOne = async (s) => {
        const start = Date.now();
        try {
            const r = (await request("POST", `/api/v1/servers/${encodeURIComponent(s.id)}/exec`, { command: cmd, timeoutMs: 30000 }, ctx));
            results.push({
                server: s.name,
                exitCode: r.exitCode,
                durationMs: r.durationMs,
                stdout: r.stdout,
            });
        }
        catch (e) {
            results.push({
                server: s.name,
                exitCode: -1,
                durationMs: Date.now() - start,
                stdout: "",
                error: e.message,
            });
        }
    };
    for (let i = 0; i < args.parallel; i++) {
        inflight.push((async () => {
            while (queue.length)
                await runOne(queue.shift());
        })());
    }
    await Promise.all(inflight);
    printData(results, format);
}
// ============== Shell completion ==============
function bashCompletion() {
    return `# opsgate bash completion
_opsgate_completion() {
  local cur prev words cword
  _init_completion || return
  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=($(compgen -W "\${opts}" -- "\${cur}"))
    return
  fi
  if [[ "\${cword}" -eq 1 ]]; then
    COMPREPLY=($(compgen -W "login logout whoami version config ping server agent audit exec batch scp terminal status search help" -- "\${cur}"))
  fi
}
complete -F _opsgate_completion opsgate
`;
}
function zshCompletion() {
    return `# opsgate zsh completion
#compdef opsgate
_opsgate() {
  local -a commands
  commands=(
    'login:Save API key to config'
    'logout:Clear local config'
    'whoami:Show current operator'
    'version:Print opsgate version'
    'config:Manage local config'
    'ping:Health check'
    'server:Server management'
    'agent:Operator management'
    'audit:Audit log query'
    'exec:Execute command on single server'
    'batch:Execute command on multiple servers'
    'scp:File transfer'
    'terminal:Open Web terminal in browser'
    'status:Get server status'
    'search:Search files on multiple servers'
  )
  _describe 'command' commands
}
compdef _opsgate opsgate
`;
}
function fishCompletion() {
    return `# opsgate fish completion
complete -c opsgate -n "__fish_use_subcommand" -a "login logout whoami version config ping server agent audit exec batch scp terminal status search"
complete -c opsgate -a "version" -d "Print version"
`;
}
function cmdCompletion(shell) {
    let script = "";
    if (shell === "bash")
        script = bashCompletion();
    else if (shell === "zsh")
        script = zshCompletion();
    else if (shell === "fish")
        script = fishCompletion();
    else {
        console.error(chalk.red(`Unknown shell: ${shell}. Supported: bash, zsh, fish`));
        process.exit(1);
    }
    console.log(script);
}
// ============== Program ==============
export async function main(argv) {
    const program = new Command();
    program
        .name(APP_NAME)
        .description(`${APP_NAME} — DevOps 中台 CLI(22+ 子命令,调 HTTP API 与 server 通信)`)
        .version(VERSION)
        .option("-f, --format <fmt>", "输出格式 (table|json|text)", "text")
        .option("--api-key <key>", `覆盖 config 中的 API key(也可用 $${ENV_API_KEY})`)
        .option("--api-base <url>", `覆盖 config 中的 API base(也可用 $${ENV_API_BASE})`)
        .showHelpAfterError();
    // 顶层命令
    program
        .command("login")
        .description("保存 API key 到 ~/.config/opsgate/config.json")
        .option("--api-base <url>", "API base URL")
        .option("--api-key <key>", "API key(非交互)")
        .option("--username <name>", "用户名(仅作备注)")
        .action(async (opts) => {
        await cmdLogin(opts);
    });
    program
        .command("logout")
        .description("清除本地 config(api key / api base / username)")
        .action(cmdLogout);
    program
        .command("whoami")
        .description("显示当前操作者")
        .action(async () => {
        const ctx = makeCtx(program);
        await cmdWhoami(ctx, formatOf(program));
    });
    program
        .command("version")
        .description(`打印 ${APP_NAME} 版本`)
        .action(() => {
        console.log(`${APP_NAME} v${VERSION}`);
    });
    program
        .command("ping")
        .description("健康检查(GET /api/v1/health)")
        .action(async () => {
        const ctx = makeCtx(program);
        await cmdPing(ctx, formatOf(program));
    });
    // config 子命令
    const config = program.command("config").description("管理本地 config 文件");
    config
        .command("show")
        .description("显示当前 config(apiBase/apiKey/username/output)")
        .action(cmdConfigShow);
    config
        .command("set <key> <value>")
        .description("设置 config 项(apiKey|apiBase|username|output)")
        .action(cmdConfigSet);
    config
        .command("unset <key>")
        .description("删除 config 项")
        .action(cmdConfigUnset);
    // completion
    program
        .command("completion <shell>")
        .description("输出 shell completion 脚本(bash|zsh|fish)")
        .action(cmdCompletion);
    // server
    const server = program.command("server").description("服务器管理");
    server
        .command("list")
        .alias("ls")
        .description("列出服务器")
        .option("--group <g>", "按分组过滤")
        .option("--tag <t>", "按 tag 过滤")
        .action(async (opts) => {
        const ctx = makeCtx(program);
        await cmdServerList(ctx, formatOf(program), {
            ...(opts.group !== undefined ? { group: opts.group } : {}),
            ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
        });
    });
    server
        .command("get <id>")
        .description("获取单台服务器详情")
        .action(async (id) => {
        const ctx = makeCtx(program);
        await cmdServerGet(ctx, formatOf(program), id);
    });
    server
        .command("create")
        .description("创建服务器")
        .requiredOption("--name <name>")
        .requiredOption("--host <host>")
        .option("--port <port>", "SSH 端口", "22")
        .requiredOption("--username <name>")
        .option("--password <pwd>")
        .option("--privateKey <path>")
        .option("--passphrase <p>")
        .option("--group <g>")
        .option("--tags <a,b,c>")
        .option("--description <d>")
        .action(async (opts) => {
        const ctx = makeCtx(program);
        await cmdServerCreate(ctx, formatOf(program), opts);
    });
    server
        .command("update <id>")
        .description("更新服务器")
        .option("--name <name>")
        .option("--host <host>")
        .option("--port <port>")
        .option("--username <name>")
        .option("--group <g>")
        .option("--tags <a,b,c>")
        .option("--description <d>")
        .action(async (id, opts) => {
        const ctx = makeCtx(program);
        await cmdServerUpdate(ctx, formatOf(program), id, opts);
    });
    server
        .command("delete <id>")
        .alias("rm")
        .description("删除服务器")
        .action(async (id) => {
        const ctx = makeCtx(program);
        await cmdServerDelete(ctx, id);
    });
    // agent / operator
    const agent = program.command("agent").description("Operator 管理(human/agent)");
    agent
        .command("list")
        .alias("ls")
        .description("列出 operator")
        .action(async () => {
        const ctx = makeCtx(program);
        await cmdAgentList(ctx, formatOf(program));
    });
    agent
        .command("get <name>")
        .description("获取单个 operator 详情")
        .action(async (name) => {
        const ctx = makeCtx(program);
        await cmdAgentGet(ctx, formatOf(program), name);
    });
    agent
        .command("create")
        .description("创建 operator(agent API key 走此路径)")
        .requiredOption("--name <name>")
        .option("--type <human|agent>", "operator 类型", "agent")
        .option("--scopes <a,b,c>", "scope 列表")
        .option("--server-permissions <id1,id2>", "服务器权限白名单")
        .action(async (opts) => {
        const ctx = makeCtx(program);
        await cmdAgentCreate(ctx, formatOf(program), opts);
    });
    agent
        .command("rotate-key <name>")
        .description("轮换 API key(失效旧 key,生成新 sk-)")
        .action(async (name) => {
        const ctx = makeCtx(program);
        await cmdAgentRotateKey(ctx, formatOf(program), name);
    });
    agent
        .command("delete <name>")
        .alias("rm")
        .description("删除 operator")
        .action(async (name) => {
        const ctx = makeCtx(program);
        await cmdAgentDelete(ctx, name);
    });
    // audit
    program
        .command("audit list")
        .alias("audit ls")
        .description("查询审计日志")
        .option("--serverId <id>")
        .option("--operatorId <id>")
        .option("--action <name>")
        .option("--status <success|failed|denied|cancelled>")
        .option("--sinceMinutes <n>")
        .option("--limit <n>", "返回条数", "50")
        .action(async (opts) => {
        const ctx = makeCtx(program);
        await cmdAuditList(ctx, formatOf(program), opts);
    });
    // exec / batch / scp / terminal / status / search
    program
        .command("exec <server> <command...>")
        .description("在单台 server 执行命令(调 /api/v1/servers/:id/exec)")
        .option("-d, --directory <dir>", "工作目录")
        .option("-t, --timeoutMs <n>", "超时(毫秒)", "30000")
        .action(async (server, commandParts, opts) => {
        const ctx = makeCtx(program);
        await cmdExec(ctx, formatOf(program), {
            server,
            command: commandParts.join(" "),
            ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
            timeoutMs: Number(opts.timeoutMs),
        });
    });
    program
        .command("batch <command...>")
        .description("在多台 server 并行执行命令(--group / --tag 过滤)")
        .option("--group <g>", "按分组过滤")
        .option("--tag <t>", "按 tag 过滤")
        .option("--parallel <n>", "并发数", "5")
        .option("--fail-fast", "任一失败立即终止")
        .option("--dry-run", "只列出目标 server,不真执行")
        .action(async (commandParts, opts) => {
        const ctx = makeCtx(program);
        await cmdBatch(ctx, formatOf(program), {
            command: commandParts.join(" "),
            ...(opts.group !== undefined ? { group: opts.group } : {}),
            ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
            parallel: Number(opts.parallel),
            failFast: !!opts.failFast,
            dryRun: !!opts.dryRun,
        });
    });
    const scp = program.command("scp").description("文件传输(走 /api/v1/servers/:id/upload|download)");
    scp
        .command("upload <local> <remote>")
        .description("上传 <local> 到 <server>:<remote>")
        .action(async (local, remote) => {
        const ctx = makeCtx(program);
        await cmdScp(ctx, formatOf(program), { direction: "upload", local, remote });
    });
    scp
        .command("download <remote> <local>")
        .description("从 <server>:<remote> 下载到 <local>")
        .action(async (remote, local) => {
        const ctx = makeCtx(program);
        await cmdScp(ctx, formatOf(program), { direction: "download", local, remote });
    });
    program
        .command("terminal <server>")
        .alias("ssh")
        .description("唤起浏览器打开 Web 终端(/servers/:id 的终端 Tab)")
        .action((server) => {
        const ctx = makeCtx(program);
        cmdTerminal(ctx, server);
    });
    program
        .command("status <server>")
        .description("获取服务器状态(拼装 /active-sessions + /health)")
        .action(async (server) => {
        const ctx = makeCtx(program);
        await cmdStatus(ctx, formatOf(program), server);
    });
    program
        .command("search <servers...>")
        .description("在多台 server 上 grep <pattern>(走 /exec 后端 grep)")
        .requiredOption("--pattern <p>", "正则 pattern")
        .option("--path <p>", "搜索根目录", "/")
        .option("--parallel <n>", "并发数", "5")
        .action(async (servers, opts) => {
        const ctx = makeCtx(program);
        await cmdSearch(ctx, formatOf(program), {
            servers,
            pattern: opts.pattern,
            ...(opts.path !== undefined ? { path: opts.path } : {}),
            parallel: Number(opts.parallel),
        });
    });
    await program.parseAsync(argv);
}
function makeCtx(program) {
    const opts = program.opts();
    const cfg = loadConfig();
    const apiKey = process.env[ENV_API_KEY] || opts.apiKey || cfg.apiKey || "";
    const apiBase = process.env[ENV_API_BASE] || opts.apiBase || cfg.apiBase || DEFAULT_API_BASE;
    return { apiBase, apiKey };
}
function formatOf(program) {
    const opts = program.opts();
    const f = (opts.format || "text");
    if (f !== "table" && f !== "json" && f !== "text")
        return "text";
    return f;
}
// 让 standalone 运行(`node dist/index.js`)也工作
if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).catch((e) => {
        console.error(chalk.red("Error:"), e instanceof Error ? e.message : e);
        process.exit(1);
    });
}
