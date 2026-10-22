# JetBot 纯浏览器 AI 助手实践研究

> 研究对象：`/Users/hongxin/Workspace/claude-ai-playground/JetBot/jetbot/`（本地开发版，与 GitHub `hongxin/JetBot` 同源）
> 研究方式：只读源码逐模块分析，全部结论附真实文件路径。目的是为 `tim-harness`（纯浏览器运行的 harness 平台）提炼可复用工程经验。

---

## ① 总览与技术栈

JetBot 是一个**零后端**的浏览器 AI 编码助手：React UI、Agentic Loop、IndexedDB 虚拟文件系统全部跑在一个标签页里，LLM 调用由浏览器 `fetch()` 直连 API 提供商。`npm run build` 产出纯静态文件，可部署到任意静态主机（含 GitHub Pages）。

| 层 | 技术 | 证据 |
|---|---|---|
| UI | React 19 + Tailwind CSS 4 | `jetbot/package.json` |
| 状态 | Zustand 5（4 个 store） | `jetbot/src/store/` |
| 构建 | Vite 8 + TypeScript 5.9 | `jetbot/vite.config.ts` |
| 存储 | IndexedDB（`idb` + 原生封装）+ localStorage | `src/tools/VirtualFS.ts` / `src/lib/db.ts` |
| Markdown | marked + highlight.js（core 按需注册语言） | `src/lib/markdown.ts` |
| LLM | 统一 OpenAI 兼容 REST 协议（单一客户端） | `src/llm/OpenAICompatibleClient.ts` |

运行时依赖仅 **7 个**：`clsx`、`highlight.js`、`idb`、`marked`、`react`、`react-dom`、`tailwind-merge`。无 UI 框架、无路由、无状态机库——循环、权限、上下文管理全部手写，这证明浏览器 harness 的核心复杂度在架构而不在依赖。

目录职责划分（`docs/architecture.md` 有完整索引）：

```
src/
├── agent/      Agent.ts(725行) / AgenticLoop.ts / ContextManager.ts / SystemPromptBuilder.ts
│               + SessionStore / SessionIndex / MemoryStore / SkillDistiller（长期记忆层）
├── llm/        OpenAICompatibleClient.ts（唯一 LLM 实现，293 行）
├── tools/      ToolRegistry / Permission(三级权限) / VirtualFS + builtins/（12 个工具）
├── store/      configStore / chatStore / agentStore / cosmosStore（zustand）
├── components/ ~20 个 React 组件（ChatPanel、MessageBubble、ToolCallBlock、PreviewPanel…）
├── scheduler/  浏览器内定时任务（interval/cron/once + heartbeat）
├── env/        RuntimeDetector：能力探测 → 决定加载哪些工具
└── lib/        db / cors / markdown / logger / i18n / storage
```

---

## ② LLM 直连与流式

### 2.1 Provider 与配置存储

单一 `OpenAICompatibleClient` 覆盖所有 provider，差异只在 baseUrl/model 预设（`src/store/configStore.ts:18-24`）：

```ts
const PRESETS: Record<string, ProviderPreset> = {
  openai:   { provider: 'openai',   baseUrl: 'https://api.openai.com/v1',        model: 'gpt-4o' },
  deepseek: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',      model: 'deepseek-v4-flash' },
  zhipu:    { provider: 'zhipu',    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5' },
  ollama:   { provider: 'ollama',   baseUrl: 'http://localhost:11434/v1',        model: 'qwen3.5:27b' },
  custom:   { provider: 'custom',   baseUrl: '', model: '' },
};
```

- **可直连的 provider**：DeepSeek、智谱、Ollama（本地无跨域问题或 CORS 友好）；OpenAI 官方端点浏览器直连会被 CORS 拒绝，必须走代理。
- **存储**：整个配置（含 **apiKey 明文**）以 JSON 存 localStorage 单键 `jetbot-config`（`src/store/configStore.ts:58-70`）。IndexedDB 不存密钥，只存会话/记忆/技能/文件。明文 localStorage 是最明显的安全短板。
- Ollama 免 key（`KEY_OPTIONAL_PROVIDERS`），Settings 里通过 `/v1/models` 自动发现模型。

### 2.2 CORS 三级方案

