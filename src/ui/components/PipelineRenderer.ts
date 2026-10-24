/**
 * PipelineRenderer —— 垂直管道渲染器（含折叠/展开交互）
 *
 * 核心功能：
 * 1. 连续同类工具自动折叠为 "tool ×N"（缺省折叠）
 * 2. 点击折叠项 → 展开显示每个调用
 * 3. 点击展开项 → 收拢回折叠
 */

import { drawTextSafe, temporalAlpha, foldRepeats, fitToViewport } from './LayoutGuard'
import { drawPanel, drawGauge } from './PhysicalParts'

const C = {
  bg: '#0A0E14',
  user: '#FF6B9D', think: '#FFD700', tool: '#00E5FF',
  done: '#00FF88', error: '#FF4444',
  pipe: '#1C2128', pipeEdge: '#30363D', flow: '#4A9EFF',
  text: '#E6EDF3', textDim: '#9DA7B3',
}

const TOOL_ICONS: Record<string, string> = {
  read_file: '📖', write_file: '✍️', edit_file: '✂️',
  run_js: '⚡', grep: '🎯', glob: '🎯', ls: '📂',
  web_fetch: '🌐', web_search: '🔎', todo_write: '📋',
  spawn_agent: '🤖', ask_user: '❓', skill: '📚',
  goal_update: '🎯', snapshot_save: '💾', snapshot_list: '📦',
}
const toolIcon = (n: string) => TOOL_ICONS[n] ?? '🔧'
const TOOL_CATEGORY: Record<string, { cat: string; icon: string }> = {
  read_file: { cat: 'read', icon: '📖' }, write_file: { cat: 'write', icon: '✍️' },
  edit_file: { cat: 'edit', icon: '✂️' }, run_js: { cat: 'exec', icon: '⚡' },
  grep: { cat: 'search', icon: '🎯' }, glob: { cat: 'match', icon: '🎯' },
  ls: { cat: 'browse', icon: '📂' }, web_fetch: { cat: 'fetch', icon: '🌐' },
  web_search: { cat: 'search', icon: '🔎' }, skill: { cat: 'skill', icon: '📚' },
  spawn_agent: { cat: 'spawn', icon: '🤖' }, todo_write: { cat: 'plan', icon: '📋' },
  ask_user: { cat: 'ask', icon: '❓' }, snapshot_save: { cat: 'snap', icon: '💾' },
}

const TOOL_DESC: Record<string, string> = {
  read_file: '读取文件', write_file: '写入文件', edit_file: '修改文件',
  run_js: '执行代码', grep: '搜索', glob: '匹配', ls: '列目录',
  web_fetch: '抓取网页', web_search: '搜索', skill: '装载技能',
  spawn_agent: '派生子代理', ask_user: '询问', snapshot_save: '保存快照',
}

const PIPE_W_MAX = 300; const USER_H = 70; const THINK_H = 90
const DONE_H = 56; const GAP_V = 14; const GAP_H = 20
const FOOTER_H = 60

interface ToolItem {
  name: string; ok: boolean; dur: number; desc?: string
  folded?: boolean; count?: number
}

interface PipeTurn {
  turnId: number; userText: string
  thinkSteps: string[]; tools: ToolItem[]; finalText: string
  isPreCompact?: boolean
}

interface PipelineData {
  turns: PipeTurn[]; totalTokens: number
  contextUsed: number; contextMax: number
}

function parseTurns(
  msgs: Array<{ role: string; content?: string | null; tool_calls?: Array<{ id: string; name: string }>; tool_call_id?: string; name?: string; toolOk?: boolean; durationMs?: number }>,
  folded: number,
  usage?: { total_tokens?: number },
  contextInfo?: { sentChars: number; budgetChars: number },
): PipelineData {
  const turns: PipeTurn[] = []
  let current: PipeTurn | null = null

  for (let mi = 0; mi < msgs.length; mi++) {
    const msg = msgs[mi]
    if (msg.role === 'user') {
      current = {
        turnId: turns.length + 1,
        userText: (msg.content || 'Untitled').slice(0, 40),
        thinkSteps: [], tools: [], finalText: '',
        isPreCompact: mi < folded,
      }
      turns.push(current)
    } else if (msg.role === 'assistant' && current) {
      if (msg.tool_calls) {
        current.thinkSteps.push(`${msg.tool_calls.length} tools`)
        for (const tc of msg.tool_calls) {
          current.tools.push({ name: tc.name || 'unknown', ok: true, dur: 0, desc: TOOL_DESC[tc.name] ?? '' })
        }
      } else if (msg.content) {
        current.finalText = (msg.content || '').slice(0, 30)
      }
    } else if (msg.role === 'tool' && current) {
      const t = current.tools.find((tt) => tt.name === (msg.name || 'unknown') && !tt.dur)
      if (t) { t.ok = msg.toolOk !== false; t.dur = msg.durationMs ?? 0 }
    }
  }

  for (const turn of turns) {
    turn.tools = foldRepeats(turn.tools, 2) as ToolItem[]
  }

  return {
    turns,
    totalTokens: usage?.total_tokens ?? 0,
    contextUsed: contextInfo?.sentChars ?? 0,
    contextMax: contextInfo?.budgetChars ?? 1,
  }
}

