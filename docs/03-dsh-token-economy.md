# DSH Token 经济与上下文管理机制深挖

> 研究对象：`/Users/hongxin/.nvm/versions/node/v22.19.0/lib/node_modules/@deepseek-ai/dsh/`（v0.2.1-rc.2）下 `node_modules/@deepseek-ai/` 各 `dsh-*` 包的编译产物 `lib/index.js`（含完整 JSDoc，注释质量极高，可直接引用）。
> 本文为 token 专题，与 [01-dsh-architecture-study.md](01-dsh-architecture-study.md) 互补：01 覆盖 cordis/agent-loop/session 架构，本文只挖"每一枚 token 从哪里来、到哪里去"。所有结论均附包路径 + 代码证据。

## ① 总览：token 流失点分析

一个 agent harness 的上下文预算被五类东西吃掉，DSH 对每一类都有专门机制（括号内为对应包）：

| 流失点 | 典型占比 | DSH 对策 | 机制性质 |
|---|---|---|---|
| 工具结果爆炸（bash/搜索输出） | 最大头 | 产出侧截断（output-retention + 工具自带预算）+ 会话侧修剪（tool-result-pruner）+ 溢写盘（spill） | 确定性、无模型 |
| 历史消息无限累积 | 随轮次线性增长 | 压缩 checkpoint（compaction-basic，80% 阈值触发） | 模型摘要 |
| 图片占位 | 单图数百~数千 token | 请求内 offload 最旧图（compaction-image-offload） | 确定性 |
| 重复失败循环（同参重试） | 隐性浪费 | 升级式提醒打断循环（repeat-tool-reminder） | 提示词 |
| 提示词全量注入 | 固定开销 | 分段注册表 + 按需 runtime-context 快照 + 增量 instructions（system-prompt / agent-instructions） | 结构性 |

一次工具调用产出到进入模型视野的完整 token 流水线：

```
工具执行
  → (1) 产出侧截断：TextRetainer/ItemRetainer（256KiB/250条/2000行…）+ spill 全量存盘
  → (2) 会话侧通用上限：spill-policy maxInlineTokens（opt-in，token 计价，头尾保留）
  → [写入 surface：tool/result 事件]
  → (3) 步间修剪：tool-result-pruner（>8192 码点 → 头4096+尾1024，pressure/overflow 前置）
  → (4) 压缩：compaction-basic（≥80% 窗口 → 摘要替换中段，尾部 16% 逐字保留）
  → (5) 请求投影：image-offload（最旧图 → 占位文本）
  → [发往 provider：system(稳定) + tools + messages + runtime-context 快照(尾部追加)]
```

每一层都比下一层便宜：前两层零模型成本且发生在消息落地之前；第 3 层只动历史；第 4 层才动用一次模型调用（且刻意复用前缀缓存）；第 5 层只改请求投影、不动日志。

关键设计哲学（贯穿全文）：

1. **计量先于治理**：所有阈值决策都经过 `ctx.tokenMeter`（dsh-token-meter）统一计价，绝不各算各的。
2. **事件溯源 + surface replace**：任何"删历史"操作都不是删除，而是 `surfaceOp: {op: "replace", startSeq, endSeq}` 阴影化替换，日志永久保留原始事件，可回放、可审计（见 ②.4）。
3. **缓存友好优先**：压缩摘要调用刻意构造成"原对话前缀 + 末尾一条指令"，复用 provider KV cache（见 ⑥）。
4. **分层降级**：产出侧截断（模型看到之前就发生）→ 会话侧修剪（替换历史节点）→ 摘要压缩（模型生成）→ 图片卸载（请求投影层，日志不变）。越早的层越便宜。

## ② compaction 体系

### 2.1 服务接口（dsh-compaction）

`dsh-compaction/lib/index.js` 只定义抽象骨架 `CompactionEngine`（cordis Service `ctx.compaction`），三个能力：

- `compactIfNeeded(agent, trigger, signal)`：自动触发，trigger ∈ `'pressure' | 'context-overflow'`（types/index.d.ts:25）。
- `compactNow(agent, signal)`：手动 idle 压缩（低于阈值也执行），走 `agent.runMaintenance()` 与驱动轮次互斥。
- `compactRegion(start, end, agent, signal)`：按 surface 位置强行压缩一段。

