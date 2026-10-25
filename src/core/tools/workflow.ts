/**
 * todo_write / spawn_agent / ask_user —— 继承自 DSH 的 harness 编排类工具。
 */
import type { ToolDef, TodoStatus } from '../types'

const TODO_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']

export const todoWriteTool: ToolDef = {
  name: 'todo_write',
  description:
    'Create or replace the task list for the current session. Use it whenever a task needs 2+ steps: set exactly one item to in_progress while working, and mark items completed as soon as they are done. The list is shown to the user in real time.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full task list (replaces the previous one)',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short imperative description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(args, ctx) {
    const raw = Array.isArray(args.todos) ? args.todos : []
    if (raw.length > 50) return { ok: false, output: 'Error: 任务数量超过上限 50' }
    const todos = []
    for (const item of raw) {
      const content = String(item?.content ?? '').trim()
      const status = String(item?.status ?? '') as TodoStatus
      if (!content) return { ok: false, output: 'Error: 任务 content 不能为空' }
      if (!TODO_STATUSES.includes(status)) {
        return { ok: false, output: `Error: 非法 status "${status}"，允许值：${TODO_STATUSES.join(', ')}` }
      }
      todos.push({ content, status })
    }
    ctx.state.todos.splice(0, ctx.state.todos.length, ...todos)
    const inProgress = todos.filter((t) => t.status === 'in_progress').length
    if (inProgress > 1) {
      return {
        ok: true,
        output: `已更新任务列表（${todos.length} 项）。提示：同时有 ${inProgress} 项 in_progress，建议聚焦为 1 项。`,
      }
    }
    return { ok: true, output: `已更新任务列表（${todos.length} 项）。` }
  },
}

export const askUserTool: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. The user sees the question in the chat and can answer by clicking an option or typing.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The specific question (one at a time)' },
      options: {
        type: 'array',
        description: 'Optional 2-4 short choices',
        items: { type: 'string' },
      },
    },
    required: ['question'],
  },
  timeoutMs: 24 * 60 * 60 * 1000, // 等待用户回答不受短超时约束
  async execute(args, ctx) {
    const question = String(args.question ?? '').trim()
    if (!question) return { ok: false, output: 'Error: question 不能为空' }
    const options = Array.isArray(args.options)
      ? args.options.slice(0, 4).map((o) => ({ label: String(o) }))
      : undefined
    const answer = await ctx.ui.askUser(question, options)
    return { ok: true, output: `[用户回答] ${answer || '(跳过)'}` }
  },
}

export const spawnAgentTool: ToolDef = {
  name: 'spawn_agent',
  description:
    'Delegate a self-contained task to a fresh subagent that works in its own context (own model per settings — often a cheaper one, same workspace tools, no spawn_agent to avoid recursion). It returns the final report only. Use it for focused independent work — research, a scoped implementation, an audit — to conserve this conversation\'s context.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '3-5 word summary for display' },
      prompt: {
        type: 'string',
        description: 'Complete, self-contained task instructions including everything the subagent needs',
      },
    },
    required: ['prompt'],
  },
  timeoutMs: 10 * 60 * 1000,
  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '').trim()
    const description = String(args.description ?? '子任务')
    if (!prompt) return { ok: false, output: 'Error: prompt 不能为空' }
    const r = await ctx.subagent.run(prompt, description)
    if (!r.ok) return { ok: false, output: `子代理未完成：${r.report}` }
    return { ok: true, output: r.report }
  },
}
