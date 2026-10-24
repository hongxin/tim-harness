/**
 * PhysicalParts —— 物理零件绘制器（Anatomy 四色调明暗原则）
 *
 * 从 Anatomy SKILL.md 学到的核心原则：
 * "每个零件都坐在另一个零件上，在边缘结束，淡出而非突然停止"
 * "1倍看是一台清晰的机器，4倍看每个区域仍有真实细节"
 *
 * 本模块提供：
 * - drawPanel(): 带厚度、明暗、螺丝的物理面板
 * - drawPipe(): 连接两个面板的物理管道
 * - drawGauge(): 带指针和刻度的物理仪表
 * - drawRail(): 带刻度线的导轨
 */

/** HSL 颜色工具 */
function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h}, ${s}%, ${l}%, ${a})`
}

export interface PanelStyle {
  hue: number
  sat: number
  light: number
  /** 厚度（像素） */
  depth: number
}

/**
 * 物理面板（Anatomy 的核心构建块）
 *
 * 视觉层次（从暗到亮）：
 * 1. 投影（下方，最暗）
 * 2. 右侧面 + 底面（暗 20%）
 * 3. 主面（基础色）
 * 4. 顶部高光（亮 15%）
 * 5. 四角螺丝（暗 40%）
 */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  style: PanelStyle,
  now: number,
  opts?: { screws?: boolean; label?: string; glowAlpha?: number },
): void {
  const { hue, sat, light, depth } = style
  const screws = opts?.screws ?? true

  ctx.save()

  // ═══ 1. 投影 ═══
  ctx.fillStyle = hsl(hue, sat * 0.5, 3, 0.4)
  ctx.beginPath()
  ctx.roundRect(x + depth, y + depth + 2, w, h, 4)
  ctx.fill()

  // ═══ 2. 厚度（右+下侧面）═══
  // 右侧面
  ctx.fillStyle = hsl(hue, sat, Math.max(light - 15, 5))
  ctx.beginPath()
  ctx.moveTo(x + w, y)
  ctx.lineTo(x + w + depth, y + depth)
  ctx.lineTo(x + w + depth, y + h + depth)
  ctx.lineTo(x + w, y + h)
  ctx.closePath()
  ctx.fill()
  // 底面
  ctx.fillStyle = hsl(hue, sat, Math.max(light - 10, 8))
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x + w + depth, y + h + depth)
  ctx.lineTo(x + depth, y + h + depth)
  ctx.closePath()
  ctx.fill()

  // ═══ 3. 主面 ═══
  const glow = opts?.glowAlpha ?? 0
  const mainGrad = ctx.createLinearGradient(x, y, x, y + h)
  mainGrad.addColorStop(0, hsl(hue, sat, light + 3))
  mainGrad.addColorStop(1, hsl(hue, sat, light - 3))
  ctx.fillStyle = mainGrad
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 3)
  ctx.fill()

  // ═══ 4. 顶部高光 ═══
  ctx.strokeStyle = hsl(hue, sat, Math.min(light + 15, 90), 0.5)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 3, y + 1)
  ctx.lineTo(x + w - 3, y + 1)
  ctx.stroke()
  // 左侧高光
  ctx.beginPath()
  ctx.moveTo(x + 1, y + 3)
  ctx.lineTo(x + 1, y + h - 3)
  ctx.stroke()

  // ═══ 5. 边框 ═══
  ctx.strokeStyle = hsl(hue, sat, light - 8, 0.6)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 3)
  ctx.stroke()

  // ═══ 6. 四角螺丝 ═══
  if (screws && w > 30 && h > 20) {
    const sr = Math.min(2, w * 0.04)
    const positions = [
      [x + 5, y + 5], [x + w - 5, y + 5],
      [x + 5, y + h - 5], [x + w - 5, y + h - 5],
    ]
    for (const [sx, sy] of positions) {
      // 螺丝底座
      ctx.fillStyle = hsl(hue, sat, light - 12)
      ctx.beginPath(); ctx.arc(sx, sy, sr + 0.5, 0, Math.PI * 2); ctx.fill()
      // 螺丝头
      ctx.fillStyle = hsl(hue, sat * 0.5, light - 20)
      ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill()
      // 十字槽
      ctx.strokeStyle = hsl(hue, 0, 5, 0.5)
      ctx.lineWidth = 0.5
      ctx.beginPath(); ctx.moveTo(sx - sr * 0.6, sy); ctx.lineTo(sx + sr * 0.6, sy); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(sx, sy - sr * 0.6); ctx.lineTo(sx, sy + sr * 0.6); ctx.stroke()
    }
  }

  // ═══ 7. 发光（运行中的面板）═══
  if (glow > 0) {
    const glowGrad = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) / 2)
    glowGrad.addColorStop(0, hsl(hue, sat + 20, light + 20, glow))
    glowGrad.addColorStop(1, 'transparent')
    ctx.fillStyle = glowGrad
    ctx.beginPath(); ctx.roundRect(x - 2, y - 2, w + 4, h + 4, 5); ctx.fill()
  }

  ctx.restore()
}

/**
 * 物理管道（连接两个面板）
 * 带壁厚、内部流动粒子、法兰接口
 */
export function drawPipe(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  hue: number, now: number,
  opts?: { width?: number; flowing?: boolean },
): void {
  const width = opts?.width ?? 4
  const flowing = opts?.flowing ?? true
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  ctx.save()

  // 管道阴影
  ctx.strokeStyle = hsl(hue, 20, 3, 0.3)
  ctx.lineWidth = width + 2
  ctx.beginPath(); ctx.moveTo(x1 + 1, y1 + 2); ctx.lineTo(x2 + 1, y2 + 2); ctx.stroke()

  // 管道外壁（暗）
  ctx.strokeStyle = hsl(hue, 30, 20)
  ctx.lineWidth = width + 1
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()

  // 管道内壁（亮）
  ctx.strokeStyle = hsl(hue, 40, 35)
  ctx.lineWidth = width - 1
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()

  // 流动粒子
  if (flowing) {
    const particleCount = Math.max(2, Math.floor(len / 30))
    for (let i = 0; i < particleCount; i++) {
      const t = ((now / 800 + i / particleCount) % 1)
      const px = x1 + dx * t, py = y1 + dy * t
      ctx.fillStyle = hsl(hue, 80, 70, 0.8)
      ctx.beginPath(); ctx.arc(px, py, width * 0.4, 0, Math.PI * 2); ctx.fill()
    }
  }

  // 法兰接口（两端）
  for (const [fx, fy] of [[x1, y1], [x2, y2]]) {
    ctx.fillStyle = hsl(hue, 30, 25)
    ctx.beginPath(); ctx.arc(fx, fy, width * 0.8, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = hsl(hue, 40, 40)
    ctx.beginPath(); ctx.arc(fx, fy, width * 0.5, 0, Math.PI * 2); ctx.fill()
  }

  ctx.restore()
}

/**
 * 物理仪表（带指针、刻度、玻璃罩）
 */
export function drawGauge(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  value: number, maxValue: number,
  label: string,
  hue: number,
  now: number,
): void {
  const ratio = Math.min(value / maxValue, 1)
  const angle = -Math.PI * 0.75 + ratio * Math.PI * 1.5 // -135° to +135°

  ctx.save()

  // 外壳（带厚度）
  ctx.fillStyle = hsl(hue, 20, 8)
  ctx.beginPath(); ctx.arc(cx + 2, cy + 2, radius + 3, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = hsl(hue, 25, 15)
  ctx.beginPath(); ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2); ctx.fill()

  // 表盘面
  ctx.fillStyle = hsl(hue, 10, 10)
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill()

  // 刻度线
  ctx.strokeStyle = hsl(hue, 20, 50, 0.6)
  ctx.lineWidth = 1
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI * 0.75 + (i / 10) * Math.PI * 1.5
    const inner = radius * 0.8
    const outer = radius * 0.92
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer)
    ctx.stroke()
  }

  // 数值弧（从起点到当前位置）
  ctx.strokeStyle = ratio > 0.8 ? '#F85149' : ratio > 0.6 ? '#D29922' : '#238636'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(cx, cy, radius * 0.7, -Math.PI * 0.75, angle)
  ctx.stroke()

  // 指针（带弹性动画）
  const wobble = Math.sin(now / 300) * 0.02 * (1 - ratio) // 越接近满越稳定
  const needleAngle = angle + wobble
  ctx.strokeStyle = '#FF6B6B'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(cx - Math.cos(needleAngle) * radius * 0.15, cy - Math.sin(needleAngle) * radius * 0.15)
  ctx.lineTo(cx + Math.cos(needleAngle) * radius * 0.75, cy + Math.sin(needleAngle) * radius * 0.75)
  ctx.stroke()
  // 指针轴
  ctx.fillStyle = '#666'
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill()

  // 玻璃反光
  const glassGrad = ctx.createLinearGradient(cx - radius, cy - radius, cx, cy)
  glassGrad.addColorStop(0, 'rgba(255,255,255,0.1)')
  glassGrad.addColorStop(0.5, 'rgba(255,255,255,0.02)')
  glassGrad.addColorStop(1, 'transparent')
  ctx.fillStyle = glassGrad
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill()

  // 标签
  ctx.fillStyle = '#9DA7B3'
  ctx.font = `${Math.max(8, radius * 0.18)}px monospace`
  ctx.textAlign = 'center'
  ctx.fillText(label, cx, cy + radius + 12)
  // 数值
  ctx.fillStyle = '#E6EDF3'
  ctx.font = `${Math.max(8, radius * 0.15)}px monospace`
  ctx.fillText(`${value}`, cx, cy + radius * 0.4)

  ctx.restore()
}

/**
 * 物理导轨（带刻度线，面板沿导轨滑动）
 */
export function drawRail(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  hue: number,
): void {
  ctx.save()

  const dx = x2 - x1, dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const ux = dx / len, uy = dy / len
  const nx = -uy, ny = ux // 法线

  // 轨道阴影
  ctx.strokeStyle = hsl(hue, 20, 3, 0.3)
  ctx.lineWidth = 5
  ctx.beginPath(); ctx.moveTo(x1 + 1, y1 + 2); ctx.lineTo(x2 + 1, y2 + 2); ctx.stroke()

  // 轨道主体
  ctx.strokeStyle = hsl(hue, 25, 18)
  ctx.lineWidth = 4
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()

  // 轨道顶部亮线
  ctx.strokeStyle = hsl(hue, 25, 28, 0.6)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x1 + nx * 1.5, y1 + ny * 1.5)
  ctx.lineTo(x2 + nx * 1.5, y2 + ny * 1.5)
  ctx.stroke()

  // 刻度
  const tickSpacing = 20
  ctx.strokeStyle = hsl(hue, 20, 35, 0.5)
  ctx.lineWidth = 0.5
  for (let d = tickSpacing; d < len; d += tickSpacing) {
    const px = x1 + ux * d, py = y1 + uy * d
    ctx.beginPath()
    ctx.moveTo(px - nx * 2, py - ny * 2)
    ctx.lineTo(px + nx * 2, py + ny * 2)
    ctx.stroke()
  }

  ctx.restore()
}