还导出两个关键工具函数（lib/index.js:21-93）：`toolPairingBalancedBefore/After(session, seq)` —— 用 WeakMap 缓存的"工具配对平衡"前缀和，保证**压缩切点永远不会切开 assistant 的 tool-call 与对应 tool/result**（未应答调用数必须为 0 才允许下刀）。缓存随 `surface.replaceGeneration` 失效重建。

### 2.2 默认后端（dsh-compaction-basic）：阈值与策略

`dsh-compaction-basic/lib/index.js:14-17` 给出默认值：

```js
const DEFAULT_THRESHOLD_RATIO = .8;   // 压缩触发 = 上下文窗口 × 0.8
const DEFAULT_RETAIN_RATIO = .16;     // 保留尾部 = 消息预算 × 16%
headroomTokens = 65536                // (line 63) 输出预留之外的安全余量
maxTokens = headroomTokens            // (line 64) 摘要调用输出上限（默认同 headroom）
compactionRetries = 1                 // (line 82) 一轮最多压缩 2 次（1+1）
maxOverflowRetries = 1                // (line 83) 溢出恢复每轮最多重试 1 次
```

精确阈值公式（`resolveCompactSpec`，line 124-147）：

```
messageBudget   = contextWindow − reservedCompletionTokens   // 输出与输入共享窗口
thresholdTokens = min(contextWindow × thresholdRatio,
                      messageBudget − headroomTokens)        // 双重保险取小
retainTokens    = messageBudget × retainRatio                 // 或绝对值 retainTokens
```

`reservedCompletionTokens` 取最近一次路由请求的 `maxTokens`（line 757-759）——即 DSH 把"输出预留"也从窗口里扣掉再算压力，避免"看似 80% 实际已爆"。支持 `modelPolicies: [{provider, model, ...同名字段}]` 按 provider/model 精确覆盖（line 94-111）。

**两个触发路径**（`_registerAutomaticCompaction`，line 834-888）：

1. **pressure**：监听 `agent/pre-step`（每步模型调用前）→ `measure().totalTokens >= thresholdTokens` 才动。先跑 toolResultPruner 修剪一遍再复测（line 941-946，两遍测量），仍超阈值才选区压缩；循环最多 `compactionRetries+1` 次，还不降就抛错。
2. **context-overflow**：监听 `agent/request-error` 且 `code === CONTEXT_WINDOW_EXCEEDED_CODE`。**绕过阈值与保留策略**（retainTokens=0，能压多少压多少），先 prune 再压缩，成功后返回 `{kind: "retry"}` 让 agent-loop 原样重发请求；失败但 surface 已有推进（replaceGeneration 变化）也重试一次。`overflowRetries` 按 agent 计数，收到 `assistant/message` 即清零（line 856-860）。

### 2.3 选区算法与摘要提示词

**选区**（`selectCompactableRange`，line 410-433）：从尾部向前累计 token 直到 ≥ `retainTokens` 得 `keepFromIdx`；再向前回退到第一个"工具配对平衡"的切点；区间 = `[firstIdx(跳过 surface 头部 system/message), keepFromIdx-1]`。**尾部 16% 逐字保留**，只有中间老历史被摘要。

**摘要提示词**（`COMPACTION_INSTRUCTION`，line 243-278，全文收录要点）：不是独立 system prompt，而是作为**最后一条 user 消息**追加在重放的对话之后。指令要求输出固定 8 段 Markdown：

```
## Primary Request and Intent    （原话引用用户目标）
## Key Technical Concepts
## Files and Code                （精确 path + 关键片段）
## Errors and Fixes
## Pending Jobs
## Current Work
## Next Step                     （唯一下一个动作，或 "(none)"）
## Critical Context              （决策与理由、约束、用户偏好、开放问题）
```

规则强调：保留精确路径/命令/错误串/标识符/数字/函数签名；忠实记录用户纠正；**不得提及这是压缩请求**；不得调用工具；若对话里已有 `<compacted-summary>` 块（上一次 checkpoint），合并去旧而非照抄。产物用 `<compacted-summary>...</compacted-summary>` 包裹，前置一段 `CHECKPOINT_PREAMBLE`（line 280）："这是自动生成的 checkpoint……当作既定背景，不要复述、不要致意"。

摘要调用（`summarizeWithLlm`，line 292-338）路由选择优先级：**显式配置的 summarizationProvider/Model > 最近一次真实路由的 provider/model > agent.options**——刻意用同一个模型摘要，因为前缀可以吃 KV cache（注释 line 238-242 明说）。`finish=max-tokens` 视为失败（截断的 checkpoint 不可用，line 362-366）；含图片输出直接拒绝。

