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
  SessionOp,
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
import { buildRuntimeSnapshot, buildStablePrompt } from './agent/prompts'
import { deriveTitle, effectiveMessages, newSession } from './session/session'
import { repairSessionIntegrity } from './session/repair'
import { createMainRegistry, createSubagentRegistry } from './tools'
import { scanSkills, type SkillMeta } from './tools/skills'
import { buildContextView, estimateChars } from './agent/context'
import { tierPolicy } from './token-economy'
import {
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  saveSnapshot,
  type WorkspaceSnapshot,
} from './workspace-snapshots'
import type { GoalState } from './types'
import { genId, normalizePath } from './util/path'

export type RuntimeStatus = 'idle' | 'running'

export interface PendingAsk {
  id: string
  question: string
  options?: { label: string; description?: string }[]
}

export interface PendingApproval {
  id: string
  tool: string
  summary: string
}

export interface ContextInfo {
  /** 折叠前原始估算（压力指标：会话真实体量） */
  rawChars: number
  /** 折叠后实际发送给模型的估算（真实成本水位） */
  sentChars: number
  budgetChars: number
  masked: boolean
}

export interface RuntimeSnapshot {
  rev: number
  status: RuntimeStatus
  booted: boolean
  sessions: { id: string; title: string; updatedAt: number }[]
  session: SessionModel | null
  draft: AssistantDraft | null
  ask: PendingAsk | null
  /** 审批缝：写类工具等待用户批准 */
  approval: PendingApproval | null
  /** 上下文水位（估算字符量 / 预算 / 是否已折叠） */
  contextInfo: ContextInfo | null
  /** 正在执行上下文压缩（LLM 摘要） */
  compacting: boolean
  /** 编辑用户消息后预填到输入区的文本（一次性） */
  composerPrefill: string | null
  /** 快照集合变更信号 */
  snapRev: number
  settings: AppSettings | null
  lastError: string | null
  providerLabel: string | null
  subagentNote: string | null
  /** 文件系统变更信号：仅在真实发生写操作时递增（避免流式期间高频 listAll） */
  fsRev: number
  /** 当前会话中智能体写入/修改过的文件（UI 高亮"执行效果"用） */
  writtenFiles: string[]
  /** 已发现的技能（/skills/<name>/SKILL.md） */
  skills: SkillMeta[]
}

export const DEFAULT_PROVIDERS: ProviderSetting[] = [
  // DeepSeek-V4.1-Flash（1017 版），官方当前建议的默认模型；API model id: deepseek-flash
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash' },
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  { id: 'ollama', name: 'Ollama 本地', baseURL: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' },
]

/** 模型显示名（顶栏芯片用） */
const MODEL_LABELS: Record<string, string> = {
  'deepseek-flash': 'DeepSeek V4.1 Flash',
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
}

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model
}

