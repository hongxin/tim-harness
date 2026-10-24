# CLAUDE.md — tim-harness 开发约定（人机协同入口）

装进一个浏览器页面的随身大模型工程 Harness：多轮工具调用智能体 + 虚拟工作区 +
JS 沙箱，全部运行在浏览器里，无后端。详见 [README](README.md)。

## 三条铁律

1. **core 平台无关**：`src/core/` 严禁 import 浏览器 API。平台能力一律走
   `src/core/ports.ts` 的端口（Transport / KVStore / VFileSystem / CodeSandbox /
   UIInteractions / SubagentRunner），浏览器实现在 `src/platform/`。
   可移植性由 `npm run smoke`（纯 Node + mock 适配器）持续验证。
2. **会话日志是唯一真相，只追加不删改**。发给模型的上下文只是投影
   （`buildContextView` 折叠 / `effectiveMessages` 压缩视图）；编辑 = 截断重放，
   分叉 = 复制前缀，修复 = `repairSessionIntegrity` 配平悬空 tool_calls。
3. **提交前必须全绿**：`npx tsc --noEmit` + `npm run smoke`（CI 同款门禁，
   还有 wechat smoke 与 build）。

## 常用命令

```bash
npm run dev          # 开发服务器 http://localhost:5188
npm run typecheck    # strict 全仓类型检查（提交门禁）
npm run smoke        # core 冒烟（155 项断言，纯 Node 可移植性保障）
npm run smoke:wechat # 微信小程序 PoC 冒烟（wx 适配器）
npm run build        # 生产构建 dist/
node scripts/e2e-check.mjs  # 真实浏览器端到端（需 dev server）
```

## 架构地图

```
src/core/     平台无关核心（铁律 1 的领地）
  runtime.ts    HarnessRuntime：装配 + 会话管理 + 状态机 + 压缩
  agent/        loop.ts（回合循环）· context.ts（上下文投影）· prompts.ts（双通道）
  llm/          client.ts（OpenAI 兼容流式）· sse.ts
  tools/        18 个工具 + 注册表；fs.ts 体现"先读后写"纪律
  session/      会话模型 + repair.ts（日志配平）
  token-economy.ts  三档成本策略（eco/standard/full 全联动旋钮）
src/platform/ 浏览器适配器（browser.ts 是组合根）
src/ui/       React 界面，只做展示与交互；Three.js/Canvas 渲染器注意
              dispose 义务（见 git 历史的泄漏修复教训）
```

## 修改守则

- 改 core → 必须过 `smoke`；新增行为 → 先在 `scripts/smoke.ts` 写断言（TDD，
  现有 155 项是该文件的惯例样板）。
- UI 渲染器（Battlefield/Pipeline/Cosmos 等）：创建的 geometry/material 必须
  在重建/销毁路径 `dispose()`；事件监听必须在 `destroy()` 解绑。
- 消息序列合法性：`assistant.tool_calls` 与 `tool` 结果必须配平且相邻
  （OpenAI 协议）；任何写入会话日志的路径都要保证这一点。
- 提交信息：中文 conventional commits（feat/fix/docs…），一个逻辑改动一提交。

## 文档索引

见 [docs/README.md](docs/README.md)。可视化产物在 `docs/experiments/`
（含 anatomy-engine/：tim-harness 原理的交互机器图，`node build.mjs [--light]`
重建，依赖 `~/.claude/skills/anatomy` kit）。