**收敛校验**（`summarizeCompaction`，line 582-607）：摘要加框后的估算 token 必须 `< shadowedRouteTokenCount`（被替换内容的路由计价），否则抛"summary is not smaller"——保证压缩单调下降。

### 2.4 replace 阴影化：事务协议

一次压缩是一个**日志事务**（`compactSurfaceRegion`，line 450-522）：

1. 同步追加 `compaction/start` 事件 = **durable 锁**（未闭合的 start 使后续压缩抛 `busy`）。
2. 异步摘要期间校验稳定性：自动压缩要求 whole-surface 不变，手动压缩只要求 selected-span 不变（外部新增消息不失效，line 608-626）。
3. 摘要失败走 `compaction/summary-error` waterfall（image-offload 在这里挂恢复钩子）。
4. 提交：追加 `compaction/summary` 事件（含 `shadowedRange/shadowedSeqs/shadowedTokenCount` + 完整 summary + usage），再追加一条 `user/message` checkpoint，携带：
   ```js
   surfaceOp: { op: "replace", startSeq, endSeq },   // 阴影化整段
   sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
   source: { kind: "compact-checkpoint", compactionId, ... }
   ```
5. 追加 `compaction/end` 闭合；任何失败路径也保证恰好一次 end（带 errorChain）。

**日志永不删除**：被替换的原始事件仍在 jsonl 里，"删除"只发生在 surface（模型可见投影）上。回放时 `imageOffloadProjection` / meter 各自重演 replace。

### 2.5 会话内修剪（dsh-compaction-tool-result-pruner）

与摘要压缩互补的**无模型确定性修剪**。`lib/index.js:8-14`：

```js
PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n"
thresholdChars = 8192   // 超过才修
headChars      = 4096   // 保留头部
tailChars      = 1024   // 保留尾部
```

`pruneContent`（line 91-124）按 **Unicode 码点**（非 UTF-16 单元）切，保留块序，中间插 marker；约束校验保证 head+marker+tail ≤ threshold。`pruneSession`（line 137-191）遍历当前 surface 全部 `tool/result` 节点，每个超预算的：先追加 `compaction/prune` 事件（记录 `shadowedTokenCount` 供投影做 O(1) 减法），再 append 一条新的 `tool/result` 以 `surfaceOp replace [seq,seq]` 阴影化原节点。它是 compaction-basic 的**前置降噪**：pressure 与 overflow 两条路径都先 `pruneSession` 再测量（compaction-basic line 926-946）。

### 2.6 图片卸载（dsh-compaction-image-offload）

被动响应式：当路由（适配器）抛 `IMAGE_OFFLOAD_REQUIRED` 且带 `offloadImages: N`（"还需卸 N 张"）时，`offloadOldestImages`（lib/index.js:14-44）按**请求顺序从最旧开始**选 N 个未卸载图片出现位置（只扫 `user/message` 与 `tool/result`，assistant 输出不含输入图），记一条 `image/offload` 事件（不改消息本体）。投影层 `imageOffloadProjection`（line 97-121）在渲染请求时把选中 occurrence 标记 `offloaded: true`；序列化器把 offload 块替换为占位文本（dsh-llm/lib/index.js:581-585）：

```
[image omitted to fit request image limits; <图片身份>. <本地路径，可用 read_image 重看>.]
```

挂两个钩子：`agent/request-error`（重试请求）与 `compaction/summary-error`（摘要调用也带图时同样救回）。**旧图先扔**是明确的策略选择——越老的图越可能不再必要。

## ③ output retention / tool-result-pruner：产出侧节流

### 3.1 通用保留库（dsh-output-retention）

无 ctx、无事件的纯库（lib/index.js:1-32 文档明说"只回答保留/省略了什么"），两个 retainer：

- **`ItemRetainer({kind:'head', maxItems})`**：有序逻辑单元（glob 路径、grep 匹配、搜索来源）保前 N 个，`finish()` 返回 `{items, truncated, seen, kept, omitted:{kind:'exact',count}}`——**精确计数省略了多少**。
- **`TextRetainer({kind:'head'|'tail'|'headTail', maxBytes/headBytes/tailBytes})`**：面向字节流（bash stdout、web body），**滚动窗口内存有界**（prefix+tail+一个 chunk）；`finish()` 在 UTF-8 码点边界修剪截口，绝不产生替换字符；返回精确 `omittedBytes`。

