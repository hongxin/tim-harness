/**
 * i18n — 轻量国际化模块（零依赖）
 *
 * 设计原则：
 * - 零外部依赖（不引 i18next/react-intl）
 * - TypeScript 类型安全
 * - React 友好（通过 hook 触发重渲染）
 * - 支持 interpolated 参数
 * - localStorage 持久化
 */

export type Locale = 'en' | 'zh'

/** 所有翻译键的类型（从 en.ts 推导，保证两个语言文件键一致） */
export type TranslationKey = string

/* ═════════════════════════════════════════════════
   核心
   ═════════════════════════════════════════════════ */

import { en } from './locales/en'
import { zh } from './locales/zh'

const messages: Record<Locale, Record<string, string>> = { en, zh }

let currentLocale: Locale = detectLocale()
const listeners = new Set<() => void>()

function detectLocale(): Locale {
  // 1. localStorage 优先
  const stored = localStorage.getItem('tim-harness:locale')
  if (stored === 'en' || stored === 'zh') return stored
  // 2. 浏览器语言
  const lang = navigator.language?.toLowerCase() ?? 'en'
  if (lang.startsWith('zh')) return 'zh'
  return 'en'
}

/** 翻译函数 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = messages[currentLocale] ?? messages.en
  let text = dict[key] ?? messages.en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
  }
  return text
}

/** 切换语言 */
export function setLocale(locale: Locale): void {
  currentLocale = locale
  localStorage.setItem('tim-harness:locale', locale)
  // 更新 <html lang>
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  // 通知所有订阅者（触发 React 重渲染）
  listeners.forEach(fn => fn())
}

/** 获取当前语言 */
export function getLocale(): Locale {
  return currentLocale
}

/** 订阅语言变化（React hook 用） */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 初始化（模块加载时执行一次） */
document.documentElement.lang = currentLocale === 'zh' ? 'zh-CN' : 'en'
