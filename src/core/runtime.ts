/**
 * HarnessRuntime —— 装配 core 各部件的应用状态机（平台无关）。
 * 浏览器版由 src/platform/browser.ts 注入适配器；
 * 未来的小程序版只需提供 wx.request / wx storage 适配器即可复用本类全部逻辑。
 */
import type {
  AgentEvent,
  AppSettings,
  AssistantDraft,
  ProviderSetting,
  SessionModel,
  TodoItem,
} from './types'
import type {
  CodeSandbox,
  KVStore,
  SubagentRunner,
  ToolContext,
  Transport,
  VFileSystem,
} from './ports'
import { LLMClient } from './llm/client'
import { AgentRunner } from './agent/loop'
import { buildSystemPrompt } from './agent/prompts'
import { deriveTitle, newSession } from './session/session'
import { repairSessionIntegrity } from './session/repair'
import { createMainRegistry, createSubagentRegistry } from './tools'
import { genId, normalizePath } from './util/path'

export type RuntimeStatus = 'idle' | 'running'

export interface PendingAsk {
  id: string
  question: string
  options?: { label: string; description?: string }[]
}

export interface RuntimeSnapshot {
  rev: number
  status: RuntimeStatus
  booted: boolean
  sessions: { id: string; title: string; updatedAt: number }[]
  session: SessionModel | null
  draft: AssistantDraft | null
  ask: PendingAsk | null
  settings: AppSettings | null
  lastError: string | null
  providerLabel: string | null
  subagentNote: string | null
  /** 文件系统变更信号：仅在真实发生写操作时递增（避免流式期间高频 listAll） */
  fsRev: number
  /** 当前会话中智能体写入/修改过的文件（UI 高亮"执行效果"用） */
  writtenFiles: string[]
}

