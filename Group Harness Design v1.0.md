下面这份文档把之前讨论的共识和 Linus 指出的细节都收进去了，并修正了任务流边界：**任务结果和聊天流完全分离，走独立通道，永不写入聊天流**。可以直接复制作为工程实现的基准文档。

---

# Group Harness 工程实现文档（v1，可复制）

## 1. 系统定位

Group Harness 以“群”为核心抽象。群是用户、agent 与消息同步的容器，存储一切聊天记录和任务记录。**群没有记忆系统**；记忆属于 agent 自己。群内成员分 `agent` 和 `user` 两类。agent 拥有自己的经典 tool loop 会话和完整上下文；群只负责投递事件和记录事实。

**两条流严格分离**：
- **聊天流**：存 `messages.db`，只承载对话消息和少量必要的系统通知（如重启）。**任务结果、任务状态变更永不写入聊天流。**
- **任务流**：存 `tasks.db`，异步任务的创建、状态、结果只走独立的任务结果通道，投递给指定成员。

## 2. 技术栈与进程模型

- **语言**：TypeScript + Node.js。
- **持久化**：SQLite（messages、tasks、queue）+ TOML（配置）+ JSONL（审计）。
- **TUI**：Ink 或 Blessed，仅作控制台。
- **进程模型**：单进程管多个群；TUI 同进程启动，直接调用群函数。
- **模型调用与 tool loop**：从 DSH 剪枝挪用，去掉插件系统、会话日志、UI、服务注册表；依赖倒置为 Group Harness 薄接口。
- **模型协议**：第一版实现 `openai-completions` 和 `anthropic-messages`，`openai-responses` 后置。
- **file_permission**：借鉴 DSH 逻辑，由 harness 强制执行，不依赖 system prompt 自觉。

## 3. 目录与持久化布局

```
.groupharness/
├── config.toml                  # 全局默认：模型、file_permission、工作目录
├── audit.jsonl                  # 全局 append-only 审计
└── groups/
    └── <group_id>/
        ├── meta.toml            # 成员、身份组、管理员、响应策略、监听、群级默认
        ├── messages.db          # 聊天记录（仅聊天流）
        ├── tasks.db             # 后台任务流（独立）
        ├── queue.db             # agent 投递队列（持久化）
        └── agents/
            └── <agent_id>/
                ├── config.toml  # 该群内 agent 覆盖配置
                ├── context.jsonl # agent 自己的上下文（落盘，重启恢复）
                └── ...          # agent 记忆/摘要，归 agent 管
```

配置 fallback 链：**agent → 群 → 全局**，逐字段 fallback。

## 4. 核心概念

| 概念 | 定义 |
|---|---|
| 群 | 持有 `group_id`，存全量聊天记录和任务记录，无记忆系统 |
| 成员 | 可说话单位，身份 id 群内唯一，分 `agent` / `user` |
| 身份组 | 独立的 `group_key → set(member_id)` 映射 |
| 权限 | 绑身份组，`check_permission(id, permission)` 判定 |
| 聊天流 | 群对话事实，全员可见，存 `messages.db` |
| 任务流 | 异步任务事实，与聊天流严格分离，存 `tasks.db` |
| queue | 群向 agent 投递事件的持久化队列 |
| 系统伪成员 | 每个群内置保留 id `system`，不可删，用于内部发送和重启通知 |

**必须区分**：群聊天记录、投递给 agent 的“群聊历史记录”附带上文、agent 自己的上下文。三者独立，群不碰 agent 上下文。

## 5. 权限模型（补 Linus #1、#3、#5）

**绑定方式**：权限绑**身份组**，不直接绑成员。
```
identity_group: group_key → set(member_id)
group_permission: permission_id → set(group_key)   # 哪些身份组拥有该权限
```

**`check_permission(id, permission)` 查两张表**：
1. 从 `member_id` 找所属身份组集合。
2. 判断任一身份组是否在 `group_permission[permission]` 中。

**管理员列表**：视为隐式拥有全部权限，不经过 `group_permission` 表，但在审计中 actor 记为实际管理员 id。

