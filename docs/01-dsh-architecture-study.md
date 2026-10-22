# DeepSeek Harness (DSH) 核心架构研究笔记

> 研究对象：`@deepseek-ai/dsh@0.2.1-rc.2`（npm 全局安装 checkout，位于
> `~/.nvm/versions/node/v22.19.0/lib/node_modules/@deepseek-ai/dsh/`）。
> 研究方式：只读源码。所有包均以编译产物分发（`lib/index.js` 单文件 bundle + `lib/types/*.d.ts`），
> 无 manifest-only 的空包；本文所有结论均附文件路径与行号证据（行号以本轮读取为准）。
> 核心源码树：`dsh/node_modules/@deepseek-ai/` 下共 **305** 个 `dsh-*`/`cordis*` 包。

---

## ① 总览：cordis 插件化 monorepo

DSH 是一个以 **cordis**（koishi 系插件框架的 DeepSeek 分支）为骨架的巨型插件 monorepo。
CLI 入口包 `@deepseek-ai/dsh`（apps/cli）本身只做 profile 启动与插件管理，其 `package.json`
通过 dependencies/devDependencies 装配约 120 个 `dsh-*` 插件构成一个完整 Agent Harness。

### 1.1 分层图谱（按包名前缀归纳）

```
┌────────────────────────────────────────────────────────────────────┐
│ 交付层  dsh(CLI) · dsh-sdk-* · dsh-headless · dsh-acp* (ACP协议)    │
├────────────────────────────────────────────────────────────────────┤
│ Web UI  dsh-web-app · dsh-web-frontend · dsh-host-webserver         │
│         dsh-api-gateway · dsh-api-{session,job,terminal,workspace,  │
│         settings,account,remotes}-controller                        │
│         dsh-client-connection · dsh-cordis-client-runner            │
│         dsh-client-ui-* (约60个 React UI 包) · dsh-client-*         │
├────────────────────────────────────────────────────────────────────┤
│ Agent 层 dsh-agent · dsh-agent-loop · dsh-agent-preset(-registry)   │
│          dsh-agent-instructions · dsh-system-prompt · dsh-persona   │
│          dsh-plan-mode · dsh-goal(-round-driver) · dsh-compaction-* │
├────────────────────────────────────────────────────────────────────┤
│ 能力层  dsh-tools · dsh-tool-{bash,fs,fs-search,str-replace-editor, │
│          todo,subagent,web,ask-user,skill,jobs,goal,schedule,       │
│          workflow,terminal,pwsh,...} · dsh-mcp-client               │
├────────────────────────────────────────────────────────────────────┤
│ 运行时  dsh-llm · dsh-llm-{deepseek,pi-ai,replay,mock-server}       │
│         dsh-llm-retry · dsh-session(-format*, -persistence*,        │
│         -projection*, -query*) · dsh-subagent(-spawn/fork-in-process)│
│         dsh-jobs-local · dsh-schedule · dsh-skill*                  │
├────────────────────────────────────────────────────────────────────┤
│ 后端    dsh-bash-local · dsh-fs-local · dsh-sandbox-local           │
│ (本地)  dsh-subprocess-local · dsh-pwsh-* · dsh-credentials-local   │
├────────────────────────────────────────────────────────────────────┤
│ 框架    @deepseek-ai/cordis · cordis-plugin-{loader,include,timer}  │
│         @deepseek-ai/schemastery (配置/Schema) · cosmokit            │
└────────────────────────────────────────────────────────────────────┘
```

### 1.2 cordis 关键机制（理解 DSH 的前提）

- **Service**：插件可注册命名服务（`ctx.systemPrompt`、`ctx.tools`、`ctx.llm`、
  `ctx.subagents`、`ctx.sandboxPolicy`、`ctx.sessionProjections`…），消费方用
  `static inject = [...]` 声明依赖（如 `dsh-tools/lib/index.js:2761` 的
  `static inject = ["systemPrompt"]`）。
- **ScopedLayers（作用域分层）**：全局注册 + 每 Agent 作用域注册两层同名可**影子覆盖**
  （shadow）而非报错——这是 DSH 实现"每个子代理一套工具/提示词/ persona"的基础
  （`dsh-system-prompt/lib/index.js:221` `layers = new ScopedLayers(...)`）。
- **事件与 waterfall**：`ctx.on(...)` 订阅、`ctx.waterfall(name, value, next)` 责任链
  （可层层改写值，最后 fallback），是贯穿全框架的扩展点风格
  （`system-prompt/assemble`、`tools/pre-execute`、`agent/request`、`agent/request-error`…）。
- **插件即依赖**：功能 = 装不装某个 `dsh-tool-*` 包。没有装 bash 执行后端时，bash 工具的
  sandbox 字段根本不向 schema 通告（`dsh-tool-bash/lib/index.js:344-346`）。

---

## ② Agent Loop 深剖（dsh-agent-loop）

核心类 `ReactLoopAgent`（`dsh-agent-loop/lib/index.js:747`）。**一切输入派生自 session 事件日志**，
循环本身几乎无独立状态。

### 2.1 三层驱动结构：driver → turn → step

