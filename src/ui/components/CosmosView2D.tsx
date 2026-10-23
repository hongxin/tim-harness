/** Cosmos 2D 视图：结构化星座布局（v3） */
import { useEffect, useRef, useState } from 'react'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import { CosmosCanvas2D, mapSessionToCosmos, type CosmosNode2D, type TurnCluster } from './CosmosCanvas2D'

export function CosmosView({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<CosmosCanvas2D | null>(null)
  const [selected, setSelected] = useState<CosmosNode2D | null>(null)
  const [caption, setCaption] = useState<string | null>(null)
  const [tourIndex, setTourIndex] = useState(-1)
  const [tourSteps, setTourSteps] = useState<TurnCluster[]>([])

  useEffect(() => {
    if (!canvasRef.current) return
    const engine = new CosmosCanvas2D(canvasRef.current)
    engine.setOnNodeSelect(setSelected)
    engine.setOnCaptionUpdate(setCaption)
    engineRef.current = engine
    return () => { engine.destroy(); engineRef.current = null }
  }, [])

  useEffect(() => {
    const session = snapshot.session
    if (!session) return
    const { nodes, edges, clusters } = mapSessionToCosmos(session.messages, session.compacted?.foldedCount ?? 0)
    engineRef.current?.setNodes(nodes, edges, clusters)
    setTourSteps(engineRef.current?.getTourSteps() ?? [])
  }, [snapshot.rev, snapshot.session]) // eslint-disable-line react-hooks/exhaustive-deps

  const inTour = tourIndex >= 0 && tourIndex < tourSteps.length
  const handlePrev = () => { if (tourIndex > 0) { setTourIndex(tourIndex - 1); engineRef.current?.flyToTurn(tourSteps[tourIndex - 1].turnId) } }
  const handleNext = () => { if (tourIndex < tourSteps.length - 1) { setTourIndex(tourIndex + 1); engineRef.current?.flyToTurn(tourSteps[tourIndex + 1].turnId) } }
  const exitTour = () => { setTourIndex(-1); engineRef.current?.resetView() }

  const ctxPct = snapshot.contextInfo ? Math.round((snapshot.contextInfo.sentChars / snapshot.contextInfo.budgetChars) * 100) : 0

  return (
    <div className="cosmos-view">
      <canvas ref={canvasRef} className="cosmos-canvas2d" />
      <div className="cosmos-hud">
        <button type="button" className="btn-ghost btn-sm" onClick={() => engineRef.current?.resetView()}>⟲ 适配</button>
        <span className="cosmos-stat">
          {snapshot.session?.messages.length ?? 0} 消息 · {tourSteps.length} 回合
          {snapshot.contextInfo?.masked ? ' · 已折叠' : ''}
        </span>
        <span className="cosmos-stat">上下文 {ctxPct}%</span>
        <span className="cosmos-stat">{(snapshot.session?.usage.total_tokens ?? 0).toLocaleString()} tokens</span>
      </div>
      {/* bbycroft 步进叙事 */}
      {caption && (
        <div className="cosmos-caption">{caption}</div>
      )}
      {inTour && tourSteps[tourIndex] && (
        <div className="cosmos-tour">
          <span className="cosmos-tour-step">{tourIndex + 1}/{tourSteps.length}</span>
          <span className="cosmos-tour-label">{tourSteps[tourIndex].summary}</span>
          <button type="button" className="btn-ghost btn-sm" onClick={handlePrev} disabled={tourIndex <= 0}>←</button>
          <button type="button" className="btn-ghost btn-sm" onClick={handleNext} disabled={tourIndex >= tourSteps.length - 1}>→</button>
          <button type="button" className="btn-ghost btn-sm" onClick={exitTour}>退出</button>
        </div>
      )}
      {!inTour && tourSteps.length > 0 && (
        <button type="button" className="cosmos-tour-start" onClick={() => { setTourIndex(0); engineRef.current?.flyToTurn(tourSteps[0].turnId) }}>
          ▶ 导览
        </button>
      )}
      {selected && (
        <div className="cosmos-detail">
          <div className="cosmos-detail-head">
            <span className={`cosmos-node-type type-${selected.kind}`}>{selected.kind}</span>
            <span className="cosmos-node-label">{selected.content.slice(0, 80)}</span>
            <button type="button" className="btn-icon" onClick={() => setSelected(null)}>×</button>
          </div>
          {selected.toolName && <span className="cosmos-detail-meta">🔧 {selected.toolName}</span>}
          {selected.durationMs != null && (
            <span className="cosmos-detail-meta">{selected.isError ? '✗ 失败' : '✓ 成功'} · {(selected.durationMs / 1000).toFixed(1)}s</span>
          )}
        </div>
      )}
    </div>
  )
}
