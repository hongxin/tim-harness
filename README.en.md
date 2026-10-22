# Tim Harness

**[中文文档](README.md)** | English

**A full LLM engineering harness that lives in a single browser page.**

[![CI](https://github.com/hongxin/tim-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/hongxin/tim-harness/actions/workflows/ci.yml)
[![Deploy](https://github.com/hongxin/tim-harness/actions/workflows/deploy.yml/badge.svg)](https://github.com/hongxin/tim-harness/actions/workflows/deploy.yml)

> 🌐 **[Live demo — open and start, zero install](https://hongxin.github.io/tim-harness/)** — bring your own
> OpenAI-compatible API key (DeepSeek / OpenAI / local Ollama). Your key never leaves your browser.

Open the page → enter an API key once → you get: an agent with multi-turn tool calling, a persistent
virtual workspace, a JavaScript code sandbox, sub-agent delegation, and a live task list — all running
inside your browser. No backend, no installation.

```
┌──────────────────────── Your Browser ────────────────────────┐
│                                                              │
│   React UI ◀── HarnessRuntime ◀── Agent Loop (platform-      │
│      │              │                 agnostic core)         │
│   IndexedDB      OPFS virtual FS     Web Worker sandbox      │
│   (sessions/     (workspace files)   (run_js execution)      │
│    settings)                   │                             │
└────────────────────────────────┼──────────────────────────────┘
                                 │ fetch (SSE streaming)
                                 ▼
                   DeepSeek / OpenAI / Ollama / any OpenAI-compatible endpoint
```

## Quick Start

```bash
cd tim-harness
npm install
npm run dev        # http://localhost:5188
```

1. Open the page, click "Settings" (bottom of the sidebar)
2. Pick a provider (DeepSeek / OpenAI / local Ollama are preconfigured) and enter your API key
3. Give the agent any task, for example:
   > Use run_js to compute the first 20 Fibonacci numbers, write them to fib.md, then read it back to confirm.

**Local Ollama (fully offline):** run `OLLAMA_ORIGINS=* ollama serve`, choose the "Ollama 本地" provider — no key needed.

## What It Can Do

| Capability | Details |
|---|---|
| Multi-turn tool calling | 12 tools: `ls / read_file / write_file / edit_file / grep / glob / run_js / web_fetch / web_search / todo_write / spawn_agent / ask_user` |
| Virtual workspace | OPFS-persistent file system (survives reloads), with import / export / download |
| Code sandbox | Isolated Web Worker execution with console capture; infinite loops terminated in ~1.5s |
| Live HTML preview | Sandboxed iframe + console capture with level filters; auto-refreshes when the agent writes. Big view adds device width presets (375/768/1280), open-in-new-tab, Esc to close |
| Resizable workspace | Drag the panel's left edge to widen it (280–720px, remembered) — handy for watching pages as they are being generated |
| Context management | Three-layer budget strategy: old tool outputs auto-folded (last 4 kept full, ls/grep/glob "project map" exempt); live context gauge above the input; long sessions never overflow |
| Tool approval (optional) | When enabled in settings, write operations require a human approval (once per session) |
| Drag & drop | Drop files anywhere to import them into the workspace; tool cards "quiet on success, loud on failure" |
| Sub-agents | `spawn_agent` runs self-contained tasks in a fresh context to conserve the main conversation |
| Task list | The agent maintains its plan with `todo_write`, projected live in the side panel |
| Streaming | Content / reasoning / tool calls all stream in real time; stop at any moment |
| Sessions | Multiple sessions, rename, delete, JSON import/export |
| Themes | Dark / light / follow system |

## Architecture at a Glance

```
src/
├── core/            # Platform-agnostic core (hard rule: no browser API imports)
│   ├── runtime.ts   #   HarnessRuntime: composition + session management + state machine
│   ├── agent/       #   loop.ts (Agent Loop) · prompts.ts (system prompt)
│   ├── llm/         #   client.ts (OpenAI-compatible streaming) · sse.ts (SSE parser)
│   ├── tools/       #   12 tools + registry (factory wiring)
│   ├── session/     #   session model · persistence
│   ├── ports.ts     #   The four ports: Transport / KVStore / VFileSystem / CodeSandbox
│   └── types.ts
├── platform/        # Browser adapters
│   ├── browser.ts   #   Composition root
│   ├── kv-idb.ts    #   IndexedDB KV
│   ├── fs-opfs.ts   #   OPFS virtual FS (with in-memory fallback)
│   ├── transport-fetch.ts  # fetch + streaming body
│   ├── sandbox-worker.ts   # Worker sandbox
│   └── worker/runner.ts    # Sandbox internals (console capture / structured returns)
└── ui/              # React interface (presentation only, never touches core logic)
```

**Why a platform-agnostic core?** The long-term goal is a WeChat Mini Program edition
(`wx.request` / wx storage / `wx.getFileSystemManager` adapters). Core portability is
continuously verified by `npm run smoke`: the complete agent loop runs in plain Node with
mock adapters (30+ assertions).

## Development

```bash
npm run dev         # Dev server at http://localhost:5188
npm run build       # Production build (dist/)
npm run typecheck   # Strict typecheck for the whole repo
npm run smoke       # Core smoke test in Node (portability guarantee)
node scripts/e2e-check.mjs   # Real-browser end-to-end checks (needs dev server + playwright)
```

## Research & Design Notes

- [docs/00-design.md](docs/00-design.md) — Design doc: problem definition, hexagonal architecture,
  DSH/JetBot idea-inheritance table, evolution roadmap (in Chinese)
- [docs/01-dsh-architecture-study.md](docs/01-dsh-architecture-study.md) — DeepSeek Harness core
  architecture study (305-package dissection, in Chinese)
- [docs/02-jetbot-study.md](docs/02-jetbot-study.md) — JetBot pure-browser AI assistant study (in Chinese)

## Security Notes (please read)

- API keys are stored only in your browser's IndexedDB and are sent to no one except your chosen
  provider. Do not save keys on shared devices.
- Sessions and files live only in your browser; "clear site data" wipes them. Use the export
  feature to back up anything important.
- `run_js` is a compute sandbox (no DOM, dedicated thread, timeout kill) — not a network-isolation sandbox.
- `web_fetch` is subject to browser CORS; a proxy template can be configured (Settings → Network).

## Roadmap

v0.1 (current) → v0.2 event-sourced sessions & compaction / tool approval / skills
→ v0.3 multi-model routing / goal-round driving → **v1.0 WeChat Mini Program edition**
(core ported as-is + wx adapters).
