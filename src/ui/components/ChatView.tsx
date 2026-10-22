/** 对话主视图：消息流 + 实时草稿 + 自动跟随 + 回到最新 */
import { useEffect, useRef, useState } from 'react'
import type { AssistantDraft, ChatMessage } from '../../core/types'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import { renderMarkdown } from '../markdown'
import { ToolCallCard } from './ToolCallCard'
import { GitHubMark, REPO_STAR_URL, REPO_URL } from './GitHubMark'

function onMarkdownClick(e: React.MouseEvent) {
  const target = e.target as HTMLElement
  if (target.classList?.contains('md-copy')) {
    const pre = target.closest('.md-codeblock')?.querySelector('pre code')
    if (pre) {
      navigator.clipboard?.writeText(pre.textContent ?? '').then(
        () => {
          target.textContent = '已复制'
          setTimeout(() => (target.textContent = '复制'), 1500)
        },
        () => {},
      )
    }
  }
}

function AssistantBody({ content }: { content: string }) {
  return (
    <div className="md-body" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
  )
}

function ReasoningBlock({ text }: { text: string }) {
  return (
    <details className="reasoning">
      <summary>思考过程</summary>
      <pre>{text}</pre>
    </details>
  )
}

function DraftView({ draft }: { draft: AssistantDraft }) {
  return (
    <div className="msg msg-assistant msg-draft">
      {draft.reasoning && draft.reasoning.trim() && <ReasoningBlock text={draft.reasoning} />}
      {draft.content ? <AssistantBody content={draft.content} /> : null}
      {draft.toolCalls.length > 0 && (
        <div className="draft-tools">
          {draft.toolCalls.map((tc, i) => (
            <span key={i} className="draft-tool-chip">
              <span className="spin-dot" /> {tc.name || '…'}
            </span>
          ))}
        </div>
      )}
      {!draft.done && <span className="cursor" />}
    </div>
  )
}

const EXAMPLES = [
  { title: '📐 斐波那契前 20 项', text: '用 run_js 计算斐波那契数列前 20 项，把结果写入 fib.md，并读回来确认。' },
  { title: '🎮 做一个小游戏', text: '写一个打砖块 HTML 小游戏到 game.html（单文件，含 CSS/JS），要能键盘操作。写完告诉我怎么预览。' },
  { title: '🔍 数据分析', text: '写一段 JS 生成 100 个正态分布随机数存入 data.json，再用另一段 JS 计算均值和标准差并给出结论。' },
]

function EmptyState({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const provider = snapshot.settings?.providers.find((p) => p.id === snapshot.settings?.activeProviderId)
  const needsKey = provider && !provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseURL)
  return (
    <div className="empty-state">
      <div className="empty-logo">
        <svg viewBox="0 0 64 64" width="72" height="72">
          <rect x="4" y="4" width="56" height="56" rx="14" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.4" />
          <path d="M16 24l10 8-10 8" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="30" y="37" width="18" height="4.5" rx="2.25" fill="currentColor" opacity="0.8" />
        </svg>
      </div>
      <h1>Tim Harness</h1>
      <p className="empty-sub">装进这个页面的随身大模型工程台 —— 会话、文件、代码沙箱、子代理，全部在你的浏览器里。</p>
      {needsKey && (
        <div className="empty-warn">
          当前 Provider「{provider?.name}」还没有 API Key。请先到右上角「设置」填写，或切换到本地 Ollama。
        </div>
      )}
      <div className="empty-examples">
        {EXAMPLES.map((ex) => (
          <button key={ex.title} type="button" className="example-card" onClick={() => runtime.send(ex.text)}>
            <span className="example-title">{ex.title}</span>
            <span className="example-text">{ex.text}</span>
          </button>
        ))}
      </div>
      <div className="gh-row">
        <a className="gh-link" href={REPO_URL} target="_blank" rel="noreferrer">
          <GitHubMark size={14} /> hongxin/tim-harness
        </a>
        <a className="gh-star" href={REPO_STAR_URL} target="_blank" rel="noreferrer">
          ★ 觉得好用？点个 Star
        </a>
      </div>
      <p className="gh-hint">开源 · 纯浏览器运行 · API Key 只存在你自己的浏览器里</p>
    </div>
  )
}

export function ChatView({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const scroller = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const sessionId = snapshot.session?.id
  const messageCount = snapshot.session?.messages.length ?? 0
  const hasContent = messageCount > 0 || !!snapshot.draft

  // 会话切换：重置跟随状态并跳到底部
  useEffect(() => {
    pinned.current = true
    setShowJump(false)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionId])

  // 内容增长（含 markdown 重排、工具卡展开、流式增量）→ 若在底部则持续跟随
  useEffect(() => {
    const el = scroller.current
    const list = listRef.current
    if (!el || !list) return
    const follow = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    }
    follow()
    const ro = new ResizeObserver(follow)
    ro.observe(list)
    return () => ro.disconnect()
  }, [sessionId, hasContent])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    pinned.current = distance < 80
    setShowJump(distance > 300)
  }

  const jumpToBottom = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    setShowJump(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const messages = snapshot.session?.messages ?? []
  const showEmpty = messageCount === 0 && !snapshot.draft

  return (
    <div className="chat-area">
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        {showEmpty ? (
          <EmptyState snapshot={snapshot} runtime={runtime} />
        ) : (
          <div className="chat-list" ref={listRef}>
            {messages.map((m: ChatMessage, i) => {
              if (m.role === 'user') {
                return (
                  <div key={i} className="msg msg-user">
                    <div className="msg-user-bubble">{m.content}</div>
                  </div>
                )
              }
              if (m.role === 'assistant') {
                const showBody = m.content && m.content.trim()
                if (!showBody && !m.tool_calls?.length && !m.reasoningContent) return null
                return (
                  <div key={i} className="msg msg-assistant">
                    {m.reasoningContent ? <ReasoningBlock text={m.reasoningContent} /> : null}
                    {showBody ? <AssistantBody content={m.content!} /> : null}
                  </div>
                )
              }
              if (m.role === 'tool') {
                return <ToolCallCard key={i} msg={m} />
              }
              return null
            })}
            {snapshot.draft && !snapshot.draft.done && <DraftView draft={snapshot.draft} />}
            {snapshot.status === 'running' && !snapshot.draft && (
              <div className="msg msg-assistant">
                <span className="cursor" />
              </div>
            )}
          </div>
        )}
      </div>
      {showJump && (
        <button type="button" className="jump-latest" onClick={jumpToBottom} title="回到最新消息">
          <span className="jump-arrow">↓</span> 最新消息
        </button>
      )}
    </div>
  )
}
