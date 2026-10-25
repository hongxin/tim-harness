/** MachineView —— 🏭 垂直管道视图（Anatomy 设计哲学的完整重做） */
import { useTranslation } from '../../i18n/useTranslation'
import { useEffect, useRef } from 'react'
import type { RuntimeSnapshot, HarnessRuntime } from '../../core/runtime'
import { PipelineRenderer, parseTurns } from './PipelineRenderer'

export function MachineView({
  snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<PipelineRenderer | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const renderer = new PipelineRenderer(canvasRef.current)
    rendererRef.current = renderer
    return () => { renderer.destroy(); rendererRef.current = null }
  }, [])

  useEffect(() => {
    const session = snapshot.session
    if (!session || !rendererRef.current) return
    const data = parseTurns(
      session.messages as any,
      session.compacted?.foldedCount ?? 0,
      session.usage,
      snapshot.contextInfo as any,
    )
    rendererRef.current.setData(data)
    // 调试接口
  }, [snapshot.rev, snapshot.session]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cosmos-view">
      <canvas ref={canvasRef} className="cosmos-canvas2d" />
      <div className="cosmos-hud">
        <span className="cosmos-stat">{t('view.machine')}</span>
        <span className="cosmos-stat">{snapshot.session?.messages.length ?? 0} 消息</span>
        <span className="cosmos-stat">{(snapshot.session?.usage.total_tokens ?? 0).toLocaleString()} tokens</span>
      </div>
    </div>
  )
}
