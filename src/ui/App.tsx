/** 应用外壳：布局与全局状态（设置开关 / 右面板 / 主题） */
import { useEffect, useState } from 'react'
import { useRuntime, useRuntimeHost } from './store'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { ChatView } from './components/ChatView'
import { AskUserCard, Composer } from './components/Composer'
import { RightPanel } from './components/RightPanel'
import { SettingsDialog } from './components/SettingsDialog'

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

function Workbench({ fsMode }: { fsMode: 'opfs' | 'memory' }) {
  const { runtime, snapshot } = useRuntime()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(true)
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark')

  useEffect(() => {
    if (window.innerWidth < 1100) setRightOpen(false)
  }, [])

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
    <div className={`app ${rightOpen ? 'with-right' : ''}`}>
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
        <AskUserCard snapshot={snapshot} runtime={runtime} />
        <Composer snapshot={snapshot} runtime={runtime} />
      </main>
      {rightOpen && <RightPanel snapshot={snapshot} runtime={runtime} fsMode={fsMode} onClose={() => setRightOpen(false)} />}
      {settingsOpen && <SettingsDialog runtime={runtime} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

export function App() {
  const host = useRuntimeHost()
  if (!host.runtime) return <BootSplash />
  return <Workbench fsMode={host.fsMode ?? 'memory'} />
}
