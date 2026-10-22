/** 右侧面板：工作区文件 + 任务列表 + 文件预览 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry } from '../../core/ports'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import { downloadBlob, downloadText, looksBinary, readFileAsBytes, readFileAsText } from '../fileops'

type Tab = 'files' | 'todos'

function fmtSize(n?: number): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function RightPanel({
  snapshot,
  runtime,
  fsMode,
  onClose,
}: {
  snapshot: RuntimeSnapshot
  runtime: HarnessRuntime
  fsMode: 'opfs' | 'memory'
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('files')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ path: string; content: string; binary: boolean } | null>(null)
  const importInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const all = await runtime.fsAdapter.listAll()
      all.sort((a, b) => a.path.localeCompare(b.path))
      setFiles(all)
    } catch {
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [runtime])

  useEffect(() => {
    void refresh()
  }, [refresh, snapshot.rev])

  const openPreview = async (path: string) => {
    try {
      if (looksBinary(path)) {
        const bytes = await runtime.fsAdapter.readBytes(path)
        downloadBlob(path.split('/').pop() ?? 'file', new Blob([bytes as unknown as BlobPart]))
        return
      }
      const content = await runtime.fsAdapter.readFile(path)
      setPreview({ path, content: content.length > 200_000 ? content.slice(0, 200_000) + '\n…(预览截断)' : content, binary: false })
    } catch (e) {
      setPreview({ path, content: `无法读取：${e instanceof Error ? e.message : e}`, binary: false })
    }
  }

  const importFiles = async (list: FileList | null) => {
    if (!list) return
    const items: { path: string; content: string | Uint8Array }[] = []
    for (const f of Array.from(list)) {
      const content = looksBinary(f.name) ? await readFileAsBytes(f) : await readFileAsText(f)
      items.push({ path: '/' + f.name, content })
    }
    await runtime.importWorkspaceFiles(items)
    await refresh()
  }

  const exportWorkspace = async () => {
    const json = await runtime.exportWorkspace()
    downloadText(`tim-harness-workspace-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json')
  }

  const downloadFile = async (path: string) => {
    try {
      if (looksBinary(path)) {
        const bytes = await runtime.fsAdapter.readBytes(path)
        downloadBlob(path.split('/').pop() ?? 'file', new Blob([bytes as unknown as BlobPart]))
      } else {
        downloadText(path.split('/').pop() ?? 'file', await runtime.fsAdapter.readFile(path))
      }
    } catch {
      /* ignore */
    }
  }

  const todos = snapshot.session?.todos ?? []

  return (
    <aside className="rightpanel">
      <div className="rp-tabs">
        <button type="button" className={`rp-tab ${tab === 'files' ? 'on' : ''}`} onClick={() => setTab('files')}>
          文件 <span className="rp-count">{files.filter((f) => f.kind === 'file').length}</span>
        </button>
        <button type="button" className={`rp-tab ${tab === 'todos' ? 'on' : ''}`} onClick={() => setTab('todos')}>
          任务 <span className="rp-count">{todos.length}</span>
        </button>
        <button type="button" className="btn-icon rp-close" onClick={onClose} title="收起面板">
          ×
        </button>
      </div>

      {tab === 'files' ? (
        <div className="rp-body">
          <div className="rp-actions">
            <button type="button" className="btn-ghost btn-sm" onClick={() => importInput.current?.click()}>
              导入
            </button>
            <input ref={importInput} type="file" multiple hidden onChange={(e) => void importFiles(e.target.files)} />
            <button type="button" className="btn-ghost btn-sm" onClick={() => void exportWorkspace()}>
              导出
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => void refresh()}>
              刷新
            </button>
            <span className={`fs-badge ${fsMode === 'opfs' ? 'fs-opfs' : 'fs-mem'}`} title={fsMode === 'opfs' ? 'OPFS 持久化虚拟文件系统' : 'OPFS 不可用，已降级为 KV 持久化内存文件系统'}>
              {fsMode === 'opfs' ? 'OPFS' : '内存+KV'}
            </span>
          </div>
          {loading ? (
            <div className="rp-empty">读取中…</div>
          ) : files.length === 0 ? (
            <div className="rp-empty">
              工作区还是空的。
              <br />
              让智能体「创建 index.html」试试，或点「导入」上传文件。
            </div>
          ) : (
            <div className="file-list">
              {files.map((f) => (
                <div key={f.path} className={`file-row ${f.kind}`} onClick={() => f.kind === 'file' && void openPreview(f.path)}>
                  <span className="file-icon">{f.kind === 'dir' ? '▸' : looksBinary(f.path) ? '◼' : '○'}</span>
                  <span className="file-path" title={f.path}>
                    {f.path.replace(/^\//, '')}
                  </span>
                  <span className="file-size">{fmtSize(f.size)}</span>
                  {f.kind === 'file' && (
                    <button
                      type="button"
                      className="file-dl"
                      title="下载"
                      onClick={(e) => {
                        e.stopPropagation()
                        void downloadFile(f.path)
                      }}
                    >
                      ↓
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rp-body">
          {todos.length === 0 ? (
            <div className="rp-empty">
              还没有任务计划。
              <br />
              复杂任务中智能体会用 todo_write 维护清单，这里实时展示。
            </div>
          ) : (
            <div className="todo-list">
              {todos.map((t, i) => (
                <div key={i} className={`todo-row todo-${t.status}`}>
                  <span className="todo-mark">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>
                  <span className={`todo-text ${t.status === 'completed' ? 'done' : ''}`}>{t.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {preview && (
        <div className="modal-overlay" onClick={() => setPreview(null)}>
          <div className="modal file-preview" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-title">{preview.path}</span>
              <div>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => void downloadFile(preview.path)}
                >
                  下载
                </button>
                <button type="button" className="btn-icon" onClick={() => setPreview(null)}>
                  ×
                </button>
              </div>
            </div>
            <pre className="preview-pre">{preview.content}</pre>
          </div>
        </div>
      )}
    </aside>
  )
}
