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

const TOOL_DESC: Record<string, string> = {
  read_file: '读取文件', write_file: '写入文件', edit_file: '修改文件',
  run_js: '执行代码', grep: '搜索', glob: '匹配', ls: '列目录',
  web_fetch: '抓取网页', web_search: '搜索', skill: '装载技能',
  spawn_agent: '派生子代理', ask_user: '询问', snapshot_save: '保存快照',
}

const PIPE_W = 300; const USER_H = 70; const THINK_H = 90
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
  private offsetX = 0; private offsetY = 0
  private panning = false
  private panStart = { x: 0, y: 0 }
  private expandedFolds = new Set<string>()
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
    const maxTools = Math.max(...this.data.turns.map(t => t.tools.length), 1)
    const contentW = this.data.turns.length * (PIPE_W + GAP_H) - GAP_H
    const contentH = USER_H + THINK_H + maxTools * (TOOL_H + GAP_V * 0.5) + DONE_H + GAP_V * 4
    const fit = fitToViewport(contentW, contentH, this.w, this.h - FOOTER_H, 1.0, 20, 0.55)
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
        if (this.expandedFolds.has(item.key)) {
          this.expandedFolds.delete(item.key)
        } else {
          this.expandedFolds.add(item.key)
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

    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti]
      const pipeX = ti * (PIPE_W + GAP_H) + 20
      const tAlpha = temporalAlpha(ti, turns.length) * (turn.isPreCompact ? 0.5 : 1.0)
      ctx.globalAlpha = tAlpha
      this.drawPipeline(ctx, turn, pipeX, now)
      ctx.globalAlpha = 1
    }

    // 回合间连接
    for (let ti = 0; ti < turns.length - 1; ti++) {
      const x1 = ti * (PIPE_W + GAP_H) + 20 + PIPE_W
      const x2 = (ti + 1) * (PIPE_W + GAP_H) + 20
      const y = USER_H / 2
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
    const pw = PIPE_W * this.zoom
    let py = this.offsetY
    const gap = GAP_V * this.zoom

    // 计算实际渲染的工具行数（考虑展开状态）
    const isExpanded = (toolIdx: number) => this.expandedFolds.has(`${turn.turnId}:${toolIdx}`)
    const visibleRows = turn.tools.reduce((sum, tool, idx) => {
      if (tool.folded && isExpanded(idx)) return sum + 1 + (tool.count ?? 1) // 标题行 + 每个调用
      return sum + 1
    }, 0)

    // 底座
    const totalH = (USER_H + THINK_H + visibleRows * TOOL_H + (turn.finalText ? DONE_H : 0) + gap * (3 + visibleRows)) * this.zoom
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
    ctx.fillText(`Turn ${turn.turnId}`, px + pw * 0.22, py + uh * 0.72)
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
    const totalCalls = turn.tools.reduce((s, t) => s + (t.count ?? 1), 0)
    ctx.fillText(`${totalCalls} 次调用`, px + pw * 0.5, py + th * 0.55)
    if (turn.finalText) {
      ctx.fillStyle = C.done + '80'
      ctx.fillText(turn.finalText, px + pw * 0.5, py + th * 0.78)
    }
    py += th + gap

    // ═══ 工具列表（含折叠/展开交互）═══
    for (let toolIdx = 0; toolIdx < turn.tools.length; toolIdx++) {
      const tool = turn.tools[toolIdx]
      const key = `${turn.turnId}:${toolIdx}`
      const expanded = this.expandedFolds.has(key)

      if (tool.folded && !expanded) {
        // ═══ 折叠状态 ═══
        const toolH = TOOL_H * this.zoom
        drawPanel(ctx, px + 16 * this.zoom, py, pw - 32 * this.zoom, toolH, {
          hue: 190, sat: 60, light: 18, depth: 2 * this.zoom
        }, now, { screws: false, glowAlpha: 0.03 })

        // 图标
        ctx.font = `${18 * this.zoom}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
        ctx.fillText(toolIcon(tool.name), px + 24 * this.zoom, py + toolH / 2)

        // 折叠名称："run_js ×5"（加粗+青色）
        ctx.fillStyle = C.tool
        ctx.font = `bold ${14 * this.zoom}px ui-monospace, monospace`
        ctx.textBaseline = 'alphabetic'
        drawTextSafe(ctx, `${tool.name} ×${tool.count}`, px + 52 * this.zoom, py + toolH * 0.38, pw - 140 * this.zoom, 'left')

        // 描述
        ctx.fillStyle = C.tool + '70'
        ctx.font = `${10 * this.zoom}px sans-serif`
        drawTextSafe(ctx, `${tool.count} 次连续调用`, px + 52 * this.zoom, py + toolH * 0.72, pw - 140 * this.zoom, 'left')

        // ▸ 展开按钮（大且明显）
        ctx.fillStyle = C.tool + '90'
        ctx.font = `bold ${13 * this.zoom}px sans-serif`
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
        ctx.fillText('▸ 展开', px + pw - 50 * this.zoom, py + toolH / 2)

        // 状态灯
        const lightX = px + pw - 110 * this.zoom
        ctx.fillStyle = C.done + '90'
        ctx.beginPath(); ctx.arc(lightX, py + toolH / 2, 5 * this.zoom, 0, Math.PI * 2); ctx.fill()

        // 注册点击区域
        this.hitItems.push({
          key, x: px + 16 * this.zoom, y: py,
          w: pw - 32 * this.zoom, h: toolH,
        })

        py += toolH + gap * 0.5
      } else if (tool.folded && expanded) {
        // ═══ 展开状态 ═══
        const count = tool.count ?? 1

        // 标题行（点击收起）
        const headerH = 32 * this.zoom
        ctx.fillStyle = C.tool + '20'
        ctx.strokeStyle = C.tool + '50'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.roundRect(px + 16 * this.zoom, py, pw - 32 * this.zoom, headerH, 4); ctx.fill(); ctx.stroke()

        ctx.fillStyle = C.tool
        ctx.font = `bold ${12 * this.zoom}px sans-serif`
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
        ctx.fillText(`${toolIcon(tool.name)} ${tool.name}`, px + 28 * this.zoom, py + headerH / 2)

        ctx.fillStyle = C.tool + '80'
        ctx.font = `${11 * this.zoom}px sans-serif`
        ctx.textAlign = 'right'
        ctx.fillText(`▾ 收起 (${count} 个)`, px + pw - 50 * this.zoom, py + headerH / 2)

        // 注册标题行点击
        this.hitItems.push({
          key, x: px + 16 * this.zoom, y: py,
          w: pw - 32 * this.zoom, h: headerH,
        })
        py += headerH + gap * 0.3

        // 每个调用
        for (let ci = 0; ci < count; ci++) {
          const callH = TOOL_H * 0.75 * this.zoom
          ctx.fillStyle = 'rgba(0,229,255,0.06)'
          ctx.strokeStyle = 'rgba(0,229,255,0.15)'; ctx.lineWidth = 0.5
          ctx.beginPath(); ctx.roundRect(px + 24 * this.zoom, py, pw - 48 * this.zoom, callH, 3); ctx.fill(); ctx.stroke()

          ctx.textBaseline = 'middle'
          // 序号
          ctx.fillStyle = C.textDim; ctx.font = `${9 * this.zoom}px monospace`; ctx.textAlign = 'left'
          ctx.fillText(`#${ci + 1}`, px + 32 * this.zoom, py + callH / 2)
          // 图标
          ctx.font = `${12 * this.zoom}px sans-serif`
          ctx.fillText(toolIcon(tool.name), px + 62 * this.zoom, py + callH / 2)
          // 名称
          ctx.fillStyle = C.text; ctx.font = `${10 * this.zoom}px monospace`
          ctx.fillText(tool.name, px + 82 * this.zoom, py + callH / 2)
          // 状态
          ctx.fillStyle = tool.ok ? C.done : C.error
          ctx.textAlign = 'right'
          ctx.fillText(tool.ok ? '✓' : '✗', px + pw - 50 * this.zoom, py + callH / 2)

          py += callH + gap * 0.2
        }
        py += gap * 0.3
      } else {
        // ═══ 普通单个工具 ═══
        const toolH = TOOL_H * this.zoom
        const toolHue = tool.ok ? 190 : 0
        drawPanel(ctx, px + 16 * this.zoom, py, pw - 32 * this.zoom, toolH, {
          hue: toolHue, sat: tool.ok ? 60 : 90, light: tool.ok ? 15 : 30, depth: 2 * this.zoom
        }, now, { screws: this.zoom > 0.6 })

        ctx.font = `${18 * this.zoom}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
        ctx.fillText(toolIcon(tool.name), px + 24 * this.zoom, py + toolH / 2)

        ctx.fillStyle = tool.ok ? C.text : '#FF6666'
        ctx.font = `${13 * this.zoom}px ui-monospace, monospace`
        ctx.textBaseline = 'alphabetic'
        drawTextSafe(ctx, tool.ok ? tool.name : `⚠ ${tool.name}`, px + 52 * this.zoom, py + toolH * 0.38, pw - 140 * this.zoom, 'left')

        ctx.fillStyle = tool.ok ? C.textDim + '90' : '#FF8888'
        ctx.font = `${10 * this.zoom}px sans-serif`
        drawTextSafe(ctx, tool.ok ? (tool.desc || '') : '执行失败', px + 52 * this.zoom, py + toolH * 0.72, pw - 140 * this.zoom, 'left')

        // 状态灯 + 耗时
        const lightX = px + pw - 36 * this.zoom
        const lightY = py + toolH / 2
        ctx.fillStyle = tool.ok ? C.done + '90' : C.error
        ctx.beginPath(); ctx.arc(lightX, lightY, 5 * this.zoom, 0, Math.PI * 2); ctx.fill()
        if (tool.dur > 0) {
          ctx.fillStyle = C.textDim; ctx.font = `${10 * this.zoom}px monospace`; ctx.textAlign = 'right'
          const durText = tool.dur > 1000 ? `${(tool.dur / 1000).toFixed(1)}s` : `${tool.dur}ms`
          ctx.fillText(durText, lightX - 12 * this.zoom, py + toolH * 0.72)
        }

        py += toolH + gap * 0.5
      }
    }
    py += gap * 0.5

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
