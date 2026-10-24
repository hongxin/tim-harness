/**
 * BattlefieldRenderer —— 智能体战场渲染器（Three.js / 红警暴兵模式）
 *
 * 核心理念：AI 的工作 = 一场实时战略游戏
 *   回合 = 生产建筑（兵营）
 *   工具调用 = 作战单位（坦克/侦察兵/工程兵）
 *   Token = 资源（金币）
 *   上下文 = 电力
 *   连接 = 能量管道
 *
 * 融合所有已知优点：
 *   Cosmos: 物理飘动、语义缩放、时间淡化
 *   Pipeline: STATION、三级披露、正交连接、锚点
 *   Anatomy: 物体即解释、四色调明暗、实时读数
 *   红警: 暴兵快感、编队系统、战略视角
 */

import * as THREE from 'three'

/* ═════════════════════════════════════════════════
   类型定义
   ═════════════════════════════════════════════════ */

interface BattleTurn {
  turnId: number
  userText: string
  finalText: string
  units: BattleUnit[]
}

interface BattleUnit {
  name: string
  category: string
  ok: boolean
  dur: number
  mesh?: THREE.Object3D
}

interface BattlefieldData {
  turns: BattleTurn[]
  totalTokens: number
  contextUsed: number
  contextMax: number
}

/* ═════════════════════════════════════════════════
   单位设计（每种工具 = 一种作战单位）
   ═════════════════════════════════════════════════ */

const UNIT_SPECS: Record<string, {
  name: string; color: number; size: number; shape: 'box' | 'sphere' | 'cone' | 'octa' | 'cyl'
  emissive: number
}> = {
  read_file:   { name: 'Scout',    color: 0x00FF88, size: 0.4, shape: 'octa',  emissive: 0.2 },
  write_file:  { name: 'Engineer', color: 0xFF8C00, size: 0.5, shape: 'box',   emissive: 0.3 },
  edit_file:   { name: 'Tech',     color: 0xFF69B4, size: 0.35, shape: 'box',  emissive: 0.2 },
  run_js:      { name: 'Tank',     color: 0x00E5FF, size: 0.7, shape: 'box',   emissive: 0.5 },
  grep:        { name: 'Radar',    color: 0x00CED1, size: 0.35, shape: 'cone', emissive: 0.3 },
  glob:        { name: 'Radar',    color: 0x00CED1, size: 0.35, shape: 'cone', emissive: 0.3 },
  ls:          { name: 'Scout',    color: 0x98FB98, size: 0.3, shape: 'octa',  emissive: 0.15 },
  web_fetch:   { name: 'Aircraft', color: 0xDDA0DD, size: 0.5, shape: 'cone',  emissive: 0.4 },
  web_search:  { name: 'Drone',    color: 0x87CEEB, size: 0.3, shape: 'sphere',emissive: 0.25 },
  skill:       { name: 'SpecOps',  color: 0xFFD700, size: 0.5, shape: 'octa',  emissive: 0.5 },
  spawn_agent: { name: 'Command',  color: 0xDA70D6, size: 0.8, shape: 'cyl',   emissive: 0.6 },
  todo_write:  { name: 'Strategy', color: 0xFFB347, size: 0.3, shape: 'box',   emissive: 0.2 },
  ask_user:    { name: 'Beacon',   color: 0xFF7F50, size: 0.5, shape: 'cyl',   emissive: 0.4 },
  snapshot_save: { name: 'Vault',  color: 0xA0522D, size: 0.5, shape: 'cyl',   emissive: 0.2 },
}

function getUnitSpec(name: string) {
  return UNIT_SPECS[name] ?? { name: 'Unknown', color: 0x808080, size: 0.4, shape: 'box' as const, emissive: 0.1 }
}

/* ═════════════════════════════════════════════════
   渲染器
   ═════════════════════════════════════════════════ */

export class BattlefieldRenderer {
  private canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private animId = 0
  private data: BattlefieldData | null = null

  // 建筑（STATION）
  private buildings: THREE.Group[] = []
  private buildingData: Map<string, { x: number; z: number; group: THREE.Group }> = new Map()

  // 相机控制
  private isPanning = false
  private panStart = { x: 0, y: 0 }
  private camTarget = new THREE.Vector3(0, 0, 0)
  private camDistance = 30
  private camAngle = Math.PI / 4 // 45° 俯视

