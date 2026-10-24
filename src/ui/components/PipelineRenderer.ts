/**
 * PipelineRenderer —— 垂直管道渲染器（完全重新设计）
 *
 * 设计哲学（从 Anatomy 学到的）：
 * 1. 讲一个故事：从上到下 = 从"用户想要什么"到"结果是什么"
 * 2. 每个元素有明确的语义位置
 * 3. 大小 = 重要性
 * 4. 连接 = 可trace的数据流
 * 5. 约束可见
 */

/* ═════════════════════════════════════════════════
   配色（多巴胺，在深空蓝上醒目）
   ═════════════════════════════════════════════════ */

const C = {
  bg: '#0A0E14',
  // 流程色
  user: '#FF6B9D',      // 粉红：人类意图
  think: '#FFD700',     // 金色：核心推理
  tool: '#00E5FF',      // 青色：执行
  done: '#00FF88',      // 荧光绿：完成
  error: '#FF4444',     // 鲜红：失败
  // 结构色
  pipe: '#1C2128',      // 管道壁
  pipeEdge: '#30363D',  // 管道边
  flow: '#4A9EFF',      // 数据流
  text: '#E6EDF3',
  textDim: '#9DA7B3',
  // 仪表色
  gaugeFill: '#238636',
  gaugeWarn: '#D29922',
  gaugeDanger: '#F85149',
}

/* ═════════════════════════════════════════════════
   工具图标（简洁、一眼可辨）
   ═════════════════════════════════════════════════ */

const TOOL_ICONS: Record<string, string> = {
  read_file: '📖', write_file: '✍️', edit_file: '✂️',
  run_js: '⚡', grep: '🎯', glob: '🎯', ls: '📂',
  web_fetch: '🌐', web_search: '🔎', todo_write: '📋',
  spawn_agent: '🤖', ask_user: '❓', skill: '📚',
  goal_update: '🎯', snapshot_save: '💾',
}

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧'
}

/* ═════════════════════════════════════════════════
   布局常量
   ═════════════════════════════════════════════════ */

const PIPE_W = 150        // 管道宽
const USER_H = 50         // 用户节点高
const THINK_H = 60        // 思考节点高
const TOOL_H = 36         // 工具节点高
const DONE_H = 40         // 完成节点高
const GAP_V = 8           // 垂直间距
const GAP_H = 50          // 管道间水平间距
const HEADER_H = 28       // 回合标题高
const FOOTER_H = 60       // 底部仪表高

/* ═════════════════════════════════════════════════
   数据结构
   ═════════════════════════════════════════════════ */

interface PipeTurn {
  turnId: number
  userText: string
  thinkSteps: string[]
  tools: Array<{ name: string; ok: boolean; dur: number }>
  finalText: string
}

interface PipelineData {
  turns: PipeTurn[]
  totalTokens: number
  contextUsed: number
  contextMax: number
}

function parseTurns(
  msgs: Array<{ role: string; content?: string | null; tool_calls?: Array<{ id: string; name: string }>; tool_call_id?: string; name?: string; toolOk?: boolean; durationMs?: number }>,
  folded: number,
  usage?: { total_tokens?: number },
  contextInfo?: { sentChars: number; budgetChars: number },
): PipelineData {
  const turns: PipeTurn[] = []
  let current: PipeTurn | null = null
  const toolResults = new Map<string, { ok: boolean; dur: number }>()

  for (const msg of msgs.slice(folded)) {
    if (msg.role === 'user') {
      current = { turnId: turns.length + 1, userText: (msg.content ?? '').slice(0, 30), thinkSteps: [], tools: [], finalText: '' }
      turns.push(current)
    } else if (msg.role === 'assistant' && current) {
      if (msg.tool_calls) {
        current.thinkSteps.push(`${msg.tool_calls.length} 个工具`)
        for (const tc of msg.tool_calls) current.tools.push({ name: tc.name, ok: true, dur: 0 })
      } else if (msg.content) {
        current.finalText = msg.content.slice(0, 30)
      }
    } else if (msg.role === 'tool' && current && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, { ok: msg.toolOk !== false, dur: msg.durationMs ?? 0 })
      const t = current.tools.find((tt) => !tt.dur)
      if (t) { t.ok = msg.toolOk !== false; t.dur = msg.durationMs ?? 0 }
    }
  }

  return {
    turns,
    totalTokens: usage?.total_tokens ?? 0,
    contextUsed: contextInfo?.sentChars ?? 0,
    contextMax: contextInfo?.budgetChars ?? 1,
  }
}

