import type { ChatMessage, SessionModel, Usage } from '../types'
import { genId } from '../util/path'

export function newSession(): SessionModel {
  const now = Date.now()
  return {
    id: genId('s_'),
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    todos: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/**
 * 压缩后的"有效消息视图"：摘要标记 + 尾部消息（日志本身不动）。
 * loop 发给 LLM 与上下文水位估算都用这个视图。
 */
export function effectiveMessages(s: SessionModel): ChatMessage[] {
  const c = s.compacted
  if (!c || c.foldedCount <= 0 || c.foldedCount >= s.messages.length) return s.messages
  return [
    {
      role: 'user',
      content:
        `[Conversation compacted: the ${c.foldedCount} earliest messages were folded into the summary below to save context. ` +
        `The full transcript remains in the session record and on disk.]\n\n${c.summary}`,
    },
    ...s.messages.slice(c.foldedCount),
  ]
}

/** 首条用户消息 → 会话标题（本地启发式，不耗 LLM 调用） */
export function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return '新会话'
  return t.length > 26 ? t.slice(0, 26) + '…' : t
}

export function mergeUsage(into: Usage, delta?: Usage): Usage {
  if (!delta) return into
  into.prompt_tokens = (into.prompt_tokens ?? 0) + (delta.prompt_tokens ?? 0)
  into.completion_tokens = (into.completion_tokens ?? 0) + (delta.completion_tokens ?? 0)
  into.total_tokens = (into.total_tokens ?? 0) + (delta.total_tokens ?? 0)
  return into
}

/** 估算 token（粗略，用于无 usage 回传时的 UI 提示） */
export function estimateTokens(messages: { content: string | null }[]): number {
  let chars = 0
  for (const m of messages) chars += m.content?.length ?? 0
  return Math.round(chars / 2.2)
}
