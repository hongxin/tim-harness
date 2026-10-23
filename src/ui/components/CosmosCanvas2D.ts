/**
 * Cosmos 2D —— 会话的气泡力导向可视化（JetBot Cosmos 范式的增强版）。
 *
 * 直观性核心（从 JetBot 学到的）：
 * - 气泡上直接渲染内容文字（不需要点击才能看到）
 * - 力导向布局（新消息自动漂到合理位置，有机感）
 * - 2D 平移/缩放（零学习成本）
 * - 诞生脉冲 + 运行呼吸 + 弧线流动粒子
 *
 * tim-harness 增强：
 * - 压缩核心（旧消息折叠为发光核心）
 * - 子代理卫星群
 * - 上下文预算环
 * - 19 种工具各自专属色相
 */

/* ---------------- 类型 ---------------- */

export interface CosmosNode2D {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'sub-agent' | 'core' | 'file'
  content: string
  toolName?: string
  isError?: boolean
  isRunning?: boolean
  durationMs?: number
  turnId: number
  birthTime: number
  x: number; y: number; vx: number; vy: number
  radius: number
  pinned: boolean
  hue: number
}

export interface CosmosEdge2D {
  id: string
  fromId: string
  toId: string
  type: 'flow' | 'spawn' | 'tool' | 'cross-turn'
}

/* ---------------- 色相映射 ---------------- */

export const TOOL_HUE: Record<string, number> = {
  ls: 140, read_file: 200, write_file: 160, edit_file: 280,
  grep: 180, glob: 150, run_js: 45, web_fetch: 320, web_search: 220,
  todo_write: 100, spawn_agent: 300, ask_user: 50, skill: 260,
  goal_update: 120, snapshot_save: 170, snapshot_restore: 175,
  snapshot_list: 165, snapshot_diff: 168, snapshot_delete: 172,
}

export const KIND_HUE: Record<string, number> = {
  user: 30, assistant: 260, tool: 210, 'sub-agent': 300, core: 45, file: 100,
}

export function getNodeHue(node: CosmosNode2D): number {
  if (node.kind === 'tool' && node.toolName) return TOOL_HUE[node.toolName] ?? 210
  return KIND_HUE[node.kind] ?? 210
}

/* ---------------- 力导向引擎 ---------------- */

const REPULSION = 6000
const EDGE_SPRING = 0.006
const EDGE_REST = 160
const CENTER_PULL = 0.0008
const DAMPING = 0.85
const MAX_VEL = 12
const COOLING = 0.05

interface SimState {
  nodes: Map<string, CosmosNode2D>
  edges: CosmosEdge2D[]
  cooled: boolean
}

export function tickSim(sim: SimState) {
  if (sim.cooled || sim.nodes.size < 2) return
  const arr = Array.from(sim.nodes.values())
  let energy = 0

  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j]
      let dx = b.x - a.x, dy = b.y - a.y
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = 1 }
      const f = REPULSION / (dist * dist)
      const fx = (dx / dist) * f, fy = (dy / dist) * f
      if (!a.pinned) { a.vx -= fx; a.vy -= fy }
      if (!b.pinned) { b.vx += fx; b.vy += fy }
    }
  }

  for (const e of sim.edges) {
    const a = sim.nodes.get(e.fromId), b = sim.nodes.get(e.toId)
    if (!a || !b) continue
    const dx = b.x - a.x, dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const rest = e.type === 'cross-turn' ? 280 : EDGE_REST
    const f = EDGE_SPRING * (dist - rest)
    const fx = (dx / dist) * f, fy = (dy / dist) * f
    if (!a.pinned) { a.vx += fx; a.vy += fy }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy }
  }

  for (const s of arr) {
    if (s.pinned) continue
    s.vx -= s.x * CENTER_PULL
    s.vy -= s.y * CENTER_PULL
    s.vx *= DAMPING; s.vy *= DAMPING
    const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy)
    if (speed > MAX_VEL) { s.vx = (s.vx / speed) * MAX_VEL; s.vy = (s.vy / speed) * MAX_VEL }
    s.x += s.vx; s.y += s.vy
    energy += s.vx * s.vx + s.vy * s.vy
  }
  if (energy < COOLING) sim.cooled = true
}

