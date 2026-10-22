/**
 * Agent Loop —— tim-harness 的心脏。
 *
 * 一次 runTurn = 用户消息进入 → [LLM 流式响应 →（若有 tool_calls）逐个执行工具 →
 * 结果回灌] 循环 → 直到模型给出无工具调用的最终回答。
 *
 * 继承自 DSH 的 harness 思想：
 * - 工具迭代上限，超限后"强制收尾"（去掉工具再要一次最终回答）
 * - 连续 LLM 失败熔断、同一调用连续失败时向模型注入换策略警告（JetBot 验证过的保险丝）
 * - 会话消息即状态：每一步都落盘，随时可恢复
 */
import type {
  AgentEvent,
  AssistantDraft,
  ChatMessage,
  SessionModel,
  ToolCall,
  ToolResult,
  Usage,
} from '../types'
import type { ToolContext } from '../ports'
import type { LLMClient } from '../llm/client'
import type { ToolRegistry } from '../tools/registry'
import { repairTrailingToolCalls } from '../session/repair'
import { effectiveMessages } from '../session/session'
import { tierPolicy } from '../token-economy'
import { buildContextView } from './context'

export const DEFAULT_MAX_ITERATIONS = 24
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000

/** 需审批的写类工具（risky 级：批准一次，本会话记住） */
export const APPROVAL_TOOLS = new Set(['write_file', 'edit_file'])

function approvalSummary(name: string, args: Record<string, unknown>): string {
  const p = typeof args.path === 'string' ? args.path : ''
  return p ? `${name} → ${p}` : name
}

async function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  return Promise.race([
    p,
    new Promise<'aborted'>((resolve) => {
      const onAbort = () => resolve('aborted')
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }),
  ])
}

export interface RunTurnResult {
  ok: boolean
  aborted?: boolean
  error?: string
  usage: Usage
}

export interface AgentRunnerDeps {
  client: LLMClient
  registry: ToolRegistry
  /** 稳定段系统提示（跨轮次字节一致 → 命中 provider 前缀缓存） */
  buildStablePrompt: () => string
  /** 易变快照（时间/任务/技能/预算状态），置于消息序列末尾 */
  buildSnapshot: (masked?: boolean) => string
  buildContext: (signal: AbortSignal) => ToolContext
  maxIterations?: number
  onEvent?: (e: AgentEvent) => void
  onDraft?: (draft: AssistantDraft | null) => void
}

export class AgentRunner {
  private consecutiveLLMFailures = 0

  constructor(private deps: AgentRunnerDeps) {}

  get maxIterations(): number {
    return this.deps.maxIterations ?? DEFAULT_MAX_ITERATIONS
  }

  async runTurn(session: SessionModel, userText: string, signal: AbortSignal): Promise<RunTurnResult> {
    const emit = (e: AgentEvent) => this.deps.onEvent?.(e)
    const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    session.messages.push({ role: 'user', content: userText })
    session.updatedAt = Date.now()
    emit({ type: 'turn_start', sessionId: session.id, userInput: userText })

    let outcome: RunTurnResult
    try {
      outcome = await this.driveLoop(session, signal, usage)
    } catch (err) {
      if (signal.aborted) {
        outcome = { ok: false, aborted: true, error: '已停止', usage }
      } else {
        const message = err instanceof Error ? err.message : String(err)
        outcome = { ok: false, error: message, usage }
      }
    } finally {
      this.deps.onDraft?.(null)
      // 日志配平（DSH 思想）：中断/异常时为悬空 tool_calls 补合成结果，
      // 保证会话消息序列始终合法、可继续。
      repairTrailingToolCalls(session)
    }
    session.usage = usage
    session.updatedAt = Date.now()
    emit({ type: 'turn_end', sessionId: session.id, ok: outcome.ok, error: outcome.error })
    return outcome
  }

