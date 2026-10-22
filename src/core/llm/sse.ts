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

/** UTF-8 解码：优先 TextDecoder；小程序等环境缺失时用纯 JS 实现（含多字节跨 chunk 拼接） */
function makeDecoder(): (chunk: Uint8Array, stream: boolean) => string {
  if (typeof TextDecoder !== 'undefined') {
    const td = new TextDecoder('utf-8', { fatal: false })
    return (chunk, stream) => td.decode(chunk, { stream })
  }
  let pending = 0
  let codepoint = 0
  let min = 0
  let out = ''
  const push = (byte: number) => {
    if (pending === 0) {
      if (byte < 0x80) return String.fromCharCode(byte)
      if (byte >= 0xf0) { pending = 3; codepoint = byte & 0x07; min = 0x10000 }
      else if (byte >= 0xe0) { pending = 2; codepoint = byte & 0x0f; min = 0x800 }
      else if (byte >= 0xc0) { pending = 1; codepoint = byte & 0x1f; min = 0x80 }
      else return '\uFFFD'
      return ''
    }
    if ((byte & 0xc0) !== 0x80) { pending = 0; return '\uFFFD' }
    codepoint = (codepoint << 6) | (byte & 0x3f)
    pending--
    if (pending > 0) return ''
    const cp = codepoint
    codepoint = 0
    if (cp < min || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD'
    return String.fromCodePoint(cp)
  }
  return (chunk, stream = true) => {
    out = ''
    for (const b of chunk) out += push(b)
    if (!stream && pending !== 0) { pending = 0; out += '\uFFFD' }
    return out
  }
}

export async function* parseSSE(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decode = makeDecoder()
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
    buffer += decode(chunk, true)
    // 按事件分隔符切分，保留最后一段不完整的
    let idx: number
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, idx)
      const sepMatch = buffer.slice(idx).match(/^\r?\n\r?\n/)
      buffer = buffer.slice(idx + (sepMatch ? sepMatch[0].length : 2))
      yield* tryYield(raw)
    }
  }
  buffer += decode(new Uint8Array(0), false)
  if (buffer.trim()) yield* tryYield(buffer)
}
