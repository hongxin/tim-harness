/**
 * Agent Machine —— Cosmos 视觉层重塑（Anatomy 思想融合）
 *
 * 核心理念：不改布局引擎（力导向+语义定位是好的），
 * 改的是视觉层——让每个元素从"标记"变成"机器零件"。
 *
 * Anatomy 的 4 层启示：
 * 1. 认知隐喻：从"星座"→"工厂流水线"
 * 2. 状态可视化：每个视觉属性编码一个数据维度
 * 3. 因果关系：连线 = 数据管道（数据在此流转并变化）
 * 4. 约束可视化：物理容量（液位、仪表）替代抽象百分比
 */

/* ══════════════════════════════════════════════════════
   机械隐喻系统：每类工具 = 一种机械零件
   ══════════════════════════════════════════════════════ */

export type MachineIcon = 'magnifier' | 'pen' | 'bolt' | 'scissors' | 'target' | 'gear' | 'pipeline' | 'camera' | 'gauge' | 'funnel' | 'shield' | 'cpu' | 'book' | 'archive' | 'question' | 'flag'

const TOOL_ICONS: Record<string, { icon: MachineIcon; verb: string }> = {
  read_file:   { icon: 'magnifier', verb: '读取' },
  write_file:  { icon: 'pen',       verb: '写入' },
  edit_file:   { icon: 'scissors',  verb: '修改' },
  run_js:      { icon: 'bolt',      verb: '执行' },
  grep:        { icon: 'target',    verb: '搜索' },
  glob:        { icon: 'target',    verb: '匹配' },
  ls:          { icon: 'book',      verb: '列出' },
  web_fetch:   { icon: 'pipeline',  verb: '抓取' },
  web_search:  { icon: 'target',    verb: '检索' },
  todo_write:  { icon: 'flag',      verb: '规划' },
  spawn_agent: { icon: 'cpu',       verb: '派生' },
  ask_user:    { icon: 'question',  verb: '询问' },
  skill:       { icon: 'book',      verb: '装载' },
  goal_update: { icon: 'flag',      verb: '更新目标' },
  snapshot_save:    { icon: 'archive', verb: '保存' },
  snapshot_restore: { icon: 'archive', verb: '恢复' },
  snapshot_list:    { icon: 'book',    verb: '列出快照' },
  snapshot_diff:    { icon: 'magnifier', verb: '对比' },
  snapshot_delete:  { icon: 'scissors', verb: '删除' },
}

export function getToolIcon(name: string): { icon: MachineIcon; verb: string } {
  return TOOL_ICONS[name] ?? { icon: 'gear', verb: name }
}

/* ══════════════════════════════════════════════════════
   Canvas 2D 机械零件绘制器
   ══════════════════════════════════════════════════════ */

/**
 * 绘制机械零件图标（替代之前的纯色方块/圆）
 * 每个图标都是"这个工具在物理世界中做什么"的隐喻
 */
