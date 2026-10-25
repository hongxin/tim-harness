/**
 * CosmosCanvas —— JetBot 风格冒泡可视化（回归简洁）
 */

export interface CosmosNode {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'core'
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
  dragged?: boolean
  hue: number
}

export interface CosmosEdge {
  id: string; fromId: string; toId: string
  type: 'flow' | 'cross-turn' | 'tool'
}

export const TOOL_HUE: Record<string, number> = {
  read_file: 200, write_file: 160, edit_file: 280,
  run_js: 45, grep: 180, glob: 150, ls: 140,
  web_fetch: 320, web_search: 220, todo_write: 100,
  spawn_agent: 300, ask_user: 50, skill: 260,
  goal_update: 120, snapshot_save: 170,
}
const KIND_HUE: Record<string, number> = {
  user: 30, assistant: 260, tool: 210, core: 45,
}
const NODE_R: Record<string, number> = {
  user: 36, assistant: 30, tool: 16, core: 42,
}

const REPULSION = 6000
const SPRING = 0.006
const SPRING_REST = 160
const CENTER_PULL = 0.0008
const DAMPING = 0.82
const MAX_VEL = 10
const COOLING = 0.05

interface SimState { nodes: Map<string, CosmosNode>; edges: CosmosEdge[]; cooled: boolean }

function tickSim(sim: SimState) {
  if (sim.cooled || sim.nodes.size < 2) return
  const arr = Array.from(sim.nodes.values())
  let energy = 0
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j]
      let dx = b.x - a.x, dy = b.y - a.y
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 1) { dx = Math.random() - .5; dy = Math.random() - .5; dist = 1 }
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
    const rest = e.type === 'cross-turn' ? 220 : SPRING_REST
    const f = SPRING * (dist - rest)
    const fx = (dx / dist) * f, fy = (dy / dist) * f
    if (!a.pinned) { a.vx += fx; a.vy += fy }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy }
  }
  for (const n of arr) {
    if (n.pinned) continue
    n.vx -= n.x * CENTER_PULL; n.vy -= n.y * CENTER_PULL
    n.vx *= DAMPING; n.vy *= DAMPING
    const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
    if (sp > MAX_VEL) { n.vx = n.vx / sp * MAX_VEL; n.vy = n.vy / sp * MAX_VEL }
    n.x += n.vx; n.y += n.vy
    energy += n.vx * n.vx + n.vy * n.vy
  }
  if (energy < COOLING) sim.cooled = true
}

function mapSession(
  msgs: Array<{
    role: string; content?: string | null
    tool_calls?: Array<{ id: string; name: string }>
    tool_call_id?: string; name?: string
    toolOk?: boolean; durationMs?: number
  }>,
  folded: number,
): { nodes: CosmosNode[]; edges: CosmosEdge[] } {
  const nodes: CosmosNode[] = []
  const edges: CosmosEdge[] = []
  let turn = 0
  let prev: string | null = null

  if (folded > 0) {
    nodes.push({
      id: 'core', kind: 'core', content: `⚡ ${folded}`,
      turnId: -1, birthTime: performance.now(),
      x: -200, y: 0, vx: 0, vy: 0,
      radius: NODE_R.core, pinned: false, hue: 45,
    })
    prev = 'core'
  }

  msgs.slice(folded).forEach((m, i) => {
    const now = performance.now()
    if (m.role === 'user') {
      turn++
      const id = `u${i}`
      const angle = Math.random() * Math.PI * 2
      nodes.push({
        id, kind: 'user', content: (m.content ?? '').slice(0, 100),
        turnId: turn, birthTime: now,
        x: Math.cos(angle) * 100, y: Math.sin(angle) * 100,
        vx: 0, vy: 0, radius: NODE_R.user, pinned: false, hue: KIND_HUE.user,
      })
      if (prev) edges.push({ id: `xt${i}`, fromId: prev, toId: id, type: 'cross-turn' })
      prev = id
    } else if (m.role === 'assistant') {
      const id = `a${i}`
      nodes.push({
        id, kind: 'assistant',
        content: (m.content ?? '').slice(0, 100) || `${m.tool_calls?.length ?? 0} 工具`,
        turnId: turn, birthTime: now,
        x: (nodes[nodes.length - 1]?.x ?? 0) + (Math.random() - .5) * 50,
        y: (nodes[nodes.length - 1]?.y ?? 0) + (Math.random() - .5) * 50,
        vx: 0, vy: 0, radius: NODE_R.assistant, pinned: false, hue: KIND_HUE.assistant,
      })
      const un = nodes.find(n => n.kind === 'user' && n.turnId === turn)
      if (un) edges.push({ id: `f${i}`, fromId: un.id, toId: id, type: 'flow' })
      if (m.tool_calls) {
        m.tool_calls.forEach((tc, j) => {
          const tid = `t${i}_${j}`
          nodes.push({
            id: tid, kind: 'tool', content: tc.name, toolName: tc.name,
            turnId: turn, birthTime: now,
            x: (nodes[nodes.length - 1]?.x ?? 0) + (Math.random() - .5) * 80,
            y: (nodes[nodes.length - 1]?.y ?? 0) + 60 + (Math.random() - .5) * 40,
            vx: 0, vy: 0, radius: NODE_R.tool, pinned: false,
            hue: TOOL_HUE[tc.name] ?? 210,
          })
          edges.push({ id: `g${tid}`, fromId: id, toId: tid, type: 'tool' })
        })
      }
      prev = id
    } else if (m.role === 'tool') {
      const tn = nodes.find(n => n.kind === 'tool' && n.turnId === turn && n.toolName === m.name && n.durationMs == null)
      if (tn) { tn.isError = m.toolOk === false; tn.durationMs = m.durationMs }
    }
  })
  return { nodes, edges }
}

