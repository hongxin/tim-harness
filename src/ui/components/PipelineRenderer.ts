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

const PIPE_W_MAX = 300; const PIPE_W_MIN = 140; const USER_H = 70; const THINK_H = 90
const TOOL_H = 52; const DONE_H = 56; const GAP_V = 14; const GAP_H = 60
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
        userText: (msg.content ?? '').slice(0, 40),
        thinkSteps: [], tools: [], finalText: '',
        isPreCompact: mi < folded,
      }
      turns.push(current)
    } else if (msg.role === 'assistant' && current) {
      if (msg.tool_calls) {
        current.thinkSteps.push(`${msg.tool_calls.length} tools`)
        for (const tc of msg.tool_calls) {
          current.tools.push({ name: tc.name, ok: true, dur: 0, desc: TOOL_DESC[tc.name] ?? '' })
        }
      } else if (msg.content) {
        current.finalText = msg.content.slice(0, 30)
      }
    } else if (msg.role === 'tool' && current) {
      const t = current.tools.find((tt) => tt.name === msg.name && !tt.dur)
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
    const maxPerRow = Math.max(2, Math.floor(availW / (PIPE_W_MIN + GAP_H)))
    const perRow = Math.min(nTurns, maxPerRow)
    const nRows = Math.ceil(nTurns / perRow)
    this.pipeW = Math.min(PIPE_W_MAX, Math.max(PIPE_W_MIN, (availW - (perRow - 1) * GAP_H) / perRow))
        this.rowHeight = USER_H + THINK_H + 50 + DONE_H + GAP_V * 4 + 20
    const contentW = perRow * (this.pipeW + GAP_H) - GAP_H
    const contentH = nRows * this.rowHeight
    const fit = fitToViewport(contentW, contentH, this.w, this.h - FOOTER_H, 1.0, 20, 0.45)
    this.zoom = fit.zoom
    this.offsetX = fit.offsetX
    this.offsetY = fit.offsetY
  }

  private w2s(wx: number, wy: number): [number, number] {
    return [wx * this.zoom + this.offsetX, wy * this.zoom + this.offsetY]
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

    this.panning = true
    this.panStart = { x: e.clientX, y: e.clientY }
  }

  private onUp = () => { this.panning = false }
  private onMove = (e: PointerEvent) => {
    if (this.panning) {
      this.offsetX += e.clientX - this.panStart.x
      this.offsetY += e.clientY - this.panStart.y
      this.panStart = { x: e.clientX, y: e.clientY }
      return
    }
    const r = this.canvas.getBoundingClientRect()
    const sx = e.clientX - r.left, sy = e.clientY - r.top
    let hovering = false
    for (const item of this.hitItems) {
      if (sx >= item.x && sx <= item.x + item.w && sy >= item.y && sy <= item.y + item.h) {
        hovering = true; break
      }
    }
    this.canvas.style.cursor = hovering ? 'pointer' : 'grab'
  }

  private loop = () => { this.render(); this.animId = requestAnimationFrame(this.loop) }

  private render() {
    const ctx = this.ctx
    const now = performance.now()

    ctx.fillStyle = C.bg
    ctx.fillRect(0, 0, this.w, this.h)
    if (!this.data) return

    this.hitItems = []
    const { turns } = this.data

    // 换行排列：每行最多 maxPerRow 个管道
    const maxPerRow = Math.max(2, Math.floor((this.w - 40) / (this.pipeW + GAP_H)))
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti]
      const row = Math.floor(ti / maxPerRow)
      const col = ti % maxPerRow
      const pipeX = col * (this.pipeW + GAP_H) + 20
      // 每行有自己的 Y 偏移
      const rowH = this.rowHeight * this.zoom + 20
      const pipeYOffset = row * rowH
      const tAlpha = temporalAlpha(ti, turns.length) * (turn.isPreCompact ? 0.7 : 1.0)
      ctx.globalAlpha = tAlpha
      ctx.save()
      ctx.translate(0, pipeYOffset)
      this.drawPipeline(ctx, turn, pipeX, now)
      ctx.restore()
      ctx.globalAlpha = 1
    }

    // 回合间连接（考虑换行：同行水平连，跨行跳过）
    for (let ti = 0; ti < turns.length - 1; ti++) {
      const row1 = Math.floor(ti / maxPerRow)
      const col1 = ti % maxPerRow
      const row2 = Math.floor((ti + 1) / maxPerRow)
      const col2 = (ti + 1) % maxPerRow
      
      if (row1 !== row2) continue // 跨行不画连接线
      
      const x1 = col1 * (this.pipeW + GAP_H) + 20 + this.pipeW
      const x2 = col2 * (this.pipeW + GAP_H) + 20
      const y = USER_H / 2 + row1 * (this.rowHeight * this.zoom + 20)
      const [sx1, sy1] = this.w2s(x1, y)
      const [sx2, sy2] = this.w2s(x2, y)
      ctx.strokeStyle = C.flow + '50'; ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(sx1 + 4, sy1); ctx.lineTo(sx2 - 4, sy2); ctx.stroke()
      ctx.strokeStyle = C.flow + '80'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(sx1 + 4, sy1); ctx.lineTo(sx2 - 4, sy2); ctx.stroke()
      const pt = (now / 800 + ti * 0.33) % 1
      const px = sx1 + 4 + (sx2 - 8 - sx1) * pt
      ctx.fillStyle = C.flow
      ctx.beginPath(); ctx.arc(px, sy1, 3, 0, Math.PI * 2); ctx.fill()
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
    ctx.fillText('推理', px + pw * 0.5, py + th * 0.3)
    ctx.fillStyle = C.textDim; ctx.font = `${11 * this.zoom}px sans-serif`
    if (turn.finalText) {
      ctx.fillStyle = C.done + '80'
      ctx.fillText(turn.finalText, px + pw * 0.5, py + th * 0.78)
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
        const icon = TOOL_CATEGORY[t.name]?.icon ?? '\u{1F527}'
        const n = t.count ?? 1
        const ex = catMap.get(cat)
        if (ex) ex.count += n
        else catMap.set(cat, { count: n, icon })
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

  private drawFooter(ctx: CanvasRenderingContext2D, now: number) {
    if (!this.data) return
    const barY = this.h - FOOTER_H
    const barW = Math.min(this.w - 40, 500)
    const barX = (this.w - barW) / 2

    drawPanel(ctx, barX - 5, barY, barW + 10, FOOTER_H - 10, {
      hue: 220, sat: 12, light: 10, depth: 3
    }, now, { screws: false })

    const ctxRatio = Math.min(this.data.contextUsed / this.data.contextMax, 1)
    drawGauge(ctx, barX + 40, barY + 25, 18, Math.round(ctxRatio * 100), 100, 'Ctx', 140, now)

    ctx.fillStyle = C.text; ctx.font = 'bold 16px ui-monospace, monospace'; ctx.textAlign = 'center'
    ctx.fillText(this.data.totalTokens.toLocaleString(), barX + barW * 0.5, barY + 22)
    ctx.fillStyle = C.textDim; ctx.font = '9px monospace'
    ctx.fillText('tokens', barX + barW * 0.5, barY + 34)
    if (this.data.totalTokens > 0) {
      const cost = this.data.totalTokens * 0.0000014
      ctx.fillStyle = C.textDim + '80'
      ctx.fillText(`≈ ¥${cost.toFixed(4)}`, barX + barW * 0.5, barY + 46)
    }

    const tlX = barX + barW - 120, tlW = 100, tlY = barY + 18
    let inputT = 0, thinkT = 0, toolT = 0
    for (const turn of this.data.turns) {
      inputT += 50; thinkT += 200
      for (const t of turn.tools) toolT += t.dur * (t.count ?? 1)
    }
    const total = Math.max(inputT + thinkT + toolT, 1)
    let segX = tlX
    for (const [label, time, color] of [
      ['I', inputT, C.user], ['T', thinkT, C.think], ['W', toolT, C.tool],
    ] as const) {
      const segW = (time / total) * tlW
      if (segW > 3) {
        ctx.fillStyle = color + '50'
        ctx.beginPath(); ctx.roundRect(segX, tlY, segW - 1, 6, 2); ctx.fill()
        if (segW > 15) {
          ctx.fillStyle = color + '80'; ctx.font = '7px monospace'; ctx.textAlign = 'center'
          ctx.fillText(label, segX + segW / 2, tlY + 14)
        }
      }
      segX += segW
    }
    ctx.fillStyle = C.textDim + '60'; ctx.font = '8px monospace'; ctx.textAlign = 'left'
    ctx.fillText('⏱', tlX - 12, tlY + 6)
    ctx.textAlign = 'right'
    ctx.fillText(`${total}ms`, tlX + tlW + 5, tlY + 6)
  }
}

export { parseTurns, type PipelineData, type PipeTurn, type ToolItem }
