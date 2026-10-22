/**
 * 工作区快照 —— 轻量 git 化（浏览器原生实现）。
 * 快照 = 虚拟工作区全量文件的 base64 包，存 KV（全局，跨会话共享），
 * 保留最近 20 个；恢复前自动对当前状态做保护快照，任何恢复都可撤销。
 */
import type { KVStore, VFileSystem } from './ports'
import type { FileEntry, ToolDef } from './types'
import { genId } from './util/path'

export interface WorkspaceSnapshot {
  id: string
  label: string
  createdAt: number
  /** path → base64 内容 */
  files: Record<string, string>
}

const PREFIX = 'wsnap:'
const MAX_SNAPSHOTS = 20

function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function serializeWorkspace(fs: VFileSystem): Promise<Record<string, string>> {
  const entries = await fs.listAll()
  const files: Record<string, string> = {}
  for (const e of entries) {
    if (e.kind !== 'file') continue
    files[e.path] = bytesToB64(await fs.readBytes(e.path))
  }
  return files
}

export async function saveSnapshot(
  kv: KVStore,
  fs: VFileSystem,
  label: string,
): Promise<WorkspaceSnapshot> {
  const snap: WorkspaceSnapshot = {
    id: genId('snap_'),
    label: label.trim() || '未命名快照',
    createdAt: Date.now(),
    files: await serializeWorkspace(fs),
  }
  await kv.set(PREFIX + snap.id, snap)
  // 修剪：保留最近 MAX_SNAPSHOTS 个
  const all = await listSnapshots(kv)
  for (let i = 0; i < all.length - MAX_SNAPSHOTS; i++) {
    await kv.delete(PREFIX + all[i].id)
  }
  return snap
}

/** 删除指定快照（不可恢复；不影响工作区文件） */
export async function deleteSnapshot(kv: KVStore, id: string): Promise<boolean> {
  const snap = await kv.get<WorkspaceSnapshot>(PREFIX + id)
  if (!snap) return false
  await kv.delete(PREFIX + id)
  return true
}

export async function listSnapshots(kv: KVStore): Promise<WorkspaceSnapshot[]> {  const keys = await kv.keys(PREFIX)
  const snaps: WorkspaceSnapshot[] = []
  for (const k of keys) {
    const s = await kv.get<WorkspaceSnapshot>(k)
    if (s?.id) snaps.push(s)
  }
  return snaps.sort((a, b) => b.createdAt - a.createdAt)
}

export interface RestoreResult {
  restored: number
  removed: number
  autoSnapshotId: string
}

/** 恢复快照为工作区精确状态；恢复前先对当前状态做自动保护快照（可再撤销） */
export async function restoreSnapshot(
  kv: KVStore,
  fs: VFileSystem,
  id: string,
): Promise<RestoreResult> {
  const snap = await kv.get<WorkspaceSnapshot>(PREFIX + id)
  if (!snap) throw new Error(`快照 ${id} 不存在`)
  const auto = await saveSnapshot(kv, fs, `恢复「${snap.label}」前的自动保护`)
  let restored = 0
  for (const [path, b64] of Object.entries(snap.files)) {
    await fs.writeFile(path, b64ToBytes(b64))
    restored++
  }
  // 删除快照中不存在的多余文件（git 语义：精确恢复）
  let removed = 0
  const current = await fs.listAll()
  for (const e of current) {
    if (e.kind === 'file' && !(e.path in snap.files)) {
      await fs.deleteEntry(e.path)
      removed++
    }
  }
  return { restored, removed, autoSnapshotId: auto.id }
}

export interface SnapshotDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

export async function diffSnapshot(
  kv: KVStore,
  fs: VFileSystem,
  id: string,
): Promise<SnapshotDiff> {
  const snap = await kv.get<WorkspaceSnapshot>(PREFIX + id)
  if (!snap) throw new Error(`快照 ${id} 不存在`)
  const currentFiles = await serializeWorkspace(fs)
  const diff: SnapshotDiff = { added: [], removed: [], changed: [] }
  for (const [p, b64] of Object.entries(currentFiles)) {
    if (!(p in snap.files)) diff.added.push(p)
    else if (snap.files[p] !== b64) diff.changed.push(p)
  }
  for (const p of Object.keys(snap.files)) {
    if (!(p in currentFiles)) diff.removed.push(p)
  }
  return diff
}

