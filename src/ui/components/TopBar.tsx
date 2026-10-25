import { useTranslation } from '../../i18n/useTranslation'
/** 顶栏：会话标题（可编辑）、模型信息、目标驱动、右侧面板开关 */
import { useEffect, useState } from 'react'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'

export function TopBar({
  snapshot,
  runtime,
  rightOpen,
  onToggleRight,
  onOpenGoal,
  viewMode,
  onToggleView,
}: {
  snapshot: RuntimeSnapshot
  runtime: HarnessRuntime
  rightOpen: boolean
  onToggleRight: () => void
  onOpenGoal: () => void
  viewMode: 'chat' | 'cosmos' | 'machine' | 'battlefield'
  onToggleView: () => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  useEffect(() => {
    setTitle(snapshot.session?.title ?? '')
  }, [snapshot.session?.id])

  const commit = () => {
    setEditing(false)
    if (title.trim() && title !== snapshot.session?.title) void runtime.renameSession(title)
  }

  return (
    <header className="topbar">
      <div className="topbar-title">
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setTitle(snapshot.session?.title ?? '')
                setEditing(false)
              }
            }}
            className="title-input"
          />
        ) : (
          <button type="button" className="title-btn" onClick={() => setEditing(true)} title="点击重命名">
            {snapshot.session?.title || '未命名会话'}
          </button>
        )}
      </div>
      <div className="topbar-right">
        {snapshot.providerLabel && <span className="model-chip">{snapshot.providerLabel}</span>}
        <button
          type="button"
          className={`btn-icon ${viewMode !== 'chat' ? 'on' : ''}`}
          title={viewMode === 'chat' ? t('topbar.viewToggle.chat') : viewMode === 'cosmos' ? t('topbar.viewToggle.cosmos') : viewMode === 'machine' ? t('topbar.viewToggle.machine') : t('topbar.viewToggle.battlefield')}
          onClick={onToggleView}
        >
          {viewMode === 'chat' ? '🌌' : viewMode === 'cosmos' ? '🏭' : viewMode === 'machine' ? '⚔️' : '💬'}
        </button>
        <button
          type="button"
          className={`btn-icon ${snapshot.session?.goal ? 'on' : ''}`}
          title={snapshot.session?.goal ? '目标驱动运行中 · 点击查看' : '目标驱动：设定目标后自动连续推进'}
          onClick={onOpenGoal}
        >
          🎯
        </button>
        <button
          type="button"
          className={`btn-icon ${snapshot.compacting ? 'on' : ''}`}
          title={
            snapshot.compacting
              ? '正在压缩上下文（LLM 摘要中）…'
              : '压缩上下文：把早期消息折叠为 LLM 摘要，此后每轮按尾部计费（省 token）'
          }
          disabled={snapshot.compacting}
          onClick={() => void runtime.compactSession(false)}
        >
          {snapshot.compacting ? <span className="spin-dot" /> : '⚡'}
        </button>
        <button type="button" className={`btn-icon ${rightOpen ? 'on' : ''}`} onClick={onToggleRight} title="工作区面板">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M15 4v16" />
          </svg>
        </button>
      </div>
    </header>
  )
}