**第一版权限 id 最小集**：
- `read_private_task`
- `set_member_permissions`（管身份组的权限绑定）
- `set_member_identity_groups`
- `set_member_listen_config`
- `manage_agent_config`
- `manage_group`

**发送权限**：`send_message` **不作为权限**。所有成员默认可发，但 kind 受角色限制：`user` 可发 `user_message`；`agent` 可发 `agent_message`；`system` 类 kind（`system_restart`）只能由内部 system 伪成员产生。

**新成员默认**：无任何身份组，无特殊权限；`system` 身份组自动全部允许，不可被非 system 修改。

## 6. system 身份落地（补 Linus #2）

每个群内置保留伪成员 `system`，id 固定为 `system`，不可删除、不参与普通成员列表（或单独标记）。

- `send` 的 `sender_id` 可以是 `system`，但只允许内部路径传入。
- `system_restart` 由 `system` 发送。
- 审计 actor 记 `tui`（TUI 操作）或 `system`（内部系统操作），不伪造管理员 id。

## 7. 审计规则（补 Linus #3、#19）

**audit.jsonl 字段**：
```json
{"ts":"ISO8601","actor":"tui|system","group_id":"...","action":"...","target":"...","before":{},"after":{},"ok":true}
```

**记审计的操作**：
- TUI 所有写操作（改权限、身份组、监听、agent 配置、群配置）。
- system 越权读私有任务。
- 管理员读私有任务（留痕）。

**不记审计**：普通读操作、聊天记录查询（除非显式要求）。

**并发写**：JSONL append 单写者队列，保证不写花。**失败操作也记**，`ok=false` 并带错误摘要。

## 8. bypass_permission 隔离（补 Linus #4）

- 参数名 `bypass_permission`（或 `internal`），仅存在于**群对象的内部方法签名**。
- 不暴露给 tool 层、IM 适配器或任何 agent 可调路径。
- TUI 直接持有群对象的 internal 句柄，传 `bypass_permission=true`；agent/tool 只能拿到受限的公开方法，签名里没有这个参数。
- 第一版不做 token，靠**函数签名隔离**：公开方法和 internal 方法分开定义。

## 9. 消息流与 content 格式（补 Linus #6）

