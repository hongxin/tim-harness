/**
 * TurnStackManager —— 回合堆叠管理器
 *
 * 核心思想：不在渲染层做补丁，而是在数据映射层做结构性重组。
 *
 * 问题：一个回合内 n 个连续 assistant 消息各自创建节点 → 位置重叠 → 遮挡
 * 加上工具分散挂在不同 assistant 节点上 → 因果链断裂
 *
 * 解法：
 * 1. 映射阶段：检测连续 assistant → 合并为一个"超级节点"（collapsed）
 *    超级节点携带所有步骤信息 + 所有工具的引用
 * 2. 渲染阶段：collapsed 画为一个堆叠卡片；expanded 画为多个独立节点
 * 3. 交互：点击超级节点 → 展开为步骤链（带动画）
 *
 * 数据结构变革：
 * 之前：N 个 assistant 节点（重叠在同一位置）
 * 之后：1 个 TurnStackNode（含 N 个 StepRecord）
 */

import type { CosmosNode2D, CosmosEdge2D, TurnCluster } from './CosmosCanvas2D'
import { TOOL_HUE } from './CosmosCanvas2D'

/* ══════════════════════════════════════════════════════
   类型定义
   ══════════════════════════════════════════════════════ */

/** 一个 assistant 步骤（一轮推理 + 工具调用） */
export interface StepRecord {
  content: string
  toolCalls: Array<{ name: string; ok: boolean; durationMs: number }>
  /** 原始消息索引 */
  msgIndex: number
}

/** 扩展节点：一个回合的完整 assistant 活动 */
export interface TurnStackNode extends Omit<CosmosNode2D, 'kind'> {
  kind: 'turn-stack'
  steps: StepRecord[]
  expanded: boolean
  /** 展开时各步骤的目标位置 */
  expandedPositions: Array<{ x: number; y: number }>
  /** 所有工具节点 id（属于此回合） */
  toolIds: string[]
  /** 展开/收拢动画进度 (0=收拢, 1=展开) */
  animProgress: number
}

/* ══════════════════════════════════════════════════════
   映射器：消息 → 结构化节点（含回合堆叠）
   ══════════════════════════════════════════════════════ */

const GAP = 340
const USER_Y = -220
const TOOL_Y0 = 220
const TOOL_DH = 90
const R = { user: 40, assistant: 30, tool: 18, 'turn-stack': 34, core: 46 }

