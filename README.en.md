# Tim Harness

**[中文文档](README.md)** | English

**A full LLM engineering harness that lives in a single browser page.**

[![CI](https://github.com/hongxin/tim-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/hongxin/tim-harness/actions/workflows/ci.yml)
[![Deploy](https://github.com/hongxin/tim-harness/actions/workflows/deploy.yml/badge.svg)](https://github.com/hongxin/tim-harness/actions/workflows/deploy.yml)
[![Star History Chart](https://api.star-history.com/svg?repos=hongxin/tim-harness&type=Date)](https://star-history.com/#hongxin/tim-harness&Date)

> 🌐 **[Live demo — open and start, zero install](https://hongxin.github.io/tim-harness/)** — bring your own
> OpenAI-compatible API key (DeepSeek / OpenAI / local Ollama). Your key never leaves your browser.

Open the page → enter an API key once → you get a complete AI coding assistant:
multi-turn tool calling, a virtual file system, a code sandbox, sub-agent delegation —
all running inside your browser. No backend, no installation.

![Tim Harness Architecture](docs/diagram/architect.jpg)

## Quick Start

```bash
cd tim-harness
npm install
npm run dev        # http://localhost:5188
```

1. Open the page → click "Settings" → pick a provider → enter your API key
2. Give the agent any task, for example:
   > Use run_js to compute the first 20 Fibonacci numbers, write them to fib.md, then read it back to confirm.

**Local Ollama (fully offline):** run `OLLAMA_ORIGINS=* ollama serve`, choose the "Ollama" provider — no key needed.

## Core Features

**🔥 Extreme Token Economy** — Five cost defense layers: tool output slimming → prefix caching (DeepSeek cache-hit price is **1/50** of cache-miss, measured **84-90% input cost savings**) → view folding → incremental compression → one-click cost tiers. [→ Details](docs/04-context-economy-research.md)

**🎯 Goal-Driven Autopilot** — Set a goal and the agent autonomously executes in continuous rounds (full harness loop each round), self-reporting complete/blocked; supports pause/resume and round limits.

**⚡ Zero Install, Zero Backend** — Open a web page and start. OPFS persistent workspace, IndexedDB session storage, Web Worker code sandbox — your key never leaves your browser.

**📦 Complete Toolchain** — 18 tools: file read/write/edit/search, JS sandbox, web fetch/search, sub-agent spawning, task planning, skill system, workspace snapshots (lightweight git). [→ Full list](docs/features.md)

**🌌 Multi-Modal Visualization** — Four real-time switchable views: 💬 Chat / 🌌 Cosmos star map (3D force-directed) / 🏭 Assembly line (orthogonal routing + 3-level progressive disclosure) / ⚔️ Battlefield mode (Three.js RTS-style unit production). [→ Visualization design](docs/08-cosmos-design-principles.md)

<details>
<summary><b>📋 More Capabilities</b> (click to expand)</summary>

| Capability | Details |
|---|---|
| Multi-model routing | Sub-agents can use cheaper models while main session stays on a strong one |
| Skill system | `/skills/<name>/SKILL.md` auto-indexed; agents can create their own skills |
| Context compression | Auto-triggers at 80% capacity via LLM summarization; full log preserved |
| Tool approval | Optional; write operations require human approval |
| Session editing & forking | Edit-resend (truncate & replay), fork from any message |
| Rich rendering | GFM tables, task lists, LaTeX formulas, code block copy |
| HTML live preview | Sandboxed iframe + console capture, device size presets |
| WeChat Mini Program PoC | wx adapter validates zero-change core portability |

</details>

## Architecture

```
src/
├── core/            # Platform-agnostic core (rule: no browser API imports)
│   ├── runtime.ts   #   HarnessRuntime: assembly + session management + state machine
│   ├── agent/       #   loop.ts · prompts.ts · context.ts
│   ├── llm/         #   OpenAI-compatible streaming client + SSE parsing
│   ├── tools/       #   18 tools + registry
│   ├── session/     #   Session model · repair · persistence
│   └── token-economy.ts  # Three-tier cost policy
├── platform/        # Browser adapters (IndexedDB / OPFS / Worker / fetch)
└── ui/              # React interface + visualization renderers
```

**Portability**: the core passes 157 assertions in pure Node with mock adapters (`npm run smoke`),
targeting WeChat Mini Program deployment.

## Development

```bash
npm run dev         # http://localhost:5188
npm run build       # production build
npm run typecheck   # strict type check
npm run smoke       # core smoke test (157 assertions)
npm run smoke:wechat # WeChat PoC smoke
```

## Security

- API keys are stored only in your browser's IndexedDB, never sent to anyone except your chosen provider
- `run_js` is a compute sandbox (no DOM, separate thread, timeout termination, same-origin storage APIs blocked)
- "Clear browser data" will erase everything — use the export feature to back up important content

## Roadmap

v0.4 (current) → v0.5 multi-view polish → **v1.0 WeChat Mini Program**

---

📚 **[Full documentation](docs/README.md)** · 🔬 [Architecture study](docs/01-dsh-architecture-study.md) · 💰 [Token economy](docs/04-context-economy-research.md) · 🎨 [Visualization design](docs/08-cosmos-design-principles.md)