```
wakeDriver() ──> kick() ──while──> turn() ──while──> step() ──> LLM stream
   │                 │                 │                 │
   │ phase=idle/running/maintenance    │                 ├─ assistant/message (durable)
   │ abort=AbortController             ├─ turn/start    ├─ tool/call + tool/result ×N
   │                                   ├─ step/start    └─ step/end
   │                                   └─ turn/end {reason}
   └─ Inbox (durable): next-turn 队列 / next-step 队列
```

- **turn**（`turn()`，:938）：append `turn/start`，循环执行 step；终止条件：
  `preStep` 被 waterfall 拒绝 → `blocked`；首个 step 无输入 → `completed`；
  step 返回 `{kind:"completed"|"max-tokens"}` 且 next-step 队列为空 → 结束；
  抛错 → `turn/end {reason: {kind:"error"|"aborted",...}}`（:1010-1036）。
- **step**（`step()`，:1043）：组装本轮 system prompt → 投影提交（`system/message`）→
  声明输入（`user/message`，含 runtime-context 快照）→ `prepareRequest`（`agent/request`
  waterfall 可改 provider/model）→ `buildRequest`（写 `request/header`，工具增减时补
  `developer/message` 的 `tool-addition/tool-removal` 块，:1241-1259）→
  `session.deriveMessages()` 从 surface 冻结派生最终 messages → `llm.stream(request)`。
- **循环驱动**：assistant 消息无 `tool-call` 块 → turn 自然结束；有则 `executeToolCalls`，
  全部结果落库后回到 turn 内的下一个 step（`target = "next-step"`，:1008）。

### 2.2 持久化 Inbox：next-turn / next-step 双队列

`ReactLoopInbox`（:70-209）将"待处理输入"做成 **session 日志投影**（projection）：
每个变更 append 一条 `agent/inbox/spliced` 事件（含 splice 语义 + 去重校验），重启后重放恢复。

- `followup()` → next-turn（新对话轮）；`steer()` → next-step（**step 边界插话/转向**，
  不打断当前 LLM 调用）；`inject()` → next-step（不唤醒）。
- `claim(target, turn)`（:103）：step 边界一次性取走 next-step 全部 + 可选一个 next-turn。
- 工具可通过 `exec.deferContext()` 把"额外上下文"塞进 next-step（如 `additionalContexts`，
  :572），下个 step 一并进入模型视野。

### 2.3 流式输出与 attempt 结算

`AssistantStreamAttempt`（:355-472）：每次 LLM 请求一个 attemptId
（`sessionId:counter`），发布带单调 `revision` 的 `start/chunk/end` 帧
（`agent/assistant-stream` 事件，GUI 直接消费）。durable 侧用
`AssistantStreamAccumulator`（紧凑流 + 时间戳）与 `BlockAssembler`（chunk→消息块）：

- 正常结束 → `assistant/message` 事件（含 message、usage、完整 stream）；
- 中途中止 → 已可见前缀 `interruptedBlocks()` 以 `interrupted: true` 落库（:1096-1112），
  或仅 `assistant/attempt`（无内容）；
- 模型侧 error/aborted → 落 `assistant/attempt` 后触发 `agent/request-error` waterfall，
  监听器（dsh-llm-retry）可返回 `{kind:"retry"}` 让 step 原地重试（:1136-1146）。

### 2.4 工具调用调度：barrier + 有界并行池

`executeToolCalls`（:506-533）按 `ctx.tools.executionMode()` 把调用分成
`exclusive`（互斥 barrier）与 `parallel`（池）。`runGroup`（:551）：

- 池大小 = `maxParallelToolCalls`（默认 10，:1297）；
- **dispatch 可乱序并发，commit 严格按模型顺序**（`commitReady` 按序落
  `tool/call`→`tool/result`，:565-576）——保证 replay 语义；
- abort：已启动的排干并落结果，未启动的补**合成错误结果**
  `"Error: tool call aborted before dispatch"`（:663-679），使日志永远配平可重放；
- step 崩溃时 `ToolCallRecovery` 观察者补写缺失 tool 结果（:975-991）。

### 2.5 错误恢复全景

| 故障点 | 机制 | 证据 |
|---|---|---|
| LLM 流失败 | `agent/request-error` waterfall → llm-retry 返回 retry | agent-loop:1136 |
| 工具体抛错 | registry 物化为 isError 结果（不炸循环） | dsh-tools:2697-2701 |
| step 中途崩溃 | ToolCallRecovery 补 synthetic 结果 | agent-loop:984 |
| 进程崩溃/日志截断 | 加载时 `openTurnClosers` 尾部修复：给未闭合 turn 补 tool 结果 + `step/end` + 带幂等性指引的 `turn/end` | dsh-session:733-770 |
| fork 分叉悬空调用 | 同上，cause="forked" 措辞教模型判断是否可安全重试 | dsh-session:745-751 |

`CLOSER_TEXT` 的模型可见措辞值得抄录（dsh-session:735）：
> "Decide whether to retry from the tool semantics: retry only if the operation is
> read-only or idempotent; if it may have side effects, first verify external state
> or ask the user. Do not retry blindly."

---

