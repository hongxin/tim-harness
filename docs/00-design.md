# Tim Harness 设计书

> 目标：把一套完整的大模型 harness —— 会话、工具、文件系统、代码沙箱、子代理 ——
> 装进一个可以随时随地打开的浏览器页面；并让这套东西的"心脏"足够纯净，
> 未来可以原样搬进微信小程序。

配套文档：
- [01-dsh-architecture-study.md](01-dsh-architecture-study.md) —— DeepSeek Harness 核心架构研究（305 个包的解剖）
- [02-jetbot-study.md](02-jetbot-study.md) —— JetBot 纯浏览器 AI 助手实践研究

---

## 一、问题定义与核心思路

**"harness"的本质**不是 UI，而是一个能驱动模型持续做事的闭环：

```
        ┌─────────────────────────────────────────┐
        │                Agent Loop                │
        │                                          │
        │   用户意图 ──▶ LLM ──▶ 工具调用 ──▶ 结果   │
        │                 ▲                │        │
        │                 └──── 回灌 ◀─────┘        │
        │                                          │
        │   终止条件：无工具调用的最终回答 / 熔断      │
        └─────────────────────────────────────────┘
```

浏览器是这个闭环的**理想宿主**：
1. 沙箱安全 —— Web Worker / iframe / OPFS 天然隔离，"能力由构造保证"而非靠自觉；
2. 存储完备 —— IndexedDB（结构化）、OPFS（文件）、localStorage（偏好）；
3. 零安装 —— 打开页面即装载整套 harness，天然符合"随时随地"；
4. 直连推理 —— DeepSeek / OpenAI 等开放 API 均可从浏览器 `fetch` 直连（JetBot 已验证）。

DSH 用 305 个包回答了"harness 该有什么"；JetBot 用 1 个页面回答了"浏览器里能跑什么"。
tim-harness 站在两者之间：**继承 DSH 的 harness 思想，用 JetBot 验证过的浏览器工程手法实现，
但把架构约束收紧到"核心零平台依赖"，为小程序预留演化路径。**

---

## 二、架构：六边形（Ports & Adapters）

```
                    ┌───────────────────────────────┐
                    │        UI（React）             │  src/ui
                    │  会话流 · 工具卡片 · 工作区面板  │
                    └──────────────┬────────────────┘
                                   │ useSyncExternalStore
                    ┌──────────────▼────────────────┐
                    │      HarnessRuntime           │  src/core/runtime.ts
                    │  会话管理 · 装配 · 事件 · 状态机  │
                    ├───────────────────────────────┤
                    │           core                │  src/core
                    │  AgentLoop · LLM Client · SSE  │
                    │  Tools · Session · Prompts     │
                    └───────┬───────┬───────┬───────┘
                            │ 端口  │（ports.ts 接口）
            ┌───────────────┼───────┼───────────────┐
            ▼               ▼       ▼               ▼
      ┌──────────┐   ┌──────────┐ ┌──────────┐ ┌──────────┐
      │Transport │   │   KVStore │ │VFileSystem│ │CodeSandbox│  src/platform
      ├──────────┤   ├──────────┤ ├──────────┤ ├──────────┤
      │fetch(浏览器)│  │IndexedDB │ │ OPFS     │ │Web Worker │  ← 当前实现
      ├──────────┤   ├──────────┤ ├──────────┤ ├──────────┤
      │wx.request│   │wx storage│ │wx FileSystemManager││ 无/受限 │  ← 小程序适配器（未来）
      └──────────┘   └──────────┘ └──────────┘ └──────────┘
```

**铁律：`src/core` 不 import 任何浏览器/Node API。** 这不是洁癖，而是被
`npm run smoke` 持续验证的约束 —— 冒烟测试在纯 Node 中以 mock 适配器跑通
完整 agent loop（22 项断言），core 的可移植性是**测试保障的**，不是口头承诺。

| 端口 | 浏览器实现 | 小程序实现（未来） |
|---|---|---|
| `Transport` | `fetch` + ReadableStream → SSE | `wx.request`（enableChunked）→ SSE |
| `KVStore` | IndexedDB | wx.setStorageSync / 本地文件 |
| `VFileSystem` | OPFS（降级：内存+KV） | wx.getFileSystemManager |
| `CodeSandbox` | Web Worker（超时 terminate） | 受限：云端沙箱或纯解释器 |

---

## 三、从 DSH 继承的 harness 思想（及浏览器化改写）

