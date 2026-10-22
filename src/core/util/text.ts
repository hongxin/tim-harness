/**
 * 文本修剪工具（token 经济）。
 * pruneMiddle：DSH tool-result-pruner 思想 —— 长输出保头保尾、删中段：
 * 头部有结构信息、尾部有错误/结论信息，中段最可能是冗余的重复正文。
 */

export interface PruneOptions {
  /** 触发阈值（字符数） */
  threshold: number
  /** 保留头部字符数 */
  head: number
  /** 保留尾部字符数 */
  tail: number
}

export const DEFAULT_PRUNE: PruneOptions = { threshold: 8_192, head: 4_096, tail: 1_024 }

export function pruneMiddle(text: string, opts: PruneOptions = DEFAULT_PRUNE): string {
  if (text.length <= opts.threshold) return text
  const pruned = text.length - opts.head - opts.tail
  return (
    text.slice(0, opts.head) +
    `\n[... middle pruned: ${pruned} chars — head ${opts.head} / tail ${opts.tail} kept ...]\n` +
    text.slice(text.length - opts.tail)
  )
}
