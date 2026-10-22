/**
 * OpenAI 兼容 Chat Completions 客户端（流式）。
 * 适用于 DeepSeek / OpenAI / 智谱 / Ollama(v1) 等一切 OpenAI 风格端点。
 * 设计要点：
 * - 通过注入的 Transport 发请求（浏览器 fetch / 小程序 wx.request / 测试 mock）
 * - tool_calls 分片按 index 由 AgentLoop 聚合
 * - reasoning_content 独立分轨（DeepSeek reasoner）
 * - 429/5xx/网络错误/空闲超时：指数退避重试；4xx 立即失败
 */
import type { ChatMessage, JsonSchema, Usage } from '../types'
import type { Transport, TransportResponse } from '../ports'
import { parseSSE } from './sse'

export interface ProviderRuntimeConfig {
  name: string
  baseURL: string
  apiKey?: string
  model: string
  temperature?: number
}

export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: JsonSchema }
}

export interface StreamChunk {
  content?: string
  reasoning?: string
  toolCalls?: { index: number; id?: string; name?: string; argumentsDelta?: string }[]
  finishReason?: string | null
  usage?: Usage
}

export interface ChatStreamRequest {
  messages: ChatMessage[]
  tools?: ToolSchema[]
  signal?: AbortSignal
}

export class LLMError extends Error {
  status: number | null
  body?: string
  retryable: boolean
  constructor(message: string, status: number | null, body?: string) {
    super(message)
    this.name = 'LLMError'
    this.status = status
    this.body = body
    this.retryable = status === null || status === 429 || status >= 500
  }
}

class IdleTimeoutError extends Error {
  constructor() {
    super('stream idle timeout')
    this.name = 'IdleTimeoutError'
  }
}

const IDLE_TIMEOUT_MS = 90_000
const MAX_ATTEMPTS = 3

export class LLMClient {
  constructor(
    private transport: Transport,
    private provider: ProviderRuntimeConfig,
  ) {}

  async *streamChat(req: ChatStreamRequest): AsyncGenerator<StreamChunk> {
    let attempt = 0
    // 外层循环只负责"连接级"重试；一旦产出过 chunk 则不再重试（避免重复输出）
    let produced = false
    while (true) {
      attempt++
      try {
        const res = await this.requestOnce(req)
        if (res.status !== 200) {
          const body = await safeText(res)
          throw new LLMError(`LLM API HTTP ${res.status}: ${excerpt(body, 400)}`, res.status, body)
        }
        for await (const ev of parseSSE(idleGuard(res.bytes(), IDLE_TIMEOUT_MS))) {
          if (ev.data === '[DONE]') return
          let obj: any
          try {
            obj = JSON.parse(ev.data)
          } catch {
            continue
          }
          if (obj.error) {
            throw new LLMError(`LLM API error: ${JSON.stringify(obj.error).slice(0, 400)}`, null)
          }
          const choice = obj.choices?.[0]
          const chunk: StreamChunk = {}
          const delta = choice?.delta ?? {}
          if (typeof delta.content === 'string' && delta.content) chunk.content = delta.content
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            chunk.reasoning = delta.reasoning_content
          }
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            chunk.toolCalls = delta.tool_calls.map((tc: any) => ({
              index: typeof tc.index === 'number' ? tc.index : 0,
              id: tc.id,
              name: tc.function?.name,
              argumentsDelta: tc.function?.arguments,
            }))
          }
          if (choice?.finish_reason) chunk.finishReason = choice.finish_reason
          if (obj.usage) chunk.usage = obj.usage
          produced = true
          yield chunk
        }
        return
      } catch (err) {
        // 用户主动中止：无论处于何阶段都立即上抛
        if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const retryable = err instanceof LLMError ? err.retryable : true
        if (produced || !retryable || attempt >= MAX_ATTEMPTS) {
          throw normalizeError(err)
        }
        await abortableSleep(600 * 2 ** (attempt - 1), req.signal)
      }
    }
  }

  private async requestOnce(req: ChatStreamRequest): Promise<TransportResponse> {
    const url = joinURL(this.provider.baseURL, '/chat/completions')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.provider.apiKey) headers.authorization = `Bearer ${this.provider.apiKey}`
    const body: Record<string, unknown> = {
      model: this.provider.model,
      messages: req.messages.map(toWireMessage),
      stream: true,
      stream_options: { include_usage: true },
      temperature: this.provider.temperature ?? 0,
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools
      body.tool_choice = 'auto'
    }
    return this.transport.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })
  }
}

/** 剥离本地补充字段，只发送 API 认识的部分 */
export function toWireMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.tool_calls) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments || '{}' },
    }))
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id
  if (m.name) out.name = m.name
  return out
}

function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

async function safeText(res: TransportResponse): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function excerpt(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err
  return new Error(String(err))
}

export function isAbort(err: any): boolean {
  return !!err && (err.name === 'AbortError' || err?.message === 'aborted')
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 空闲守卫：timeoutMs 内无新数据则抛 IdleTimeoutError（触发重试） */
async function* idleGuard(
  stream: AsyncIterable<Uint8Array>,
  timeoutMs: number,
): AsyncIterable<Uint8Array> {
  const it = stream[Symbol.asyncIterator]()
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new IdleTimeoutError()), timeoutMs)
    })
    let next: IteratorResult<Uint8Array>
    try {
      next = await Promise.race([it.next(), timeout])
    } finally {
      clearTimeout(timer)
    }
    if (next.done) return
    yield next.value
  }
}
