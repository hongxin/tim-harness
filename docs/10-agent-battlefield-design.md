# AGENT BATTLEFIELD —— 智能体战场可视化
# 基于 Three.js 的红警暴兵模式

## 全盘分析：从整个对话中提取的精华

### 一、用户核心需求（从 90 轮对话中提炼）

| 需求 | 来源轮次 | 在战场模式中的体现 |
|---|---|---|
| **折叠原则** | 50-52, 74-77 | 单位按类型编队，默认显示队伍摘要 |
| **不遮挡** | 66, 68 | 3D 空间天然分层，单位不会 2D 重叠 |
| **序贯性** | 62, 80 | 建筑物按工作流排列，连接线显示路径 |
| **拖拽自由** | 84-90 | 建筑物可在 3D 地面上自由放置 |
| **时间淡化** | 62, 66 | 远处的建筑物和单位自然淡化（雾效） |
| **地图感** | 58, 66 | 俯视 = 战略地图，侧视 = 战术细节 |
| **多巴胺配色** | 59 | 每种单位有鲜明色彩，视觉冲击力 |
| **实时更新** | 全程 | 新单位从建筑中"暴"出来 |
| **零 LLM 成本** | 59, 61 | 纯本地 Three.js 渲染 |
| **锚点连接** | 83, 86 | 建筑物有输入/输出能量门 |
| **三级披露** | 74-77 | 俯视=摘要/侧视=类别/近观=明细 |

### 二、从 Cosmos 模式提取的优点

- 力导向物理 → 单位在战场上自然聚集
- 语义缩放 → 远=概览/近=细节
- hover 聚焦 → 点击单位查看详情
- 回合堆叠 → 每回合是一个"军团"

### 三、从装配线模式提取的优点

- STATION 概念 → 生产建筑（兵营/工厂）
- 工具分类 → 单位类型（侦察兵/工程兵/坦克）
- 状态指示灯 → 建筑物顶部的信号灯
- 正交连接 → 建筑物间的能量管道
- 底部仪表 → 资源条（Token/上下文/效率）
- 锚点系统 → 能量输入/输出门

### 四、从 Anatomy 提取的设计原则

- 物体即解释 → 单位的形状就是它的功能
- 四色调明暗 → 3D 光照系统自然实现
- 零件的零件 → 建筑物有可拆卸的细节
- 实时读数 → 资源条和进度条反映真实数据

### 五、红警暴兵的核心体验

- **累积感**: 单位从 1 个变成 100 个，视觉冲击力递增
- **代理感**: 你在指挥生产，而不是被动观看
- **涌现感**: 个体 → 编队 → 军团 → 战场态势
- **反馈感**: 每次生产完成都有粒子爆发
- **战略感**: 拉远看全局，拉近看细节

## 架构设计

### 场景层次

```
Camera (RTS-style: pan/zoom/tilt)
  └── Ground Plane (战场地面，网格纹理)
       ├── Production Buildings (生产建筑 = STATION)
       │    ├── Building mesh (3D 模型)
       │    ├── Progress bar (生产进度)
       │    ├── Status light (信号灯)
       │    ├── Input/Output gates (能量门)
       │    └── Rally point (集结点)
       ├── Units (单位 = TOOL CALLS)
       │    ├── Unit mesh (3D 模型，按类型不同)
       │    ├── Team colors (阵营色)
       │    ├── Health/status (状态条)
       │    └── Formation slot (编队位置)
       ├── Connection Beams (能量管道)
       │    ├── Beam mesh (发光管道)
       │    └── Flow particles (流动粒子)
       ├── Resource Panel (资源面板)
       │    ├── Token bar (Token 消耗)
       │    ├── Context gauge (上下文占用)
       │    └── Efficiency meter (效率)
       └── Effects (特效层)
            ├── Production burst (生产完成爆发)
            ├── Error explosion (错误爆炸)
            └── Ambient particles (环境粒子)
```

### 单位类型映射

