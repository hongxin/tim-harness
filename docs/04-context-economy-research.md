# 上下文经济与高效记忆系统：业界调研

> 调研日期：2026-10-22。方法：web_search + 直接抓取官方文档一手来源（DeepSeek API Docs、OpenAI 开发者文档、Claude Platform 文档、Anthropic Engineering 博客、arXiv、GitHub）。
> 所有关键数字均附来源链接；第三方转述数字单独标注。与本文互补的内部机制研究见 [03-dsh-token-economy.md](03-dsh-token-economy.md)（DSH 实现层的 token 流水线）。

---

## ① 缓存经济学：各家规则与价格表

### 1.1 DeepSeek：当前官方定价（2026-10 快照）

官方"模型 & 价格"页（[api-docs.deepseek.com/zh-cn/quick_start/pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)）当前在售两款模型，按"百万 tokens"计价，**分高峰/空闲时段**（北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰，不含法定节假日；其余时段含周末为空闲，空闲价为高峰一半）：

| 项目（元/百万tokens） | deepseek-flash<br>(DeepSeek-V4.1-Flash-1017) | deepseek-v4-pro<br>(DeepSeek-V4-Pro-0813) |
|---|---|---|
| 输入·缓存命中（空闲/高峰） | **0.02 / 0.04** | **0.15 / 0.30** |
| 输入·缓存未命中（空闲/高峰） | **1 / 2** | **4.5 / 9.0** |
| 输出（空闲/高峰） | **4 / 8** | **13.5 / 27.0** |
| 上下文长度 / 最大输出 | 1M / 384K | —（V4-Pro） |
| 并发限制 | 2500 | 500 |

要点（同页）：

