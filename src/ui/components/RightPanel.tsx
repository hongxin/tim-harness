/**
 * 右侧面板：工作区文件树 + HTML 实时预览（沙箱 iframe + console 捕获）+ 任务列表。
 * 面板左缘可拖拽调宽（280–720px，localStorage 记忆）；
 * 大窗预览：设备尺寸预设、控制台分级过滤、新标签打开、Esc 关闭、状态栏。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '../../core/ports'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import { downloadBlob, downloadText, looksBinary, readFileAsBytes, readFileAsText, relTime } from '../fileops'
import type { WorkspaceSnapshot } from '../../core/workspace-snapshots'
import { RP_WIDTH_DEFAULT, RP_WIDTH_MAX, RP_WIDTH_MIN } from '../App'

function relTimeLite(ts: number): string {
  return relTime(ts)
}

type Tab = 'files' | 'preview' | 'todos'
type ConsoleEntry = { level: string; text: string; ts: number }
type DeviceWidth = 'auto' | 375 | 768 | 1280
type ConsoleFilter = 'all' | 'log' | 'warn' | 'error'

const CONSOLE_HOOK = `<script>(function(){
  var fmt=function(v){try{if(typeof v==='string')return v;if(v instanceof Error)return v.message;return JSON.stringify(v)}catch(e){return String(v)}};
  var send=function(level,args){try{parent.postMessage({__tim_preview:true,entry:{level:level,text:args.map(fmt).join(' ')}},'*')}catch(e){}};
  ['log','info','warn','error','debug'].forEach(function(k){var o=console[k];console[k]=function(){send(k,[].slice.call(arguments));try{o&&o.apply(console,arguments)}catch(e){}}});
  window.addEventListener('error',function(e){send('error',[(e.message||'Error')+(e.lineno?' @line '+e.lineno:'')])});
  window.addEventListener('unhandledrejection',function(e){send('error',['UnhandledRejection: '+fmt(e.reason&&e.reason.message||e.reason)])});
})();</script>`

function injectConsoleHook(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${CONSOLE_HOOK}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1>${CONSOLE_HOOK}`)
  return CONSOLE_HOOK + html
}

function fmtSize(n?: number): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const levelClass = (level: string): ConsoleFilter => {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warn'
  return 'log'
}

/* ---------------- 文件树 ---------------- */

interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  size?: number
  children: TreeNode[]
}

function buildTree(entries: FileEntry[]): TreeNode {
  const root: TreeNode = { name: '/', path: '/', kind: 'dir', children: [] }
  const dirIndex = new Map<string, TreeNode>([['/', root]])
  const ensureDir = (path: string): TreeNode => {
    if (dirIndex.has(path)) return dirIndex.get(path)!
    const parentPath = path.slice(0, path.lastIndexOf('/')) || '/'
    const parent = ensureDir(parentPath)
    const node: TreeNode = { name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'dir', children: [] }
    parent.children.push(node)
    dirIndex.set(path, node)
    return node
  }
  for (const e of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    if (e.kind === 'dir') {
      ensureDir(e.path)
    } else {
      const parentPath = e.path.slice(0, e.path.lastIndexOf('/')) || '/'
      ensureDir(parentPath).children.push({ name: e.path.slice(e.path.lastIndexOf('/') + 1), path: e.path, kind: 'file', size: e.size, children: [] })
    }
  }
  const sortTree = (n: TreeNode) => {
    n.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    n.children.forEach(sortTree)
  }
  sortTree(root)
  return root
}