export const DEFAULT_PROVIDERS: ProviderSetting[] = [
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  { id: 'ollama', name: 'Ollama 本地', baseURL: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' },
]

const K_SETTINGS = 'app:settings'
const K_SESSION = (id: string) => `session:${id}`

export interface RuntimeDeps {
  kv: KVStore
  fs: VFileSystem
  transport: Transport
  sandbox: CodeSandbox
  now?: () => Date
  maxIterations?: number
}

export class HarnessRuntime {
  private settings: AppSettings | null = null
  private session: SessionModel | null = null
  private sessions: { id: string; title: string; updatedAt: number }[] = []
  private status: RuntimeStatus = 'idle'
  private booted = false
  private draft: AssistantDraft | null = null
  private ask: PendingAsk | null = null
  private askResolve: ((answer: string) => void) | null = null
  private lastError: string | null = null
  private subagentNote: string | null = null
  private abortController: AbortController | null = null
  /** 每会话的"已读文件"观测门状态 */
  private readFilesBySession = new Map<string, Set<string>>()
  private fsRev = 0
  private writtenBySession = new Map<string, Set<string>>()

  private listeners = new Set<() => void>()
  private snapshot: RuntimeSnapshot
  private rev = 0
  private notifyScheduled = false

  constructor(private deps: RuntimeDeps) {
    this.snapshot = this.buildSnapshot()
  }

  /* ---------------- 订阅（React useSyncExternalStore） ---------------- */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): RuntimeSnapshot => this.snapshot

  private buildSnapshot(): RuntimeSnapshot {
    const provider = this.activeProvider()
    return {
      rev: this.rev,
      status: this.status,
      booted: this.booted,
      sessions: this.sessions,
      session: this.session,
      draft: this.draft,
      ask: this.ask,
      settings: this.settings,
      lastError: this.lastError,
      providerLabel: provider ? `${provider.name} · ${provider.model}` : null,
      subagentNote: this.subagentNote,
      fsRev: this.fsRev,
      writtenFiles: [...(this.session ? this.writtenBySession.get(this.session.id) ?? [] : [])],
    }
  }

  private notify(): void {
    this.rev++
    this.snapshot = this.buildSnapshot()
    for (const fn of this.listeners) fn()
  }

  /** UI 高频刷新合并到下一帧 */
  private scheduleNotify(): void {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    const flush = () => {
      this.notifyScheduled = false
      this.notify()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
    else if (typeof setTimeout === 'function') setTimeout(flush, 16)
    else flush()
  }

  /* ---------------- 启动与设置 ---------------- */

  async boot(): Promise<void> {
    if (this.booted) return
    const stored = await this.deps.kv.get<AppSettings>(K_SETTINGS)
    this.settings = stored?.providers?.length
      ? stored
      : { providers: DEFAULT_PROVIDERS.map((p) => ({ ...p })), activeProviderId: 'deepseek', proxyTemplate: '', webSearch: null }
    await this.loadSessions()
    if (!this.session) this.createSession()
    this.booted = true
    this.notify()
  }

  private async loadSessions(): Promise<void> {
    const keys = await this.deps.kv.keys('session:')
    const sessions: SessionModel[] = []
    let repaired = false
    for (const k of keys) {
      const s = await this.deps.kv.get<SessionModel>(k)
      if (s && s.id && Array.isArray(s.messages)) {
        // 启动时修复历史会话中的悬空 tool_calls（页面刷新/崩溃留下的不合法序列）
        if (repairSessionIntegrity(s) > 0) {
          repaired = true
          await this.deps.kv.set(k, s)
        }
        sessions.push(s)
      }
    }
    if (repaired) console.info('[tim-harness] 已自动修复历史会话中的中断工具调用记录')
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    this.sessions = sessions.slice(0, 100).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }))
    this.session = sessions[0] ?? null
  }

  activeProvider(): ProviderSetting | null {
    if (!this.settings) return null
    return this.settings.providers.find((p) => p.id === this.settings!.activeProviderId) ?? this.settings.providers[0] ?? null
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    this.settings = settings
    await this.deps.kv.set(K_SETTINGS, settings)
    this.lastError = null
    this.notify()
  }

  /* ---------------- 会话管理 ---------------- */

  createSession(): SessionModel {
    const s = newSession()
    this.session = s
    this.readFilesBySession.set(s.id, new Set())
    this.sessions.unshift({ id: s.id, title: s.title, updatedAt: s.updatedAt })
    void this.persistSession()
    this.notify()
    return s
  }

  async selectSession(id: string): Promise<void> {
    if (this.status === 'running') return
    const s = await this.deps.kv.get<SessionModel>(K_SESSION(id))
    if (!s) return
    this.session = s
    this.lastError = null
    this.notify()
  }

  async deleteSession(id: string): Promise<void> {
    if (this.status === 'running' && this.session?.id === id) return
    await this.deps.kv.delete(K_SESSION(id))
    this.readFilesBySession.delete(id)
    this.sessions = this.sessions.filter((s) => s.id !== id)
    if (this.session?.id === id) {
      this.session = null
      const next = this.sessions[0]
      if (next) await this.selectSession(next.id)
      else this.createSession()
    }
    this.notify()
  }

  async renameSession(title: string): Promise<void> {
    if (!this.session) return
    this.session.title = title.trim() || this.session.title
    this.syncSessionMeta()
    await this.persistSession()
    this.notify()
  }

  private syncSessionMeta(): void {
    if (!this.session) return
    const meta = this.sessions.find((s) => s.id === this.session!.id)
    if (meta) {
      meta.title = this.session.title
      meta.updatedAt = this.session.updatedAt
    }
    this.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private async persistSession(): Promise<void> {
    if (!this.session) return
    await this.deps.kv.set(K_SESSION(this.session.id), this.session)
    this.syncSessionMeta()
  }

  /* ---------------- 主对话循环 ---------------- */

  get running(): boolean {
    return this.status === 'running'
  }

  async send(text: string): Promise<void> {
    const input = text.trim()
    if (!input || this.status === 'running' || !this.session) return
    const provider = this.activeProvider()
    if (!provider || !provider.baseURL) {
      this.lastError = '未配置模型服务：请在设置中选择或填写 Provider（baseURL / model / apiKey）。'
      this.notify()
      return
    }
    if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseURL)) {
      this.lastError = `Provider "${provider.name}" 缺少 API Key，请在设置中填写。`
      this.notify()
      return
    }

    if (this.session.messages.length === 0) {
      this.session.title = deriveTitle(input)
    }
    this.lastError = null
    this.status = 'running'
    this.abortController = new AbortController()
    this.notify()

    const client = new LLMClient(this.deps.transport, {
      name: provider.name,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey || undefined,
      model: provider.model,
      temperature: provider.temperature,
    })
    const registry = createMainRegistry({ transport: this.deps.transport, sandbox: this.deps.sandbox })
    const runner = new AgentRunner({
      client,
      registry,
      maxIterations: this.deps.maxIterations,
      buildSystemPrompt: () => this.systemPrompt(),
      buildContext: (signal) => this.buildContext(this.session!, signal),
      onEvent: (e) => this.onAgentEvent(e),
      onDraft: (d) => {
        this.draft = d
        this.scheduleNotify()
      },
    })

    const result = await runner.runTurn(this.session, input, this.abortController.signal)
    this.session.providerId = provider.id
    this.session.model = provider.model
    this.status = 'idle'
    this.abortController = null
    this.draft = null
    // 中止时若仍有挂起的 ask_user，释放并清理（其工具结果已由日志配平补齐）
    if (!result.ok && this.ask) {
      const resolve = this.askResolve
      this.ask = null
      this.askResolve = null
      resolve?.('')
    }
    if (!result.ok && result.error && !result.aborted) {
      this.lastError = result.error
    }
    await this.persistSession()
    this.notify()
  }

  stop(): void {
    this.abortController?.abort()
  }

  /* ---------------- 子代理 ---------------- */

  private subagentRunner = (): SubagentRunner => ({
    run: async (instruction: string, description?: string) => {
      const provider = this.activeProvider()
      if (!provider) return { ok: false, report: '未配置模型服务' }
      this.subagentNote = `子代理运行中：${description ?? '子任务'}`
      this.notify()
      const client = new LLMClient(this.deps.transport, {
        name: provider.name,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey || undefined,
        model: provider.model,
        temperature: provider.temperature,
      })
      const registry = createSubagentRegistry({
        transport: this.deps.transport,
        sandbox: this.deps.sandbox,
      })
      const subSession = newSession()
      const readFiles = new Set<string>()
      const todos: TodoItem[] = []
      const runner = new AgentRunner({
        client,
        registry,
        maxIterations: 16,
        buildSystemPrompt: () =>
          buildSystemPrompt({
            now: this.deps.now?.() ?? new Date(),
            timezone: this.timezone(),
            todos,
            hasSearchProvider: !!this.settings?.webSearch?.apiKey,
            hasProxy: !!this.settings?.proxyTemplate?.trim(),
          }),
        buildContext: (signal) => {
          const ctx: ToolContext = {
            fs: this.deps.fs,
            kv: this.deps.kv,
            emit: () => {},
            signal,
            subagent: { run: async () => ({ ok: false, report: '子代理不能再派生子代理' }) },
            ui: {
              askUser: async () => '(子代理无权向用户提问，请自行决策)',
            },
            state: {
              session: subSession,
              readFiles,
              todos,
              settings: this.settings ?? { providers: [], activeProviderId: '', proxyTemplate: '', webSearch: null },
            },
          }
          return ctx
        },
        onEvent: () => {},
        onDraft: () => {},
      })
      const result = await runner.runTurn(subSession, instruction, this.abortController?.signal ?? new AbortController().signal)
      const lastAssistant = [...subSession.messages].reverse().find((m) => m.role === 'assistant' && m.content)
      this.subagentNote = null
      this.notify()
      return {
        ok: result.ok,
        report: result.ok
          ? (lastAssistant?.content ?? '(子代理未产出文本)').slice(0, 16_000)
          : `子代理失败：${result.error ?? 'unknown'}\n${lastAssistant?.content ?? ''}`.slice(0, 8_000),
      }
    },
  })

  /* ---------------- 上下文与工具环境 ---------------- */

  private timezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  }

  private systemPrompt(): string {
    return buildSystemPrompt({
      now: this.deps.now?.() ?? new Date(),
      timezone: this.timezone(),
      todos: this.session?.todos ?? [],
      hasSearchProvider: !!this.settings?.webSearch?.apiKey,
      hasProxy: !!this.settings?.proxyTemplate?.trim(),
    })
  }

  private buildContext(session: SessionModel, signal: AbortSignal): ToolContext {
    let readFiles = this.readFilesBySession.get(session.id)
    if (!readFiles) {
      readFiles = new Set()
      this.readFilesBySession.set(session.id, readFiles)
    }
    return {
      fs: this.deps.fs,
      kv: this.deps.kv,
      emit: (e) => this.onAgentEvent(e),
      signal,
      subagent: this.subagentRunner(),
      ui: {
        askUser: (question, options) =>
          new Promise<string>((resolve) => {
            const id = genId('ask_')
            this.ask = { id, question, options }
            this.askResolve = resolve
            this.notify()
          }),
      },
      state: {
        session,
        readFiles,
        todos: session.todos,
        settings: this.settings ?? { providers: [], activeProviderId: '', proxyTemplate: '', webSearch: null },
      },
    }
  }

  answerAsk(id: string, answer: string): void {
    if (this.ask?.id !== id) return
    const question = this.ask.question
    this.ask = null
    const resolve = this.askResolve
    this.askResolve = null
    // 把用户的回答也留档到会话（对模型可见）
    this.session?.messages.push({
      role: 'user',
      content: `[回答 ask_user「${question}」] ${answer || '(跳过)'}`,
    })
    this.notify()
    resolve?.(answer)
  }

  private onAgentEvent(e: AgentEvent): void {
    if (e.type === 'tool_end') {
      // 文件写入类工具 → 递增 fsRev（驱动文件面板精准刷新）并记录"新写文件"
      if ((e.call.name === 'write_file' || e.call.name === 'edit_file') && e.result.ok) {
        try {
          const path = normalizePath(JSON.parse(e.call.arguments || '{}').path ?? '')
          if (path && path !== '/' && this.session) {
            let set = this.writtenBySession.get(this.session.id)
            if (!set) {
              set = new Set()
              this.writtenBySession.set(this.session.id, set)
            }
            set.add(path)
            this.fsRev++
          }
        } catch {
          /* args 解析失败忽略 */
        }
      }
      void this.persistSession()
      this.scheduleNotify()
      return
    }
    if (e.type === 'llm_end') {
      void this.persistSession()
      this.scheduleNotify()
    }
  }

  /* ---------------- 导入导出（UI 直接调用） ---------------- */

  async exportSession(): Promise<string> {
    if (!this.session) return ''
    return JSON.stringify(
      { kind: 'tim-harness-session', version: 1, session: this.session },
      null,
      2,
    )
  }

  async importSession(json: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(json)
      const s = parsed?.session ?? parsed
      if (!s?.id || !Array.isArray(s.messages)) return false
      s.usage = s.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      s.todos = Array.isArray(s.todos) ? s.todos : []
      await this.deps.kv.set(K_SESSION(s.id), s)
      this.sessions.unshift({ id: s.id, title: s.title || '导入会话', updatedAt: s.updatedAt || Date.now() })
      this.session = s
      this.notify()
      return true
    } catch {
      return false
    }
  }

  /** 导出整个虚拟工作区（base64 JSON bundle） */
  async exportWorkspace(): Promise<string> {
    const entries = await this.deps.fs.listAll()
    const files: Record<string, string> = {}
    for (const e of entries) {
      if (e.kind !== 'file') continue
      const bytes = await this.deps.fs.readBytes(e.path)
      let binary = ''
      for (const b of bytes) binary += String.fromCharCode(b)
      files[e.path] = btoa(binary)
    }
    return JSON.stringify({ kind: 'tim-harness-workspace', version: 1, files }, null, 2)
  }

  async importWorkspaceFiles(files: { path: string; content: string | Uint8Array }[]): Promise<number> {
    let n = 0
    for (const f of files) {
      await this.deps.fs.writeFile(f.path, f.content)
      n++
    }
    this.fsRev++
    this.notify()
    return n
  }

  get fsAdapter(): VFileSystem {
    return this.deps.fs
  }

  get kvAdapter(): KVStore {
    return this.deps.kv
  }

  clearError(): void {
    if (this.lastError) {
      this.lastError = null
      this.notify()
    }
  }
}