interface Particle { edgeId: string; t: number }

export class CosmosCanvas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private w = 0; private h = 0; private dpr = 1
  private animId = 0
  private sim: SimState = { nodes: new Map(), edges: [], cooled: false }
  private particles: Particle[] = []
  private zoom = 1; private ox = 0; private oy = 0
  private hoverId: string | null = null
  private selectedId: string | null = null
  private dragNode: string | null = null
  private panning = false
  private panStart = { x: 0, y: 0 }
  private onSelect: ((n: CosmosNode | null) => void) | null = null
  private ro: ResizeObserver

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas.parentElement || canvas)
    this.resize()
    this.bind()
    this.loop()
  }

  destroy() { cancelAnimationFrame(this.animId); this.ro.disconnect(); this.unbind() }
  setOnNodeSelect(cb: (n: CosmosNode | null) => void) { this.onSelect = cb }

  setNodes(nodes: CosmosNode[], edges: CosmosEdge[]) {
    const ids = new Set(nodes.map(n => n.id))
    for (const id of this.sim.nodes.keys()) if (!ids.has(id)) this.sim.nodes.delete(id)
    for (const n of nodes) {
      const old = this.sim.nodes.get(n.id)
      if (old) {
        old.content = n.content; old.isError = n.isError
        old.durationMs = n.durationMs; old.toolName = n.toolName
      } else {
        this.sim.nodes.set(n.id, { ...n })
        this.sim.cooled = false
      }
    }
    this.sim.edges = edges
    this.sim.cooled = false
    const eids = new Set(edges.map(e => e.id))
    this.particles = this.particles.filter(p => eids.has(p.edgeId))
    for (const e of edges) {
      if (!this.particles.some(p => p.edgeId === e.id)) {
        this.particles.push({ edgeId: e.id, t: Math.random() })
      }
    }
  }

  private w2s(wx: number, wy: number): [number, number] {
    return [(wx + this.ox) * this.zoom + this.w / 2, (wy + this.oy) * this.zoom + this.h / 2]
  }
  private s2w(sx: number, sy: number): [number, number] {
    return [(sx - this.w / 2) / this.zoom - this.ox, (sy - this.h / 2) / this.zoom - this.oy]
  }
  

  private bind() {
    this.canvas.addEventListener('wheel', this.onWheel)
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('pointermove', this.onMove)
    this.canvas.addEventListener('pointerup', this.onUp)
    this.canvas.addEventListener('pointerleave', this.onUp)
  }
  private unbind() {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerup', this.onUp)
    this.canvas.removeEventListener('pointerleave', this.onUp)
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.zoom = Math.max(0.1, Math.min(5, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)))
  }

  private onDown = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect()
    const [wx, wy] = this.s2w(e.clientX - r.left, e.clientY - r.top)
    for (const n of [...this.sim.nodes.values()].reverse()) {
      const dx = wx - n.x, dy = wy - n.y
      if (dx * dx + dy * dy <= n.radius * n.radius) {
        this.selectedId = n.id
        this.onSelect?.(n)
        this.dragNode = n.id
        n.pinned = true; n.vx = 0; n.vy = 0
        this.sim.cooled = false
        return
      }
    }
    this.selectedId = null; this.onSelect?.(null)
    this.panning = true; this.panStart = { x: e.clientX, y: e.clientY }
  }

  private onMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect()
    if (this.dragNode) {
      const [wx, wy] = this.s2w(e.clientX - r.left, e.clientY - r.top)
      const n = this.sim.nodes.get(this.dragNode)
      if (n) { n.x = wx; n.y = wy; n.vx = 0; n.vy = 0; n.dragged = true; this.sim.cooled = false }
      return
    }
    if (this.panning) {
      this.ox += (e.clientX - this.panStart.x) / this.zoom
      this.oy += (e.clientY - this.panStart.y) / this.zoom
      this.panStart = { x: e.clientX, y: e.clientY }
      return
    }
    const [wx, wy] = this.s2w(e.clientX - r.left, e.clientY - r.top)
    this.hoverId = null
    for (const n of this.sim.nodes.values()) {
      const dx = wx - n.x, dy = wy - n.y
      if (dx * dx + dy * dy <= n.radius * n.radius) { this.hoverId = n.id; break }
    }
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab'
  }

  private onUp = () => {
    if (this.dragNode) {
      const n = this.sim.nodes.get(this.dragNode)
      if (n) n.pinned = false
      this.dragNode = null
    }
    this.panning = false
  }

  private resize() {
    const p = this.canvas.parentElement
    if (!p) return
    this.dpr = window.devicePixelRatio || 1
    this.w = p.clientWidth; this.h = p.clientHeight
    this.canvas.width = this.w * this.dpr; this.canvas.height = this.h * this.dpr
    this.canvas.style.width = `${this.w}px`; this.canvas.style.height = `${this.h}px`
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  private loop = () => {
    tickSim(this.sim)
    this.render()
    this.animId = requestAnimationFrame(this.loop)
  }

  private render() {
    const ctx = this.ctx
    const now = performance.now()
    const isDark = !document.documentElement.dataset.theme || document.documentElement.dataset.theme === 'dark'

    ctx.fillStyle = isDark ? '#0A0E14' : '#F4F6F9'
    ctx.fillRect(0, 0, this.w, this.h)

    // 连接线
    for (const e of this.sim.edges) {
      const a = this.sim.nodes.get(e.fromId)
      const b = this.sim.nodes.get(e.toId)
      if (!a || !b) continue
      const [x1, y1] = this.w2s(a.x, a.y)
      const [x2, y2] = this.w2s(b.x, b.y)
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
      const dx = x2 - x1, dy = y2 - y1
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const cx = mx - dy / len * len * 0.1
      const cy = my + dx / len * len * 0.1
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cx, cy, x2, y2)
      if (e.type === 'cross-turn') { ctx.strokeStyle = isDark ? 'rgba(100,150,200,0.1)' : 'rgba(100,150,200,0.2)'; ctx.lineWidth = 1 }
      else if (e.type === 'tool') { ctx.strokeStyle = `hsla(${a.hue},50%,50%,0.2)`; ctx.lineWidth = 1 }
      else { ctx.strokeStyle = 'hsla(220,60%,60%,0.25)'; ctx.lineWidth = 1.5 }
      ctx.stroke()
    }

    // 流动粒子
    for (const p of this.particles) {
      const e = this.sim.edges.find(ed => ed.id === p.edgeId)
      if (!e || e.type === 'tool') continue
      const a = this.sim.nodes.get(e.fromId)
      const b = this.sim.nodes.get(e.toId)
      if (!a || !b) continue
      p.t = (p.t + 0.003) % 1
      const [x1, y1] = this.w2s(a.x, a.y)
      const [x2, y2] = this.w2s(b.x, b.y)
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
      const dx = x2 - x1, dy = y2 - y1
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const cx = mx - dy / len * len * 0.1
      const cy = my + dx / len * len * 0.1
      const t = p.t
      const px = (1-t)*(1-t)*x1 + 2*(1-t)*t*cx + t*t*x2
      const py = (1-t)*(1-t)*y1 + 2*(1-t)*t*cy + t*t*y2
      ctx.fillStyle = 'hsla(45,80%,70%,0.5)'
      ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill()
    }

    // 节点（气泡）
    for (const n of this.sim.nodes.values()) {
      const [sx, sy] = this.w2s(n.x, n.y)
      const r = n.radius * this.zoom
      if (r < 2 || sx < -r * 3 || sx > this.w + r * 3 || sy < -r * 3 || sy > this.h + r * 3) continue

      const isHover = this.hoverId === n.id
      const age = now - n.birthTime
      const birth = Math.min(1, age / 1200)
      const eased = 1 - Math.pow(1 - birth, 3)
      const er = r * eased
      if (er < 0.5) continue

      const hue = n.hue
      const sat = n.isError ? 90 : 70
      const li = isDark ? 50 : 55

      const glowR = er * (isHover ? 3.0 : 2.5)
      const glow = ctx.createRadialGradient(sx, sy, er * 0.3, sx, sy, glowR)
      glow.addColorStop(0, `hsla(${hue}, 80%, 60%, ${isHover ? 0.4 : 0.25})`)
      glow.addColorStop(1, 'transparent')
      ctx.fillStyle = glow
      ctx.beginPath(); ctx.arc(sx, sy, glowR, 0, Math.PI * 2); ctx.fill()

      if (birth < 1) {
        const pulse = Math.sin(birth * Math.PI * 2) * 0.3
        if (pulse > 0) {
          ctx.beginPath(); ctx.arc(sx, sy, er * (1 + birth * 0.8), 0, Math.PI * 2)
          ctx.strokeStyle = `hsla(${hue},80%,70%,${pulse})`; ctx.lineWidth = 2; ctx.stroke()
        }
      }

      if (n.isRunning) {
        const breath = 1 + 0.08 * Math.sin(now / 500)
        ctx.beginPath(); ctx.arc(sx, sy, er * breath * 1.3, 0, Math.PI * 2)
        ctx.strokeStyle = `hsla(${hue},80%,60%,0.2)`; ctx.lineWidth = 1.5; ctx.stroke()
      }

      const bg = ctx.createRadialGradient(sx - er * 0.3, sy - er * 0.3, 0, sx, sy, er)
      bg.addColorStop(0, `hsla(${hue},${sat}%,${li + 15}%,0.9)`)
      bg.addColorStop(1, `hsla(${hue},${sat}%,${li - 10}%,0.7)`)
      ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2)
      ctx.fillStyle = bg; ctx.fill()

      if (this.selectedId === n.id) {
        ctx.beginPath(); ctx.arc(sx, sy, er + 3, 0, Math.PI * 2)
        ctx.strokeStyle = `hsla(${hue},90%,70%,0.8)`; ctx.lineWidth = 2; ctx.stroke()
      }

      if (n.isError) {
        ctx.fillStyle = 'hsla(0,90%,60%,0.9)'
        ctx.font = `bold ${Math.max(9, er * 0.5)}px sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('✗', sx + er * 0.5, sy - er * 0.5)
      }

      if (this.zoom > 0.3) {
        if (n.kind === 'tool') {
          ctx.font = `bold ${Math.max(7, 9 * this.zoom)}px monospace`
          ctx.fillStyle = isDark ? `hsla(${hue},60%,80%,0.9)` : `hsla(${hue},50%,25%,0.9)`
          const tn = n.toolName ?? n.content
          ctx.fillText(tn.length > 8 ? tn.slice(0, 7) + '…' : tn, sx, sy)
        } else {
          const fs = Math.max(9, 11 * this.zoom)
          const maxChars = Math.floor(er * 2.2 / (fs * 0.55))
          let text = n.content
          if (text.length > maxChars) text = text.slice(0, maxChars) + '…'
          if (text) {
            ctx.font = `${fs}px -apple-system, sans-serif`
            ctx.fillStyle = isDark ? `hsla(${hue},30%,90%,0.9)` : `hsla(${hue},30%,10%,0.9)`
            ctx.fillText(text, sx, sy + er * 0.3)
          }
        }
      }

      if (n.durationMs != null && n.durationMs > 500 && this.zoom > 0.5) {
        ctx.font = `${Math.max(7, 8 * this.zoom)}px monospace`
        ctx.fillStyle = isDark ? 'rgba(200,200,200,0.3)' : 'rgba(80,80,80,0.4)'
        ctx.textAlign = 'center'
        ctx.fillText(n.durationMs < 1000 ? `${n.durationMs}ms` : `${(n.durationMs / 1000).toFixed(1)}s`, sx, sy - er - 8)
      }
    }
  }
}

export { mapSession }
