# Group Harness

以「群」为核心的 agent 聊天运行时。群是用户、agent 与消息的容器；群没有记忆，记忆属于每个
agent 自己。聊天流与任务流严格分离：任务状态和结果永远不会写进聊天记录。

实现依据：`Group Harness Design v1.0.md`。第一版范围已全部实现，包含本地模拟 IM、Web 管理台
（默认）与 Ink TUI（备用）。

## 两条流

```
user ──WebSocket──> ImServer ──> group.send() ──> messages.db
                                      │
                                      ├─ 响应策略 ──> queue.db ──> agent 工具循环 ──> 工具/发消息
                                      └─ 主动监听 ──> 各 user 的 transport

异步工具 ──> tasks.db ──> 独立结果通道 ──> agent: queue(task_result) / user: transport(task_result)
```

- **聊天流**：`messages.db`，只存 `user_message` / `agent_message` / `system_restart`。
- **任务流**：`tasks.db`，状态机 `pending → running → done | failed`，失败不自动重试。
- **queue**：`queue.db`，只服务 agent；一次消费合并当前全部 pending，事务内批量置 processing。
- **审计**：`.groupharness/audit.jsonl`，单写者队列，凭据自动脱敏。

## 快速开始

需要 Node.js 24+。

```bash
npm install

# 从 .env 的 API_KEY / MODEL 生成 .groupharness/config.toml
npm run gh -- init

# 编辑 .groupharness/config.toml，至少填好 model.baseurl（apikey/model 已从 .env 带入）
#   [model]
#   baseurl = "https://api.commandcode.ai/provider/v1"

# 建立演示群
npm run gh -- create demo "Demo Group"
npm run gh -- member-add demo alice user
npm run gh -- member-add demo bob agent
npm run gh -- admins demo alice
npm run gh -- identity demo alice core
npm run gh -- permission demo manage_group core
npm run gh -- policy-add demo bob mention user 6
npm run gh -- agent-set demo bob tools=read_file,write_file,list_dir,run_command,run_command_async dir=.

# 启动 Web 管理台 + 模拟 IM；终端会打印带 token 的本地 URL
npm start

# 或者继续用终端控制台
npm run tui
```

`npm start` 会打印：

```
Group Harness admin: http://127.0.0.1:8787/?token=...
Mock IM: ws://127.0.0.1:8787
```

用浏览器打开第一个 URL。页面只做管理，不做聊天；聊天仍然走模拟 IM。可以用任意
WebSocket 客户端连上来：

```json
{"type":"hello","group_id":"demo","user_id":"alice"}
{"type":"send","text":"@bob 帮我看看 package.json"}
```

服务端帧：`hello_ok` / `message` / `task_result` / `sent` / `error`。
完整可运行客户端见 `scripts/demo.ts`。

## Web 管理台

默认入口（`npm start`），和模拟 IM 共用同一个端口，因此不需要第二个端口或前端构建。

页面提供的操作：

- 群列表、创建群；群配置覆盖（model / working_directory / file_permission）
- 成员列表、添加成员、身份组、用户 listen 配置
- 响应策略增删
- 六个权限到身份组的绑定
- agent 列表；每个 agent 的 model / tools / working_directory / file_permission 覆盖
- 任务列表、任务详情（读私有任务写审计）
- 最近消息与消息搜索
- 软件设置（全局 model / file_permission / working_directory / mock IM / 主题色）
- reload config

API 写操作需要启动时随机生成的 token；终端 URL 里的 `?token=...` 就是它。页面把 token
存进 `sessionStorage`，之后的 API 请求用 `X-Admin-Token` 头。直接打开不带 token 的
`http://127.0.0.1:8787/` 只会看到 token 输入框；不会暴露数据。

样式约束：`admin.html` 只定义 `--accent` / `--bg` / `--fg` 三个颜色，所有按钮、输入框、
表格、面板统一是 1px 边框、0 圆角，无阴影、无渐变。

### 软件设置（自动保存）

页头 `settings` 打开全局设置，不需要先选群。改完就保存，没有 Save 按钮：

