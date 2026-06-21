# CLI Reference

> `opsgate` 命令行工具 — 25+ 子命令,基于 Commander.js。
> 通过 HTTP API 与 server 通信,所有操作在 server 侧审计。

## 安装

### 方式 1:全局安装
```bash
npm install -g @opsgate/cli
opsgate --version    # 验证:应输出 opsgate v2.0.0
```

### 方式 2:Docker 容器内调用
容器里已装好,直接 `docker compose exec opsgate opsgate ...`

### 方式 3:从源码
```bash
git clone https://github.com/liuzkang6/opsgate.git
cd opsgate
npm install && npm run build
node packages/cli/dist/index.js --version
```

---

## 认证

```bash
# 1) 交互式登录
opsgate login
# 提示输入 API key (sk-...) → 存到 ~/.config/opsgate/config.json (chmod 600)

# 2) 非交互(脚本里)
opsgate login --api-key sk-xxxx --api-base http://opsgate:3000

# 3) 环境变量(优先级最高)
export OPSGATE_API_KEY=sk-xxxx
export OPSGATE_API_BASE=http://opsgate:3000

# 4) 临时覆盖
opsgate --api-key sk-yyyy server list
```

> 💡 API Key 通过 `opsgate agent create` 或 Web UI 创建。

## 全局选项

```bash
opsgate [global options] <command> [command options]

# 全局
-f, --format <fmt>   # 输出格式:table | json | text(默认 text)
    --api-key <key>  # 覆盖 config 中的 API key
    --api-base <url> # 覆盖 config 中的 API base
-V, --version        # opsgate CLI 版本
-h, --help           # 帮助
```

---

## 子命令清单

### 核心

#### `opsgate login`
保存 API key 到 `~/.config/opsgate/config.json`。
```bash
opsgate login                                          # 交互
opsgate login --api-key sk-xxx --api-base http://h:3000
opsgate login --username deploy-bot                    # 备注
```

#### `opsgate logout`
清空本地 config(`apiKey` / `apiBase` / `username`)。

#### `opsgate whoami`
显示当前操作者(从 `/api/v1/auth/whoami`)。
```bash
opsgate whoami              # text(默认)
opsgate whoami -f json      # JSON
```

#### `opsgate version`
打印 `opsgate v2.0.0`。

#### `opsgate ping`
健康检查。
```bash
opsgate ping                # text
opsgate ping -f json        # {"status":"ok","activeSessions":0,...}
```

#### `opsgate config`
管理本地 config 文件。
```bash
opsgate config show                                      # 显示当前
opsgate config set apiKey sk-xxxx                        # 修改
opsgate config set apiBase http://opsgate.internal:3000
opsgate config set output json                           # 全局默认输出格式
opsgate config unset apiKey                              # 删
```

#### `opsgate completion <shell>`
输出 shell completion 脚本。
```bash
# bash
opsgate completion bash > /etc/bash_completion.d/opsgate
# zsh
opsgate completion zsh > "${fpath[1]}/_opsgate"
# fish
opsgate completion fish > ~/.config/fish/completions/opsgate.fish
```

---

### 业务

#### `opsgate server list` (alias: `ls`)
```bash
opsgate server list                    # 全部
opsgate server list --group production # 按 group 过滤
opsgate server list --tag web          # 按 tag 过滤
opsgate server list -f table           # 表格
opsgate server list -f json            # JSON(适合 jq)
```

#### `opsgate server get <id|name>`
```bash
opsgate server get srv-1
opsgate server get web-1               # 接受 name
```

#### `opsgate server create`
```bash
opsgate server create \
  --name web-1 \
  --host 192.168.1.10 \
  --port 22 \
  --username ubuntu \
  --password '********'                # 走 HTTPS,只在传输中
# 或
opsgate server create \
  --name web-2 \
  --host 10.0.0.5 \
  --username ops \
  --privateKey ~/.ssh/id_rsa \
  --group production \
  --tags web,nginx,us-east \
  --description "frontend web tier"
```
必填:`--name` / `--host` / `--username`。
可选:`--port`(默认 22) / `--password` / `--privateKey` / `--passphrase` / `--group` / `--tags`(逗号分隔) / `--description`。

#### `opsgate server update <id|name>`
```bash
opsgate server update web-1 --tags web,nginx,eu-west
opsgate server update srv-1 --description "已下线"
```

#### `opsgate server delete <id|name>` (alias: `rm`)
```bash
opsgate server rm web-1
```

---

### Operator 管理

#### `opsgate agent list` (alias: `ls`)
```bash
opsgate agent list -f table    # name | type | scopes | last login
```

#### `opsgate agent get <name>`

#### `opsgate agent create`
```bash
opsgate agent create \
  --name deploy-bot \
  --type agent \
  --scopes read,write \
  --server-permissions web-1,web-2,db-1
```
返回的 `apiKey`(**`sk-...`**)只显示一次,立即存到 secret manager。

#### `opsgate agent rotate-key <name>`
轮换 API key(旧 key 立即失效,生成新 sk-)。

#### `opsgate agent delete <name>` (alias: `rm`)

