/** 输入区：自动增高、Enter 发送、运行中变为停止（仍可预输入下一条） */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'

export function Composer({
  snapshot,
  runtime,
  askSlot,
}: {
  snapshot: RuntimeSnapshot
  runtime: HarnessRuntime
  askSlot?: ReactNode
}) {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // 编辑用户消息 → 一次性预填
  useEffect(() => {
    if (snapshot.composerPrefill !== null) {
      setText(snapshot.composerPrefill)
      runtime.clearComposerPrefill()
      taRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.composerPrefill])

  const running = snapshot.status === 'running'

  const autosize = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'
  }

  const submit = () => {
    const value = text.trim()
    if (!value || running) return
    setText('')
    requestAnimationFrame(autosize)
    void runtime.send(value)
  }

  const est = snapshot.session ? Math.round(((snapshot.session.usage.total_tokens ?? 0)) ) : 0
  const ctx = snapshot.contextInfo
  // 水位显示"折叠后实际发送"（真实成本）；原始体量与折叠状态放提示与角标
  const ctxPct = ctx ? Math.min(100, Math.round((ctx.sentChars / ctx.budgetChars) * 100)) : 0
  const rawPct = ctx ? Math.round((ctx.rawChars / ctx.budgetChars) * 100) : 0
  const usage = snapshot.session?.usage
  const cacheTotal = (usage?.prompt_cache_hit_tokens ?? 0) + (usage?.prompt_cache_miss_tokens ?? 0)
  const cachePct = cacheTotal > 0 ? Math.round(((usage?.prompt_cache_hit_tokens ?? 0) / cacheTotal) * 100) : null

  return (
    <div className="composer-wrap">
      {askSlot}
      {snapshot.lastError && (
        <div className="error-banner" role="alert">
          <span className="error-icon">!</span>
          <span className="error-text">{snapshot.lastError}</span>
          <button type="button" className="error-close" onClick={() => runtime.clearError()}>
            ×
          </button>
        </div>
      )}
      {snapshot.subagentNote && <div className="subagent-note">⑃ {snapshot.subagentNote}</div>}
      <div className={`composer ${running ? 'composer-running' : ''}`}>
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder={running ? '智能体运行中… 可先输入下一条任务（发送待其结束后回车）' : '给 Tim 下达任务（Enter 发送 · Shift+Enter 换行）'}
          onChange={(e) => {
            setText(e.target.value)
            autosize()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {running ? (
          <button type="button" className="btn-stop" onClick={() => runtime.stop()} title="停止">
            <span className="stop-square" />
          </button>
        ) : (
          <button type="button" className="btn-send" onClick={submit} disabled={!text.trim()} title="发送">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h13M13 6l6 6-6 6" />
            </svg>
          </button>
        )}
      </div>
      <div className="composer-meta">
        <span>{running ? '智能体运行中 · 工具调用与结果实时展示在上方' : '支持多轮工具调用 · 虚拟工作区 · JS 沙箱 · 子代理'}</span>
        <span className="meta-chips">
          {ctx && ctx.sentChars > 12_000 && (
            <span
              className={`ctx-chip ${ctx.masked ? 'ctx-masked' : ctxPct > 85 ? 'ctx-high' : ''}`}
              title={`实际发送估算 ${ctx.sentChars.toLocaleString()} / 预算 ${ctx.budgetChars.toLocaleString()} 字符（折叠后）\n会话原始体量 ${ctx.rawChars.toLocaleString()} 字符（${rawPct}%）${ctx.masked ? '\n已自动折叠早期工具输出——完整记录保留在会话中，实际发送的水位才是真实成本' : ''}`}
            >
              上下文 {ctxPct}%{ctx.masked ? ` · 已折叠(原 ${rawPct}%)` : ''}
            </span>
          )}
          {cachePct !== null && (
            <span
              className={`ctx-chip ${cachePct >= 60 ? 'ctx-cached' : ''}`}
              title={`前缀缓存命中 ${usage?.prompt_cache_hit_tokens?.toLocaleString()} / 未命中 ${usage?.prompt_cache_miss_tokens?.toLocaleString()} token（命中部分计费约为十分之一）`}
            >
              缓存命中 {cachePct}%
            </span>
          )}
          {est > 0 && <span className="token-chip">{est.toLocaleString()} tokens</span>}
        </span>
      </div>
    </div>
  )
}

export function AskUserCard({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const ask = snapshot.ask
  const [text, setText] = useState('')
  if (!ask) return null
  const answer = (value: string) => {
    setText('')
    runtime.answerAsk(ask.id, value)
  }
  return (
    <div className="ask-card">
      <div className="ask-q">
        <span className="ask-badge">提问</span>
        {ask.question}
      </div>
      <div className="ask-options">
        {(ask.options ?? []).map((o) => (
          <button key={o.label} type="button" className="ask-option" onClick={() => answer(o.label)}>
            {o.label}
            {o.description ? <span className="ask-option-desc">{o.description}</span> : null}
          </button>
        ))}
      </div>
      <div className="ask-input-row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) answer(text.trim())
          }}
          placeholder="或输入自定义回答，回车提交"
        />
        <button type="button" className="btn-ghost" onClick={() => answer('')}>
          跳过
        </button>
        <button type="button" className="btn-primary" disabled={!text.trim()} onClick={() => answer(text.trim())}>
          回答
        </button>
      </div>
    </div>
  )
}

/** 审批卡片（JetBot Permission 桥）：写类工具执行前的用户批准 */
export function ApprovalCard({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const approval = snapshot.approval
  if (!approval) return null
  return (
    <div className="approval-card">
      <div className="ask-q">
        <span className="approval-badge">审批</span>
        智能体请求执行写操作：<code className="approval-summary">{approval.summary}</code>
      </div>
      <div className="ask-input-row">
        <span className="approval-hint">允许后本会话内同类操作不再询问</span>
        <button type="button" className="btn-ghost" onClick={() => runtime.answerApproval(approval.id, 'deny')}>
          拒绝
        </button>
        <button type="button" className="btn-primary" onClick={() => runtime.answerApproval(approval.id, 'allow')}>
          ✓ 允许
        </button>
      </div>
    </div>
  )
}