export function mapSessionToCosmosV2(
  msgs: Array<{
    role: string; content?: string | null
    tool_calls?: Array<{ id: string; name: string }>
    tool_call_id?: string; name?: string
    toolOk?: boolean; durationMs?: number
  }>,
  folded: number,
): { nodes: CosmosNode2D[]; edges: CosmosEdge2D[]; clusters: TurnCluster[] } {
  const nodes: (CosmosNode2D | TurnStackNode)[] = []
  const edges: CosmosEdge2D[] = []
  const clusters: TurnCluster[] = []
  let turn = 0
  let prevLast: string | null = null

  // 压缩核心
  if (folded > 0) {
    nodes.push({
      id: 'core', kind: 'core' as any, content: `⚡ ${folded} 条`,
      turnId: -1, birthTime: performance.now(),
      x: -GAP, y: 0, vx: 0, vy: 0, radius: R.core, pinned: false, hue: 45,
    })
    prevLast = 'core'
  }

  const visible = msgs.slice(folded)
  let i = 0

  while (i < visible.length) {
    const msg = visible[i]
    const now = performance.now()

    if (msg.role === 'user') {
      turn++
      const id = `u${i}`
      const tx = turn * GAP
      nodes.push({
        id, kind: 'user', content: (msg.content ?? '').slice(0, 120),
        turnId: turn, birthTime: now,
        x: tx, y: USER_Y, vx: 0, vy: 0, radius: R.user, pinned: false, hue: 30,
      })
      if (prevLast) edges.push({ id: `xt${i}`, fromId: prevLast, toId: id, type: 'cross-turn' })
      prevLast = id
      i++
      continue
    }

    if (msg.role === 'assistant') {
      // ═══ 收集此回合内所有连续的 assistant + tool 消息 ═══
      const steps: StepRecord[] = []
      const toolResults = new Map<string, { ok: boolean; dur: number }>()
      let j = i

      while (j < visible.length) {
        const m = visible[j]
        if (m.role === 'assistant') {
          steps.push({
            content: (m.content ?? '').slice(0, 80) || `${m.tool_calls?.length ?? 0} 工具`,
            toolCalls: (m.tool_calls ?? []).map((tc) => ({ name: tc.name, ok: true, durationMs: 0 })),
            msgIndex: folded + j,
          })
          j++
        } else if (m.role === 'tool' && m.tool_call_id) {
          toolResults.set(m.tool_call_id, { ok: m.toolOk !== false, dur: m.durationMs ?? 0 })
          // 更新对应步骤的工具结果
          const lastStep = steps[steps.length - 1]
          if (lastStep) {
            const tc = lastStep.toolCalls.find((t) => !t.durationMs)
            if (tc) { tc.ok = m.toolOk !== false; tc.durationMs = m.durationMs ?? 0 }
          }
          j++
        } else {
          break // user 消息或其他 → 结束此回合的 assistant 块
        }
      }

      // ═══ 创建回合堆叠节点 ═══
      const id = `ts${turn}`
      const tx = turn * GAP
      const stepCount = steps.length

      if (stepCount === 1) {
        // 单步骤：普通 assistant 节点
        nodes.push({
          id: `a${i}`, kind: 'assistant',
          content: steps[0].content,
          turnId: turn, birthTime: now,
          x: tx, y: 0, vx: 0, vy: 0, radius: R.assistant, pinned: false, hue: 260,
        })
        // 工具
        for (const tc of steps[0].toolCalls) {
          const tid = `t${i}_${steps[0].toolCalls.indexOf(tc)}`
          nodes.push({
            id: tid, kind: 'tool', content: tc.name, toolName: tc.name,
            isError: !tc.ok, durationMs: tc.durationMs,
            turnId: turn, birthTime: now,
            x: tx + (steps[0].toolCalls.indexOf(tc) % 3 - 1) * 80,
            y: TOOL_Y0 + Math.floor(steps[0].toolCalls.indexOf(tc) / 3) * TOOL_DH,
            vx: 0, vy: 0, radius: R.tool, pinned: false, hue: TOOL_HUE[tc.name] ?? 210,
          })
          edges.push({ id: `g_${tid}`, fromId: `a${i}`, toId: tid, type: 'grid' })
        }
        prevLast = `a${i}`
      } else {
        // 多步骤：回合堆叠节点
        const stackNode: TurnStackNode = {
          id, kind: 'turn-stack' as any,
          content: `${stepCount} 步推理`,
          turnId: turn, birthTime: now,
          x: tx, y: 0, vx: 0, vy: 0, radius: R['turn-stack'], pinned: false, hue: 260,
          steps,
          expanded: false,
          expandedPositions: [],
          toolIds: [],
          animProgress: 0,
        }

        // 工具节点：全部挂在堆叠节点下
        let toolIdx = 0
        for (const step of steps) {
          for (const tc of step.toolCalls) {
            const tid = `t${turn}_${toolIdx}`
            nodes.push({
              id: tid, kind: 'tool', content: tc.name, toolName: tc.name,
              isError: !tc.ok, durationMs: tc.durationMs,
              turnId: turn, birthTime: now,
              x: tx + (toolIdx % 3 - 1) * 80,
              y: TOOL_Y0 + Math.floor(toolIdx / 3) * TOOL_DH,
              vx: 0, vy: 0, radius: R.tool, pinned: false, hue: TOOL_HUE[tc.name] ?? 210,
            })
            edges.push({ id: `g_${tid}`, fromId: id, toId: tid, type: 'grid' })
            stackNode.toolIds.push(tid)
            toolIdx++
          }
        }

        // 计算展开位置（每步垂直排列）
        const stepH = 70
        stackNode.expandedPositions = steps.map((_, si) => ({
          x: tx,
          y: (si - (steps.length - 1) / 2) * stepH,
        }))

        nodes.push(stackNode)
        prevLast = id
      }

      i = j // 跳到处理完的位置
      continue
    }

    if (msg.role === 'tool') {
      // 工具结果已在上面处理，跳过
      i++
      continue
    }

    i++ // 其他角色跳过
  }

  return { nodes: nodes as CosmosNode2D[], edges, clusters }
}

/* ══════════════════════════════════════════════════════
   堆叠节点渲染器
   ══════════════════════════════════════════════════════ */