/* ---------------- 工具 ---------------- */

function err(message: string) {
  return { ok: false as const, output: `Error: ${message}` }
}

export const snapshotSaveTool: ToolDef = {
  name: 'snapshot_save',
  description:
    'Save a full snapshot of the virtual workspace (lightweight git commit). Use before risky bulk changes or when the user asks for a checkpoint. Returns the snapshot id.',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'Short label, e.g. "重构前" or milestone name' },
    },
  },
  async execute(args, ctx) {
    const label = String(args.label ?? '')
    const snap = await saveSnapshot(ctx.kv, ctx.fs, label)
    return {
      ok: true,
      output: `快照已保存：#${snap.id}「${snap.label}」（${Object.keys(snap.files).length} 个文件，${new Date(snap.createdAt).toLocaleString('zh-CN', { hour12: false })}）。可用 snapshot_restore 恢复。`,
    }
  },
}

export const snapshotRestoreTool: ToolDef = {
  name: 'snapshot_restore',
  description:
    'Restore the workspace to a snapshot exactly (git checkout semantics). A protective auto-snapshot of the current state is saved first, so restores are always reversible. Get ids via snapshot_list.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Snapshot id from snapshot_list' },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const id = String(args.id ?? '').trim()
    if (!id) return err('缺少快照 id')
    try {
      const r = await restoreSnapshot(ctx.kv, ctx.fs, id)
      return {
        ok: true,
        output: `已恢复快照 ${id}：写入 ${r.restored} 个文件，移除 ${r.removed} 个多余文件。恢复前状态已自动保存为保护快照 ${r.autoSnapshotId}（可再次恢复撤销本次操作）。`,
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  },
}

export const snapshotDeleteTool: ToolDef = {
  name: 'snapshot_delete',
  description:
    'Delete a workspace snapshot by id (frees storage; does NOT touch current workspace files). Irreversible — confirm with the user unless the snapshot was clearly temporary (e.g. pre-restore auto-protection).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Snapshot id from snapshot_list' },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const id = String(args.id ?? '').trim()
    if (!id) return err('缺少快照 id')
    const okDel = await deleteSnapshot(ctx.kv, id)
    if (!okDel) return err(`快照 ${id} 不存在（可能已被删除）`)
    return { ok: true, output: `快照 ${id} 已删除（工作区文件不受影响）。` }
  },
}

export const snapshotListTool: ToolDef = {
  name: 'snapshot_list',
  description: 'List workspace snapshots (id, label, time, file count).',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const snaps = await listSnapshots(ctx.kv)
    if (snaps.length === 0) return { ok: true, output: '（暂无快照）' }
    return {
      ok: true,
      output:
        snaps
          .map(
            (s) =>
              `#${s.id} 「${s.label}」 ${Object.keys(s.files).length} 文件 · ${new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false })}`,
          )
          .join('\n') + `\n\n${snaps.length} snapshots`,
    }
  },
}

export const snapshotDiffTool: ToolDef = {
  name: 'snapshot_diff',
  description: 'Diff the current workspace against a snapshot (added / removed / changed file lists).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Snapshot id' },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const id = String(args.id ?? '').trim()
    try {
      const d = await diffSnapshot(ctx.kv, ctx.fs, id)
      const parts: string[] = []
      if (d.added.length) parts.push('新增:\n' + d.added.map((p) => `+ ${p}`).join('\n'))
      if (d.removed.length) parts.push('删除:\n' + d.removed.map((p) => `- ${p}`).join('\n'))
      if (d.changed.length) parts.push('修改:\n' + d.changed.map((p) => `~ ${p}`).join('\n'))
      return {
        ok: true,
        output: parts.length ? parts.join('\n\n') : '（工作区与该快照完全一致）',
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  },
}

export type { FileEntry }