- **主题**：accent / background / foreground 三个颜色，即时应用；落盘到 `[webui]`
- **全局 model**：format、baseurl、model、reasoning_effort、context_window、max_output_tokens；
  API key 不显示，输入新值即覆盖，`clear` 显式清空
- **全局 file_permission**：default 与 read/write/execute/deny 前缀
- **全局 working_directory**：相对项目根；保存时自动创建目录
- **mock IM**：host / port；写入配置，但当前监听要等下次启动才换

设置写入 `config.toml` 并立即更新内存；model/file_permission 在下一次 agent 唤醒/工具执行时生效。
每次尝试都会写审计（actor `web`，action `set_settings`）。保存会重写整个 `config.toml`，
只保留文件头注释。

### 一键真实模型演示

```bash
npm run demo
```

在 `.demo/` 里创建独立环境，让 bob 真正读文件并通过 `run_command_async` 起后台任务，
然后打印聊天回复与任务结果通道。使用 `.env` 的 `API_KEY` / `MODEL`，默认 baseurl 为
`https://api.commandcode.ai/provider/v1`（可用 `BASE_URL` 覆盖）。

## 控制台命令

Web 管理台是默认入口；TUI 与 `npm run gh -- <command>` 共用下面这套命令。TUI 里
`view <overview|messages|tasks>`、`select <group>`、`quit` 是额外命令。

```
groups
group <group>
create <group> [name...]
member-add <group> <id> <user|agent>
admins <group> [member...]
identity <group> <member> [groupKey...]
permission <group> <permission> [groupKey...]
listen <group> <user> <all|blacklist|whitelist> [senders=a,b] [kinds=...]
policy-add <group> <agent> <mention|all> <user|agent|all> [context_before]
policy-clear <group> <agent>
agent <group> <agent>
agent-set <group> <agent> key=value...    # model 字段 / tools / dir / read / write / execute / deny / default
group-set <group> key=value...
messages <group> [limit]
search <group> <query> [since=ISO] [until=ISO] [limit=N] [cursor=N]
tasks <group> [limit]
task <group> <task_id>
reload
help
```

Web/TUI/CLI 写操作与管理员读私有任务都会写入审计（Web 写操作 actor 为 `web`，TUI 为
`tui`）；apikey 在展示与审计中均为脱敏值。

## 配置

- 全局：`.groupharness/config.toml`
- 群：`.groupharness/groups/<id>/meta.toml`
- agent：`.groupharness/groups/<id>/agents/<agent>/config.toml`

逐字段 fallback：**agent → 群 → 全局**；空字符串 / 空数组表示继承。配置错误启动即失败并报路径。
模型配置在每次 agent 唤醒开始时读取（一次工具循环不会中途换模型）；`file_permission` 与
`working_directory` 在每次工具执行前重新合并读取。`reload` 用于重新读取文件。

```toml
working_directory = ""         # 相对路径按项目根解析

[model]
format = "completion"          # completion | anthropic
baseurl = "https://api.commandcode.ai/provider/v1"
apikey = "..."
model = "deepseek/deepseek-v4.1-flash-fast"
reasoning_effort = ""
context_window = 128000
max_output_tokens = 4096

[file_permission]
default = "inherit"            # inherit | deny_all
# read/write/execute = ["/abs/prefix"] 或 "deny_all"
# deny = ["/abs/prefix"]       # 优先于 allow

[im]
host = "127.0.0.1"
port = 8787                    # 0 = 随机端口

[webui]                        # Web 管理台主题（settings 页自动保存）
accent = "#6ea8fe"
background = "#0d0f12"
foreground = "#d7dae0"
```

## 工具

系统级（固定注入）：`send_message`、`search_messages`、`list_tasks`、`get_task`。
业务工具（agent 配置 `tools` 启用）：`read_file`、`write_file`、`list_dir`、`run_command`、
`run_command_async`。

所有调用走同一条流水线：pre（参数校验 + file_permission 门禁）→ execute（超时包装）→
post。异常、超时、拒绝都变成结构化结果 `{error, message}`，不会抛裸异常给模型。

