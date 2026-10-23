/**
 * Cosmos 2D v3 —— 结构化星座布局（确定性空间语法取代力模拟）
 *
 * 空间语法：
 *   X 轴 = 时间（回合从左到右线性推进）
 *   Y 轴 = 层级（用户上 → 助手中 → 工具方格下）
 *   宽度 = 复杂度（工具多的回合更宽）
 *   整体轮廓 = 会话模式签名（简单问答=低矮，深度研究=高塔）
 *
 * 三范式融合：
 * - Minecraft：工具 = 方块网格，回合 = 建筑群
 * - bbycroft：相机编排 + 步进叙事 + 焦点暗化
 * - JetBot：隐藏复杂性 + 内容直接可见 + 诞生/呼吸动画
 */

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
  targetX: number; targetY: number
  x: number; y: number
  radius: number
  hue: number
  gridCol?: number; gridRow?: number
}

export interface CosmosEdge2D {
  id: string; fromId: string; toId: string
  type: 'flow' | 'cross-turn' | 'grid'
}

export interface TurnCluster {
  turnId: number; centerX: number; centerY: number
  width: number; height: number
  nodeIds: string[]; summary: string; hue: number
  toolCount: number; hasError: boolean; totalDuration: number
}

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

const TURN_GAP = 180
const USER_Y = -70
const ASST_Y = 0
const TOOL_Y0 = 60
const TOOL_CW = 44; const TOOL_RH = 38; const TOOL_COLS = 3
const R: Record<string, number> = { user: 30, assistant: 26, tool: 16, 'sub-agent': 36, core: 40, file: 12 }
const LERP = 0.1

export function mapSessionToCosmos(
  msgs: Array<{ role: string; content?: string | null; tool_calls?: Array<{ id: string; name: string }>; name?: string; toolOk?: boolean; durationMs?: number }>,
  folded: number,
): { nodes: CosmosNode2D[]; edges: CosmosEdge2D[]; clusters: TurnCluster[] } {
  const nodes: CosmosNode2D[] = []
  const edges: CosmosEdge2D[] = []
  const clusters: TurnCluster[] = []
  let turn = 0

  if (folded > 0) {
    nodes.push({ id: 'core', kind: 'core', content: `⚡ ${folded} 条已压缩`, turnId: -1, birthTime: performance.now(), targetX: -TURN_GAP, targetY: 0, x: -TURN_GAP, y: 0, radius: R.core, hue: KIND_HUE.core })
    clusters.push({ turnId: -1, centerX: -TURN_GAP, centerY: 0, width: 100, height: 100, nodeIds: ['core'], summary: `压缩历史 (${folded})`, hue: 45, toolCount: 0, hasError: false, totalDuration: 0 })
  }

  msgs.slice(folded).forEach((m, i) => {
    const now = performance.now()
    if (m.role === 'user') {
      turn++
      const x = turn * TURN_GAP
      const id = `u${i}`
      nodes.push({ id, kind: 'user', content: (m.content ?? '').slice(0, 120), turnId: turn, birthTime: now, targetX: x, targetY: USER_Y, x, y: USER_Y, radius: R.user, hue: KIND_HUE.user })
      const prev = nodes[nodes.length - 2]
      if (prev) edges.push({ id: `xt${i}`, fromId: prev.id, toId: id, type: 'cross-turn' })
      clusters.push({ turnId: turn, centerX: x, centerY: 0, width: TURN_GAP * 0.7, height: 200, nodeIds: [id], summary: `T${turn}: ${(m.content ?? '').slice(0, 50)}`, hue: 30, toolCount: 0, hasError: false, totalDuration: 0 })
    } else if (m.role === 'assistant') {
      const id = `a${i}`; const x = turn * TURN_GAP
      nodes.push({ id, kind: 'assistant', content: (m.content ?? '').slice(0, 120) || `${m.tool_calls?.length ?? 0} 工具`, turnId: turn, birthTime: now, targetX: x, targetY: ASST_Y, x, y: ASST_Y, radius: R.assistant, hue: KIND_HUE.assistant })
      const un = nodes.find((n) => n.kind === 'user' && n.turnId === turn)
      if (un) edges.push({ id: `f${i}`, fromId: un.id, toId: id, type: 'flow' })
      clusters.find((c) => c.turnId === turn)?.nodeIds.push(id)
      if (m.tool_calls) {
        m.tool_calls.forEach((tc, j) => {
          const tid = `t${i}_${j}`; const col = j % TOOL_COLS; const row = Math.floor(j / TOOL_COLS)
          const gx = x + (col - 1) * TOOL_CW; const gy = TOOL_Y0 + row * TOOL_RH
          nodes.push({ id: tid, kind: 'tool', content: tc.name, toolName: tc.name, turnId: turn, birthTime: now, targetX: gx, targetY: gy, x: gx, y: gy, radius: R.tool, hue: TOOL_HUE[tc.name] ?? 210, gridCol: col, gridRow: row })
          edges.push({ id: `g${tid}`, fromId: id, toId: tid, type: 'grid' })
          clusters.find((c) => c.turnId === turn)?.nodeIds.push(tid)
        })
        const c = clusters.find((cl) => cl.turnId === turn)
        if (c) { c.toolCount = m.tool_calls.length; c.width = Math.max(c.width, m.tool_calls.length * TOOL_CW * 0.5); c.height = TOOL_Y0 + Math.ceil(m.tool_calls.length / TOOL_COLS) * TOOL_RH + 20 }
      }
    } else if (m.role === 'tool') {
      const tn = nodes.find((n) => n.kind === 'tool' && n.turnId === turn && n.toolName === m.name && n.durationMs == null)
      if (tn) {
        tn.isError = m.toolOk === false; tn.durationMs = m.durationMs; tn.content = `${m.name} ${m.toolOk === false ? '✗' : '✓'}`
        const c = clusters.find((cl) => cl.turnId === turn)
        if (c) { if (m.toolOk === false) c.hasError = true; c.totalDuration += m.durationMs ?? 0 }
      }
    }
  })
  return { nodes, edges, clusters }
}