  private async driveLoop(
    session: SessionModel,
    signal: AbortSignal,
    usage: Usage,
  ): Promise<RunTurnResult> {
    const emit = (e: AgentEvent) => this.deps.onEvent?.(e)
    const ctx = this.deps.buildContext(signal)
    let lastFailedSignature: string | null = null
    let lastFailureCount = 0

    for (let iteration = 1; iteration <= this.maxIterations + 1; iteration++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const forced = iteration === this.maxIterations + 1
      // 上下文预算视图：压缩（摘要+尾部）→ 旧工具结果折叠；会话日志永不改动
      const policy = tierPolicy(ctx.state.settings)
      const view = buildContextView(effectiveMessages(session), policy.budgetChars, policy.recentFullResults)
      const messages: ChatMessage[] = [
        { role: 'system', content: this.deps.buildStablePrompt() },
        ...view.messages,
      ]
      if (forced) {
        messages.push({
          role: 'user',
          content:
            '[harness] 已达到工具迭代上限。请不要再调用任何工具，基于已有信息直接给出最终回答。',
        })
      }
      // 双通道：易变快照永远置于序列末尾（不破坏前缀缓存），supersedes 语义声明仅最新有效
      messages.push({ role: 'user', content: this.deps.buildSnapshot(view.info.masked) })

      emit({ type: 'llm_start', iteration })
      const draft: AssistantDraft = {
        content: '',
        reasoning: '',
        toolCalls: [],
        iteration,
        done: false,
      }
      this.deps.onDraft?.(draft)

      let finishReason: string | null = null
      try {
        for await (const chunk of this.deps.client.streamChat({
          messages,
          tools: forced ? undefined : this.deps.registry.schemas(),
          signal,
        })) {
          if (chunk.reasoning) draft.reasoning += chunk.reasoning
          if (chunk.content) draft.content += chunk.content
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls) {
              const slot = (draft.toolCalls[tc.index] ??= { id: '', name: '', arguments: '' })
              if (tc.id) slot.id = tc.id
              if (tc.name) slot.name = tc.name
              if (tc.argumentsDelta) slot.arguments += tc.argumentsDelta
            }
          }
          if (chunk.finishReason) finishReason = chunk.finishReason
          if (chunk.usage) {
            usage.prompt_tokens = (usage.prompt_tokens ?? 0) + (chunk.usage.prompt_tokens ?? 0)
            usage.completion_tokens =
              (usage.completion_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0)
            usage.total_tokens = (usage.total_tokens ?? 0) + (chunk.usage.total_tokens ?? 0)
            // DeepSeek 前缀缓存计量（省钱核心观测指标）
            usage.prompt_cache_hit_tokens =
              (usage.prompt_cache_hit_tokens ?? 0) + (chunk.usage.prompt_cache_hit_tokens ?? 0)
            usage.prompt_cache_miss_tokens =
              (usage.prompt_cache_miss_tokens ?? 0) + (chunk.usage.prompt_cache_miss_tokens ?? 0)
          }
          this.deps.onDraft?.(draft)
        }
        this.consecutiveLLMFailures = 0
      } catch (err) {
        draft.done = true
        this.deps.onDraft?.(draft)
        if (signal.aborted) {
          this.retainPartial(session, draft, '\n\n[已中断]')
          throw err
        }
        this.consecutiveLLMFailures++
        if (this.consecutiveLLMFailures >= 3) {
          throw new Error(`LLM 连续 3 次调用失败，已熔断：${err instanceof Error ? err.message : err}`)
        }
        // 软失败：记录后继续下一次迭代（模型可见的中断留给上层）
        session.messages.push({
          role: 'assistant',
          content: `[调用模型时出错（第 ${this.consecutiveLLMFailures} 次，将重试）：${err instanceof Error ? err.message : err}]`,
        })
        continue
      }