1. **URL 包装器**（`src/lib/cors.ts`，仅 6 行）：配置了 proxyUrl 就把目标包成 `${base}/proxy?url=...`。
2. **生产**：Cloudflare Worker 反代（`worker/cors-proxy.ts`）——处理 `OPTIONS` 预检、注入 `Access-Control-Allow-*`、流式透传 `response.body`。
3. **开发**：Vite 中间件插件 `devCorsProxy` 完整复刻 Worker 行为（`vite.config.ts:8-76`），保证 dev/prod 行为一致。
4. **兜底**：`http_get` 工具内置公共代理链 allorigins → corsproxy.io（`src/tools/builtins/httpGet.ts:7-10`），按"用户代理→直连→公共代理"顺序尝试。

默认值很讲究（`configStore.ts:81-86`）：dev 下 proxyUrl 默认取当前 origin（dev server 有 `/proxy`），**生产默认为空**（直连），避免向静态宿主 POST 得 405。

### 2.3 SSE 流式解析（手写，不依赖 SDK）

`OpenAICompatibleClient._handleStream`（`src/llm/OpenAICompatibleClient.ts:166-284`）核心逻辑：

```ts
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
// 30s 空转超时：Promise.race(reader.read(), reject('stream_idle_timeout'))
while (true) {
  const { done, value } = await readWithTimeout();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';              // 半行留到下一 chunk —— 关键细节
  for (const line of lines) {
    if (trimmed === 'data: [DONE]') { streamDone = true; break; }
    if (!trimmed.startsWith('data: ')) continue;
    const parsed = JSON.parse(trimmed.slice(6));
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.reasoning_content) onReasoningStream(delta.reasoning_content); // DeepSeek 思考流
    if (delta?.content) onStream(delta.content);
    // tool_calls 增量按 index 聚合（见下）
  }
}
```

- **跨 chunk 半行处理**：`buffer = lines.pop()`，任何按行协议都必须做。
- **工具调用流式聚合**：`delta.tool_calls` 的 `function.arguments` 是分片到达的，用 `Map<index, {id, name, argChunks[]}>` 累积，结束时 `argChunks.join('')`（`OpenAICompatibleClient.ts:242-252`）。
- **思考链**：`reasoning_content` 单独回调，与正文分轨。
- **usage/finish_reason** 在流尾 chunk 捕获。
- 防御：`response.body` 为 null 时回退非流式 JSON（changelog `86be80d`）。

### 2.4 工具调用（function calling）

请求侧：有 tools 时带 `tools` + `tool_choice: 'auto'`（`OpenAICompatibleClient.ts:59-62`）。响应侧统一规整为 `{id, name, arguments(JSON 字符串)}`。DeepSeek 专属采样参数：`temperature=1.0 / top_p=1.0 / thinking:{type:'enabled'}`（`:50-57`）。

### 2.5 错误与重试

- 分类错误 `LLMError { code: AUTH|RATE_LIMIT|NETWORK|SERVER|TIMEOUT, retryable }`（`src/types/llm.ts:29-39`）。
- **只重试网络级失败**（fetch 抛异常），最多 3 次、指数退避 `500*2^n`（`OpenAICompatibleClient.ts:88-101`）；HTTP 401/403 不重试直接抛 AUTH，429/5xx 标记 retryable 交给上层。
- 整体超时用 AbortController：普通 120s，thinking 模式 300s。
- 流式读取 30s idle timeout 后 `reader.cancel()`，**返回已收到的部分内容**而不是抛错——已收 delta 不浪费。

### 2.6 Token 计量

双轨：精确值来自 API `usage.prompt_tokens + completion_tokens`（流尾 chunk），由 AgenticLoop 累计进 `LoopStats.totalTokens`（`AgenticLoop.ts:112-114`）；估算值 `Math.ceil(chars/4)` 存在每个 Turn 上（`ContextManager.ts:195`），用于 compaction 触发与 `/status` 展示。

---

## ③ Agentic Loop

### 3.1 驱动与终止

纯 async while 循环（`src/agent/AgenticLoop.ts:74-222`），无生成器无状态机：

```ts
while (iterations < this.maxIterations) {           // 上限 100
  if (this.abortController.signal.aborted) return ...; // 用户中止
  response = await llm.complete({ messages: context.toMessages(systemPrompt),
                                  tools: toolSchemas, tool_choice: 'auto', stream }, onStream, onReasoning);
  context.addAssistantMessage(response.content, reasoning, toolCalls);
  if (response.toolCalls.length === 0) return final;  // 终止条件①：无工具调用
  for (const tc of response.toolCalls) { /* 权限→执行→回灌 */ }
}
// 终止条件②：maxIterations；③：熔断器
```

