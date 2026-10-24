/**
 * MachineRenderer —— 装配线渲染引擎（Anatomy 编译器第三层）
 *
 * 多巴胺配色 + 机械动画 + 装配线布局
 * 零 LLM 调用，纯 Canvas 2D，60fps
 */

import type { MachineBlueprint, Station, StationType } from './MachineBlueprint'

/* ═════════════════════════════════════════════════
   多巴胺配色系统
   ═════════════════════════════════════════════════ */

export const DOPAMINE = {
  bg: '#0D1117',
  bgPanel: '#161B22',
  bgEdge: '#21262D',
  // 亮色系（多巴胺直接刺激）
  input: '#FF6B9D',      // 粉红 - 人类温暖
  thinking: '#FFD700',   // 金色 - 价值与快乐
  reader: '#7CFC00',     // 草绿 - 获取知识
  writer: '#FF8C00',     // 橙色 - 创造
  editor: '#FF69B4',     // 粉 - 精细调整
  reactor: '#00E5FF',    // 青色 - 机器精确
  screener: '#00CED1',   // 青蓝 - 筛选
  lister: '#98FB98',     // 浅绿 - 浏览
  fetcher: '#DDA0DD',    // 兰紫 - 网络获取
  searcher: '#87CEEB',   // 天蓝 - 搜索
  planner: '#FFB347',    // 杏黄 - 规划
  cloner: '#DA70D6',     // 兰紫 - 派生
  asker: '#FF7F50',      // 珊瑚 - 询问
  loader: '#9370DB',     // 紫罗兰 - 装载
  tracker: '#32CD32',    // 亮绿 - 追踪
  archiver: '#A0522D',   // 赭石 - 归档
  output: '#00FF88',     // 荧光绿 - 完成的喜悦
  compressor: '#C0C0C0', // 银色 - 压缩
  // 状态色
  running: '#58A6FF',
  done: '#00FF88',
  error: '#FF4444',
  idle: '#6E7681',
  // 结构色
  conveyor: '#4A9EFF',
  gauge: '#FFA500',
  text: '#E6EDF3',
  textDim: '#9DA7B3',
}

const STATION_COLOR: Record<StationType, string> = {
  'input-funnel': DOPAMINE.input,
  'thinking-gear': DOPAMINE.thinking,
  'reader': DOPAMINE.reader,
  'writer': DOPAMINE.writer,
  'editor': DOPAMINE.editor,
  'reactor': DOPAMINE.reactor,
  'screener': DOPAMINE.screener,
  'lister': DOPAMINE.lister,
  'fetcher': DOPAMINE.fetcher,
  'searcher': DOPAMINE.searcher,
  'planner': DOPAMINE.planner,
  'cloner': DOPAMINE.cloner,
  'asker': DOPAMINE.asker,
  'loader': DOPAMINE.loader,
  'tracker': DOPAMINE.tracker,
  'archiver': DOPAMINE.archiver,
  'output-chute': DOPAMINE.output,
  'compressor': DOPAMINE.compressor,
}

/* ═════════════════════════════════════════════════
   工位绘制器（每种类型一个专属外观）
   ═════════════════════════════════════════════════ */

