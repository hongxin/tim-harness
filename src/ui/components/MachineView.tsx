/** MachineView —— 🏭 装配线视图（Anatomy 编译器的 React 壳） */
import { useEffect, useRef } from 'react'
import type { RuntimeSnapshot, HarnessRuntime } from '../../core/runtime'
import { parseBlueprint, layoutBlueprint } from './MachineBlueprint'
import { MachineRenderer } from './MachineRenderer'

export function MachineView({ snapshot, runtime }: { snapshot: RuntimeSnapshot; runtime: HarnessRuntime }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<MachineRenderer | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const renderer = new MachineRenderer(canvasRef.current)
    rendererRef.current = renderer
    return () => { renderer.destroy(); rendererRef.current = null }
  }, [])

  useEffect(() => {
    const session = snapshot.session
    if (!session || !rendererRef.current) return
    // 解析 → 布局 → 渲染（纯本地，零 LLM 调用）
    const bp = layoutBlueprint(parseBlueprint(
      session.messages as any,
      session.compacted?.foldedCount ?? 0,
      session.usage,
      snapshot.contextInfo as any,
    ))
    rendererRef.current.setBlueprint(bp)
  }, [snapshot.rev, snapshot.session]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cosmos-view">
      <canvas ref={canvasRef} className="cosmos-canvas2d" />
      <div className="cosmos-hud">
        <span className="cosmos-stat">🏭 装配线模式</span>
        <span className="cosmos-stat">{snapshot.session?.messages.length ?? 0} 消息</span>
        <span className="cosmos-stat">{(snapshot.session?.usage.total_tokens ?? 0).toLocaleString()} tokens</span>
      </div>
    </div>
  )
}