- 每轮通过 `onEvent(AgentEvent)` 向 UI 广播 `llm:request / llm:chunk / tool:start / tool:result / circuit_breaker` 等 14 种事件（`src/types/message.ts`），**循环本身零 React 依赖**。
- `abort()` 用 AbortController，LLM 请求与工具执行前都检查信号。

### 3.2 失败分类与熔断（最值得抄的部分）

两级计数器（`AgenticLoop.ts:23-34, 57-68`）：

- `FATAL_LIMIT = 3`：连续 3 次"致命"失败（unknown tool / Malformed JSON / LLM API 错误）→ **circuit breaker，终止循环**。
- `RECOVERABLE_LIMIT = 6`：连续 6 次"可恢复"失败（权限拒绝、普通工具错误）→ 不终止，而是**注入策略提示**让模型换路：

```ts
context.addAssistantMessage('Hint: You have encountered many recoverable errors. Consider switching your exploration strategy...');
```

- **重复错误检测**：记录 `recentToolErrors`，同一工具+同一错误再次出现时，在错误结果后追加：
  `⚠ This is the same error you got before (Nx). Do NOT retry with the same parameters...`（`AgenticLoop.ts:187-196`）——直接对模型喊话，比静默重试有效得多。
- API 校验类错误（`Invalid assistant message`）**不写入上下文**，避免污染重试（`:104-109`）。

### 3.3 工具结果回灌

`context.addToolResult(tc.id, result, isError, toolName)` → `toMessages()` 产出 `{role:'tool', content, tool_call_id}`。结果硬截断 3072 字符（`:179-181`）。Malformed JSON 参数时不执行、直接回灌解析错误说明，让模型自己修。

### 3.4 上下文管理（ContextManager，`src/agent/ContextManager.ts`）

三层策略，比"简单截断"精细：

1. **按模型预算**：`getBudgetForModel()` 给 deepseek-v4 128k / glm 128k / qwen 24k / 默认 30k，含 `compactThreshold=0.8` 与 `maxTurns`（`:16-33`）。
2. **滑窗 + 孤儿清理**：`trimTurns()` 超出 maxTurns 从头删，再删开头孤儿 tool 消息（tool 结果必须紧跟带 tool_calls 的 assistant，否则 API 报错）（`:211-221`）。
3. **Smart masking + compaction**：超阈值时 `compact()` 把**前一半** turn 的各 part 截到 200 字符（保留结构，不丢轮次）；平时只保留**最近 4 条**工具结果全文，旧的非错误结果替换为 `[Result masked - N bytes]`——但 `list_dir/search_text/glob` 这类"项目地图"结果 ≤2000 字符时**豁免**，作为持久上下文保留（`:4-7, 149-158`）。

另有消息合法性防御：assistant 消息必须含 content 或 tool_calls，空则补 `' '`（`:69-74, 138-142`，changelog `05970da` "防止空 assistant 消息污染上下文"）。`toMessages()` 带脏检查缓存。

### 3.5 系统提示组装与增强

`SystemPromptBuilder` 用带优先级的 section 拼 prompt：identity(jetbot.md 灵魂文件, p10) → environment(运行时能力画像, p20) → tools(p30) → memory(p35) → sessionRecall(p36) → skills(p40)（`src/agent/SystemPromptBuilder.ts:67-70`）。灵魂文件混合加载：编译期 `import jetbot.md?raw` 作默认 → 首次种子写入 VirtualFS → 之后用户可用 agent 自己的 `edit_file` 修改它（`:36-57`）。跨会话记忆（MemoryStore 2000 字符）与历史会话召回（SessionIndex 1500 字符）注入 prompt 而非消息流（`Agent.ts:146-153`）。

---

## ④ 虚拟文件系统（IndexedDB）

### 4.1 数据模型：扁平 path 键 + parent 索引

`src/tools/VirtualFS.ts:6-14, 30-35`：

```ts
interface FileEntry {
  path: string;        // 主键，如 '/workspace/snake.html'
  content: string;     // 纯文本
  type: 'file' | 'directory';
  parent: string;      // 父目录 path，建了索引
  createdAt/updatedAt/size
}
// openDB('jetbot-fs', 1) → createObjectStore('files', { keyPath: 'path' })
//                          .createIndex('parent', 'parent')
```

