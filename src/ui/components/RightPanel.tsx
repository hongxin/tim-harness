/**
 * 右侧面板：工作区文件树 + HTML 实时预览（沙箱 iframe + console 捕获）+ 任务列表。
 * 预览是 JetBot 亮点的升级版：opaque-origin 沙箱渲染 + 控制台输出回传 + 写入自动刷新。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '../../core/ports'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import { downloadBlob, downloadText, looksBinary, readFileAsBytes, readFileAsText } from '../fileops'

type Tab = 'files' | 'preview' | 'todos'
type ConsoleEntry = { level: string; text: string; ts: number }

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
        {node.kind === 'file' && (
          <span className="ft-size">{fmtSize(node.size)}</span>
        )}
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

/* ---------------- 主面板 ---------------- */

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
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewSrc, setPreviewSrc] = useState('')
  const [previewNonce, setPreviewNonce] = useState(0)
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [bigView, setBigView] = useState(false)
  const [modal, setModal] = useState<{ path: string; content: string } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))
  const importInput = useRef<HTMLInputElement>(null)

  /* 文件列表：仅在文件系统真实变更（fsRev）或切换到文件 tab 时刷新，避免流式期间高频 IO */
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
          if (prev === injectConsoleHook(content) && !force) return prev
          setConsoleEntries([])
          return injectConsoleHook(content)
        })
      } catch {
        setPreviewPath(path)
        setPreviewSrc(`<pre>无法读取 ${path}</pre>`)
      }
    },
    [runtime],
  )

  const openPreview = (path: string) => {
    setTab('preview')
    setConsoleEntries([])
    void loadPreview(path, true)
  }

  /* 智能体写入 html 后自动刷新当前预览 */
  useEffect(() => {
    if (tab !== 'preview' || !previewPath) return
    if (written.has(previewPath)) void loadPreview(previewPath, true)
    else void loadPreview(previewPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.fsRev])

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
  const errCount = consoleEntries.filter((c) => c.level === 'error').length

  const toggle = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const previewFrame = (height?: string) => (
    <iframe
      key={`${previewPath}#${previewNonce}`}
      className="preview-frame"
      style={height ? { height } : undefined}
      sandbox="allow-scripts allow-modals allow-forms allow-popups"
      srcDoc={previewSrc}
      title="HTML 预览"
    />
  )

  const consolePanel = (compact: boolean) => (
    <div className={`preview-console ${compact ? 'compact' : ''}`}>
      <div className="pc-head">
        <span>
          控制台{consoleEntries.length > 0 && <span className="pc-count">{consoleEntries.length}</span>}
          {errCount > 0 && <span className="pc-err">{errCount} 错误</span>}
        </span>
        <button type="button" className="pc-clear" onClick={() => setConsoleEntries([])}>
          清空
        </button>
      </div>
      <div className="pc-body">
        {consoleEntries.length === 0 ? (
          <div className="pc-empty">暂无输出 —— 页面内 console.log / 报错会显示在这里</div>
        ) : (
          consoleEntries.map((c, i) => (
            <div key={i} className={`pc-line pc-${c.level}`}>
              {c.text}
            </div>
          ))
        )}
      </div>
    </div>
  )

  const previewBody = (
    <>
      <div className="preview-toolbar">
        {previewPath ? (
          <>
            <span className="preview-path" title={previewPath}>
              {previewPath.replace(/^\//, '')}
            </span>
            <button type="button" className="btn-ghost btn-sm" onClick={() => previewPath && void loadPreview(previewPath, true)} title="重新加载">
              ⟳
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setBigView(true)} title="大窗预览">
              ⤢
            </button>
            {htmlFiles.length > 1 && (
              <select className="preview-select" value={previewPath} onChange={(e) => openPreview(e.target.value)}>
                {htmlFiles.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path.replace(/^\//, '')}
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <span className="preview-path">HTML 预览</span>
        )}
      </div>
      {previewPath ? (
        <div className="preview-frame-wrap">{previewFrame()}</div>
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
      {previewPath && consolePanel(true)}
    </>
  )

  return (
    <aside className="rightpanel">
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
        <div className="rp-body preview-body">{previewBody}</div>
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
                  <button type="button" className="btn-ghost btn-sm" onClick={() => { setModal(null); openPreview(modal.path) }}>
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
          <div className="preview-big-inner" onClick={(e) => e.stopPropagation()}>
            <div className="preview-toolbar">
              <span className="preview-path">{previewPath.replace(/^\//, '')}</span>
              <div className="modal-head-actions">
                <button type="button" className="btn-ghost btn-sm" onClick={() => setPreviewNonce((n) => n + 1)}>
                  ⟳ 重载
                </button>
                <button type="button" className="btn-icon" onClick={() => setBigView(false)}>
                  ×
                </button>
              </div>
            </div>
            <div className="preview-big-main">
              {previewFrame('100%')}
              {consolePanel(false)}
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