/* ═════════════════════════════════════════════════
   渲染器
   ═════════════════════════════════════════════════ */

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
  private t0 = performance.now()

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resize()
    this.bind()
    this.loop()
  }

  destroy() { cancelAnimationFrame(this.animId); this.unbind() }

  setData(data: PipelineData) { this.data = data; this.fit() }

  private fit() {
    if (!this.data || this.data.turns.length === 0) return
    const totalW = this.data.turns.length * (PIPE_W + GAP_H) - GAP_H
    this.zoom = Math.min(1, this.w / (totalW + 40))
    this.offsetX = 0
    this.offsetY = HEADER_H
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
  private onDown = (e: PointerEvent) => { this.panning = true; this.panStart = { x: e.clientX, y: e.clientY } }
  private onUp = () => { this.panning = false }
  private onMove = (e: PointerEvent) => {
    if (this.panning) {
      this.offsetX += e.clientX - this.panStart.x
      this.offsetY += e.clientY - this.panStart.y
      this.panStart = { x: e.clientX, y: e.clientY }
      return
    }
    this.canvas.style.cursor = 'grab'
  }

  private loop = () => { this.render(); this.animId = requestAnimationFrame(this.loop) }

  /* ════════════════════════════════════════════════
     主渲染
     ════════════════════════════════════════════════ */

  private render() {
    const ctx = this.ctx
    const now = performance.now()
    const t = (now - this.t0) / 1000

    // 背景
    ctx.fillStyle = C.bg
    ctx.fillRect(0, 0, this.w, this.h)
    if (!this.data) return

    const { turns } = this.data

    // ═══ 逐回合渲染垂直管道 ═══
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti]
      const pipeX = ti * (PIPE_W + GAP_H) + 20
      this.drawPipeline(ctx, turn, pipeX, t, now)
    }

    // ═══ 回合间的水平连接（数据流）═══
    for (let ti = 0; ti < turns.length - 1; ti++) {
      const x1 = ti * (PIPE_W + GAP_H) + 20 + PIPE_W
      const x2 = (ti + 1) * (PIPE_W + GAP_H) + 20
      const y = USER_H / 2 // 在用户节点层连接
      const [sx1, sy1] = this.w2s(x1, y)
      const [sx2, sy2] = this.w2s(x2, y)
      // 流动箭头线
      ctx.strokeStyle = C.flow + '60'
      ctx.lineWidth = 2
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(sx1 + 4, sy1)
      ctx.lineTo(sx2 - 12, sy2)
      ctx.stroke()
      // 箭头
      ctx.fillStyle = C.flow
      ctx.beginPath()
      ctx.moveTo(sx2 - 12, sy2 - 5)
      ctx.lineTo(sx2 - 4, sy2)
      ctx.lineTo(sx2 - 12, sy2 + 5)
      ctx.closePath()
      ctx.fill()
      // 流动粒子
      const pt = (t * 0.5 + ti * 0.3) % 1
      const px = sx1 + 4 + (sx2 - 12 - sx1 - 4) * pt
      ctx.fillStyle = C.flow + '90'
      ctx.beginPath(); ctx.arc(px, sy1, 3, 0, Math.PI * 2); ctx.fill()
    }

    // ═══ 底部约束条 ═══
    this.drawConstraintBar(ctx)
  }

  /* ════════════════════════════════════════════════
     单个回合的垂直管道
     ════════════════════════════════════════════════ */

  private drawPipeline(
    ctx: CanvasRenderingContext2D,
    turn: PipeTurn,
    pipeX: number,
    t: number,
    now: number,
  ) {
    const px = pipeX * this.zoom + this.offsetX
    const pw = PIPE_W * this.zoom
    let py = this.offsetY
    const gap = GAP_V * this.zoom

    // 管道背景（整体轮廓）
    const totalH = (USER_H + THINK_H + turn.tools.length * TOOL_H + (turn.finalText ? DONE_H : 0) + gap * (3 + turn.tools.length)) * this.zoom
    ctx.fillStyle = C.pipe + '60'
    ctx.strokeStyle = C.pipeEdge
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(px - 4, py - 4, pw + 8, totalH + 8, 8)
    ctx.fill()
    ctx.stroke()

    // ═══ 1. 用户节点（顶部，粉红）═══
    const uh = USER_H * this.zoom
    const userGrad = ctx.createLinearGradient(px, py, px, py + uh)
    userGrad.addColorStop(0, C.user + '30')
    userGrad.addColorStop(1, C.user + '15')
    ctx.fillStyle = userGrad
    ctx.strokeStyle = C.user + '80'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.roundRect(px, py, pw, uh, 6); ctx.fill(); ctx.stroke()
    // 文字
    ctx.fillStyle = C.user
    ctx.font = `bold ${13 * this.zoom}px -apple-system, sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('👤', px + pw / 2 - turn.userText.length * 4 * this.zoom, py + uh / 2)
    ctx.fillStyle = C.text
    ctx.font = `${11 * this.zoom}px -apple-system, sans-serif`
    ctx.fillText(turn.userText, px + pw / 2 + 10 * this.zoom, py + uh / 2)
    py += uh + gap

    // ═══ 2. 思考节点（中上，金色，最大）═══
    const th = THINK_H * this.zoom
    const thinkGrad = ctx.createLinearGradient(px, py, px, py + th)
    thinkGrad.addColorStop(0, C.think + '25')
    thinkGrad.addColorStop(1, C.think + '10')
    ctx.fillStyle = thinkGrad
    ctx.strokeStyle = C.think + '70'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.roundRect(px, py, pw, th, 6); ctx.fill(); ctx.stroke()
    // 旋转齿轮
    const gearR = 16 * this.zoom
    const gx = px + pw / 2, gy = py + th * 0.4
    ctx.save(); ctx.translate(gx, gy); ctx.rotate(now / 1500)
    ctx.strokeStyle = C.think + '90'
    ctx.lineWidth = 2
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * gearR * 0.5, Math.sin(a) * gearR * 0.5)
      ctx.lineTo(Math.cos(a) * gearR, Math.sin(a) * gearR)
      ctx.stroke()
    }
    ctx.beginPath(); ctx.arc(0, 0, gearR * 0.5, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
    // 标签
    ctx.fillStyle = C.think
    ctx.font = `${10 * this.zoom}px -apple-system, sans-serif`
    ctx.fillText('推理', gx, py + th * 0.85)
    py += th + gap

    // ═══ 3. 工具节点序列（垂直排列）═══
    for (const tool of turn.tools) {
      const toolH = TOOL_H * this.zoom
      const toolColor = tool.ok ? C.tool : C.error
      // 工具行背景
      ctx.fillStyle = toolColor + '15'
      ctx.strokeStyle = toolColor + '50'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(px + 10 * this.zoom, py, pw - 20 * this.zoom, toolH, 4); ctx.fill(); ctx.stroke()
      // 工具图标
      ctx.font = `${14 * this.zoom}px sans-serif`
      ctx.textAlign = 'left'
      ctx.fillText(toolIcon(tool.name), px + 18 * this.zoom, py + toolH / 2)
      // 工具名
      ctx.fillStyle = C.textDim
      ctx.font = `${10 * this.zoom}px monospace`
      ctx.fillText(tool.name, px + 38 * this.zoom, py + toolH / 2)
      // 状态 + 耗时
      const statusIcon = tool.ok ? '✓' : '✗'
      ctx.fillStyle = tool.ok ? C.done : C.error
      ctx.font = `${10 * this.zoom}px sans-serif`
      ctx.textAlign = 'right'
      const durText = tool.dur > 500 ? `${(tool.dur / 1000).toFixed(1)}s` : ''
      ctx.fillText(`${statusIcon} ${durText}`, px + pw - 18 * this.zoom, py + toolH / 2)
      py += toolH + gap * 0.5
    }
    py += gap * 0.5

    // ═══ 4. 完成节点（底部，绿色）═══
    if (turn.finalText) {
      const dh = DONE_H * this.zoom
      ctx.fillStyle = C.done + '20'
      ctx.strokeStyle = C.done + '70'
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.roundRect(px, py, pw, dh, 6); ctx.fill(); ctx.stroke()
      ctx.fillStyle = C.done
      ctx.font = `${12 * this.zoom}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(`✅ ${turn.finalText}`, px + pw / 2, py + dh / 2)
    }
  }

  /* ════════════════════════════════════════════════
     底部约束条（上下文 + Token）
     ════════════════════════════════════════════════ */

  private drawConstraintBar(ctx: CanvasRenderingContext2D) {
    if (!this.data) return
    const barY = this.h - FOOTER_H
    const barH = FOOTER_H - 20
    const barW = Math.min(this.w - 40, 500)
    const barX = (this.w - barW) / 2

    // 背景面板
    ctx.fillStyle = C.pipe + '90'
    ctx.strokeStyle = C.pipeEdge
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 6); ctx.fill(); ctx.stroke()

    // 上下文液位
    const ctxRatio = Math.min(this.data.contextUsed / this.data.contextMax, 1)
    const ctxColor = ctxRatio > 0.8 ? C.gaugeDanger : ctxRatio > 0.6 ? C.gaugeWarn : C.gaugeFill
    const bar1Y = barY + 12
    const bar1H = 8
    // 标签
    ctx.fillStyle = C.textDim
    ctx.font = '9px monospace'
    ctx.textAlign = 'left'
    ctx.fillText('Context', barX + 10, bar1Y - 2)
    // 进度条
    ctx.fillStyle = C.pipeEdge
    ctx.beginPath(); ctx.roundRect(barX + 70, bar1Y, barW - 180, bar1H, 2); ctx.fill()
    ctx.fillStyle = ctxColor + '80'
    ctx.beginPath(); ctx.roundRect(barX + 70, bar1Y, (barW - 180) * ctxRatio, bar1H, 2); ctx.fill()
    // 百分比
    ctx.fillStyle = ctxColor
    ctx.fillText(`${Math.round(ctxRatio * 100)}%`, barX + barW - 100, bar1Y + bar1H - 1)

    // Token 燃料
    const tokenY = bar1Y + bar1H + 10
    ctx.fillStyle = C.textDim
    ctx.fillText('Token', barX + 10, tokenY - 2)
    ctx.fillStyle = C.flow + '60'
    const tokenRatio = Math.min(this.data.totalTokens / 100000, 1)
    ctx.beginPath(); ctx.roundRect(barX + 70, tokenY, (barW - 180) * tokenRatio, bar1H, 2); ctx.fill()
    ctx.fillStyle = C.flow
    ctx.fillText(`${this.data.totalTokens.toLocaleString()}`, barX + barW - 100, tokenY + bar1H - 1)
  }
}

/* 导出解析函数供 React 组件使用 */
export { parseTurns, type PipelineData, type PipeTurn }
