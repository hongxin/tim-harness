/**
 * goal_update 工具 —— DSH goal 轮次驱动的模型侧接口。
 * 智能体由此标记目标完成/阻塞/暂停；目标创建与轮次驱动由用户经 UI 发起。
 */
import type { GoalStatus, ToolDef } from '../types'

const STATUSES: GoalStatus[] = ['active', 'paused', 'complete', 'blocked']

export const goalUpdateTool: ToolDef = {
  name: 'goal_update',
  description:
    'Update the session goal in goal-driven mode. Call with status "complete" when the objective is fully achieved (then summarize the outcome), "blocked" when you cannot proceed (explain in note), or "paused" to hand control back to the user. Optionally refine the objective wording.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: STATUSES, description: 'New goal status' },
      note: { type: 'string', description: 'Reason / summary (required for blocked)' },
      objective: { type: 'string', description: 'Optional refined objective text' },
    },
    required: ['status'],
  },
  async execute(args, ctx) {
    const status = String(args.status ?? '') as GoalStatus
    if (!STATUSES.includes(status)) {
      return { ok: false, output: `Error: 非法 status "${status}"，允许值：${STATUSES.join(', ')}` }
    }
    const goal = ctx.state.session.goal
    if (!goal) {
      return { ok: false, output: 'Error: 当前会话没有目标。目标由用户在界面（🎯）发起，请引导用户设置。' }
    }
    const note = String(args.note ?? '').trim()
    if (status === 'blocked' && !note) {
      return { ok: false, output: 'Error: 标记 blocked 时必须给出 note 说明阻塞原因。' }
    }
    if (typeof args.objective === 'string' && args.objective.trim()) {
      goal.objective = args.objective.trim().slice(0, 500)
    }
    goal.status = status
    goal.note = note || goal.note
    goal.updatedAt = Date.now()
    return {
      ok: true,
      output: `目标状态已更新为 ${status}${note ? `（${note}）` : ''}。${status === 'complete' ? '请给出面向用户的成果总结。' : ''}`,
    }
  },
}
