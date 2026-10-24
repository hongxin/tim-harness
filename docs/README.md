# docs 索引

## 设计与路线

- [00-design.md](00-design.md) —— 设计书：问题定义、六边形架构、DSH/JetBot 思想继承表、演化路线
- [design-spec-v2.md](design-spec-v2.md) —— 视图设计对比：为什么 Anatomy 好（讲一个故事/语义位置/大小=重要性）
- [layout-constraints.md](layout-constraints.md) —— 布局约束与从 Anatomy 提取的学习原则

## 研究笔记（按编号即阅读顺序）

- [01-dsh-architecture-study.md](01-dsh-architecture-study.md) —— DeepSeek Harness 核心架构研究（305 包解剖）
- [02-jetbot-study.md](02-jetbot-study.md) —— JetBot 纯浏览器实践研究
- [03-dsh-token-economy.md](03-dsh-token-economy.md) —— DSH Token 经济
- [04-context-economy-research.md](04-context-economy-research.md) —— 上下文经济调研（前缀缓存计价、空闲时段）
- [07-taste-skill-notes.md](07-taste-skill-notes.md) —— 品味技能笔记

## 视图设计

- [05-wechat-poc.md](05-wechat-poc.md) —— 微信小程序 PoC（wx 四适配器，core 零改动）
- [08-cosmos-design-principles.md](08-cosmos-design-principles.md) —— Cosmos 设计原则
- [09-cosmos-v5-anatomy-compiler.md](09-cosmos-v5-anatomy-compiler.md) —— Anatomy 编译器方案（确定性渲染引擎）
- [10-agent-battlefield-design.md](10-agent-battlefield-design.md) —— 智能体战场模式设计

## 目录说明

- `screenshots/` —— README 与文档用截图
- `experiments/` —— 可视化实验产物（HTML/PNG/对照分析）；
  其中 `experiments/anatomy-engine/` 是 tim-harness 原理的交互机器图
  （独立 HTML 双主题，`node build.mjs [--light]` 重建）
