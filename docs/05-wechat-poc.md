# 微信小程序 PoC（v1.0 起步）

> 目标：验证 tim-harness 的架构承诺 —— **core 零改动**，在微信小程序运行时原样驱动完整 agent 会话。
> 本 PoC 以真实 wx API 形状实现四件适配器，在 wx 环境模拟器（`scripts/wx-mock.ts`）中端到端验证。

## 架构

```
src/platform/wechat/
├── wx-types.ts     # wx API 最小结构化类型声明（request/Storage/FileSystemManager/env）
├── adapters.ts     # 四件适配器
│   ├── createWxTransport(wx)   # wx.request enableChunked → SSE 字节流（AbortSignal 支持）
│   ├── createWxKV(wx)          # wx Storage 同步 API → KVStore（thn: 前缀隔离）
│   ├── createWxFS(wx)          # FileSystemManager + USER_DATA_PATH → VFileSystem（mkdirp/readdir/stat）
│   └── createWxSandbox()       # 诚实降级：明确告知"小程序暂不支持 run_js"而非静默失败
└── boot.ts         # bootWechatHarness(wx)：装配根，core 原样运行
```

## 验证方式（无微信开发者工具条件下）

`npm run smoke:wechat`：以真实 wx API 形状的模拟器驱动，**刻意制造严苛条件**：

- SSE 以 **3 字节 ArrayBuffer 小块**下发（'微' 等 3 字节 UTF-8 字符必然被切开、半行缓冲考验）
- 完整 agent 会话：写文件（参数分片+中文内容）→ 读回 → 最终回答
- run_js 沙箱诚实降级断言
- "重启"（新 runtime 实例，Storage/文件保留）后会话恢复
- **删除全局 TextDecoder** 后纯 JS UTF-8 解码兜底（core/llm/sse.ts 新增）仍正确

11 项断言全部通过（见 CI）。

## 能力矩阵（诚实声明）

| 能力 | 浏览器 | 小程序 PoC | 说明 |
|---|---|---|---|
| LLM 流式（SSE） | ✅ fetch | ✅ wx.request enableChunked | 基础库 ≥2.20.1 |
| 会话/设置持久化 | ✅ IndexedDB | ✅ wx Storage | 10MB 上限，注意大工作区 |
| 虚拟工作区 | ✅ OPFS | ✅ FileSystemManager | USER_DATA_PATH，200MB 上限 |
| run_js 沙箱 | ✅ Web Worker | ❌ 诚实降级 | 微信 Worker 需 app.json 预配置且能力受限；PoC 明确报错引导 |
| HTML 预览 | ✅ iframe srcDoc | ❌ 不适用 | 小程序无 iframe；可用 web-view 组件（需业务域名）|
| 跨域 | 同源/CORS | 需合法域名白名单 | 小程序 request 仅允许在管理后台配置的 HTTPS 域名 |

## 真实小程序应用层的后续路线

1. **UI 层**（WXML/WXSS 页面，约 3-5 个页面）：会话列表/对话流/设置 —— 订阅 `runtime.getSnapshot()` 平移 `useSyncExternalStore` 模型
2. **域名配置**：DeepSeek API 域名加入小程序后台 request 合法域名（或经自有代理转发）
3. **Worker 评估**：如需 run_js，调研小程序 Worker（"workers" 目录预编译）或改用云端解释器
4. **HTML 预览替代**：web-view 组件（需业务域名）或截帧方案

## 与浏览器版的关系

两版共享全部 core（agent loop / 工具 / 压缩 / 快照 / 技能 / 目标驱动 / token 经济），
仅适配层与 UI 层分叉 —— 这正是六边形架构的兑现时刻。
