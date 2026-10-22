/**
 * Token 经济档位 —— 一组联动旋钮，把"上下文预算 / 工具输出上限 / 压缩时机"
 * 统一为用户可理解的三档（省流 / 标准 / 完整）。
 * 原则：最便宜的 token 是从未发送的 token；其次是缓存命中的 token。
 */
import type { AppSettings } from './types'

export type CostTier = 'eco' | 'standard' | 'full'

export interface TierPolicy {
  /** 上下文视图预算（字符）——超过即折叠旧工具结果/丢块 */
  budgetChars: number
  /** 自动压缩阈值（占预算比例） */
  autoCompactAt: number
  /** read_file 单次输出上限（字符） */
  readMax: number
  /** grep 最大命中条数 */
  grepMax: number
  /** web_fetch 正文截断（字符） */
  fetchMax: number
  /** 折叠时保持全文的最近 N 条工具结果 */
  recentFullResults: number
}

export const TIER_POLICIES: Record<CostTier, TierPolicy> = {
  eco: {
    budgetChars: 48_000,
    autoCompactAt: 0.5,
    readMax: 32_000,
    grepMax: 60,
    fetchMax: 24_000,
    recentFullResults: 2,
  },
  standard: {
    budgetChars: 120_000,
    autoCompactAt: 0.65,
    readMax: 80_000,
    grepMax: 100,
    fetchMax: 60_000,
    recentFullResults: 3,
  },
  full: {
    budgetChars: 260_000,
    autoCompactAt: 0.8,
    readMax: 200_000,
    grepMax: 200,
    fetchMax: 100_000,
    recentFullResults: 4,
  },
}

export const TIER_LABELS: Record<CostTier, string> = {
  eco: '省流',
  standard: '标准',
  full: '完整',
}

export function tierPolicy(settings?: Pick<AppSettings, 'costTier'> | null): TierPolicy {
  return TIER_POLICIES[settings?.costTier ?? 'standard'] ?? TIER_POLICIES.standard
}
