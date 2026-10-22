/**
 * run_js —— 浏览器版 "bash"：在隔离的 Web Worker 沙箱中执行 JavaScript。
 * （相对 JetBot 的 js_eval 主线程 new Function 的关键升级：独立线程 + 超时 terminate）
 */
import type { ToolDef, ToolResult } from '../types'
import type { CodeSandbox } from '../ports'
import { truncate } from '../util/path'

export function createRunJsTool(sandbox: CodeSandbox): ToolDef {
  return {
    name: 'run_js',
    description:
      'Execute JavaScript in an isolated sandbox (Web Worker, no DOM). Use it to compute, verify logic, transform data, or test generated code. console.log output and the return value are both captured. Top-level await is supported. Network requests inside the sandbox are still subject to browser CORS.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript source. Use console.log for progress; use `return value` for the final result.',
        },
        timeout_ms: { type: 'integer', description: 'Timeout in ms. Default 10000, max 60000.' },
      },
      required: ['code'],
    },
    timeoutMs: 70_000,
    async execute(args, ctx): Promise<ToolResult> {
      const code = String(args.code ?? '')
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 10_000, 500), 60_000)
      if (!code.trim()) return { ok: false, output: 'Error: code 不能为空' }
      const r = await sandbox.run(code, timeout, ctx.signal)
      const parts: string[] = []
      if (r.logs.length > 0) parts.push('[console]\n' + truncate(r.logs.join('\n'), 30_000))
      if (r.ok) {
        const resultStr =
          r.result === undefined ? 'undefined' : JSON.stringify(r.result, null, 2)
        parts.push('[return]\n' + truncate(resultStr, 30_000))
        return {
          ok: true,
          output: parts.join('\n\n') || '(no output)',
          meta: { durationMs: r.durationMs },
        }
      }
      parts.push('[error]\n' + truncate(r.error ?? 'unknown error', 10_000))
      return { ok: false, output: parts.join('\n\n'), meta: { durationMs: r.durationMs } }
    },
  }
}
