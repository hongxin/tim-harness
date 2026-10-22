/**
 * 上下文预算管理 —— 引入自 JetBot ContextManager 的三层策略，
 * 并与 DSH 的 surface 投影思想对齐：会话日志是唯一真相、永不删改；
 * 这里产出的只是"发给模型的视图"（折叠/投影），存储层不受影响。
 *
 * 三层：
 * 1. 预算判定：估算 wire 消息字符量，未超预算直接原文返回（零成本快路径）
 * 2. Smart masking：旧工具结果折叠为摘要；最近 N 条保持全文；
 *    ls/grep/glob 等"项目地图"结果（≤2000 字符）豁免，作为持久上下文；
 *    错误结果保留全文（短且信息密度高）
 * 3. 滑窗 + 孤儿清理：仍超预算时从前部丢最老的整块消息，
 *    并修复 assistant.tool_calls 与 tool 结果的配平关系（API 合法性）
 */
import type { ChatMessage } from '../types'

/** 上下文字符预算（约 65k token，为系统提示/工具 schema/输出留余量） */
export const CONTEXT_BUDGET_CHARS = 260_000
/** 最近 N 条工具结果保持全文 */
const RECENT_FULL_RESULTS = 4
/** 项目地图类工具：输出是工作区结构索引，值得常驻 */
const PROJECT_MAP_TOOLS = new Set(['ls', 'grep', 'glob'])
const PROJECT_MAP_EXEMPT_CHARS = 2_000
/** compact 时前半程内容截断长度 */
const COMPACT_HEAD_CHARS = 200
/** masked 摘要首行长度 */
const MASK_HEAD_CHARS = 120

export interface ContextViewInfo {
  masked: boolean
  estChars: number
  budgetChars: number
  maskedResults: number
  droppedBlocks: number
}

export function estimateChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += 24 // role 等固定开销
    n += m.content?.length ?? 0
    if (m.tool_calls) {
      for (const tc of m.tool_calls) n += tc.arguments.length + tc.name.length + 24
    }
    // 注：tool 消息的 args 是本地展示字段（toWireMessage 会剥离），不计入发送估算
  }
  return n
}

function maskToolOutput(content: string): string {
  const firstLine =
    content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const head = firstLine.length > MASK_HEAD_CHARS ? firstLine.slice(0, MASK_HEAD_CHARS) + '…' : firstLine
  return `${head}\n[Result masked: ${content.length} chars. Full content remains in the session record and on disk; re-run the tool if you need it.]`
}

export interface ContextView {
  messages: ChatMessage[]
  info: ContextViewInfo
}

export function buildContextView(
  messages: ChatMessage[],
  budgetChars: number = CONTEXT_BUDGET_CHARS,
  recentFull: number = RECENT_FULL_RESULTS,
): ContextView {
  const estChars = estimateChars(messages)
  const info: ContextViewInfo = {
    masked: false,
    estChars,
    budgetChars,
    maskedResults: 0,
    droppedBlocks: 0,
  }
  if (estChars <= budgetChars) {
    return { messages, info }
  }

  // ---------- 第 2 层：smart masking ----------
  // 从尾部数最近的工具结果索引
  const toolMsgIdx: number[] = []
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolMsgIdx.push(i)
  })
  const recentFullFrom = toolMsgIdx[Math.max(0, toolMsgIdx.length - recentFull)] ?? -1

  let view = messages.map((m, i) => {
    if (m.role !== 'tool') return m
    const isRecent = i >= recentFullFrom
    const isProjectMap = PROJECT_MAP_TOOLS.has(m.name ?? '') && (m.content?.length ?? 0) <= PROJECT_MAP_EXEMPT_CHARS
    const isError = m.toolOk === false
    if (isRecent || isProjectMap || isError) return m
    if ((m.content?.length ?? 0) < 512) return m // 很短的结果不值得折叠
    info.maskedResults++
    return { ...m, content: maskToolOutput(m.content ?? '') }
  })

  // ---------- 第 3 层：滑窗 + 孤儿修复（仍超预算时） ----------
  let guard = 0
  while (estimateChars(view) > budgetChars && guard++ < 50) {
    // 找最老的可丢块：成组地丢（assistant(tool_calls) + 其 tool 结果）
    // 保住第一条 user（任务起源）与其后的首个 assistant
    const firstDroppable = view.findIndex((m, i) => i > 1 && m.role === 'user')
    if (firstDroppable === -1) break
    // 从该 user 起丢到下一个 user（或末尾）之前 —— 丢一个完整"回合块"
    let end = view.length
    for (let j = firstDroppable + 1; j < view.length; j++) {
      if (view[j].role === 'user') {
        end = j
        break
      }
    }
    // 不能把全部消息丢光
    if (end >= view.length && firstDroppable <= 1) break
    view = view.slice(0, firstDroppable).concat(view.slice(end))
    info.droppedBlocks++
  }

  // 前半程内容压缩（保结构、不丢轮次）
  if (estimateChars(view) > budgetChars) {
    const half = Math.floor(view.length / 2)
    view = view.map((m, i) => {
      if (i >= half || i === 0) return m
      if (m.role === 'user' || m.role === 'assistant') {
        const c = m.content ?? ''
        if (c.length > COMPACT_HEAD_CHARS * 2) {
          return { ...m, content: c.slice(0, COMPACT_HEAD_CHARS) + `\n…[truncated ${c.length} chars]` }
        }
      }
      return m
    })
  }

  // 孤儿修复：保证 assistant.tool_calls 与 tool 结果互相配平（API 合法性）
  const offered = new Set<string>()
  for (const m of view) {
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) offered.add(tc.id)
  }
  const answeredNow = new Set(
    view.filter((m) => m.role === 'tool' && m.tool_call_id).map((m) => m.tool_call_id!),
  )
  // 丢掉没有对应 assistant 调用的 tool 消息
  view = view.filter((m) => !(m.role === 'tool' && m.tool_call_id && !offered.has(m.tool_call_id)))
  // 丢掉没有对应结果的 tool_calls（无内容的 assistant 整条移除）
  view = view.flatMap((m) => {
    if (m.role !== 'assistant' || !m.tool_calls?.length) return [m]
    const surviving = m.tool_calls.filter((tc) => answeredNow.has(tc.id))
    if (surviving.length === m.tool_calls.length) return [m]
    if (surviving.length === 0) {
      return m.content && m.content.trim() ? [{ ...m, tool_calls: undefined }] : []
    }
    return [{ ...m, tool_calls: surviving }]
  })
  // 清理开头残留的孤儿 tool 消息（理论上不会出现，防御性）
  while (view.length > 0 && view[0].role === 'tool') {
    view = view.slice(1)
    info.droppedBlocks++
  }
  if (view.length === 0) view = messages.slice(0, 2) // 极端兜底

  info.masked = info.maskedResults > 0 || info.droppedBlocks > 0
  return { messages: view, info }
}
