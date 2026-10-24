/**
 * Agent Machine v2 —— 具象化 + 防遮挡设计
 *
 * 核心改进（对照 Anatomy 的具象化程度）：
 * 1. 工具零件放大 + 阴影分离（防止视觉重叠）
 * 2. 标签外置（用"引线"连接，不遮挡零件）
 * 3. 等轴测深度暗示（2.5D 效果，零 3D 库依赖）
 * 4. 物理感增强（金属质感、螺丝钉、接缝线）
 */

import type { MachineIcon } from './MachineParts'

/* ══════════════════════════════════════════════════════
   具象化机械零件（v2：更大、更精细、有物理感）
   ══════════════════════════════════════════════════════ */

export function drawMachinePartV2(
  ctx: CanvasRenderingContext2D,
  icon: MachineIcon,
  cx: number, cy: number,
  size: number,
  hue: number,
  alpha: number,
  now: number,
  isDark: boolean,
): void {
  const s = size // 半径
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(cx, cy)

  // ═══ 底板（金属面板质感）═══
  // 阴影（物理深度感）
  ctx.shadowColor = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.15)'
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 2

  // 面板
  const panelGrad = ctx.createLinearGradient(-s, -s, s, s)
  if (isDark) {
    panelGrad.addColorStop(0, `hsl(${hue}, 25%, 18%)`)
    panelGrad.addColorStop(1, `hsl(${hue}, 20%, 12%)`)
  } else {
    panelGrad.addColorStop(0, `hsl(${hue}, 20%, 95%)`)
    panelGrad.addColorStop(1, `hsl(${hue}, 15%, 88%)`)
  }
  ctx.fillStyle = panelGrad
  ctx.strokeStyle = `hsla(${hue}, 50%, ${isDark ? 45 : 55}%, 0.6)`
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.roundRect(-s, -s, s * 2, s * 2, 3)
  ctx.fill()
  ctx.stroke()
  ctx.shadowColor = 'transparent' // 关闭阴影继续画细节

  // 螺丝钉（四角，物理固定感）
  ctx.fillStyle = `hsla(${hue}, 20%, ${isDark ? 40 : 60}%, 0.5)`
  for (const [dx, dy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
    ctx.beginPath()
    ctx.arc(dx * (s - 4), dy * (s - 4), 1.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // ═══ 图标区域 ═══
  ctx.strokeStyle = `hsla(${hue}, 70%, ${isDark ? 65 : 35}%, 0.95)`
  ctx.fillStyle = `hsla(${hue}, 55%, ${isDark ? 45 : 55}%, 0.75)`
  ctx.lineWidth = Math.max(1.5, s * 0.1)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const is = s * 0.55 // icon scale

  switch (icon) {
    case 'magnifier': {
      // 放大镜：圆 + 柄
      ctx.beginPath(); ctx.arc(-is*0.2, -is*0.2, is*0.5, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(is*0.2, is*0.2); ctx.lineTo(is*0.55, is*0.55); ctx.stroke()
      // 镜片反光
      ctx.strokeStyle = `hsla(${hue}, 80%, 80%, 0.3)`
      ctx.beginPath(); ctx.arc(-is*0.2, -is*0.2, is*0.3, -0.5, 1.2); ctx.stroke()
      break
    }
    case 'pen': {
      // 钢笔：斜杆 + 笔尖
      ctx.beginPath(); ctx.moveTo(-is*0.5, is*0.5); ctx.lineTo(is*0.2, -is*0.4); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(is*0.2, -is*0.4); ctx.lineTo(is*0.5, -is*0.2); ctx.stroke()
      // 笔尖
      ctx.beginPath(); ctx.moveTo(-is*0.5, is*0.5); ctx.lineTo(-is*0.6, is*0.6); ctx.stroke()
      // 墨水滴
      ctx.fillStyle = `hsla(${hue}, 80%, 60%, 0.4)`
      ctx.beginPath(); ctx.arc(-is*0.55, is*0.55, 2, 0, Math.PI*2); ctx.fill()
      break
    }
    case 'bolt': {
      // 闪电：折线填充
      ctx.beginPath()
      ctx.moveTo(is*0.15, -is*0.7); ctx.lineTo(-is*0.35, is*0.1); ctx.lineTo(is*0.05, is*0.1)
      ctx.lineTo(-is*0.15, is*0.7); ctx.lineTo(is*0.4, -is*0.1); ctx.lineTo(is*0.0, -is*0.1)
      ctx.closePath()
      ctx.fill()
      // 电弧
      ctx.strokeStyle = `hsla(${hue}, 90%, 80%, 0.4)`
      ctx.lineWidth = 1
      const spark = Math.sin(now / 300) * 0.5 + 0.5
      if (spark > 0.5) {
        ctx.beginPath(); ctx.moveTo(is*0.5, -is*0.5); ctx.lineTo(is*0.7, -is*0.3); ctx.stroke()
      }
      break
    }
    case 'scissors': {
      // 剪刀：交叉线 + 两个手柄圆
      ctx.beginPath(); ctx.moveTo(-is*0.4, -is*0.3); ctx.lineTo(is*0.4, is*0.3); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-is*0.4, is*0.3); ctx.lineTo(is*0.4, -is*0.3); ctx.stroke()
      ctx.beginPath(); ctx.arc(-is*0.35, is*0.4, is*0.15, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.arc(-is*0.35, -is*0.4, is*0.15, 0, Math.PI*2); ctx.stroke()
      break
    }
    case 'target': {
      // 靶心：同心圆 + 十字线
      ctx.beginPath(); ctx.arc(0, 0, is*0.55, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.arc(0, 0, is*0.28, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-is*0.7, 0); ctx.lineTo(is*0.7, 0); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, -is*0.7); ctx.lineTo(0, is*0.7); ctx.stroke()
      ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI*2); ctx.fill()
      break
    }
    case 'cpu': {
      // CPU：方框 + 内框 + 引脚
      ctx.strokeRect(-is*0.35, -is*0.35, is*0.7, is*0.7)
      ctx.strokeRect(-is*0.18, -is*0.18, is*0.36, is*0.36)
      for (let i = -1; i <= 1; i += 2) {
        for (const [px, py, dx2, dy2] of [
          [i*is*0.15, -is*0.35, 0, -is*0.15],
          [i*is*0.15, is*0.35, 0, is*0.15],
          [-is*0.35, i*is*0.15, -is*0.15, 0],
          [is*0.35, i*is*0.15, is*0.15, 0],
        ]) {
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px+dx2, py+dy2); ctx.stroke()
        }
      }
      break
    }
    case 'pipeline': {
      // 管道：双线 + 流动箭头
      ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.moveTo(-is*0.6, 0); ctx.lineTo(is*0.6, 0); ctx.stroke()
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(-is*0.6, -is*0.15); ctx.lineTo(is*0.6, -is*0.15); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-is*0.6, is*0.15); ctx.lineTo(is*0.6, is*0.15); ctx.stroke()
      // 流动标记
      const flowT = (now / 400) % 1
      const fx = -is*0.5 + flowT * is
      ctx.fillStyle = `hsla(${hue}, 80%, 70%, 0.8)`
      ctx.beginPath(); ctx.arc(fx, 0, 2, 0, Math.PI*2); ctx.fill()
      break
    }
    case 'gear': {
      // 齿轮：旋转齿 + 中心孔
      const rot = now / 800
      ctx.save(); ctx.rotate(rot)
      const teeth = 6
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * is * 0.3, Math.sin(a) * is * 0.3)
        ctx.lineTo(Math.cos(a) * is * 0.55, Math.sin(a) * is * 0.55)
        ctx.stroke()
      }
      ctx.beginPath(); ctx.arc(0, 0, is*0.3, 0, Math.PI*2); ctx.stroke()
      ctx.beginPath(); ctx.arc(0, 0, is*0.12, 0, Math.PI*2); ctx.stroke()
      ctx.restore()
      break
    }
    case 'book': {
      // 书本：打开的双页
      ctx.beginPath()
      ctx.moveTo(-is*0.5, -is*0.4); ctx.quadraticCurveTo(0, -is*0.5, is*0.5, -is*0.4)
      ctx.lineTo(is*0.5, is*0.3); ctx.quadraticCurveTo(0, is*0.4, -is*0.5, is*0.3)
      ctx.closePath(); ctx.stroke()
      // 中缝
      ctx.beginPath(); ctx.moveTo(0, -is*0.45); ctx.lineTo(0, is*0.35); ctx.stroke()
      // 页线
      ctx.lineWidth = 0.8
      ctx.beginPath(); ctx.moveTo(-is*0.3, -is*0.2); ctx.lineTo(-is*0.05, -is*0.2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-is*0.3, 0); ctx.lineTo(-is*0.05, 0); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(is*0.05, -is*0.2); ctx.lineTo(is*0.3, -is*0.2); ctx.stroke()
      break
    }
    case 'flag': {
      // 旗帜：杆 + 旗面
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(-is*0.3, -is*0.6); ctx.lineTo(-is*0.3, is*0.6); ctx.stroke()
      const wave = Math.sin(now / 400) * 2
      ctx.beginPath()
      ctx.moveTo(-is*0.3, -is*0.6)
      ctx.quadraticCurveTo(is*0.1, -is*0.5 + wave, is*0.5, -is*0.4)
      ctx.lineTo(is*0.5, -is*0.1)
      ctx.quadraticCurveTo(is*0.1, -is*0.2 + wave, -is*0.3, -is*0.1)
      ctx.closePath(); ctx.fill()
      break
    }
    case 'archive': {
      // 档案盒：箱体 + 抽屉拉手
      ctx.strokeRect(-is*0.45, -is*0.35, is*0.9, is*0.7)
      ctx.beginPath(); ctx.moveTo(-is*0.45, -is*0.1); ctx.lineTo(is*0.45, -is*0.1); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-is*0.1, 0.05); ctx.lineTo(is*0.1, 0.05); ctx.stroke()
      break
    }
    case 'question': {
      // 问号：粗体
      ctx.font = `bold ${is * 1.3}px sans-serif`
      ctx.fillStyle = `hsla(${hue}, 70%, ${isDark ? 65 : 35}%, 0.95)`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('?', 0, 0)
      break
    }
    case 'funnel': {
      // 漏斗：梯形 + 下落粒子
      ctx.beginPath()
      ctx.moveTo(-is*0.5, -is*0.4); ctx.lineTo(is*0.5, -is*0.4)
      ctx.lineTo(is*0.15, is*0.15); ctx.lineTo(-is*0.15, is*0.15)
      ctx.closePath(); ctx.stroke()
      // 下落粒子
      const dropT = (now / 600) % 1
      ctx.fillStyle = `hsla(${hue}, 70%, 65%, 0.6)`
      ctx.beginPath(); ctx.arc(0, is*0.2 + dropT * is*0.4, 1.5, 0, Math.PI*2); ctx.fill()
      break
    }
    default: {
      ctx.beginPath(); ctx.arc(0, 0, is*0.35, 0, Math.PI*2); ctx.stroke()
    }
  }

  ctx.restore()
}

