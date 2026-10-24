import { drawTextSafe, temporalAlpha, foldRepeats, fitToViewport } from './LayoutGuard'
import { drawPanel, drawGauge, drawRail } from './PhysicalParts'
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

const TOOL_DESC: Record<string, string> = {
  read_file: '读取文件内容', write_file: '写入新文件', edit_file: '修改已有文件',
  run_js: '沙箱执行代码', grep: '搜索匹配模式', glob: '文件模式匹配',
  ls: '列出目录', web_fetch: '抓取网页', web_search: '网络搜索',
  skill: '装载领域技能', spawn_agent: '派生子代理', ask_user: '询问用户',
  todo_write: '更新任务清单', goal_update: '更新目标状态',
  snapshot_save: '保存快照', snapshot_restore: '恢复快照',
}

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧'
}

/* ═════════════════════════════════════════════════
   布局常量
   ═════════════════════════════════════════════════ */

const PIPE_W = 300        // 管道宽
const USER_H = 70         // 用户节点高
const THINK_H = 90        // 思考节点高
const TOOL_H = 52         // 工具节点高
const DONE_H = 56         // 完成节点高
const GAP_V = 14           // 垂直间距
const GAP_H = 60          // 管道间水平间距
const HEADER_H = 28       // 回合标题高
const FOOTER_H = 60       // 底部仪表高

/* ═════════════════════════════════════════════════
   数据结构
   ═════════════════════════════════════════════════ */