配套措辞工具：`describeOmitted` 输出标准化的 `Omitted 3 items.` / `More bytes were omitted.`（unknown 时**绝不虚报数字**），`formatRetentionNotice` 拼装"省略声明 + 工具自述恢复指引（收窄 pattern / 读 spill 文件）"单行页脚。`truncateWithoutSplittingSurrogatePair` 保证 JSON 日志里不出现孤立代理项。

### 3.2 各工具的实际预算（产出侧第一道闸）

| 工具 | 预算 | 证据 |
|---|---|---|
| bash/terminal 结果 | `maxResultBytes = 256 KiB`（默认，尾保留 + spill 全量存盘 + `[output truncated; full output: <path>]`） | dsh-tool-terminal/lib/index.js:157,163；dsh-tool-bash/lib/index.js:134-137,244（工具描述里就告知模型"长输出截尾、全量有文件"） |
| grep | `grepMaxMatches=250` 条、每行预览 `2 000 B`（注释：对齐 Claude Code 默认）、glob `100` 条、searchMeta `64 KiB`、rawOutput `20 MB`（仅盘上）、stderr `64 KiB` | dsh-tool-fs-search/lib/index.js:33-58,889,1220-1227 |
| read | 默认/上限 `2 000` 行、单行 `2 000` 字符、总量 `50 KiB` | dsh-tool-fs/lib/index.js:17-19,212,1199-1201 |
| web search | `searchMaxResults=8` | dsh-tool-web/lib/index.js:848 |

fs-search 还演示了**工具主动 spill**：超预算时 `trySaveFormattedResult` 把完整格式化结果写 `ctx.spillStore`，行内只留截断版 + 恢复提示。

### 3.3 spill-policy：通用 token 上限插件（opt-in）

`dsh-spill-policy/lib/index.js`：单一配置 `maxInlineTokens`（**无默认值，不配置即禁用**，line 141-144）。挂在 `tools/post-execute`（prepend）拦截所有 accept 的工具结果（`read` 工具除外，line 239；PTC 子调用仅当含图时处理，line 242）：

1. 用 token-meter 同款 `estimateContent` + 路由 `imageRequestPricing` 给整段结果计价（图 = visualTokens + 描述文本），≤ maxInlineTokens 直接放行。
2. 超限则把**全文（图转为 `[Image: path; mediaType; WxH. Use read_image to view it.]` 文本行）**写入 spillStore，行内保留 head+tail 各半预算（`retainContent`，二分 `fitText` 找不超价的最大连续文本，图整块取舍不切半），中间插 `

[...]

`，尾部追加 notice：`(Omitted N bytes. Omitted 2 images. Full formatted result stored at: <path>. Use read with offset/limit, or grep this path to search within it.)`。
3. 全程 best-effort：任何失败（无 spillStore、notice 本身超预算）保留原文并 warn（line 232-235）。

也挂 `tools/ptc-dispatch-log`，给 PTC 调度日志副本同样设限。PTC 剥离图片后原文以 `additionalContexts`（source `ptc-mode`）补投（line 246-249）。

## ④ spill 机制：三件套

**spill = 把放不进上下文的完整内容卸载到外部存储，给模型一个可按需取回的定位符。** 与"截断丢弃"不同，spill 是无损的、可恢复的。

- **dsh-spill**（seam）：`SpillStore` 抽象服务，唯一方法 `saveText({owner:{sessionId}, source:{toolName,callId,label}, suggestedName, content})` → `{locator, bytes, retrievalHint}`。文档（lib/index.js:42-51）规定：内容**逐字**持久化；存储按 session 隔离；拒绝即由调用方降级。
- **dsh-spill-local**（backend）：文件在 `<root>/session-<sha256(sessionId)前12位>/<6字节随机hex>-<安全编码名>.txt`，0600 权限独占写（`wx`），根目录 0700；名字编码 `encodeSegment` 是**单射**转义（`~XXXX`），防路径穿越（lib/index.js:50-105）。启动时一次性清扫：默认根 `/tmp/dsh-spill-XXXXXX` 精确形状匹配，`cleanupPeriodDays=30`（默认）过期删除，空 session 目录与可空默认根整删（line 116-123,469,482-485）。`retrievalHint` 固定为 "Use read with offset/limit, or grep this path to search within it."（line 566）。
- **dsh-spill-policy**（策略）：见 ③.3，把 seam 接到工具结果管线上。

