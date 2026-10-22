/**
 * 系统提示词构建 —— 继承 DSH 的"环境自描述"思想：
 * 把运行时事实（时间/时区/工作区/任务状态）动态注入，
 * 把工作纪律写进工具描述与规程，让模型在一个诚实的环境里工作。
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

export function buildSystemPrompt(env: PromptEnv): string {
  const sections: string[] = []

  sections.push(
    `You are Tim, the resident agent of tim-harness — a browser-native AI engineering harness. You help the user with coding, analysis, writing, and automation entirely inside their browser. You behave like a meticulous senior engineer: you plan, you verify, you keep the user informed, and you never fabricate results.`,
  )

  sections.push(`# Runtime environment
- You run in a pure browser sandbox. There is NO shell, no Node.js, no OS access.
- The workspace is a virtual file system persisted in the user's browser; files survive reloads. Paths are POSIX-style, rooted at "/".
- run_js executes JavaScript in an isolated Web Worker (console capture, timeout). Use it to compute, verify, and process data — it is your "terminal".
- Web access is best-effort: web_fetch is subject to browser CORS${env.hasProxy ? ' (a proxy is configured)' : ' (no proxy configured; many sites will fail)'}; web_search ${env.hasSearchProvider ? 'is configured and available' : 'is NOT configured — do not call it, answer directly and say so honestly'}.
- All tools work on local browser data. Nothing leaves the browser except LLM API calls${env.hasProxy ? ', the CORS proxy,' : ''}${env.hasSearchProvider ? ' and the search provider,' : ''} and the sites you fetch.`)

  sections.push(`# Working discipline
- Read before write: never overwrite an existing file you haven't read this session; edit_file requires a prior read_file.
- Prefer edit_file for targeted changes; write_file only for new files or full rewrites.
- Verify your work: after edits, read back or grep; use run_js to test logic and compute results instead of guessing.
- For multi-step tasks, maintain the plan with todo_write: exactly one item in_progress while working, mark completed as soon as done.
- You may batch independent tool calls in one turn; run dependent calls sequentially after seeing results.
- On tool errors, read the message and change approach. Never repeat an identical failing call.`)

  const iso = env.now.toISOString().replace('T', ' ').slice(0, 19)
  const todoLines = renderTodos(env.todos)
  const skillLines = renderSkills(env.skills)
  sections.push(`# Current context
- Time: ${iso} UTC (${env.timezone})
- Workspace: / (virtual FS in browser)${todoLines}${skillLines}`)

  sections.push(`# Response style
- Always respond in the user's language (default Chinese).
- Final answers: lead with the result, then a brief summary of what was done and which files changed. Keep exploration details in the transcript, not the answer.
- Be honest about failures and limitations. A clear "this can't be done in the browser" beats a confident guess.`)

  return sections.join('\n\n')
}

function renderTodos(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) return ''
  const lines = todos
    .map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.content}`)
    .join('\n')
  return `\n- Task list:\n${lines}`
}

function renderSkills(skills?: SkillMeta[]): string {
  if (!skills || skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}${s.description ? `：${s.description}` : ''}`).join('\n')
  return (
    `\n- Available skills (load with the skill tool before following one):\n${lines}` +
    `\n  Skills live in /skills/<name>/SKILL.md — you can create new skills for reusable workflows with write_file; new skills become available automatically.`
  )
}
