/**
 * Cosmos 3D —— 会话的智能体星图可视化。
 *
 * 设计思想：对话如一条星河，从中心（压缩区）向外螺旋展开。
 * - 中心核心（琥珀色发光体）= 压缩/摘要的历史
 * - 螺旋臂上排布消息节点（用户=金色八面体，助手=青色二十面体，工具=彩色立方体）
 * - 子代理是分支螺旋，用半透明弧线连接
 * - 上下文预算以环绕的全息光盘呈现（填充率+颜色渐变）
 * - 背景星尘 + 粒子流（token 流动方向感）
 *
 * 技术要点：three.js 按需动态 import（主 bundle 零影响）；
 * OrbitControls 拖拽旋转/缩放；节点可点击弹出详情。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import type { ChatMessage } from '../../core/types'

/* ---------------- 类型 ---------------- */

interface CosmosNode {
  id: string
  type: 'user' | 'assistant' | 'tool' | 'sub-agent'
  position: [number, number, number]
  size: number
  color: string
  label: string
  detail?: string
  message?: ChatMessage
  durationMs?: number
  ok?: boolean
}

interface SceneData {
  nodes: CosmosNode[]
  connections: Array<{ from: number; to: number; type: 'flow' | 'spawn' | 'tool' }>
  contextFill: number
  compactedCount: number
  tokenTotal: number
  cacheHitPct: number
}

/* ---------------- 数据 → 3D 场景映射 ---------------- */

const TOOL_COLORS: Record<string, string> = {
  ls: '#8b95a5', read_file: '#60a5fa', write_file: '#4ade80', edit_file: '#facc15',
  grep: '#f97316', glob: '#a78bfa', run_js: '#22d3ee', web_fetch: '#ec4899',
  web_search: '#ec4899', todo_write: '#94a3b8', spawn_agent: '#f472b6',
  ask_user: '#eab308', skill: '#c084fc', goal_update: '#10b981',
  snapshot_save: '#6ee7b7', snapshot_restore: '#5eead4', snapshot_list: '#99f6e4',
  snapshot_diff: '#2dd4bf', snapshot_delete: '#14b8a6',
}