interface PipeTurn {
  turnId: number
  userText: string
  thinkSteps: string[]
  tools: Array<{ name: string; ok: boolean; dur: number; desc?: string }>
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
        for (const tc of msg.tool_calls) current.tools.push({ name: tc.name, ok: true, dur: 0, desc: TOOL_DESC[tc.name] ?? '' })
      } else if (msg.content) {
        current.finalText = msg.content.slice(0, 30)
      }
    } else if (msg.role === 'tool' && current && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, { ok: msg.toolOk !== false, dur: msg.durationMs ?? 0 })
      const t = current.tools.find((tt) => !tt.dur)
      if (t) { t.ok = msg.toolOk !== false; t.dur = msg.durationMs ?? 0 }
    }
  }

  // 应用重复折叠（R5）
  for (const turn of turns) {
    turn.tools = foldRepeats(turn.tools) as typeof turn.tools
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
    const maxTools = Math.max(...this.data.turns.map(t => t.tools.length), 1)
    // 总宽度：含边距（每管道 ±10px 底座 + 首尾 30px padding）
    const contentW = this.data.turns.length * (PIPE_W + GAP_H) - GAP_H
    const contentH = HEADER_H + USER_H + THINK_H + maxTools * (TOOL_H + GAP_V * 0.5) + DONE_H + GAP_V * 4
    const fit = fitToViewport(contentW, contentH, this.w, this.h - FOOTER_H, 1.0, 20)
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
      const tAlpha = temporalAlpha(ti, turns.length)
      ctx.globalAlpha = tAlpha
      this.drawPipeline(ctx, turn, pipeX, t, now)
      ctx.globalAlpha = 1
    }

    // ═══ 回合间的水平连接（数据流）═══
    for (let ti = 0; ti < turns.length - 1; ti++) {
      const x1 = ti * (PIPE_W + GAP_H) + 20 + PIPE_W
      const x2 = (ti + 1) * (PIPE_W + GAP_H) + 20
      const y = USER_H / 2 // 在用户节点层连接
      const [sx1, sy1] = this.w2s(x1, y)
      const [sx2, sy2] = this.w2s(x2, y)
      // 流动箭头线
      // 物理管道连接（带法兰和流动粒子）
      ctx.strokeStyle = 'rgba(74, 158, 255, 0.4)'
      ctx.lineWidth = 5
      ctx.beginPath()
      ctx.moveTo(sx1 + 4, sy1)
      ctx.lineTo(sx2 - 4, sy2)
      ctx.stroke()
      // 内壁亮线
      ctx.strokeStyle = 'rgba(74, 158, 255, 0.7)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(sx1 + 4, sy1)
      ctx.lineTo(sx2 - 4, sy2)
      ctx.stroke()
      // 法兰（两端圆形接口）
      for (const [fx, fy] of [[sx1 + 4, sy1], [sx2 - 4, sy2]]) {
        ctx.fillStyle = 'rgba(74, 158, 255, 0.3)'
        ctx.beginPath(); ctx.arc(fx, fy, 4, 0, Math.PI * 2); ctx.fill()
      }
      // 流动粒子
      const pt = (t * 0.4 + ti * 0.33) % 1
      const px2 = sx1 + 4 + (sx2 - 8 - sx1) * pt
      ctx.fillStyle = '#4A9EFF'
      ctx.beginPath(); ctx.arc(px2, sy1, 3, 0, Math.PI * 2); ctx.fill()
      // 连接标签
      if (this.zoom > 0.5) {
        ctx.fillStyle = C.textDim + '50'
        ctx.font = `${9 * this.zoom}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('→', (sx1 + sx2) / 2, sy1 - 8)
      }
      
    }

    // ═══ 底部约束条 ═══
    this.drawConstraintBar(ctx)
    this.drawTimeline(ctx)
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

    // 底座面板（物理感：整个回合坐在这个底座上）
    const totalH = (USER_H + THINK_H + turn.tools.length * TOOL_H + (turn.finalText ? DONE_H : 0) + gap * (3 + turn.tools.length)) * this.zoom
    drawPanel(ctx, px - 10, py - 8, pw + 20, totalH + 16, {
      hue: 220, sat: 15, light: 10, depth: 4 * this.zoom
    }, now, { screws: true })
    // 导轨（工具面板沿此导轨排列）
    if (turn.tools.length > 0) {
      const railY = py + (USER_H + THINK_H + GAP_V * 2.5) * this.zoom
      drawRail(ctx, px + 8, railY, px + pw - 8, railY, 210)
    }

    // ═══ 1. 用户节点（顶部，粉红）═══
    const uh = USER_H * this.zoom
    drawPanel(ctx, px, py, pw, uh, {
      hue: 340, sat: 70, light: 20, depth: 3 * this.zoom
    }, now, { screws: true, glowAlpha: 0.05 })
    // 文字
    ctx.fillStyle = C.user
    ctx.font = `bold ${16 * this.zoom}px -apple-system, sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('👤', px + pw / 2 - turn.userText.length * 4 * this.zoom, py + uh / 2)
    ctx.fillStyle = C.text
    ctx.font = `${14 * this.zoom}px -apple-system, sans-serif`
    ctx.textAlign = 'left'
    drawTextSafe(ctx, turn.userText, px + pw / 2 + 10 * this.zoom, py + uh * 0.38, pw * 0.4, 'left')
    // 副标签（回合编号）
    ctx.fillStyle = C.textDim
    ctx.font = `${10 * this.zoom}px monospace`
    ctx.fillText(`Turn ${turn.turnId}`, px + pw / 2 + 10 * this.zoom, py + uh * 0.72)
    py += uh + gap
    // 分隔线
    if (this.zoom > 0.5) {
      ctx.strokeStyle = C.pipeEdge + '40'
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(px + 20 * this.zoom, py - gap * 0.5)
      ctx.lineTo(px + pw - 20 * this.zoom, py - gap * 0.5)
      ctx.stroke()
    }

    // ═══ 2. 思考节点（中上，金色，最大）═══
    const th = THINK_H * this.zoom
    drawPanel(ctx, px, py, pw, th, {
      hue: 45, sat: 90, light: 22, depth: 3 * this.zoom
    }, now, { screws: true, glowAlpha: 0.08 })
    // 大齿轮 + 反向小齿轮（Anatomy 咬合感）
    const gearR = 26 * this.zoom
    const gx = px + pw * 0.38, gy = py + th * 0.42
    // 大齿轮
    ctx.save(); ctx.translate(gx, gy); ctx.rotate(now / 1200)
    ctx.strokeStyle = C.think + '90'
    ctx.lineWidth = 2
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * gearR * 0.55, Math.sin(a) * gearR * 0.55)
      ctx.lineTo(Math.cos(a) * gearR, Math.sin(a) * gearR)
      ctx.stroke()
    }
    ctx.beginPath(); ctx.arc(0, 0, gearR * 0.55, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(0, 0, gearR * 0.15, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
    // 小齿轮（反向）
    const sgx = px + pw * 0.68, sgy = py + th * 0.55
    const sgR = gearR * 0.5
    ctx.save(); ctx.translate(sgx, sgy); ctx.rotate(-now / 700)
    ctx.strokeStyle = C.think + '60'
    ctx.lineWidth = 1.5
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * sgR * 0.5, Math.sin(a) * sgR * 0.5)
      ctx.lineTo(Math.cos(a) * sgR, Math.sin(a) * sgR)
      ctx.stroke()
    }
    ctx.beginPath(); ctx.arc(0, 0, sgR * 0.5, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
    // 标签
    ctx.fillStyle = C.think
    ctx.font = `${14 * this.zoom}px -apple-system, sans-serif`
    ctx.fillText('推理', px + pw * 0.15, py + th * 0.3)
    // 策略描述
    ctx.fillStyle = C.textDim
    ctx.font = `${11 * this.zoom}px -apple-system, sans-serif`
    const stepCount = turn.tools.length
    ctx.fillText(`${stepCount} 步 · ${turn.thinkSteps.length} 次决策`, px + pw * 0.15, py + th * 0.55)
    if (turn.finalText) {
      ctx.fillStyle = C.done + '80'
      ctx.fillText(turn.finalText, px + pw * 0.15, py + th * 0.78)
    }
    py += th + gap

    // ═══ 3. 工具节点序列（垂直排列）═══
    for (const tool of turn.tools) {
      const toolH = TOOL_H * this.zoom
      // 工具行背景
      const toolHue = tool.ok ? 190 : 0
      const toolSat = tool.ok ? 60 : 90
      const toolLight = tool.ok ? 15 : 30
      drawPanel(ctx, px + 16 * this.zoom, py, pw - 32 * this.zoom, toolH, {
        hue: toolHue, sat: toolSat, light: toolLight, depth: 2 * this.zoom
      }, now, { screws: this.zoom > 0.6, glowAlpha: tool.ok ? 0 : 0.15 })
      // 失败时加红色边框闪烁
      if (!tool.ok) {
        const blink = 0.4 + 0.3 * Math.sin(now / 300)
        ctx.strokeStyle = `rgba(255, 68, 68, ${blink})`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.roundRect(px + 16 * this.zoom - 1, py - 1, pw - 32 * this.zoom + 2, toolH + 2, 4)
        ctx.stroke()
      }
      // 工具图标
      ctx.font = `${18 * this.zoom}px sans-serif`
      ctx.textAlign = 'left'
      ctx.fillText(toolIcon(tool.name), px + 24 * this.zoom, py + toolH / 2)
      // 工具名
      // 名称（第一行，稍大）
      ctx.fillStyle = tool.ok ? C.text : '#FF6666'
      ctx.font = `${13 * this.zoom}px ui-monospace, monospace`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      // 失败工具加警告前缀
      drawTextSafe(ctx, tool.ok ? tool.name : `⚠ ${tool.name}`, px + 50 * this.zoom, py + toolH * 0.38, pw - 120 * this.zoom, 'left')
      // 描述（第二行，更小更淡）
      if (tool.desc) {
        ctx.fillStyle = tool.ok ? C.textDim + '90' : '#FF8888'
        ctx.font = `${10 * this.zoom}px -apple-system, sans-serif`
        drawTextSafe(ctx, tool.ok ? (tool.desc || '') : '执行失败', px + 50 * this.zoom, py + toolH * 0.72, pw - 120 * this.zoom, 'left')
      }
      // 状态指示灯（圆形，非文字符号）
      const statusColor = tool.ok ? C.done : C.error
      const lightR = 5 * this.zoom
      const lightX = px + pw - 36 * this.zoom
      const lightY = py + toolH / 2
      if (!tool.ok) {
        // 失败：闪烁
        const blink = Math.sin(now / 200) > 0
        ctx.fillStyle = blink ? C.error : C.error + '40'
      } else {
        ctx.fillStyle = statusColor + '90'
      }
      ctx.beginPath(); ctx.arc(lightX, lightY, lightR, 0, Math.PI * 2); ctx.fill()
      // 光晕
      ctx.fillStyle = statusColor + '20'
      ctx.beginPath(); ctx.arc(lightX, lightY, lightR * 1.8, 0, Math.PI * 2); ctx.fill()
      // 耗时（右对齐，第二行位置）
      if (tool.dur > 0) {
        ctx.fillStyle = C.textDim
        ctx.font = `${10 * this.zoom}px monospace`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'alphabetic'
        const durText = tool.dur > 1000 ? `${(tool.dur / 1000).toFixed(1)}s` : `${tool.dur}ms`
        ctx.fillText(durText, lightX - 10 * this.zoom, py + toolH * 0.72)
        // 状态文字（第一行）
        ctx.fillStyle = statusColor + '90'
        ctx.font = `${9 * this.zoom}px sans-serif`
        ctx.fillText(tool.ok ? '成功' : '失败', lightX - 10 * this.zoom, py + toolH * 0.38)
      }
      py += toolH + gap * 0.5
    }
    py += gap * 0.5

    // ═══ 4. 完成节点（底部，绿色）═══
    if (turn.finalText) {
      const dh = DONE_H * this.zoom
      drawPanel(ctx, px, py, pw, dh, {
        hue: 140, sat: 80, light: 18, depth: 3 * this.zoom
      }, now, { screws: true, glowAlpha: 0.1 })
      ctx.fillStyle = C.done
      ctx.font = `${15 * this.zoom}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(`✅ ${turn.finalText}`, px + pw / 2, py + dh * 0.42)
      // 完成时间戳
      ctx.fillStyle = C.done + '60'
      ctx.font = `${10 * this.zoom}px monospace`
      ctx.fillText(new Date().toLocaleTimeString(), px + pw / 2, py + dh * 0.75)
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

    // 上下文仪表（物理仪表盘）
    const ctxRatio = Math.min(this.data.contextUsed / this.data.contextMax, 1)
    drawGauge(ctx, barX + 40, barY + 35, 24, Math.round(ctxRatio * 100), 100, 'Context', 140, performance.now())

    // Token 燃料
    const tokenY = barY + 12 + barH - 20 + 10
    // 成本估算（token ≈ 人民币）
    if (this.data.totalTokens > 0) {
      const costCNY = this.data.totalTokens * 0.0000014 // 假设 1.4 CNY/M tokens
      ctx.fillStyle = C.textDim + '90'
      ctx.font = '9px monospace'
      ctx.textAlign = 'right'
      ctx.fillText(`≈ ¥${costCNY.toFixed(4)}`, barX + barW - 8, tokenY + barH - 20 + 14)
    }
    ctx.fillStyle = C.textDim
    ctx.fillText('Token', barX + 10, tokenY - 2)
    ctx.fillStyle = C.flow + '60'
    const tokenRatio = Math.min(this.data.totalTokens / 100000, 1)
    ctx.beginPath(); ctx.roundRect(barX + 70, tokenY, (barW - 180) * tokenRatio, barH - 20, 2); ctx.fill()
    ctx.fillStyle = C.flow
    ctx.fillText(`${this.data.totalTokens.toLocaleString()}`, barX + barW - 100, tokenY + barH - 20 - 1)
  }


  /* ════════════════════════════════════════════════
     执行时间线（各阶段耗时比例）
     ════════════════════════════════════════════════ */

  private drawTimeline(ctx: CanvasRenderingContext2D) {
    if (!this.data || this.data.turns.length === 0) return
    const barY = this.h - 18
    const barW = Math.min(this.w - 40, 600)
    const barX = (this.w - barW) / 2

    // 标签
    ctx.fillStyle = C.textDim + '80'
    ctx.font = '9px monospace'
    ctx.textAlign = 'left'
    ctx.fillText('⏱', barX - 15, barY + 4)

    // 计算各阶段总耗时
    let inputTime = 0, thinkTime = 0, toolTime = 0
    for (const turn of this.data.turns) {
      inputTime += 50 // 用户输入假设 50ms
      thinkTime += 200 // 推理假设 200ms
      for (const t of turn.tools) toolTime += t.dur
    }
    const totalTime = Math.max(inputTime + thinkTime + toolTime, 1)

    // 分段条
    let x = barX
    const segments: Array<[string, number, string]> = [
      ['输入', inputTime, C.user],
      ['推理', thinkTime, C.think],
      ['工具', toolTime, C.tool],
    ]
    for (const [label, time, color] of segments) {
      const w = (time / totalTime) * barW
      if (w > 2) {
        ctx.fillStyle = color + '50'
        ctx.beginPath(); ctx.roundRect(x, barY, w - 1, 8, 2); ctx.fill()
        if (w > 30) {
          ctx.fillStyle = color
          ctx.font = '7px monospace'
          ctx.textAlign = 'center'
          ctx.fillText(label, x + w / 2, barY + 13)
        }
      }
      x += w
    }
    // 总时长
    ctx.fillStyle = C.textDim
    ctx.font = '9px monospace'
    ctx.textAlign = 'right'
    ctx.fillText(`总 ${totalTime}ms`, barX + barW + 5, barY + 6)
  }
}

/* 导出解析函数供 React 组件使用 */
export { parseTurns, type PipelineData, type PipeTurn }