function drawStation(
  ctx: CanvasRenderingContext2D,
  st: Station,
  cx: number, cy: number,
  scale: number,
  now: number,
  isHovered: boolean,
): void {
  const color = STATION_COLOR[st.type] ?? '#666'
  const s = 30 * scale // 基础尺寸
  const isRunning = st.status === 'running'
  const isError = st.status === 'error'

  ctx.save()
  ctx.translate(cx, cy)

  // 光晕（运行中的工位更亮）
  const glowR = s * (isRunning ? 2.2 : isHovered ? 1.8 : 1.3)
  const glowA = isRunning ? 0.35 : isHovered ? 0.25 : 0.1
  const glow = ctx.createRadialGradient(0, 0, s * 0.3, 0, 0, glowR)
  glow.addColorStop(0, color + Math.round(glowA * 255).toString(16).padStart(2, '0'))
  glow.addColorStop(1, 'transparent')
  ctx.fillStyle = glow
  ctx.beginPath(); ctx.arc(0, 0, glowR, 0, Math.PI * 2); ctx.fill()

  // 底板（面板质感）
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = 6
  ctx.shadowOffsetY = 3
  const panel = ctx.createLinearGradient(-s, -s, s, s)
  panel.addColorStop(0, color + '25')
  panel.addColorStop(1, color + '10')
  ctx.fillStyle = panel
  ctx.strokeStyle = color + '80'
  ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.roundRect(-s, -s, s * 2, s * 2, 6); ctx.fill(); ctx.stroke()
  ctx.shadowColor = 'transparent'

  // 螺丝钉
  ctx.fillStyle = color + '40'
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.beginPath(); ctx.arc(dx * (s - 5), dy * (s - 5), 1.5, 0, Math.PI * 2); ctx.fill()
  }

  // ═══ 类型专属图形 ═══
  ctx.strokeStyle = color
  ctx.fillStyle = color + 'AA'
  ctx.lineWidth = Math.max(1.5, s * 0.08)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const r = s * 0.45

  switch (st.type) {
    case 'input-funnel': {
      // 漏斗 + 下落粒子
      ctx.beginPath()
      ctx.moveTo(-r, -r * 0.8); ctx.lineTo(r, -r * 0.8)
      ctx.lineTo(r * 0.3, r * 0.3); ctx.lineTo(-r * 0.3, r * 0.3)
      ctx.closePath(); ctx.stroke()
      const dropY = (now / 300 % 1) * r * 1.2
      ctx.fillStyle = color
      ctx.beginPath(); ctx.arc(0, r * 0.4 + dropY, 2.5, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'thinking-gear': {
      // 旋转齿轮
      const rot = isRunning ? now / 200 : now / 2000 // 运行时快转
      ctx.save(); ctx.rotate(rot)
      const teeth = 8
      for (let i = 0; i < teeth; i++) {
        const a = i / teeth * Math.PI * 2
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5)
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r)
        ctx.stroke()
      }
      ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.arc(0, 0, r * 0.15, 0, Math.PI * 2); ctx.stroke()
      ctx.restore()
      break
    }
    case 'reactor': {
      // 反应釜：容器 + 搅拌 + 电弧
      ctx.strokeRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4)
      // 内部液体
      ctx.fillStyle = color + '30'
      ctx.fillRect(-r * 0.6, -r * 0.2, r * 1.2, r * 0.8)
      // 电弧
      if (isRunning && Math.random() > 0.7) {
        ctx.strokeStyle = '#FFF'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(-r * 0.4, -r * 0.5)
        ctx.lineTo(Math.random() * r * 0.4 - r * 0.2, 0)
        ctx.lineTo(r * 0.3, r * 0.3)
        ctx.stroke()
      }
      break
    }
    case 'reader': {
      // 放大镜
      ctx.beginPath(); ctx.arc(-r * 0.2, -r * 0.2, r * 0.5, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(r * 0.15, r * 0.15); ctx.lineTo(r * 0.5, r * 0.5); ctx.stroke()
      ctx.strokeStyle = color + '50'
      ctx.beginPath(); ctx.arc(-r * 0.2, -r * 0.2, r * 0.3, -0.5, 1.2); ctx.stroke()
      break
    }
    case 'writer': {
      // 钢笔 + 墨滴
      ctx.beginPath(); ctx.moveTo(-r * 0.5, r * 0.5); ctx.lineTo(r * 0.2, -r * 0.4); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(r * 0.2, -r * 0.4); ctx.lineTo(r * 0.5, -r * 0.2); ctx.stroke()
      ctx.fillStyle = color + '60'
      ctx.beginPath(); ctx.arc(-r * 0.55, r * 0.55, 2.5, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'output-chute': {
      // 输出滑道 + 产品
      ctx.beginPath()
      ctx.moveTo(-r * 0.5, -r * 0.6); ctx.lineTo(r * 0.5, -r * 0.3)
      ctx.lineTo(r * 0.4, r * 0.5); ctx.lineTo(-r * 0.3, r * 0.3)
      ctx.closePath(); ctx.stroke()
      // 完成的对勾
      ctx.strokeStyle = DOPAMINE.done
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(-r * 0.15, 0); ctx.lineTo(0, r * 0.15); ctx.lineTo(r * 0.25, -r * 0.2); ctx.stroke()
      break
    }
    case 'compressor': {
      // 压缩机：多层薄板
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = 0.5 + i * 0.2
        ctx.strokeRect(-r * 0.5 + i * 3, -r * 0.5 + i * 2, r - i * 6, r - i * 4)
      }
      ctx.globalAlpha = 1
      break
    }
    default: {
      // 通用工位：圆 + 内圆
      ctx.beginPath(); ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.arc(0, 0, r * 0.25, 0, Math.PI * 2); ctx.stroke()
    }
  }

  // ═══ 状态指示灯（右上角）═══
  const lightColor = isRunning ? DOPAMINE.running : isError ? DOPAMINE.error : st.status === 'done' ? DOPAMINE.done : DOPAMINE.idle
  const lightR = 3.5
  const lx = s * 0.7, ly = -s * 0.7
  if (isRunning) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 150)
    ctx.fillStyle = lightColor + Math.round(pulse * 255).toString(16).padStart(2, '0')
  } else if (isError) {
    const blink = Math.sin(now / 200) > 0
    ctx.fillStyle = blink ? DOPAMINE.error : DOPAMINE.error + '40'
  } else {
    ctx.fillStyle = lightColor
  }
  ctx.beginPath(); ctx.arc(lx, ly, lightR, 0, Math.PI * 2); ctx.fill()

  ctx.restore()
}