  // 拖拽建筑
  private draggingBuilding: string | null = null
  private raycaster = new THREE.Raycaster()
  private mouse = new THREE.Vector2()

  // 动画时间
  private clock = new THREE.Clock()

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500)

    this.setupScene()
    this.bindEvents()
    this.loop()
  }

  destroy() {
    cancelAnimationFrame(this.animId)
    this.renderer.dispose()
  }

  /* ════════════════════════════════════════════════
     场景设置
     ════════════════════════════════════════════════ */

  private setupScene() {
    // 背景（深空蓝）
    this.scene.background = new THREE.Color(0x0A0E14)

    // 雾效（远处淡化 = 时间淡化原则）
    this.scene.fog = new THREE.Fog(0x0A0E14, 40, 120)

    // 光照
    const ambient = new THREE.AmbientLight(0x404040, 0.6)
    this.scene.add(ambient)

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(20, 30, 10)
    this.scene.add(dirLight)

    // 补光（从下方，增加立体感）
    const fillLight = new THREE.DirectionalLight(0x4A9EFF, 0.3)
    fillLight.position.set(-10, 5, -20)
    this.scene.add(fillLight)

    // 地面（深色平面 + 网格）
    const groundGeo = new THREE.PlaneGeometry(300, 300)
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x0D1117,
      roughness: 0.9,
      metalness: 0.1,
    })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = 0
    this.scene.add(ground)

    // 网格线（战术地图感）
    const grid = new THREE.GridHelper(200, 50, 0x30363D, 0x21262D)
    grid.position.y = 0.01
    this.scene.add(grid)

    // 环境粒子（漂浮的尘埃，增加空间感）
    this.createAmbientParticles()
  }

  private createAmbientParticles() {
    const count = 200
    const geometry = new THREE.BufferGeometry()
    const positions = new Float32Array(count * 3)

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 200
      positions[i * 3 + 1] = Math.random() * 30 + 1
      positions[i * 3 + 2] = (Math.random() - 0.5) * 200
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      color: 0x4A9EFF,
      size: 0.15,
      transparent: true,
      opacity: 0.3,
    })
    this.scene.add(new THREE.Points(geometry, material))
  }

  /* ════════════════════════════════════════════════
     数据设置
     ════════════════════════════════════════════════ */

  setData(data: BattlefieldData) {
    this.data = data
    this.clearBuildings()
    this.buildBattlefield(data)
  }

  private clearBuildings() {
    for (const b of this.buildings) {
      this.scene.remove(b)
    }
    this.buildings = []
    this.buildingData.clear()
  }

  /* ════════════════════════════════════════════════
     构建战场
     ════════════════════════════════════════════════ */

  private buildBattlefield(data: BattlefieldData) {
    const turns = data.turns
    const spacing = 12

    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti]
      const building = this.createBuilding(turn, ti, spacing)
      this.buildings.push(building)
      this.scene.add(building)

      // 存储位置（拖拽用）
      const buildingId = String(turn.turnId)
      const pos = this.getBuildingPosition(ti, turns.length, spacing)
      building.position.set(pos.x, 0, pos.z)
      this.buildingData.set(buildingId, { x: pos.x, z: pos.z, group: building })
    }

    // 建筑间连接（能量管道）
    for (let ti = 0; ti < turns.length - 1; ti++) {
      const a = this.buildingData.get(String(turns[ti].turnId))
      const b = this.buildingData.get(String(turns[ti + 1].turnId))
      if (a && b) {
        this.createConnectionBeam(a.group.position, b.group.position)
      }
    }

    // 调整相机以看到全部
    this.fitCamera(turns.length, spacing)
  }

  private getBuildingPosition(index: number, total: number, spacing: number): { x: number; z: number } {
    // 弧形排列（像基地防线）
    const angle = (index / Math.max(total - 1, 1)) * Math.PI * 0.6 - Math.PI * 0.3
    const radius = spacing * Math.max(total / 3, 2)
    return {
      x: Math.sin(angle) * radius,
      z: -Math.cos(angle) * radius + radius * 0.3,
    }
  }

  /* ════════════════════════════════════════════════
     创建生产建筑
     ════════════════════════════════════════════════ */

  private createBuilding(turn: BattleTurn, index: number, spacing: number): THREE.Group {
    const group = new THREE.Group()
    group.name = `building_${turn.turnId}`

    // ═══ 建筑主体（底座平台 + 上升结构）═══
    // 底座（宽大的平台）
    const baseGeo = new THREE.BoxGeometry(6, 0.5, 5)
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x1C2128,
      roughness: 0.7,
      metalness: 0.3,
    })
    const base = new THREE.Mesh(baseGeo, baseMat)
    base.position.y = 0.25
    group.add(base)

    // 建筑主体（中央塔楼）
    const towerGeo = new THREE.BoxGeometry(3.5, 4, 3)
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0x21262D,
      roughness: 0.5,
      metalness: 0.5,
      emissive: 0x161B22,
      emissiveIntensity: 0.5,
    })
    const tower = new THREE.Mesh(towerGeo, towerMat)
    tower.position.y = 2.5
    group.add(tower)

    // 顶部（发光核心）
    const coreGeo = new THREE.OctahedronGeometry(1.2)
    const coreColor = new THREE.Color(0xFFD700) // 金色核心
    const coreMat = new THREE.MeshStandardMaterial({
      color: coreColor,
      emissive: coreColor,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.8,
    })
    const core = new THREE.Mesh(coreGeo, coreMat)
    core.position.y = 5.5
    core.name = 'core'
    group.add(core)

    // ═══ 状态指示灯（顶部信标）═══
    const lightGeo = new THREE.SphereGeometry(0.3, 8, 8)
    const hasError = turn.units.some(u => !u.ok)
    const allDone = turn.units.every(u => u.ok)
    const lightColor = hasError ? 0xFF4444 : allDone ? 0x00FF88 : 0xFFD700
    const lightMat = new THREE.MeshStandardMaterial({
      color: lightColor,
      emissive: lightColor,
      emissiveIntensity: 1.0,
    })
    const light = new THREE.Mesh(lightGeo, lightMat)
    light.position.y = 7
    light.name = 'statusLight'
    group.add(light)

    // ═══ 生产进度条（建筑前面的横条）═══
    const progressRatio = turn.units.length > 0 ? 1 : 0 // 简化：全部完成
    const barGeo = new THREE.BoxGeometry(4, 0.3, 0.1)
    const barBgMat = new THREE.MeshStandardMaterial({ color: 0x30363D })
    const barBg = new THREE.Mesh(barGeo, barBgMat)
    barBg.position.set(0, 1.2, 2.6)
    group.add(barBg)

    const barFillGeo = new THREE.BoxGeometry(4 * progressRatio, 0.25, 0.12)
    const barFillMat = new THREE.MeshStandardMaterial({
      color: 0x00FF88,
      emissive: 0x00FF88,
      emissiveIntensity: 0.5,
    })
    const barFill = new THREE.Mesh(barFillGeo, barFillMat)
    barFill.position.set(-4 * (1 - progressRatio) / 2, 1.2, 2.65)
    group.add(barFill)

    // ═══ 输入/输出能量门（锚点）═══
    // 输入门（左侧，绿色）
    const inGateGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 8)
    const inGateMat = new THREE.MeshStandardMaterial({
      color: 0x00FF88,
      emissive: 0x00FF88,
      emissiveIntensity: 0.5,
    })
    const inGate = new THREE.Mesh(inGateGeo, inGateMat)
    inGate.rotation.z = Math.PI / 2
    inGate.position.set(-3.2, 1.5, 0)
    inGate.name = 'inputGate'
    group.add(inGate)

    // 输出门（右侧，蓝色）
    const outGateMat = new THREE.MeshStandardMaterial({
      color: 0x4A9EFF,
      emissive: 0x4A9EFF,
      emissiveIntensity: 0.5,
    })
    const outGate = new THREE.Mesh(inGateGeo, outGateMat)
    outGate.rotation.z = Math.PI / 2
    outGate.position.set(3.2, 1.5, 0)
    outGate.name = 'outputGate'
    group.add(outGate)

    // ═══ 已生产的单位（围绕建筑编队）═══
    this.createUnitsAroundBuilding(group, turn)

    return group
  }

  /* ════════════════════════════════════════════════
     创建单位（围绕建筑编队排列）
     ════════════════════════════════════════════════ */

  private createUnitsAroundBuilding(building: THREE.Group, turn: BattleTurn) {
    const maxUnits = 20 // 最多显示 20 个单位（折叠原则）
    const units = turn.units.slice(0, maxUnits)
    const total = turn.units.length
    const perRow = 6
    const unitSpacing = 1.2

    for (let ui = 0; ui < units.length; ui++) {
      const unit = units[ui]
      const spec = getUnitSpec(unit.name)

      // 编队位置（建筑前方网格排列）
      const row = Math.floor(ui / perRow)
      const col = ui % perRow
      const ufx = (col - (perRow - 1) / 2) * unitSpacing
      const ufz = 4 + row * unitSpacing // 建筑前方

      // 创建单位 mesh
      const unitMesh = this.createUnitMesh(unit, spec)
      unitMesh.position.set(ufx, 0.3, ufz)
      building.add(unitMesh)
    }

    // 如果有更多单位，显示 "+N" 标记（折叠原则）
    if (total > maxUnits) {
      // 用一个更大的发光体表示剩余单位
      const extraGeo = new THREE.SphereGeometry(0.5)
      const extraMat = new THREE.MeshStandardMaterial({
        color: 0x4A9EFF,
        emissive: 0x4A9EFF,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.5,
      })
      const extra = new THREE.Mesh(extraGeo, extraMat)
      const row = Math.floor((maxUnits - 1) / perRow)
      extra.position.set(0, 0.8, 4 + (row + 1) * unitSpacing)
      extra.name = `extra_${total - maxUnits}`
      building.add(extra)
    }
  }

  private createUnitMesh(unit: BattleUnit, spec: ReturnType<typeof getUnitSpec>): THREE.Mesh {
    let geometry: THREE.BufferGeometry

    switch (spec.shape) {
      case 'sphere':
        geometry = new THREE.SphereGeometry(spec.size, 12, 8)
        break
      case 'cone':
        geometry = new THREE.ConeGeometry(spec.size, spec.size * 2, 6)
        break
      case 'octa':
        geometry = new THREE.OctahedronGeometry(spec.size)
        break
      case 'cyl':
        geometry = new THREE.CylinderGeometry(spec.size * 0.5, spec.size, spec.size * 1.5, 8)
        break
      default: // box
        geometry = new THREE.BoxGeometry(spec.size, spec.size, spec.size)
    }

    // 失败的单位用红色
    const color = unit.ok ? spec.color : 0xFF4444
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: unit.ok ? spec.emissive : 0.8,
      roughness: 0.4,
      metalness: 0.3,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `unit_${unit.name}_${Math.random().toString(36).slice(2, 6)}`
    return mesh
  }

  /* ════════════════════════════════════════════════
     连接管道（建筑间能量管道）
     ════════════════════════════════════════════════ */

  private connectionBeams: THREE.Mesh[] = []

  private createConnectionBeam(from: THREE.Vector3, to: THREE.Vector3) {
    // 创建拱形管道
    const mid = from.clone().lerp(to, 0.5)
    mid.y += 3 // 拱起

    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(from.x + 3.5, 1.5, from.z), // 输出门位置
      mid,
      new THREE.Vector3(to.x - 3.5, 1.5, to.z),     // 输入门位置
    ])

    const tubeGeo = new THREE.TubeGeometry(curve, 32, 0.12, 8)
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x4A9EFF,
      emissive: 0x4A9EFF,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.5,
    })

    const beam = new THREE.Mesh(tubeGeo, tubeMat)
    this.scene.add(beam)
    this.connectionBeams.push(beam)
  }

  /* ════════════════════════════════════════════════
     相机
     ════════════════════════════════════════════════ */

  private fitCamera(turnCount: number, spacing: number) {
    const radius = spacing * Math.max(turnCount / 3, 2)
    this.camDistance = radius * 2.5 + 15
    this.camTarget.set(0, 0, 0)
  }

  private updateCamera() {
    const t = this.clock.getElapsedTime()
    const x = this.camTarget.x + Math.sin(this.camAngle) * this.camDistance
    const z = this.camTarget.z + Math.cos(this.camAngle) * this.camDistance
    const y = this.camTarget.y + this.camDistance * 0.7
    this.camera.position.set(x, y, z)
    this.camera.lookAt(this.camTarget)
  }

  /* ════════════════════════════════════════════════
     事件处理
     ════════════════════════════════════════════════ */

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

  private onResize = () => {
    const parent = this.canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth, h = parent.clientHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.camDistance = Math.max(10, Math.min(100, this.camDistance * (e.deltaY > 0 ? 1.1 : 0.9)))
  }

  private onDown = (e: PointerEvent) => {
    this.isPanning = true
    this.panStart = { x: e.clientX, y: e.clientY }
  }

  private onMove = (e: PointerEvent) => {
    if (this.isPanning) {
      const dx = e.clientX - this.panStart.x
      const dy = e.clientY - this.panStart.y
      this.panStart = { x: e.clientX, y: e.clientY }

      // 平移（沿着地面方向）
      const panSpeed = this.camDistance * 0.002
      this.camTarget.x -= dx * panSpeed
      this.camTarget.z -= dy * panSpeed
    }
  }

  private onUp = () => {
    this.isPanning = false
  }

  /* ════════════════════════════════════════════════
     动画循环
     ════════════════════════════════════════════════ */

  private loop = () => {
    const dt = this.clock.getDelta()
    const t = this.clock.getElapsedTime()

    // 建筑动画
    for (const building of this.buildings) {
      // 核心旋转
      const core = building.getObjectByName('core')
      if (core) {
        core.rotation.y = t * 0.5
        core.position.y = 5.5 + Math.sin(t * 2) * 0.2 // 呼吸浮动
      }

      // 状态灯闪烁
      const light = building.getObjectByName('statusLight')
      if (light) {
        const mat = (light as THREE.Mesh).material as THREE.MeshStandardMaterial
        if (mat.color.getHex() === 0xFF4444) {
          // 错误状态闪烁
          mat.emissiveIntensity = 0.5 + 0.5 * Math.sin(t * 5)
        }
      }

      // 单位微动（编队中的单位轻微浮动）
      building.children.forEach((child, idx) => {
        if (child.name.startsWith('unit_')) {
          child.position.y = 0.3 + Math.sin(t * 3 + idx * 0.5) * 0.05
          child.rotation.y = t * 0.3 + idx
        }
      })
    }

    // 管道脉动
    for (const beam of this.connectionBeams) {
      const mat = beam.material as THREE.MeshStandardMaterial
      mat.emissiveIntensity = 0.3 + 0.2 * Math.sin(t * 3)
    }

    this.updateCamera()
    this.renderer.render(this.scene, this.camera)
    this.animId = requestAnimationFrame(this.loop)
  }
}