/** 模型默认值迁移：旧缺省 → 新缺省（只动恰好等于旧默认值的，尊重用户自定义） */
const MODEL_MIGRATIONS: Record<string, Record<string, string>> = {
  deepseek: { 'deepseek-chat': 'deepseek-flash' },
}

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
  private approval: PendingApproval | null = null
  private approvalResolve: ((d: 'allow' | 'deny') => void) | null = null
  /** 每会话已批准的写类工具（risky 级：问一次，会话内记住） */
  private approvedToolsBySession = new Map<string, Set<string>>()
  private lastError: string | null = null
  private subagentNote: string | null = null
  private abortController: AbortController | null = null
  /** 每会话的"已读文件"观测门状态 */
  private readFilesBySession = new Map<string, Set<string>>()
  private fsRev = 0
  private writtenBySession = new Map<string, Set<string>>()
  private skills: SkillMeta[] = []
  private compactingFlag = false
  private composerPrefill: string | null = null
  private snapRevCounter = 0
  private goalLoopRunning = false

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
    let contextInfo: ContextInfo | null = null
    if (this.session) {
      const policy = tierPolicy(this.settings)
      const view = buildContextView(effectiveMessages(this.session), policy.budgetChars, policy.recentFullResults)
      contextInfo = {
        rawChars: view.info.estChars,
        sentChars: estimateChars(view.messages),
        budgetChars: view.info.budgetChars,
        masked: view.info.masked,
      }
    }
    return {
      rev: this.rev,
      status: this.status,
      booted: this.booted,
      sessions: this.sessions,
      session: this.session,
      draft: this.draft,
      ask: this.ask,
      approval: this.approval,
      contextInfo,
      compacting: this.compactingFlag,
      composerPrefill: this.composerPrefill,
      snapRev: this.snapRevCounter,
      settings: this.settings,
      lastError: this.lastError,
      providerLabel: provider ? `${provider.name} · ${modelLabel(provider.model)}` : null,
      subagentNote: this.subagentNote,
      fsRev: this.fsRev,
      writtenFiles: [...(this.session ? this.writtenBySession.get(this.session.id) ?? [] : [])],
      skills: this.skills,
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
    if (stored?.providers?.length) {
      // 存量设置迁移：把恰好为旧默认模型名的 provider 升级到新默认（不动 Key 等自定义字段）
      let migrated = false
      for (const p of stored.providers) {
        const table = MODEL_MIGRATIONS[p.id]
        if (table && table[p.model]) {
          p.model = table[p.model]
          migrated = true
        }
      }
      if (!stored.toolApproval) stored.toolApproval = 'off'
      if (!stored.autoCompact) stored.autoCompact = 'on'
      if (!stored.costTier) stored.costTier = 'standard'
      this.settings = stored
      if (migrated) await this.deps.kv.set(K_SETTINGS, stored)
    } else {
      this.settings = {
        providers: DEFAULT_PROVIDERS.map((p) => ({ ...p })),
        activeProviderId: 'deepseek',
        proxyTemplate: '',
        webSearch: null,
        toolApproval: 'off',
        autoCompact: 'on',
      }
    }
    await this.loadSessions()
    if (!this.session) this.createSession()
    await this.refreshSkills()
    this.booted = true
    this.notify()
  }

  /** 扫描 /skills/ 下各技能的 SKILL.md，变更时通知（系统提示注入 + UI 展示） */
  async refreshSkills(): Promise<void> {
    let next: SkillMeta[]
    try {
      next = await scanSkills(this.deps.fs)
    } catch {
      return
    }
    if (JSON.stringify(next) !== JSON.stringify(this.skills)) {
      this.skills = next
      if (this.booted) this.notify()
    }
  }

  private async loadSessions(): Promise<void> {
    const keys = await this.deps.kv.keys('session:')
    const sessions: SessionModel[] = []
    let repaired = false
    for (const k of keys) {
      const s = await this.deps.kv.get<SessionModel>(k)
      if (s && s.id && Array.isArray(s.messages)) {
        // 启动时修复历史会话中的悬空 tool_calls（页面刷新/崩溃留下的不合法序列）
        const fixed = repairSessionIntegrity(s)
        // 浏览器现实：重载后不可能有后台轮次 → 活动目标诚实转为暂停
        if (s.goal?.status === 'active') {
          s.goal.status = 'paused'
          s.goal.note = '页面重载，已自动暂停（点击继续可恢复推进）'
          s.goal.updatedAt = Date.now()
        }
        if (fixed > 0 || s.goal?.status === 'paused') {
          repaired = true
          if (!s.ops) s.ops = []
          s.ops.push({ op: 'repair', ts: Date.now(), note: `${fixed} dangling tool calls` })
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
    this.approvedToolsBySession.delete(id)
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

  /** 发送一轮；返回 false 表示本轮未真正执行（守卫拦截，如缺 Key / 正在运行） */
  async send(text: string): Promise<boolean> {
    const input = text.trim()
    if (!input || this.status === 'running' || !this.session) return false
    const provider = this.activeProvider()
    if (!provider || !provider.baseURL) {
      this.lastError = '未配置模型服务：请在设置中选择或填写 Provider（baseURL / model / apiKey）。'
      this.notify()
      return false
    }
    if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseURL)) {
      this.lastError = `Provider "${provider.name}" 缺少 API Key，请在设置中填写。`
      this.notify()
      return false
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
      buildStablePrompt: () => this.stablePrompt(),
      buildSnapshot: (masked) => this.runtimeSnapshot(masked),
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
    // 中止时若仍有挂起的 ask_user / 审批，释放并清理（其工具结果已由日志配平补齐）
    if (!result.ok) {
      if (this.ask) {
        const resolveAsk = this.askResolve
        this.ask = null
        this.askResolve = null
        resolveAsk?.('')
      }
      if (this.approval) {
        const resolveApproval = this.approvalResolve
        this.approval = null
        this.approvalResolve = null
        resolveApproval?.('deny')
      }
    }
    if (!result.ok && result.error && !result.aborted) {
      this.lastError = result.error
    }
    // 用户主动中止 → 活动目标同步暂停（诚实语义：没有后台轮次）
    if (result.aborted && this.session?.goal?.status === 'active') {
      this.session.goal.status = 'paused'
      this.session.goal.note = '用户停止，目标已暂停'
      this.session.goal.updatedAt = Date.now()
    }
    await this.persistSession()
    this.notify()
    // 自动压缩：按"折叠后实际发送水位"触发（与 UI 水位表同源同语义）
    const policy = tierPolicy(this.settings)
    const effView = buildContextView(effectiveMessages(this.session), policy.budgetChars, policy.recentFullResults)
    const sentChars = estimateChars(effView.messages)
    if (this.settings?.autoCompact !== 'off' && sentChars > policy.budgetChars * policy.autoCompactAt) {
      void this.compactSession(true)
    }
    return true
  }

  /**
   * 上下文压缩（DSH surface 思想）：用一次 LLM 调用把 [0, 最后一条 user) 的
   * 消息总结为摘要；日志不动，后续每轮只发"摘要 + 尾部"。
   */
  async compactSession(auto = false): Promise<boolean> {
    if (this.status === 'running' || this.compactingFlag || !this.session) return false
    const provider = this.activeProvider()
    if (!provider?.baseURL) return false
    if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseURL)) {
      if (!auto) {
        this.lastError = '压缩需要可用的模型服务（当前 Provider 缺 Key）。'
        this.notify()
      }
      return false
    }
    const s = this.session
    // 折叠边界：最后一条 user 消息之前（保证当前任务上下文完整）
    let lastUser = -1
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role === 'user') {
        lastUser = i
        break
      }
    }
    if (lastUser < 2) {
      if (!auto) {
        this.lastError = '会话还没有可折叠的早期内容。'
        this.notify()
      }
      return false
    }
    const policy = tierPolicy(this.settings)
    // 守卫按"字符量"而非消息条数——胖而短的会话（少而肥的工具结果）同样需要压缩
    const headChars = estimateChars(s.messages.slice(0, lastUser))
    const minWorth = Math.max(4_000, policy.budgetChars * 0.08)
    if (headChars < minWorth) {
      if (!auto) {
        this.lastError = `可折叠的早期内容还太少（约 ${headChars.toLocaleString()} 字符，低于 ${minWorth.toLocaleString()}），暂不值得压缩。`
        this.notify()
      }
      return false
    }
    // 已压缩且新增段字符量不足 → 跳过自动
    if (auto && s.compacted && lastUser > s.compacted.foldedCount) {
      const segChars = estimateChars(s.messages.slice(s.compacted.foldedCount, lastUser))
      if (segChars < Math.max(2_000, policy.budgetChars * 0.05)) return false
    }
    // 已压缩且无新增内容（手动触发也无事可做）
    if (s.compacted && lastUser === s.compacted.foldedCount) {
      if (!auto) {
        this.lastError = '自上次压缩后没有新内容，无需再次压缩。'
        this.notify()
      }
      return false
    }

    this.compactingFlag = true
    this.notify()
    try {
      const client = new LLMClient(this.deps.transport, {
        name: provider.name,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey || undefined,
        model: provider.model,
        temperature: 0,
      })
      // 增量压缩：已有摘要时只总结 [foldedCount, lastUser) 新增段，追加到摘要尾部
      // （单次成本只与新段相关 → 可以放心在高频阈值下触发）
      const prev = s.compacted
      const segStart = prev && prev.foldedCount < lastUser ? prev.foldedCount : 0
      const segment = s.messages.slice(segStart, lastUser)
      const incremental = segStart > 0
      // 摘要请求 = 原对话前缀逐字重放 + 末尾 user 指令（DSH 做法：复用 provider 前缀缓存，
      // 使摘要调用本身的输入大部分走缓存价）
      const instruction = incremental
        ? 'Update the rolling summary for this conversation. The block at the top (starting with "[Conversation ' +
          'compacted") is the EXISTING summary — do not repeat it. Summarize ONLY the messages between that block ' +
          'and the most recent user message: append a concise delta (markdown, ≤200 words) covering new decisions, ' +
          'workspace changes (exact paths), findings, and updated next steps. Preserve exact file paths and numbers. ' +
          'Write in the conversation language. Output ONLY the update.'
        : 'Compress this conversation (everything BEFORE the most recent user message) into a summary with EXACTLY ' +
          'these markdown sections:\n## Primary Request — the user\'s original task & constraints\n' +
          '## Key Decisions & Findings\n## Workspace State — files (exact paths) + purpose, todos\n' +
          '## Errors & Fixes\n## Pending Jobs\n## Current Work — what was in flight at the end\n' +
          '## Next Step\n## Critical Context — numbers, names, URLs that must survive verbatim\n' +
          'Rules: ≤500 words; preserve exact file paths and numbers; write in the conversation language. ' +
          'Output ONLY the summary.'
      let summary = ''
      // 缓存对齐（关键）：摘要请求复用与主对话完全相同的前缀 [稳定 system + 同一视图]，
      // 仅以指令替换尾部的快照消息 → 输入几乎全部命中前缀缓存（DSH 做法）。
      // 此前"片段裸发"从第 0 token 起就与缓存前缀不符，整包按未命中价计费。
      const summaryMessages = effectiveMessages(s)
      const summaryView = buildContextView(summaryMessages, policy.budgetChars, policy.recentFullResults)
      for await (const chunk of client.streamChat({
        messages: [
          { role: 'system', content: this.stablePrompt() },
          ...summaryView.messages,
          { role: 'user', content: instruction },
        ],
      })) {
        if (chunk.content) summary += chunk.content
      }
      summary = summary.trim()
      if (!summary) return false
      // 收敛校验（DSH 思想）：摘要必须显著小于被替换段，否则压缩无意义
      const segChars = estimateChars(segment)
      if (segChars > 2_000 && summary.length > segChars * 0.6) {
        console.warn('[tim-harness] 压缩摘要未收敛，放弃本次压缩')
        return false
      }
      const merged = incremental ? (prev!.summary + '\n\n## 增量更新\n' + summary).slice(-12_000) : summary
      s.compacted = { summary: merged, foldedCount: lastUser, createdAt: prev?.createdAt ?? Date.now(), model: provider.model }
      this.recordOp(s, 'compact', lastUser, `${lastUser - segStart} messages folded (${incremental ? 'incremental' : 'full'})`)
      await this.persistSession()
      this.notify()
      return true
    } catch (err) {
      console.warn('[tim-harness] compact 失败', err)
      if (!auto) {
        this.lastError = `压缩失败：${err instanceof Error ? err.message : err}`
        this.notify()
      }
      return false
    } finally {
      this.compactingFlag = false
      this.notify()
    }
  }

  stop(): void {
    this.abortController?.abort()
  }

  /* ---------------- 子代理 ---------------- */

  private subagentRunner = (): SubagentRunner => ({
    run: async (instruction: string, description?: string) => {
      // 多模型路由：子代理可用更便宜的 provider（设置中配置）
      const provider =
        this.settings?.providers.find((p) => p.id === this.settings?.subagentProviderId) ??
        this.activeProvider()
      if (!provider) return { ok: false, report: '未配置模型服务' }
      const main = this.activeProvider()
      const via = main && provider.id !== main.id ? ` · ${provider.name}/${provider.model}` : ''
      this.subagentNote = `子代理运行中：${description ?? '子任务'}${via}`
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
        buildStablePrompt: () => this.stablePrompt(),
        buildSnapshot: () => this.runtimeSnapshot(false),
        buildContext: (signal) => {
          const ctx: ToolContext = {
            fs: this.deps.fs,
            kv: this.deps.kv,
            emit: () => {},
            signal,
            subagent: { run: async () => ({ ok: false, report: '子代理不能再派生子代理' }) },
            ui: {
              askUser: async () => '(子代理无权向用户提问，请自行决策)',
              approve: (toolName, summary) => this.approveBridge(subSession.id, toolName, summary),
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

  private stablePrompt(): string {
    return buildStablePrompt({
      now: this.deps.now?.() ?? new Date(),
      timezone: this.timezone(),
      todos: this.session?.todos ?? [],
      hasSearchProvider: !!this.settings?.webSearch?.apiKey,
      hasProxy: !!this.settings?.proxyTemplate?.trim(),
      skills: this.skills,
    })
  }

  private runtimeSnapshot(masked?: boolean): string {
    return buildRuntimeSnapshot({
      now: this.deps.now?.() ?? new Date(),
      timezone: this.timezone(),
      todos: this.session?.todos ?? [],
      hasSearchProvider: !!this.settings?.webSearch?.apiKey,
      hasProxy: !!this.settings?.proxyTemplate?.trim(),
      skills: this.skills,
      masked,
      compacted: !!this.session?.compacted,
    })
  }

  /* ---------------- Surface 操作（事件溯源精神的审计面） ---------------- */

  private recordOp(session: SessionModel, op: SessionOp['op'], at?: number, note?: string): void {
    if (!session.ops) session.ops = []
    session.ops.push({ op, at, ts: Date.now(), note })
    if (session.ops.length > 100) session.ops = session.ops.slice(-100)
  }

  /**
   * 编辑用户消息（surface replace 原语）：截断该消息及其后全部内容，
   * 原文返回给输入区供修改重发。截断后立即日志配平。
   */
  editUserMessage(atIndex: number): string | null {
    if (this.status === 'running' || !this.session) return null
    const msgs = this.session.messages
    if (atIndex < 0 || atIndex >= msgs.length || msgs[atIndex].role !== 'user') return null
    const text = msgs[atIndex].content ?? ''
    const removed = msgs.length - atIndex
    msgs.length = atIndex
    // 压缩边界若越界则失效（尾部整体被替换）
    if (this.session.compacted && this.session.compacted.foldedCount >= msgs.length) {
      this.session.compacted = undefined
    }
    repairSessionIntegrity(this.session)
    this.recordOp(this.session, 'edit-truncate', atIndex, `removed ${removed} messages`)
    void this.persistSession()
    this.composerPrefill = text
    this.notify()
    return text
  }

  /** 从某条用户消息处分叉新会话（复制 [0, atIndex]），并切换过去 */
  async forkSession(atIndex: number, titleSuffix = '（分叉）'): Promise<string | null> {
    if (this.status === 'running' || !this.session) return null
    const src = this.session
    if (atIndex < 0 || atIndex >= src.messages.length || src.messages[atIndex].role !== 'user') return null
    const forked = newSession()
    forked.title = src.title.slice(0, 22) + titleSuffix
    forked.messages = src.messages.slice(0, atIndex + 1).map((m) => ({ ...m }))
    forked.todos = src.todos.map((t) => ({ ...t }))
    if (src.compacted && src.compacted.foldedCount < forked.messages.length) {
      forked.compacted = { ...src.compacted }
    }
    this.recordOp(forked, 'fork', atIndex, `from ${src.id} @${atIndex}`)
    this.recordOp(src, 'fork-source', atIndex, `to ${forked.id}`)
    // 观测门状态沿用（读过的文件仍算读过）
    const reads = this.readFilesBySession.get(src.id)
    if (reads) this.readFilesBySession.set(forked.id, new Set(reads))
    await this.deps.kv.set(K_SESSION(forked.id), forked)
    this.sessions.unshift({ id: forked.id, title: forked.title, updatedAt: forked.updatedAt })
    this.session = forked
    void this.persistSession()
    this.notify()
    return forked.id
  }

  clearComposerPrefill(): void {
    if (this.composerPrefill !== null) {
      this.composerPrefill = null
      this.notify()
    }
  }

  /* ---------------- 目标驱动（DSH goal 轮次驱动） ---------------- */

  /** 用户发起目标：自动连续推进直到 complete/blocked/上限/用户暂停 */
  startGoal(objective: string, maxRounds = 8): void {
    if (this.status === 'running' || !this.session || !objective.trim()) return
    const goal: GoalState = {
      objective: objective.trim().slice(0, 500),
      status: 'active',
      rounds: 0,
      maxRounds: Math.min(Math.max(Math.round(maxRounds) || 8, 1), 20),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.session.goal = goal
    this.recordOp(this.session, 'goal', undefined, `start: ${goal.objective.slice(0, 40)}`)
    void this.persistSession()
    this.notify()
    void this.driveGoal()
  }

  pauseGoal(note = '用户暂停'): void {
    const g = this.session?.goal
    if (!g || g.status !== 'active') return
    g.status = 'paused'
    g.note = note
    g.updatedAt = Date.now()
    void this.persistSession()
    this.notify()
  }

  resumeGoal(): void {
    const g = this.session?.goal
    if (!g || g.status !== 'paused') return
    g.status = 'active'
    g.note = undefined
    g.updatedAt = Date.now()
    void this.persistSession()
    this.notify()
    void this.driveGoal()
  }

  cancelGoal(): void {
    if (!this.session?.goal) return
    this.recordOp(this.session, 'goal', undefined, 'cancel')
    this.session.goal = undefined
    void this.persistSession()
    this.notify()
  }

  private async driveGoal(): Promise<void> {
    if (this.goalLoopRunning) return
    this.goalLoopRunning = true
    try {
      for (;;) {
        const g = this.session?.goal
        if (!g || g.status !== 'active' || g.rounds >= g.maxRounds) break
        if (this.status !== 'idle') break // 用户正在交互，让位
        g.rounds++
        g.updatedAt = Date.now()
        this.notify()
        const ran = await this.send(
          `[goal round ${g.rounds}/${g.maxRounds}] You are in goal-driven mode. Objective: "${g.objective}".\n` +
            `Work the plan: do the next step, verify it, keep todos current. When the objective is fully met, call goal_update with status "complete" and summarize the outcome for the user. ` +
            `If you cannot proceed, call goal_update with status "blocked" and explain in note. Avoid ask_user unless truly necessary.`,
        )
        if (!ran) break // 本轮未真正执行（缺配置/被占用）→ 停止驱动，等待用户处理
        const after = this.session?.goal
        if (!after || after.status !== 'active') break
        if (after.rounds >= after.maxRounds) {
          after.status = 'paused'
          after.note = `已达轮次上限（${after.maxRounds}轮），自动暂停；可点击继续追加轮次`
          after.updatedAt = Date.now()
          void this.persistSession()
          this.notify()
          break
        }
      }
    } finally {
      this.goalLoopRunning = false
    }
  }

  /* ---------------- 工作区快照（UI 入口） ---------------- */

  async uiSaveSnapshot(label: string): Promise<WorkspaceSnapshot> {
    const snap = await saveSnapshot(this.deps.kv, this.deps.fs, label)
    this.snapRevCounter++
    this.notify()
    return snap
  }

  async uiRestoreSnapshot(id: string): Promise<void> {
    await restoreSnapshot(this.deps.kv, this.deps.fs, id)
    this.snapRevCounter++
    this.fsRev++
    this.notify()
  }

  /** 删除指定快照（不影响工作区文件） */
  async uiDeleteSnapshot(id: string): Promise<boolean> {
    const okDel = await deleteSnapshot(this.deps.kv, id)
    if (okDel) {
      this.snapRevCounter++
      this.notify()
    }
    return okDel
  }

  async uiListSnapshots(): Promise<WorkspaceSnapshot[]> {
    return listSnapshots(this.deps.kv)
  }

  /** 审批桥（JetBot Permission 思想）：risky 级工具批准一次，会话内记住 */
  private approveBridge = (sessionId: string, toolName: string, summary: string): Promise<'allow' | 'deny'> =>
    new Promise<'allow' | 'deny'>((resolve) => {
      let set = this.approvedToolsBySession.get(sessionId)
      if (!set) {
        set = new Set()
        this.approvedToolsBySession.set(sessionId, set)
      }
      if (set.has(toolName)) return resolve('allow')
      const id = genId('appr_')
      this.approval = { id, tool: toolName, summary }
      this.approvalResolve = (d) => {
        if (d === 'allow') set!.add(toolName)
        resolve(d)
      }
      this.notify()
    })

  answerApproval(id: string, decision: 'allow' | 'deny'): void {
    if (this.approval?.id !== id) return
    this.approval = null
    const resolve = this.approvalResolve
    this.approvalResolve = null
    this.notify()
    resolve?.(decision)
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
        approve: (toolName, summary) => this.approveBridge(session.id, toolName, summary),
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
            // 技能文件可能被创建/修改 → 重扫技能索引
            void this.refreshSkills()
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

  /** 会话转录导出为 Markdown（便于分享/归档） */
  exportSessionMarkdown(): string {
    const s = this.session
    if (!s) return ''
    const lines: string[] = []
    lines.push(`# ${s.title}`)
    lines.push('')
    lines.push(`> Tim Harness 会话转录 · ${new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false })} 创建 · 模型 ${s.model ?? '-'}`)
    if (s.usage.total_tokens) lines.push(`> 累计 ${s.usage.total_tokens.toLocaleString()} tokens`)
    lines.push('')
    for (const m of s.messages) {
      if (m.role === 'user') {
        lines.push('## 🧑 用户')
        lines.push('')
        lines.push(m.content ?? '')
        lines.push('')
      } else if (m.role === 'assistant') {
        if (m.reasoningContent) {
          lines.push('<details><summary>思考过程</summary>')
          lines.push('')
          lines.push('```')
          lines.push(m.reasoningContent.slice(0, 4000))
          lines.push('```')
          lines.push('')
          lines.push('</details>')
          lines.push('')
        }
        if (m.content && m.content.trim()) {
          lines.push('## 🤖 助手')
          lines.push('')
          lines.push(m.content)
          lines.push('')
        }
      } else if (m.role === 'tool') {
        const status = m.toolOk === false ? '✗ 失败' : '✓'
        const dur = m.durationMs != null ? ` · ${(m.durationMs / 1000).toFixed(1)}s` : ''
        lines.push(`**工具 \`${m.name}\`** ${status}${dur}`)
        lines.push('')
        const out = (m.content ?? '').slice(0, 2000)
        lines.push('```')
        lines.push(out)
        lines.push('```')
        lines.push('')
      }
    }
    if (s.todos.length > 0) {
      lines.push('## 📋 最终任务清单')
      lines.push('')
      for (const t of s.todos) {
        lines.push(`- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`)
      }
      lines.push('')
    }
    if (s.ops && s.ops.length > 0) {
      lines.push('## 🧾 操作审计')
      lines.push('')
      for (const op of s.ops.slice(-20)) {
        lines.push(`- ${new Date(op.ts).toLocaleString('zh-CN', { hour12: false })} · \`${op.op}\`${op.at != null ? ` @${op.at}` : ''}${op.note ? ` · ${op.note}` : ''}`)
      }
      lines.push('')
    }
    return lines.join('\n')
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
    if (files.some((f) => f.path.startsWith('/skills/'))) void this.refreshSkills()
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