export function drawMachinePart(
  ctx: CanvasRenderingContext2D,
  icon: MachineIcon,
  cx: number, cy: number,
  size: number,
  hue: number,
  alpha: number,
  now: number,
): void {
  const s = size
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(cx, cy)

  // 底板（所有零件都有）
  ctx.fillStyle = `hsla(${hue}, 30%, 12%, 0.9)`
  ctx.strokeStyle = `hsla(${hue}, 60%, 50%, 0.5)`
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(-s, -s, s * 2, s * 2, 3)
  ctx.fill()
  ctx.stroke()

  ctx.strokeStyle = `hsla(${hue}, 70%, 65%, 0.9)`
  ctx.fillStyle = `hsla(${hue}, 50%, 45%, 0.7)`
  ctx.lineWidth = Math.max(1.2, s * 0.12)

  switch (icon) {
    case 'magnifier': { // read_file
      const r = s * 0.45
      ctx.beginPath(); ctx.arc(-s*0.15, -s*0.15, r, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(s*0.2, s*0.2); ctx.lineTo(s*0.55, s*0.55); ctx.stroke()
      break
    }
    case 'pen': { // write_file
      ctx.beginPath(); ctx.moveTo(-s*0.4, s*0.4); ctx.lineTo(s*0.3, -s*0.4); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(s*0.3, -s*0.4); ctx.lineTo(s*0.5, -s*0.2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-s*0.4, s*0.4); ctx.lineTo(-s*0.5, s*0.5); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-s*0.4, s*0.4); ctx.lineTo(-s*0.2, s*0.5); ctx.stroke()
      break
    }
    case 'bolt': { // run_js
      ctx.beginPath()
      ctx.moveTo(s*0.1, -s*0.6); ctx.lineTo(-s*0.3, s*0.1); ctx.lineTo(s*0.05, s*0.1)
      ctx.lineTo(-s*0.1, s*0.6); ctx.lineTo(s*0.35, -s*0.1); ctx.lineTo(s*0.0, -s*0.1)
      ctx.closePath(); ctx.fill()
      break
    }
    case 'scissors': { // edit_file
      ctx.beginPath(); ctx.moveTo(-s*0.4, -s*0.3); ctx.lineTo(s*0.4, s*0.3); ctx.stroke()
      ctx.beginPath(); ctx.arc(-s*0.3, s*0.35, s*0.15, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.arc(s*0.3, s*0.35, s*0.15, 0, Math.PI*2); ctx.stroke()
      break
    }
    case 'target': { // grep/glob/web_search
      ctx.beginPath(); ctx.arc(0, 0, s*0.5, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.arc(0, 0, s*0.25, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s*0.6, -s*0.6); ctx.stroke()
      break
    }
    case 'gear': { // default
      const teeth = 6
      const rot = now / 1000
      ctx.rotate(rot)
      for (let i = 0; i < teeth; i++) {
        const a = i / teeth * Math.PI * 2
        ctx.beginPath()
        ctx.moveTo(Math.cos(a)*s*0.3, Math.sin(a)*s*0.3)
        ctx.lineTo(Math.cos(a)*s*0.55, Math.sin(a)*s*0.55)
        ctx.stroke()
      }
      ctx.beginPath(); ctx.arc(0, 0, s*0.3, 0, Math.PI*2); ctx.stroke()
      break
    }
    case 'pipeline': { // web_fetch
      ctx.beginPath(); ctx.moveTo(-s*0.5, 0); ctx.lineTo(s*0.5, 0); ctx.stroke()
      ctx.beginPath(); ctx.arc(-s*0.5, 0, s*0.15, -Math.PI/2, Math.PI/2); ctx.stroke()
      ctx.beginPath(); ctx.arc(s*0.5, 0, s*0.15, -Math.PI/2, Math.PI/2); ctx.stroke()
      // 流动箭头
      const t = (now / 500) % 1
      const px = -s*0.5 + t * s
      ctx.beginPath(); ctx.moveTo(px, -s*0.1); ctx.lineTo(px + s*0.1, 0); ctx.lineTo(px, s*0.1); ctx.stroke()
      break
    }
    case 'cpu': { // spawn_agent
      ctx.strokeRect(-s*0.3, -s*0.3, s*0.6, s*0.6)
      ctx.strokeRect(-s*0.15, -s*0.15, s*0.3, s*0.3)
      // 引脚
      for (let i = -1; i <= 1; i += 2) {
        ctx.beginPath(); ctx.moveTo(i*s*0.15, -s*0.3); ctx.lineTo(i*s*0.15, -s*0.5); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(i*s*0.15, s*0.3); ctx.lineTo(i*s*0.15, s*0.5); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(-s*0.3, i*s*0.15); ctx.lineTo(-s*0.5, i*s*0.15); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(s*0.3, i*s*0.15); ctx.lineTo(s*0.5, i*s*0.15); ctx.stroke()
      }
      break
    }
    case 'flag': { // todo_write / goal_update
      ctx.beginPath(); ctx.moveTo(-s*0.2, -s*0.5); ctx.lineTo(-s*0.2, s*0.5); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-s*0.2, -s*0.5); ctx.lineTo(s*0.4, -s*0.3); ctx.lineTo(-s*0.2, -s*0.1); ctx.fill()
      break
    }
    case 'book': { // skill / ls / snapshot_list
      ctx.beginPath(); ctx.moveTo(-s*0.4, -s*0.4); ctx.lineTo(0, -s*0.3); ctx.lineTo(s*0.4, -s*0.4)
      ctx.lineTo(s*0.4, s*0.3); ctx.lineTo(0, s*0.4); ctx.lineTo(-s*0.4, s*0.3); ctx.closePath(); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, -s*0.3); ctx.lineTo(0, s*0.4); ctx.stroke()
      break
    }
    case 'archive': { // snapshot
      ctx.strokeRect(-s*0.4, -s*0.35, s*0.8, s*0.7)
      ctx.beginPath(); ctx.moveTo(-s*0.4, -s*0.1); ctx.lineTo(s*0.4, -s*0.1); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-s*0.1, s*0.05); ctx.lineTo(s*0.1, s*0.05); ctx.stroke()
      break
    }
    case 'question': { // ask_user
      ctx.font = `bold ${s*1.1}px sans-serif`
      ctx.fillStyle = `hsla(${hue}, 70%, 65%, 0.9)`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('?', 0, 0)
      break
    }
    case 'funnel': { // user input
      ctx.beginPath(); ctx.moveTo(-s*0.4, -s*0.4); ctx.lineTo(s*0.4, -s*0.4)
      ctx.lineTo(s*0.15, s*0.2); ctx.lineTo(-s*0.15, s*0.2); ctx.closePath(); ctx.stroke()
      break
    }
    case 'camera': { // verify/read back
      ctx.strokeRect(-s*0.4, -s*0.3, s*0.8, s*0.6)
      ctx.beginPath(); ctx.arc(0, 0, s*0.15, 0, Math.PI*2); ctx.stroke()
      break
    }
    default: {
      ctx.beginPath(); ctx.arc(0, 0, s*0.3, 0, Math.PI*2); ctx.stroke()
    }
  }

  ctx.restore()
}

/* ══════════════════════════════════════════════════════
   状态指示灯
   ══════════════════════════════════════════════════════ */

