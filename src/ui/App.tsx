/** 应用外壳：布局与全局状态（设置开关 / 右面板宽度拖拽 / 拖拽导入 / 主题） */
import { useEffect, useState } from 'react'
import { useRuntime, useRuntimeHost } from './store'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { ChatView } from './components/ChatView'
import { ApprovalCard, AskUserCard, Composer } from './components/Composer'
import { RightPanel } from './components/RightPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { looksBinary, readFileAsBytes, readFileAsText } from './fileops'

function BootSplash() {
  return (
    <div className="boot-splash">
      <div className="boot-logo">
        <svg viewBox="0 0 64 64" width="56" height="56">
          <rect x="4" y="4" width="56" height="56" rx="14" fill="none" stroke="currentColor" strokeWidth="3" />
          <path d="M16 24l10 8-10 8" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="30" y="37" width="18" height="5" rx="2.5" fill="currentColor" />
        </svg>
      </div>
      <div className="boot-text">正在装载 harness…</div>
    </div>
  )
}

export const RP_WIDTH_KEY = 'tim-harness:rp-width'
export const RP_WIDTH_DEFAULT = 340
export const RP_WIDTH_MIN = 280
export const RP_WIDTH_MAX = 720

export function loadRightPanelWidth(): number {
  try {
    const v = Number(localStorage.getItem(RP_WIDTH_KEY))
    if (Number.isFinite(v) && v >= RP_WIDTH_MIN && v <= RP_WIDTH_MAX) return Math.round(v)
  } catch {
    /* ignore */
  }
  return RP_WIDTH_DEFAULT
}

function Workbench({ fsMode }: { fsMode: 'opfs' | 'memory' }) {
  const { runtime, snapshot } = useRuntime()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(true)
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark')
  const [rpWidth, setRpWidth] = useState(loadRightPanelWidth)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (window.innerWidth < 1100) setRightOpen(false)
  }, [])

  /* 全窗口拖拽导入（JetBot FileBridge DropZone） */
  useEffect(() => {
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      depth++
      setDragOver(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
    }
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      depth = 0
      setDragOver(false)
      const items: { path: string; content: string | Uint8Array }[] = []
      for (const f of Array.from(e.dataTransfer.files)) {
        try {
          const content = looksBinary(f.name) ? await readFileAsBytes(f) : await readFileAsText(f)
          items.push({ path: '/' + f.name, content })
        } catch {
          /* 跳过读不了的文件 */
        }
      }
      if (items.length > 0) void runtime.importWorkspaceFiles(items)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [runtime])

  // 宽度持久化（记忆用户偏好）
  useEffect(() => {
    try {
      localStorage.setItem(RP_WIDTH_KEY, String(rpWidth))
    } catch {
      /* ignore */
    }
  }, [rpWidth])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('tim-harness:theme', next)
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className={`app ${rightOpen ? 'with-right' : ''}`}
      style={rightOpen ? ({ '--rp-width': `${rpWidth}px` } as React.CSSProperties) : undefined}
    >
      <Sidebar
        snapshot={snapshot}
        runtime={runtime}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main className="mainpane">
        <TopBar snapshot={snapshot} runtime={runtime} rightOpen={rightOpen} onToggleRight={() => setRightOpen((v) => !v)} />
        <ChatView snapshot={snapshot} runtime={runtime} />
        <Composer
          snapshot={snapshot}
          runtime={runtime}
          askSlot={
            <>
              <ApprovalCard snapshot={snapshot} runtime={runtime} />
              <AskUserCard snapshot={snapshot} runtime={runtime} />
            </>
          }
        />
      </main>
      {rightOpen && (
        <RightPanel
          snapshot={snapshot}
          runtime={runtime}
          fsMode={fsMode}
          width={rpWidth}
          onWidthChange={setRpWidth}
          onClose={() => setRightOpen(false)}
        />
      )}
      {settingsOpen && <SettingsDialog runtime={runtime} onClose={() => setSettingsOpen(false)} />}
      {dragOver && (
        <div className="dropzone-overlay">
          <div className="dropzone-inner">
            <div className="dropzone-icon">⤓</div>
            <div>松开以导入文件到虚拟工作区</div>
            <div className="dropzone-sub">文本文件可直接读取；二进制文件按字节保存</div>
          </div>
        </div>
      )}
    </div>
  )
}

export function App() {
  const host = useRuntimeHost()
  if (!host.runtime) return <BootSplash />
  return <Workbench fsMode={host.fsMode ?? 'memory'} />
}
