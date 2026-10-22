/**
 * 浏览器装配根：创建适配器并启动 HarnessRuntime。
 * 优先 OPFS 工作区；不可用时降级 KV 持久化的内存 FS。
 */
import { HarnessRuntime } from '../core/runtime'
import { openIndexedDBKV } from './kv-idb'
import { MemoryFileSystem, OPFSFileSystem } from './fs-opfs'
import { FetchTransport } from './transport-fetch'
import { WorkerSandbox } from './sandbox-worker'

export interface BootInfo {
  runtime: HarnessRuntime
  fsMode: 'opfs' | 'memory'
}

export async function bootBrowserHarness(): Promise<BootInfo> {
  const kv = await openIndexedDBKV()
  const opfs = await OPFSFileSystem.create()
  const fs = opfs ?? (await MemoryFileSystem.create(kv))
  const runtime = new HarnessRuntime({
    kv,
    fs,
    transport: new FetchTransport(),
    sandbox: new WorkerSandbox(),
  })
  await runtime.boot()
  return { runtime, fsMode: opfs ? 'opfs' : 'memory' }
}