/* ═════════════════════════════════════════════════
   传送带绘制
   ═════════════════════════════════════════════════ */

function drawConveyor(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  now: number,
  scale: number,
  isBranch: boolean,
): void {
  ctx.save()

  const w = isBranch ? 2 : 4 * scale
  ctx.strokeStyle = isBranch ? DOPAMINE.conveyor + '40' : DOPAMINE.conveyor + '70'
  ctx.lineWidth = w
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()

  // 滚动纹路
  if (!isBranch) {
    const dx = x2 - x1, dy = y2 - y1
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const ux = dx / len, uy = dy / len
    const spacing = 14
    const offset = (now / 25) % spacing
    ctx.strokeStyle = DOPAMINE.conveyor + '40'
    ctx.lineWidth = 1
    for (let d = offset; d < len; d += spacing) {
      const px = x1 + ux * d, py = y1 + uy * d
      ctx.beginPath()
      ctx.moveTo(px - uy * w * 0.5, py + ux * w * 0.5)
      ctx.lineTo(px + uy * w * 0.5, py - ux * w * 0.5)
      ctx.stroke()
    }
  }

  ctx.restore()
}

/* ═════════════════════════════════════════════════
   仪表绘制
   ═════════════════════════════════════════════════ */

function drawGauge(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  type: string, value: number, maxValue: number,
  label: string,
  now: number,
): void {
  const w = 100, h = 14
  ctx.save()

  ctx.fillStyle = DOPAMINE.bgPanel
  ctx.strokeStyle = DOPAMINE.bgEdge
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill(); ctx.stroke()

  const ratio = Math.min(value / maxValue, 1)
  const color = type === 'fuel' ? DOPAMINE.gauge : ratio > 0.8 ? DOPAMINE.error : ratio > 0.6 ? DOPAMINE.planner : DOPAMINE.done
  ctx.fillStyle = color + '50'
  ctx.beginPath(); ctx.roundRect(x + 1, y + 1, Math.max(ratio * (w - 2), 0), h - 2, 2); ctx.fill()

  // 波动液面
  if (ratio > 0.05) {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let px = x + 2; px < x + ratio * w - 2; px += 2) {
      const wy = y + h * 0.5 + Math.sin(px * 0.4 + now / 500) * 1.5
      if (px === x + 2) ctx.moveTo(px, wy)
      else ctx.lineTo(px, wy)
    }
    ctx.stroke()
  }

  ctx.fillStyle = DOPAMINE.textDim
  ctx.font = '9px monospace'
  ctx.textAlign = 'left'
  ctx.fillText(`${label} ${Math.round(ratio * 100)}%`, x, y - 3)

  ctx.restore()
}

/* ═════════════════════════════════════════════════
   主渲染器
   ═════════════════════════════════════════════════ */

