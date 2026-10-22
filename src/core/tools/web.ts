/**
 * web_fetch / web_search —— 尽力而为的联网能力。
 * 浏览器 CORS 是硬约束：先直连，失败后若配置了代理模板则走代理（JetBot 验证的三级方案的简化版）。
 */
import type { ToolDef, ToolResult } from '../types'
import type { Transport } from '../ports'
import { truncate } from '../util/path'
import { tierPolicy } from '../token-economy'

function err(message: string): ToolResult {
  return { ok: false, output: `Error: ${message}` }
}

function proxied(template: string, url: string): string {
  if (template.includes('{url}')) return template.replace('{url}', encodeURIComponent(url))
  // 无占位符时退化为前缀拼接
  return template.replace(/\/$/, '') + '/' + url
}

export function createWebTools(transport: Transport): ToolDef[] {
  const webFetch: ToolDef = {
    name: 'web_fetch',
    description:
      'Fetch an HTTP(S) URL and return the response body as text (truncated). Subject to browser CORS: if direct fetch fails and a CORS proxy is configured, it retries through the proxy. HTML is returned raw.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL' },
      },
      required: ['url'],
    },
    timeoutMs: 45_000,
    async execute(args, ctx) {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//.test(url)) return err('仅支持 http(s) URL')
      const doFetch = async (target: string) => {
        const res = await transport.request(target, { method: 'GET', signal: ctx.signal })
        const body = await res.text()
        return { status: res.status, body }
      }
      let status: number
      let body: string
      let viaProxy = false
      try {
        ;({ status, body } = await doFetch(url))
      } catch (e) {
        if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError')
        const template = ctx.state.settings?.proxyTemplate?.trim()
        if (!template) {
          return err(
            `直连 ${url} 失败（通常是浏览器 CORS 限制）：${e instanceof Error ? e.message : e}。可在设置中配置 CORS 代理模板（含 {url} 占位符）后重试。`,
          )
        }
        try {
          ;({ status, body } = await doFetch(proxied(template, url)))
          viaProxy = true
        } catch (e2) {
          if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError')
          return err(`直连与代理均失败。代理错误：${e2 instanceof Error ? e2.message : e2}`)
        }
      }
      if (status >= 400) return err(`HTTP ${status}：${truncate(body, 500)}`)
      const header = `[HTTP ${status}${viaProxy ? ' · via proxy' : ''} · ${body.length} chars]`
      const fetchMax = tierPolicy(ctx.state.settings).fetchMax
      return { ok: true, output: header + '\n\n' + truncate(body, fetchMax) }
    },
  }

  const webSearch: ToolDef = {
    name: 'web_search',
    description:
      'Search the web and return title/url/snippet results. Requires a configured search provider (Tavily or Brave) in settings; if not configured, returns guidance instead of results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'integer', description: 'Max results, default 6' },
      },
      required: ['query'],
    },
    timeoutMs: 30_000,
    async execute(args, ctx) {
      const query = String(args.query ?? '')
      const max = Math.min(Math.max(Number(args.max_results) || 6, 1), 10)
      const cfg = ctx.state.settings?.webSearch
      if (!cfg?.apiKey) {
        return err(
          '未配置搜索服务。请在设置中填写 Tavily 或 Brave Search 的 API Key；未配置时请直接回答，不要反复调用本工具。',
        )
      }
      try {
        if (cfg.provider === 'tavily') {
          const res = await transport.request('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: max }),
            signal: ctx.signal,
          })
          const body = await res.text()
          if (res.status !== 200) return err(`Tavily HTTP ${res.status}: ${truncate(body, 300)}`)
          const data = JSON.parse(body)
          const lines = (data.results ?? []).map(
            (r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${truncate(r.content ?? '', 300)}`,
          )
          return { ok: true, output: lines.join('\n\n') || '(无结果)' }
        }
        // brave
        const u = new URL('https://api.search.brave.com/res/v1/web/search')
        u.searchParams.set('q', query)
        u.searchParams.set('count', String(max))
        const res = await transport.request(u.toString(), {
          method: 'GET',
          headers: { 'x-subscription-token': cfg.apiKey, accept: 'application/json' },
          signal: ctx.signal,
        })
        const body = await res.text()
        if (res.status !== 200) return err(`Brave HTTP ${res.status}: ${truncate(body, 300)}`)
        const data = JSON.parse(body)
        const lines = (data.web?.results ?? []).map(
          (r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${truncate(r.description ?? '', 300)}`,
        )
        return { ok: true, output: lines.join('\n\n') || '(无结果)' }
      } catch (e) {
        if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError')
        return err(`搜索失败：${e instanceof Error ? e.message : e}`)
      }
    },
  }

  return [webFetch, webSearch]
}
