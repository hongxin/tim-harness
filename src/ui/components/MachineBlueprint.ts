/**
 * MachineBlueprint —— 语义解析器（Anatomy 编译器第一层）
 *
 * 纯函数：从会话消息流提取"工厂蓝图"
 * 零 LLM 调用，纯规则映射，微秒级解析
 */

/* ═════════════════════════════════════════════════
   蓝图数据结构
   ═════════════════════════════════════════════════ */

export interface Station {
  id: string
  /** 工位类型（决定绘制样式） */
  type: StationType
  /** 显示名 */
  label: string
  /** 在装配线上的位置（引擎计算） */
  x: number; y: number
  /** 运行状态 */
  status: 'running' | 'done' | 'error' | 'idle'
  /** 耗时 */
  durationMs: number
  /** 所属回合 */
  turnId: number
  /** 参数预览 */
  detail: string
}

export type StationType =
  | 'input-funnel'    // 用户输入
  | 'thinking-gear'   // 智能体推理
  | 'reader'          // read_file
  | 'writer'          // write_file
  | 'editor'          // edit_file
  | 'reactor'         // run_js
  | 'screener'        // grep/glob
  | 'lister'          // ls
  | 'fetcher'         // web_fetch
  | 'searcher'        // web_search
  | 'planner'         // todo_write
  | 'cloner'          // spawn_agent
  | 'asker'           // ask_user
  | 'loader'          // skill
  | 'tracker'         // goal_update
  | 'archiver'        // snapshot
  | 'output-chute'    // 最终输出
  | 'compressor'      // 压缩核心

export interface Conveyor {
  fromStation: string
  toStation: string
  /** 传送带类型 */
  type: 'main' | 'branch' | 'return' | 'bypass'
}

export interface Gauge {
  type: 'fuel' | 'level' | 'efficiency' | 'alert'
  value: number
  maxValue: number
  label: string
  x: number; y: number
}

export interface MachineBlueprint {
  stations: Station[]
  conveyors: Conveyor[]
  gauges: Gauge[]
  /** 装配线总长度（用于布局） */
  totalStages: number
}

/* ═════════════════════════════════════════════════
   工具 → 工位类型 映射表（规则引擎核心）
   ═════════════════════════════════════════════════ */

const TOOL_STATION: Record<string, StationType> = {
  read_file: 'reader',
  write_file: 'writer',
  edit_file: 'editor',
  run_js: 'reactor',
  grep: 'screener',
  glob: 'screener',
  ls: 'lister',
  web_fetch: 'fetcher',
  web_search: 'searcher',
  todo_write: 'planner',
  spawn_agent: 'cloner',
  ask_user: 'asker',
  skill: 'loader',
  goal_update: 'tracker',
  snapshot_save: 'archiver',
  snapshot_restore: 'archiver',
  snapshot_list: 'archiver',
  snapshot_diff: 'archiver',
  snapshot_delete: 'archiver',
}

/* ═════════════════════════════════════════════════
   解析器：消息流 → 蓝图
   ═════════════════════════════════════════════════ */

export function parseBlueprint(
  msgs: Array<{
    role: string; content?: string | null
    tool_calls?: Array<{ id: string; name: string }>
    tool_call_id?: string; name?: string
    toolOk?: boolean; durationMs?: number
  }>,
  folded: number,
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number },
  contextInfo?: { sentChars: number; budgetChars: number; masked?: boolean },
): MachineBlueprint {
  const stations: Station[] = []
  const conveyors: Conveyor[] = []
  const gauges: Gauge[] = []
  let turn = 0
  let prevId: string | null = null
  let sIdx = 0

  const addStation = (st: Omit<Station, 'id' | 'x' | 'y'>) => {
    const id = `st${sIdx++}`
    stations.push({ ...st, id, x: 0, y: 0 })
    if (prevId) conveyors.push({ fromStation: prevId, toStation: id, type: 'main' })
    prevId = id
    return id
  }

  // 压缩核心
  if (folded > 0) {
    addStation({
      type: 'compressor', label: `⚡ ${folded} 条已压缩`,
      status: 'done', durationMs: 0, turnId: -1, detail: '历史会话已压缩存储',
    })
  }

  const visible = msgs.slice(folded)
  let i = 0

  while (i < visible.length) {
    const msg = visible[i]

    if (msg.role === 'user') {
      turn++
      addStation({
        type: 'input-funnel', label: (msg.content ?? '').slice(0, 40),
        status: 'done', durationMs: 0, turnId: turn, detail: msg.content ?? '',
      })
      i++
      continue
    }

    if (msg.role === 'assistant') {
      // 推理工位
      const hasTools = (msg.tool_calls?.length ?? 0) > 0
      addStation({
        type: 'thinking-gear',
        label: hasTools ? `推理 + ${msg.tool_calls!.length} 工具` : (msg.content ?? '').slice(0, 30),
        status: 'done', durationMs: 0, turnId: turn,
        detail: msg.content ?? '',
      })

      // 工具工位
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const stationType = TOOL_STATION[tc.name] ?? 'reactor'
          // 查找对应的工具结果
          const result = visible.find(
            (m) => m.role === 'tool' && m.tool_call_id === tc.id
          )
          addStation({
            type: stationType, label: tc.name,
            status: result ? (result.toolOk === false ? 'error' : 'done') : 'running',
            durationMs: result?.durationMs ?? 0, turnId: turn,
            detail: result?.content?.slice(0, 60) ?? '',
          })
        }
      }
      i++
      continue
    }

    if (msg.role === 'tool') {
      i++ // 工具结果已在上面处理
      continue
    }

    i++
  }

  // 最终输出工位
  if (stations.length > 0) {
    addStation({
      type: 'output-chute', label: '最终输出',
      status: 'done', durationMs: 0, turnId: turn, detail: '',
    })
  }

  // ═══ 仪表 ═══
  if (usage?.total_tokens) {
    gauges.push({
      type: 'fuel', value: usage.total_tokens, maxValue: 100000,
      label: 'Token 燃料', x: 0, y: 0,
    })
  }
  if (contextInfo) {
    gauges.push({
      type: 'level', value: contextInfo.sentChars, maxValue: contextInfo.budgetChars,
      label: '上下文液位', x: 0, y: 0,
    })
  }

  return {
    stations,
    conveyors,
    gauges,
    totalStages: stations.length,
  }
}

