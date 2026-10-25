/**
 * useTranslation — React hook，语言变化时触发组件重渲染
 */
import { useSyncExternalStore, useCallback } from 'react'
import { t, setLocale, getLocale, subscribeLocale } from "./index"

export function useTranslation() {
  // 订阅语言变化 → 语言切换时自动重渲染
  useSyncExternalStore(subscribeLocale, getLocale)

  const translate = useCallback((key: string, params?: Record<string, string | number>) => {
    return t(key, params)
  }, [])

  return {
    t: translate,
    locale: getLocale(),
    setLocale,
  }
}