token 视角的意义：spill 把"一次性大结果"从上下文移到盘上，行内只留头尾 + 精确定位符；模型需要时自主 `read`/`grep` 取回——**按需分页代替常驻**。

## ⑤ token meter 与缓存命中

### 5.1 统一计价器（dsh-token-meter，服务 `ctx.tokenMeter`）

**启发式计价**（`estimate.js`，lib/index.js:16-18）：`CHARS_PER_TOKEN=4`、每块 `BLOCK_OVERHEAD=4`（JSON 框架开销）；text/reasoning/tool-call 按 `ceil(字符/4)+4`；图片按其 JSON 引用结构估（真实路由价由 `priceImages` 替换）；system prompt `ceil(总字符/4)+4`；tools schema `ceil(JSON串长/4)+4`。

**`measure(session)`**（line 722-765）返回 `{baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes:[{seq,tokens,heuristicTokens}]}`：

- baseline 优先用**最近一次成功调用的 provider usage**（仅当 canonical request envelope 一致且 usage 总量 ≥ 估算锚点，防止 provider 少报），否则退回估算。`totalTokens = baseline + surface 自锚点以来的增量`——结合了真实计费与本地实时增量。
- 带路由图片计价：每图 `visualTokens + 描述文本估算`；file attachment 按投影文本计价（`priceSurface`，line 614-665）。

### 5.2 三个会话投影（O(1) 状态、可持久回放）

- **tokenUsage**：桶 `uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`，从 `assistant/message` 的 usage 折叠，`llm/retry-started` 重置槽位防重试双计（line 393-426）。**缓存命中显式单列**。
- **contextPressure**：`pressureTokens = inputTokens + cacheReadTokens + cacheWriteTokens`（**纯 prompt 侧，不含输出**，line 367）+ `contextWindow`（来自 request/context 事件）+ `projectedTokens = pressure + surface 自采样以来的位移`（line 489-493）——**预测下一次请求**的占窗，而非报告上一次。
- **contextBreakdown**：`systemTokens / toolsTokens / messageTokens` 三段（line 168-183），system 取最后一个非空 system 节点。

投影状态是 O(1) 标量，靠**影子计价协议**处理 replace：`compaction/summary` / `compaction/prune` 事件先武装 claim（被换区间的 token 价），紧邻的 replace 消费 claim 做 `+新−旧`（`foldSurfaceProjection`，line 282-314，区间不匹配即抛错）。这是"事件溯源 + 有界投影状态"的精髓。

### 5.3 展示

Web 端 dsh-client-ui-trajectory/lib/client.js 有完整计量：每请求 usage 卡片含"缓存读取"（locale key `usage.cached`，line 101/296/3902），聚合 `input+cacheRead+cacheWrite` 为 prompt 总量（line 3886-3887）。dsh-session-stats 只管时延（ttft/decode/llmMs），token 计量不经它。

### 5.4 投影缓存（dsh-session-projection-cache）

`session_projcache` 存储域（version 7，per-record 布局：每 session 一个 JSON 文档），**节流 write-behind**：`writeEveryEvents` 计数 + `writeIntervalMs` 定时 + 三个强制点（session 创建 / turn/end / dispose）。冷启动 `coldSnapshot` 用缓存行播种、只回放尾部增量（"cache is a fold shortcut, never an authority"——行可能 stale 但绝不会错，`seq` 标明多 stale，`ver` 不匹配直接丢弃，line 103-118）。token 关系：**让 token-meter 三个投影在大日志会话上 O(tail) 恢复**，否则每次重开都要全量重折（每事件一次 estimateMessage）。身份校验防"同 id 新生命周期"吃到旧缓存（line 389-407）。

### 5.5 双轨计价：heuristicTokens vs tokens

measurement 的每个节点同时带两个价（`priceSurface` 返回 `{seq, tokens, heuristicTokens}`）：`heuristicTokens` 是 4字符/ token 固定估算，`tokens` 是**路由真实计价**（图片按 provider visualTokens、file 按投影文本）。compaction 选区用 `nodes[].tokens`（route 价，因为压力对象是真实请求），而 `compaction/prune` 事件记录的 `shadowedTokenCount` 用 heuristic 价（投影 O(1) 折叠用同一估算器，两边数字才严格对得上——line 253-259 注释："The counts are exact by construction: producers derive them from the same fixed estimator"）。**这是可移植的要点：所有持久化的影子价必须由与消费者相同的估算器产生，否则投影永远对不上账。**