function mapMessagesToScene(snapshot: RuntimeSnapshot): SceneData {
  const session = snapshot.session
  if (!session) return { nodes: [], connections: [], contextFill: 0, compactedCount: 0, tokenTotal: 0, cacheHitPct: 0 }

  const msgs = session.messages
  const nodes: CosmosNode[] = []
  const connections: SceneData['connections'] = []
  const folded = session.compacted?.foldedCount ?? 0

  // 中心核心：压缩/摘要区
  if (folded > 0 || session.compacted) {
    nodes.push({
      id: 'core',
      type: 'sub-agent',
      position: [0, 0, 0],
      size: 2.5,
      color: '#f59e0b',
      label: `⚡ 压缩核心 (${folded} 条)`,
      detail: session.compacted?.summary?.slice(0, 300) ?? '',
    })
  }

  // 消息节点：从内到外螺旋排布
  const visible = msgs.slice(folded)
  const spiralRadius = 6
  const spiralPitch = 1.8
  const angleStep = 0.55

  visible.forEach((msg, i) => {
    const angle = i * angleStep
    const radius = spiralRadius + i * 0.4
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const y = i * spiralPitch * 0.12

    if (msg.role === 'user') {
      nodes.push({
        id: `u${i}`,
        type: 'user',
        position: [x, y, z],
        size: 0.9 + Math.min((msg.content?.length ?? 0) / 200, 1.2),
        color: '#ffd700',
        label: (msg.content ?? '').slice(0, 60),
        detail: msg.content ?? '',
        message: msg,
      })
    } else if (msg.role === 'assistant') {
      const hasTools = (msg.tool_calls?.length ?? 0) > 0
      nodes.push({
        id: `a${i}`,
        type: 'assistant',
        position: [x, y, z],
        size: hasTools ? 0.6 : 0.7 + Math.min((msg.content?.length ?? 0) / 400, 1.5),
        color: hasTools ? '#38bdf8' : '#22d3ee',
        label: (msg.content ?? `[${msg.tool_calls?.length ?? 0} 个工具调用]`).slice(0, 60),
        detail: msg.content ?? '',
        message: msg,
      })
      // 工具子节点
      if (msg.tool_calls) {
        msg.tool_calls.forEach((tc, j) => {
          const tAngle = angle + 0.3 + j * 0.25
          const tRadius = radius + 1.8
          const toolColor = TOOL_COLORS[tc.name] ?? '#76688a'
          nodes.push({
            id: `t${i}_${j}`,
            type: 'tool',
            position: [Math.cos(tAngle) * tRadius, y - 0.4, Math.sin(tAngle) * tRadius],
            size: 0.35,
            color: toolColor,
            label: `${tc.name}`,
            detail: tc.arguments?.slice(0, 200),
          })
          connections.push({ from: nodes.length - 2, to: nodes.length - 1, type: 'tool' })
        })
      }
    } else if (msg.role === 'tool') {
      // 工具结果：紧跟工具调用
      nodes.push({
        id: `tr${i}`,
        type: 'tool',
        position: [x, y - 0.3, z],
        size: 0.22,
        color: msg.toolOk === false ? '#ef4444' : '#64748b',
        label: msg.name ?? '',
        detail: (msg.content ?? '').slice(0, 200),
        message: msg,
        durationMs: msg.durationMs,
        ok: msg.toolOk,
      })
    }

    // 顺序连接
    if (i > 0) connections.push({ from: i - 1, to: i, type: 'flow' })
    if (i === 0 && folded > 0) connections.push({ from: 0, to: 1, type: 'flow' })
  })

  const ctx = snapshot.contextInfo
  const usage = session.usage
  const total = (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0)
  return {
    nodes,
    connections,
    contextFill: ctx ? Math.min(ctx.sentChars / ctx.budgetChars, 1) : 0,
    compactedCount: folded,
    tokenTotal: usage.total_tokens ?? 0,
    cacheHitPct: total > 0 ? Math.round(((usage.prompt_cache_hit_tokens ?? 0) / total) * 100) : 0,
  }
}

/* ---------------- Three.js 场景构建 ---------------- */

interface ThreeBundle {
  THREE: typeof import('three')
  OrbitControls: typeof import('three/examples/jsm/controls/OrbitControls.js').OrbitControls
}

let threeBundle: ThreeBundle | null = null

async function loadThree(): Promise<ThreeBundle> {
  if (threeBundle) return threeBundle
  const THREE = await import('three')
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')
  threeBundle = { THREE, OrbitControls }
  return threeBundle
}

interface Cosmos3DScene {
  dispose: () => void
  resize: () => void
  focusNode: (index: number) => void
  resetCamera: () => void
  setFocus: (index: number | null) => void
}