## ③ 系统提示词工程（dsh-system-prompt / dsh-agent-instructions）

### 3.1 注册表模型：sections + contexts + variables + tools

`SystemPrompt` 服务（`dsh-system-prompt/lib/index.js:213`）维护四类注册：

- **section**（静态段落）：`{name, order, text, interpolate?, complete?}`，按
  `SECTION_ORDERS` 中心化排序（:10-43）：`HARNESS_IDENTITY(-1000) → persona prefix(0) →
  PLAN_POLICY(500) → TOOL_*(1000-3000) → MCP_SERVERS(3100) → TOOLS_SDK(5000) →
  STRUCTURED_OUTPUT(9900) → HARNESS_SOURCE(10000) → persona suffix(10200)`。
- **context**（动态运行时上下文）：`CONTEXT_ORDERS`（:44-52）：
  `WORKING_DIRECTORY(100) → SANDBOX_POLICY(110) → APPROVAL_POLICY(115) →
  SUBAGENT_DELEGATION(120) → TEAM_IDENTITY(125)`。
- **variable**：严格 `{{name}}` 插值，未知/畸形引用直接 throw（:158-182）——
  提示词错误在装配期爆炸而非静默输出。
- **tools provider**：每次 assembly 收集工具 schema，支持 `toolOrder` 强排序 + 
  `<unlisted-tools>` 占位（:67-95）。

`renderPrompt`（:117）= 过滤空段 + `\n\n` 连接。`complete: true` 的 section 可**整体接管**
系统提示词（agent-preset 换 persona 用，:381-382）。

### 3.2 双通道投放：稳定系统提示 vs runtime-context 快照

这是 DSH 提示词工程最精髓的设计（agent-loop:211-350）：

```
模型请求
├── system 消息   ← SystemPromptProjection：首条占 surface 节点 0；
│                   支持 in-history 追加（provider 支持 system 更新时）或
│                   原地 replace；"series"边界决定缓存友好的更新策略
└── user 消息     ← RuntimeContextProjection：渲染后的动态上下文快照，
                    文本固定以 "Current runtime context. This snapshot
                    supersedes earlier runtime-context snapshots." 开头
                    (joinContextSections, dsh-system-prompt:136-140)
                    仅在内容变化时追加（cleared 时声明"先前的不再适用"）
```

工作目录、沙箱策略、审批策略、时间（`dsh-time-context`：ISO 时间戳 + 浏览器时区，
"mixed 时区→让用户澄清"）都走 runtime-context 通道——**稳定身份与易变事实分离，
前者利于 provider 缓存，后者变化才追加**。

### 3.3 散布在各工具包的"harness 思想"段落（真实文案）

| 包 | section | 文案（节选） |
|---|---|---|
| dsh-tool-bash:377-379 | `tool:bash` | "Check the `[exit code: N]` marker on every bash result; investigate failures before moving on." |
| dsh-tool-fs:546-548 | `tool:write` | "Read an existing file before overwriting it with write (the default fs-observation-policy requires it) and prefer edit for targeted changes." |
| dsh-tool-fs:687-689 | `tool:edit` | "Read a file before editing it … unless you just created or edited it in this session." |
| dsh-tool-fs:246-249 | `tool:read` | "Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files." |
| dsh-tool-todo:21-24 | 工具描述 | "Record and update a task list to plan multi-step work … skip it for trivial single-step tasks. Add one todo per concrete step before you start … keep exactly one todo `in_progress` … Mark each todo `completed` as soon as it is done." |
| dsh-sandbox-policy:70-78 | `sandbox:policy` | "Current DSH file policy: workspace-write. … may modify files under the session workspace: <root>. Some platform temporary areas may also be writable." |
| dsh-persona | persona prefix/suffix | 通过**同名 section 影子覆盖**实现 per-agent 身份切换 |

- **plan mode**（dsh-plan-mode）：进出 plan 模式**只换提示段落**（`plan:policy` section），
  不改请求工具集（README 明言"changes only the prompt section, not the request tool set"）。
- **workspace instructions**（dsh-agent-instructions）：向上扫描 `.git` 根，发现
  `AGENTS.md / CLAUDE.md`（+ `.local` 变体，:16-18），SHA-1 内容去重、字节预算
  （默认 1MiB maxSourceBytes）内渲染，作为独立 user 消息注入（会话状态含 baseline 身份，
  resume 时校验兼容）。
- **todo**：每次 `todo_write` 全量替换 + append `todo/write` 事件快照；
  "todos" 本身是 session projection（dsh-tool-todo:63-81），GUI 与恢复共用。

---

## ④ 工具协议（dsh-tools / dsh-tool-*）

### 4.1 定义：defineTool

```js
// dsh-tools/lib/index.js:838-887
defineTool({
  name, description,
  parameters: { /* Schemastery spec → 强制 JSON Schema 子集 */ },
  output: { schema, render(args, value), presentationMeta? },
  execute(args, exec),          // 参数先过 validateArgs，违规抛 ToolArgsError
  finalizeContent?, projectContent?,   // 结果后处理钩子
  presentCall?, presentResult?,        // GUI 呈现
  isConcurrencySafe?(args),            // 精确 true 才允许并行
  timeoutMs?, deferLoading?,
})
```