## ⑥ 前缀缓存友好策略（DeepSeek context caching）

### 6.1 usage 字段链路

`dsh-llm-deepseek` 走 **Anthropic 兼容 Messages 协议**（默认 baseURL `https://api.deepseek.com/anthropic`，line 430），SSE usage 映射（line 1823-1828）：

```js
input_tokens             → inputTokens          （未缓存输入）
cache_read_input_tokens  → cacheReadTokens      （前缀缓存命中）
cache_creation_input_tokens → cacheWriteTokens  （缓存写入）
```

语义约定（dsh-llm/lib/types/types.d.ts:153-158）：三桶**互斥**，计费输入 = 三者之和；`totalTokens` 由 adapter 补齐（dsh-llm-deepseek line 2006）。DSH 源码中**未出现** `prompt_cache_hit_tokens/prompt_cache_miss_tokens`（原生 chat-completions 字段）——它统一从 Messages 协议拿缓存数据；类型注释说明"把命中折进总 prompt 数的 provider（DeepSeek 原生 `prompt_tokens`）由 adapter 拆开"。

`dsh-deepseek-llm-api-extensions` 与缓存无关：它是**顶层请求字段注册表**（如 thinking 等），插件可注册独占字段，adapter 统一做 prepare/accept 事务，失败字段被静默剔除（lib/index.js:73-107）。

### 6.2 主动的缓存友好设计（真正的重点）

DSH 没有显式发 cache_control 断点，而是**结构上保证前缀稳定**：

1. **摘要即前缀**：compaction-basic 注释（line 238-242）原文："Keeping the conversation's own system prompt, tools, and message prefix in front of it makes the auxiliary call a genuine prefix of the last routed request, so the provider's KV cache is reused instead of invalidated."——摘要请求 = `重放前缀 + 一条 user 指令`，零额外 system prompt。
2. **稳定 system prompt vs 动态快照双通道**（dsh-system-prompt + dsh-agent-loop）：静态分段（SECTION_ORDERS 排序的 sections + tools schema）构成 surface 节点 0 的 `system/message`，基本不变；cwd/沙箱/审批/时区/时间等易变事实走 **runtime-context 快照**——一条 `source.kind="runtime-context"` 的 user 消息，头行固定 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."（dsh-system-prompt/lib/index.js:139）。变化只追加新快照消息（尾部），**从不改写 system 节点** → 前缀 KV 不失效。
3. **system prompt 变更的追加式落地**：`SystemPromptProjection.project`（dsh-agent-loop/lib/index.js:264-282）——路由支持 in-history system 消息且是连续系列时，prompt 变化**append 新 system 节点**而非替换节点 0；只有不可行时才 normalize 头节点（整体重写，缓存全失效，属最后手段）。
4. **工具结果修剪/压缩保持消息边界**：replace 只动被影子化的区间，其后的逐字尾部 16% 原样，尾部前缀缓存仍在。
5. **图片 offload 是投影层操作**：`image/offload` 事件不重写消息日志，只在请求投影时替换占位文本，协议上最小化扰动。

## ⑦ 提示词节制

- **分段注册表**（dsh-system-prompt）：sections 有全局保留位（HARNESS_IDENTITY=-1000 … DEPLOYMENT_PERSONA_SUFFIX=10200），工具段落（TOOL_BASH=1000、TOOL_READ=1100……）**只有对应工具加载才注入**——不装 LSP 就没有 TOOL_LSP 段。`suppressRuntimeContext()` 可整体关掉可选动态上下文；空段在渲染时直接丢弃（`renderPrompt` filter，line 117-119）。
- **动态上下文与静态段分离**（CONTEXT_ORDERS：WORKING_DIRECTORY/SANDBOX_POLICY/APPROVAL_POLICY…），快照只在内容变化时追加（`RuntimeContextProjection.project` 比较文本，相同则不产生消息，dsh-agent-loop/lib/index.js:334-349；清空时也有固定 CLEARED 文案）。
- **AGENTS.md 增量注入**（dsh-agent-instructions）：发现 `AGENTS.md/CLAUDE.md(.local)` 链；单文件 `maxSourceBytes=1 MiB` 上限、整批 `maxBytes`（必配）渲染预算、UTF-8 边界截断（`truncateUtf8`）；**SHA-1(trimmed content) 去重**——同组内字节相同的候选折叠（`dedupInstructionFilesByCandidateGroup`，line 730-746）；变更时发 `{action:'add'|'remove', scope, path, digest}` 的**增量指令消息**（`reconcileInstructionContext`），不整篇重发；消息形态是 `kind:"agent-instructions"` 的 user message（渲染进上下文但 UI 可按 source 归类）。
- **摘要提示词本身的节制**：8 段模板 + "terse bullets, not prose" + "(none) 占位禁删段"（②.3）——用结构换长度，避免自由发挥的摘要膨胀。
- **repeat-tool-reminder**（opt-in 插件）：`thresholds=[3,5,8]`（连续同工具+**同参**（canonical JSON 深排序键序）第 3 次发温和提醒、第 5/8 次发详细提醒（工具名/次数/参数预览，预览截 500 字符），`include/exclude` 通配过滤，用户新消息重置计数（lib/index.js:2117-2264）。省 token 的逻辑：**打断无进展循环 = 省掉整轮重复调用+结果**；参数预览上限 500 字符防"提醒本身成为大 payload"（d.ts:33-38 注释原话）。

