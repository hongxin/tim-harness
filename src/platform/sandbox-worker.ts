/** Web Worker 沙箱适配器：每次执行起一个全新 Worker（干净状态），超时/中止即 terminate */
import type { CodeSandbox, SandboxResult } from '../core/ports'

export class WorkerSandbox implements CodeSandbox {
  async run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxResult> {
    const worker = new Worker(new URL('./worker/runner.ts', import.meta.url), { type: 'module' })
    const t0 = Date.now()
    return new Promise<SandboxResult>((resolve) => {
      let settled = false
      const finish = (r: SandboxResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(r)
        worker.terminate()
      }
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            logs: [],
            error: `执行超时（${timeoutMs}ms），已被强制终止。请检查是否有死循环，或用更小的数据量分批处理。`,
            durationMs: Date.now() - t0,
          }),
        timeoutMs,
      )
      const onAbort = () =>
        finish({ ok: false, logs: [], error: '已被用户中止', durationMs: Date.now() - t0 })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { ok: boolean; logs: string[]; result?: unknown; error?: string }
        finish({
          ok: d.ok,
          logs: d.logs,
          result: d.result,
          error: d.error,
          durationMs: Date.now() - t0,
        })
      }
      worker.onerror = (e: ErrorEvent) => {
        // 语法错误等加载期错误
        finish({
          ok: false,
          logs: [],
          error: `Worker 加载/执行错误：${e.message || 'unknown'}`,
          durationMs: Date.now() - t0,
        })
      }
      worker.postMessage({ code })
    })
  }
}
