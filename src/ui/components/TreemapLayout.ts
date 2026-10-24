/**
 * Treemap 布局器 —— 面积编码复杂度的空间填充布局
 *
 * 参考 Treemap 可视化思想：
 * - 面积 = 数据值（回合的工位数/耗时 → 卡片面积）
 * - 空间填充（零浪费，卡片紧邻）
 * - 层次包含（卡片内嵌套工具区）
 *
 * 算法：简化版 Squarified Treemap（保持宽高比接近 1）
 */

import type { MachineBlueprint, Station } from './MachineBlueprint'

export interface TreemapCell {
  /** 回合 ID */
  turnId: number
  /** 卡片矩形 */
  x: number; y: number; w: number; h: number
  /** 内部工位及其子矩形 */
  items: Array<{ station: Station; x: number; y: number; w: number; h: number }>
  /** 权重（决定面积） */
  weight: number
  /** 标签 */
  label: string
}

/**
 * 计算回合权重（面积分配依据）
 * 权重 = 工具数 × 1.0 + 推理次数 × 0.6 + 1（基础面积）
 */
function stationWeight(stations: Station[]): number {
  let w = 0
  for (const st of stations) {
    if (st.type === 'input-funnel' || st.type === 'compressor') w += 0.5
    else if (st.type === 'thinking-gear') w += 0.8
    else if (st.type === 'output-chute') w += 0.3
    else w += 1.0 // 工具工位
  }
  return Math.max(w, 1) // 最小面积
}

/**
 * 简化版 Squarified 算法
 * 输入：总区域 + 权重列表 → 输出：各单元格矩形
 */
function squarify(
  items: Array<{ id: number; weight: number }>,
  totalX: number, totalY: number, totalW: number, totalH: number,
): Map<number, { x: number; y: number; w: number; h: number }> {
  const result = new Map<number, { x: number; y: number; w: number; h: number }>()
  const totalWeight = items.reduce((s, i) => s + i.weight, 0)
  if (totalWeight === 0) return result

  let remaining = items.slice()
  let rx = totalX, ry = totalY, rw = totalW, rh = totalH
  let remainingWeight = totalWeight

  while (remaining.length > 0) {
    // 决定切割方向（沿短边切）
    const isHorizontal = rw > rh // 宽 > 高 → 垂直切（分列）
    
    // 取出下一个（贪心：取权重最大的保持方形）
    const item = remaining[0]
    const ratio = item.weight / remainingWeight
    
    if (isHorizontal) {
      // 垂直切：item 占左侧 ratio 比例的宽度
      const itemW = rw * ratio
      result.set(item.id, { x: rx, y: ry, w: itemW, h: rh })
      rx += itemW
      rw -= itemW
    } else {
      // 水平切：item 占上方 ratio 比例的高度
      const itemH = rh * ratio
      result.set(item.id, { x: rx, y: ry, w: rw, h: itemH })
      ry += itemH
      rh -= itemH
    }
    
    remaining = remaining.slice(1)
    remainingWeight -= item.weight
  }

  return result
}

/**
 * Treemap 布局：从蓝图生成 Treemap 单元格
 */
export function layoutTreemap(
  bp: MachineBlueprint,
  totalW: number = 1200,
  totalH: number = 800,
  padding: number = 4,
  headerH: number = 24,
): TreemapCell[] {
  // 按回合分组
  const cells = new Map<number, Station[]>()
  for (const st of bp.stations) {
    if (!cells.has(st.turnId)) cells.set(st.turnId, [])
    cells.get(st.turnId)!.push(st)
  }

  // 计算权重
  const items = Array.from(cells.entries()).map(([tid, stations]) => ({
    id: tid,
    weight: stationWeight(stations),
  })).sort((a, b) => b.weight - a.weight) // 大权重优先

  // Squarified 分割
  const rects = squarify(items, 0, 0, totalW, totalH)

  // 生成单元格（含内部工具布局）
  const result: TreemapCell[] = []
  for (const [tid, rect] of rects) {
    const stations = cells.get(tid) ?? []
    
    // 卡片内边距
    const cx = rect.x + padding
    const cy = rect.y + padding
    const cw = rect.w - padding * 2
    const ch = rect.h - padding * 2

    // 标题栏区域
    const bodyY = cy + headerH
    const bodyH = ch - headerH

    // 内部工位布局：
    // 顶部一行：📥(左) ⚙️(右)
    // 剩余区域：工具 treemap（面积 = 耗时）
    const tools = stations.filter(s => 
      !['input-funnel', 'thinking-gear', 'output-chute', 'compressor'].includes(s.type)
    )
    const funnels = stations.filter(s => s.type === 'input-funnel')
    const gears = stations.filter(s => s.type === 'thinking-gear')
    const outputs = stations.filter(s => s.type === 'output-chute')
    const compressors = stations.filter(s => s.type === 'compressor')

    const items: TreemapCell['items'] = []

    // 📥 和 ⚙️ 在标题栏行
    const headerY = cy + headerH / 2
    if (funnels[0]) items.push({ station: funnels[0], x: cx + 16, y: headerY, w: 24, h: 24 })
    if (gears[0]) items.push({ station: gears[0], x: cx + cw - 16, y: headerY, w: 24, h: 24 })

    // 🔧 工具区（简化的 treemap：按耗时分配面积）
    const toolAreaY = bodyY + 8
    const toolAreaH = bodyH - 16
    const toolAreaW = cw - 16
    const toolAreaX = cx + 8

    if (tools.length > 0 && toolAreaH > 20) {
      const totalDur = tools.reduce((s, t) => s + Math.max(t.durationMs, 100), 0)
      
      // 单行或双行排列（简化，不做完整递归 treemap）
      const cols = Math.min(tools.length, Math.max(3, Math.floor(toolAreaW / 55)))
      const rows = Math.ceil(tools.length / cols)
      const cellW = toolAreaW / cols
      const cellH = toolAreaH / rows

      tools.forEach((t, ti) => {
        const tc = ti % cols
        const tr = Math.floor(ti / cols)
        const durRatio = Math.max(t.durationMs, 100) / totalDur
        // 工位大小按耗时加权（最小 70%）
        const sizeRatio = 0.7 + durRatio * 0.3
        const iw = Math.min(cellW * sizeRatio, 45)
        const ih = Math.min(cellH * sizeRatio, 45)
        items.push({
          station: t,
          x: toolAreaX + tc * cellW + cellW / 2,
          y: toolAreaY + tr * cellH + cellH / 2,
          w: iw, h: ih,
        })
      })
    }

    // 📤 输出（如果有）
    if (outputs[0] && bodyH > 40) {
      items.push({ station: outputs[0], x: cx + cw - 16, y: cy + ch - 14, w: 20, h: 20 })
    }

    // ⚡ 压缩机（如果有）
    if (compressors[0] && bodyH > 40) {
      items.push({ station: compressors[0], x: cx + 16, y: cy + ch - 14, w: 20, h: 20 })
    }

    result.push({
      turnId: tid,
      x: cx, y: cy, w: cw, h: ch,
      items,
      weight: stationWeight(stations),
      label: `回合 ${tid + 1}`,
    })
  }

  return result
}
