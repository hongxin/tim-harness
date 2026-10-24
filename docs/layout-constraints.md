# 可视化布局约束系统（Layout Constraint System）

## 用户的三条核心原则

### 原则一：折叠原则（Folding Principle）
> 同一类型对象变多后，不能简单平铺（会横向/纵向极度拉伸）。
> 适当折叠/简化，不失重点。人类会脑补重复性内容。
> 重点突出正在运行的部分，时间越久越淡化。

### 原则二：学习原则（Learning from Anatomy）
> 不是无意义的来回修改，而是真正理解人类直观需要的可视化安排。

### 原则三：不遮挡原则（Non-Overlap Principle）
> - 不同对象之间避免相互遮挡
> - 文字不超出所属对象的边界（放不下则截断为"..."）
> - 单个物体不溢出到成组容器之外

## 从原则推导的检查规则

### R1: 文字边界约束
```
规则：文字渲染宽度 ≤ 容器宽度 - 左右 padding（各 8px）
检查：ctx.measureText(text).width <= containerWidth - 16
违反时：截断为 text.slice(0, n) + '…'，n 从大到小试
```

### R2: 容器嵌套约束
```
规则：子元素边界必须在父容器边界内
检查：child.x >= parent.x && child.x + child.w <= parent.x + parent.w
      child.y >= parent.y && child.y + child.h <= parent.y + parent.h
违反时：重新计算子元素尺寸
```

### R3: 同级不重叠约束
```
规则：同级元素之间不重叠（视觉上可分辨）
检查：!rectsOverlap(a, b) 对所有同级对
违反时：推开或折叠
```

### R4: 时间淡化约束
```
规则：越老的回合视觉权重越低
参数：alpha = max(0.3, 1 - ageInTurns / maxTurns * 0.7)
最近回合 alpha = 1.0
次近回合 alpha ≈ 0.8
最老回合 alpha ≈ 0.3~0.5
```

### R5: 重复折叠约束
```
规则：同类工具连续出现 ≥ 3 次时，折叠为 "read_file × 3"
触发：countInARow(toolName) >= 3
展开：点击折叠项展开明细
```

### R6: 视口适配约束
```
规则：所有内容必须在画布可视区域内
检查：totalContentWidth * zoom <= canvasWidth
      totalContentHeight * zoom <= canvasHeight
违反时：自动缩小或允许滚动
```

### R7: 重点突出约束
```
规则：正在运行的元素视觉权重最高
参数：isRunning ? { glow: true, alpha: 1, scale: 1.1 } : normal
```

## 实施架构

```typescript
interface LayoutConstraint {
  name: string
  check: (layout: LayoutData) => Violation[]
  fix: (layout: LayoutData, violation: Violation) => LayoutData
}

// 检查流程
const constraints = [textBound, containerNesting, siblingOverlap, viewportFit]
const violations = constraints.flatMap(c => c.check(layout))
const fixedLayout = violations.reduce((l, v) => v.fix(l, v), layout)
```
