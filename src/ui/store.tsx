/** React 绑定：RuntimeContext + useSyncExternalStore */
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { HarnessRuntime, type RuntimeSnapshot } from '../core/runtime'
import { bootBrowserHarness } from '../platform/browser'

interface RuntimeHost {
  runtime: HarnessRuntime | null
  fsMode: 'opfs' | 'memory' | null
}

const RuntimeContext = createContext<RuntimeHost>({ runtime: null, fsMode: null })

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<RuntimeHost>({ runtime: null, fsMode: null })
  useEffect(() => {
    let cancelled = false
    bootBrowserHarness()
      .then(({ runtime, fsMode }) => {
        if (!cancelled) setHost({ runtime, fsMode })
      })
      .catch((err) => {
        console.error('boot failed', err)
        if (!cancelled) setHost({ runtime: null, fsMode: null })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return <RuntimeContext.Provider value={host}>{children}</RuntimeContext.Provider>
}

export function useRuntimeHost(): RuntimeHost {
  return useContext(RuntimeContext)
}

export function useRuntime(): { runtime: HarnessRuntime; snapshot: RuntimeSnapshot } {
  const { runtime } = useContext(RuntimeContext)
  if (!runtime) throw new Error('runtime 未就绪')
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  return { runtime, snapshot }
}