目录不是树结构，是**普通条目**：`listDir(path)` = `getAllFromIndex('files','parent',path)`。写文件时自动递归 `mkdir` 父目录（`writeFile:54-72`）。初始化保证 `/workspace` 存在。**没有树缓存**——每次列目录查索引，简单正确；规模小（浏览器内项目）够用。

降级：IndexedDB 不可用（隐私模式）时整体切换到内存 `Map`（`:36-39`）。

### 4.2 读写与搜索

- `search()`：全量 `getAll('files')` 后逐文件逐行 regex 匹配，上限 100 条命中（`:110-129`）——O(N×行数) 暴力扫描，是这个规模下的正确取舍。
- `deleteFile` 目录非空时拒绝删除（无递归 rm）。

### 4.3 导入导出（FileBridge，`src/components/FileBridge.tsx`）

- **导入**：`<input type=file multiple>` + 全窗口 DropZone 拖拽 → `file.text()` → `fs.writeFile('/workspace/'+name)`。只支持文本。
- **导出**：`export_file` 工具 / `/export` 命令 dispatch `jetbot:export` CustomEvent → `ExportListener` 用 `Blob + URL.createObjectURL + <a download>` 触发下载（`:9-27`）。
- **关键解耦**：工具层（纯 TS）与 UI 层（React）通过 document CustomEvent 通信，工具不 import 任何 React 代码。

### 4.4 第二个 IndexedDB：结构化持久层

`lib/db.ts` 管理 `jetbot` 库（v4），5 个 store：`skills / session_meta / session_turns / session_index / memory`。初始化**带重试 + 版本自增**：开库后检查所有 store 是否齐全，缺则 bump version 触发 `onupgradeneeded` 重建，最多试 5 次（`lib/db.ts:35-78`）——这是踩坑后补的（changelog `e0659ec` "Robust IndexedDB init"）。会话崩溃恢复：`SessionStore.recoverTurns()` + `Agent.recoverCrashedSession()`。

---

## ⑤ 代码执行沙箱与预览

### 5.1 HTML 预览：iframe srcDoc + sandbox="allow-scripts"

生成的 HTML（如贪吃蛇游戏）通过 `render_html` 工具 → CustomEvent → `PreviewPanel` 渲染（`src/components/RenderPreview.tsx:117-126`）：

```tsx
<iframe key={active.id} srcDoc={active.html} sandbox="allow-scripts"
        className="w-full h-full border-none" />
```

- **srcDoc 而非 blob URL**：内容来自 LLM 生成字符串，srcDoc 最直接。
- `sandbox="allow-scripts"` **不含** `allow-same-origin` → iframe 是 opaque origin，脚本无法读父页 localStorage/IndexedDB（API key 所在），这是真正的安全边界。
- 不带 `allow-forms/allow-popups` 等，默认拒绝。代价：iframe 内无法 fetch 跨域资源（无 CORS 凭据）、无法用部分存储 API。
- 多预览用标签页管理；窄屏（<768px 或竖屏）切换为 snap 滑动分页（`App.tsx` `useIsNarrow`）。

### 5.2 js_eval：Function 构造器，**不是真沙箱**

`src/tools/builtins/jsEval.ts:63-71`：

```ts
const fn = new Function('return (async () => {\n' + code + '\n})()');
const result = await Promise.race([fn(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timed out (10s limit)')), 10_000))]);
```

- async 包装让模型可直接用 `await`；补丁 `console.log/warn/error` 捕获输出；输出截 8192 字符。
- **局限明确**：跑在主线程，能访问全部 DOM/fetch；10s 超时只是"放弃等待"，**死循环仍在烧 CPU**；注释自认 "slightly better isolation"。
- **没用 Web Worker**——全项目无 Worker（除 Cloudflare Worker 代理）。这是 tim-harness 最明显的升级点：Worker + `terminate()` 才能真正掐死失控代码。

### 5.3 shell_execute：模拟 shell