- `file_permission` 在**每次工具执行前**由 harness 强制检查：路径先规范化（解析 `..` 与符号链接），
  再按前缀匹配，`deny` 优先。`run_command` 只检查工作目录的 `execute` 权限，不提供 OS 级沙箱。
- 私任务默认 `visibility=private`，只投发布者与 listeners；公开任务仍只走任务结果通道，不写聊天流。
- `list_tasks` / `get_task` 的调用者 id 由 harness 注入，模型无法伪造。

## 目录

```
src/
  main.ts          CLI / Web / TUI 入口
  harness.ts       配置、群、模拟 IM、Web 管理台、启动顺序
  group.ts         群公共面 + GroupAdmin（bypass_permission 内部句柄）
  admin-web.ts     Web 管理台 HTTP API（token、审计 actor=web）
  admin.html       单页管理界面（纯 HTML/CSS/JS，无构建）
  agent.ts         agent 上下文、队列消费、工具循环
  tools.ts         工具注册表 + 内置工具
  llm.ts           OpenAI chat completions / Anthropic messages 适配
  config.ts        TOML 解析、fallback、脱敏、file permission 合并
  meta.ts          群元数据校验
  storage.ts       messages/tasks/queue（ATTACH 事务）
  prompts.ts       所有模型提示词，集中管理
  permissions.ts   身份组 → 权限判定
  file-permission.ts 路径权限
  audit.ts         单写者 JSONL 审计
  im.ts            本地模拟 IM（WebSocket）
  commands.ts      控制台命令
  tui.tsx          Ink 控制台
scripts/demo.ts    真实模型端到端演示
test/              node:test 测试
```

## 测试

```bash
npm run typecheck
npm test
```

覆盖：配置合并与严格校验、路径权限（含符号链接逃逸）、FTS/短词回退与分页、事务回滚、
v1 → v2 schema 迁移、队列状态机、分发规则、监听过滤、agent 工具循环与上下文恢复、
运行时新增成员、异步任务结果通道、公开/私有任务可见性、两套 LLM 协议映射、模拟 IM 往返、
Web 管理台 token/API/审计与样式约束、全局设置持久化与主题校验。

## 已知边界（第一版）

- 上下文压缩是**截断**：保留最近 8 轮 + token 预算，不调用模型做摘要；`context.jsonl` 不重写。
- 全文检索用 FTS5 trigram；少于 3 个字符（常见中文双字词）回退到 `LIKE`。
- 模拟 IM 无鉴权，仅用于本地开发；离线投递是内存 outbox（上限 100 条），重连即冲刷，
  进程崩溃会丢未送达消息。
- 同一 harness 同时只应有一个 `runtime` 进程（Web 或 TUI，二选一）。命令行控制默认不启动
  agent runtime，因此和 Web/TUI 并存是安全的；但两个 runtime 同时跑会重复消费队列。
- Web 管理台和模拟 IM 共用一个端口。若端口被现有 TUI 占用，先退出它（或在 `[im]` 改端口）
  再 `npm start`。
- Web 管理台和模拟 IM 都只应绑 `127.0.0.1`；改 host 前先想清楚，mock IM 本身没有鉴权。
- 外部直接改 `meta.toml` / agent config 后，运行中的 Web/TUI 需点 `reload config`（或执行
  `reload`）才会读到新成员/策略；模型与权限配置在每次 agent 唤醒时自然重读。
- Web 设置页保存会重写整个 `config.toml`；手工加在文件里的注释（除文件头）会丢。改 IM
  host/port 只写配置，当前进程的监听地址不会热切换。
- 无插件系统、无真实 IM、无任务重试、无人为防循环上限（与设计文档一致）。
- 任务失败/队列失败保留在数据库中供排查，不自动重试。
- 第一版允许明文 apikey；`file_permission` 默认不限制，启用文件工具的 agent 可以读工作目录内的
  文件（包括 `.env`）。需要隔离时用 `file_permission.deny` 或受限的 `working_directory`。
  `.env` 只在 `init` / `demo` 时读取，不会注入长期进程环境。