**messages.db schema**：
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 群内单调序号
sender_id TEXT NOT NULL,
kind TEXT NOT NULL,
content TEXT NOT NULL,                 -- JSON 包装
created_at TEXT NOT NULL
```

**content JSON 包装**：
```json
{"kind":"user_message|agent_message|system_restart","sender_id":"...","source":"...","task_id":null,"timestamp":"...","text":"..."}
```

**kind 第一版完整枚举**：
- `user_message`
- `agent_message`
- `system_restart`
- 未知 kind：不注入 agent 上下文，标记为 `unknown`，不静默当用户消息。

**task_status / task_result 不进 messages.db**。任务相关事件只走任务流和独立通道。

**send 接口**：`group.send(sender_id, content, kind)`，内部校验成员身份和 kind 合法性，返回消息 id。

## 10. 响应策略与分发（补 Linus #7、#8）

**策略挂在成员上**，每条策略包含目标成员 id。正交列表：
```
(trigger_mode, sender_type, context_before)
trigger_mode: mention（默认）| all
sender_type: user | agent | all
```

**mention 语法**：`@<member_id>`。`all` 表示“所有该类发送者的消息”。

**分发算法**：
- 纯规则匹配，O(成员数) 可接受。
- 不转发自己的消息给自己。
- 多条策略命中同一 agent，只生成**一条** queue 条目。
- 不设人为防循环上限。

**context_before 组装**：
- 按触发消息逐条取前 x 条群聊记录，统一模板拼接。
- 模板格式：`[群聊历史记录]\n<seq> <sender_id>: <text>\n...\n[当前触发消息]\n...`
- 简单拼接，不消除重复。
- 标记为“群聊历史记录”，不是 agent 上下文。

## 11. 主动监听（user）（补 Linus #9）

- 监听配置挂在 user 成员上：黑名单 / 白名单 / 全部。
- 匹配维度：`sender_id` + `kind`。
- 默认不监听自己发的消息、`system`、`system_restart`。
- 多个 user 的 transport 独立路由，每个成员绑自己的 adapter。
- `set_member_listen_config` 权限：允许管理员改他人；第一版不允许 user 改自己（走 TUI/system 路径）。

## 12. Agent 运行时（补 Linus #10、#24）

- agent 拥有完整经典 tool loop 会话和上下文，触发源全部是系统转发消息。
- 上下文**落盘**到 `agents/<id>/context.jsonl`，重启恢复。
- `system_restart` 作为新条目注入，**不重置**上下文。
- 压缩摘要存同目录；保留最近 N 轮（默认 8）+ system prompt，早期内容截断或摘要。
- `agent_id` 群内唯一，不跨群共享实例。
- 配置项（agent → 群 → 全局 fallback）：
  - `baseurl`
  - `format`: `completion` / `anthropic`（第一版）
  - `apikey`（第一版允许明文）
  - `model`
  - `reasoning_effort`
  - `context_window`
  - `max_output_tokens`
  - `file_permission`
  - `working_directory`

**薄接口**：
- `complete(messages, config) → { tool_calls?, text? }`
- `get_tool(name) → ToolDefinition`
- queue 输入：`QueueItem[]`
- 动作输出：`send` / `call_tool`

**tool call/result role**：`assistant.tool_calls` / `tool`。最大 tool loop 轮数默认 16。

## 13. Tool 系统（补 Linus #15）

**同步 tool**：`(args, ctx) → Result`。`ctx` 含调用者 id（harness 注入，不接受 model 传参）、群句柄、工作目录。

**异步 tool**：挂载到后台，指定发布者、`(tooltype, args)`、可选监听者、`visibility`。**任务默认 `visibility=private`**，显式声明才公开。

**tool 执行流水线**（借鉴 DSH）：
`pre-execute`（门禁）→ `execute`（超时/重试包装）→ `post-execute`（结果检查/替换）→ 返回 model。

**超时/异常/权限拒绝**：返回结构化错误 `{error: "timeout|denied|failed", message: "..."}`，不抛裸异常。

**系统级 tool**（固定注入）：发消息到群聊、查聊天记录、查后台任务。

**业务 tool**：每个 agent 独立启用列表。

## 14. 任务流与独立结果通道（修正 D 点）

**tasks.db schema**：
```sql
task_id TEXT PRIMARY KEY,
tooltype TEXT,
args TEXT,
publisher_id TEXT,
listeners TEXT,        -- JSON array of member_id
visibility TEXT,       -- private | public，默认 private
status TEXT,           -- pending | running | done | failed
result TEXT,
error TEXT,
created_at TEXT,
updated_at TEXT
```

**状态机**：`pending → running → done | failed`。失败也是结果，不自动重试。

**独立结果通道**：
- 任务状态变更和结果**永不写入 messages.db**。
- 对 user 成员：通过该成员的 transport 调**任务结果接口**，区别于发送群聊消息接口。user 的 adapter 决定展示或丢弃。
- 对 agent 成员：以 `kind=task_result` 注入 queue，由 agent 运行时决定是否进上下文。
- 私有任务的结果只投发布者和监听者；公开任务也不写聊天流，仍走独立通道。

**读后台任务概要**：入参只传读取者 id，内部 `check_permission`。私有任务非发布者/监听者不可见，管理员可无视私有但留痕。拒绝统一返回“不可见”。

**查询后台任务 tool**：harness 层注入调用者 id，结果作为 tool result 回 model，不写聊天流。

## 15. Queue 机制（补 Linus #11）

- queue **只服务 agent**；user 不走 queue，走 transport 直接推送。
- 存 `queue.db`，启动加载。
- 条目字段：`id, target_agent_id, kind, payload, created_at, status`。
- 状态机：`pending → processing → done | failed`。
- 一次消费合并当前全部 `pending`，事务内批量置 `processing`，处理完置 `done`；失败置 `failed` 并记录错误。
- 消费失败不重试，`failed` 条目保留供排查。
- 启动顺序：先加载旧 `pending`，再入 `system_restart`。
- 合并发送时触发消息单独标明；群聊历史记录简单拼接，不去重。

## 16. file_permission 与工作目录（补 Linus #16）

- 路径归一化后前缀匹配，`..` 和符号链接先解析再判，`deny` 优先。
- 操作位：`read` / `write` / `execute`。
- 空值继承，显式 `deny_all` 才全拒。
- `working_directory` 由 harness 校验存在或可创建。
- 每次 **tool 执行前**合并读取配置，不是每次模型调用。

## 17. 查找聊天记录（补 Linus #17）

- SQLite FTS5，中文用 trigram 或外部分词。
- 入参：读取者 id、关键词、日期范围、分页 cursor。
- 返回 `{id, sender_id, kind, text, created_at}`，按 id 排序。
- 默认页大小 50，上限 200。
- 分页用 cursor：`id > ?`。
- 第一版不做可见性过滤，群消息全员可见；读取者 id 保留用于审计。
- 全文索引随写入同步维护；schema 迁移版本号管理。

## 18. 启动流程（补 Linus #18）

1. 读 `.groupharness/config.toml`。
2. 启动 transport 和本地模拟 IM 服务。
3. 扫描 `groups/*`，加载 `meta.toml`、`messages.db`、`tasks.db`、`queue.db`。
4. 加载 agent 配置，按 agent → 群 → 全局合并。
5. 启动各群运行时和 agent 运行时。
6. 向每个群全部成员投递 `system_restart`：写入 messages.db（仅此系统通知允许），user 通过 transport 发送，agent 进 queue 唤醒。
7. 启动 TUI。
8. 投递失败标 pending，不阻塞启动。

## 19. 事务与崩溃恢复（补 Linus #22）

- 消息写入 + 分发入队：同一 SQLite 事务（或 ATTACH 事务）。
- 任务状态 + 结果入队：同一事务。
- SQLite 开 WAL，`busy_timeout` 设 5000ms。
- 启动时检查 queue 中 `processing` 条目（上次崩溃残留），重置为 `pending`。
- `messages.db` 和 `tasks.db` 分别 WAL，互不阻塞。

## 20. TUI 控制台（补 Linus #21）

- TUI 是控制面，**不是聊天入口**。
- 以群无关 system 身份直接调 internal 方法，带 `bypass_permission=true`。
- 管理内容：群创建/查看、成员注册与身份组、权限与策略编辑、agent 配置、任务流查看、聊天记录检索。
- 消息流只读展示；**TUI 不发消息**，发消息走模拟 IM。
- TUI 写操作记审计。

## 21. 本地模拟 IM

- WebSocket，单端口，user_id 映射到群内成员。
- adapter 接口：`connect` / `send` / `receive`。
- 作为 user 成员的 transport 接入系统接口。
- 之后替换成真实 IM adapter，接口不变。

## 22. 配置 schema 与热更新（补 Linus #20）

**config.toml（全局）**：
```toml
[model]
format = "completion"
baseurl = ""
apikey = ""
model = ""
reasoning_effort = ""
context_window = 128000
max_output_tokens = 4096

[file_permission]
default = "inherit"   # inherit | deny_all
```

**群 meta.toml**：成员、身份组、管理员、响应策略、监听、群级 model/file_permission 覆盖。

**agent config.toml**：逐字段覆盖。

**缺省值**：`context_window=128000`，`max_output_tokens=4096`，`file_permission=inherit`。

**配置错误**：启动失败并报路径，不静默跳过。

**热更新**：在一次 tool loop 结束后生效，不在 loop 中间切换配置。

## 23. 第一版范围

**做**：群/成员/身份组/六权限、`check_permission`、`bypass_permission` internal 隔离、聊天流与任务流分离、queue 持久化、响应策略、主动监听（user）、agent 上下文落盘与压缩、同步/异步 tool、任务独立结果通道、file_permission、查聊天记录、查后台任务、TUI、审计、本地模拟 IM、配置 fallback 与热更新、key 脱敏。

**暂缓**：插件系统、复杂成员可见性、消息级可见性、真实 IM adapter、向量检索、queue 去重、失败重试、人为防循环上限、

---

专门找个地方放所有用到的提示词：ts, 字典

测试可任意使用的API：
https://api.commandcode.ai/provider/v1/chat/completions
https://api.commandcode.ai/provider/v1/responses
https://api.commandcode.ai/provider/v1/messages

key和model在.env