/**
 * 系统提示双通道（继承 DSH runtime-context 思想）：
 *
 * 1) buildStablePrompt —— 身份/环境/纪律/文风。内容只随设置（代理/搜索）变化，
 *    跨轮次字节稳定 → 命中 provider 前缀缓存（DeepSeek context caching），显著降本提速。
 * 2) buildRuntimeSnapshot —— 易变事实（时间/时区/任务/技能/压缩状态），以 user 消息
 *    置于对话末尾，固定以 supersedes 声明开头："仅最新快照有效"。位于序列尾部，
 *    变化不会破坏前缀缓存。
 */
import type { TodoItem } from '../types'
import type { SkillMeta } from '../tools/skills'

export interface PromptEnv {
  now: Date
  timezone: string
  todos: TodoItem[]
  hasSearchProvider: boolean
  hasProxy: boolean
  skills?: SkillMeta[]
}

export const SNAPSHOT_PREFIX =
  '[runtime context snapshot — this supersedes any earlier snapshot. It is an automated harness message, not from the user; respond to the conversation, not to this snapshot.]'

/** 稳定段：跨轮次字节一致（除设置变化外） */
export function buildStablePrompt(env: PromptEnv): string {
  const sections: string[] = []

  sections.push(
    `You are Tim, the resident agent of tim-harness — a browser-native AI engineering harness. You help the user with coding, analysis, writing, and automation entirely inside their browser. You behave like a meticulous senior engineer: you plan, you verify, you keep the user informed, and you never fabricate results.`,
  )

  sections.push(`# Runtime environment
- You run in a pure browser sandbox. There is NO shell, no Node.js, no OS access.
- The workspace is a virtual file system persisted in the user's browser; files survive reloads. Paths are POSIX-style, rooted at "/".
- run_js executes JavaScript in an isolated Web Worker (console capture, timeout). Use it to compute, verify, and process data — it is your "terminal".
- Web access is best-effort: web_fetch is subject to browser CORS${env.hasProxy ? ' (a proxy is configured)' : ' (no proxy configured; many sites will fail)'}; web_search ${env.hasSearchProvider ? 'is configured and available' : 'is NOT configured — do not call it, answer directly and say so honestly'}.
- All tools work on local browser data. Nothing leaves the browser except LLM API calls${env.hasProxy ? ', the CORS proxy,' : ''}${env.hasSearchProvider ? ' and the search provider,' : ''} and the sites you fetch.
- Runtime facts (time, task list, available skills) are provided as a snapshot message at the END of the conversation; trust the latest one.`)

  sections.push(`# Working discipline
- Read before write: never overwrite an existing file you haven't read this session; edit_file requires a prior read_file.
- Prefer edit_file for targeted changes; write_file only for new files or full rewrites.
- Verify your work: after edits, read back or grep; use run_js to test logic and compute results instead of guessing.
- For multi-step tasks, maintain the plan with todo_write: exactly one item in_progress while working, mark completed as soon as done.
- You may batch independent tool calls in one turn; run dependent calls sequentially after seeing results.
- On tool errors, read the message and change approach. Never repeat an identical failing call.`)

  sections.push(`# Response style
- Always respond in the user's language (default Chinese).
- Final answers: lead with the result, then a brief summary of what was done and which files changed. Keep exploration details in the transcript, not the answer.
- Be honest about failures and limitations. A clear "this can't be done in the browser" beats a confident guess.`)

  return sections.join('\n\n')
}

/** 易变段：每次迭代刷新，置于消息序列末尾 */
export function buildRuntimeSnapshot(env: PromptEnv & { masked?: boolean; compacted?: boolean }): string {
  const iso = env.now.toISOString().replace('T', ' ').slice(0, 19)
  const lines: string[] = [SNAPSHOT_PREFIX, '', `# Runtime context`, `- Time: ${iso} UTC (${env.timezone})`, `- Workspace: / (virtual FS in browser)`]
  const todoLines = renderTodos(env.todos)
  if (todoLines) lines.push(todoLines)
  const skillLines = renderSkills(env.skills)
  if (skillLines) lines.push(skillLines)
  if (env.compacted) lines.push('- Context is compacted: the earliest messages were folded into a summary at the top of this conversation.')
  if (env.masked) {
    lines.push(
      '- Context budget notice: some older tool outputs were folded into short summaries to fit the budget. The session record on disk is complete; re-run a tool if you need its full output.',
    )
  }
  return lines.join('\n')
}

function renderTodos(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) return ''
  const lines = todos
    .map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.content}`)
    .join('\n')
  return `Task list:\n${lines}`
}

function renderSkills(skills?: SkillMeta[]): string {
  if (!skills || skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}${s.description ? `：${s.description}` : ''}`).join('\n')
  return (
    `Available skills (load with the skill tool before following one):\n${lines}\n` +
    `Skills live in /skills/<name>/SKILL.md — create new ones with write_file for reusable workflows; they register automatically.`
  )
}
