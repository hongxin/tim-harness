/** 左侧栏：品牌、会话列表、入口 */
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import { relTime } from '../fileops'
import { GitHubMark, REPO_URL } from './GitHubMark'

export function Sidebar({
  snapshot,
  runtime,
  onOpenSettings,
  theme,
  onToggleTheme,
}: {
  snapshot: RuntimeSnapshot
  runtime: HarnessRuntime
  onOpenSettings: () => void
  theme: string
  onToggleTheme: () => void
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg viewBox="0 0 64 64" width="26" height="26">
            <rect x="4" y="4" width="56" height="56" rx="14" fill="none" stroke="currentColor" strokeWidth="3" />
            <path d="M16 24l10 8-10 8" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="30" y="37" width="18" height="5" rx="2.5" fill="currentColor" />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-name">TIM HARNESS</div>
          <div className="brand-sub">浏览器里的大模型工程台</div>
        </div>
      </div>

      <button type="button" className="btn-new-session" onClick={() => runtime.createSession()} disabled={snapshot.status === 'running'}>
        + 新会话
      </button>

      <div className="session-list">
        {snapshot.sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${snapshot.session?.id === s.id ? 'active' : ''}`}
            onClick={() => void runtime.selectSession(s.id)}
          >
            <div className="session-title">{s.title || '未命名会话'}</div>
            <div className="session-meta">
              <span>{relTime(s.updatedAt)}</span>
              <button
                type="button"
                className="session-del"
                title="删除会话"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`删除会话「${s.title}」？此操作不可撤销。`)) void runtime.deleteSession(s.id)
                }}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <a className="btn-ghost btn-footer gh-footer" href={REPO_URL} target="_blank" rel="noreferrer" title="源码仓库 · 欢迎 Star">
          <GitHubMark size={13} />
        </a>
        <button type="button" className="btn-ghost btn-footer" onClick={onToggleTheme} title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button type="button" className="btn-ghost btn-footer" onClick={onOpenSettings}>
          ⚙ 设置
        </button>
      </div>
    </aside>
  )
}