export class MachineRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private w = 0; private h = 0; private dpr = 1
  private animId = 0
  private bp: MachineBlueprint | null = null
  private zoom = 1
  private offsetX = 0; private offsetY = 0
  private hoverId: string | null = null
  
  private panning = false
  private panStart = { x: 0, y: 0 }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resize()
    this.bindEvents()
    this.loop()
  }

  destroy() {
    cancelAnimationFrame(this.animId)
    this.unbindEvents()
  }

  setBlueprint(bp: MachineBlueprint) {
    this.bp = bp
    this.autoFit()
  }

  private autoFit() {
    if (!this.bp || this.bp.stations.length === 0) return
    const xs = this.bp.stations.map((s) => s.x)
    const minX = Math.min(...xs) - 80
    const maxX = Math.max(...xs) + 80
    const rangeX = maxX - minX
    this.zoom = Math.min(1.2, this.w / rangeX)
    this.offsetX = -(minX + maxX) / 2
    this.offsetY = 30 // 稍微向下偏移，给仪表留空间
  }

  private w2s(wx: number, wy: number): [number, number] {
    return [(wx + this.offsetX) * this.zoom + this.w / 2, (wy + this.offsetY) * this.zoom + this.h / 2]
  }
  private s2w(sx: number, sy: number): [number, number] {
    return [(sx - this.w / 2) / this.zoom - this.offsetX, (sy - this.h / 2) / this.zoom - this.offsetY]
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

  private bindEvents() {
    this.canvas.addEventListener('wheel', this.onWheel)
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('pointermove', this.onMove)
    this.canvas.addEventListener('pointerup', this.onUp)
    window.addEventListener('resize', this.onResize)
  }
  private unbindEvents() {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('resize', this.onResize)
  }

  private onResize = () => { this.resize(); this.autoFit() }
  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.zoom = Math.max(0.2, Math.min(3, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)))
  }
  private onDown = (e: PointerEvent) => {
    this.panning = true
    this.panStart = { x: e.clientX, y: e.clientY }
  }
  private onMove = (e: PointerEvent) => {
    if (this.panning) {
      this.offsetX += (e.clientX - this.panStart.x) / this.zoom
      this.offsetY += (e.clientY - this.panStart.y) / this.zoom
      this.panStart = { x: e.clientX, y: e.clientY }
      return
    }
    // hover 检测
    const r = this.canvas.getBoundingClientRect()
    const [wx, wy] = this.s2w(e.clientX - r.left, e.clientY - r.top)
    this.hoverId = null
    if (this.bp) {
      for (const st of this.bp.stations) {
        const dx = wx - st.x, dy = wy - st.y
        if (dx * dx + dy * dy < 40 * 40) { this.hoverId = st.id; break }
      }
    }
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab'
  }
  private onUp = () => { this.panning = false }

  private loop = () => {
    this.render()
    this.animId = requestAnimationFrame(this.loop)
  }

  private render() {
    const ctx = this.ctx
    const now = performance.now()

    // 背景（深空蓝，让鲜艳色弹出）
    const bg = ctx.createRadialGradient(this.w / 2, this.h / 2, 0, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.7)
    bg.addColorStop(0, '#111827')
    bg.addColorStop(1, DOPAMINE.bg)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, this.w, this.h)

    if (!this.bp) return

    // 工作单元卡片（长方形面板，卡片式布局）
    const cellMap = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>()
    for (const st of this.bp.stations) {
      if (!cellMap.has(st.turnId)) {
        cellMap.set(st.turnId, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
      }
      const c = cellMap.get(st.turnId)!
      c.minX = Math.min(c.minX, st.x)
      c.maxX = Math.max(c.maxX, st.x)
      c.minY = Math.min(c.minY, st.y)
      c.maxY = Math.max(c.maxY, st.y)
    }
    for (const [tid, c] of cellMap) {
      // 固定尺寸卡片（不依赖内容位置，更规整）
      const cw = 240, ch = 170 // card width/height
      const cx = c.minX - 20, cy = c.minY - 35 // card 左上角
      const [sx, sy] = this.w2s(cx, cy)
      const sw = cw * this.zoom, sh = ch * this.zoom
      if (sx + sw < 0 || sx > this.w) continue
      
      // 卡片阴影（物理深度感）
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.4)'
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 4
      
      // 卡片背景（实体面板，非虚线）
      const cardHue = (tid * 47) % 360 // 每回合不同色相
      const cardGrad = ctx.createLinearGradient(sx, sy, sx, sy + sh)
      cardGrad.addColorStop(0, `hsla(${cardHue}, 20%, 12%, 0.95)`)
      cardGrad.addColorStop(1, `hsla(${cardHue}, 15%, 8%, 0.95)`)
      ctx.fillStyle = cardGrad
      ctx.beginPath(); ctx.roundRect(sx, sy, sw, sh, 8); ctx.fill()
      
      // 卡片边框（顶部亮线，底部暗线——立体感）
      ctx.shadowColor = 'transparent'
      ctx.strokeStyle = `hsla(${cardHue}, 40%, 45%, 0.3)`
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(sx, sy, sw, sh, 8); ctx.stroke()
      // 顶部高光线
      ctx.strokeStyle = `hsla(${cardHue}, 50%, 60%, 0.15)`
      ctx.beginPath(); ctx.moveTo(sx + 4, sy + 1); ctx.lineTo(sx + sw - 4, sy + 1); ctx.stroke()
      
      ctx.restore()
      
      // 卡片标题栏（回合信息）
      if (this.zoom > 0.35) {
        const titleH = 22 * this.zoom
        // 标题栏背景
        ctx.fillStyle = `hsla(${cardHue}, 35%, 18%, 0.9)`
        ctx.beginPath(); ctx.roundRect(sx + 1, sy + 1, sw - 2, titleH, [8, 8, 0, 0]); ctx.fill()
        // 标题文字
        ctx.fillStyle = `hsla(${cardHue}, 60%, 75%, 0.9)`
        ctx.font = `bold ${11 * Math.min(this.zoom, 1.2)}px -apple-system, sans-serif`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(`回合 ${tid + 1}`, sx + 8, sy + titleH / 2 + 1)
        // 回合内工位计数
        const toolCount = this.bp!.stations.filter(st => st.turnId === tid && !['input-funnel','thinking-gear','output-chute'].includes(st.type)).length
        if (toolCount > 0) {
          ctx.fillStyle = `hsla(${cardHue}, 40%, 55%, 0.6)`
          ctx.font = `${9 * this.zoom}px monospace`
          ctx.textAlign = 'right'
          ctx.fillText(`${toolCount} 工具`, sx + sw - 8, sy + titleH / 2 + 1)
        }
      }
    }

    // 传送带
    for (const cv of this.bp.conveyors) {
      const from = this.bp.stations.find((s) => s.id === cv.fromStation)
      const to = this.bp.stations.find((s) => s.id === cv.toStation)
      if (!from || !to) continue
      const [x1, y1] = this.w2s(from.x, from.y)
      const [x2, y2] = this.w2s(to.x, to.y)
      const isBranch = from.y !== 0 || to.y !== 0
      drawConveyor(ctx, x1, y1, x2, y2, now, this.zoom, isBranch)
    }

    // 工位
    for (const st of this.bp.stations) {
      const [sx, sy] = this.w2s(st.x, st.y)
      if (sx < -100 || sx > this.w + 100) continue // 视口裁剪
      const isHovered = this.hoverId === st.id
      drawStation(ctx, st, sx, sy, this.zoom, now, isHovered)

      // 标签
      if (this.zoom > 0.4) {
        ctx.fillStyle = isHovered ? DOPAMINE.text : DOPAMINE.textDim
        ctx.font = `${10 * Math.min(this.zoom, 1.2)}px -apple-system, sans-serif`
        ctx.textAlign = 'center'
        const label = st.label.length > 14 ? st.label.slice(0, 13) + '…' : st.label
        ctx.fillText(label, sx, sy + 45 * this.zoom)
        // 耗时
        if (st.durationMs > 500 && this.zoom > 0.6) {
          ctx.fillStyle = DOPAMINE.textDim + '80'
          ctx.font = `${8 * this.zoom}px monospace`
          ctx.fillText(`${(st.durationMs / 1000).toFixed(1)}s`, sx, sy - 40 * this.zoom)
        }
      }
    }

    // 仪表（固定在右上角）
    let gaugeY = 60
    for (const g of this.bp.gauges) {
      drawGauge(ctx, this.w - 130, gaugeY, g.type, g.value, g.maxValue, g.label, now)
      gaugeY += 30
    }
  }
}