| 工具 | 单位名称 | 3D 形状 | 颜色 | 大小 | 特效 |
|---|---|---|---|---|---|
| read_file | Scout 侦察兵 | 小型无人机 | #00FF88 绿 | S | 扫描波纹 |
| write_file | Engineer 工程兵 | 六边形建造器 | #FF8C00 橙 | M | 建造光环 |
| edit_file | Technician 技工 | 菱形修改器 | #FF69B4 粉 | S | 修改波纹 |
| run_js | Tank 坦克 | 履带战车 | #00E5FF 青 | L | 电弧效果 |
| grep | Radar 雷达 | 抛物面天线 | #00CED1 青蓝 | S | 旋转扫描 |
| web_fetch | Aircraft 飞机 | 三角形飞行器 | #DDA0DD 紫 | M | 飞行轨迹 |
| web_search | Drone 无人机 | 小型无人机 | #87CEEB 天蓝 | S | 搜索光束 |
| skill | Special Ops 特种兵 | 星形标记 | #FFD700 金 | M | 金色光环 |
| spawn_agent | Command 指挥部 | 大型方尖碑 | #DA70D6 紫罗兰 | XL | 能量脉冲 |
| snapshot_save | Vault 保险库 | 圆柱形存储塔 | #A0522D 赭石 | M | 数据封存 |
| todo_write | Strategist 战略家 | 棋子形状 | #FFB347 杏黄 | S | 规划网格 |
| ask_user | Beacon 信标 | 发光柱体 | #FF7F50 珊瑚 | M | 闪烁信号 |

### 生产建筑设计

每个 STATION 是一座生产建筑（像红警的兵营/战车工厂）：

```
     ┌──[信号灯]──┐
     │   ST 1     │  ← 建筑名称
     │ 🏭 兵营     │  ← 建筑类型
     ├─────────────┤
     │ ▓▓▓▓░░░░░  │  ← 生产进度条
     │ 35 units   │  ← 已生产单位数
     ├──────┬──────┤
     │IN ●──┼──● OUT│  ← 输入/输出能量门
     └──────┴──────┘
          ↓ 集结点
     [●][●][●][●]  ← 已生产的单位（编队排列）
```

### 相机控制

| 操作 | 效果 | 红警类比 |
|---|---|---|
| 滚轮 | 缩放（俯视↔侧视） | 战略地图↔战术视角 |
| 拖拽空白 | 平移 | 滚动地图 |
| 点击建筑 | 聚焦该建筑 | 选中建筑 |
| 拖拽建筑 | 移动建筑位置 | 移动建筑 |
| 双击 | 重置视角 | 回到基地 |

### 资源系统

| 资源 | 对应 | 显示方式 |
|---|---|---|
| Credits (Token) | total_tokens | 顶部数字 + 消耗速率 |
| Power (Context) | context_used/max | 电力条（绿→黄→红） |
| Efficiency | success_rate | 百分比 + 指示灯 |
| Time | total_time | 战斗计时器 |

### 核心交互

1. **生产可视化**: 新工具调用完成 → 单位从建筑"弹出"+粒子效果
2. **编队系统**: 同类工具自动编队，队长有标记
3. **选择系统**: 框选多个单位查看汇总
4. **检查系统**: 点击单个单位查看详情（参数、结果、耗时）
5. **拖拽建筑**: 用户可重新布置"基地"布局

## 技术实现

### Three.js 场景设置

```typescript
// 场景
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 2000)
const renderer = new THREE.WebGLRenderer({ antialias: true })

// 光照
const ambientLight = new THREE.AmbientLight(0x404040, 0.5)
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)

// 地面（网格 + 发光边缘）
const groundGrid = new THREE.GridHelper(200, 40, 0x30363D, 0x21262D)
const groundPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x0A0E14 })
)

// 雾效（远处淡化 = 时间淡化）
scene.fog = new THREE.Fog(0x0A0E14, 50, 150)
```

### 单位生成动画

```typescript
// 生产完成 → 单位弹出
function produceUnit(building: Building, toolCall: ToolCall): void {
  const unit = createUnitMesh(toolCall.type)
  unit.position.copy(building.outputGate.position)
  
  // 弹出动画（从建筑内弹出）
  const spawnAnim = new THREE.Tween(unit.position)
    .to({ y: unit.position.y + 2, z: unit.position.z + 3 })
    .easing(TWEEN.Easing.Elastic.Out)
    .start()
  
  // 粒子爆发
  spawnParticles(building.outputGate.position, toolCall.type.color)
  
  // 移动到编队位置
  const formationSlot = getFormationSlot(building, unitIndex)
  new THREE.Tween(unit.position)
    .to(formationSlot)
    .delay(200)
    .easing(TWEEN.Easing.Cubic.Out)
    .start()
}
```

### 连接管道

```typescript
// 建筑间的能量管道（发光曲线）
function createConnectionBeam(from: Vector3, to: Vector3): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3([
    from,
    from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 3, 0)), // 拱起
    to,
  ])
  
  const tubeGeometry = new THREE.TubeGeometry(curve, 32, 0.15, 8)
  const tubeMaterial = new THREE.MeshStandardMaterial({
    color: 0x4A9EFF,
    emissive: 0x4A9EFF,
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.6,
  })
  
  return new THREE.Mesh(tubeGeometry, tubeMaterial)
}
```
