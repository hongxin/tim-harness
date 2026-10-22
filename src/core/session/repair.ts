/**
 * 会话完整性修复 —— 继承 DSH 的"日志配平"思想。
 *
 * OpenAI 协议要求：assistant 消息里的每个 tool_call 必须有对应的 tool 结果消息。
 * 中断（用户停止 / 页面刷新 / 异常）会造成"悬空 tool_calls"，下次发送将被 API 拒绝。
 * 本模块幂等地补齐合成结果，保证任何会话随时可继续。
 */
import type { ChatMessage, SessionModel } from '../types'
import { genId } from '../util/path'

/** 为最后一个未配平的 assistant.tool_calls 补合成 tool 结果（在 loop 的中止路径调用） */
export function repairTrailingToolCalls(session: SessionModel): void {
  const msgs = session.messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'tool') continue // 已有结果，继续向前找 assistant
    if (m.role === 'assistant' && m.tool_calls?.length) {
      fillMissing(session, i)
      return
    }
    // user/system/无工具的 assistant：无需修复
    return
  }
}

/** 全量修复：扫描整条会话，补齐所有缺失的 tool 结果（加载历史会话时调用），返回修复数 */
export function repairSessionIntegrity(session: SessionModel): number {
  let fixed = 0
  const msgs = session.messages
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant' && msgs[i].tool_calls?.length) {
      fixed += fillMissing(session, i)
    }
  }
  return fixed
}

/** 检查 session[i] 的 tool_calls 是否都有结果；缺的补在"紧随其后且连续的 tool 消息块"末尾 */
function fillMissing(session: SessionModel, assistantIdx: number): number {
  const msgs = session.messages
  const assistant = msgs[assistantIdx]
  const answered = new Set<string>()
  let j = assistantIdx + 1
  while (j < msgs.length && msgs[j].role === 'tool') {
    if (msgs[j].tool_call_id) answered.add(msgs[j].tool_call_id!)
    j++
  }
  const missing = (assistant.tool_calls ?? []).filter((tc) => !answered.has(tc.id))
  if (missing.length === 0) return 0
  const inserts: ChatMessage[] = missing.map((tc) => ({
    role: 'tool',
    tool_call_id: tc.id,
    name: tc.name,
    args: tc.arguments,
    toolOk: false,
    durationMs: 0,
    content:
      '[harness] 该调用因会话中断未产生结果（合成记录以保持消息序列合法）。请根据已有信息判断是否需要重新执行；只有当该操作幂等（如读取/计算）时才重试。',
  }))
  // 无 id 的调用（极端流式残缺）也要补上可用 id，避免 API 报错
  for (let k = 0; k < inserts.length; k++) {
    const call = missing[k]
    if (!call.id) {
      const newId = genId('call_repair_')
      call.id = newId
      inserts[k].tool_call_id = newId
    }
  }
  msgs.splice(j, 0, ...inserts)
  return inserts.length
}
