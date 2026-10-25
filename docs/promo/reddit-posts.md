# Reddit Posts

## Post 1: r/LocalLLaMA

### Title
```
I built a zero-install LLM coding agent that runs entirely in your browser — works with Ollama, DeepSeek, and Gemini free tier
```

### Body
---

**Tim Harness** is a full LLM engineering harness that lives in one browser page. No backend, no install, no Docker.

**How to start with Ollama (fully offline):**
1. Run `OLLAMA_ORIGINS=* ollama serve`
2. Open https://hongxin.github.io/tim-harness/
3. Settings → Provider → "Ollama" → Done

**What you get:**
- Multi-turn agent with 19 tools (file system, JS sandbox, web search, sub-agents)
- Token economy that saves 84-90% on input costs (prefix caching + compression + folding)
- 4 visualization modes including an RTS-style "Battlefield" view where tool calls appear as game units
- Goal-driven autopilot (set a goal, agent runs until done)
- Workspace snapshots (lightweight git)

**Token savings breakdown (DeepSeek):**
- Prefix cache hit price: 1/50 of cache-miss
- Measured savings: 84-90% on input tokens
- Three cost tiers: Eco (48K budget) / Standard (140K) / Full (260K)

**Architecture:** Platform-agnostic core (zero browser APIs, 160 Node-only test assertions), browser adapter, WeChat Mini Program adapter coming.

Source: https://github.com/hongxin/tim-harness
Live demo: https://hongxin.github.io/tim-harness/

Would love feedback, especially from Ollama users — does the CORS setup work smoothly for you?

---

## Post 2: r/webdev

### Title
```
I built a full LLM coding agent using only browser APIs — IndexedDB, OPFS, Web Workers, zero backend
```

### Body
---

Most AI coding tools need a server. I wanted to see if a browser page alone could host a complete LLM harness.

**The result: Tim Harness** — https://hongxin.github.io/tim-harness/

**Browser APIs used:**
- **OPFS** (Origin Private File System) → persistent virtual workspace (survives refresh)
- **Web Workers** → JS code sandbox (isolated, timeout-terminated, storage-blocked)
- **IndexedDB** → session/settings/key-value storage
- **fetch + SSE** → streaming LLM API calls (OpenAI-compatible)
- **Three.js + Canvas 2D** → 4 visualization modes

**What makes it interesting (from a web dev perspective):**
- The core is platform-agnostic (hexagonal architecture, zero browser imports) — validated by tests running in pure Node
- Token optimization: prefix caching aligned with DeepSeek's pricing model (cache hits cost 1/50 of misses)
- The agent can write HTML files to the virtual workspace and preview them in a sandboxed iframe with console capture

**Try it:** Open the link, paste any OpenAI-compatible API key (Gemini has a free tier — no credit card needed).

Source: https://github.com/hongxin/tim-harness

Feedback welcome — especially on the OPFS file system and Worker sandbox approach.

---
