/**
 * LayoutGuard —— 布局约束系统
 *
 * 核心理念：不是事后修复，而是渲染前预防。
 * 每次绘制前先检查约束，违反则自动修正。
 *
 * 三条用户原则 → 七条可执行规则
 */

/* ═════════════════════════════════════════════════
   类型
   ═════════════════════════════════════════════════ */

export interface Rect {
  x: number; y: number; w: number; h: number
}

export interface LayoutContext {
  ctx: CanvasRenderingContext2D
  canvasW: number; canvasH: number
  zoom: number
}

/* ═════════════════════════════════════════════════
   R1: 文字边界约束
   文字不得超出容器宽度，放不下则截断
   ═════════════════════════════════════════════════ */

const TEXT_PADDING = 8 // 左右各 8px

export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (maxWidth <= TEXT_PADDING * 2) return ''

  const availW = maxWidth - TEXT_PADDING * 2
  const metrics = ctx.measureText(text)

  if (metrics.width <= availW) return text

  // 二分查找最大可显示字符数
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate = text.slice(0, mid) + '…'
    if (ctx.measureText(candidate).width <= availW) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  return text.slice(0, lo) + '…'
}

/** 安全绘制文字：自动截断 + 返回实际绘制宽度 */
export function drawTextSafe(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number, y: number,
  maxWidth: number,
  align: 'left' | 'center' | 'right' = 'left',
): number {
  const fitted = fitText(ctx, text, maxWidth)
  ctx.textAlign = align
  ctx.fillText(fitted, x, y)
  return ctx.measureText(fitted).width
}

/* ═════════════════════════════════════════════════
   R2: 容器嵌套约束
   子元素必须在父容器边界内
   ═════════════════════════════════════════════════ */

export function clampToParent(
  child: Rect,
  parent: Rect,
): Rect {
  return {
    x: Math.max(parent.x, Math.min(child.x, parent.x + parent.w - child.w)),
    y: Math.max(parent.y, Math.min(child.y, parent.y + parent.h - child.h)),
    w: Math.min(child.w, parent.w),
    h: Math.min(child.h, parent.h),
  }
}

/* ═════════════════════════════════════════════════
   R3: 同级不重叠
   ═════════════════════════════════════════════════ */

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y
}

/** 推开重叠的矩形（b 往下移直到不重叠） */
export function pushApart(a: Rect, b: Rect, gap: number = 4): Rect {
  if (!rectsOverlap(a, b)) return b
  return { ...b, y: a.y + a.h + gap }
}

/* ═════════════════════════════════════════════════
   R4: 时间淡化
   越老的回合 alpha 越低
   ═════════════════════════════════════════════════ */

/**
 * 计算基于"新近度"的透明度
 * 最新回合 = 1.0（全亮）
 * 中间回合 = 线性衰减
 * 最老回合 = 最低 0.3（仍可辨但淡化）
 */
export function temporalAlpha(
  turnIndex: number,
  totalTurns: number,
): number {
  if (totalTurns <= 1) return 1.0
  // 最新（turnIndex = totalTurns - 1）→ 1.0
  // 最老（turnIndex = 0）→ 0.5
  const ageFromNewest = totalTurns - 1 - turnIndex
  const maxAge = totalTurns - 1
  const ratio = maxAge === 0 ? 0 : ageFromNewest / maxAge
  return 1.0 - ratio * 0.5 // 1.0 → 0.5 (淡化但不消失)
}

/* ═════════════════════════════════════════════════
   R5: 重复折叠
   连续同类工具 ≥ 3 次时折叠
   ═════════════════════════════════════════════════ */

export interface FoldableTool {
  name: string
  ok: boolean
  dur: number
  desc?: string
}

/**
 * 检测连续同类工具并折叠
 * 输出：折叠后的工具列表（保留一个代表 + 计数）
 */
export function foldRepeats(
  tools: FoldableTool[],
  threshold: number = 3,
): Array<FoldableTool & { count?: number; folded?: boolean }> {
  const result: Array<FoldableTool & { count?: number; folded?: boolean }> = []
  let i = 0

  while (i < tools.length) {
    const current = tools[i]
    let count = 1
    let j = i + 1

    while (j < tools.length &&
           tools[j].name === current.name &&
           tools[j].ok === current.ok) {
      count++
      j++
    }

    if (count >= threshold) {
      result.push({
        ...current,
        count,
        folded: true,
        desc: `${current.desc ?? current.name} ×${count}`,
      })
    } else {
      for (let k = 0; k < count; k++) result.push(tools[i + k])
    }

    i = j
  }

  return result
}

/* ═════════════════════════════════════════════════
   R6: 视口适配
   ═════════════════════════════════════════════════ */

export function fitToViewport(
  contentW: number, contentH: number,
  canvasW: number, canvasH: number,
  maxZoom: number = 1.0,
  padding: number = 30,
): { zoom: number; offsetX: number; offsetY: number } {
  const availW = canvasW - padding * 2
  const availH = canvasH - padding * 2
  const zoom = Math.min(availW / contentW, availH / contentH, maxZoom)
  const scaledW = contentW * zoom
  const scaledH = contentH * zoom
  return {
    zoom,
    offsetX: (canvasW - scaledW) / 2,
    offsetY: (canvasH - scaledH) / 2,
  }
}

/* ═════════════════════════════════════════════════
   R7: 重点突出
   ═════════════════════════════════════════════════ */

export function emphasisScale(isRunning: boolean): number {
  return isRunning ? 1.1 : 1.0
}

export function emphasisGlow(isRunning: boolean, baseAlpha: number): number {
  return isRunning ? Math.max(baseAlpha, 0.15) : baseAlpha
}

/* ═════════════════════════════════════════════════
   综合检查器
   ═════════════════════════════════════════════════ */

export interface Violation {
  rule: string
  message: string
  rect?: Rect
}

export function checkLayout(
  elements: Array<{ id: string; rect: Rect; parent?: string }>,
  allRects: Map<string, Rect>,
): Violation[] {
  const violations: Violation[] = []

  // R2: 嵌套检查
  for (const el of elements) {
    if (el.parent && allRects.has(el.parent)) {
      const parent = allRects.get(el.parent)!
      const child = el.rect
      if (child.x < parent.x || child.x + child.w > parent.x + parent.w ||
          child.y < parent.y || child.y + child.h > parent.y + parent.h) {
        violations.push({
          rule: 'R2:container-nesting',
          message: `${el.id} overflows parent ${el.parent}`,
          rect: child,
        })
      }
    }
  }

  // R3: 同级重叠检查
  const siblings = elements.filter(e => !e.parent || e.parent === '')
  for (let i = 0; i < siblings.length; i++) {
    for (let j = i + 1; j < siblings.length; j++) {
      if (rectsOverlap(siblings[i].rect, siblings[j].rect)) {
        violations.push({
          rule: 'R3:sibling-overlap',
          message: `${siblings[i].id} overlaps ${siblings[j].id}`,
        })
      }
    }
  }

  return violations
}