## ⑧ 对 tim-harness（纯浏览器实现）的可移植结论

### 8.1 直接照搬（浏览器环境零障碍）

1. **估算计价器**：`ceil(chars/4)+4/块`、role 框架 +4、tools JSON 串 /4——`estimateContent/estimateMessage` 两个纯函数直接抄（dsh-token-meter/estimate）。浏览器不需要真 tokenizer 就能做所有阈值决策。
2. **tool-result 中段修剪**：8192/4096/1024 码点 + `[... tool result middle pruned ...]` marker + 码点安全切片（dsh-compaction-tool-result-pruner）。纯函数，直接抄。
3. **TextRetainer/ItemRetainer**：无依赖纯类（Uint8Array 滚动窗口 + UTF-8 边界修剪 + 精确 omitted 计数 + 标准化 notice 措辞），整文件可直接复制进 tim-harness（dsh-output-retention 全库 ~300 行）。
4. **工具预算表**：read 2000 行/行 2000 字符/50 KiB；grep 250 匹配/行 2 KiB/预览 + glob 100；终端 256 KiB 尾保留。这些数字是现成的合理默认。
5. **repeat-tool-reminder**：canonical（深排序 JSON）判同 + [3,5,8] 阈值升级 + 500 字符参数预览 + 用户新消息重置——纯前端可实现，省钱效果直接。
6. **摘要提示词 8 段模板 + 收敛校验（摘要必须小于被替换段）**：模板照抄，校验必抄（防"越压越大"）。

### 8.2 需适配（思路照搬，载体换掉）

1. **压缩事务协议**：tim-harness 若用 append-only 数组 + `replace(start,end)` 投影也能实现 `compaction/start|summary|end` 三事件 + 影子化（被替换区间保留在日志里，撤销/审计可行）。阈值公式照搬：`threshold = min(0.8×window, window − maxTokens − 65536)`、`retain = 16%×(window−maxTokens)`、每轮最多压 2 次、overflow 强制压缩（retain=0）后原样重试请求。
2. **spill**：磁盘 → **IndexedDB / OPFS**。Locator 用自定义 scheme（如 `spill:<sessionId>/<id>`），retrievalHint 改成 "用 read 工具分页读取"。安全编码（单射段名）与按 session 隔离、30 天清扫的思路保留；0600 权限检查不适用。`maxInlineTokens` 建议 ~4000（约等于一次工具结果的合理上限，超过就 spill 行内留头尾各半 + `

[...]

`）。
3. **图片卸载**：触发源从 adapter 错误码改为"计价器发现图片超预算"；策略照搬"从最旧开始整块 offload + 占位文本（含原图尺寸与可重看指引）"。浏览器里图片最贵，这个优先级应高于在 DSH 中的位置。
4. **token meter 投影**：三个投影（usage 四桶 / pressure+projected / breakdown）+ "provider usage 锚点 + 本地增量"混合基线可整体照搬；持久化从 jsonl+projcache 换成单条 IndexedDB 记录（每 turn/end 写一次即可，不需要 DSH 的双触发节流那么细）。
5. **runtime-context 快照**：时间/时区/工作目录等易变事实绝不能进 system prompt（会打爆前缀缓存），照搬"固定头行 + supersedes 声明 + 只在变化时追加"的三件套。

### 8.3 不适用浏览器