interface Star { x: number; y: number; size: number; layer: number; alpha: number; twinkle: boolean }
interface Particle { edgeId: string; t: number }

export class CosmosCanvas2D {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private w = 0; private h = 0; private dpr = 1
  private animId = 0
  private nodes: CosmosNode2D[] = []
  private edges: CosmosEdge2D[] = []
  private clusters: TurnCluster[] = []
  private nm = new Map<string, CosmosNode2D>()
  private stars: Star[] = []
  private particles: Particle[] = []
  private t0 = performance.now()
  private zoom = 1; private ox = 0; private oy = 0
  private hoverId: string | null = null
  private selectedId: string | null = null
  private focusTurn: number | null = null
  private ro: ResizeObserver
  private onSelect: ((n: CosmosNode2D | null) => void) | null = null
  private onCaption: ((c: string | null) => void) | null = null
  private cam: { t: number; d: number; fx: number; fy: number; fz: number; tx: number; ty: number; tz: number } | null = null
  private panning = false
  private panS = { x: 0, y: 0 }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas.parentElement || canvas)
    this.resize(); this.initStars(); this.loop(); this.bind()
  }
  destroy() { cancelAnimationFrame(this.animId); this.ro.disconnect(); this.unbind() }

  setOnNodeSelect(cb: (n: CosmosNode2D | null) => void) { this.onSelect = cb }
  setOnCaptionUpdate(cb: (c: string | null) => void) { this.onCaption = cb }

  setNodes(nodes: CosmosNode2D[], edges: CosmosEdge2D[], clusters: TurnCluster[]) {
    const newIds = new Set(nodes.map((n) => n.id))
    this.nodes = this.nodes.filter((n) => newIds.has(n.id))
    for (const n of nodes) {
      const old = this.nm.get(n.id)
      if (old) {
        old.content = n.content; old.isError = n.isError; old.durationMs = n.durationMs
        old.hue = n.hue; old.targetX = n.targetX; old.targetY = n.targetY; old.toolName = n.toolName
      } else {
        n.y = n.targetY - 30
        this.nodes.push(n)
      }
    }
    this.nm = new Map(this.nodes.map((n) => [n.id, n]))
    this.edges = edges; this.clusters = clusters
    const eids = new Set(edges.map((e) => e.id))
    this.particles = this.particles.filter((p) => eids.has(p.edgeId))
    for (const e of edges) if (!this.particles.some((p) => p.edgeId === e.id)) this.particles.push({ edgeId: e.id, t: Math.random() })
  }

  flyToTurn(tid: number) {
    const c = this.clusters.find((cl) => cl.turnId === tid); if (!c) return
    this.focusTurn = tid
    this.animateCam(c.centerX, 0, Math.max(1.5, 250 / Math.max(c.width, 80)))
    this.onCaption?.(c.summary)
  }
  resetView() { this.focusTurn = null; this.onCaption?.(null); this.autoFit() }
  getTourSteps() { return this.clusters.filter((c) => c.turnId >= 0).sort((a, b) => a.turnId - b.turnId) }

  private animateCam(tx: number, ty: number, tz: number) {
    this.cam = { t: 0, d: 600, fx: this.ox, fy: this.oy, fz: this.zoom, tx: -tx, ty: -ty, tz }
  }
  private autoFit() {
    if (!this.nodes.length) return
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity
    for (const n of this.nodes) { x1 = Math.min(x1, n.x - n.radius); x2 = Math.max(x2, n.x + n.radius); y1 = Math.min(y1, n.y - n.radius); y2 = Math.max(y2, n.y + n.radius) }
    this.zoom = Math.min(1.2, Math.min(this.w / (x2 - x1 + 200), this.h / (y2 - y1 + 200)))
    this.ox = -(x1 + x2) / 2; this.oy = -(y1 + y2) / 2
  }
  private w2s(wx: number, wy: number): [number, number] { return [(wx + this.ox) * this.zoom + this.w / 2, (wy + this.oy) * this.zoom + this.h / 2] }
  private s2w(sx: number, sy: number): [number, number] { return [(sx - this.w / 2) / this.zoom - this.ox, (sy - this.h / 2) / this.zoom - this.oy] }

  private bind() {
    this.canvas.addEventListener('wheel', this.onWheel)
    this.canvas.addEventListener('pointerdown', this.onPD)
    this.canvas.addEventListener('pointermove', this.onPM)
    this.canvas.addEventListener('pointerup', this.onPU)
    this.canvas.addEventListener('pointerleave', this.onPU)
  }
  private unbind() {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onPD)
    this.canvas.removeEventListener('pointermove', this.onPM)
    this.canvas.removeEventListener('pointerup', this.onPU)
    this.canvas.removeEventListener('pointerleave', this.onPU)
  }
  private onWheel = (e: WheelEvent) => { e.preventDefault(); this.cam = null; this.zoom = Math.max(0.1, Math.min(5, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1))) }
  private onPD = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect()
    const [wx, wy] = this.s2w(e.clientX - r.left, e.clientY - r.top)
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]; const dx = wx - n.x, dy = wy - n.y
      if (dx * dx + dy * dy <= n.radius * n.radius) { this.selectedId = n.id; this.onSelect?.(n); return }
    }
    for (const c of this.clusters) {
      if (Math.abs(wx - c.centerX) < c.width / 2 && Math.abs(wy) < c.height / 2) { this.flyToTurn(c.turnId); return }
    }
    this.selectedId = null; this.focusTurn = null; this.onSelect?.(null); this.onCaption?.(null)
    this.panning = true; this.panS = { x: e.clientX, y: e.clientY }
  }
  private onPM = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect()
    if (this.panning) {
      this.cam = null
      this.ox += (e.clientX - this.panS.x) / this.zoom; this.oy += (e.clientY - this.panS.y) / this.zoom
      this.panS = { x: e.clientX, y: e.clientY }; return
    }
    const [wx, wy] = this.s2w(e.clientX - r.left, e.clientY - r.top)
    this.hoverId = null
    for (const n of this.nodes) { const dx = wx - n.x, dy = wy - n.y; if (dx * dx + dy * dy <= n.radius * n.radius) { this.hoverId = n.id; break } }
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab'
  }
  private onPU = () => { this.panning = false }

  private resize() {
    const p = this.canvas.parentElement; if (!p) return
    this.dpr = window.devicePixelRatio || 1
    this.w = p.clientWidth; this.h = p.clientHeight
    this.canvas.width = this.w * this.dpr; this.canvas.height = this.h * this.dpr
    this.canvas.style.width = `${this.w}px`; this.canvas.style.height = `${this.h}px`
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }
  private initStars() {
    this.stars = []
    for (let i = 0; i < 200; i++) this.stars.push({ x: Math.random() * 3000 - 1500, y: Math.random() * 2000 - 1000, size: Math.random() * 1.5 + 0.3, layer: Math.floor(Math.random() * 3), alpha: Math.random() * 0.5 + 0.15, twinkle: Math.random() < 0.1 })
  }

  private loop = () => {
    if (this.cam) {
      const a = this.cam; a.t += 16 / a.d
      if (a.t >= 1) { this.ox = a.tx; this.oy = a.ty; this.zoom = a.tz; this.cam = null }
      else { const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2; this.ox = a.fx + (a.tx - a.fx) * e; this.oy = a.fy + (a.ty - a.fy) * e; this.zoom = a.fz + (a.tz - a.fz) * e }
    }
    for (const n of this.nodes) { n.x += (n.targetX - n.x) * LERP; n.y += (n.targetY - n.y) * LERP }
    this.render()
    this.animId = requestAnimationFrame(this.loop)
  }

  private render() {
    const ctx = this.ctx; const now = performance.now(); const time = (now - this.t0) / 1000
    const bg = ctx.createRadialGradient(this.w / 2, this.h / 2, 0, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.7)
    bg.addColorStop(0, 'hsl(230,20%,8%)'); bg.addColorStop(1, 'hsl(230,15%,3%)')
    ctx.fillStyle = bg; ctx.fillRect(0, 0, this.w, this.h)
    // 星尘
    const px = [0.1, 0.3, 0.6]
    for (const s of this.stars) {
      const sx = (s.x + this.ox * px[s.layer]) * this.zoom + this.w / 2
      const sy = (s.y + this.oy * px[s.layer]) * this.zoom + this.h / 2
      if (sx < -5 || sx > this.w + 5 || sy < -5 || sy > this.h + 5) continue
      ctx.beginPath(); ctx.arc(sx, sy, s.size * this.zoom, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(220,230,255,${s.twinkle ? s.alpha * (0.5 + 0.5 * Math.sin(time * 2 + s.x * 0.01)) : s.alpha})`; ctx.fill()
    }
    // 时间轴基线
    if (this.nodes.length > 1) {
      const [x1] = this.w2s(this.nodes[0].x, 0); const [x2] = this.w2s(this.nodes[this.nodes.length - 1].x, 0)
      ctx.beginPath(); ctx.moveTo(x1 - 20 * this.zoom, this.h / 2); ctx.lineTo(x2 + 20 * this.zoom, this.h / 2)
      ctx.strokeStyle = 'hsla(210,30%,30%,0.1)'; ctx.lineWidth = 1; ctx.setLineDash([2, 8]); ctx.stroke(); ctx.setLineDash([])
    }
    // 回合建筑轮廓
    for (const c of this.clusters) {
      const [sx] = this.w2s(c.centerX, 0); const w = c.width * this.zoom; const h = c.height * this.zoom
      if (sx + w / 2 < 0 || sx - w / 2 > this.w) continue
      const isF = this.focusTurn === null || this.focusTurn === c.turnId
      ctx.beginPath(); ctx.roundRect(sx - w / 2, this.h / 2 - h / 2 + this.oy * this.zoom * 0.3, w, h, 6)
      ctx.strokeStyle = `hsla(${c.hue},50%,50%,${isF ? 0.06 : 0.015})`; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([])
      if (this.focusTurn === c.turnId) { ctx.fillStyle = `hsla(${c.hue},40%,30%,0.03)`; ctx.fill() }
      if (this.zoom > 0.5 && c.turnId >= 0) {
        ctx.font = `${10 * this.zoom}px monospace`; ctx.textAlign = 'center'; ctx.fillStyle = `hsla(${c.hue},30%,60%,${isF ? 0.4 : 0.1})`
        ctx.fillText(`T${c.turnId + 1}`, sx, this.h / 2 - h / 2 + this.oy * this.zoom * 0.3 - 8)
      }
    }
    // 连接
    for (const e of this.edges) {
      const a = this.nm.get(e.fromId); const b = this.nm.get(e.toId); if (!a || !b) continue
      const isF = this.focusTurn === null || a.turnId === this.focusTurn || b.turnId === this.focusTurn; if (!isF) continue
      const [x1, y1] = this.w2s(a.x, a.y); const [x2, y2] = this.w2s(b.x, b.y)
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2)
      if (e.type === 'grid') { ctx.strokeStyle = `hsla(${a.hue},40%,50%,0.08)`; ctx.lineWidth = 1 }
      else if (e.type === 'cross-turn') { ctx.strokeStyle = 'hsla(200,40%,45%,0.06)'; ctx.lineWidth = 1 }
      else { ctx.strokeStyle = 'hsla(200,60%,50%,0.15)'; ctx.lineWidth = 1.5 }
      ctx.stroke()
    }
    // 流动粒子
    for (const p of this.particles) {
      const e = this.edges.find((ed) => ed.id === p.edgeId); if (!e || e.type === 'grid') continue
      const a = this.nm.get(e.fromId); const b = this.nm.get(e.toId); if (!a || !b) continue
      const isF = this.focusTurn === null || a.turnId === this.focusTurn; if (!isF) continue
      p.t = (p.t + 0.005) % 1
      const [x1, y1] = this.w2s(a.x, a.y); const [x2, y2] = this.w2s(b.x, b.y)
      const px2 = x1 + (x2 - x1) * p.t; const py2 = y1 + (y2 - y1) * p.t
      ctx.beginPath(); ctx.arc(px2, py2, 1.5, 0, Math.PI * 2); ctx.fillStyle = 'hsla(45,80%,70%,0.4)'; ctx.fill()
    }
    // 节点
    const fs = Math.max(9, 11 * this.zoom); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    for (const n of this.nodes) {
      const [sx, sy] = this.w2s(n.x, n.y); const r = n.radius * this.zoom
      if (r < 2 || sx < -r * 3 || sx > this.w + r * 3 || sy < -r * 3 || sy > this.h + r * 3) continue
      const isF = this.focusTurn === null || n.turnId === this.focusTurn
      const alpha = isF ? 1 : 0.1; const isH = this.hoverId === n.id; const isS = this.selectedId === n.id
      const age = now - n.birthTime; const birth = Math.min(1, age / 800); const eased = 1 - (1 - birth) ** 3; const er = r * eased
      if (er < 0.5) continue
      const { hue } = n; const sat = n.isError ? 90 : 70; const li = n.isError ? 40 : n.kind === 'core' ? 55 : 50
      ctx.globalAlpha = alpha
      // glow
      const gr = er * (isH ? 3 : 2)
      const g = ctx.createRadialGradient(sx, sy, er * 0.3, sx, sy, gr)
      g.addColorStop(0, `hsla(${hue},${sat}%,60%,${(isH ? 0.4 : 0.2) * alpha})`); g.addColorStop(1, 'transparent')
      ctx.beginPath(); ctx.arc(sx, sy, gr, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill()
      // birth pulse
      if (birth < 1 && isF) { const pl = Math.sin(birth * Math.PI) * 0.4; if (pl > 0) { ctx.beginPath(); ctx.arc(sx, sy, er * (1 + birth), 0, Math.PI * 2); ctx.strokeStyle = `hsla(${hue},80%,70%,${pl * alpha})`; ctx.lineWidth = 2; ctx.stroke() } }
      // body
      if (n.kind === 'tool') {
        const hf = er * 0.85
        const fg = ctx.createLinearGradient(sx - hf, sy - hf, sx + hf, sy + hf)
        fg.addColorStop(0, `hsla(${hue},${sat}%,${li + 15}%,0.9)`); fg.addColorStop(1, `hsla(${hue},${sat}%,${li - 10}%,0.7)`)
        ctx.fillStyle = fg; ctx.beginPath(); ctx.roundRect(sx - hf, sy - hf, hf * 2, hf * 2, 2); ctx.fill()
        ctx.strokeStyle = `hsla(${hue},${sat}%,${li + 20}%,0.4)`; ctx.lineWidth = 1; ctx.stroke()
      } else {
        const bg2 = ctx.createRadialGradient(sx - er * 0.3, sy - er * 0.3, 0, sx, sy, er)
        bg2.addColorStop(0, `hsla(${hue},${sat}%,${li + 15}%,0.9)`); bg2.addColorStop(1, `hsla(${hue},${sat}%,${li - 10}%,0.7)`)
        ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.fillStyle = bg2; ctx.fill()
      }
      if (isS) { ctx.beginPath(); ctx.arc(sx, sy, er + 3, 0, Math.PI * 2); ctx.strokeStyle = `hsla(${hue},90%,70%,0.8)`; ctx.lineWidth = 2; ctx.stroke() }
      if (n.isError) { ctx.fillStyle = `hsla(0,90%,60%,${0.9 * alpha})`; ctx.font = `bold ${Math.max(9, er * 0.5)}px sans-serif`; ctx.fillText('✗', sx + er * 0.5, sy - er * 0.5) }
      // text
      if (this.zoom > 0.35 && isF) {
        if (n.kind === 'tool') {
          ctx.font = `bold ${Math.max(7, fs * 0.7)}px monospace`; ctx.fillStyle = `hsla(${hue},60%,80%,0.9)`
          const tn = n.toolName ?? n.content; ctx.fillText(tn.length > 8 ? tn.slice(0, 7) + '…' : tn, sx, sy)
        } else {
          const mc = Math.floor(er * 2 / (fs * 0.55)); let t = n.content
          if (t.length > mc) t = t.slice(0, mc) + '…'
          if (t) { ctx.font = `${fs}px -apple-system, sans-serif`; ctx.fillStyle = `hsla(${hue},30%,88%,0.9)`; ctx.fillText(t, sx, sy + er * 0.4) }
        }
      }
      if (n.durationMs != null && n.durationMs > 500 && this.zoom > 0.5 && isF) {
        const d = n.durationMs < 1000 ? `${n.durationMs}ms` : `${(n.durationMs / 1000).toFixed(1)}s`
        ctx.font = `${Math.max(7, fs * 0.7)}px monospace`; ctx.fillStyle = 'rgba(200,200,200,0.3)'; ctx.fillText(d, sx, sy - er - 8)
      }
      ctx.globalAlpha = 1
    }
  }
}