/* ---------------- 消息 → 节点映射 ---------------- */

const RADIUS_MAP: Record<string, number> = {
  user: 32, assistant: 36, tool: 24, 'sub-agent': 42, core: 50, file: 18,
}

export function mapSessionToCosmos(
  messages: Array<{ role: string; content?: string | null; tool_calls?: Array<{ id: string; name: string; arguments: string }>; tool_call_id?: string; name?: string; toolOk?: boolean; durationMs?: number; args?: string }>,
  compactedFolded: number,
): { nodes: CosmosNode2D[]; edges: CosmosEdge2D[] } {
  const nodes: CosmosNode2D[] = []
  const edges: CosmosEdge2D[] = []
  let turn = 0
  let prevNodeId: string | null = null

  // 压缩核心
  if (compactedFolded > 0) {
    const core: CosmosNode2D = {
      id: 'core', kind: 'core', content: `⚡ ${compactedFolded} 条已压缩`,
      turnId: 0, birthTime: performance.now(),
      x: 0, y: 0, vx: 0, vy: 0, radius: RADIUS_MAP.core, pinned: false, hue: 45,
    }
    nodes.push(core)
    prevNodeId = 'core'
  }

  const visible = messages.slice(compactedFolded)
  visible.forEach((msg, i) => {
    const now = performance.now()

    if (msg.role === 'user') {
      turn++
      const id = `u${i}`
      const dist = 60 + Math.random() * 80
      nodes.push({
        id, kind: 'user', content: (msg.content ?? '').slice(0, 100),
        turnId: turn, birthTime: now,
        x: (Math.random() - 0.5) * dist * 2, y: (Math.random() - 0.5) * dist * 2, vx: 0, vy: 0,
        radius: RADIUS_MAP.user, pinned: false, hue: 30,
      })
      if (prevNodeId) edges.push({ id: `e_${prevNodeId}_${id}`, fromId: prevNodeId, toId: id, type: prevNodeId === 'core' ? 'flow' : 'cross-turn' })
      prevNodeId = id
    } else if (msg.role === 'assistant') {
      const id = `a${i}`
      const last = nodes[nodes.length - 1]
      const cx = last?.x ?? 0, cy = last?.y ?? 0
      nodes.push({
        id, kind: 'assistant', content: (msg.content ?? '').slice(0, 100) || `🔧 ${(msg.tool_calls?.length ?? 0)} 个工具`,
        turnId: turn, birthTime: now,
        x: cx + (Math.random() - 0.5) * 80, y: cy + (Math.random() - 0.5) * 80, vx: 0, vy: 0,
        radius: RADIUS_MAP.assistant, pinned: false, hue: 260,
      })
      if (prevNodeId) edges.push({ id: `e_${prevNodeId}_${id}`, fromId: prevNodeId, toId: id, type: 'flow' })
      prevNodeId = id

      // 工具子节点
      if (msg.tool_calls) {
        msg.tool_calls.forEach((tc, j) => {
          const tid = `t${i}_${j}`
          nodes.push({
            id: tid, kind: 'tool', content: tc.name,
            toolName: tc.name, turnId: turn, birthTime: now,
            x: (nodes[nodes.length - 1]?.x ?? 0) + (Math.random() - 0.5) * 60,
            y: (nodes[nodes.length - 1]?.y ?? 0) + (Math.random() - 0.5) * 60,
            vx: 0, vy: 0, radius: RADIUS_MAP.tool, pinned: false,
            hue: TOOL_HUE[tc.name] ?? 210,
          })
          edges.push({ id: `e_${id}_${tid}`, fromId: id, toId: tid, type: 'tool' })
        })
      }
    } else if (msg.role === 'tool') {
      // 找到对应的工具调用节点，更新其状态
      const toolNode = nodes.find((n) => n.kind === 'tool' && n.turnId === turn && n.content === msg.name)
      if (toolNode) {
        toolNode.isError = msg.toolOk === false
        toolNode.durationMs = msg.durationMs
        toolNode.content = `${msg.name} ${msg.toolOk === false ? '✗' : '✓'}`
      } else {
        const id = `tr${i}`
        nodes.push({
          id, kind: 'tool', content: msg.name ?? '',
          toolName: msg.name, isError: msg.toolOk === false, durationMs: msg.durationMs,
          turnId: turn, birthTime: now,
          x: (nodes[nodes.length - 1]?.x ?? 0) + 40, y: (nodes[nodes.length - 1]?.y ?? 0) + 40,
          vx: 0, vy: 0, radius: RADIUS_MAP.tool, pinned: false,
          hue: TOOL_HUE[msg.name ?? ''] ?? 210,
        })
        if (prevNodeId) edges.push({ id: `e_${prevNodeId}_${id}`, fromId: prevNodeId, toId: id, type: 'tool' })
        prevNodeId = id
      }
    }
  })

  return { nodes, edges }
}