export function drawTurnStackNode(
  ctx: CanvasRenderingContext2D,
  node: TurnStackNode,
  sx: number, sy: number, er: number,
  now: number,
  isDark: boolean,
  zoom: number,
  isExpanded: boolean,
): void {
  const n = node.steps.length
  if (n <= 1) return

  ctx.save()

  if (!isExpanded) {
    // ═══ 收拢状态：堆叠卡片效果 ═══
    
    // 底层卡片（最多显示4层，递减透明度）
    const layers = Math.min(n, 4)
    const spacing = 3
    
    for (let l = layers - 1; l >= 1; l--) {
      ctx.globalAlpha = 0.15 + l * 0.06
      ctx.fillStyle = isDark
        ? `hsl(260, 30%, ${12 + l * 3}%)`
        : `hsl(260, 20%, ${88 - l * 3}%)`
      ctx.beginPath()
      ctx.arc(sx + l * spacing * 0.3, sy + l * spacing, er * 0.92, 0, Math.PI * 2)
      ctx.fill()
      // 边框
      ctx.strokeStyle = `hsla(260, 40%, ${isDark ? 40 : 60}%, 0.2)`
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // 顶层卡片
    ctx.globalAlpha = 1
    const bodyGrad = ctx.createRadialGradient(sx - er*0.3, sy - er*0.3, 0, sx, sy, er)
    bodyGrad.addColorStop(0, `hsla(260, 50%, ${isDark ? 35 : 60}%, 0.9)`)
    bodyGrad.addColorStop(1, `hsla(260, 40%, ${isDark ? 20 : 45}%, 0.8)`)
    ctx.beginPath()
    ctx.arc(sx, sy, er, 0, Math.PI * 2)
    ctx.fillStyle = bodyGrad
    ctx.fill()
    ctx.strokeStyle = `hsla(260, 50%, ${isDark ? 50 : 40}%, 0.5)`
    ctx.lineWidth = 1.5
    ctx.stroke()

    // 步骤数徽章（醒目但不喧宾夺主）
    if (zoom > 0.3) {
      const br = Math.max(8, er * 0.3)
      const bx = sx + er * 0.65
      const by = sy - er * 0.65
      
      // 徽章底
      ctx.fillStyle = isDark ? '#58A6FF' : '#0969DA'
      ctx.beginPath()
      ctx.arc(bx, by, br, 0, Math.PI * 2)
      ctx.fill()
      
      // 数字
      ctx.fillStyle = '#FFFFFF'
      ctx.font = `bold ${br * 0.9}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(n), bx, by)
    }

    // "点击展开"提示（hover 时显示）
    if (zoom > 0.5) {
      ctx.fillStyle = `hsla(0, 0%, ${isDark ? 60 : 40}%, 0.5)`
      ctx.font = `${9 * zoom}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText('▸ 点击展开', sx, sy + er * 0.55)
    }

    // 步骤预览（低透明度，在圆盘内部显示步骤序列）
    if (zoom > 0.6 && n <= 5) {
      ctx.font = `${8 * zoom}px monospace`
      ctx.fillStyle = `hsla(0, 0%, ${isDark ? 70 : 30}%, 0.4)`
      ctx.textAlign = 'center'
      for (let si = 0; si < Math.min(n, 3); si++) {
        const stepText = `${si + 1}. ${node.steps[si].content.slice(0, 15)}`
        ctx.fillText(stepText, sx, sy - er * 0.3 + si * 10 * zoom)
      }
      if (n > 3) ctx.fillText('...', sx, sy - er * 0.3 + 3 * 10 * zoom)
    }
  } else {
    // ═══ 展开状态：步骤链 ═══
    
    const stepH = 70 * zoom
    const startY = sy - (n - 1) * stepH / 2
    
    for (let si = 0; si < n; si++) {
      const stepY = startY + si * stepH
      
      // 步骤节点
      const stepR = er * 0.6
      const stepGrad = ctx.createRadialGradient(sx - stepR*0.3, stepY - stepR*0.3, 0, sx, stepY, stepR)
      stepGrad.addColorStop(0, `hsla(260, 55%, ${isDark ? 40 : 55}%, 0.9)`)
      stepGrad.addColorStop(1, `hsla(260, 40%, ${isDark ? 25 : 45}%, 0.8)`)
      ctx.beginPath()
      ctx.arc(sx, stepY, stepR, 0, Math.PI * 2)
      ctx.fillStyle = stepGrad
      ctx.fill()
      ctx.strokeStyle = `hsla(260, 50%, ${isDark ? 50 : 40}%, 0.4)`
      ctx.lineWidth = 1
      ctx.stroke()

      // 步骤编号
      ctx.fillStyle = '#FFFFFF'
      ctx.font = `bold ${stepR * 0.5}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(si + 1), sx, stepY - stepR * 0.3)

      // 步骤内容
      if (zoom > 0.5) {
        ctx.fillStyle = isDark ? '#C9D1D9' : '#57606A'
        ctx.font = `${9 * zoom}px -apple-system, sans-serif`
        ctx.fillText(
          node.steps[si].content.slice(0, 20),
          sx, stepY + stepR * 0.3
        )
      }

      // 步骤间的连接箭头
      if (si < n - 1) {
        ctx.strokeStyle = `hsla(260, 40%, ${isDark ? 50 : 40}%, 0.3)`
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(sx, stepY + stepR)
        ctx.lineTo(sx, stepY + stepH - stepR)
        ctx.stroke()
        ctx.setLineDash([])
        // 箭头
        ctx.fillStyle = `hsla(260, 40%, ${isDark ? 50 : 40}%, 0.5)`
        ctx.beginPath()
        ctx.moveTo(sx - 3, stepY + stepH - stepR - 4)
        ctx.lineTo(sx + 3, stepY + stepH - stepR - 4)
        ctx.lineTo(sx, stepY + stepH - stepR)
        ctx.closePath()
        ctx.fill()
      }
    }

    // "点击收起"提示
    ctx.fillStyle = `hsla(0, 0%, ${isDark ? 60 : 40}%, 0.5)`
    ctx.font = `${9 * zoom}px sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText('▾ 点击收起', sx, startY + n * stepH + 10)
  }

  ctx.restore()
}