JSON Schema **强制子集**（`dsh-tools/lib/index.js` json-schema region）只允许
`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注释键
（description/title/default/examples），不支持的关键字直接拒绝——保证校验器与
生成 TS/Py 类型（`jsonSchemaToTs/jsonSchemaToPy`）行为一致，杜绝 open-ended schema。

bash 工具参数示例（dsh-tool-bash:492-529）——注意 `description` 字段是给 **UI 展示**的
"5-10 词主动语态"短语，而非给模型的：

```jsonc
{
  "description": "Clear, concise description … shown in the UI",
  "command": "…", "timeoutMs": 0, "workdir": "…",
  "run_in_background": false,          // 有 job registry 才通告
  "sandbox_permissions": "workspace-write|danger-full-access",  // 有沙箱执行器才通告
  "justification": "Required with sandbox_permissions: one sentence …"
}
```

### 4.2 执行管线与审批介入点

`ToolRuntime` 服务（dsh-tools:2760）管线（`prepareExecution` :3310 起）：

```
createExecution  冻结参数(deepFreeze+lossless JSON 校验)、发 token、
                 绑定 exec={callId, rootCallId, agent, parent?, signal,
                 deferContext(), concludeTurn()}
      ↓
tools/pre-execute waterfall ──► gate: {allow | ask(问题) | deny(原因)}   ← 审批/权限插件在此
      ↓ ask                                                        （dsh-user-approval）
serviceAsk → ctx.approval.ask(...)   用户批准/拒绝，事件 approval/asked+decided 落日志
      ↓
guards (单调拒绝谓词) ──deny──► 物化 isError 结果 "Error: <reason>"
      ↓
dispatch → tool.execute(args, exec)
      ↓
