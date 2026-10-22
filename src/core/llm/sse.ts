/**
 * 增量 SSE（Server-Sent Events）解析器。
 * 处理要点（来自 JetBot 实战验证）：
 * - 半行缓冲：chunk 边界可能落在任意位置，必须跨 chunk 缓冲
 * - 事件以空行（\n\n 或 \r\n\r\n）分隔
 * - data: 可多行，需用 \n 连接
 * - 以 ":" 开头的注释行（心跳）忽略
 */

export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSE(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let buffer = ''

  const tryYield = function* (raw: string): Generator<SSEEvent> {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of raw.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') event = value
      else if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length > 0) {
      const data = dataLines.join('\n')
      if (data.trim().length > 0) yield { event, data }
    }
  }

  for await (const chunk of bytes) {
    buffer += decoder.decode(chunk, { stream: true })
    // 按事件分隔符切分，保留最后一段不完整的
    let idx: number
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, idx)
      const sepMatch = buffer.slice(idx).match(/^\r?\n\r?\n/)
      buffer = buffer.slice(idx + (sepMatch ? sepMatch[0].length : 2))
      yield* tryYield(raw)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) yield* tryYield(buffer)
}
