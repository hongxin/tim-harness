/** Cosmos 2D 视图：力导向气泡可视化（JetBot 范式增强版） */
import { useEffect, useRef, useState } from 'react'
import type { RuntimeSnapshot } from '../../core/runtime'
import type { HarnessRuntime } from '../../core/runtime'
import { CosmosCanvas2D, mapSessionToCosmos, type CosmosNode2D } from './CosmosCanvas2D'

export function CosmosView({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<CosmosCanvas2D | null>(null)
  const [selected, setSelected] = useState<CosmosNode2D | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const engine = new CosmosCanvas2D(canvasRef.current)
    engine.setOnNodeSelect(setSelected)
    engineRef.current = engine
    return () => {
      engine.destroy()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    const session = snapshot.session
    if (!session) return
    const { nodes, edges } = mapSessionToCosmos(session.messages, session.compacted?.foldedCount ?? 0)
    engineRef.current?.setNodes(nodes, edges)
  }, [snapshot.rev, snapshot.session]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cosmos-view">
      <canvas ref={canvasRef} className="cosmos-canvas2d" />
      <div className="cosmos-hud">
        <button type="button" className="btn-ghost btn-sm" onClick={() => engineRef.current?.resetView()} title="适配全部">
          ⟲ 适配
        </button>
        <span className="cosmos-stat">
          {snapshot.session?.messages.length ?? 0} 消息
          {snapshot.contextInfo?.masked ? ' · 已折叠' : ''}
        </span>
        {snapshot.contextInfo && (
          <span className="cosmos-stat">
            上下文 {Math.round((snapshot.contextInfo.sentChars / snapshot.contextInfo.budgetChars) * 100)}%
          </span>
        )}
        <span className="cosmos-stat">{(snapshot.session?.usage.total_tokens ?? 0).toLocaleString()} tokens</span>
      </div>
      {selected && (
        <div className="cosmos-detail">
          <div className="cosmos-detail-head">
            <span className={`cosmos-node-type type-${selected.kind}`}>{selected.kind}</span>
            <span className="cosmos-node-label">{selected.content.slice(0, 80)}</span>
            <button type="button" className="btn-icon" onClick={() => setSelected(null)}>×</button>
          </div>
          {selected.toolName && (
            <span className="cosmos-detail-meta">🔧 {selected.toolName}</span>
          )}
          {selected.durationMs != null && (
            <span className="cosmos-detail-meta">
              {selected.isError ? '✗ 失败' : '✓ 成功'} · {(selected.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </div>
  )
}
