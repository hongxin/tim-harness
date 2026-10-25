/** BattlefieldView —— ⚔️ 战场视图（红警暴兵模式） */
import { useTranslation } from '../../i18n/useTranslation'
import { useEffect, useRef } from 'react'
import type { RuntimeSnapshot, HarnessRuntime } from '../../core/runtime'
import { BattlefieldRenderer, parseBattlefieldData } from './BattlefieldRenderer'

export function BattlefieldView({
  snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<BattlefieldRenderer | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const renderer = new BattlefieldRenderer(canvasRef.current)
    rendererRef.current = renderer
    return () => { renderer.destroy(); rendererRef.current = null }
  }, [])

  useEffect(() => {
    const session = snapshot.session
    if (!session || !rendererRef.current) return
    const data = parseBattlefieldData(
      session.messages as any,
      session.compacted?.foldedCount ?? 0,
      session.usage,
      snapshot.contextInfo as any,
    )
    rendererRef.current.setData(data)
  }, [snapshot.rev, snapshot.session]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cosmos-view">
      <canvas ref={canvasRef} className="cosmos-canvas2d" />
      <div className="cosmos-hud">
        <span className="cosmos-stat">{t('view.battlefield')}</span>
        <span className="cosmos-stat">{snapshot.session?.messages.length ?? 0} messages</span>
        <span className="cosmos-stat">{(snapshot.session?.usage.total_tokens ?? 0).toLocaleString()} tokens</span>
      </div>
    </div>
  )
}