/* ---------------- Canvas 2D 渲染器 ---------------- */

interface Star { x: number; y: number; size: number; layer: number; alpha: number; twinkle: boolean }
interface Particle { edgeId: string; t: number }

export class CosmosCanvas2D {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private width = 0; private height = 0; private dpr = 1
  private animId = 0
  private sim: SimState = { nodes: new Map(), edges: [], cooled: false }
  private stars: Star[] = []
  private particles: Particle[] = []
  private startTime = performance.now()
  private zoom = 1
  private offsetX = 0; private offsetY = 0
  private hoverId: string | null = null
  private selectedId: string | null = null
  private resizeObserver: ResizeObserver
  private onNodeSelect: ((node: CosmosNode2D | null) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas.parentElement || canvas)
    this.resize()
    this.initStars()
    this.loop()
    this.bindEvents()
  }

  destroy() {
    cancelAnimationFrame(this.animId)
    this.resizeObserver.disconnect()
    this.unbindEvents()
  }

  setOnNodeSelect(cb: (node: CosmosNode2D | null) => void) { this.onNodeSelect = cb }

  setNodes(nodes: CosmosNode2D[], edges: CosmosEdge2D[]) {
    const newIds = new Set(nodes.map((n) => n.id))
    for (const id of this.sim.nodes.keys()) {
      if (!newIds.has(id)) this.sim.nodes.delete(id)
    }
    for (const n of nodes) {
      const existing = this.sim.nodes.get(n.id)
      if (existing) {
        existing.content = n.content
        existing.isError = n.isError
        existing.isRunning = n.isRunning
        existing.durationMs = n.durationMs
        existing.toolName = n.toolName
        existing.hue = n.hue
      } else {
        this.sim.nodes.set(n.id, { ...n })
        this.sim.cooled = false
      }
    }
    this.sim.edges = edges
    this.sim.cooled = false
    // 同步粒子
    const edgeIds = new Set(edges.map((e) => e.id))
    this.particles = this.particles.filter((p) => edgeIds.has(p.edgeId))
    for (const e of edges) {
      if (!this.particles.some((p) => p.edgeId === e.id)) {
        for (let i = 0; i < 3; i++) this.particles.push({ edgeId: e.id, t: i / 3 })
      }
    }
    this.autoFit()
  }

  private autoFit() {
    if (this.sim.nodes.size === 0) return
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const s of this.sim.nodes.values()) {
      minX = Math.min(minX, s.x - s.radius)
      maxX = Math.max(maxX, s.x + s.radius)
      minY = Math.min(minY, s.y - s.radius)
      maxY = Math.max(maxY, s.y + s.radius)
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const rangeX = maxX - minX + 200, rangeY = maxY - minY + 200
    this.zoom = Math.min(1.5, Math.min(this.width / rangeX, this.height / rangeY))
    this.offsetX = -cx; this.offsetY = -cy
  }

  resetView() { this.autoFit() }

  /* 坐标变换 */
  private w2s(wx: number, wy: number): [number, number] {
    return [(wx + this.offsetX) * this.zoom + this.width / 2, (wy + this.offsetY) * this.zoom + this.height / 2]
  }
  private s2w(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.zoom - this.offsetX, (sy - this.height / 2) / this.zoom - this.offsetY]
  }

  /* 事件 */
  private isPanning = false
  private panStart = { x: 0, y: 0 }
  private dragNode: string | null = null

  private bindEvents() {
    this.canvas.addEventListener('wheel', this.onWheel)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointerleave', this.onPointerUp)
  }
  private unbindEvents() {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onPointerUp)
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    this.zoom = Math.max(0.1, Math.min(5, this.zoom * factor))
  }

  private onPointerDown = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    const [wx, wy] = this.s2w(sx, sy)
    // 命中检测（从后往前）
    const arr = Array.from(this.sim.nodes.values())
    for (let i = arr.length - 1; i >= 0; i--) {
      const n = arr[i]
      const dx = wx - n.x, dy = wy - n.y
      if (dx * dx + dy * dy <= n.radius * n.radius) {
        this.selectedId = n.id
        this.dragNode = n.id
        n.pinned = true
        this.onNodeSelect?.(n)
        return
      }
    }
    // 空白 → 平移
    this.selectedId = null
    this.onNodeSelect?.(null)
    this.isPanning = true
    this.panStart = { x: e.clientX, y: e.clientY }
  }

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    if (this.dragNode) {
      const [wx, wy] = this.s2w(sx, sy)
      const n = this.sim.nodes.get(this.dragNode)
      if (n) { n.x = wx; n.y = wy; n.vx = 0; n.vy = 0; this.sim.cooled = false }
      return
    }
    if (this.isPanning) {
      const dx = e.clientX - this.panStart.x
      const dy = e.clientY - this.panStart.y
      this.offsetX += dx / this.zoom
      this.offsetY += dy / this.zoom
      this.panStart = { x: e.clientX, y: e.clientY }
      return
    }
    // hover
    const [wx, wy] = this.s2w(sx, sy)
    this.hoverId = null
    for (const n of this.sim.nodes.values()) {
      const dx = wx - n.x, dy = wy - n.y
      if (dx * dx + dy * dy <= n.radius * n.radius) { this.hoverId = n.id; break }
    }
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab'
  }

  private onPointerUp = () => {
    if (this.dragNode) {
      const n = this.sim.nodes.get(this.dragNode)
      if (n) n.pinned = false
      this.dragNode = null
    }
    this.isPanning = false
  }

  /* 渲染 */
  private resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    this.dpr = window.devicePixelRatio || 1
    this.width = parent.clientWidth
    this.height = parent.clientHeight
    this.canvas.width = this.width * this.dpr
    this.canvas.height = this.height * this.dpr
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  private initStars() {
    this.stars = []
    for (let i = 0; i < 300; i++) {
      this.stars.push({
        x: Math.random() * 4000 - 2000, y: Math.random() * 4000 - 2000,
        size: Math.random() * 1.8 + 0.3, layer: Math.floor(Math.random() * 3),
        alpha: Math.random() * 0.6 + 0.2, twinkle: Math.random() < 0.1,
      })
    }
  }

  private loop = () => {
    tickSim(this.sim)
    this.render()
    this.animId = requestAnimationFrame(this.loop)
  }

  private render() {
    const ctx = this.ctx, w = this.width, h = this.height
    const now = performance.now()
    const time = (now - this.startTime) / 1000

    // 背景（径向渐变）
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7)
    bg.addColorStop(0, 'hsl(230, 20%, 8%)')
    bg.addColorStop(1, 'hsl(230, 15%, 3%)')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)

    this.renderStars(ctx, time)
    this.renderEdges(ctx)
    this.renderNodes(ctx, now)
  }

  private renderStars(ctx: CanvasRenderingContext2D, time: number) {
    const parallax = [0.1, 0.3, 0.6]
    for (const star of this.stars) {
      const pf = parallax[star.layer]
      const sx = (star.x + this.offsetX * pf) * this.zoom + this.width / 2
      const sy = (star.y + this.offsetY * pf) * this.zoom + this.height / 2
      if (sx < -5 || sx > this.width + 5 || sy < -5 || sy > this.height + 5) continue
      let alpha = star.alpha
      if (star.twinkle) alpha *= 0.5 + 0.5 * Math.sin(time * 2 + star.x * 0.01)
      ctx.beginPath()
      ctx.arc(sx, sy, star.size * this.zoom, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(220,230,255,${alpha})`
      ctx.fill()
    }
  }

  private renderEdges(ctx: CanvasRenderingContext2D) {
    for (const edge of this.sim.edges) {
      const a = this.sim.nodes.get(edge.fromId)
      const b = this.sim.nodes.get(edge.toId)
      if (!a || !b) continue
      const [x1, y1] = this.w2s(a.x, a.y)
      const [x2, y2] = this.w2s(b.x, b.y)
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
      const dx = x2 - x1, dy = y2 - y1
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const cx = mx + (-dy / len) * len * 0.15
      const cy = my + (dx / len) * len * 0.15

      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.quadraticCurveTo(cx, cy, x2, y2)

      if (edge.type === 'tool') { ctx.strokeStyle = 'hsla(200,50%,50%,0.2)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]) }
      else if (edge.type === 'cross-turn') { ctx.strokeStyle = 'hsla(200,40%,45%,0.12)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]) }
      else { ctx.strokeStyle = 'hsla(200,60%,50%,0.3)'; ctx.lineWidth = 1.5; ctx.setLineDash([]) }
      ctx.stroke()
      ctx.setLineDash([])

      // 流动粒子
      const eps = this.particles.filter((p) => p.edgeId === edge.id)
      const speed = edge.type === 'cross-turn' ? 0.002 : 0.004
      for (const p of eps) {
        p.t = (p.t + speed) % 1
        const u = 1 - p.t
        const px = u * u * x1 + 2 * u * p.t * cx + p.t * p.t * x2
        const py = u * u * y1 + 2 * u * p.t * cy + p.t * p.t * y2
        const hue = edge.type === 'tool' ? 200 : 45
        ctx.beginPath()
        ctx.arc(px, py, 2, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${hue},80%,70%,0.7)`
        ctx.fill()
      }
    }
  }

  private renderNodes(ctx: CanvasRenderingContext2D, now: number) {
    const fontSize = Math.max(9, 11 * this.zoom)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    for (const node of this.sim.nodes.values()) {
      const [sx, sy] = this.w2s(node.x, node.y)
      const r = node.radius * this.zoom
      if (r < 2) continue
      if (sx < -r * 3 || sx > this.width + r * 3 || sy < -r * 3 || sy > this.height + r * 3) continue

      const isHover = this.hoverId === node.id
      const isSelected = this.selectedId === node.id
      const age = now - node.birthTime
      const birth = Math.min(1, age / 1200)
      const eased = 1 - Math.pow(1 - birth, 3)
      const er = r * eased
      if (er < 0.5) continue

      const hue = node.hue
      const light = node.isError ? 40 : node.kind === 'core' ? 55 : 50
      const sat = node.isError ? 90 : 70

      // 外发光
      const glowR = er * (isHover ? 3 : 2.2)
      const glow = ctx.createRadialGradient(sx, sy, er * 0.3, sx, sy, glowR)
      glow.addColorStop(0, `hsla(${hue},${sat}%,60%,${isHover ? 0.45 : 0.25})`)
      glow.addColorStop(1, 'transparent')
      ctx.beginPath()
      ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
      ctx.fillStyle = glow
      ctx.fill()

      // 诞生脉冲
      if (birth < 1) {
        const pulse = Math.sin(birth * Math.PI * 2) * 0.3
        if (pulse > 0) {
          ctx.beginPath()
          ctx.arc(sx, sy, er * (1 + birth * 0.8), 0, Math.PI * 2)
          ctx.strokeStyle = `hsla(${hue},80%,70%,${pulse})`
          ctx.lineWidth = 2
          ctx.stroke()
        }
      }

      // 运行呼吸
      if (node.isRunning) {
        const breath = 1 + 0.08 * Math.sin(now / 500)
        ctx.beginPath()
        ctx.arc(sx, sy, er * breath * 1.3, 0, Math.PI * 2)
        ctx.strokeStyle = `hsla(${hue},80%,60%,0.2)`
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // 主体气泡
      const bodyGrad = ctx.createRadialGradient(sx - er * 0.3, sy - er * 0.3, 0, sx, sy, er)
      bodyGrad.addColorStop(0, `hsla(${hue},${sat}%,${light + 15}%,0.9)`)
      bodyGrad.addColorStop(1, `hsla(${hue},${sat}%,${light - 10}%,0.7)`)
      ctx.beginPath()
      ctx.arc(sx, sy, er, 0, Math.PI * 2)
      ctx.fillStyle = bodyGrad
      ctx.fill()

      // 选中环
      if (isSelected) {
        ctx.beginPath()
        ctx.arc(sx, sy, er + 3, 0, Math.PI * 2)
        ctx.strokeStyle = `hsla(${hue},90%,70%,0.8)`
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // 错误标记
      if (node.isError) {
        ctx.fillStyle = 'hsla(0,90%,60%,0.9)'
        ctx.font = `bold ${Math.max(10, er * 0.5)}px sans-serif`
        ctx.fillText('✗', sx + er * 0.5, sy - er * 0.5)
      }

      // 内容文字（核心直观性来源：直接可读，无需点击）
      if (this.zoom > 0.35) {
        const maxChars = Math.floor(er * 1.8 / (fontSize * 0.55))
        let text = node.content
        if (text.length > maxChars) text = text.slice(0, maxChars) + '…'
        if (text) {
          ctx.font = `${fontSize}px -apple-system, sans-serif`
          // 文字背景（提高可读性）
          const textW = ctx.measureText(text).width
          ctx.fillStyle = 'rgba(0,0,0,0.3)'
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(sx - textW / 2 - 4, sy + er * 0.3, textW + 8, fontSize + 6, 4)
            ctx.fill()
          }
          // 文字
          ctx.fillStyle = `hsla(${hue},30%,90%,0.9)`
          ctx.fillText(text, sx, sy + er * 0.3 + (fontSize + 6) / 2)
        }
        // 工具名（工具节点在气泡中心显示）
        if (node.kind === 'tool' && this.zoom > 0.6) {
          ctx.font = `bold ${Math.max(8, fontSize * 0.8)}px monospace`
          ctx.fillStyle = `hsla(${hue},60%,80%,0.9)`
          ctx.fillText(node.toolName ?? node.content, sx, sy - er * 0.1)
        }
      }

      // 耗时标签
      if (node.durationMs != null && node.durationMs > 500 && this.zoom > 0.5) {
        const dur = node.durationMs < 1000 ? `${node.durationMs}ms` : `${(node.durationMs / 1000).toFixed(1)}s`
        ctx.font = `${Math.max(7, fontSize * 0.7)}px monospace`
        ctx.fillStyle = 'rgba(200,200,200,0.5)'
        ctx.fillText(dur, sx, sy - er - 8)
      }
    }
  }
}
