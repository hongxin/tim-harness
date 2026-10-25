/**
 * Worker 沙箱 runner —— 模型生成代码的执行环境。
 * 无 DOM、无 localStorage、独立线程；主线程可随时 terminate（超时/中止）。
 * 用户 console 输出被捕获并回传；返回值经结构化克隆（不可克隆则降级为字符串）。
 */

const FMT_DEPTH = 4
const FMT_MAX_STR = 2000

function fmt(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t === 'string') {
    const s = value as string
    return s.length > FMT_MAX_STR ? JSON.stringify(s.slice(0, FMT_MAX_STR)) + '…' : JSON.stringify(s)
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value)
  if (t === 'symbol') return value.toString()
  if (t === 'function') return `[Function: ${(value as Function).name || 'anonymous'}]`
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value instanceof Date) return value.toISOString()
  if (depth >= FMT_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]'
  if (seen.has(value as object)) return '[Circular]'
  seen.add(value as object)
  try {
    if (Array.isArray(value)) return '[' + value.map((v) => fmt(v, depth + 1, seen)).join(', ') + ']'
    if (value instanceof Map) {
      return (
        'Map(' + value.size + ') {' +
        [...value.entries()].map(([k, v]) => `${fmt(k, depth + 1, seen)} => ${fmt(v, depth + 1, seen)}`).join(', ') +
        '}'
      )
    }
    if (value instanceof Set) {
      return 'Set(' + value.size + ') {' + [...value.values()].map((v) => fmt(v, depth + 1, seen)).join(', ') + '}'
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return '{ ' + entries.map(([k, v]) => `${k}: ${fmt(v, depth + 1, seen)}`).join(', ') + ' }'
  } finally {
    seen.delete(value as object)
  }
}

self.onmessage = async (ev: MessageEvent) => {
  const { code } = ev.data as { code: string }
  const logs: string[] = []
  const push = (...args: unknown[]) => {
    if (logs.length < 500) logs.push(args.map((a) => fmt(a)).join(' '))
  }
  const fakeConsole = {
    log: push,
    info: push,
    warn: push,
    error: push,
    debug: push,
    trace: push,
    table: push,
  }
  let ok = false
  let result: unknown
  let error: string | undefined
  try {
    // 存储隔离：沙箱代码与主应用同源，若不遮蔽，可直接经 indexedDB /
    // navigator.storage(OPFS) 读到设置里的 API Key 再经 fetch 外传。
    // 以函数参数遮蔽存储类全局（严格模式下参数即局部绑定，遮蔽同名全局）。
    // 说明：这是默认拒绝的加固，不是安全边界 —— 网络仍开放（见 README）。
    const safeNavigator = new Proxy(navigator, {
      get: (t, p) => (p === 'storage' ? undefined : Reflect.get(t, p)),
    })
    const safeGlobalThis = new Proxy({}, {
      get: (_t, p) => (p === 'indexedDB' || p === 'caches' || p === 'localStorage' || p === 'sessionStorage'
        ? undefined
        : Reflect.get(self, p)),
      has: () => true,
    })
    // 包裹为 async IIFE：支持顶层 await 与 return
    const fn = new Function(
      'console', 'self', 'indexedDB', 'caches', 'localStorage', 'sessionStorage', 'navigator', 'globalThis',
      '"use strict";\nreturn (async () => {\n' + code + '\n})()',
    ) as (c: typeof fakeConsole, s: unknown, idb: undefined, cch: undefined, ls: undefined, ss: undefined, nav: Navigator, gt: unknown) => Promise<unknown>
    result = await fn(
      fakeConsole,
      { postMessage: undefined }, // self 遮蔽：不给沙箱向主线程自发消息的入口
      undefined, undefined, undefined, undefined,
      safeNavigator,
      safeGlobalThis,
    )
    ok = true
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}\n${(e.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(e)
  }
  let payload: unknown
  try {
    payload = result === undefined ? undefined : structuredClone(result)
  } catch {
    payload = fmt(result)
  }
  ;(self as unknown as Worker).postMessage({ ok, logs, result: payload, error })
}
