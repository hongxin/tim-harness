/** 目标驱动 UI：状态条（GoalBar）+ 创建/管理弹窗（GoalModal） */
import { useTranslation } from '../../i18n/useTranslation'
import { useState } from 'react'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'

// Status labels via t()

export function GoalBar({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const { t } = useTranslation()
  const goal = snapshot.session?.goal
  if (!goal) return null
  const cls = `goal-bar goal-${goal.status}`
  return (
    <div className={cls}>
      <span className="goal-icon">{goal.status === 'complete' ? '🏆' : goal.status === 'blocked' ? '⛔' : '🎯'}</span>
      <span className="goal-objective" title={goal.objective}>
        {goal.objective}
      </span>
      <span className="goal-meta">
        {t(`goal.status.${goal.status}`)} · {t('goal.rounds')} {goal.rounds}/{goal.maxRounds}
        {goal.note ? ` · ${goal.note}` : ''}
      </span>
      <span className="goal-actions">
        {goal.status === 'active' && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => runtime.pauseGoal()}>
            ⏸ 暂停
          </button>
        )}
        {goal.status === 'paused' && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => runtime.resumeGoal()}>
            ▶ 继续
          </button>
        )}
        {(goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'complete') && goal.status !== 'complete' && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => runtime.cancelGoal()} title={t('goal.remove')}>
            ✕ 移除
          </button>
        )}
      </span>
    </div>
  )
}

export function GoalModal({ runtime, onClose }: { runtime: HarnessRuntime; onClose: () => void }) {
  const { t } = useTranslation()
  const existing = runtime.getSnapshot().session?.goal
  const [objective, setObjective] = useState(existing?.objective ?? '')
  const [maxRounds, setMaxRounds] = useState(existing?.maxRounds ?? 8)
  const current = runtime.getSnapshot().session?.goal

  const start = () => {
    if (!objective.trim()) return
    runtime.startGoal(objective.trim(), maxRounds)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal goal-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">🎯 目标驱动</span>
          <button type="button" className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-body">
          <p className="form-desc">
            {t('goal.desc')}（多轮工具调用）直到完成、受阻或达到轮次上限；
            随时可在对话区上方的目标条暂停/继续。每轮仍是完整的 harness 循环（工具/预览/审计全部可用）。
          </p>
          {current ? (
            <div className="form-block">
              <div className="form-block-title">{t('goal.current')} · {t(`goal.status.${current.status}`)}</div>
              <p className="form-desc">{current.objective}</p>
              <p className="form-desc">
                轮次 {current.rounds}/{current.maxRounds}
                {current.note ? ` · ${current.note}` : ''} —— {t('goal.editHint')}/重启目标。
              </p>
            </div>
          ) : null}
          <div className="form-block">
            <div className="form-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <label>目标（要达成什么，越具体越好）</label>
              <textarea
                className="goal-input"
                rows={3}
                value={objective}
                placeholder="例：在工作区构建一个完整的贪吃蛇游戏（game.html），并在预览中验证可玩"
                onChange={(e) => setObjective(e.target.value)}
              />
            </div>
            <div className="form-row" style={{ marginTop: 10 }}>
              <label>{t('goal.maxRounds')}</label>
              <input
                type="number"
                min={1}
                max={20}
                value={maxRounds}
                onChange={(e) => setMaxRounds(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="modal-foot" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn-primary" disabled={!objective.trim()} onClick={start}>
              🚀 开始推进
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