---

### 操作

#### `opsgate exec <server> <command...>`
单机执行命令。
```bash
opsgate exec web-1 "uptime"
opsgate exec web-1 "df -h" --directory /tmp --timeoutMs 60000
opsgate exec srv-1 "ls /etc/nginx" -d /etc -t 30s
```

#### `opsgate batch <command...>`
批量执行(走 `/api/v1/servers/:id/exec` 并行)。
```bash
# 在 tag=web 的所有机器跑 uptime,最多并发 10
opsgate batch "uptime" --tag web --parallel 10

# 按 group
opsgate batch "systemctl restart nginx" --group production

# 任一失败立即终止
opsgate batch "rm -rf /tmp/old" --tag cleanup --fail-fast

# 预演不真执行
opsgate batch "yum update -y" --tag all --dry-run

# 复杂命令(注意 shell 解析,带特殊字符用引号)
opsgate batch 'for i in $(seq 1 3); do echo $i; done' --tag web
```

#### `opsgate scp upload|download <local> <remote>`
```bash
# upload: local → server:path
opsgate scp upload ./dist.tar.gz web-1:/tmp/

# download: server:path → local
opsgate scp download web-1:/var/log/nginx/access.log ./access.log
```
remote 形式:`<server-name>:<abs-path>`,path 走 server 端 `allowed_remote_paths` 白名单。

#### `opsgate terminal <server>` (alias: `ssh`)
唤起浏览器打开 `/servers/:id` 的终端 Tab。
```bash
opsgate terminal web-1
opsgate ssh web-1    # 同上
```

#### `opsgate status <server>`
拼装 `/active-sessions` + `/health` 输出。
```bash
opsgate status web-1
```

#### `opsgate search <servers...> --pattern <regex>`
多机 grep。`--path` 限定目录(默认 `/`)。
```bash
opsgate search web-1 web-2 --pattern "ERROR.*timeout" --path /var/log
opsgate search $(opsgate server list --format json | jq -r '.[].name') --pattern "TODO" --parallel 20
```

---

### 审计

#### `opsgate audit list`
```bash
# 默认最近 50 条
opsgate audit list

# 过滤
opsgate audit list --serverId web-1
opsgate audit list --operatorId admin --sinceMinutes 60
opsgate audit list --status failed
opsgate audit list --action execute-command --limit 100

# JSON 给 jq
opsgate audit list -f json | jq '.[] | select(.durationMs > 5000)'
```

---

## 常用组合

### 批量操作 + dry-run
```bash
opsgate batch "systemctl restart myapp" --tag app --dry-run    # 先看
opsgate batch "systemctl restart myapp" --tag app --parallel 5 # 再真做
```

### 链式 audit 排查
```bash
# 1) 看最近 1 小时失败
opsgate audit list --status failed --sinceMinutes 60 -f json
# 2) 看某台机器的全部操作
opsgate audit list --serverId web-1 -f json | jq '.[] | {ts: .timestamp, action, status}'
# 3) 看某个 operator 的操作
opsgate audit list --operatorId admin -f json | jq 'length'   # 数总数
```

### JSON 拼装 + jq 过滤
```bash
# 列出所有 production group 的 host
opsgate server list --group production -f json | jq -r '.[] | .host'

# 按 hostname 排序去重
opsgate server list -f json | jq -r '.[] | .name' | sort -u

# 找最近 24h 出错的机器名
opsgate audit list --status failed --sinceMinutes 1440 -f json | jq -r '.[].serverName' | sort -u
```

### CI 集成
```yaml
# .gitlab-ci.yml 片段
deploy:
  script:
    - opsgate login --api-key "$OPSGATE_API_KEY"
    - opsgate batch "cd /app && git pull && systemctl restart myapp" --tag app --fail-fast
    - opsgate audit list --operatorId "$CI_JOB_USER" --sinceMinutes 10 -f json | tee audit.json
```

---

## 环境变量

| 变量 | 优先级 | 说明 |
|------|--------|------|
| `OPSGATE_API_KEY` | 最高 | 覆盖 config 文件 |
| `OPSGATE_API_BASE` | 最高 | 覆盖 config 文件 |
| `OPSGATE_OUTPUT` | 中 | 覆盖 `config.output`(`table`/`json`/`text`) |

> 旧名 `SSH_MCP_API_KEY` / `SSH_MCP_API_BASE` 仍兼容(打 deprecation warning,3 个大版本后移除)。

---

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | 通用错误(参数错误 / 网络失败 / server 返回 5xx) |
| 2 | 鉴权失败(401 / 403) |
| 3 | 资源不存在(404) |
| 4 | 部分失败(仅 `batch`,只要有 ≥1 台机器失败就是 4) |
| 64-78 | Command `exec` 透传远端 `exitCode`(`exitCode=0` → 0,`exitCode=1` → 65,以此类推) |

可在 CI 里用 `if [ $? -eq 0 ]; then ...`。

---

## 下一步

- [docs/API.md](API.md) — REST 13 端点参考
- [docs/MCP.md](MCP.md) — 8 工具 schema
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 架构