      draft.done = true
      this.deps.onDraft?.(draft)
      const toolCalls = draft.toolCalls.filter((tc) => tc.name)
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: draft.content || (toolCalls.length ? null : ''),
      }
      if (draft.reasoning) assistantMsg.reasoningContent = draft.reasoning
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id || `call_${iteration}_${Math.random().toString(36).slice(2, 8)}`,
          name: tc.name,
          arguments: tc.arguments || '{}',
        }))
      }
      session.messages.push(assistantMsg)
      emit({ type: 'llm_end', iteration, finishReason, usage })

      if (toolCalls.length === 0 || forced) {
        return { ok: true, usage }
      }

      for (const call of assistantMsg.tool_calls!) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError')
        emit({ type: 'tool_start', call })
        const t0 = Date.now()
        const result = await this.executeTool(call, ctx)
        const durationMs = Date.now() - t0

        // 重复失败检测：同一工具 + 同一参数连续失败 → 注入换策略警告
        let output = result.output
        if (!result.ok) {
          const sig = `${call.name}:${call.arguments}`
          if (sig === lastFailedSignature) {
            lastFailureCount++
            if (lastFailureCount >= 1) {
              output += `\n[harness] 这个调用已经连续 ${lastFailureCount + 1} 次以相同方式失败。不要用完全相同的参数重试；请换一种方法，或向用户说明障碍。`
            }
          } else {
            lastFailedSignature = sig
            lastFailureCount = 0
          }
        } else {
          lastFailedSignature = null
          lastFailureCount = 0
        }

        session.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          args: call.arguments,
          toolOk: result.ok,
          durationMs,
          content: output || '(no output)',
        })
        emit({ type: 'tool_end', call, result: { ...result, output }, durationMs })
      }
    }
    return { ok: true, usage }
  }

  private retainPartial(session: SessionModel, draft: AssistantDraft, suffix: string) {
    if (draft.content || draft.reasoning) {
      const msg: ChatMessage = { role: 'assistant', content: draft.content + suffix }
      if (draft.reasoning) msg.reasoningContent = draft.reasoning
      session.messages.push(msg)
    }
  }

  private async executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.deps.registry.get(call.name)
    if (!tool) {
      return {
        ok: false,
        output: `Error: 未知工具 "${call.name}"。可用工具：${this.deps.registry.names().join(', ')}`,
      }
    }
    let args: Record<string, unknown>
    try {
      args = call.arguments.trim() ? JSON.parse(call.arguments) : {}
    } catch (e) {
      return {
        ok: false,
        output: `Error: 工具 ${call.name} 的 arguments 不是合法 JSON：${e instanceof Error ? e.message : e}\nRaw: ${call.arguments}`,
      }
    }
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    // 审批缝（可选）：写类工具在设置开启时经用户批准（DSH pre-execute / JetBot Permission 桥）
    if (ctx.state.settings?.toolApproval === 'on' && APPROVAL_TOOLS.has(call.name) && ctx.ui.approve) {
      const decision = await raceAbort(ctx.ui.approve(call.name, approvalSummary(call.name, args)), ctx.signal)
      if (decision !== 'allow') {
        return {
          ok: false,
          output: `用户拒绝了 ${call.name} 操作。请询问用户意图或调整方案；不要以完全相同的参数原样重试。`,
        }
      }
    }
    // 三个出口：正常完成 / 超时 / 用户中止（中止必须能打断任何挂起的工具，如 ask_user）
    const timeoutP = new Promise<ToolResult>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`工具 ${call.name} 执行超时（${timeoutMs}ms）`)),
        timeoutMs,
      )
      // Node 环境下不阻止进程退出（长超时工具如 ask_user 会挂住事件循环）
      ;(t as unknown as { unref?: () => void }).unref?.()
    })
    timeoutP.catch(() => {})
    const abortP = new Promise<ToolResult>((_, reject) => {
      const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
      if (ctx.signal.aborted) onAbort()
      else ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
    abortP.catch(() => {})
    try {
      return await Promise.race([tool.execute(args ?? {}, ctx), timeoutP, abortP])
    } catch (err) {
      if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError')
      return { ok: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}
