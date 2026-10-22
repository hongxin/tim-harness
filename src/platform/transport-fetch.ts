/** fetch 传输适配器：流式 body → AsyncIterable<Uint8Array> */
import type { Transport, TransportResponse } from '../core/ports'

export class FetchTransport implements Transport {
  async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<TransportResponse> {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: 'follow',
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k] = v))
    return {
      status: res.status,
      headers,
      text: () => res.text(),
      bytes: async function* () {
        if (!res.body) {
          const text = await res.text()
          if (text) yield new TextEncoder().encode(text)
          return
        }
        const reader = res.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) yield value
          }
        } finally {
          reader.releaseLock()
        }
      },
    }
  }
}