function TreeRow({
  node,
  depth,
  expanded,
  toggle,
  written,
  onOpenFile,
  onPreviewHtml,
  onDownload,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  toggle: (p: string) => void
  written: Set<string>
  onOpenFile: (n: TreeNode) => void
  onPreviewHtml: (n: TreeNode) => void
  onDownload: (n: TreeNode) => void
}) {
  const isOpen = expanded.has(node.path)
  const isHtml = /\.html?$/i.test(node.name)
  const isNew = written.has(node.path)
  return (
    <>
      <div
        className={`ft-row ${node.kind}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (node.kind === 'dir' ? toggle(node.path) : onOpenFile(node))}
      >
        <span className={`ft-icon ${node.kind} ${node.kind === 'dir' && isOpen ? 'open' : ''}`}>
          {node.kind === 'dir' ? '▸' : looksBinary(node.path) ? '◼' : '○'}
        </span>
        <span className={`ft-name ${isNew ? 'new' : ''}`} title={node.path}>
          {node.name}
        </span>
        {isNew && <span className="ft-new-badge" title="本会话由智能体写入">new</span>}
        {node.kind === 'file' && <span className="ft-size">{fmtSize(node.size)}</span>}
        {node.kind === 'file' && (
          <span className="ft-actions">
            {isHtml && (
              <button
                type="button"
                className="ft-btn"
                title="预览"
                onClick={(e) => {
                  e.stopPropagation()
                  onPreviewHtml(node)
                }}
              >
                ▶
              </button>
            )}
            <button
              type="button"
              className="ft-btn"
              title="下载"
              onClick={(e) => {
                e.stopPropagation()
                onDownload(node)
              }}
            >
              ↓
            </button>
          </span>
        )}
      </div>
      {node.kind === 'dir' &&
        isOpen &&
        node.children.map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            written={written}
            onOpenFile={onOpenFile}
            onPreviewHtml={onPreviewHtml}
            onDownload={onDownload}
          />
        ))}
    </>
  )
}

/* ---------------- 控制台面板 ---------------- */

function ConsolePanel({
  entries,
  onClear,
  compact,
  filter,
  onFilterChange,
}: {
  entries: ConsoleEntry[]
  onClear: () => void
  compact: boolean
  filter: ConsoleFilter
  onFilterChange: (f: ConsoleFilter) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const filtered = useMemo(
    () => (filter === 'all' ? entries : entries.filter((c) => levelClass(c.level) === filter)),
    [entries, filter],
  )
  const errCount = entries.filter((c) => c.level === 'error').length
  const warnCount = entries.filter((c) => c.level === 'warn').length

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [filtered.length])

  const filters: { key: ConsoleFilter; label: string }[] = [
    { key: 'all', label: `全部 ${entries.length}` },
    { key: 'log', label: '日志' },
    { key: 'warn', label: warnCount ? `警告 ${warnCount}` : '警告' },
    { key: 'error', label: errCount ? `错误 ${errCount}` : '错误' },
  ]

  return (
    <div className={`preview-console ${compact ? 'compact' : ''}`}>
      <div className="pc-head">
        {!compact ? (
          <span className="pc-filters">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`pc-filter ${filter === f.key ? 'on' : ''} ${f.key === 'error' && errCount ? 'has-err' : ''} ${f.key === 'warn' && warnCount ? 'has-warn' : ''}`}
                onClick={() => onFilterChange(f.key)}
              >
                {f.label}
              </button>
            ))}
          </span>
        ) : (
          <span>
            控制台{entries.length > 0 && <span className="pc-count">{entries.length}</span>}
            {errCount > 0 && <span className="pc-err">{errCount} 错误</span>}
          </span>
        )}
        <button type="button" className="pc-clear" onClick={onClear}>
          清空
        </button>
      </div>
      <div className="pc-body" ref={bodyRef}>
        {filtered.length === 0 ? (
          <div className="pc-empty">{entries.length === 0 ? '暂无输出 —— 页面内 console.log / 报错会显示在这里' : '当前筛选下无输出'}</div>
        ) : (
          filtered.map((c, i) => (
            <div key={i} className={`pc-line pc-${levelClass(c.level)}`}>
              {c.text}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/* ---------------- 主面板 ---------------- */

export function RightPanel({
  snapshot,
  runtime,
  fsMode,
  width,
  onWidthChange,
  onClose,
}: {
  snapshot: RuntimeSnapshot
  runtime: HarnessRuntime
  fsMode: 'opfs' | 'memory'
  width: number
  onWidthChange: (w: number) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('files')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewSrc, setPreviewSrc] = useState('')
  const [previewNonce, setPreviewNonce] = useState(0)
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [consoleFilter, setConsoleFilter] = useState<ConsoleFilter>('all')
  const [bigView, setBigView] = useState(false)
  const [device, setDevice] = useState<DeviceWidth>('auto')
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const [modal, setModal] = useState<{ path: string; content: string } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([])
  const importInput = useRef<HTMLInputElement>(null)

  const refreshSnapshots = useCallback(async () => {
    try {
      setSnapshots(await runtime.uiListSnapshots())
    } catch {
      setSnapshots([])
    }
  }, [runtime])

  useEffect(() => {
    void refreshSnapshots()
  }, [refreshSnapshots, snapshot.snapRev])

  /* 文件列表：仅在文件系统真实变更（fsRev）或 tab 切换时刷新 */
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
  }, [refresh, snapshot.fsRev, tab])

  /* iframe 控制台回传 */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { __tim_preview?: boolean; entry?: { level: string; text: string } }
      if (d?.__tim_preview && d.entry) {
        setConsoleEntries((prev) => [...prev.slice(-199), { ...d.entry!, ts: Date.now() }])
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const htmlFiles = useMemo(() => files.filter((f) => f.kind === 'file' && /\.html?$/i.test(f.path)), [files])
  const written = useMemo(() => new Set(snapshot.writtenFiles), [snapshot.writtenFiles])
  const newHtml = useMemo(() => [...written].some((p) => /\.html?$/i.test(p)), [written])

  const loadPreview = useCallback(
    async (path: string, force = false) => {
      try {
        const content = await runtime.fsAdapter.readFile(path)
        setPreviewPath(path)
        setPreviewSrc((prev) => {
          const next = injectConsoleHook(content)
          if (prev === next && !force) return prev
          setConsoleEntries([])
          setRefreshedAt(Date.now())
          return next
        })
      } catch {
        setPreviewPath(path)
        setPreviewSrc(`<pre style="padding:12px;font-family:sans-serif">无法读取 ${path}</pre>`)
      }
    },
    [runtime],
  )

  const openPreview = (path: string) => {
    setTab('preview')
    setConsoleEntries([])
    void loadPreview(path, true)
  }

  const reloadPreview = () => {
    if (!previewPath) return
    setConsoleEntries([])
    setPreviewNonce((n) => n + 1)
    setRefreshedAt(Date.now())
  }

  /* 智能体写入 html 后自动刷新当前预览 */
  useEffect(() => {
    if (tab !== 'preview' || !previewPath) return
    if (written.has(previewPath)) void loadPreview(previewPath, true)
    else void loadPreview(previewPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.fsRev])

  /* 大窗预览：Esc 关闭 */
  useEffect(() => {
    if (!bigView) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBigView(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [bigView])

  /* 新标签页打开（Blob URL，带 console 钩子，脱离面板全屏使用） */
  const openInNewTab = () => {
    const blob = new Blob([previewSrc], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  /* 面板宽度拖拽（左缘手柄；拖动期间禁用 iframe 指针事件防吞） */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(RP_WIDTH_MAX, Math.max(RP_WIDTH_MIN, startW + (startX - ev.clientX)))
      onWidthChange(Math.round(w))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('rp-resizing')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    document.body.classList.add('rp-resizing')
  }

  const downloadFile = async (path: string) => {
    try {
      const name = path.split('/').pop() ?? 'file'
      if (looksBinary(path)) {
        const bytes = await runtime.fsAdapter.readBytes(path)
        downloadBlob(name, new Blob([bytes as unknown as BlobPart]))
      } else {
        downloadText(name, await runtime.fsAdapter.readFile(path))
      }
    } catch {
      /* ignore */
    }
  }

  const openModal = async (path: string) => {
    try {
      if (looksBinary(path)) return void (await downloadFile(path))
      const content = await runtime.fsAdapter.readFile(path)
      setModal({ path, content: content.length > 300_000 ? content.slice(0, 300_000) + '\n…(预览截断)' : content })
    } catch (e) {
      setModal({ path, content: `无法读取：${e instanceof Error ? e.message : e}` })
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
  }

  const exportWorkspace = async () => {
    const json = await runtime.exportWorkspace()
    downloadText(`tim-harness-workspace-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json')
  }

  const tree = useMemo(() => buildTree(files), [files])
  const todos = snapshot.session?.todos ?? []
  const devicePx = device === 'auto' ? null : device

  const toggle = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const fileSwitcher = (className: string) =>
    htmlFiles.length > 1 ? (
      <select className={className} value={previewPath ?? ''} onChange={(e) => openPreview(e.target.value)} title="切换预览文件">
        {htmlFiles.map((f) => (
          <option key={f.path} value={f.path}>
            {f.path.replace(/^\//, '')}
          </option>
        ))}
      </select>
    ) : null

  return (
    <aside className="rightpanel">
      <div
        className="rp-resizer"
        onPointerDown={startResize}
        onDoubleClick={() => onWidthChange(RP_WIDTH_DEFAULT)}
        title="拖动调整宽度 · 双击恢复默认"
        role="separator"
        aria-orientation="vertical"
      />
      <div className="rp-tabs">
        <button type="button" className={`rp-tab ${tab === 'files' ? 'on' : ''}`} onClick={() => setTab('files')}>
          文件 <span className="rp-count">{files.filter((f) => f.kind === 'file').length}</span>
        </button>
        <button type="button" className={`rp-tab ${tab === 'preview' ? 'on' : ''}`} onClick={() => setTab('preview')}>
          预览 {htmlFiles.length > 0 && <span className="rp-count">{htmlFiles.length}</span>}
          {newHtml && tab !== 'preview' && <span className="rp-dot" title="本会话有新写入的 HTML" />}
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
            <span
              className={`fs-badge ${fsMode === 'opfs' ? 'fs-opfs' : 'fs-mem'}`}
              title={fsMode === 'opfs' ? 'OPFS 持久化虚拟文件系统' : 'OPFS 不可用，已降级为 KV 持久化内存文件系统'}
            >
              {fsMode === 'opfs' ? 'OPFS' : '内存+KV'}
            </span>
          </div>
          {snapshot.skills.length > 0 && (
            <div className="skills-strip" title={snapshot.skills.map((s) => `${s.name}：${s.description}`).join('\n')}>
              <span className="skills-badge">⚙ 技能 {snapshot.skills.length}</span>
              {snapshot.skills.slice(0, 3).map((s) => (
                <span key={s.path} className="skill-chip" title={s.description}>
                  {s.name}
                </span>
              ))}
              {snapshot.skills.length > 3 && <span className="skill-chip more">+{snapshot.skills.length - 3}</span>}
            </div>
          )}
          <div className="snap-section">
            <div className="snap-head">
              <span>📷 快照（轻量 git）</span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                title="保存当前工作区为快照"
                onClick={() => {
                  const label = prompt('快照名称：', `手动快照 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
                  if (label !== null) void runtime.uiSaveSnapshot(label).then(() => refreshSnapshots())
                }}
              >
                保存
              </button>
            </div>
            {snapshots.length === 0 ? (
              <div className="snap-empty">暂无快照 · 保存后可随时精确恢复（恢复前自动保护）</div>
            ) : (
              snapshots.map((sn) => (
                <div key={sn.id} className="snap-row" title={sn.label}>
                  <span className="snap-label">{sn.label}</span>
                  <span className="snap-meta">
                    {Object.keys(sn.files).length} 文件 · {relTimeLite(sn.createdAt)}
                  </span>
                  <span className="snap-actions">
                    <button
                      type="button"
                      className="ft-btn"
                      title="恢复到此快照（当前状态将自动保护）"
                      onClick={() => {
                        if (confirm(`恢复到「${sn.label}」？当前工作区会先自动保存为保护快照。`)) {
                          void runtime.uiRestoreSnapshot(sn.id).then(() => refreshSnapshots())
                        }
                      }}
                    >
                      ↩
                    </button>
                    <button
                      type="button"
                      className="ft-btn snap-del"
                      title="删除此快照（不影响工作区文件）"
                      onClick={() => {
                        if (confirm(`删除快照「${sn.label}」？此操作不可恢复（工作区文件不受影响）。`)) {
                          void runtime.uiDeleteSnapshot(sn.id).then(() => refreshSnapshots())
                        }
                      }}
                    >
                      ✕
                    </button>
                    <button
                      type="button"
                      className="ft-btn"
                      title="下载快照 JSON"
                      onClick={() =>
                        downloadText(`tim-snapshot-${sn.id}.json`, JSON.stringify({ kind: 'tim-harness-snapshot', ...sn }, null, 2), 'application/json')
                      }
                    >
                      ↓
                    </button>
                  </span>
                </div>
              ))
            )}
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
            <div className="file-tree">
              {tree.children.map((c) => (
                <TreeRow
                  key={c.path}
                  node={c}
                  depth={0}
                  expanded={expanded}
                  toggle={toggle}
                  written={written}
                  onOpenFile={(n) => void openModal(n.path)}
                  onPreviewHtml={(n) => openPreview(n.path)}
                  onDownload={(n) => void downloadFile(n.path)}
                />
              ))}
            </div>
          )}
        </div>
      ) : tab === 'preview' ? (
        <div className="rp-body preview-body">
          <div className="preview-toolbar">
            {previewPath ? (
              <>
                <span className="preview-path" title={previewPath}>
                  {previewPath.replace(/^\//, '')}
                </span>
                {fileSwitcher('preview-select')}
                <button type="button" className="btn-ghost btn-sm" onClick={reloadPreview} title="重新加载">
                  ⟳
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setBigView(true)} title="大窗预览（Esc 关闭）">
                  ⤢
                </button>
              </>
            ) : (
              <span className="preview-path">HTML 预览</span>
            )}
          </div>
          {previewPath ? (
            bigView ? (
              <div className="preview-frame-wrap preview-paused">
                <div className="pc-empty" style={{ padding: '24px 12px' }}>已在大窗预览中运行 · 关闭大窗后返回</div>
              </div>
            ) : (
              <div className="preview-frame-wrap">
                <iframe
                  key={`${previewPath}#${previewNonce}`}
                  className="preview-frame"
                  sandbox="allow-scripts allow-modals allow-forms allow-popups"
                  srcDoc={previewSrc}
                  title="HTML 预览"
                />
              </div>
            )
          ) : htmlFiles.length > 0 ? (
            <div className="preview-pick">
              <div className="rp-empty">选择一个 HTML 文件开始预览：</div>
              {htmlFiles.map((f) => (
                <button key={f.path} type="button" className="preview-pick-item" onClick={() => openPreview(f.path)}>
                  ▶ {f.path.replace(/^\//, '')}
                </button>
              ))}
            </div>
          ) : (
            <div className="rp-empty">
              还没有可预览的 HTML 文件。
              <br />
              让智能体「写一个 game.html 小游戏」，写完即可在这里预览运行效果。
            </div>
          )}
          {previewPath && !bigView && (
            <ConsolePanel entries={consoleEntries} onClear={() => setConsoleEntries([])} compact filter={consoleFilter} onFilterChange={setConsoleFilter} />
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

      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal file-preview" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-title">{modal.path}</span>
              <div className="modal-head-actions">
                {/\.html?$/i.test(modal.path) && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => {
                      setModal(null)
                      openPreview(modal.path)
                    }}
                  >
                    在预览中打开
                  </button>
                )}
                <button type="button" className="btn-ghost btn-sm" onClick={() => void downloadFile(modal.path)}>
                  下载
                </button>
                <button type="button" className="btn-icon" onClick={() => setModal(null)}>
                  ×
                </button>
              </div>
            </div>
            <pre className="preview-pre">{modal.content}</pre>
          </div>
        </div>
      )}

      {bigView && previewPath && (
        <div className="modal-overlay preview-big" onClick={() => setBigView(false)}>
          <div className="pb-inner" onClick={(e) => e.stopPropagation()}>
            <div className="pb-head">
              <div className="pb-title">
                <span className="pb-live-dot" title="实时预览运行中" />
                <span className="pb-path" title={previewPath}>
                  {previewPath.replace(/^\//, '')}
                </span>
                {fileSwitcher('preview-select')}
              </div>
              <div className="pb-actions">
                <span className="pb-devices">
                  {(['auto', 375, 768, 1280] as DeviceWidth[]).map((d) => (
                    <button
                      key={String(d)}
                      type="button"
                      className={`pb-device-btn ${device === d ? 'on' : ''}`}
                      onClick={() => setDevice(d)}
                      title={d === 'auto' ? '自适应宽度' : `${d}px 设备宽度`}
                    >
                      {d === 'auto' ? '自适应' : `${d}`}
                    </button>
                  ))}
                </span>
                <button type="button" className="btn-ghost btn-sm" onClick={reloadPreview} title="重新加载">
                  ⟳ 重载
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={openInNewTab} title="在新标签页打开（Blob URL）">
                  ↗ 新标签
                </button>
                <button type="button" className="btn-icon" onClick={() => setBigView(false)} title="关闭（Esc）">
                  ×
                </button>
              </div>
            </div>
            <div className="pb-main">
              <div className="pb-stage">
                <div className={`pb-device ${devicePx ? 'fixed' : 'auto'}`} style={devicePx ? { width: devicePx } : undefined}>
                  <div className="pb-device-bar">
                    <span className="pb-device-url">{previewPath.replace(/^\//, '')}</span>
                    <span className="pb-device-size">{devicePx ? `${devicePx}px` : '自适应'}</span>
                  </div>
                  <iframe
                    key={`${previewPath}#${previewNonce}`}
                    className="pb-frame"
                    sandbox="allow-scripts allow-modals allow-forms allow-popups"
                    srcDoc={previewSrc}
                    title="HTML 大窗预览"
                  />
                </div>
              </div>
              <div className="pb-console">
                <ConsolePanel entries={consoleEntries} onClear={() => setConsoleEntries([])} compact={false} filter={consoleFilter} onFilterChange={setConsoleFilter} />
              </div>
            </div>
            <div className="pb-status">
              <span>沙箱运行：allow-scripts · opaque origin（无法触碰本站存储与密钥）</span>
              <span>
                {refreshedAt ? `最近刷新 ${new Date(refreshedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '未刷新'} · Esc 关闭
              </span>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