| DSH 机制 | tim-harness v0.1 落地 | 演进方向 |
|---|---|---|
| 会话即事件日志 + surface 投影 | 会话 = JSON 消息数组，逐轮落盘 IndexedDB，可导出/导入 | v0.2：事件溯源 + replace 阴影化（compaction 的地基） |
| 系统提示双通道（稳定段 + 动态快照） | 单 system prompt，动态段（时间/时区/任务/能力诚实声明）每次构建 | v0.2：拆分为稳定段 + "supersedes" 快照，利于 provider 缓存 |
| 工具协议 fail-closed、错误物化 | 工具结果 `{ok, output}`，错误文本含纠正指引；未知工具/坏 JSON 参数返回结构化错误 | v0.2：稳定错误码 |
| **先读后写是机制不是约定** | `readFiles` 观测门：未 read 的现存文件拒绝 write/edit —— 与 DSH fs-observation-policy 同构 | 已实现（低成本复刻） |
| 审批缝（pre-execute waterfall） | 暂无（浏览器内工具全部无破坏性） | 需要时在 execute 前插 UI 审批 Promise 桥 |
| 三级沙箱 + 升级协议 | 浏览器即沙箱；工具能力面即权限面 | — |
| 子代理 spawn/fork | spawn 模式：独立上下文、禁递归、共享工作区 | v0.2：fork（以父会话前缀为种子） |
| todo / plan / goal 轮次驱动 | todo_write 全量替换 + 实时 UI 投影 | v0.2：goal 自动续轮 |
| 重试 durable + 幂等话术 | LLM 3 连败熔断；同签名工具调用连续失败 → 注入"换策略"警告（JetBot 手法） | — |
| 强制收尾 | 迭代上限后去工具再要一次最终回答 | — |

## 四、从 JetBot 继承的工程手法

- **手写 SSE 解析器**：半行缓冲、`[DONE]`、tool_calls 按 index 聚合、`reasoning_content` 分轨、空闲超时（JetBot 30s，本版 90s）。全部吸收进 `core/llm/`。
- **CORS 现实主义**：直连优先 → 失败走可配置代理模板（`{url}` 占位符）。DeepSeek/OpenAI 可直连；通用网页抓取需代理。
- **双级熔断 + 重复错误喊话**：AgenticLoop 的保险丝思想进 loop.ts。
- **升级 JetBot 的短板**：`js_eval` 主线程 `new Function`（超时杀不掉死循环）→ 本版改为 Web Worker + terminate，实测死循环 1.5s 精确终止；API key 从 localStorage 明文 → IndexedDB（仍在本地，见"安全边界"）。

## 五、工具面（v0.1 = 12 个）

```
文件   ls · read_file · write_file · edit_file · grep · glob     ← 虚拟工作区（OPFS）
计算   run_js                       ← Web Worker 沙箱（浏览器版 bash）
网络   web_fetch · web_search       ← 尽力而为：直连/代理；搜索可选配置
编排   todo_write · spawn_agent · ask_user
```

设计准则：每个工具的 description 本身就是给模型的操作规程（先读后写、
edit 唯一匹配、超时上限、失败换策略）；错误信息必须包含**下一步指引**。

## 六、安全边界（诚实声明）

1. **API Key** 存在本机 IndexedDB，不出浏览器；但浏览器存储对用户本人透明，
   共享设备场景请自行斟酌。会话导出 JSON 不含密钥。
2. **run_js** 在 Web Worker 中执行：无 DOM、无 localStorage、独立线程、超时即杀。
   但 Worker 内仍有 `fetch`（受 CORS 约束）—— 它是计算沙箱，不是网络隔离沙箱。
3. **web_fetch** 受浏览器 CORS 约束；代理模板由用户自行配置与信任。
4. Markdown 渲染先全量转义再生成受控标签（链接仅 http(s)，防注入式 XSS）。

## 七、演化路线（2026-10 复盘修订）

- **v0.1 ✅（完成且超额）**：完整闭环 —— 多会话、流式、13 工具、子代理、双主题、导入导出。
  规划外增量：会话配平修复、中止传播、HTML 预览+控制台+设备预设、可调面板、GitHub/CI/Pages、双语 README。
- **v0.2（进行中，4/6 已完成）**：
  - ✅ compaction —— 以"上下文视图折叠"形态落地（v0.1.3，非事件溯源版）
  - ✅ 工具审批缝（v0.1.3）✅ HTML 预览（v0.1.1）
  - ✅ **技能系统（v0.1.4）**：`/skills/<name>/SKILL.md` 自动索引入系统提示 + `skill` 工具按需装载；
    智能体可用 write_file 沉淀新技能，形成"越用越聪明"的正循环（DSH skill 思想）
  - ✅ Markdown 富格式（v0.1.4）：GFM 表格（含对齐）、任务列表、删除线、嵌套列表
  - ⏳ 事件溯源会话 + surface replace 原语（大重构，专轮做）
  - ⏳ 系统提示双通道（稳定段 + supersedes 快照，利于 provider 缓存）
- **v0.3**：多模型路由（子代理可用便宜模型）；goal 轮次驱动；工作区 git 化。
- **v1.0 小程序版**：`core` 原样移植 + wx 适配器四件套；UI 层用小程序组件重写
  （UI 与 core 本就单向数据流，`useSyncExternalStore` 的订阅模型可平移为小程序 store）。

