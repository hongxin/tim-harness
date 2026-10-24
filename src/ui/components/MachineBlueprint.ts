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

export const STATION_W = 120   // 工位宽
export const STATION_GAP = 40  // 工位间距
export const LINE_Y = 0        // 主轴 Y
export const BRANCH_Y = 100    // 分支 Y（工具工位）

export function layoutBlueprint(bp: MachineBlueprint): MachineBlueprint {
  let x = 0

  for (const st of bp.stations) {
    // 判断是否是工具工位（放在分支行）
    const isTool = [
      'reader', 'writer', 'editor', 'reactor', 'screener',
      'lister', 'fetcher', 'searcher', 'planner', 'cloner',
      'asker', 'loader', 'tracker', 'archiver',
    ].includes(st.type)

    if (isTool) {
      // 工具工位：放在主轴下方（分支行），紧凑排列
      st.x = x - STATION_W / 2
      st.y = BRANCH_Y
      x += STATION_W * 0.6 // 工具间距更紧凑
    } else {
      // 主轴工位：放在主轴上
      st.x = x
      st.y = LINE_Y
      x += STATION_W + STATION_GAP
    }
  }

  // 仪表位置（右上角区域）
  bp.gauges.forEach((g, gi) => {
    g.x = x + 20
    g.y = -60 + gi * 50
  })

  return bp
}