/* ═════════════════════════════════════════════════
   数据解析（从会话消息 → 战场数据）
   ═════════════════════════════════════════════════ */

export function parseBattlefieldData(
  msgs: Array<{
    role: string; content?: string | null
    tool_calls?: Array<{ id: string; name: string }>
    tool_call_id?: string; name?: string
    toolOk?: boolean; durationMs?: number
  }>,
  folded: number,
  usage?: { total_tokens?: number },
  contextInfo?: { sentChars: number; budgetChars: number },
): BattlefieldData {
  const turns: BattleTurn[] = []
  let current: BattleTurn | null = null

  const TOOL_CAT: Record<string, string> = {
    read_file: 'read', write_file: 'write', edit_file: 'edit',
    run_js: 'exec', grep: 'search', glob: 'search', ls: 'browse',
    web_fetch: 'fetch', web_search: 'search', skill: 'skill',
    spawn_agent: 'spawn', todo_write: 'plan', ask_user: 'ask',
    snapshot_save: 'save',
  }

  for (let mi = 0; mi < msgs.length; mi++) {
    const msg = msgs[mi]
    if (msg.role === 'user') {
      current = {
        turnId: turns.length + 1,
        userText: (msg.content || 'Untitled').slice(0, 30),
        finalText: '',
        units: [],
      }
      turns.push(current)
    } else if (msg.role === 'assistant' && current) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          current.units.push({
            name: tc.name || 'unknown',
            category: TOOL_CAT[tc.name] ?? tc.name,
            ok: true, dur: 0,
          })
        }
      } else if (msg.content) {
        current.finalText = msg.content.slice(0, 30)
      }
    } else if (msg.role === 'tool' && current) {
      const u = current.units.find(u2 => u2.name === (msg.name || 'unknown') && !u2.dur)
      if (u) {
        u.ok = msg.toolOk !== false
        u.dur = msg.durationMs ?? 0
      }
    }
  }

  return {
    turns,
    totalTokens: usage?.total_tokens ?? 0,
    contextUsed: contextInfo?.sentChars ?? 0,
    contextMax: contextInfo?.budgetChars ?? 1,
  }
}
