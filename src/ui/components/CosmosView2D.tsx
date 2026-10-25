/** Cosmos 2D 视图：JetBot 风格冒泡 */
import { useTranslation } from '../../i18n/useTranslation'
import { useEffect, useRef, useState } from 'react'
import type { RuntimeSnapshot, HarnessRuntime } from '../../core/runtime'
import { CosmosCanvas, mapSession, type CosmosNode } from './CosmosCanvas2D'

export function CosmosView({
  const { t } = useTranslation() snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<CosmosCanvas | null>(null)
  const [selected, setSelected] = useState<CosmosNode | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const engine = new CosmosCanvas(canvasRef.current)
    engine.setOnNodeSelect(setSelected)
    engineRef.current = engine
    return () => { engine.destroy(); engineRef.current = null }
  }, [])

  useEffect(() => {
    const session = snapshot.session
    if (!session) return
    const { nodes, edges } = mapSession(session.messages as any, session.compacted?.foldedCount ?? 0)
    engineRef.current?.setNodes(nodes, edges)
  }, [snapshot.rev, snapshot.session]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cosmos-view">
      <canvas ref={canvasRef} className="cosmos-canvas2d" />
      <div className="cosmos-hud">
        <span className="cosmos-stat">{t('view.cosmos')}</span>
        <span className="cosmos-stat">{snapshot.session?.messages.length ?? 0} 消息</span>
      </div>
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