1. **cordis 服务注入体系**（ctx.tokenMeter/ctx.compaction 动态分发）——tim-harness 直接函数调用即可，不需要 DI。
2. **spill-local 的 POSIX 权限/符号链接防御**（0600/0700、sticky-bit 祖先检查、mkdtemp 形状发现）——OPFS 天然按 origin 隔离。
3. **runMaintenance 互斥 / durable flush**（手动压缩与驱动轮次的 idle 互斥、持久化 checkpoint 等待）——单页面前端没有并发会话竞争，一个 `compressing` 布尔标志 + await 足够。
4. **modelPolicies 按 provider/model 精确覆盖表**——tim-harness 单一 DeepSeek 路由时用一组全局值即可；将来多模型再引入。

### 8.4 推荐参数速查（128K 窗口 / deepseek-chat 量级）

| 参数 | 建议值 | 来源依据 |
|---|---|---|
| 压缩阈值 | `min(0.8×window, window−maxTokens−65536)` ≈ 90K（128K 窗口、8K 输出预留时） | thresholdRatio 0.8 + headroom 65536 |
| 摘要输出上限 | 65536 | maxTokens=headroomTokens 默认 |
| 尾部逐字保留 | `(window−maxTokens)×0.16` ≈ 19K | retainRatio 0.16 |
| 压缩重试 | 同轮 ≤2 次；overflow 重试 ≤1 次/轮 | compactionRetries/maxOverflowRetries=1 |
| 工具结果中段修剪 | >8192 码点触发，保头 4096 + 尾 1024 | pruner DEFAULTS |
| 行内工具结果上限（spill 阈值） | ~4000 est-tokens（约 16K 字符），头尾各半 | spill-policy maxInlineTokens（DSH 无默认，需自配） |
| 重复调用提醒 | 阈值 [3,5,8]，参数预览 500 字符 | repeat-tool-reminder DEFAULTS |
| read/grep/终端 | 2000 行、2000 字/行、50 KiB / 250 匹配、2 KiB/行 / 256 KiB 尾保留 | 工具 DEFAULTS |
| 计价密度 | 4 chars/token + 4/块 + 4/消息 | estimate.js |

### 8.5 实施顺序建议（按性价比）

1. **第一步（零风险纯函数）**：estimate 计价器 + TextRetainer/ItemRetainer + read/grep/terminal 预算表 + tool-result-pruner——不碰会话模型，直接把最坏情况工具输出从无界压到 ~8K 码点。
2. **第二步（会话结构）**：runtime-context 快照双通道（system 稳定 + 易变事实尾部追加）——不加任何"压缩"就先保住前缀缓存命中率，这是每次请求都在生效的隐性节省。
3. **第三步（压缩事务）**：compaction 事件协议 + 8 段摘要模板 + 收敛校验 + 阈值公式——前两步稳了之后再上，因为它引入模型调用与新的事件类型。
4. **第四步（增强件）**：spill（OPFS）> image-offload > repeat-tool-reminder > spill-policy 通用上限——各自独立、随时可加。

一个校验点贯穿全程：**所有持久化的影子计价必须与消费者用同一个估算函数产生**（见 ⑤.5），否则任何 replace 之后你的压力数字都会漂移。

## 附：本文引用的关键文件

- `dsh-compaction/lib/index.js`、`dsh-compaction-basic/lib/index.js`、`dsh-compaction-tool-result-pruner/lib/index.js`、`dsh-compaction-image-offload/lib/index.js`
- `dsh-output-retention/lib/index.js`、`dsh-spill/lib/index.js`、`dsh-spill-policy/lib/index.js`、`dsh-spill-local/lib/index.js`
- `dsh-token-meter/lib/index.js`（estimate / surface-projection / usage-projection / route-pricing）、`dsh-session-projection-cache/lib/index.js`
- `dsh-llm-deepseek/lib/index.js`（Messages 协议、usage 映射、图片计价）、`dsh-llm/lib/types/types.d.ts`（TokenUsage 契约）、`dsh-deepseek-llm-api-extensions/lib/index.js`
- `dsh-system-prompt/lib/index.js`、`dsh-agent-instructions/lib/index.js`、`dsh-agent-loop/lib/index.js`（runtime-context 投影）、`dsh-repeat-tool-reminder/lib/index.js`
- `dsh-tool-fs/lib/index.js`、`dsh-tool-fs-search/lib/index.js`、`dsh-tool-terminal/lib/index.js`、`dsh-tool-bash/lib/index.js`、`dsh-client-ui-trajectory/lib/client.js`