不是 shell，是命令解析器 → VFS 操作的白名单分发（`src/tools/builtins/shellExecute.ts`）：支持 `ls/cat/echo/pwd/mkdir/rm/grep/head/tail/wc`，自写引号感知 tokenizer，相对路径一律 resolve 到 `/workspace`。标 `dangerous` 权限。**对 LLM 的价值在于熟悉接口**——模型天然会 `cat`/`grep`，比学新工具省 token。

---

## ⑥ UI 架构（React）

### 6.1 四个 zustand store + 单向事件流

| Store | 职责 |
|---|---|
| `configStore` | LLM 配置 + localStorage 持久化 + 预设/校验 |
| `chatStore` | `UIMessage[]`、状态机（idle/thinking/executing_tool/waiting_permission/error）、pendingPermission、distill 提案 |
| `agentStore` | Agent 生命周期；**把 `AgentEvent` 路由到 chatStore/cosmosStore**（`src/store/agentStore.ts:71-179` 的巨型 switch） |
| `cosmosStore` | 力导向图可视化（派生视图，非事实源） |

关键链路：`AgenticLoop onEvent → agentStore switch → chatStore 更新 → React 重渲`。工具/UI 跨层通信用 document CustomEvent（`jetbot:render / jetbot:export / jetbot:distill:* / jetbot:memory:*`），实现工具层零 React 依赖。

### 6.2 流式渲染性能：rAF 批量合并

`chatStore.appendToAssistant` 用闭包缓冲 + `requestAnimationFrame` 合并 chunk，每个动画帧只 set 一次（`src/store/chatStore.ts:101-125`）——比逐 chunk setState 少一个数量级的渲染，值得原样抄。

### 6.3 权限对话框：Promise 桥

Agent 注入 `permissionConfirmFn`，返回 Promise；触发时把 `resolve` 塞进 store（`agentStore.ts:61-66`），`PermissionDialog` 点按钮调 `resolve('allow'|'deny'|'always')`。三级策略（`src/tools/Permission.ts:27-78`）：safe 永远自动放行；risky 问一次全会话记住；dangerous 每次都问；`/auto on` 时 risky 自动放行。纯同步 UI 状态机优雅地接进异步循环。

### 6.4 聊天流渲染

- Markdown：marked + highlight.js core（只注册 js/ts/py/json/bash/xml/css 七种语言，控制包体）（`src/lib/markdown.ts`）；自定义 renderer 输出带语言标签和 Copy 按钮的 `<pre>`；`dangerouslySetInnerHTML` 直插——**无 XSS 消毒（无 DOMPurify）**，模型输出可注入脚本，是明确风险。
- `MessageBubble`：思考中显示风火轮 spinner；`ReasoningBlock` 可折叠展示思考链；流式尾部 Braille 光标（`MessageBubble.tsx:96-163`）。
- `ToolCallBlock`：一行式摘要（`paramHint` 取 path/pattern/command 等关键参数、`resultHint` 取首个非空行），完成自动折叠、出错自动展开（`ToolCallBlock.tsx:33-55`）——工具卡片的"静默成功、喧哗失败"原则。

---

## ⑦ 工程化与规模

- **规模**：`src/` 80 个文件 + 1 个 worker，约 **10,300 行**（ts/tsx/css）。最大文件 `Agent.ts` 725 行（命令路由偏多，可拆）。
- **构建**：Vite 8；`base: '/JetBot/'` 适配 GitHub Pages 子路径；`server.host: true` 局域网可访问（手机调试）；changelog 有 CI → gh-pages 工作流。
- **dev/prod 代理同一套语义**：`vite.config.ts` 的 `devCorsProxy` 中间件复刻 Cloudflare Worker，`/proxy?url=` 两端一致（changelog `425ec5d`）。其中还沉淀了一个高价值 bug：**转发浏览器 `accept-encoding`（zstd）会导致上游返回 undici 解不了的压缩体、SSE 流"静默变空"**，必须剥掉该头（`vite.config.ts:39-46`，changelog `5327ff8`）。
- **质量实践**（changelog 可追溯）：工具参数校验 + 重复失败检测（`0c3358b`）、流崩溃兜底（`86be80d`）、空 assistant 消息防污染（`05970da`）、IndexedDB 健壮初始化（`e0659ec`）、模块化 logger、双语 i18n、ESLint 9 flat config。
- **设计文档**：`docs/design.md` 论证了浏览器可行性矩阵（IndexedDB/fetch/SW 在微信内置浏览器的支持度），`CLAUDE.md` 是方法论（观谋行验四阶段）而非工程规范。