finalize（post-execute policy + finalizeContent）→ finish（物化冻结结果）
```

- **失败即结果**：工具体抛错不炸循环，物化为 `isError: true` 的 tool/result，附
  `error.info {name, code}`（HarnessError 携带机器可路由 `code`，如 `UNKNOWN_TOOL`、
  `INVALID_TOOL_OUTPUT`、`ABORTED`、`ABORTED_BEFORE_DISPATCH`）。
- **并发分类 fail-closed**（`executionMode` :3153）：只有 `isConcurrencySafe(args) === true`
  精确为真才 parallel；未知/抛错一律 exclusive。
- **结果回灌**：`appendToolResult`（agent-loop:691-707）以 `sourceEventSeqs:[callSeq]`
  关联调用事件；`result.additionalContexts` 进入 next-step inbox（steering 通道）；
  `exec.concludeTurn()` 可让某个工具（如 ask_user）直接终结 turn（`concludesTurn`，
  agent-loop:573,1167）。
- **PTC 模式**：`mode:"ptc"` 时所有工具对模型折叠为唯一的 `run_code`，其余名字直调返回
  UNKNOWN_TOOL（:3195-3197, 3272-3283）——模型写代码在受限进程里调工具，工具面收敛为 1。

### 4.3 代表性工具

- **bash**（dsh-tool-bash）：前台/后台(job)/超时转后台(promoted) 三态输出 union；
  stdout/stderr `{text, truncated, spillPath}`；渲染层追加 `[exit code: N]`、
  `[sandbox: file access denied under <mode> mode]`、升级提示等**边界标记**
  （:30-48, :167）；后台 job 注册进 `ctx.jobs`（pull-source 环形读 + spill 文件）。
- **fs read/write/edit**（dsh-tool-fs）：`read` 行号化 + offset/limit；`edit` 字面量
  old_string→new_string；write/edit 受 fs-observation-policy 约束（见 ⑦）。
- **ask_user_question**（dsh-tool-ask-user）：结构化多问题 schema
  `{questions:[{id, question, header?, options:[{label, description}], multi_select?}]}`，
  稳定 id 回显、超时语义明确（skipped≠pending）。
- **todo_write**：全量替换 + 投影（见 ③）。
- **subagent**（dsh-tool-subagent）：见 ⑥。
- **workflow**（dsh-workflow-ptc）：编排脚本在 `node:vm` realm 中执行，仅暴露
  `agent(prompt,opts)/parallel(thunks)/pipeline(items,...stages)/phase(title)/log(msg)/args`
  六个冻结全局；返回值必须经 `materializeFromRealm` 纯 JSON 物化（拒绝 bigint/symbol/
  循环引用/异构原型）；错误纪律：fatal（编排器错）抛出杀脚本，普通子项失败→`null`
  （`isFatalWorkflowError`）。并发槽 FIFO + 总量上限（AGENT_CAP 防失控循环）。

---

## ⑤ 会话模型（dsh-session / persistence / projection / format）

### 5.1 事件溯源日志

`Session`（`dsh-session/lib/index.js:1324`）：内存 `log[]`（seq=数组下标，连续性契约）+
不可变 `header {id, formatVersion: 4, cwd, lineage…}`。`append(type, data, intent?)` 同步
追加并广播 `session/event`，持久化插件**异步缓冲**（热路径不阻塞 I/O）。

事件词表 `KNOWN_SESSION_EVENT_TYPES`（:79-142，60 个）分四类：

1. 消息面（surface-eligible）：`system/message`、`developer/message`、`user/message`、
   `assistant/message`、`tool/result`（:157-163）；
2. 边界/骨架：`turn/start|end`、`step/start|end`、`tool/call`、`assistant/attempt`、
   `request/header|context`、`session/end-seed`；
3. 策略状态（log-only）：`sandbox/mode`、`approval/*`、`permission/preset`、
   `llm/retry(-started)`、`plan/mode`、`model/selection`、`todo/write`、`goal/change`、
   `schedule/change`、`agent/inbox/spliced`；
4. 生态：`compaction/*`、`subagent/*`、`team/*`、`job/*`、`workspace/changes`、
   `feedback/*`、`image/offload`…

未知事件类型必须带 `ignorable` 信封标记才可跳过（向前兼容新版本日志，:65-77）。

### 5.2 Surface：模型可见面的投影

`SURFACE_EVENT_TYPES` 之上的折叠层：每条 surface 事件携带
`surfaceOp: "append" | {op:"replace", startSeq, endSeq}` 与 `sourceEventSeqs`（:179-331）。
**append-only 日志是真相，surface 是"当前模型该看见什么"的有序视图**——compaction、
消息编辑、runtime-context 替换都通过 replace 阴影化旧区间实现，可审计、可回滚。
`deriveMessages()` 从 surface 冻结派生请求消息数组。

### 5.3 消息数据结构（dsh-llm/lib/types/message.d.ts:100-165）

```jsonc
{
  "id": "uuid",                    // 跨一切表示边界稳定
  "role": "system|developer|user|assistant|tool",
  "content": [ { "type": "text", "text": "…" } ],   // ContentBlock[]
  "source": { "kind": "user" | "model" | "tool" | "system-prompt", … },
  "toolCallId": "…",               // 仅 tool 角色
  "isError": true                  // 仅 tool 角色
}
```

assistant 事件额外携带 `{turn, step, message, usage?, interrupted?, stream}`（紧凑流重放）。

### 5.4 持久化与恢复

- **jsonl**（dsh-session-persistence-jsonl，3642 行）：`.jsonl` / `.jsonl.zstd`；
  格式版本迁移链 `dsh-session-format-v0-to-v1 … v3-to-v4`（当前 v4）；
  原子写（dsh-atomic-write）、文件租约（lease）、win32 特殊处理。
- **恢复**：`Session.fromRestore` 校验信封/序列连续性/surface 合法性 →
  `SessionPreparation` + 尾部修复 `openTurnClosers`（见 ②.5）。
- **fork**：子会话以父日志前缀为 seed + `session/end-seed` 标记 + `inheritedEventCount`；
  继承区间外才是子会话自有事件（:1341-1428）。
- **projection**（dsh-session-projection）：注册式 fold 单元
  `{key, stateVersion, stateSchema, init, apply(state,event), wire}`——inbox、turnBoundary、
  sandboxMode、llmRetry、todos…全部策略状态都住在日志里，**日志即唯一存储**，
  没有旁路 config store（dsh-sandbox-policy:20-32 明确陈述此哲学）。

---

## ⑥ 子代理（dsh-subagent / dsh-tool-subagent）

两种 in-process 后端，同一 `ctx.subagents.registerProvider` 接口：

| | spawn（dsh-subagent-spawn-in-process） | fork（dsh-subagent-fork-in-process） |
|---|---|---|
| seed | 无（全新会话） | 父日志**最后一个 `turn/end` 前缀**（在飞 turn 不平衡不可重放，:15-27） |
| inheritsParentContext | `false` | `true` |
| agentPreset 能力 | ✅ 可独立选 preset | ❌ 继承父组合 |
| 通信 | 提示词自包含 | 提示词自包含 + 继承上下文 |

- **continuable 模式**：子代理初始任务尾部追加回信指引（dsh-subagent:476）：
  "Your parent agent id is … Before you finish, send your result to that agent with
  `send_message({agent_id, message})`. The parent shares your workspace but does not
  automatically receive your transcript, tool output, or reasoning."
  子代理结束后由编排层补 settdement 消息（"finished and will do no further work unless
  you send it more"）；父代理用 `send_message` 续聊、`interrupt_agent` 打断。
- **深度限制**：`assertSubagentMaxDepth` / delegation 链（rootCallId 贯穿）。
- **结构化输出**：`outputSchema` 用 ④.1 的 JSON Schema 子集校验子代理最终文本。
- **模型选择治理**：调用方可传 provider/model/reasoning_effort，但受
  `subagent/model-selection-policy` 白名单约束（dsh-tool-subagent:88-107）。

---

## ⑦ 沙箱与文件策略（dsh-sandbox-policy / dsh-fs-observation-policy / dsh-sandbox*）

### 7.1 三级模式 + 会话级覆盖

```
read-only ─ workspace-write ─ danger-full-access     (SANDBOX_MODES, dsh-sandbox-policy:26)
```

- 会话内切换 = append 一条 `sandbox/mode` 事件（**开关即事件**，:38-41）；
  `effective = 已批准的 escalation > 会话覆盖 > 部署默认`（resolve，:128-138）。
- 策略文本注入 runtime-context（③.3 的 "Current DSH file policy…"），执行侧
  `ctx.sandboxPolicy.resolve()` 与提示侧读**同一份投影**，不漂移。
- 执行后端：dsh-sandbox-local（macOS Seatbelt 等本机执行器，556 行）等，
  每个后端保留自己的"执行方言"，策略语义统一。

### 7.2 升级（escalation）协议

模型在工具参数里显式请求 `sandbox_permissions + justification` → 执行前经
`approveEscalation` → `ctx.approval`（ask/never 策略，dsh-user-approval:37,153）→
用户批准后按最弱优先级并入门禁。拒绝/失败都以**标记回灌**模型：
`[sandbox: file access denied under <mode> mode]` + 升级提示（dsh-tool-bash:30-36）。

### 7.3 fs-observation-policy：先读后写 + 乐观并发（全文 97 行，纯事件无服务）

`ObservedStateGate`（dsh-fs-observation-policy）：

- `fs/observed` 事件记录权威观测（present 带 version / absent），WeakMap 按 session 隔离；
- `writeIntent`：观测过 present → `replaceIfVersion(观测版本)`（CAS 防覆盖他人修改），
  否则 `createIfAbsent`；
- `editIntent`：**未观测直接 throw `FS_NOT_OBSERVED`**（"edit requires reading … first"），
  确认 absent → `FS_NOT_FOUND`，present → 以观测版本为 CAS 基准。

这是"先读后写"从提示词约定升级为**机制强制**的范本：提示词里的行为要求
（③.3）与执行门禁（此处）互为犄角。

---

## ⑧ LLM 抽象（dsh-llm / dsh-llm-deepseek / dsh-llm-retry）

- **Adapter 注册**：`ctx.llm.registerAdapter(providers, adapter)`，一个 adapter 可占多个
  provider 路由，重复注册抛 `DUPLICATE_ADAPTER`（dsh-llm:1842-1875）；实现：
  dsh-llm-deepseek（OpenAI 兼容流，2327 行）、dsh-llm-pi-ai、dsh-llm-replay
  （从会话日志确定性重放，测试用）、dsh-llm-mock-server。
- **prepareCall**（:2220）：请求前解析 route → `{config, stream(request), adapterDefaults,
  context{contextWindow}, systemPromptUpdate, retryPolicy}`——agent-loop 用
  `systemPromptUpdate:"in-history"` 决定系统提示投放策略，用 `retryPolicy` 交给重试插件。
- **流式装配**：`BlockAssembler` 把 chunk 流装配为 text/reasoning/tool-call 块，
  `interruptedBlocks()` 产出中止安全前缀；`AssistantStreamAccumulator` 产出可持久化紧凑流。
- **错误归一**：HarnessError 携带稳定 `code`（RATE_LIMIT…），上下文超限用多条正则把
  各家 provider 文案归一为 `CONTEXT_WINDOW_EXCEEDED`（dsh-llm-deepseek 内），驱动
  compaction 的溢出路径。
- **dsh-llm-retry**（186 行全文可读）：挂 `agent/request-error`；策略
  `{maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio}` 或 `always` 模式；
  **每次重试先落 `llm/retry` 事件再可取消等待，等待后落 `llm/retry-started`**（:141-148）
  ——重试状态经 `llmRetry` projection 恢复，`step/start` 与 `turn/end` 重置计数（:94）；
  尊重 `providerRetryAfterMs`（超过 maxDelayMs 时 normal 模式放弃）。

---

## ⑨ Web GUI 架构（dsh-web-* / dsh-client-* / dsh-cordis-client-runner）

```
Node 进程 (dsh web)                                浏览器
┌───────────────────────────────┐        ┌──────────────────────────────┐
│ host-webserver (HTTP+upgrade) │        │ dsh-web-frontend (vite dist) │
│  · 静态: host-frontend-static │◄──────│  · dsh-client-web shell       │
│  · /api/* JSON RPC            │  HTTP  │  · cordis-client-runner:      │
│  · /api/remote.mux (WebSocket │◄─────►│    浏览器侧 cordis 运行时，    │
│    Typert Remote 流多路复用)   │   WS   │    插件跑在浏览器，声明式服务  │
│ api-gateway → controllers     │        │    经 host.call RPC 代理到宿主 │
│  (session/job/terminal/       │        │  · client-ui-* ~60 个 React 包│
│   workspace/settings/...)     │        │    (chat/tool渲染/审批/侧栏…)  │
│ cordis 宿主：agents/llm/tools │        └──────────────────────────────┘
└───────────────────────────────┘
```

- **一元 RPC**（dsh-client-connection/client.browser.js:1209-1238）：
  `POST /{channel}/{endpoint}`，信封 `{type:"client-request", rpcId:uuid, method, payload}`
  ↔ `{type:"server-response", rpcId, result}`；二进制响应用 multipart 字段 + 路径寻址
  attachments 还原 `Uint8Array`（:1240-1276）。
- **流**：WebSocket 复用通道 `/api/remote.mux`（dsh-api-gateway:132-134），逻辑流帧
  `{type:"item"|"cancel"|"end", streamId}`，`$events` 端点把宿主 cordis 事件推给客户端
  （`$events/result` HTTP RPC 回执流量控制，:140-150）。
- **cordis-client-runner**（7446 行）：浏览器里的受限 cordis——`ctx` 是白名单 Proxy，
  服务访问受插件 `inject` 声明门控；`Remote` 装饰的方法走流式 RPC；
  宿主禁止返回 cordis Context 对象（:225-227 守卫）。**插件代码可以原样在浏览器运行，
  只把服务调用折算成 RPC**——这是 DSH 前后端同构的关键。
- **web-app**：启动 glue（解析 dist、`DSH_WEB_URL` 环境变量、默认浏览器拉起、
  非 loopback 绑定告警、publicUrl 覆盖），presets/ 提供 standard/minimal/ptc 组合补丁。
- **HMR**：dsh-client-hmr + dsh-hmr 支持插件热替换（UI 插件免刷新）。

---

## ⑩ 其他值得注意的思想

- **compaction**（dsh-compaction-basic，1027 行）：`thresholdRatio 0.8`（上下文压力
  阈值）+ `retainRatio 0.16`（逐字保留尾部）；摘要模型独立路由；事件
  `compaction/start|summary|prune|end`；**摘要作为替换 user 消息经 `surfaceOp: replace`
  阴影化旧区间**（:651-652），日志不删、面收敛；溢出触发的 compaction 在
  `replaceGeneration` 变化时从新面重试（:869-883）。另有 tool-result-pruner 单独修剪
  巨型工具输出。
- **goal 轮次驱动**（dsh-goal / dsh-goal-round-driver）：goal 状态（objective/phase/
  maxGoalRounds/roundsStarted）经 `goal/change` 事件与投影维护；agent 空闲且 goal 仍
  active 时，driver 注入 `<goal_round>` 结构化 followup（"Round: N/M … Before claiming
  completion, gather evidence…"，goal-round-driver:9-19）实现**自动多轮续跑**；
  "blocked" 需连续 N 轮同一阻塞条件才允许上报。
- **schedule**：reminder 的完整时序语义（after_seconds/at/every_seconds/daily/weekly/cron，
  时区缺页跳过、重复时刻只发一次、崩溃后补发最新一次）。
- **jobs**：统一后台作业注册表（bash 进程、workflow 等），pull-source 环形输出 +
  spill 文件 + 终态 outcome 归一（completed/failed/killed + detail）。
- **skill 系统**：dsh-skill 提供目录与 `skill` 工具（按名加载技能全文），
  dsh-skill-filesystem 扫描磁盘技能，dsh-agent-preset 直接随包携带 4 个技能
  （agent-experience、cordis-plugin-development 等，skills/ 目录）。
- **permission presets**（dsh-client-ui-permission-presets + `permission/preset` 事件）：
  预设化的一揽子工具审批策略。

---

## ⑪ 精髓提炼：tim-harness（纯浏览器实现）应继承 / 应舍弃

### 11.1 应继承（按价值排序）

1. **事件溯源会话 + surface 投影**：append-only 日志为唯一真相；模型可见面是带
   `append/replace + sourceEventSeqs` 的投影。compaction/编辑/上下文替换全是 replace——
   可审计、可重放、可 fork。浏览器落地：日志写 OPFS/IndexedDB（每事件一行 jsonl 语义），
   surface 是纯内存 fold，天然适配。**这是整个 DSH 最值得整体搬运的骨架。**
2. **系统提示双通道**：稳定 section（中心化 order、作用域影子覆盖、严格 `{{var}}` 校验）
   + 动态 runtime-context 快照（"supersedes earlier snapshots" 头部、变化才追加）。
   纯浏览器实现照样受益：稳定段利于 provider 端缓存计费，动态段（当前时间/时区/
   虚拟工作目录/沙箱策略）不必重写系统提示。
3. **先读后写从提示约定升级为机制**：fs-observation-policy 的观测门（WeakMap per
   session + `FS_NOT_OBSERVED` + `replaceIfVersion` CAS）在虚拟 FS 上几乎零成本复刻，
   且把"模型会不会瞎写"从概率问题变成结构问题。
4. **工具协议的 fail-closed 细节**：JSON Schema 强制子集；参数 deepFreeze + 无损 JSON
   校验；并发分类"精确 true 才并行"；错误物化为 `isError` 结果（带稳定 code）而非炸循环；
   abort 给未启动调用补合成结果保日志配平。浏览器版把"进程门禁"换成"Worker/领域门禁"，
   这些纪律原样适用。
5. **`tools/pre-execute` waterfall 审批 seam**：allow/ask/deny 单一介入点 + 结构化
   ask_user_question——浏览器内审批就是一次模态交互，协议可以照抄。
6. **结果回灌的三条通道**：tool/result（面内）、`additionalContexts`→next-step inbox
   （step 边界 steering）、`concludeTurn`——语义清晰，UI 联动容易。
7. **durable inbox（next-turn/next-step）**：用户随时插话/转向且重启不丢；
   next-step 让 steer 不打断在飞的 LLM 调用，边界处并入。
8. **重试与恢复的可重放措辞**：llm/retry 先落事件再等待；崩溃尾部修复给模型的
   "outcome unknown → 按幂等性决定是否重试"指引文案，直接抄。
9. **goal-round 驱动 + compaction-as-replacement**：自动多轮与上下文收敛都建立在
   surface replace 原语上——先有 1 才有它们，浏览器版免费获得。
10. **spawn/fork 子代理 + continuable 回信协议**：`send_message` 指引文案与
    settlement 消息模式，在浏览器多标签/多 Worker 场景同样成立。

### 11.2 应替换（映射表）

| DSH（Node） | tim-harness（浏览器） | 说明 |
|---|---|---|
| bash + 本机沙箱执行器 | QuickJS/WASM 沙箱或 Web Worker 内 JS 解释器 | `[exit code: N]` 纪律保留；"命令"语义换成受限 JS；超时→job 语义用 Worker.terminate |
| 本地 FS（dsh-fs-local） | 虚拟 FS（OPFS/内存，zip 导入导出） | read/write/edit/glob/grep 工具面不变；观测门 + 版本 CAS 原样适用 |
| 进程隔离（PTC/confined process） | Worker/Realm 隔离（`materializeFromRealm` 的纯 JSON 物化直接可用） | workflow 的 vm realm 方案几乎是为浏览器写的 |
| approval 走 GUI websocket | 浏览器内模态（同一 ask 语义） | `tools/pre-execute` waterfall 不变 |
| host-webserver + api-gateway | 页面内直连（或 SharedWorker 作"宿主"） | cordis-client-runner 的"浏览器插件 + 声明式服务代理"模式可保留为前端架构 |
| jsonl 落盘 + zstd | OPFS 追加写 / IndexedDB | 保留"一事件一记录 + ignorable 信封"的前向兼容设计 |
| session-projection 注册 fold | 同构 | 纯函数 fold 在浏览器无差别 |

### 11.3 应舍弃

- 终端/PTY/tmux 生态（dsh-terminal*、dsh-tmux-context、pwsh 系列）——除非做 xterm.js
  玩具；本地凭证（credentials-local）、MCP filesystem、ACP 对接、tmux 上下文注入。
- 本机 Seatbelt/sandbox-local 执行器细节与 win32 特例——浏览器有自己的隔离原语。
- "shell 环境继承/scrubbedParentEnv"一整族问题在浏览器不存在，别带进来。
- cordis 宿主的 HMR/插件市场等 Node 工程设施——按需以 ESM 动态 import 重设计。

### 11.4 一句话总结

DSH 的本质是：**把"和模型的一轮协作"做成一条可重放的事件日志（会话即存储），
把"能对模型做什么"做成一条带单一审批缝的 fail-closed 工具管线，
把"模型该知道什么"拆成稳定提示 + 易变快照双通道**——这三件事与运行环境无关，
全部可以平移进浏览器；需要替换的只是执行后端（进程→Worker/VM、FS→虚拟 FS）。

---

### 附：本笔记引用的关键文件清单

| 主题 | 文件（相对 `dsh/node_modules/@deepseek-ai/`） |
|---|---|
| Agent Loop | dsh-agent-loop/lib/index.js（ReactLoopAgent:747、executeToolCalls:506、AssistantStreamAttempt:355、Inbox:70、SystemPromptProjection:239） |
| 系统提示 | dsh-system-prompt/lib/index.js（SECTION_ORDERS:10、SystemPrompt:213、renderPrompt:117、joinContextSections:136） |
| 工具协议 | dsh-tools/lib/index.js（defineTool:838、ToolRuntime:2760、prepareExecution:3310、executionMode:3153） |
| 会话 | dsh-session/lib/index.js（KNOWN_SESSION_EVENT_TYPES:79、Surface:146、Session:1324、openTurnClosers:733）；dsh-session-persistence-jsonl/lib/index.js |
| 子代理 | dsh-subagent-fork-in-process/lib/index.js、dsh-subagent-spawn-in-process/lib/index.js、dsh-subagent/lib/index.js:476、dsh-tool-subagent/lib/index.js |
| 沙箱 | dsh-sandbox-policy/lib/index.js（SANDBOX_MODES:26、renderPolicyContext:70、resolve:128）；dsh-fs-observation-policy/lib/index.js |
| LLM | dsh-llm/lib/index.js（createMessage:37、LlmRuntime:1766、prepareCall:2220）；dsh-llm-retry/lib/index.js |
| Web | dsh-client-connection/lib/client.browser.js:1158-1276；dsh-api-gateway/lib/index.js:130-150；dsh-cordis-client-runner/lib/client.js；dsh-web-app/lib/index.js |
| 其他 | dsh-compaction-basic/lib/index.js；dsh-goal-round-driver/lib/index.js；dsh-tool-bash/lib/index.js:340-530；dsh-tool-fs/lib/index.js；dsh-tool-todo/lib/index.js；dsh-agent-instructions/lib/index.js；dsh-workflow-ptc/lib/index.js（内嵌 guest 源码） |
