/**
 * tim-harness 核心类型定义。
 * 本文件（以及整个 src/core）不允许依赖任何浏览器/Node 专属 API ——
 * 这是"未来可移植到微信小程序"这一长期目标的架构约束。
 */
import type { ToolContext } from './ports'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** OpenAI 风格的工具调用（arguments 保持原始 JSON 字符串，便于流式拼装） */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** 会话消息。带 * 的字段为 harness 本地补充字段，发送给 LLM 前会被剥离。 */
export interface ChatMessage {
  role: Role
  content: string | null
  /** assistant 消息携带的工具调用 */
  tool_calls?: ToolCall[]
  /** tool 消息对应的调用 id */
  tool_call_id?: string
  /** tool 消息对应的工具名 */
  name?: string
  /** *本地：工具调用参数快照（UI 展示用） */
  args?: string
  /** *本地：工具执行是否成功 */
  toolOk?: boolean
  /** *本地：工具耗时 */
  durationMs?: number
  /** *本地：思考链（DeepSeek reasoner 等），不会回传给 API */
  reasoningContent?: string
}

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  [key: string]: unknown
}

export interface JsonSchemaProperty {
  type: string
  description?: string
  enum?: string[]
  items?: JsonSchemaProperty
  [key: string]: unknown
}

export interface ToolResult {
  ok: boolean
  output: string
  meta?: Record<string, unknown>
}

export interface ToolDef {
  name: string
  description: string
  parameters: JsonSchema
  /** 单次执行超时（毫秒），默认见 loop */
  timeoutMs?: number
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface TodoItem {
  content: string
  status: TodoStatus
}

export interface FileEntry {
  path: string
  kind: 'file' | 'dir'
  size?: number
}

/* ---------------- 设置 ---------------- */

export interface ProviderSetting {
  id: string
  name: string
  baseURL: string
  apiKey: string
  model: string
  temperature?: number
}

export interface WebSearchSetting {
  provider: 'tavily' | 'brave'
  apiKey: string
}

export interface AppSettings {
  providers: ProviderSetting[]
  activeProviderId: string
  /**
   * web_fetch 的 CORS 代理模板，须含 {url} 占位符。
   * 例：https://corsproxy.io/?{url} （{url} 会被替换为 encodeURIComponent 后的地址）
   * 留空表示直连（仅支持 CORS 友好的站点）。
   */
  proxyTemplate: string
  webSearch: WebSearchSetting | null
  /** 工具审批缝：'on' 时写类工具（write_file/edit_file）需用户批准（JetBot Permission 桥思想） */
  toolApproval?: 'off' | 'on'
  /** 上下文水位超 80% 时自动压缩（LLM 摘要折叠早期消息，省 token） */
  autoCompact?: 'on' | 'off'
}

/* ---------------- 会话 ---------------- */

export interface SessionModel {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  todos: TodoItem[]
  providerId?: string
  model?: string
  /** 累计 token 用量（近似，来自流式 usage） */
  usage: Usage
  /**
   * 上下文压缩（DSH surface 思想）：日志不删，foldedCount 之前的消息
   * 被折叠为 summary，仅发给模型"摘要+尾部"，token 按尾部计费。
   */
  compacted?: {
    summary: string
    foldedCount: number
    createdAt: number
    model?: string
  }
  /** surface 操作审计日志（append-only；事件溯源精神的审计面） */
  ops?: SessionOp[]
}

export interface SessionOp {
  op: 'compact' | 'edit-truncate' | 'fork' | 'repair' | 'fork-source'
  at?: number
  ts: number
  note?: string
}

/* ---------------- 事件 ---------------- */

export type AgentEvent =
  | { type: 'turn_start'; sessionId: string; userInput: string }
  | { type: 'llm_start'; iteration: number }
  | { type: 'llm_end'; iteration: number; finishReason: string | null; usage?: Usage }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall; result: ToolResult; durationMs: number }
  | { type: 'turn_end'; sessionId: string; ok: boolean; error?: string }

/** 流式过程中的 assistant 草稿（UI 实时渲染用） */
export interface AssistantDraft {
  content: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
  iteration: number
  done: boolean
}
