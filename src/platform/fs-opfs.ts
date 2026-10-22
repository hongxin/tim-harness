/**
 * OPFS（Origin Private File System）虚拟工作区适配器。
 * OPFS 不可用时降级为 MemoryFS（KV 持久化），保证任何浏览器都能跑。
 */
import type { FileEntry, KVStore, VFileSystem } from '../core/ports'
import { dirname, joinPath, normalizePath } from '../core/util/path'

export class OPFSFileSystem implements VFileSystem {
  private constructor(private root: FileSystemDirectoryHandle) {}

  static async create(): Promise<OPFSFileSystem | null> {
    try {
      if (!navigator.storage?.getDirectory) return null
      const root = await navigator.storage.getDirectory()
      return new OPFSFileSystem(root)
    } catch {
      return null
    }
  }

  private async getDirHandle(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = this.root
    const p = normalizePath(path)
    if (p === '/') return dir
    for (const seg of p.slice(1).split('/')) {
      dir = await dir.getDirectoryHandle(seg, { create })
    }
    return dir
  }

  private split(path: string): { dir: string; name: string } {
    const p = normalizePath(path)
    if (p === '/') throw new Error('路径不能是根目录 /')
    return { dir: dirname(p), name: p.slice(p.lastIndexOf('/') + 1) }
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readBytes(path)
    return new TextDecoder().decode(bytes)
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const { dir, name } = this.split(path)
    const dh = await this.getDirHandle(dir, false)
    const fh = await dh.getFileHandle(name)
    const file = await fh.getFile()
    return new Uint8Array(await file.arrayBuffer())
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const { dir, name } = this.split(path)
    const dh = await this.getDirHandle(dir, true)
    const fh = await dh.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    const chunk = (typeof data === 'string' ? new TextEncoder().encode(data) : data) as unknown as FileSystemWriteChunkType
    await w.write(chunk)
    await w.close()
  }

  async deleteEntry(path: string): Promise<void> {
    const { dir, name } = this.split(path)
    const dh = await this.getDirHandle(dir, false)
    await dh.removeEntry(name, { recursive: true })
  }

  async mkdir(path: string): Promise<void> {
    await this.getDirHandle(path, true)
  }

  async list(dir: string): Promise<FileEntry[]> {
    const dh = await this.getDirHandle(normalizePath(dir), false)
    const out: FileEntry[] = []
    for await (const [name, handle] of (dh as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const path = joinPath(normalizePath(dir), name)
      if (handle.kind === 'directory') {
        out.push({ path, kind: 'dir' })
      } else {
        const f = await (handle as FileSystemFileHandle).getFile()
        out.push({ path, kind: 'file', size: f.size })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async listAll(): Promise<FileEntry[]> {
    const out: FileEntry[] = []
    const walk = async (dir: string, depth: number) => {
      if (depth > 12 || out.length > 5000) return
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
  }
}

interface MemEntry {
  kind: 'file' | 'dir'
  data?: Uint8Array
}

/**
 * 内存 + KV 持久化的降级文件系统。
 * 结构：目录显式存为 dir 条目，文件存字节。
 */
export class MemoryFileSystem implements VFileSystem {
  private entries = new Map<string, MemEntry>()

  constructor(private kv?: KVStore) {}

  static async create(kv?: KVStore): Promise<MemoryFileSystem> {
    const fs = new MemoryFileSystem(kv)
    if (kv) {
      const keys = await kv.keys('vfs:')
      for (const key of keys) {
        const raw = await kv.get<{ kind: 'file' | 'dir'; data?: number[] }>(key)
        if (!raw) continue
        const path = key.slice(4)
        fs.entries.set(path, { kind: raw.kind, data: raw.data ? new Uint8Array(raw.data) : undefined })
      }
    }
    return fs
  }

  private normalize(path: string): string {
    return normalizePath(path)
  }

  private async persist(path: string): Promise<void> {
    if (!this.kv) return
    const e = this.entries.get(path)
    if (!e) {
      await this.kv.delete('vfs:' + path)
      return
    }
    await this.kv.set('vfs:' + path, { kind: e.kind, data: e.data ? Array.from(e.data) : undefined })
  }

  private ensureParentDirs(path: string): void {
    const parts = path.slice(1).split('/')
    parts.pop()
    let cur = ''
    for (const seg of parts) {
      cur += '/' + seg
      if (!this.entries.has(cur)) this.entries.set(cur, { kind: 'dir' })
    }
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path))
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const p = this.normalize(path)
    const e = this.entries.get(p)
    if (!e || e.kind !== 'file') throw new Error(`文件不存在：${p}`)
    return e.data ?? new Uint8Array()
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const p = this.normalize(path)
    if (p === '/') throw new Error('路径不能是根目录 /')
    this.ensureParentDirs(p)
    this.entries.set(p, { kind: 'file', data: typeof data === 'string' ? new TextEncoder().encode(data) : data })
    await this.persist(p)
  }

  async deleteEntry(path: string): Promise<void> {
    const p = this.normalize(path)
    for (const key of [...this.entries.keys()]) {
      if (key === p || key.startsWith(p + '/')) {
        this.entries.delete(key)
        if (this.kv) await this.kv.delete('vfs:' + key)
      }
    }
  }

  async mkdir(path: string): Promise<void> {
    const p = this.normalize(path)
    if (p === '/') return
    this.ensureParentDirs(p)
    this.entries.set(p, { kind: 'dir' })
    await this.persist(p)
  }

  async list(dir: string): Promise<FileEntry[]> {
    const p = this.normalize(dir)
    if (p !== '/' && !this.entries.has(p)) throw new Error(`目录不存在：${p}`)
    const prefix = p === '/' ? '/' : p + '/'
    const out: FileEntry[] = []
    for (const [path, e] of this.entries) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest === '' || rest.includes('/')) continue
      out.push({ path, kind: e.kind, size: e.kind === 'file' ? e.data?.length ?? 0 : undefined })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async listAll(): Promise<FileEntry[]> {
    const out: FileEntry[] = []
    for (const [path, e] of this.entries) {
      out.push({ path, kind: e.kind, size: e.kind === 'file' ? e.data?.length ?? 0 : undefined })
    }
    return out
  }
}