/* ═════════════════════════════════════════════════
   布局器：蓝图 → 空间坐标
   ═════════════════════════════════════════════════ */

/* ═════════════════════════════════════════════════
   工厂车间布局（非线性装配线）
   
   问题：线性装配线在多回合下退化为一条细长的线
   解法：像真实工厂一样——工位单元紧凑排列在车间地板上
   
   布局策略：
   - 每个回合 = 一个"工作单元"（WorkCell）
   - 单元内部：📥漏斗(上) → ⚙️齿轮(中) → 🔧工具群(下)
   - 单元排列：从左到右，到达宽度上限后换行（像文字换行）
   - 整体形状保持接近方形，不会无限拉长
   ═════════════════════════════════════════════════ */

export const CELL_W = 260    // 单元宽
export const CELL_H = 200    // 单元高
export const CELL_GAP = 30   // 单元间距
export const MAX_CELLS_PER_ROW = 4 // 每行最多单元数

export function layoutBlueprint(bp: MachineBlueprint): MachineBlueprint {
  // 按回合分组
  const cells = new Map<number, Station[]>()
  for (const st of bp.stations) {
    const tid = st.turnId
    if (!cells.has(tid)) cells.set(tid, [])
    cells.get(tid)!.push(st)
  }

  // 布局每个单元
  const cellIds = Array.from(cells.keys()).sort((a, b) => a - b)
  let cellIndex = 0

  for (const tid of cellIds) {
    const cellStations = cells.get(tid)!
    const row = Math.floor(cellIndex / MAX_CELLS_PER_ROW)
    const col = cellIndex % MAX_CELLS_PER_ROW
    
    // 单元左上角坐标（蛇形排列）
    const cellX = col * (CELL_W + CELL_GAP)
    const cellY = row * (CELL_H + CELL_GAP)
    
    // 单元内部布局
    const funnels = cellStations.filter(s => s.type === 'input-funnel')
    const gears = cellStations.filter(s => s.type === 'thinking-gear')
    const tools = cellStations.filter(s => !['input-funnel','thinking-gear','output-chute','compressor'].includes(s.type))
    const outputs = cellStations.filter(s => s.type === 'output-chute')
    const compressors = cellStations.filter(s => s.type === 'compressor')
    
    // 📥 输入漏斗：左上
    for (const f of funnels) {
      f.x = cellX + 40
      f.y = cellY + 40
    }
    
    // ⚙️ 推理齿轮：右上
    for (const g of gears) {
      g.x = cellX + CELL_W - 60
      g.y = cellY + 40
    }
    
    // 🔧 工具群：下方网格（紧凑排列，最多 2 行）
    const toolCols = Math.min(tools.length, 4)
        tools.forEach((t, ti) => {
      const tc = ti % toolCols
      const tr = Math.floor(ti / toolCols)
      t.x = cellX + 40 + tc * 55
      t.y = cellY + 110 + tr * 55
    })
    
    // 📤 输出：右下角（如果有）
    for (const o of outputs) {
      o.x = cellX + CELL_W - 50
      o.y = cellY + CELL_H - 40
    }
    
    // ⚡ 压缩机：左下角
    for (const c of compressors) {
      c.x = cellX + 30
      c.y = cellY + CELL_H - 40
    }
    
    cellIndex++
  }

  // 仪表：右上角固定区域
  bp.gauges.forEach((g, gi) => {
    g.x = 0
    g.y = gi * 35
  })

  return bp
}
