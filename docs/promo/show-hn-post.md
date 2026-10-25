# Show HN Post

## Title (31 chars — HN limit is 80, this is fine)

```
Show HN: Tim Harness – A full LLM coding agent in one browser page
```

## URL

```
https://hongxin.github.io/tim-harness/
```

## Body (first comment, posted immediately after submission)

---

I built a coding agent that lives entirely in a single browser page — no backend, no install, no Docker.

**What it does:** Open the page, paste an API key (DeepSeek, OpenAI, Gemini free tier, or local Ollama), and you get a multi-turn agent with 19 tools: file system (OPFS), JS code sandbox (Web Worker), web search, sub-agent spawning, task planning, and workspace snapshots.

**Key features:**

- **Token economy** — 5-layer cost optimization. Prefix caching alone saves 84-90% on DeepSeek input costs (measured). Three cost tiers: Eco / Standard / Full.
- **4 visualization modes** — Chat, 3D Cosmos (force-directed), Assembly Line (orthogonal routing with progressive disclosure), and Battlefield (RTS-style unit production view built with Three.js).
- **Goal-driven autopilot** — Set a goal, the agent runs full harness loops autonomously until done or blocked.
- **Free to try** — Preconfigured with Google Gemini free tier (15 RPM, no credit card needed).

**Architecture:** Hexagonal (ports & adapters). The core (`src/core/`) has zero browser API imports — validated by 160 smoke test assertions running in pure Node. The browser is just the first adapter; WeChat Mini Program is next.

**Security:** API keys stored only in your browser's IndexedDB. The JS sandbox blocks same-origin storage access. No data leaves your browser except API calls to your chosen provider.

**Tech stack:** TypeScript, React, Three.js, Web Workers, OPFS, IndexedDB. Zero backend dependencies.

Source code: https://github.com/hongxin/tim-harness

I'd love feedback on the visualization modes — especially the Battlefield view, which renders agent tool calls as RTS-style units (tanks for code execution, scouts for file reads, engineers for writes). It's a fun way to watch your agent work.

---
