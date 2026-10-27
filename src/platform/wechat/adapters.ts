/**
 * 微信小程序四件适配器：Transport（wx.request 分块 SSE）/ KV（Storage）/ FS（FileSystemManager）
 * / Sandbox（诚实降级）。core 原样复用 —— 这正是"core 平台无关"承诺的验证场。
 */
import type { KVStore, Transport, TransportResponse, VFileSystem, CodeSandbox } from '../../core/ports'
import type { FileEntry } from '../../core/types'
import type { WxLike } from './wx-types'

/* ---------------- Transport：wx.request enableChunked → SSE 字节流 ---------------- */

export function createWxTransport(wx: WxLike): Transport {
  return {
    async request(url, init) {
      return new Promise<TransportResponse>((resolve, reject) => {
        let settled = false
        const chunkQueue: ArrayBuffer[] = []
        let finalText = ''

        const task = wx.request({
          url,
          method: (init.method ?? 'GET') as string,
          header: init.headers,
          data: init.body,
          enableChunked: true,
          timeout: 300_000,
          success: (res) => {
            finalText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
            settled = true
            resolve({
              status: res.statusCode,
              headers: res.header ?? {},
              text: async () => finalText,
              bytes: async function* () {
                for (const c of chunkQueue) yield new Uint8Array(c)
              },
            })
          },
          fail: (err) => {
            if (settled) return
            settled = true
            reject(new Error(`wx.request 失败：${err.errMsg}`))
          },
        })

        task.onChunkReceived((res) => {
          chunkQueue.push(res.data)
        })

        if (init.signal) {
          const onAbort = () => {
            try {
              task.abort()
            } catch {
              /* ignore */
            }
            if (!settled) {
              settled = true
              reject(new DOMException('aborted', 'AbortError'))
            }
          }
          if (init.signal.aborted) return onAbort()
          init.signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    },
  }
}

/* ---------------- KV：wx Storage 同步 API ---------------- */

const KV_PREFIX = 'thn:'

export function createWxKV(wx: WxLike): KVStore {
  return {
    async get(key) {
      const v = wx.getStorageSync(KV_PREFIX + key)
      return v === '' || v == null ? undefined : (v as never)
    },
    async set(key, value) {
      wx.setStorageSync(KV_PREFIX + key, value)
    },
    async delete(key) {
      wx.removeStorageSync(KV_PREFIX + key)
    },
    async keys(prefix) {
      const all = wx.getStorageInfoSync().keys
        .filter((k) => k.startsWith(KV_PREFIX))
        .map((k) => k.slice(KV_PREFIX.length))
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all
    },
  }
}

/* ---------------- VFileSystem：wx FileSystemManager（USER_DATA_PATH 根） ---------------- */

export function createWxFS(wx: WxLike): VFileSystem {
  const root = () => wx.env.USER_DATA_PATH
  const abs = (p: string) => root() + (p.startsWith('/') ? p : '/' + p)
  const call = <T>(invoke: (success: (r: T) => void, fail: (e: { errMsg: string }) => void) => void): Promise<T> =>
    new Promise<T>((resolve, reject) =>
      invoke((r) => resolve(r), (e) => reject(new Error(e.errMsg))),
    )

  const fs = () => wx.getFileSystemManager()
  const parentOf = (p: string) => {
    const i = p.lastIndexOf('/')
    return i <= 0 ? '/' : p.slice(0, i)
  }

  const mkdirp = async (dir: string): Promise<void> => {
    if (dir === '/' || dir === '') return
    try {
      await call((s2, f2) => fs().stat({ path: abs(dir), success: s2, fail: f2 }))
      return
    } catch {
      /* 不存在则创建 */
    }
    await mkdirp(parentOf(dir))
    try {
      await call((s2, f2) => fs().mkdir({ dirPath: abs(dir), recursive: false, success: s2, fail: f2 }))
    } catch {
      /* 并发创建竞态可容忍 */
    }
  }

  return {
    async readFile(path) {
      const res = await call<{ data: string | ArrayBuffer }>((s2, f2) =>
        fs().readFile({ filePath: abs(path), encoding: 'utf8', success: s2, fail: f2 }),
      )
      return typeof res.data === 'string' ? res.data : new TextDecoderCompat().decode(res.data as ArrayBuffer)
    },
    async readBytes(path) {
      const res = await call<{ data: string | ArrayBuffer }>((s2, f2) =>
        fs().readFile({ filePath: abs(path), success: s2, fail: f2 }),
      )
      return typeof res.data === 'string' ? new TextEncoder().encode(res.data) : new Uint8Array(res.data as ArrayBuffer)
    },
    async writeFile(path, data) {
      await mkdirp(parentOf(path))
      await call((s2, f2) => fs().writeFile({ filePath: abs(path), data: data as string, encoding: 'utf8', success: s2, fail: f2 }))
    },
    async deleteEntry(path) {
      try {
        await call((s2, f2) => fs().unlink({ filePath: abs(path), success: s2, fail: f2 }))
      } catch {
        await call((s2, f2) => fs().rmdir({ dirPath: abs(path), recursive: true, success: s2, fail: f2 }))
      }
    },
    async mkdir(path) {
      await mkdirp(path)
    },
    async list(dir) {
      const files = await call<{ files: string[] }>((s2, f2) => fs().readdir({ dirPath: abs(dir), success: s2, fail: f2 }))
      const out: FileEntry[] = []
      for (const name of files.files.sort()) {
        const path = (dir === '/' ? '' : dir) + '/' + name
        try {
          const st = await call<{ stats: { isDirectory?: () => boolean; size?: number } }>((s2, f2) =>
            fs().stat({ path: abs(path), success: s2, fail: f2 }),
          )
          if (st.stats.isDirectory?.()) out.push({ path, kind: 'dir' })
          else out.push({ path, kind: 'file', size: st.stats.size })
        } catch {
          out.push({ path, kind: 'file' })
        }
      }
      return out
    },
    async listAll() {
      const out: FileEntry[] = []
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 10 || out.length > 5000) return
        let entries: FileEntry[]
        try {
          entries = await this.list(dir)
        } catch {
          return
        }
        for (const e of entries) {
          out.push(e)
          if (e.kind === 'dir') await walk(e.path, depth + 1)
        }
      }
      await walk('/', 0)
      return out
    },
    async moveEntry(from: string, to: string): Promise<void> {
      const content = await this.readFile(from)
      await this.writeFile(to, content)
      await this.deleteEntry(from)
    },
  }
}

/** 小程序无 TextDecoder 时的兜底（仅 FS 读路径使用；SSE 路径在 core 内已有独立兜底） */
class TextDecoderCompat {
  decode(buf: ArrayBuffer): string {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(buf)
    const bytes = new Uint8Array(buf)
    let out = ''
    let i = 0
    while (i < bytes.length) {
      const b = bytes[i]
      if (b < 0x80) { out += String.fromCharCode(b); i++ }
      else if (b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2 }
      else if (b < 0xf0) { out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3 }
      else {
        const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
        out += String.fromCodePoint(cp)
        i += 4
      }
    }
    return out
  }
}

/* ---------------- Sandbox：诚实降级（小程序 Worker 需专用配置，PoC 不启用） ---------------- */

export function createWxSandbox(): CodeSandbox {
  return {
    async run() {
      return {
        ok: false,
        logs: [],
        error:
          '小程序环境暂不支持 run_js 代码沙箱（微信 Worker 需在 app.json 预配置且能力受限）。' +
          '请改用浏览器版 tim-harness 执行计算任务，或让模型用纯推理/文件方式解决。',
        durationMs: 0,
      }
    },
  }
}
