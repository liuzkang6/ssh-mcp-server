# Checklist — AI Agent 增强的 DevOps 中台验收

> 每项都是可验证的检查点。完成实现后,逐项勾选。

## 数据库与持久化

- [ ] `servers` / `operators` / `sessions` / `audit_logs` 四张表在 SQLite 中存在
- [ ] 启动时若 DB 文件不存在,自动建表(迁移)
- [ ] 启动时若 DB 文件存在,跳过建表不报错
- [ ] 所有表主键使用 ULID(26 字符)
- [ ] 所有时间字段存 Unix epoch 整数

## 加密

- [ ] 启动时 `ENCRYPTION_KEY` 缺失或不合法,进程立即退出并报清晰错误
- [ ] `servers` 表的 `encrypted_password` / `encrypted_private_key` / `encrypted_passphrase` 字段存的是密文(肉眼不可读)
- [ ] `decrypt(encrypt(x)) === x` 单元测试通过
- [ ] 加密单元测试覆盖空串、特殊字符、错误密钥

## 双操作者鉴权

- [ ] `POST /api/v1/auth/login` 正确用户名密码返回 JWT
- [ ] `POST /api/v1/auth/login` 错误凭证返回 401,且不区分"用户不存在"和"密码错误"
- [ ] 带有效 JWT 的请求能访问受保护端点
- [ ] 带有效 API Key 的请求能访问受保护端点
- [ ] 带无效/过期凭证的请求返回 401
- [ ] JWT 载荷包含 `operatorId` / `type` / `scopes` / `exp`

## RBAC

- [ ] 只有 `read` scope 的 operator 调写操作,返回 403 `INSUFFICIENT_SCOPE`
- [ ] operator 的 `server_permissions` 不含目标 server ID,访问被拒,返回 403 `SERVER_ACCESS_DENIED`,审计 `status='denied'`
- [ ] `server_permissions` 为空时,admin 可访问所有 server,非 admin 行为待定(预期默认全部)

## SSH 连接池隔离

- [ ] 人类 A 和 Agent B 同时操作同一台机器,各有独立 ssh2.Client
- [ ] A 断线不影响 B 的活跃会话
- [ ] 同一台机器活跃 Client 超过配置上限,新连接返回 `TOO_MANY_CONNECTIONS`
- [ ] 原 `executeCommand` / `upload` / `download` 公共方法签名保持不变

## MCP 工具(8 个)

### 已有 4 个

- [ ] `list_servers` 从 DB 读取,而非 CLI 启动参数
- [ ] `execute_command` 调用前通过 RBAC 校验,调用后写 audit
- [ ] `upload` / `download` 同上
- [ ] 命令不在 `servers.command_whitelist` 时,返回 `COMMAND_VALIDATION_FAILED`,审计 `denied`

### 新增 4 个

- [ ] `get_server_status(serverName, timeout?)` 返回 CPU/内存/磁盘/网络/进程/服务完整结构
- [ ] `batch_execute_command` 按 `--group / --tag / --servers` 过滤目标
- [ ] `batch_execute_command` `parallel=5` 时最多 5 个并发
- [ ] `batch_execute_command` `failFast=true` 时,首个失败后其他进行中调用被取消
- [ ] `batch_execute_command` 每台机器各写一行 audit_log
- [ ] `search_files` 包装 find 命令,支持 name pattern + path + type + maxDepth
- [ ] `search_files` 单服务器结果超过 1000 条被截断
- [ ] `query_audit_logs` 按 `operator.server_permissions` 自动过滤越权 server
- [ ] `query_audit_logs` 支持分页(limit / offset)

## Web UI

- [ ] `/login` 页能登录,失败显示错误
- [ ] 登录成功后 JWT 存 localStorage,后续请求自动带 Authorization header
- [ ] `/` 仪表盘显示统计卡片(机器总数/在线/今日操作数)
- [ ] `/servers` 列表支持 group/tag 过滤
- [ ] `/servers` 列表支持新建/编辑/删除(对话框表单)
- [ ] `/servers/:id` 详情页有 5 个 Tab:终端/命令/文件/状态/审计
- [ ] 401 响应自动跳登录页

## Web 终端

- [ ] `/servers/:id` 切到"终端" Tab,xterm.js 渲染
- [ ] 输入字符立刻传到远端机器
- [ ] 远端输出实时显示
- [ ] 调整浏览器窗口大小时,resize 帧同步到 server,远端 `stty` 调整
- [ ] WebSocket 断开时浏览器自动重连(指数退避,最大 30s)
- [ ] server 侧 shell session 在断线后保留 30s 宽限期
- [ ] 详情页"当前连接"列表正确显示进行中的 session

## CLI 工具

- [ ] `ssh-mcp-cli server list` 输出服务器列表
- [ ] `ssh-mcp-cli server list --format json` 输出 JSON
- [ ] `ssh-mcp-cli server list --format table` 输出人类可读表格
- [ ] `ssh-mcp-cli exec <server> <cmd>` 单机执行
- [ ] `ssh-mcp-cli batch exec --group <g> --cmd <c>` 批量执行
- [ ] `ssh-mcp-cli batch exec --dry-run` 预演不执行
- [ ] `ssh-mcp-cli scp upload <local> <server>:<remote>` 上传
- [ ] `ssh-mcp-cli scp download <server>:<remote> <local>` 下载
- [ ] `ssh-mcp-cli terminal <server>` 唤起浏览器
- [ ] `ssh-mcp-cli login` 交互式登录,API key 存到 `~/.config/ssh-mcp-cli/config.json`,文件权限 600
- [ ] `SSH_MCP_API_KEY=sk-xxx ssh-mcp-cli server list` 用环境变量 key 鉴权成功

## 审计

- [ ] 所有 MCP tool / API 端点 / WebSocket 调用执行后写 `audit_logs`
- [ ] `output` 字段超过 10KB 被截断
- [ ] `error_message` 包含 `password=secret` 入库时变 `password=***`
- [ ] `error_message` 包含 `BEGIN PRIVATE KEY` 入库时过滤掉
- [ ] `query_audit_logs` 接口能查到所有操作

## 部署

- [ ] `Dockerfile` 多阶段构建,最终镜像基于 node:22-alpine
- [ ] `docker-compose.yml` 单服务,挂载 data/logs 卷
- [ ] `docker compose up -d` 后 5s 内 `/api/v1/health` 返回 `ok`
- [ ] 健康检查失败 3 次后容器标记 unhealthy
- [ ] 容器内 MCP 仍能通过 `npx ssh-mcp-server --help` 工作

## 现有能力保留

- [ ] 命令白/黑名单继续生效(从 DB 读配置)
- [ ] 本地路径校验(`validateLocalPath`)保留,逻辑不变
- [ ] 远程路径校验(`validateRemotePath`)保留,逻辑不变
- [ ] SOCKS 代理支持保留
- [ ] 2FA (`tryKeyboard` + `SSH_MCP_2FA_CODE`)支持保留
- [ ] exec / shell 两种 transport mode 保留
- [ ] shell 模式的 marker 协议(`__MCP_BEGIN__` / `__MCP_END__`)保留
- [ ] 现有 7 个测试文件继续通过
- [ ] `npm run build` 继续成功

## 兼容性 / 迁移

- [ ] 启动时若 `servers` 表为空,提示"首次启动请创建服务器"
- [ ] 启动时若提供 `--import-config <file>`,从旧 CLI 参数格式导入到 `servers` 表
- [ ] 原 CLI 启动参数(`--host` / `--port` 等)仍能在小规模场景下工作(向后兼容,可选)
