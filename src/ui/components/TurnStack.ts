/**
 * Expandable Turn Stack —— 可展开的回合堆叠
 *
 * 问题：一个回合内 n 个连续 assistant 应答被压缩成一个节点 → 钻入分析不便
 * 解法：概览时堆叠为一个圆盘（像一叠扑克牌），点击后扇形展开为独立步骤
 *
 * 交互：
 * - 概览：每个回合一个 assistant 节点（显示"N 步"计数徽章）
 * - 点击：展开为 n 个独立节点（垂直排列，每步带自己的工具）
 * - 再点：收拢回堆叠
 * - 展开动画：从堆叠位置弹性展开到各自位置
 */



export interface AssistantStep {
  /** 这一步的 assistant 消息内容 */
  content: string
  /** 这一步触发的工具调用 */
  toolCalls: Array<{ name: string; result?: string }>
  /** 在消息数组中的索引 */
  msgIndex: number
}

export interface TurnStack {
  turnId: number
  /** 是否展开 */
  expanded: boolean
  /** 堆叠位置（收拢时的中心点） */
  stackX: number; stackY: number
  /** 展开后的各步骤位置 */
  stepPositions: Array<{ x: number; y: number }>
  /** 包含的 assistant 步骤 */
  steps: AssistantStep[]
  /** 属于此回合的工具节点 id 列表 */
  toolNodeIds: string[]
}

/**
 * 从消息数组中提取回合堆叠结构
 * 一个回合 = 用户消息 → [assistant+tools] × n → 最终 assistant 回答
 */
export function buildTurnStacks(
  messages: Array<{
    role: string; content?: string | null
    tool_calls?: Array<{ id: string; name: string }>
    tool_call_id?: string; name?: string
  }>,
  foldedCount: number,
): Map<number, TurnStack> {
  const stacks = new Map<number, TurnStack>()
  let currentTurn = 0
  let currentStack: TurnStack | null = null

  messages.slice(foldedCount).forEach((msg, i) => {
    if (msg.role === 'user') {
      currentTurn++
      currentStack = null // 新回合
    } else if (msg.role === 'assistant') {
      if (!currentStack) {
        currentStack = {
          turnId: currentTurn,
          expanded: false,
          stackX: 0, stackY: 0,
          stepPositions: [],
          steps: [],
          toolNodeIds: [],
        }
        stacks.set(currentTurn, currentStack)
      }
      currentStack.steps.push({
        content: (msg.content ?? '').slice(0, 80) || `${msg.tool_calls?.length ?? 0} 个工具`,
        toolCalls: (msg.tool_calls ?? []).map((tc) => ({ name: tc.name })),
        msgIndex: foldedCount + i,
      })
    }
  })

  return stacks
}

/**
 * 绘制堆叠效果（收拢状态）
 * 视觉：像一叠扑克牌——底层卡片微微偏移，顶层完整显示
 * + 一个"N 步"计数徽章
 */
export function drawStackEffect(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  radius: number,
  stepCount: number,
  hue: number,
  isDark: boolean,
  zoom: number,
): void {
  if (stepCount <= 1) return // 只有一步不需要堆叠效果

  ctx.save()

  const offset = Math.min(4, stepCount) // 最多显示 4 层
  const spacing = 2.5

  // 底层卡片（偏移产生"一叠"效果）
  for (let i = offset - 1; i >= 1; i--) {
    const ox = i * spacing * 0.4
    const oy = i * spacing
    ctx.globalAlpha = 0.25 - i * 0.04
    ctx.fillStyle = `hsla(${hue}, 50%, ${isDark ? 35 : 60}%, 1)`
    ctx.beginPath()
    ctx.arc(cx + ox, cy + oy, radius * 0.95, 0, Math.PI * 2)
    ctx.fill()
  }

  // 顶层卡片（正常渲染）
  ctx.globalAlpha = 1

  // 计数徽章
  if (zoom > 0.4) {
    const badgeR = radius * 0.35
    const bx = cx + radius * 0.7
    const by = cy - radius * 0.7
    // 徽章底
    ctx.fillStyle = isDark ? 'rgba(88, 166, 255, 0.9)' : 'rgba(9, 105, 218, 0.9)'
    ctx.beginPath()
    ctx.arc(bx, by, badgeR, 0, Math.PI * 2)
    ctx.fill()
    // 数字
    ctx.fillStyle = '#FFFFFF'
    ctx.font = `bold ${Math.max(8, badgeR * 0.8)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(stepCount), bx, by)
  }

  ctx.restore()
}

/**
 * 计算展开后的各步骤位置
 * 扇形展开：从堆叠中心向下垂直排列，每步带自己的工具区
 */
export function computeExpandedPositions(
  stack: TurnStack,
  stepHeight: number,
): Array<{ x: number; y: number }> {
  const n = stack.steps.length
  const positions: Array<{ x: number; y: number }> = []
  for (let i = 0; i < n; i++) {
    // 垂直排列，从堆叠位置向下展开
    const y = stack.stackY + i * stepHeight
    // 轻微左右交错（视觉丰富度）
    const x = stack.stackX + (i % 2 === 0 ? -10 : 10) * (i > 0 ? 1 : 0)
    positions.push({ x, y })
  }
  return positions
}

/**
 * 绘制展开/收拢动画的过渡
 * t=0: 完全收拢（堆叠位置）
 * t=1: 完全展开（各自位置）
 */
export function lerpPosition(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2 // easeInOutQuad
  return {
    x: from.x + (to.x - from.x) * ease,
    y: from.y + (to.y - from.y) * ease,
  }
}