/* ══════════════════════════════════════════════════════
   外置标签（防遮挡：标签用引线连接到节点）
   ══════════════════════════════════════════════════════ */

export function drawExternalLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  nodeX: number, nodeY: number,
  nodeRadius: number,
  placement: 'above' | 'below' | 'right',
  isDark: boolean,
  fontSize: number,
): void {
  ctx.save()

  const pad = 4
  ctx.font = `${fontSize}px ui-monospace, monospace`
  const metrics = ctx.measureText(text)
  const tw = metrics.width + pad * 2
  const th = fontSize + pad

  // 计算标签位置（基于放置方向）
  let lx: number, ly: number
  const stemLen = 6 // 引线长度
  switch (placement) {
    case 'above':
      lx = nodeX - tw / 2
      ly = nodeY - nodeRadius - stemLen - th
      break
    case 'below':
      lx = nodeX - tw / 2
      ly = nodeY + nodeRadius + stemLen
      break
    case 'right':
      lx = nodeX + nodeRadius + stemLen
      ly = nodeY - th / 2
      break
  }

  // 引线（从节点边缘到标签）
  ctx.strokeStyle = isDark ? 'rgba(110, 118, 129, 0.3)' : 'rgba(100, 108, 120, 0.3)'
  ctx.lineWidth = 1
  ctx.beginPath()
  if (placement === 'above') {
    ctx.moveTo(nodeX, nodeY - nodeRadius)
    ctx.lineTo(nodeX, ly + th)
  } else if (placement === 'below') {
    ctx.moveTo(nodeX, nodeY + nodeRadius)
    ctx.lineTo(nodeX, ly)
  } else {
    ctx.moveTo(nodeX + nodeRadius, nodeY)
    ctx.lineTo(lx, nodeY)
  }
  ctx.stroke()

  // 标签底衬
  ctx.fillStyle = isDark ? 'rgba(13, 17, 23, 0.85)' : 'rgba(255, 255, 255, 0.85)'
  ctx.strokeStyle = isDark ? 'rgba(48, 54, 61, 0.5)' : 'rgba(208, 215, 222, 0.5)'
  ctx.lineWidth = 0.5
  ctx.beginPath()
  ctx.roundRect(lx, ly, tw, th, 2)
  ctx.fill()
  ctx.stroke()

  // 标签文字
  ctx.fillStyle = isDark ? '#9DA7B3' : '#57606A'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, lx + tw / 2, ly + th / 2)

  ctx.restore()
}
