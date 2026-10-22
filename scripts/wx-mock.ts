/**
 * wx 环境模拟器（Node 测试用）：以真实 wx API 形状模拟 Storage / FileSystemManager /
 * request(enableChunked SSE)。用于验证"core + wx 适配器"在无微信开发者工具条件下的正确性。
 * 刻意制造严苛条件：SSE 按 ArrayBuffer 分块且在多字节 UTF-8 中间切开。
 */
import type { WxLike, WxRequestOptions, WxRequestTask } from '../src/platform/wechat/wx-types'

export class WxMock implements WxLike {
  private storage = new Map<string, unknown>()
  private files = new Map<string, Uint8Array>() // 绝对路径（含 USER_DATA_PATH 前缀）
  /** 每个请求的应答脚本：返回 SSE 字符串（可多轮按序取） */
  public sseScripts: string[] = []
  public requests: { url: string; body: unknown }[] = []
  public readonly env = { USER_DATA_PATH: '/mockfs' }

  /* ---- Storage ---- */
  getStorageInfoSync() {
    return { keys: [...this.storage.keys()] }
  }
  getStorageSync(key: string) {
    return this.storage.has(key) ? this.storage.get(key) : ''
  }
  setStorageSync(key: string, value: unknown) {
    this.storage.set(key, value)
  }
  removeStorageSync(key: string) {
    this.storage.delete(key)
  }
  /** 模拟"重启"：文件与存储保留（真实小程序同域持久），内存态清空 */
  rebootKeepingData(): void {
    this.requests = []
    this.sseScripts = []
  }

  /* ---- FileSystemManager ---- */
  getFileSystemManager() {
    const mock = this
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const norm = (p: string) => (p.startsWith(mock.env.USER_DATA_PATH) ? p : mock.env.USER_DATA_PATH + '/' + p.replace(/^\//, ''))
    const fail = (cb: any, msg: string) => cb.fail({ errMsg: msg })
    return {
      readFile(o: any) {
        const key = norm(o.filePath)
        const data = mock.files.get(key)
        if (data == null) return fail(o, `readFile:fail no such file ${key}`)
        o.success({ data: o.encoding === 'utf8' ? dec.decode(data) : data.slice().buffer })
      },
      writeFile(o: any) {
        mock.files.set(norm(o.filePath), typeof o.data === 'string' ? enc.encode(o.data) : new Uint8Array(o.data))
        o.success()
      },
      unlink(o: any) {
        const key = norm(o.filePath)
        if (!mock.files.has(key)) return fail(o, `unlink:fail ${key}`)
        mock.files.delete(key)
        o.success()
      },
      rmdir(o: any) {
        const key = norm(o.dirPath)
        for (const k of [...mock.files.keys()]) {
          if (k === key || k.startsWith(key + '/')) mock.files.delete(k)
        }
        o.success()
      },
      mkdir(o: any) {
        o.success() // 内存模型中目录是隐式的
      },
      readdir(o: any) {
        const dir = norm(o.dirPath)
        const prefix = dir.endsWith('/') ? dir : dir + '/'
        const names = new Set<string>()
        for (const k of mock.files.keys()) {
          if (!k.startsWith(prefix)) continue
          const rest = k.slice(prefix.length)
          if (!rest) continue
          names.add(rest.includes('/') ? rest.split('/')[0] : rest)
        }
        o.success({ files: [...names].sort() })
      },
      stat(o: any) {
        const key = norm(o.path)
        // 目录判定：是某文件路径的前缀
        for (const k of mock.files.keys()) {
          if (k === key) return o.success({ stats: { size: mock.files.get(k)!.length, isDirectory: () => false } })
          if (k.startsWith(key.endsWith('/') ? key : key + '/')) {
            return o.success({ stats: { size: 0, isDirectory: () => true } })
          }
        }
        fail(o, `stat:fail no such file ${key}`)
      },
    }
  }

  /* ---- request：enableChunked SSE，字节按块下发且切在多字节中间 ---- */
  request(options: WxRequestOptions): WxRequestTask {
    this.requests.push({ url: options.url, body: options.data as unknown })
    const script = this.sseScripts.shift() ?? 'data: {"choices":[{"delta":{"content":"(默认应答)"}}]}\n\ndata: [DONE]\n\n'
    const bytes = new TextEncoder().encode(script)
    let listeners: ((res: { data: ArrayBuffer }) => void)[] = []
    let aborted = false
    // 异步推送：3 字节小块，制造多字节切割与半行
    const emit = async () => {
      await new Promise((r) => setTimeout(r, 1))
      for (let i = 0; i < bytes.length; i += 3) {
        if (aborted) return
        const slice = bytes.slice(i, i + 3)
        const buf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
        for (const l of listeners) l({ data: buf })
        await new Promise((r) => setTimeout(r, 0))
      }
      if (!aborted) {
        options.success?.({
          statusCode: 200,
          header: { 'content-type': 'text/event-stream' },
          data: script,
        })
      }
    }
    void emit()
    return {
      abort() {
        aborted = true
        options.fail?.({ errMsg: 'request:fail abort' })
      },
      onChunkReceived(cb) {
        listeners.push(cb)
      },
    }
  }

  /** 测试辅助：读文件（虚拟路径） */
  readFileRaw(path: string): string | undefined {
    const key = path.startsWith(this.env.USER_DATA_PATH) ? path : this.env.USER_DATA_PATH + '/' + path.replace(/^\//, '')
    const b = this.files.get(key)
    return b ? new TextDecoder().decode(b) : undefined
  }
}