---

## ⑧ 可复用结论（面向 tim-harness）

### 直接复用（抄走即可）

1. **`AgenticLoop` 的失败分类 + 熔断 + 重复错误警告**（`src/agent/AgenticLoop.ts`）——FATAL 3 次熔断 / RECOVERABLE 6 次注入策略提示 / 相同错误喊话，是浏览器端不稳定 LLM 下循环不失控的核心保险丝。
2. **手写 SSE 解析器**（`src/llm/OpenAICompatibleClient.ts:166-284`）——半行缓冲、`data: [DONE]`、tool_calls 按 index 聚合、reasoning_content 分轨、30s idle timeout、body null 兜底，一个不落全要。
3. **`ContextManager` 三层上下文策略**（`src/agent/ContextManager.ts`）——按模型预算 + 滑窗孤儿清理 + smart masking（近 4 条工具结果全文、项目地图工具豁免、compact 只压前半程），比截断丢弃好得多。
4. **`VirtualFS` 扁平 path + parent 索引模型**（`src/tools/VirtualFS.ts`）——169 行解决目录树，配合 FileBridge 的拖拽导入 / Blob 下载导出。
5. **iframe `srcDoc + sandbox="allow-scripts"` 预览**（`src/components/RenderPreview.tsx`）——opaque origin 隔离密钥存储，是浏览器 harness 预览面板的正确默认。
6. **权限 Promise 桥 + 三级策略**（`src/tools/Permission.ts`、`agentStore.ts`）——异步循环里的同步人审，接口极简。
7. **工具↔UI 的 CustomEvent 总线**（`jetbot:render/export/distill/*`）——工具层保持纯 TS，可独立测试。
8. **rAF 批量流式渲染**（`chatStore.ts:101-125`）、**dev/prod 双代理**（`vite.config.ts` + `worker/cors-proxy.ts`，含剥 `accept-encoding` 教训）、**IndexedDB 版本自增重建**（`lib/db.ts`）。

### 需要改进（不要照抄）

1. **js_eval 换 Web Worker**：现状 `new Function` 跑主线程、超时不终止代码（`jsEval.ts:63-71`）。tim-harness 应该 Worker + `terminate()` 硬杀 + 无 DOM 环境，预览仍走 iframe。
2. **API key 明文 localStorage**（`configStore.ts:68`）：至少换 IndexedDB + 可选 WebCrypto 加密；或 OPFS/Session Storage 分级。
3. **Markdown 无消毒**（`MessageBubble.tsx:136` `dangerouslySetInnerHTML`）：引入 DOMPurify 或换安全渲染器，LLM 输出是不可信输入。
4. **单 bucket 代理**：所有流量共用一个 proxyUrl；应按 provider 独立配置代理与超时。
5. **token 估算 chars/4 过粗**：中文场景低估明显，建议接入 tokenizer 或按 API usage 回填校准。
6. **`Agent.ts` 725 行**承担命令路由 + 调度 + 蒸馏：命令系统应拆独立模块。
7. **`http_get` 依赖公共 CORS 代理**（allorigins/corsproxy.io）：不可控且有隐私泄露面，企业场景必须去掉。
8. **无测试**：整个仓库没有单测；AgenticLoop/ContextManager 这类纯逻辑模块完全可测，tim-harness 应补。

### 一句话总结

JetBot 用 1 万行、7 个运行时依赖证明了"浏览器即 harness"在工程上完全成立；它的价值不在任何单个文件，而在**循环保险丝、上下文分层、CustomEvent 解耦**这三个模式——照抄这三样，其余按上述清单升级。

---

*附：核心文件路径速查*
`src/llm/OpenAICompatibleClient.ts` · `src/agent/{Agent,AgenticLoop,ContextManager,SystemPromptBuilder,SessionStore}.ts` · `src/tools/{ToolRegistry,Permission,VirtualFS}.ts` · `src/tools/builtins/{jsEval,renderHtml,shellExecute,httpGet}.ts` · `src/store/{agentStore,chatStore,configStore}.ts` · `src/components/{MessageBubble,ToolCallBlock,RenderPreview,FileBridge,PermissionDialog}.tsx` · `src/lib/{db,cors,markdown}.ts` · `vite.config.ts` · `worker/cors-proxy.ts` · `docs/{architecture,design,changelog}.md`