async function buildScene(
  container: HTMLElement,
  data: SceneData,
  onNodeClick: (node: CosmosNode) => void,
): Promise<Cosmos3DScene> {
  const { THREE, OrbitControls } = await loadThree()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0e14)
  scene.fog = new THREE.Fog(0x0b0e14, 30, 120)

  const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 300)
  camera.position.set(18, 10, 22)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  container.appendChild(renderer.domElement)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.minDistance = 5
  controls.maxDistance = 80
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.5

  /* 灯光 */
  const ambient = new THREE.AmbientLight(0x404060, 2)
  scene.add(ambient)
  const keyLight = new THREE.DirectionalLight(0x7cc7ff, 1.5)
  keyLight.position.set(10, 20, 10)
  scene.add(keyLight)
  const rimLight = new THREE.DirectionalLight(0xffb347, 0.8)
  rimLight.position.set(-10, 5, -15)
  scene.add(rimLight)

  /* 节点组 */
  const nodeGroup = new THREE.Group()
  scene.add(nodeGroup)
  const nodeMeshes: import('three').Mesh[] = []
  const geometries: Record<string, import('three').BufferGeometry> = {
    user: new THREE.OctahedronGeometry(1),
    assistant: new THREE.IcosahedronGeometry(1, 0),
    tool: new THREE.BoxGeometry(1, 1, 1),
    'sub-agent': new THREE.SphereGeometry(1, 16, 12),
  }

  data.nodes.forEach((node) => {
    const geo = geometries[node.type] ?? geometries.tool
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(node.color),
      emissive: new THREE.Color(node.color).multiplyScalar(0.3),
      metalness: node.type === 'user' ? 0.4 : 0.6,
      roughness: 0.35,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(...node.position)
    mesh.scale.setScalar(node.size)
    mesh.userData = node
    nodeGroup.add(mesh)
    nodeMeshes.push(mesh)

    // 发光圈（核心节点）
    if (node.type === 'sub-agent') {
      const glowGeo = new THREE.SphereGeometry(node.size * 1.3, 16, 12)
      const glowMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(node.color),
        transparent: true,
        opacity: 0.12,
      })
      const glow = new THREE.Mesh(glowGeo, glowMat)
      glow.position.set(...node.position)
      nodeGroup.add(glow)
    }
  })

  /* 连线 */
  const connectionMats: Record<string, import('three').LineBasicMaterial> = {
    flow: new THREE.LineBasicMaterial({ color: 0x3b6a8c, transparent: true, opacity: 0.35 }),
    tool: new THREE.LineBasicMaterial({ color: 0x2a4a3a, transparent: true, opacity: 0.2 }),
    spawn: new THREE.LineBasicMaterial({ color: 0x6a3a5a, transparent: true, opacity: 0.3 }),
  }
  const connectionLines: import('three').Line[] = []
  data.connections.forEach((conn) => {
    const from = data.nodes[conn.from]
    const to = data.nodes[conn.to]
    if (!from || !to) return
    const pts = [
      new THREE.Vector3(...from.position),
      new THREE.Vector3((from.position[0] + to.position[0]) / 2, (from.position[1] + to.position[1]) / 2 + 0.8, (from.position[2] + to.position[2]) / 2),
      new THREE.Vector3(...to.position),
    ]
    const curve = new THREE.CatmullRomCurve3(pts)
    const lineGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(20))
    const line = new THREE.Line(lineGeo, connectionMats[conn.type] ?? connectionMats.flow)
    scene.add(line)
    connectionLines.push(line)
  })

  /* 上下文预算光盘 */
  const contextGroup = new THREE.Group()
  const ctxRadius = Math.max(12, data.nodes.length * 0.8)
  const ctxGeometry = new THREE.RingGeometry(ctxRadius - 0.3, ctxRadius, 64)
  const ctxOuterMat = new THREE.MeshBasicMaterial({ color: 0x1a2530, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  const ctxOuter = new THREE.Mesh(ctxGeometry, ctxOuterMat)
  ctxOuter.rotation.x = -Math.PI / 2
  ctxOuter.position.y = -4
  contextGroup.add(ctxOuter)
  if (data.contextFill > 0.02) {
    const fillAngle = data.contextFill * Math.PI * 2
    const ctxFillGeo = new THREE.RingGeometry(ctxRadius - 0.3, ctxRadius, 64, 1, 0, fillAngle)
    const fillColor = data.contextFill > 0.8 ? 0xef4444 : data.contextFill > 0.6 ? 0xeab308 : 0x22c55e
    const ctxFillMat = new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
    const ctxFill = new THREE.Mesh(ctxFillGeo, ctxFillMat)
    ctxFill.rotation.x = -Math.PI / 2
    ctxFill.position.y = -4
    contextGroup.add(ctxFill)
  }
  scene.add(contextGroup)

  /* 背景星尘 */
  const starCount = 400
  const starGeo = new THREE.BufferGeometry()
  const starPositions = new Float32Array(starCount * 3)
  for (let i = 0; i < starCount; i++) {
    const r = 40 + Math.random() * 60
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    starPositions[i * 3 + 1] = r * Math.cos(phi) * 0.4
    starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
  const starMat = new THREE.PointsMaterial({ color: 0x556677, size: 0.15, transparent: true, opacity: 0.6 })
  const stars = new THREE.Points(starGeo, starMat)
  scene.add(stars)

  /* 动画循环 */
  let animationId = 0
  let lastTime = performance.now()
  const animate = () => {
    animationId = requestAnimationFrame(animate)
    const now = performance.now()
    const dt = (now - lastTime) / 1000
    lastTime = now
    controls.update()
    // 节点轻微浮动
    const t = now / 1000
    nodeMeshes.forEach((mesh, i) => {
      mesh.position.y += Math.sin(t * 1.2 + i * 0.7) * 0.002
      if (mesh.userData?.type === 'user') {
        mesh.rotation.y += dt * 0.4
      } else if (mesh.userData?.type === 'assistant') {
        mesh.rotation.y += dt * 0.2
      }
    })
    renderer.render(scene, camera)
  }
  animate()

  /* 点击拾取 */
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  const onClick = (e: MouseEvent) => {
    const rect = renderer.domElement.getBoundingClientRect()
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(nodeMeshes)
    if (hits.length > 0 && hits[0].object.userData) {
      onNodeClick(hits[0].object.userData as CosmosNode)
    }
  }
  renderer.domElement.addEventListener('click', onClick)

  /* 窗口自适应 */
  const resize = () => {
    if (!container.isConnected) return
    camera.aspect = container.clientWidth / container.clientHeight
    camera.updateProjectionMatrix()
    renderer.setSize(container.clientWidth, container.clientHeight)
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)

  // 焦点暗化：选中节点高亮，其余降低透明度（bbycroft 范式）
  const setFocus = (index: number | null) => {
    nodeMeshes.forEach((mesh, i) => {
      const mat = mesh.material as import('three').MeshStandardMaterial
      if (index === null || i === index) {
        mat.opacity = 1
        mat.transparent = false
      } else {
        mat.transparent = true
        mat.opacity = 0.15
      }
    })
  }

  return {
    setFocus,
    dispose: () => {
      cancelAnimationFrame(animationId)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('click', onClick)
      controls.dispose()
      renderer.dispose()
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose()
          const mat = obj.material
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
          else mat.dispose()
        }
      })
      if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement)
    },
    resize,
    focusNode: (index: number) => {
      const node = data.nodes[index]
      if (!node) return
      controls.autoRotate = false
      const target = new THREE.Vector3(...node.position)
      const dist = 6
      const direction = new THREE.Vector3(1, 0.5, 1).normalize()
      camera.position.copy(target.clone().add(direction.multiplyScalar(dist)))
      controls.target.copy(target)
    },
    resetCamera: () => {
      controls.autoRotate = true
      camera.position.set(18, 10, 22)
      controls.target.set(0, 0, 0)
    },
  }
}