- 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，但已由 V4.1-Flash-1017 提供服务并按 Flash 价计费；V4-Pro 不支持图像理解，Flash 支持。
- 缓存命中与未命中价差：Flash 为 **1/50**（0.02 vs 1 元），V4-Pro 为 **1/30**（0.15 vs 4.5 元）——命中缓存的输入几乎免费，这是所有省 token 手段的杠杆支点。
- 配套的 Search/Fetch API 按 5 元 / 1000 次成功请求计费；目前在 DeepSeek Harness/Claude Code/Codex 中经 Server 端工具调用暂不计费，**2026-11-01 00:00（北京时间）起按次收费**。
- 官方页仅以人民币计价；美元牌价官方页未列出（第三方网关如 Vercel AI Gateway、Artificial Analysis 有列，未逐项核实，本文不转述）。V4.1-Flash 于 2026/09/10 发布、1017 小版本 2026/10/17（见[官方新闻时间线](https://api-docs.deepseek.com/zh-cn/news/news0802/)侧栏）。

### 1.2 DeepSeek：上下文硬盘缓存机制与命中规则

官方指南（[上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)）——**默认开启、无需改代码**，但命中规则必须吃透：

- **缓存前缀单元 + 完整匹配**：受 Sliding Window Attention 影响，每条缓存前缀是独立完整单元；后续请求只有**完整匹配**某个已落盘单元才能命中。第一轮 A+B、第二轮 A+C 不会命中；但系统会检测公共前缀 A 并落盘，第三轮 A+D 即可命中 A。
- **三种落盘时机**：① 每次请求的"用户输入结束位置"与"模型输出结束位置"各产生一个单元（多轮对话天然受益）；② 跨请求公共前缀检测落盘；③ 长输入/长输出按固定 token 间隔截取落盘。
- **usage 字段**：返回中 `prompt_cache_hit_tokens`（命中数）与 `prompt_cache_miss_tokens`（未命中数），可实时监测命中率。
- **TTL**：缓存"尽力而为"，不保证命中；不再使用后自动清空，**一般为几个小时到几天**。
- **粒度**：2024 年上线公告（[API 创新采用硬盘缓存](https://api-docs.deepseek.com/zh-cn/news/news0802/)）明确"**缓存系统以 64 tokens 为一个存储单元，不足 64 tokens 的内容不会被缓存**"；现行指南改为"前缀单元"表述、未再重述 64，可视为粒度下限的历史口径。
- **历史价与收益参考**（同公告）：命中 0.1 元/百万 vs 未命中 1 元/百万（当时为 1/10）；前缀必须**从第 0 个 token 开始相同**，中间重复不算命中；128K 大重复输入实测首 token 延迟 **13 秒 → 500 毫秒**；针对缓存优化最高省 **90%** 费用，不做优化历史平均也省 **>50%**。技术根基是 V2 的 MLA 压缩 KV Cache，使缓存可落廉价硬盘阵列。
- **多轮对话是无状态 API**：服务端不存上下文，客户端每轮把全部历史拼好重发（[多轮对话指南](https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat/)）——所以"每轮只追加、不改历史"直接决定命中量。

### 1.3 OpenAI：自动 prompt caching

官方指南（[developers.openai.com/api/docs/guides/prompt-caching](https://developers.openai.com/api/docs/guides/prompt-caching)，[发布公告](https://openai.com/index/api-prompt-caching/)）：

- **默认开启**，缓存命中输入价折扣最高 **95% off**（即读价约 0.05x-0.1x）。
- **最小可缓存长度 1,024 tokens**（GPT-5.6 及以后；更早模型随请求设置变化），隐藏系统内容不计入。
- GPT-5.6+：缓存写 **1.25x**（默认 30 分钟寿命）/ **2.5x**（12 小时），缓存读 **0.1x**（GPT-6.1 Sol 为 0.05x）；官方算术：写 1 次 + 读 9 次 = **2.15x**，不缓存处理 10 次是 10x。支持显式/隐式 breakpoint，每次请求最多 **4 个缓存写**；`cached_tokens` 按 **128 token 向下取整**计。
- **隐式断点位置**：自动打在"最新一条 eligible 消息"末尾（用户消息 / 连续工具响应组的最后一条 / 初始连续 developer 消息组的最后一条）；查找时从最长前缀到最短逐一探测（显式模式探测前 2 + 最近 50 个断点，隐式模式另加最多 20 个更早消息结尾）。
- 更早模型：仅隐式缓存，闲置后存活约 **5-10 分钟，最长 1 小时**。
- **破坏前缀的设置**（同页表格）：`model`、`tools`（名称/描述/schema/顺序）、`parallel_tool_calls`、`text.format`、`reasoning.effort`、`text.verbosity`、`context_management`（压缩改写历史）。缓存的是**完整渲染上下文**（含 OpenAI 注入的隐藏指令），任一前置内容变化，其后全部无法命中。

> 破坏缓存操作对照（三家共性）：**改提示前缀任意一字、换模型、改工具定义、压缩/重写历史**。OpenAI 另点名 `reasoning.effort` / `text.verbosity`；Anthropic 的 thinking 块"保留=缓存完好、清除=失效"；DeepSeek 因"完整单元匹配"对中间改动最敏感（改动点之前的单元仍可命中，之后全部 miss）。

### 1.4 Anthropic：显式 cache_control + 双 TTL

官方文档（[platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)）：

- 两种开启方式：**自动缓存**（请求顶层加 `cache_control`，断点自动打在最后可缓存块并随对话前移，适合多轮）与**显式断点**（打在具体 content block 上，精细控制）。
- **计费乘数**：5 分钟 TTL 写 **1.25x**；1 小时 TTL 写 **2x**；读 **0.1x**（Opus 5.5 / Sonnet 5.5 为 0.05x，Fable 5.1 / Mythos 5.1 为 0.025x）。命中即免费续期（refresh），寿命从**请求开始时刻**起算——若响应流式输出耗时 4 分钟，后续复用请求须在响应结束后 ~1 分钟内发出。
- **增量缓存写法**（官方多轮示例）：每轮把最后一条消息标 `cache_control`，系统自动查找并复用此前最长的已缓存块序列；曾被标记过的块后来不再标记，也仍算命中（并续期）。系统提示单独打断点，防止其被逐出后无法重新入缓存。
- **最小可缓存长度**：Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1 为 **512 tokens**；Sonnet 5/4.6/4.5、Opus 4.8 等为 1,024；Opus 4.7 为 2,048；Opus 4.6/4.5、Haiku 4.5 为 4,096。
- 示例牌价（同页表）：Sonnet 5.5 输入 $2 / 5m写 $2.50 / 1h写 $4 / 读 **$0.10** / 输出 $10（每 MTok）；Haiku 5.5（≤100K 提示）输入 $0.10 / 读 $0.01。
- 官方推荐的 **4 段缓存布局**：系统指令 → 工具定义 → RAG 知识库 → 对话历史，各段独立断点：追加对话不动前三段；更新知识库只失效第三段；改工具定义才失效到第二段。

### 1.5 三家对比速查

| 维度 | DeepSeek（硬盘缓存） | OpenAI | Anthropic |
|---|---|---|---|
| 开启方式 | 默认自动 | 默认自动 | 自动或显式 `cache_control` |
| 命中读价 | 0.02-0.30 元/M（未命中的 1/30~1/50） | ~0.05-0.1x 输入价 | 0.1x（部分 0.05/0.025x） |
| 写溢价 | 无 | 1.25x（30m）/ 2.5x（12h） | 1.25x（5m）/ 2x（1h） |
| 最小粒度 | 64 tokens（历史口径）/ 前缀单元 | 1,024 tokens，128 取整 | 512-4,096 tokens（按模型） |
| 寿命 | 数小时到数天 | 5-10 分钟（旧）/ 30m-12h（新） | 5 分钟（默认，命中续期）/ 1 小时 |
| 监测字段 | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | `cached_tokens` | `cache_read_input_tokens` / `cache_creation_input_tokens` |

### 1.6 一笔账：缓存对多轮 agent 的实际意义

以 DeepSeek flash 空闲时段、典型编码 agent 每轮输入 100k token（其中 95k 与上轮相同）× 10 轮为例：

- 无缓存：100k×10 = 1M 输入 → **1 元**（另有输出费）。
- 全命中稳态：首轮 100k miss（0.1 元）+ 9 轮各 95k hit + 5k miss（9×(0.095×0.02 + 0.005×1) ≈ 9×0.0069 ≈ 0.062 元）→ 合计约 **0.16 元，省 84%**；命中率越高越接近官方"优化后省 90%"口径（[硬盘缓存公告](https://api-docs.deepseek.com/zh-cn/news/news0802/)）。
- 反面：若 harness 每轮重写历史（哪怕只改一个系统层 token），10 轮全量 miss → 1 元，且首 token 延迟回到无缓存水平（对照 128K 输入 13s vs 500ms 的实测差距）。**prompt 组装的"只追加"纪律本身就是最大的成本特性。**

---

## ② 上下文工程实践（Anthropic 为代表）

### 2.1 核心观念：context rot 与注意力预算

Anthropic 工程博客《[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)》（2025-09-29）提出：上下文工程 = "在不断演化的信息宇宙中，策划什么进入有限上下文窗口"的艺术。核心论据：

- **Context rot**：needle-in-a-haystack 类研究发现，随上下文 token 增长，模型准确回忆能力**普遍下降**（所有模型皆有，程度不同）；上下文是**边际收益递减的有限资源**，模型有"注意力预算"。架构根源：n 个 token 两两关系为 O(n²)，且训练分布中短序列占主导。
- 总原则："**找到最大化达成目标概率的最小高信号 token 集**"。
- 后续实证论文：长程搜索中的 context rot 诊断与缓解（[arXiv:2606.29718](https://arxiv.org/abs/2606.29718)）、编码代理中 context rot 的白盒研究（[arXiv:2607.17937](https://arxiv.org/abs/2607.17937)）。

### 2.2 三大长程技术：Compaction / 结构化笔记 / 子代理

同篇博客给出的三种官方长程手段：

1. **Compaction（压缩）**：接近窗口上限时让模型总结历史、以摘要重启窗口，是"第一杠杆"。Claude Code 的实现：保留**架构决策、未解决 bug、实现细节**，丢弃冗余工具输出，重开窗口后附带**最近访问的 5 个文件**。调优方法论：先在复杂 agent trace 上**最大化召回**（摘要不漏关键信息），再迭代**提高精度**（去冗余）。
2. **结构化笔记（agentic memory）**：agent 定期把笔记写到窗口外的持久存储、按需读回——如 Claude Code 的 todo list、自定义 agent 维护 NOTES.md；Claude 玩宝可梦的 agent 跨数千步维护精确计数与地图，上下文重置后**读自己的笔记继续多小时任务**。配套产品是 memory tool（见 2.4）。
3. **子代理架构**：主代理只带高层计划；子代理在干净窗口里做深活，内部可以烧掉数万 token，但只回传 **1,000-2,000 token 的浓缩摘要**。搜索类复杂任务上显著优于单代理（参考其多代理研究系统一文）。

### 2.3 Context editing：服务端清除与压缩

官方文档《[Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)》（beta header `context-management-2025-06-27`）：

- 官方立场：长对话首选**服务端 compaction**；context editing 用于需要精细控制清除内容的场景。
- **`clear_tool_uses_20250919`**：超过阈值后按时间序**从旧到新清除工具结果**，原位替换为占位文本；可选 `clear_tool_inputs: true` 连工具调用参数一起清。
- **`clear_thinking_20251015`**：清除早前轮次的 thinking 块，`keep` 参数控制保留量（Sonnet 4.6+/Opus 4.5+ 默认保留全部历史 thinking，更早模型默认只留最后一轮）。
- **与缓存的权衡**（文档明示）：清除会使缓存前缀失效，所以要"**一次清够本**"——用 `clear_at_least` 保证每次至少清除若干 token，摊销缓存重写成本；thinking 块**保留则缓存不失效**、清除才失效，按"缓存性能 vs 窗口空间"取舍。
- 服务端编辑不影响客户端：客户端继续保存完整历史，无需同步。

### 2.4 Memory tool：窗口外的文件记忆

官方文档《[Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)》：Claude 在任务开始自动检查 `/memories` 目录；工作中把学到的东西写成文件、后续会话按需读回，实现 **just-in-time 检索**（不必把所有相关信息预先塞进窗口）。工具是**客户端执行**的：模型只发 `view/create/str_replace/insert/delete/rename` 命令，存储位置完全由应用控制。这是"结构化笔记"的产品化形态。

### 2.5 Claude Code 的缓存实战（对 ① 的落地示范）

Claude Code 官方文档《[How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)》与《[costs](https://code.claude.com/docs/en/costs)》给出可复制的工程细节：

- **请求分层排序**（稳定在前）：系统提示+工具定义 → 项目上下文（CLAUDE.md 等）→ 对话历史。对话层变化不伤前两层；系统层一变**全量失效**。**没有按文件的缓存**，前缀精确匹配。Plan 模式、技能加载等动态指令以"对话消息"形式追加而非改系统层，正是为了保前缀。
- **官方列出的缓存失效动作**及成本：

| 动作 | 后果 | 说明 |
|---|---|---|
| 切模型 / 改 effort / 开 fast mode | 全量失效 | 每个模型、每个 effort、fast-mode 请求头各自独立缓存键 |
| 连/断 MCP 服务器、开关提供 MCP 的插件 | 失效（工具定义在系统层） | 工具搜索（tool search）延迟注册可豁免 |
| 整体禁用某工具（裸名 deny 规则） | 失效（同上） | 作用域规则如 `Bash(rm *)` 不影响前缀 |
| `/compact` | 对话层失效 | 系统层/项目层仍可命中缓存 |
| 累积大量图片、升级 Claude Code | 失效/重建 | 图片体积大；版本升级改变请求形状 |

- 建议"会话开始就定好模型和 effort，/compact 留在任务间隙"；网关若剥掉 `cache_control` 标记，整段历史每轮都按未缓存输入计费（选网关时必查）。
- **/compact 的成本结构**：摘要请求复用同一前缀，缓存热时只花"生成分摘要"的钱；冷缓存恢复旧会话再 compact 最贵（历史全量重算）。压缩后下一轮只需为短摘要重建缓存。
- 企业数据基线：平均 **$13/开发者/活跃日**、$150-250/月，90% 用户低于 $30/日；示例会话账单 940.0k cache read + 1.2k input + 5.3k output = $0.55，**91% 输入来自缓存**——缓存是 Claude Code 经济性的支柱。

---

## ③ 分层记忆系统

### 3.1 MemGPT：LLM 即操作系统（虚拟上下文管理）

论文《[MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)》（arXiv:2310.08560，全文见 [ar5iv](https://ar5iv.labs.arxiv.org/html/2310.08560)）——借用操作系统**虚拟内存分页**思想，在有限窗口内"虚拟化"出大上下文：

- **两级存储**：`main context`（主上下文，类比内存/DRAM）= 系统指令 + **working context**（工作上下文，常驻的核心记忆，模型可直接改写）+ **FIFO 队列**（近期消息）；`external context`（类比磁盘）= **recall storage**（全量对话历史，可检索回插）+ **archival storage**（任意长文本的向量库，读写字对象）。
- **自管理**：模型通过函数调用在层间搬数据，`request_heartbeat=true` 触发链式推理，实现多步检索——**记忆编辑完全由模型自主发起**。典型函数面：`core_memory_append/replace`（改写常驻核心记忆）、`archival_memory_insert/search`（向量库读写）、`conversation_search`（查 recall storage）等。
- **队列管理器（逐出策略）**：token 达窗口 **~70%** 时插入"memory pressure"系统告警，提示模型把重要信息存入 working context 或 archival；达 **~100%** 时逐出约 **50% 窗口**的消息，并用"现有递归摘要 + 被逐出消息"生成**新的递归摘要**（recursive summarization）；被逐出消息永久留在 recall storage 可查。

### 3.2 Letta（MemGPT 商业化）：记忆块

Letta 文档《[Stateful agents](https://docs.letta.com/v1-sdk/concepts/stateful-agents/)》：stateful agent = 系统提示 + **memory blocks** + 消息 + 工具。要点：

- **memory block** 是可由 agent 通过 memory 工具（或开发者经 API）编辑的字符串；**attach 到 agent 的块即 in-context**（钉在系统提示里），可跨 agent **共享**（shared blocks）——主/子代理共享同一份核心记忆。
- 服务端保存**全部消息**：即便经过 compaction/eviction，旧消息仍可通过 API（开发者）和检索工具（agent）找回——"窗口内丢失 ≠ 系统内丢失"。

### 3.3 mem0：提取-存储-检索流水线与成本

论文《[Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)》（arXiv:2504.19413）+ [官方 research 页](https://mem0.ai/research)：

- **工作流**：对话中**动态提取（extraction）→ 合并巩固（consolidation）→ 检索（retrieval）**显著信息；另有图记忆变体捕捉实体关系。
- **效果数字**（LoCoMo 基准）：LLM-as-a-Judge 相对 OpenAI 方案 **+26%**；图记忆再 +2%；相比全量上下文，**p95 延迟 -91%**，**token 成本省 >90%**。
- 官方 research 页（2026 更新）：LoCoMo 综合 92.5 分，单次检索平均 **~6,956 tokens** vs 全量上下文 **25,000+**；架构上"**单遍 ADD-only 提取**"（只增不改写，历史完整，提取快约 2x）+ "**多信号检索**"（语义/关键词/实体三路打分融合）+ 时间衰减排序（中位检索延迟只 +1ms）。

---

## ④ 工具输出管理：截断、折叠与递归总结

工具调用型 agent 的上下文大头是工具结果。业界惯例：

### 4.1 Claude Code：默认上限 + 环境变量

官方环境变量表（[code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars)）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `BASH_MAX_OUTPUT_LENGTH` | **30,000 字符**（上限 150,000） | bash 输出读回结果的最大字符数 |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | **25,000 tokens** | 单次文件读取上限 |
| `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` | **4,096 / 16,384 字符** | MCP 工具描述/说明上限（防工具定义本身吃窗口并破坏缓存） |
| `MAX_THINKING_TOKENS` | ≥1,024 | 思考预算（可设 0 关闭） |

另有 auto-compaction：接近窗口自动压缩（[costs 文档](https://code.claude.com/docs/en/costs)）；DSH 实现层对应机制见 [03-dsh-token-economy.md](03-dsh-token-economy.md)（产出侧 TextRetainer 256KiB、pruner 8192 码点头 4096+尾 1024、compaction 80% 阈值等）。

### 4.2 Cline：头尾保留 + 中段省略 + 分页提示

Cline PR（[cline/cline#11480](https://github.com/cline/cline/pull/11480) "cap tool output ingestion for bash and file reads"，配套 [#11475](https://github.com/cline/cline/pull/11475) 默认开启截断与预算记账、[#4002](https://github.com/cline/cline/issues/4002) 社区需求）：

- **bash 输出**：弃用"只取前 N 字节"，改为滚动采集器：**保留头 24k 字符 + 尾 24k 字符**（stdout/stderr 各自独立），超限时发 `truncateMiddle` 通知（保头去中）；用 `StringDecoder` 保证多字节 UTF-8 不被截断。
- **文件读取**：窗口化到 **2,000 行 / 48,000 字符**，单行上限 2,000 字符（对付压缩/混淆文件）；截断通知**报告总行数并提示用 `start_line`/`end_line` 分页**——截断信息本身要教会模型"怎么拿全量"，而不是让它盲目重试。
- 上限刻意低于 MessageBuilder 的 **50,000 字符/条**兜底，保证"截断通知 + 内容"能完整过 provider 请求层。
- 配套 PR（[#11475](https://github.com/cline/cline/pull/11475)）把截断**默认开启**并在 MessageBuilder 里做**预算记账**（聚合超限时二次中段截断，头尾与分页提示保留）——即"工具级截断 + 请求级预算"双层防线，与 DSH 的 retainer→pruner→compaction 流水线同构（见 [03-dsh-token-economy.md](03-dsh-token-economy.md)）。

### 4.3 Aider：为缓存组织历史 + 缓存保活

Aider 文档《[Prompt caching](https://aider.chat/docs/usage/caching.html)》：`--cache-prompts` 把聊天历史按可缓存顺序组织——**系统提示 → 只读文件（--read）→ 仓库地图 → 可编辑文件**；`--cache-keepalive-pings N` 每 5 分钟 ping 一次 provider，防止 Anthropic 默认 5 分钟 TTL 过期（最多 N 次，覆盖 N*5 分钟空闲）。

### 4.4 递归总结与 context rot

- **递归总结**：MemGPT 的"旧摘要 + 新逐出消息 → 新摘要"是标准做法（见 3.1）；Anthropic compaction 同思路，并强调"保什么"比"压多狠"更关键——过度压缩会丢掉事后才显重要的细节（[博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。
- **context rot 实证**：除 Anthropic 定义外，2026 年已有针对长程搜索（[arXiv:2606.29718](https://arxiv.org/abs/2606.29718)）、编码代理技能（[arXiv:2607.17937](https://arxiv.org/abs/2607.17937)）、监控分类器（[arXiv:2605.12366](https://arxiv.org/abs/2605.12366)）的专项研究——**"窗口够大"不等于"表现不降"**，主动瘦身仍是必需。

### 4.5 浏览器/边缘端 agent 的 token 成本优化

- **[free-web-ai-worker](https://github.com/augustlies/free-web-ai-worker)**：让编码 agent 把**简单文本子任务**（总结/翻译/分类/抽取/重排）外包给用户自己浏览器里的免费网页版 AI（驱动既有 Edge/Chrome，隔离 profile）：主模型只收回纯文本答案，**主上下文零占用、零 token 计费**；内置防滥用护栏（间隔/冷却/配额/熔断/缓存）。这是"浏览器端 agent"独有的一条省 token 路径——把"不配用前沿模型"的工作流走免费通道。
- 第三方实践参考：ofox 博客称接入 DeepSeek 前缀缓存后"账单直降 80%"（[ofox.ai](https://ofox.ai/zh/blog/deepseek-v3-2-prompt-caching-setup-2026/)，第三方口径，仅供参考）；CloudZero 的 DeepSeek 定价与优化指南（[cloudzero.com](https://www.cloudzero.com/blog/deepseek-pricing/)）可作背景阅读。
- tim-harness 自身定位（浏览器宿主 + 小程序演化路径，见 [00-design.md](00-design.md)）意味着：IndexedDB/OPFS 可充当 archival 存储（对应 3.1/3.2 的外层记忆），这是本地记忆层不花 token 的天然优势。

---

## ⑤ 对 tim-harness 的设计启示（可执行清单)

按"省 token 效果 × 实现成本"排序，编号便于逐条落 issue：

**A. 缓存最大化（收益最大，先做）**

1. **请求分层排序**：组装 prompt 时固定顺序 `系统提示 → 工具定义 → 项目上下文（CLAUDE.md 等价物）→ 对话历史`，历史**只追加、永不改写**；文件变更通知等动态系统内容放到消息尾部（对齐 [Claude Code 分层](https://code.claude.com/docs/en/prompt-caching)与 [Aider 顺序](https://aider.chat/docs/usage/caching.html)）。
2. **会话内不折腾**：模型/effort/工具集在会话开始锁定；MCP 工具接入用"延迟注册"避免中途改工具定义；工具描述超 4,096 字符即截断（对齐 [Claude Code](https://code.claude.com/docs/en/env-vars)）。
3. **缓存仪表盘**：解析 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek）与 `cached_tokens`（OpenAI）、`cache_read/creation_input_tokens`（Anthropic），在 UI 显示命中率与"上次 miss 原因"（对齐 [Claude Code /usage](https://code.claude.com/docs/en/costs) 的 91% 缓存读示例）。
4. **峰谷调度**：批量/后台任务错开北京时间工作日 9-12/14-18 高峰（[DeepSeek 定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)空闲价 = 半价）；2026-11-01 起把 Search/Fetch 5 元/千次计入成本模型。

**B. 工具输出瘦身（防爆炸，第二优先）**

5. **头尾保留截断**：bash/抓取类输出采用 Cline 式"头 24k + 尾 24k 字符 + truncateMiddle 通知"（[cline#11480](https://github.com/cline/cline/pull/11480)），默认上限先对齐 `BASH_MAX_OUTPUT_LENGTH=30000` 字符（[Claude Code](https://code.claude.com/docs/en/env-vars)），全量溢写 OPFS/IndexedDB（spill，DSH 已有对应机制）。
6. **文件读取窗口化**：单次读上限 25,000 token / 2,000 行，截断通知带 `总行数 + 分页参数提示`，教模型翻页而非重试。
7. **旧工具结果折叠/清除**：超过阈值后把旧工具结果替换为占位文本，但"一次清够本"（`clear_at_least` 思想，[Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)）——清除量太小会白白付缓存重写费。

**C. 压缩与记忆（长会话必需）**

8. **Compaction**：窗口 80% 触发摘要重启（DSH compaction-basic 同阈值），摘要必保：待办、架构决策、未解决 bug、**最近 5 个文件**；调 prompt 先最大化召回再提精度（[Anthropic 博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）；compact 尽量安排在缓存热时的自然任务间隙。
9. **分层记忆**：in-context 核心记忆块（可编辑、可跨子代理共享，Letta memory blocks 模型）+ IndexedDB archival（向量检索工具按需召回）+ 全量消息永久留存（"窗口内丢失 ≠ 系统内丢失"）；水位线借鉴 MemGPT：70% 警告自查、100% 逐出 50% 并做递归总结。
10. **记忆写读分离**：写入用 ADD-only 单遍提取（不覆写、保历史，[mem0](https://mem0.ai/research)），读取用多信号融合（语义+关键词+实体），单次召回预算控制在 ~7k token。
11. **子任务隔离**：脏活（全库搜索、长文档解析）丢给一次性子代理，只回收 1-2k token 摘要（[Anthropic 子代理架构](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。

**D. 浏览器端专属（差异化机会）**

12. **免费通道外包**：把总结/翻译/分类/重排类子任务路由到用户本机浏览器的免费 web AI（[free-web-ai-worker](https://github.com/augustlies/free-web-ai-worker) 模式），主模型上下文与账单双省；需带防滥用护栏（间隔/冷却/配额/熔断）。
13. **本地记忆零 token**：用户偏好、项目画像、常用命令缓存常驻 IndexedDB 而非对话历史，配合 memory-tool 式 just-in-time 读取（[Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)）。
14. **输出预算**：默认 `max_tokens` 收紧 + thinking 预算独立控制（`MAX_THINKING_TOKENS` ≥1024 的思路），避免单轮爆走。

**E. 验收标准（怎么算做完）**

- A 组：连续 10 轮对话第 2-10 轮 `prompt_cache_hit_tokens` 占输入 >90%；无任何一轮因 harness 侧改写历史导致非预期 miss。
- B 组：单条工具结果入窗 ≤ 设定上限（30k 字符），截断通知含分页指引；全量可在 OPFS 找回。
- C 组：20 万 token 长会话压缩后任务可续作，摘要含待办/决策/未解 bug 三要素；记忆召回平均 <8k token/次。
- D 组：外包子任务走免费通道时主会话 token 增量为 0（只进纯文本结果）。

---

## 来源汇总

**官方文档/一手**：[DeepSeek 模型&价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) · [DeepSeek 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/) · [DeepSeek 硬盘缓存公告(2024, 64-token 粒度)](https://api-docs.deepseek.com/zh-cn/news/news0802/) · [DeepSeek 多轮对话](https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat/) · [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [OpenAI 公告](https://openai.com/index/api-prompt-caching/) · [Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Anthropic Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) · [Anthropic Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) · [Anthropic 博客: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching) · [Claude Code env-vars](https://code.claude.com/docs/en/env-vars) · [Claude Code costs](https://code.claude.com/docs/en/costs)

**论文**：[MemGPT (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560) · [mem0 (arXiv:2504.19413)](https://arxiv.org/abs/2504.19413) · [context rot in long-horizon search (arXiv:2606.29718)](https://arxiv.org/abs/2606.29718) · [context rot in coding agents (arXiv:2607.17937)](https://arxiv.org/abs/2607.17937) · [classifier context rot (arXiv:2605.12366)](https://arxiv.org/abs/2605.12366)

**工程实践/第三方**：[Letta stateful agents](https://docs.letta.com/v1-sdk/concepts/stateful-agents/) · [mem0 research](https://mem0.ai/research) · [Cline PR#11480](https://github.com/cline/cline/pull/11480) · [Cline PR#11475](https://github.com/cline/cline/pull/11475) · [Cline issue#4002](https://github.com/cline/cline/issues/4002) · [Aider prompt caching](https://aider.chat/docs/usage/caching.html) · [free-web-ai-worker](https://github.com/augustlies/free-web-ai-worker) · [ofox DeepSeek 缓存实践(第三方)](https://ofox.ai/zh/blog/deepseek-v3-2-prompt-caching-setup-2026/) · [CloudZero DeepSeek pricing](https://www.cloudzero.com/blog/deepseek-pricing/) · [Reuters: V4 Pro 定价报道](https://www.reuters.com/5f374b32b07b/world/china/deepseek-releases-official-v4-pro-model-it-steps-up-expansion-2026-08-13/)