export class PipelineRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private w = 0; private h = 0; private dpr = 1
  private animId = 0
  private data: PipelineData | null = null
  private zoom = 1
  private pipeW = PIPE_W_MAX
  private rowHeight = 500
  private offsetX = 0; private offsetY = 0
  private panning = false
  // ═══ 物理节点系统（简化力导向，参考 Cosmos）═══
  private physNodes = new Map<string, {
    x: number; y: number     // 当前位置
    vx: number; vy: number   // 速度
    hx: number; hy: number   // 家位置（蛇形布局）
    w: number; h: number     // 尺寸（用于碰撞检测）
    dragged: boolean          // 是否被用户拖拽过
  }>()
  private draggingId: string | null = null
  private dragGrabOffset = { dx: 0, dy: 0 }
  /** 锚点屏幕位置（render 时更新，连接线使用同一数据源） */
  private anchorPos = new Map<string, { inX: number; inY: number; outX: number; outY: number }>
  private panStart = { x: 0, y: 0 }
  private expandLevel = new Map<string, number>()
  private hitItems: Array<{ key: string; x: number; y: number; w: number; h: number }> = []

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resize()
    this.bind()
    this.loop()
  }

  destroy() { cancelAnimationFrame(this.animId); this.unbind() }

  setData(data: PipelineData) {
    this.data = data
    this.fit()
  }

  private fit() {
    if (!this.data || this.data.turns.length === 0) return
    const nTurns = this.data.turns.length
    const availW = this.w - 40
    // 用户要求：每行固定 8 个，允许超出画布（用户可缩放）
    const perRow = Math.min(nTurns, 8)
    const nRows = Math.ceil(nTurns / perRow)
    // pipeW 取合理值：优先适配画布，但不低于 100px
    // 超出画布没关系——用户可以缩放（用户明确说过）
    const idealW = (availW - (perRow - 1) * 20) / perRow // 用更小的间距
    this.pipeW = Math.max(100, idealW)
        this.rowHeight = USER_H + THINK_H + 50 + DONE_H + GAP_V * 4 + 20
    const contentW = perRow * (this.pipeW + GAP_H) - GAP_H
    const contentH = nRows * this.rowHeight
    const fit = fitToViewport(contentW, contentH, this.w, this.h - FOOTER_H, 1.0, 20, 0.45)
    this.zoom = fit.zoom
    this.offsetX = fit.offsetX
    this.offsetY = fit.offsetY
  }

  private resize() {
    const p = this.canvas.parentElement
    if (!p) return
    this.dpr = window.devicePixelRatio || 1
    this.w = p.clientWidth; this.h = p.clientHeight
    this.canvas.width = this.w * this.dpr; this.canvas.height = this.h * this.dpr
    this.canvas.style.width = `${this.w}px`; this.canvas.style.height = `${this.h}px`
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (this.data) this.fit()
  }

  private bind() {
    this.canvas.addEventListener('wheel', this.onWheel)
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('pointermove', this.onMove)
    this.canvas.addEventListener('pointerup', this.onUp)
    window.addEventListener('resize', this.onResize)
  }
  private unbind() {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('resize', this.onResize)
  }

  private onResize = () => { this.resize() }
  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.zoom = Math.max(0.3, Math.min(2.5, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)))
  }

  private onDown = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect()
    const sx = e.clientX - r.left, sy = e.clientY - r.top

    // 点击检测：折叠/展开项
    for (const item of this.hitItems) {
      if (sx >= item.x && sx <= item.x + item.w && sy >= item.y && sy <= item.y + item.h) {
        const turnId = item.key.split(':')[0]
        if (item.key.endsWith(':all')) {
          this.expandLevel.set(turnId, 2)
        } else {
          const cur = this.expandLevel.get(turnId) ?? 0
          this.expandLevel.set(turnId, cur === 0 ? 1 : 0)
        }
        return
      }
    }

    // ═══ STATION 拖拽检测 ═══
    for (const [id, node] of this.physNodes) {
      const nsx = node.x * this.zoom + this.offsetX
      const nsy = this.offsetY + node.y
      const nw = this.pipeW * this.zoom
      const nh = 250 * this.zoom
      if (sx >= nsx && sx <= nsx + nw && sy >= nsy && sy <= nsy + nh) {
        this.draggingId = id
        node.dragged = true
        node.vx = 0; node.vy = 0
        this.dragGrabOffset = { dx: sx - nsx, dy: sy - nsy }
        this.canvas.style.cursor = 'grabbing'
        return
      }
    }

    this.panning = true
    this.panStart = { x: e.clientX, y: e.clientY }
  }

  private onUp = () => {
    this.panning = false
    if (this.draggingId) {
      // 释放时给予惯性（保留当前速度，物理系统会处理）
      this.draggingId = null
    }
  }
  private onMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect()
    if (this.draggingId) {
      const node = this.physNodes.get(this.draggingId)
      if (node) {
        const sx = e.clientX - r.left, sy = e.clientY - r.top
        // 减去抓取偏移，转换到 node 的坐标系
        const targetX = (sx - this.dragGrabOffset.dx - this.offsetX) / this.zoom
        const targetY = sy - this.dragGrabOffset.dy - this.offsetY
        node.vx = (targetX - node.x) * 0.5
        node.vy = (targetY - node.y) * 0.5
        node.x = targetX
        node.y = targetY
      }
      return
    }
    if (this.panning) {
      this.offsetX += e.clientX - this.panStart.x
      this.offsetY += e.clientY - this.panStart.y
      this.panStart = { x: e.clientX, y: e.clientY }
      return
    }
    const sx = e.clientX - r.left, sy = e.clientY - r.top
    let hovering = false
    for (const item of this.hitItems) {
      if (sx >= item.x && sx <= item.x + item.w && sy >= item.y && sy <= item.y + item.h) {
        hovering = true; break
      }
    }
    this.canvas.style.cursor = hovering ? 'pointer' : 'grab'
  }

  private loop = () => {
    this.tickPhysics()
    this.render()
    this.animId = requestAnimationFrame(this.loop)
  }

  /** 简化力导向：弹簧（拉向家位置或用户放置位置）+ 阻尼 */
  private tickPhysics() {
    const SPRING = 0.03   // 弹簧强度（越大回弹越快）
    const DAMPING = 0.85  // 阻尼（越小停止越快）
    const THRESHOLD = 0.05 // 速度低于此值时停止

    for (const [id, node] of this.physNodes) {
      // 被拖拽中的节点不更新物理
      if (this.draggingId === id) continue

      // 弹簧力：拉向家位置（但如果家=当前位置，力为零，节点自然停留）
      // 拖拽释放后 hx=node.x，所以弹簧力 = 0 → 节点不动
      // 只有窗口 resize 等导致家位置变化时才有力
      const springForce = node.dragged ? 0 : SPRING
      node.vx += (node.hx - node.x) * springForce
      node.vy += (node.hy - node.y) * springForce

      // 阻尼
      node.vx *= DAMPING
      node.vy *= DAMPING

      // 速度死区（消除微抖动）
      if (Math.abs(node.vx) < THRESHOLD) node.vx = 0
      if (Math.abs(node.vy) < THRESHOLD) node.vy = 0

      // 应用位移
      node.x += node.vx
      node.y += node.vy
    }
  }

  private render() {
    const ctx = this.ctx
    const now = performance.now()

    ctx.fillStyle = C.bg
    ctx.fillRect(0, 0, this.w, this.h)
    if (!this.data) return

    this.hitItems = []
    const { turns } = this.data

    // ═══ 自适应模式：>6 回合用热力图，≤6 用管道 ═══
    if (turns.length > 6) {
      this.drawHeatmapMode(ctx, turns, now)
      return
    }

    // 蛇形布局 + 物理节点初始化
    const maxPerRow = 8 // 用户要求固定 8 个/行
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti]
      const nodeId = String(turn.turnId)
      
      // 计算蛇形默认位置
      const row = Math.floor(ti / maxPerRow)
      const col = row % 2 === 0 ? ti % maxPerRow : maxPerRow - 1 - (ti % maxPerRow)
      const homeX = col * (this.pipeW + GAP_H) + 20
      const homeY = row * (this.rowHeight * this.zoom + 20)
      
      // 初始化或更新物理节点
      let node = this.physNodes.get(nodeId)
      if (!node) {
        node = { x: homeX, y: homeY, vx: 0, vy: 0, hx: homeX, hy: homeY, w: this.pipeW, h: this.rowHeight, dragged: false }
        this.physNodes.set(nodeId, node)
      } else {
        // 更新家位置（布局可能变化）
        node.hx = homeX
        node.hy = homeY
        // 如果没被拖拽过，跟随家位置
        if (!node.dragged) { node.x = homeX; node.y = homeY }
      }
      
      const pipeX = node.x
      const pipeYBase = node.y
      // 每行有自己的 Y 偏移
            const pipeYOffset = pipeYBase
      const tAlpha = temporalAlpha(ti, turns.length) * (turn.isPreCompact ? 0.7 : 1.0)
      ctx.globalAlpha = tAlpha
      ctx.save()
      ctx.translate(0, pipeYOffset)
      this.drawPipeline(ctx, turn, pipeX, now)
      ctx.restore()
      ctx.globalAlpha = 1
    }

    // （旧连接线代码已删除——由下方的正交布线连接线替代）

    // ═══ 统一绘制锚点（与连接线同一坐标源）═══
    for (let ti = 0; ti < turns.length; ti++) {
      const node = this.physNodes.get(String(turns[ti].turnId))
      if (!node) continue
      
      // 计算锚点的屏幕坐标（与 drawPipeline 的 translate 一致）
      const pipeX = node.x
      const pipeYOffset = node.y
      // drawPipeline 内部: px = pipeX * zoom + offsetX, py = offsetY
      // 加上 translate(0, pipeYOffset)
      const px = pipeX * this.zoom + this.offsetX
      const py = this.offsetY + pipeYOffset // 实际屏幕 Y
      const pw = this.pipeW * this.zoom
      const anchorY = py + 20 * this.zoom // 锚点在顶部往下 20px

      // 存储锚点位置（连接线用）
      this.anchorPos.set(String(turns[ti].turnId), {
        inX: px, inY: anchorY,      // 输入：左边缘
        outX: px + pw, outY: anchorY // 输出：右边缘
      })

      // 绘制锚点
      const hasPrev = ti > 0
      const hasNext = ti < turns.length - 1
      this.drawAnchor(ctx, px, anchorY, 'input', hasPrev, now)
      this.drawAnchor(ctx, px + pw, anchorY, 'output', hasNext, now)
    }

    // ═══ 相邻 STATION 连接线（从锚点到锚点）═══
    for (let ti = 0; ti < turns.length - 1; ti++) {
      const nodeA = this.physNodes.get(String(turns[ti].turnId))
      const nodeB = this.physNodes.get(String(turns[ti + 1].turnId))
      if (!nodeA || !nodeB) continue

      // 连接点：从 anchorPos 获取（与锚点绘制同一数据源）
      const anchorsA = this.anchorPos.get(String(turns[ti].turnId))
      const anchorsB = this.anchorPos.get(String(turns[ti + 1].turnId))
      if (!anchorsA || !anchorsB) continue
      const ax = anchorsA.outX, ay = anchorsA.outY // A 的输出锚点
      const bx = anchorsB.inX, by = anchorsB.inY   // B 的输入锚点

      const dx = bx - ax
      const dy = by - ay
      
      // 最小距离检查：如果锚点几乎重合（<15px），不画连接线
      // 避免产生无意义的短线
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 15) continue

      // ═══ 路径点计算（正交布线）═══
      const points: Array<[number, number]> = [[ax, ay]]
      
      // 辅助函数：只添加与上一个点不同的坐标（避免零长度线段）
      const addPoint = (x: number, y: number) => {
        const last = points[points.length - 1]
        if (Math.abs(last[0] - x) > 2 || Math.abs(last[1] - y) > 2) {
          points.push([x, y])
        }
      }

      if (Math.abs(dy) < 8) {
        // 情况 1：同一行 → 纯直线
        addPoint(bx, by)
      } else if (dx > 0 && Math.abs(dy) > 20) {
        // 情况 2：同行但不同高度 → L 形（先水平后垂直）
        const midX = ax + dx * 0.6
        addPoint(midX, ay)
        addPoint(midX, by)
        addPoint(bx, by)
      } else if (dx <= 0) {
        // 情况 3：换行（蛇形折返）→ U 形（右→下→左→到达）
        const rightOffset = 20 // 向右伸出一点再折返
        points.push([ax + rightOffset, ay])
        points.push([ax + rightOffset, by])
        points.push([bx, by])
      } else {
        // 情况 4：任意位置 → 简单 L 形
        const midY = (ay + by) / 2
        addPoint(ax, midY)
        addPoint(bx, midY)
        addPoint(bx, by)
      }

      // ═══ 绘制路径（带圆角转弯）═══
      const CORNER_R = 6 // 圆角半径

      ctx.strokeStyle = 'rgba(74, 158, 255, 0.12)'
      ctx.lineWidth = 5
      ctx.lineCap = 'round'
      ctx.beginPath()
      this.tracePath(ctx, points, CORNER_R)
      ctx.stroke()

      ctx.strokeStyle = 'rgba(74, 158, 255, 0.45)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      this.tracePath(ctx, points, CORNER_R)
      ctx.stroke()

      // ═══ 流动粒子（沿路径）═══
      const particleT = (now / 1500 + ti * 0.2) % 1
      const [ppx, ppy] = this.pointOnPath(points, particleT)
      ctx.fillStyle = '#4A9EFF'
      ctx.beginPath(); ctx.arc(ppx, ppy, 3, 0, Math.PI * 2); ctx.fill()
      // 粒子光晕
      ctx.fillStyle = 'rgba(74, 158, 255, 0.15)'
      ctx.beginPath(); ctx.arc(ppx, ppy, 6, 0, Math.PI * 2); ctx.fill()

      // ═══ 箭头（在 B 端，沿最后一段方向）═══
      if (points.length >= 2) {
        const [prevX, prevY] = points[points.length - 2]
        const [endX, endY] = points[points.length - 1]
        const ang = Math.atan2(endY - prevY, endX - prevX)
        ctx.fillStyle = 'rgba(74, 158, 255, 0.6)'
        ctx.save()
        ctx.translate(bx, by)
        ctx.rotate(ang)
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.lineTo(-8, -4)
        ctx.lineTo(-5, 0)
        ctx.lineTo(-8, 4)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
    }

    this.drawFooter(ctx, now)
  }

  private drawPipeline(ctx: CanvasRenderingContext2D, turn: PipeTurn, pipeX: number, now: number) {
    const px = pipeX * this.zoom + this.offsetX
    const pw = this.pipeW * this.zoom
    let py = this.offsetY
    const gap = GAP_V * this.zoom

    // 计算实际渲染的工具行数（考虑展开状态）

    // 底座
    const totalH = (USER_H + THINK_H + 50 + (turn.finalText ? DONE_H : 0) + gap * 4) * this.zoom
    drawPanel(ctx, px - 10, py - 8, pw + 20, totalH + 16, {
      hue: 220, sat: 15, light: 10, depth: 4 * this.zoom
    }, now, { screws: true })

    // 用户节点
    const uh = USER_H * this.zoom
    drawPanel(ctx, px, py, pw, uh, { hue: 340, sat: 70, light: 20, depth: 3 * this.zoom }, now, { screws: true })
    ctx.font = `${16 * this.zoom}px sans-serif`; ctx.textAlign = 'left'
    ctx.fillText('👤', px + 12 * this.zoom, py + uh * 0.4)
    ctx.fillStyle = C.text; ctx.font = `${14 * this.zoom}px -apple-system, sans-serif`
    drawTextSafe(ctx, (turn.isPreCompact ? '⚡ ' : '') + turn.userText, px + pw * 0.22, py + uh * 0.38, pw * 0.7, 'left')
    ctx.fillStyle = C.textDim; ctx.font = `${10 * this.zoom}px monospace`
    ctx.fillText(`ST ${turn.turnId}`, px + pw * 0.22, py + uh * 0.72)
    py += uh + gap

    // 思考节点
    const th = THINK_H * this.zoom
    drawPanel(ctx, px, py, pw, th, { hue: 45, sat: 90, light: 22, depth: 3 * this.zoom }, now, { screws: true, glowAlpha: 0.08 })
    const gearR = 26 * this.zoom
    const gx = px + pw * 0.3, gy = py + th * 0.42
    ctx.save(); ctx.translate(gx, gy); ctx.rotate(now / 1200)
    ctx.strokeStyle = C.think + '90'; ctx.lineWidth = 2
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * gearR * 0.55, Math.sin(a) * gearR * 0.55)
      ctx.lineTo(Math.cos(a) * gearR, Math.sin(a) * gearR)
      ctx.stroke()
    }
    ctx.beginPath(); ctx.arc(0, 0, gearR * 0.55, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
    ctx.fillStyle = C.think; ctx.font = `${14 * this.zoom}px sans-serif`; ctx.textAlign = 'left'
    drawTextSafe(ctx, 'ST ' + turn.turnId, px + pw * 0.5, py + th * 0.3, pw * 0.45, 'left')
    ctx.fillStyle = C.textDim; ctx.font = `${11 * this.zoom}px sans-serif`
    if (turn.finalText) {
      ctx.fillStyle = C.done + '80'
      if (turn.finalText) drawTextSafe(ctx, turn.finalText, px + pw * 0.5, py + th * 0.78, pw * 0.42, 'left')
    }
    py += th + gap

    // ═══ 工具区：三级渐进式披露 ═══
    const totalCalls = turn.tools.reduce((sum, t) => sum + (t.count ?? 1), 0)
    const level = this.expandLevel.get(String(turn.turnId)) ?? 0

    if (totalCalls > 0 && level === 0) {
      // Level 0: 一行摘要（缺省，极度紧凑）
      const sumH = 44 * this.zoom
      drawPanel(ctx, px + 16 * this.zoom, py, pw - 32 * this.zoom, sumH, {
        hue: 190, sat: 50, light: 15, depth: 2 * this.zoom
      }, now, { screws: false })
      ctx.font = `${16 * this.zoom}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText('\u{1F527}', px + 26 * this.zoom, py + sumH / 2)
      // 操作数 + 成功率（Anatomy 风格）
      const okCount = turn.tools.filter(t => t.ok).reduce((s2, t) => s2 + (t.count ?? 1), 0)
      ctx.fillStyle = C.tool
      ctx.font = `bold ${13 * this.zoom}px sans-serif`
      ctx.fillText(String(totalCalls), px + 52 * this.zoom, py + sumH * 0.38)
      ctx.fillStyle = C.textDim; ctx.font = `${9 * this.zoom}px sans-serif`
      ctx.fillText('ops', px + 54 * this.zoom + String(totalCalls).length * 9 * this.zoom, py + sumH * 0.38)
      // 成功指示灯 + 比率
      const okColor = okCount === totalCalls ? C.done : '#FF8888'
      ctx.fillStyle = okColor + '90'
      ctx.beginPath(); ctx.arc(px + 56 * this.zoom, py + sumH * 0.7, 3.5 * this.zoom, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = okColor; ctx.font = `${9 * this.zoom}px monospace`
      ctx.fillText(`${okCount}/${totalCalls}`, px + 64 * this.zoom, py + sumH * 0.7)
      ctx.fillStyle = C.tool + '80'
      ctx.font = `${11 * this.zoom}px sans-serif`
      ctx.textAlign = 'right'
      ctx.fillText('\u25B8 detail', px + pw - 45 * this.zoom, py + sumH / 2)
      this.hitItems.push({ key: String(turn.turnId), x: px + 16 * this.zoom, y: py, w: pw - 32 * this.zoom, h: sumH })
      py += sumH + gap
    } else if (totalCalls > 0 && level === 1) {
      // Level 1: 按类别汇总
      const catMap = new Map<string, { count: number; icon: string }>()
      for (const t of turn.tools) {
        const cat = TOOL_CATEGORY[t.name]?.cat ?? t.name
        const n = t.count ?? 1
        const ex = catMap.get(cat)
        if (ex) ex.count += n
        else catMap.set(cat, { count: n, icon: TOOL_CATEGORY[t.name]?.icon ?? "u{1F527}" })
      }
      const hdrH = 30 * this.zoom
      ctx.fillStyle = C.tool + '15'; ctx.strokeStyle = C.tool + '40'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(px + 16 * this.zoom, py, pw - 32 * this.zoom, hdrH, 4); ctx.fill(); ctx.stroke()
      ctx.fillStyle = C.tool; ctx.font = `bold ${11 * this.zoom}px sans-serif`
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText('by category', px + 26 * this.zoom, py + hdrH / 2)
      this.hitItems.push({ key: String(turn.turnId), x: px + 16 * this.zoom, y: py, w: pw - 32 * this.zoom, h: hdrH })
      py += hdrH + gap * 0.3
      const maxCC = Math.max(...Array.from(catMap.values()).map(v => v.count), 1)
      for (const [cat, info] of catMap) {
        const catH = 30 * this.zoom
        ctx.fillStyle = 'rgba(0,229,255,0.03)'
        ctx.beginPath(); ctx.roundRect(px + 24 * this.zoom, py, pw - 48 * this.zoom, catH, 3); ctx.fill()
        ctx.font = `${10 * this.zoom}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
        ctx.fillText(info.icon, px + 32 * this.zoom, py + catH * 0.3)
        ctx.fillStyle = C.textDim; ctx.font = `${9 * this.zoom}px sans-serif`
        ctx.fillText(cat, px + 48 * this.zoom, py + catH * 0.3)
        ctx.fillStyle = C.tool; ctx.font = `bold ${10 * this.zoom}px monospace`
        ctx.textAlign = 'right'
        ctx.fillText(String(info.count), px + pw - 45 * this.zoom, py + catH * 0.3)
        const barW = pw - 100 * this.zoom
        const barH = Math.max(3, 5 * this.zoom)
        const barY = py + catH * 0.65
        const barX = px + 32 * this.zoom
        const fillW = barW * (info.count / maxCC)
        ctx.fillStyle = '#21262D'
        ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 2); ctx.fill()
        ctx.fillStyle = C.tool + '40'
        ctx.beginPath(); ctx.roundRect(barX, barY, fillW, barH, 2); ctx.fill()
        ctx.fillStyle = C.tool + '25'
        ctx.beginPath(); ctx.roundRect(barX, barY, fillW, 1, 0.5); ctx.fill()
        py += catH + gap * 0.2
      }
      const moreH = 26 * this.zoom
      ctx.fillStyle = C.tool + '10'
      ctx.beginPath(); ctx.roundRect(px + 24 * this.zoom, py, pw - 48 * this.zoom, moreH, 3); ctx.fill()
      ctx.fillStyle = C.tool + '70'; ctx.font = `${10 * this.zoom}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText('\u25B8 view all', px + pw / 2, py + moreH / 2)
      this.hitItems.push({ key: `${turn.turnId}:all`, x: px + 24 * this.zoom, y: py, w: pw - 48 * this.zoom, h: moreH })
      py += moreH + gap
    } else if (totalCalls > 0 && level >= 2) {
      // Level 2: 完整明细
      const hdrH = 30 * this.zoom
      ctx.fillStyle = C.tool + '15'; ctx.strokeStyle = C.tool + '40'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(px + 16 * this.zoom, py, pw - 32 * this.zoom, hdrH, 4); ctx.fill(); ctx.stroke()
      ctx.fillStyle = C.tool; ctx.font = `bold ${11 * this.zoom}px sans-serif`
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText('all calls', px + 26 * this.zoom, py + hdrH / 2)
      this.hitItems.push({ key: String(turn.turnId), x: px + 16 * this.zoom, y: py, w: pw - 32 * this.zoom, h: hdrH })
      py += hdrH + gap * 0.3
      let callNum = 0
      for (const tool of turn.tools) {
        const n = tool.count ?? 1
        for (let ci = 0; ci < n; ci++) {
          callNum++
          const callH = 26 * this.zoom
          ctx.fillStyle = tool.ok ? 'rgba(0,229,255,0.04)' : 'rgba(255,68,68,0.06)'
          ctx.strokeStyle = tool.ok ? 'rgba(0,229,255,0.1)' : 'rgba(255,68,68,0.2)'
          ctx.lineWidth = 0.5
          ctx.beginPath(); ctx.roundRect(px + 24 * this.zoom, py, pw - 48 * this.zoom, callH, 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = C.textDim + '60'; ctx.font = `${8 * this.zoom}px monospace`
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
          ctx.fillText(String(callNum), px + 30 * this.zoom, py + callH / 2)
          ctx.font = `${10 * this.zoom}px sans-serif`
          ctx.fillText(toolIcon(tool.name), px + 46 * this.zoom, py + callH / 2)
          ctx.fillStyle = tool.ok ? C.text : '#FF8888'
          ctx.font = `${9 * this.zoom}px monospace`
          ctx.fillText(tool.name, px + 62 * this.zoom, py + callH / 2)
          ctx.fillStyle = tool.ok ? C.done : C.error
          ctx.textAlign = 'right'
          ctx.fillText(tool.ok ? '\u2713' : '\u2717', px + pw - 45 * this.zoom, py + callH / 2)
          py += callH + gap * 0.15
        }
      }
      py += gap * 0.5
    }

    // 完成节点
    // 完成节点
    if (turn.finalText) {
      const dh = DONE_H * this.zoom
      drawPanel(ctx, px, py, pw, dh, { hue: 140, sat: 80, light: 18, depth: 3 * this.zoom }, now, { screws: true, glowAlpha: 0.1 })
      ctx.fillStyle = C.done
      ctx.font = `${15 * this.zoom}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      drawTextSafe(ctx, `✅ ${turn.finalText}`, px + pw / 2, py + dh / 2, pw - 20, 'center')
    }

      }

  
  /* ═══ 热力图模式（>6 回合的自适应布局）═══
   * 水平时间线 + 类别热力图
   * 比 14 个垂直管道更紧凑、更有信息量
   */
  private drawHeatmapMode(ctx: CanvasRenderingContext2D, turns: PipeTurn[], now: number) {
    const margin = 30
    const labelW = 140
    const heatmapW = this.w - margin * 2 - labelW
    const rowH = Math.min(32, (this.h - 160) / turns.length)
    const startY = 70

    // 收集所有类别
    const allCats = new Set<string>()
    for (const t of turns) {
      for (const tool of t.tools) {
        const cat = TOOL_CATEGORY[tool.name]?.cat ?? tool.name
        allCats.add(cat)
      }
    }
    const catList = Array.from(allCats).sort()
    const catCount = catList.length
    const colW = heatmapW / Math.max(catCount, 1)

    // 标题
    ctx.fillStyle = C.text
    ctx.font = 'bold 16px -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(`Heatmap — ${turns.length} turns · ${catCount} categories`, margin, 36)
    ctx.fillStyle = C.textDim
    ctx.font = '11px monospace'
    ctx.fillText(`${turns.reduce((s, t) => s + t.tools.reduce((a, b) => a + (b.count ?? 1), 0), 0)} total ops`, margin, 52)

    // 列头（类别名）
    ctx.font = '9px monospace'
    ctx.textAlign = 'center'
    for (let ci = 0; ci < catCount; ci++) {
      const cat = catList[ci]
      const cx = margin + labelW + ci * colW + colW / 2
      ctx.fillStyle = C.textDim
      ctx.fillText(cat, cx, startY - 10)
    }

    // 行（每个回合）
    const maxVal = Math.max(...turns.flatMap(t => 
      Array.from(this.categorizeTools(t.tools).values()).map(v => v)
    ), 1)

    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti]
      const y = startY + ti * rowH
      
      // 行标签（ST N + 简短用户文本）
      ctx.fillStyle = C.textDim
      ctx.font = `${Math.min(10, rowH * 0.3)}px monospace`
      ctx.textAlign = 'left'
      ctx.fillText(`ST${turn.turnId}`, margin, y + rowH * 0.5)
      ctx.fillStyle = C.text
      ctx.font = `${Math.min(9, rowH * 0.25)}px sans-serif`
      const shortUser = turn.userText.slice(0, 12)
      ctx.fillText(shortUser, margin + 30, y + rowH * 0.5)
      // 总操作数
      const ops = turn.tools.reduce((a, b) => a + (b.count ?? 1), 0)
      ctx.fillStyle = C.tool
      ctx.font = `${Math.min(9, rowH * 0.25)}px monospace`
      ctx.textAlign = 'right'
      ctx.fillText(`${ops}`, margin + labelW - 10, y + rowH * 0.5)

      // 热力图格子
      const catMap = this.categorizeTools(turn.tools)
      for (let ci = 0; ci < catCount; ci++) {
        const cat = catList[ci]
        const val = catMap.get(cat) ?? 0
        const intensity = val / maxVal
        const cx = margin + labelW + ci * colW

        if (val > 0) {
          // 热力格（颜色强度 = 数量）
          const alpha = 0.1 + intensity * 0.6
          ctx.fillStyle = `rgba(0, 229, 255, ${alpha})`
          ctx.beginPath()
          ctx.roundRect(cx + 2, y + 2, colW - 4, rowH - 4, 3)
          ctx.fill()
          // 数量文字（如果格子够大）
          if (colW > 30 && rowH > 18) {
            ctx.fillStyle = intensity > 0.5 ? '#0A0E14' : C.text
            ctx.font = `${Math.min(10, rowH * 0.3)}px monospace`
            ctx.textAlign = 'center'
            ctx.fillText(String(val), cx + colW / 2, y + rowH * 0.55)
          }
        } else {
          // 空格子（极淡的网格）
          ctx.fillStyle = 'rgba(30, 35, 45, 0.3)'
          ctx.beginPath()
          ctx.roundRect(cx + 2, y + 2, colW - 4, rowH - 4, 3)
          ctx.fill()
        }
      }
    }

    // 底部说明
    ctx.fillStyle = C.textDim + '60'
    ctx.font = '9px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('■ intensity = tool count · click a row for detail', margin, startY + turns.length * rowH + 20)

    // 仍然绘制底部仪表
    this.drawFooter(ctx, now)
  }

  /** 将工具列表按类别汇总 */
  private categorizeTools(tools: ToolItem[]): Map<string, number> {
    const map = new Map<string, number>()
    for (const t of tools) {
      const cat = TOOL_CATEGORY[t.name]?.cat ?? t.name
      map.set(cat, (map.get(cat) ?? 0) + (t.count ?? 1))
    }
    return map
  }

  
  /** 沿路径绘制（在转角处用圆角代替硬角） */
  private tracePath(ctx: CanvasRenderingContext2D, points: Array<[number, number]>, cornerR: number) {
    if (points.length < 2) return
    ctx.moveTo(points[0][0], points[0][1])

    for (let i = 1; i < points.length - 1; i++) {
      const [px, py] = points[i - 1]
      const [cx, cy] = points[i]
      const [nx, ny] = points[i + 1]

      // 计算转角方向
      const dx1 = cx - px, dy1 = cy - py
      const dx2 = nx - cx, dy2 = ny - cy
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1

      // 限制圆角半径不超过线段一半
      const r = Math.min(cornerR, len1 / 2, len2 / 2)

      // 入点（转角前 r 像素）
      const inX = cx - dx1 / len1 * r
      const inY = cy - dy1 / len1 * r
      // 出点（转角后 r 像素）
      const outX = cx + dx2 / len2 * r
      const outY = cy + dy2 / len2 * r

      ctx.lineTo(inX, inY)
      ctx.quadraticCurveTo(cx, cy, outX, outY)
    }

    // 最后一个点
    const [lastX, lastY] = points[points.length - 1]
    ctx.lineTo(lastX, lastY)
  }

  /** 计算路径上 t 位置（0-1）的坐标 */
  private pointOnPath(points: Array<[number, number]>, t: number): [number, number] {
    if (points.length < 2) return points[0] ?? [0, 0]

    // 计算总长度
    let totalLen = 0
    const segLens: number[] = []
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i-1][0]
      const dy = points[i][1] - points[i-1][1]
      const len = Math.sqrt(dx * dx + dy * dy)
      segLens.push(len)
      totalLen += len
    }

    // 找到 t 对应的线段
    let targetLen = t * totalLen
    for (let i = 0; i < segLens.length; i++) {
      if (targetLen <= segLens[i]) {
        const segT = segLens[i] === 0 ? 0 : targetLen / segLens[i]
        const [ax, ay] = points[i]
        const [bx, by] = points[i + 1]
        return [ax + (bx - ax) * segT, ay + (by - ay) * segT]
      }
      targetLen -= segLens[i]
    }

    return points[points.length - 1]
  }

  
  /** 绘制锚点（凸起端口，像 UE 蓝图 / ComfyUI 节点） */
  private drawAnchor(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    type: 'input' | 'output',
    isConnected: boolean,
    now: number,
  ): void {
    const r = 5 // 锚点半径
    const isInput = type === 'input'
    
    ctx.save()
    ctx.translate(x, y)

    // 凸起形状：半圆凸起（从面板边缘伸出）
    // 输入朝左，输出朝右
    ctx.beginPath()
    if (isInput) {
      // 输入：从左侧凸出（半圆朝左）
      ctx.arc(0, 0, r, Math.PI / 2, Math.PI * 1.5, false)
    } else {
      // 输出：从右侧凸出（半圆朝右）
      ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false)
    }
    ctx.closePath()

    // 填充（连接时亮色，未连接时暗色）
    if (isConnected) {
      ctx.fillStyle = '#4A9EFF'
      ctx.fill()
      // 光晕
      const glowR = r * 2
      const glow = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, glowR)
      glow.addColorStop(0, 'rgba(74,158,255,0.3)')
      glow.addColorStop(1, 'transparent')
      ctx.fillStyle = glow
      ctx.beginPath(); ctx.arc(0, 0, glowR, 0, Math.PI * 2); ctx.fill()
      // 重新画锚点
      ctx.beginPath()
      if (isInput) ctx.arc(0, 0, r, Math.PI/2, Math.PI*1.5, false)
      else ctx.arc(0, 0, r, -Math.PI/2, Math.PI/2, false)
      ctx.closePath()
      ctx.fillStyle = '#4A9EFF'; ctx.fill()
    } else {
      ctx.fillStyle = '#30363D'
      ctx.fill()
    }

    // 内圈（小圆点，像插孔）
    ctx.beginPath(); ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2)
    ctx.fillStyle = isConnected ? '#0A0E14' : '#1C2128'
    ctx.fill()

    // 边框
    ctx.beginPath()
    if (isInput) ctx.arc(0, 0, r, Math.PI/2, Math.PI*1.5, false)
    else ctx.arc(0, 0, r, -Math.PI/2, Math.PI/2, false)
    ctx.closePath()
    ctx.strokeStyle = isConnected ? '#4A9EFF' : '#484F58'
    ctx.lineWidth = 1.5
    ctx.stroke()

    ctx.restore()
  }

  

  private drawFooter(ctx: CanvasRenderingContext2D, now: number) {
    if (!this.data) return
    const barY = this.h - FOOTER_H
    const barW = Math.min(this.w - 40, 700)
    const barX = (this.w - barW) / 2

    drawPanel(ctx, barX - 5, barY, barW + 10, FOOTER_H - 10, {
      hue: 220, sat: 12, light: 10, depth: 3
    }, now, { screws: false })

    // ═══ 左侧：上下文仪表（紧凑，12%）═══
    const ctxRatio = Math.min(this.data.contextUsed / this.data.contextMax, 1)
    drawGauge(ctx, barX + 25, barY + 28, 12, Math.round(ctxRatio * 100), 100, '', 140, now)

    // ═══ 中间：Token（紧凑，20%，纵向居中）═══
    const tokenX = barX + barW * 0.14
    const centerY = barY + (FOOTER_H - 10) / 2 // 纵向中心
    ctx.fillStyle = C.text
    ctx.font = 'bold 15px ui-monospace, monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle' // 纵向居中对齐
    ctx.fillText(this.data.totalTokens.toLocaleString(), tokenX, centerY)
    ctx.fillStyle = C.textDim
    ctx.font = '9px monospace'
    const tokW = ctx.measureText(this.data.totalTokens.toLocaleString()).width
    ctx.fillText('tok', tokenX + tokW + 8, centerY)
    if (this.data.totalTokens > 0) {
      const cost = this.data.totalTokens * 0.0000014
      ctx.fillStyle = C.textDim + '70'
      ctx.fillText(`\u2248\u00A5${cost.toFixed(4)}`, tokenX, centerY + 14)
    }

    // ═══ 右侧：时间条（大幅扩展，65%）═══
    const tlX = barX + barW * 0.35
    const tlW = barW * 0.62 // 从 48% 扩展到 62%
    const tlY = barY + 14
    const tlH = 12 // 更粗的时间条
    
    let inputT = 0, thinkT = 0, toolT = 0
    for (const turn of this.data.turns) {
      inputT += 50; thinkT += 200
      for (const t of turn.tools) toolT += t.dur * (t.count ?? 1)
    }
    const total = Math.max(inputT + thinkT + toolT, 1)
    
    // 时间条背景槽
    ctx.fillStyle = '#21262D'
    ctx.beginPath(); ctx.roundRect(tlX, tlY, tlW, tlH, 4); ctx.fill()
    
    let segX = tlX
    const segments: Array<[string, number, string]> = [
      ['Input', inputT, C.user],
      ['Think', thinkT, C.think],
      ['Tools', toolT, C.tool],
    ]
    for (const [label, time, color] of segments) {
      const segW = (time / total) * tlW
      if (segW > 3) {
        // 填充
        ctx.fillStyle = color + '50'
        ctx.beginPath(); ctx.roundRect(segX, tlY, segW - 1, tlH, 3); ctx.fill()
        // 顶部亮线
        ctx.fillStyle = color + '30'
        ctx.beginPath(); ctx.roundRect(segX, tlY, segW - 1, 2, 1); ctx.fill()
        // 标签（如果够宽）
        if (segW > 35) {
          ctx.fillStyle = color
          ctx.font = 'bold 9px monospace'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(label, segX + segW / 2, tlY + tlH / 2)
        }
      }
      segX += segW
    }
    
    // 总时长（右侧）
    ctx.fillStyle = C.text
    ctx.font = 'bold 10px monospace'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    const totalS = total > 1000 ? (total / 1000).toFixed(1) + 's' : total + 'ms'
    ctx.fillText(totalS, tlX + tlW + 8, tlY + tlH / 2)
    
    // 底部：工具类别汇总（第二行，在时间条下方）
    const catSummary = this.data.turns
      .flatMap(t => t.tools)
      .reduce((map, tool) => {
        const cat = TOOL_CATEGORY[tool.name]?.cat ?? tool.name
        map.set(cat, (map.get(cat) ?? 0) + (tool.count ?? 1))
        return map
      }, new Map<string, number>())
    const topCats = Array.from(catSummary.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, n]) => `${cat} ${n}`)
      .join('  ')
    
    ctx.fillStyle = C.textDim + '60'
    ctx.font = '8px monospace'
    ctx.textAlign = 'left'
    ctx.fillText(topCats, tlX, tlY + tlH + 10)
  }
}

export { parseTurns, type PipelineData, type PipeTurn, type ToolItem }
