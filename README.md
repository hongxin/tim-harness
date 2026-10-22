# Tim Harness

中文 | **[English](README.en.md)**

**装进一个浏览器页面的随身大模型工程 Harness。**

[![CI](https://github.com/hongxin/tim-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/hongxin/tim-harness/actions/workflows/ci.yml)
[![Deploy](https://github.com/hongxin/tim-harness/actions/workflows/deploy.yml/badge.svg)](https://github.com/hongxin/tim-harness/actions/workflows/deploy.yml)

> 🌐 **[在线演示（打开即用，无需安装）](https://hongxin.github.io/tim-harness/)** —— 自备任意
> OpenAI 兼容 API Key（DeepSeek / OpenAI / 本地 Ollama），密钥只存在你自己的浏览器里。

打开页面 → 填一次 API Key → 你就拥有：多轮工具调用的智能体、持久化虚拟工作区、
JS 代码沙箱、子代理派发、任务清单 —— 全部运行在你的浏览器里，没有后端，没有安装。

```
┌────────────────────────── 你的浏览器 ──────────────────────────┐
│                                                                │
│   React UI ◀── HarnessRuntime ◀── Agent Loop（核心，平台无关）  │
│      │              │                  │                       │
│   IndexedDB      OPFS 虚拟FS       Web Worker 沙箱             │
│   (会话/设置)     (工作区文件)       (run_js 代码执行)           │
│                          │                                     │
└──────────────────────────┼─────────────────────────────────────┘
                           │ fetch (SSE 流式)
                           ▼
                 DeepSeek / OpenAI / Ollama / 任何 OpenAI 兼容端点
```

## 快速开始

```bash
cd tim-harness
npm install
npm run dev        # http://localhost:5188
```

1. 打开页面，点右上（侧栏底部）「设置」
2. 选择 Provider（默认预置 DeepSeek / OpenAI / 本地 Ollama），填入 API Key
3. 回到对话区，随便给一个任务，例如：
   > 用 run_js 计算斐波那契数列前 20 项，把结果写入 fib.md，并读回来确认。

**本地 Ollama（完全离线）**：`OLLAMA_ORIGINS=* ollama serve`，Provider 选「Ollama 本地」即可，无需 Key。

## 它能做什么

| 能力 | 说明 |
|---|---|
| 多轮工具调用 | 13 个工具：`ls / read_file / write_file / edit_file / grep / glob / run_js / web_fetch / web_search / todo_write / spawn_agent / ask_user / skill` |
| 技能系统 | `/skills/<名称>/SKILL.md` 自动入索引，`skill` 工具按需装载；智能体可自建技能沉淀工作流 |
| 富格式渲染 | GFM 表格（含列对齐）、任务列表、删除线、嵌套列表、代码块复制；LaTeX 公式（`$..$`/`$$..$$`，Unicode 兜底 + KaTeX 精确渲染） |
| 虚拟工作区 | OPFS 持久化文件系统（刷新不丢），支持导入/导出/下载 |
| 代码沙箱 | Web Worker 隔离执行，console 捕获，死循环 1.5s 内强制终止 |
| HTML 实时预览 | 沙箱 iframe + 控制台捕获与分级过滤，智能体写入自动刷新；大窗预览支持设备尺寸预设（375/768/1280）、新标签打开、Esc 关闭 |
| 可调工作区 | 右侧面板左缘可拖拽调宽（280–720px，自动记忆），便于动态观察生成中的页面 |
| 上下文管理 | 三层预算策略：旧工具结果自动折叠（近 4 条全文、ls/grep/glob 项目地图豁免），输入区实时显示上下文水位，长会话不爆窗 |
| 上下文压缩 ⚡ | LLM 把早期消息一次性总结为摘要，此后每轮只发"摘要+尾部"——token 按尾部计费；手动触发 + 水位 80% 自动压缩（可关），完整记录不受影响 |
| 工具审批（可选） | 设置开启后写操作需人工批准（允许一次，本会话记忆） |
| 拖拽导入 | 文件拖入窗口即入虚拟工作区；工具卡"静默成功、喧哗失败" |
| 子代理 | `spawn_agent` 派生独立上下文的子任务，节省主会话上下文 |
| 任务清单 | 智能体用 `todo_write` 维护计划，右侧面板实时投影 |
| 流式渲染 | 内容/思考链/工具调用全程流式，可随时停止 |
| 会话管理 | 多会话、重命名、删除、JSON 导入导出 |
| 双主题 | 深色 / 浅色 / 跟随系统 |

## 架构一览

```
src/
├── core/            # 平台无关核心（铁律：不 import 浏览器 API）
│   ├── runtime.ts   #   HarnessRuntime：装配 + 会话管理 + 状态机
│   ├── agent/       #   loop.ts（Agent Loop）· prompts.ts（系统提示词）
│   ├── llm/         #   client.ts（OpenAI 兼容流式）· sse.ts（SSE 解析）
│   ├── tools/       #   12 个工具 + 注册表（工厂装配）
│   ├── session/     #   会话模型 · 持久化
│   ├── ports.ts     #   四大端口：Transport / KVStore / VFileSystem / CodeSandbox
│   └── types.ts
├── platform/        # 浏览器适配器
│   ├── browser.ts   #   装配根（composition root）
│   ├── kv-idb.ts    #   IndexedDB KV
│   ├── fs-opfs.ts   #   OPFS 虚拟 FS（含内存降级）
│   ├── transport-fetch.ts  # fetch + 流式 body
│   ├── sandbox-worker.ts   # Worker 沙箱
│   └── worker/runner.ts    # 沙箱内部（console 捕获/结构化返回）
└── ui/              # React 界面（只做展示与交互，不碰 core 逻辑）
```

**为什么 core 要平台无关？** 长期目标是微信小程序版（wx.request / wx storage /
wx FileSystemManager 适配器）。core 的可移植性由 `npm run smoke` 持续验证：
在纯 Node 中以 mock 适配器跑通完整 agent loop（34 项断言）。

## 开发命令

```bash
npm run dev         # 开发服务器 http://localhost:5188
npm run build       # 生产构建（dist/）
npm run typecheck   # 全仓 strict 类型检查
npm run smoke       # Node 中跑 core 冒烟测试（可移植性保障）
node scripts/e2e-check.mjs   # 真实浏览器端到端检查（需 dev server + playwright）
```

## 研究与设计文档

- [docs/00-design.md](docs/00-design.md) —— 设计书：问题定义、六边形架构、DSH/JetBot 思想继承表、演化路线
- [docs/01-dsh-architecture-study.md](docs/01-dsh-architecture-study.md) —— DeepSeek Harness 核心架构研究（305 包解剖）
- [docs/02-jetbot-study.md](docs/02-jetbot-study.md) —— JetBot 纯浏览器实践研究

## 安全说明（请读）

- API Key 仅存本机 IndexedDB，不会发给除你所选 Provider 之外的任何一方；请勿在共享设备上保存密钥。
- 会话与文件仅存本机浏览器；「清空浏览器数据」会一并清除，重要内容请用导出功能备份。
- `run_js` 是计算沙箱（无 DOM、独立线程、超时终止），但不是网络隔离沙箱。
- `web_fetch` 受浏览器 CORS 约束，可配置代理模板（设置 → 网络）。

## 路线图

v0.1（当前）→ v0.2 事件溯源会话与 compaction / 工具审批 / HTML 预览 / 技能系统
→ v0.3 多模型路由 / goal 轮次驱动 → **v1.0 微信小程序版**（core 原样移植 + wx 适配器）。