**复盘结论**：前期被真实使用反馈牵引完成大量体验与正确性增强（方向正确，这是产品活下来的基础）；
v0.2 剩余两项均为架构性重构，宜各专一轮实施，避免与功能演进互相干扰。

## 七点五、JetBot 二期引入（v0.1.3）：增强而不改本质

综合对照研究文档 ② 与 tim-harness 现状后的选型决策：

| JetBot 特性 | 决策 | 理由 |
|---|---|---|
| **ContextManager 三层上下文管理** | ✅ 引入（core/agent/context.ts） | tim-harness 最大缺口：长会话必然爆窗。实现为"视图投影"——会话日志不动，发给模型的折叠视图（暗合 DSH surface 思想）：未超预算零成本快路径 → 旧工具结果折叠摘要（近 4 条全文、ls/grep/glob 项目地图豁免、错误保留）→ 仍超则滑窗丢最老整块并修复 API 配平 |
| **权限 Promise 桥（三级）** | ✅ 引入（可选，默认关） | DSH 审批缝的 JetBot 实现法。write_file/edit_file 批准一次会话内记忆；设置→数据 可开关；拒绝产生带指引的错误结果 |
| **拖拽导入 DropZone** | ✅ 引入 | 全窗口拖入即导入虚拟工作区（JetBot FileBridge） |
| **工具卡"静默成功、喧哗失败"** | ✅ 引入 | 成功默认折叠、失败自动展开 |
| 会话 Markdown 导出 | ✅ 新增 | 分享/归档友好（含思考链折叠与任务清单） |
| 浏览器内定时调度器 | ❌ 不引入 | 标签页关闭即停，制造"以为在跑"的虚假可靠性，违背诚实原则 |
| 跨会话记忆/历史召回注入 | ⏸ 缓 | 改变系统本质程度较高，待事件溯源会话落地后再评估 |
| 命令路由系统（/commands） | ⏸ 缓 | 当前复杂度不匹配 |

上下文水位在输入区实时显示（估算字符/预算百分比，折叠时琥珀色标注）。

## 八、验证矩阵

| 验证 | 方式 | 结果 |
|---|---|---|
| 类型 | `tsc --noEmit` 全仓 strict | ✅ |
| core 可移植性 | Node + mock 适配器跑通完整 loop | ✅ 30 断言（含会话配平/中止路径） |
| 生产构建 | `vite build` | ✅ gzip ≈ 73KB |
| 浏览器启动 | Playwright 真实浏览器 | ✅ 无页面错误 |
| Worker 沙箱 | 真实浏览器：正常/超时/async | ✅ |
| OPFS / IndexedDB | 真实浏览器读写删 | ✅ |
| 滚动约束链 | 视口锁定 + 自动跟随 + 回到最新 | ✅ e2e |
| HTML 预览 | 沙箱 iframe + console/error 回传 + 大窗 | ✅ e2e |
| 真实 LLM 端到端 | 用户填入 API Key 人工验证 | ✅（DeepSeek 实测可用） |

## 九、v0.1.1 GUI 深度改良记录（真实使用反馈驱动）

1. **滚动约束链修复（根因）**：`.app` grid 隐式行随内容长高、被 `overflow:hidden` 裁剪，
   对话区从未触发内部滚动 → `grid-template-rows: minmax(0,1fr)` + `min-height:0` 锁定视口，
   滚动约束正确传导；配套 ResizeObserver 自动跟随 + 可见滚动条 + 「回到最新」悬浮按钮。
2. **HTML 实时预览**（右面板新 tab）：opaque-origin 沙箱 iframe（`sandbox="allow-scripts"`
   系，无 `allow-same-origin`），注入 console/error 钩子 postMessage 回传，智能体写入自动
   刷新，支持大窗分栏（预览 + 控制台）。这是 JetBot 亮点的升级版。
3. **会话完整性（日志配平）**：中止/刷新导致的悬空 tool_calls 由 `repair.ts` 幂等补齐
   合成结果 —— loop 中止路径 + 启动加载历史会话两处触发，彻底杜绝 "下次发送 400"。
4. **中止传播修复**：`executeTool` 竞速加入 abort 分支，任何挂起中的工具（如 ask_user）
   都能被「停止」立即打断；挂起的 ask 卡片同步清理。
5. **性能**：文件列表刷新信号从"每次 UI 通知"改为 `fsRev`（仅真实文件写入递增），
   消除流式期间每帧 OPFS listAll。
6. **文件树**：目录分组可折叠；本会话智能体新写文件 `new` 高亮 + 预览 tab 琥珀点提示。
7. 细节：ask 卡片对齐到输入区宽度；运行中可预输入下一条消息；主题按钮语义化。
