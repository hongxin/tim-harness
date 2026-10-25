/** 工具调用卡片：状态、参数摘要、可展开详情（成功默认折叠、失败自动展开） */
import { useTranslation } from '../../i18n/useTranslation'
import { useState } from 'react'
import type { ChatMessage } from '../../core/types'

/** 展开渲染上限：完整内容仍在会话记录里，这里只保 DOM 不被超长输出压垮 */
const BODY_CAP = 50_000

const TOOL_GLYPHS: Record<string, string> = {
  ls: '▤',
  read_file: '◉',
  write_file: '✎',
  edit_file: '✂',
  grep: '⌕',
  glob: '❋',
  run_js: '▷',
  web_fetch: '⇲',
  web_search: '⌕',
  todo_write: '☑',
  spawn_agent: '⑃',
  ask_user: '?',
}

function argSummary(name: string, argsRaw?: string): string {
  if (!argsRaw) return ''
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsRaw)
  } catch {
    return argsRaw.slice(0, 60)
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = args[k]
      if (typeof v === 'string' && v) return v
    }
    return undefined
  }
  const p = pick('path', 'file', 'query', 'pattern', 'question', 'url')
  if (p) return p.length > 72 ? p.slice(0, 72) + '…' : p
  if (name === 'todo_write' && Array.isArray(args.todos)) return `${args.todos.length} 项任务`
  if (name === 'run_js') {
    const code = typeof args.code === 'string' ? args.code : ''
    return `${code.split('\n').length} 行 JS`
  }
  if (name === 'spawn_agent') return pick('description') ?? t('tool.subtask')
  const keys = Object.keys(args)
  return keys.length ? `${keys[0]}: ${String(args[keys[0]]).slice(0, 40)}` : ''
}

function renderOut(content?: string | null): string {
  const c = content ?? ''
  if (c.length <= BODY_CAP) return c
  return c.slice(0, BODY_CAP) + `\n…[${t('tool.truncated', { total: c.length.toLocaleString() })}]`
}

export function ToolCallCard({ msg }: { msg: ChatMessage }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(msg.toolOk === false) // 静默成功、喧哗失败
  const ok = msg.toolOk
  const dur = msg.durationMs != null ? (msg.durationMs < 1000 ? `${msg.durationMs}ms` : `${(msg.durationMs / 1000).toFixed(1)}s`) : ''
  const glyph = TOOL_GLYPHS[msg.name ?? ''] ?? '·'
  let prettyArgs = ''
  if (msg.args) {
    try {
      prettyArgs = JSON.stringify(JSON.parse(msg.args), null, 2)
    } catch {
      prettyArgs = msg.args
    }
  }
  return (
    <div className={`toolcard ${ok === false ? 'toolcard-err' : ''}`}>
      <button type="button" className="toolcard-head" onClick={() => setOpen((v) => !v)}>
        <span className={`toolcard-dot ${ok === false ? 'dot-err' : ok === true ? 'dot-ok' : 'dot-run'}`} />
        <span className="toolcard-glyph">{glyph}</span>
        <span className="toolcard-name">{msg.name}</span>
        <span className="toolcard-summary">{argSummary(msg.name ?? '', msg.args)}</span>
        <span className="toolcard-dur">{dur}</span>
        <span className={`toolcard-chev ${open ? 'open' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="toolcard-body">
          {prettyArgs && (
            <details className="toolcard-args" open={false}>
              <summary>{t('tool.params')}</summary>
              <pre>{prettyArgs}</pre>
            </details>
          )}
          <pre className="toolcard-out">{renderOut(msg.content)}</pre>
        </div>
      )}
    </div>
  )
}
