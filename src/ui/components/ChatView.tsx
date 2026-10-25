/** 对话主视图：消息流 + 实时草稿 + 自动跟随 + 回到最新 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n/useTranslation'
import type { AssistantDraft, ChatMessage } from '../../core/types'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import { renderMarkdown } from '../markdown'
import { enhanceMath } from '../math'
import { ToolCallCard } from './ToolCallCard'
import { GitHubMark, REPO_STAR_URL, REPO_URL } from './GitHubMark'

function onMarkdownClick(e: React.MouseEvent) {
  const target = e.target as HTMLElement
  if (target.classList?.contains('md-copy')) {
    const pre = target.closest('.md-codeblock')?.querySelector('pre code')
    if (pre) {
      navigator.clipboard?.writeText(pre.textContent ?? '').then(
        () => {
          target.textContent = useTranslationCopied()
          setTimeout(() => (target.textContent = useTranslationCopy()), 1500)
        },
        () => {},
      )
    }
  }
}

// 辅助函数（非组件上下文中无法使用 hook）
import { t } from '../../i18n'
function useTranslationCopied() { return t('chat.copied') }
function useTranslationCopy() { return t('chat.copy') }

function AssistantBody({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current?.querySelector('[data-tex]')) void enhanceMath(ref.current)
  }, [content])
  return (
    <div ref={ref} className="md-body" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
  )
}

function ReasoningBlock({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <details className="reasoning">
      <summary>{t('chat.thinkingProcess')}</summary>
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

function CompactionDivider({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const { t } = useTranslation()
  const c = snapshot.session?.compacted
  if (!c) return null
  const savedPct = snapshot.session!.messages.length
    ? Math.round((c.foldedCount / snapshot.session!.messages.length) * 100)
    : 0
  return (
    <details className="compact-divider">
      <summary>
        <span className="cd-badge">{t('chat.compactBadge')}</span>
        {t('chat.compactDetail', { count: c.foldedCount, pct: savedPct })}
        <span className="cd-time">{new Date(c.createdAt).toLocaleString(undefined, { hour12: false })}</span>
      </summary>
      <div className="cd-summary md-body" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(c.summary) }} />
    </details>
  )
}

function EmptyState({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const { t } = useTranslation()
  const provider = snapshot.settings?.providers.find((p) => p.id === snapshot.settings?.activeProviderId)
  const needsKey = provider && !provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseURL)

  const examples = [
    { title: t('chat.example.computeTitle'), text: t('chat.example.compute') },
    { title: t('chat.example.gameTitle'), text: t('chat.example.game') },
    { title: t('chat.example.dataTitle'), text: t('chat.example.data') },
  ]

  return (
    <div className="empty-state">
      <h1>Tim Harness<span className="empty-cursor">_</span></h1>
      <p className="empty-sub">{t('chat.empty.tagline')}</p>
      {needsKey && (
        <div className="empty-warn">
          {t('chat.empty.noKey', { provider: provider?.name ?? '' })}
        </div>
      )}
      <div className="empty-examples">
        {examples.map((ex) => (
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
          ★ {t('chat.empty.star')}
        </a>
      </div>
      <p className="gh-hint">{t('chat.empty.openSource')}</p>
    </div>
  )
}

export function ChatView({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const { t } = useTranslation()
  const scroller = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const sessionId = snapshot.session?.id
  const messageCount = snapshot.session?.messages.length ?? 0
  const hasContent = messageCount > 0 || !!snapshot.draft

  useEffect(() => {
    pinned.current = true
    setShowJump(false)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionId])

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
            {snapshot.session?.compacted && <CompactionDivider snapshot={snapshot} />}
            {messages.map((m: ChatMessage, i) => {
              if (m.role === 'user') {
                return (
                  <div key={i} className="msg msg-user">
                    <div className="msg-user-actions">
                      <button
                        type="button"
                        className="msg-action"
                        title={t('chat.editResend')}
                        onClick={() => runtime.editUserMessage(i)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="msg-action"
                        title={t('chat.fork')}
                        onClick={() => {
                          if (confirm(t('chat.forkConfirm'))) void runtime.forkSession(i)
                        }}
                      >
                        ⑃
                      </button>
                    </div>
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
        <button type="button" className="jump-latest" onClick={jumpToBottom} title={t('chat.scrollLatest')}>
          <span className="jump-arrow">↓</span> {t('chat.latest')}
        </button>
      )}
    </div>
  )
}