export function drawStatusLight(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  status: 'running' | 'done' | 'error' | 'idle',
  now: number,
): void {
  const r = 3
  ctx.save()
  switch (status) {
    case 'running':
      const pulse = 0.5 + 0.5 * Math.sin(now / 200)
      ctx.fillStyle = `rgba(88, 166, 255, ${0.4 + pulse * 0.6})`
      // 光晕
      ctx.beginPath(); ctx.arc(cx, cy, r * 2, 0, Math.PI*2)
      ctx.fillStyle = `rgba(88, 166, 255, ${0.1 + pulse * 0.2})`; ctx.fill()
      break
    case 'done':
      ctx.fillStyle = 'rgba(63, 185, 80, 0.9)'
      break
    case 'error':
      const blink = Math.sin(now / 150) > 0
      ctx.fillStyle = blink ? 'rgba(248, 81, 73, 1)' : 'rgba(248, 81, 73, 0.3)'
      break
    case 'idle':
      ctx.fillStyle = 'rgba(110, 118, 129, 0.5)'
      break
  }
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill()
  ctx.restore()
}

/* ══════════════════════════════════════════════════════
   上下文液位计（替代百分比数字）
   ══════════════════════════════════════════════════════ */

export function drawContextGauge(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  width: number, height: number,
  fillRatio: number,
  masked: boolean,
  isDark: boolean,
): void {
  ctx.save()

  // 容器
  ctx.fillStyle = isDark ? 'rgba(22, 27, 34, 0.9)' : 'rgba(255, 255, 255, 0.9)'
  ctx.strokeStyle = isDark ? '#30363D' : '#D0D7DE'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.roundRect(x, y, width, height, 4); ctx.fill(); ctx.stroke()

  // 液位
  const fillW = width * Math.min(fillRatio, 1)
  const fillColor = fillRatio > 0.8 ? '#F85149' : fillRatio > 0.6 ? '#D29922' : '#238636'
  ctx.fillStyle = fillColor
  ctx.globalAlpha = 0.3
  ctx.beginPath(); ctx.roundRect(x + 1, y + 1, Math.max(fillW - 2, 0), height - 2, 3); ctx.fill()
  ctx.globalAlpha = 1

  // 液面波动线
  if (fillW > 5) {
    const waveY = y + height * 0.5
    ctx.strokeStyle = fillColor
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let px = x + 2; px < x + fillW - 2; px += 3) {
      const wy = waveY + Math.sin(px * 0.3 + Date.now() / 500) * 1.5
      if (px === x + 2) ctx.moveTo(px, wy)
      else ctx.lineTo(px, wy)
    }
    ctx.stroke()
  }

  // 标记线（25%/50%/75%）
  ctx.strokeStyle = isDark ? 'rgba(48, 54, 61, 0.5)' : 'rgba(208, 215, 222, 0.5)'
  ctx.lineWidth = 0.5
  for (const pct of [0.25, 0.5, 0.75]) {
    const px = x + width * pct
    ctx.beginPath(); ctx.moveTo(px, y + 2); ctx.lineTo(px, y + height - 2); ctx.stroke()
  }

  // 压缩标记（液位突然下降的地方）
  if (masked) {
    const maskX = x + fillW
    ctx.strokeStyle = '#58A6FF'
    ctx.setLineDash([2, 2])
    ctx.beginPath(); ctx.moveTo(maskX, y + 2); ctx.lineTo(maskX, y + height - 2); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#58A6FF'
    ctx.font = '8px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('⚡', maskX, y - 3)
  }

  // 标签
  ctx.fillStyle = isDark ? '#9DA7B3' : '#57606A'
  ctx.font = '9px monospace'
  ctx.textAlign = 'left'
  ctx.fillText(`Context ${(fillRatio * 100).toFixed(0)}%`, x + 4, y + height - 4)

  ctx.restore()
}

/* ══════════════════════════════════════════════════════
   传送带连接线（替代静态弧线）
   ══════════════════════════════════════════════════════ */

export function drawConveyorBelt(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  width: number,
  isDark: boolean,
  now: number,
  alpha: number,
): void {
  ctx.save()
  ctx.globalAlpha = alpha

  // 传送带主体
  ctx.strokeStyle = isDark ? 'rgba(48, 54, 61, 0.8)' : 'rgba(208, 215, 222, 0.8)'
  ctx.lineWidth = width
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()

  // 移动纹路（模拟传送带滚动）
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.sqrt(dx*dx + dy*dy) || 1
  const ux = dx / len, uy = dy / len
  const spacing = 12
  const offset = (now / 30) % spacing

  ctx.strokeStyle = isDark ? 'rgba(88, 166, 255, 0.3)' : 'rgba(9, 105, 218, 0.3)'
  ctx.lineWidth = 1
  for (let d = offset; d < len; d += spacing) {
    const px = x1 + ux * d, py = y1 + uy * d
    // 垂直于传送带方向的短线
    ctx.beginPath()
    ctx.moveTo(px - uy * width * 0.4, py + ux * width * 0.4)
    ctx.lineTo(px + uy * width * 0.4, py - ux * width * 0.4)
    ctx.stroke()
  }

  ctx.restore()
}