/* ---------------- React 组件 ---------------- */

export function CosmosView({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<Cosmos3DScene | null>(null)
  const [selected, setSelected] = useState<CosmosNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [nodeList, setNodeList] = useState<CosmosNode[]>([])
  const [stepIndex, setStepIndex] = useState(-1) // -1 = 自由模式
  const tourNodes = nodeList.filter((n) => n.type === 'user' || n.type === 'sub-agent')
  const inTour = stepIndex >= 0 && stepIndex < tourNodes.length
  const tourNode = inTour ? tourNodes[stepIndex] : null
  const handlePrev = () => { if (stepIndex > 0) { setStepIndex(stepIndex - 1); const idx = nodeList.indexOf(tourNodes[stepIndex - 1]); if (idx >= 0) { sceneRef.current?.focusNode(idx); sceneRef.current?.setFocus(idx) } } }
  const handleNext = () => { if (stepIndex < tourNodes.length - 1) { setStepIndex(stepIndex + 1); const idx = nodeList.indexOf(tourNodes[stepIndex + 1]); if (idx >= 0) { sceneRef.current?.focusNode(idx); sceneRef.current?.setFocus(idx) } } }
  const exitTour = () => { setStepIndex(-1); sceneRef.current?.setFocus(null); sceneRef.current?.resetCamera() }

  const handleNodeClick = useCallback((node: CosmosNode) => setSelected(node), [])

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false
    const data = mapMessagesToScene(snapshot)
    setNodeList(data.nodes)
    setLoading(true)
    buildScene(containerRef.current, data, handleNodeClick)
      .then((scene) => {
        if (disposed) {
          scene.dispose()
          return
        }
        sceneRef.current = scene
        setLoading(false)
      })
      .catch((err) => {
        console.error('[cosmos] 场景构建失败', err)
        setLoading(false)
      })
    return () => {
      disposed = true
      sceneRef.current?.dispose()
      sceneRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.rev]) // 每次 snapshot 变化重建（对话进行中实时更新）

  const handleReset = () => sceneRef.current?.resetCamera()
  const handleFocus = (i: number) => sceneRef.current?.focusNode(i)

  const scene = snapshot
  const ctxPct = scene.contextInfo ? Math.round((scene.contextInfo.sentChars / scene.contextInfo.budgetChars) * 100) : 0

  return (
    <div className="cosmos-view">
      <div ref={containerRef} className="cosmos-canvas" />
      {loading && <div className="cosmos-loading">🌌 正在构建星图…</div>}
      {!loading && (
        <>
          <div className="cosmos-hud">
            <button type="button" className="btn-ghost btn-sm" onClick={handleReset} title="重置视角 + 自动旋转">
              ⟲ 重置
            </button>
            <span className="cosmos-stat">
              {snapshot.session?.messages.length ?? 0} 消息 · {scene.contextInfo?.masked ? '已折叠' : '完整'}
            </span>
            <span className="cosmos-stat">上下文 {ctxPct}%</span>
            <span className="cosmos-stat">{(scene.session?.usage.total_tokens ?? 0).toLocaleString()} tokens</span>
          </div>
          {selected && (
            <div className="cosmos-detail">
              <div className="cosmos-detail-head">
                <span className={`cosmos-node-type type-${selected.type}`}>{selected.type}</span>
                <span className="cosmos-node-label">{selected.label.slice(0, 80)}</span>
                <button type="button" className="btn-icon" onClick={() => setSelected(null)}>×</button>
              </div>
              {selected.detail && <pre className="cosmos-detail-body">{selected.detail.slice(0, 600)}</pre>}
              {selected.durationMs != null && (
                <span className="cosmos-detail-meta">
                  {selected.ok === false ? '✗ 失败' : '✓ 成功'} · {(selected.durationMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          )}
          {inTour && tourNode && (
            <div className="cosmos-tour">
              <div className="cosmos-tour-info">
                <span className="cosmos-tour-step">{stepIndex + 1} / {tourNodes.length}</span>
                <span className="cosmos-tour-label">{tourNode.label.slice(0, 60)}</span>
              </div>
              <div className="cosmos-tour-controls">
                <button type="button" className="btn-ghost btn-sm" onClick={handlePrev} disabled={stepIndex <= 0}>←</button>
                <button type="button" className="btn-ghost btn-sm" onClick={handleNext} disabled={stepIndex >= tourNodes.length - 1}>→</button>
                <button type="button" className="btn-ghost btn-sm" onClick={exitTour}>退出</button>
              </div>
            </div>
          )}
          {!inTour && tourNodes.length > 0 && (
            <button type="button" className="cosmos-tour-start" onClick={() => { setStepIndex(0); const idx = nodeList.indexOf(tourNodes[0]); if (idx >= 0) { sceneRef.current?.focusNode(idx); sceneRef.current?.setFocus(idx) } }}>
              ▶ 导览模式
            </button>
          )}
          {nodeList.length > 0 && (
            <div className="cosmos-timeline">
              {nodeList.slice(0, 30).map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  className={`cosmos-tl-dot type-${n.type}`}
                  title={n.label}
                  onClick={() => handleFocus(i)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
