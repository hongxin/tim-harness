/** IndexedDB KV 适配器（会话/设置/密钥的持久化） */
import type { KVStore } from '../core/ports'

export function openIndexedDBKV(dbName = 'tim-harness', storeName = 'kv'): Promise<KVStore> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
    }
    req.onsuccess = () => resolve(new IDBKV(req.result, storeName))
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

class IDBKV implements KVStore {
  constructor(
    private db: IDBDatabase,
    private store: string,
  ) {}

  private tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(this.store, mode)
      const req = fn(t.objectStore(this.store))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.tx('readwrite', (s) => s.put(value, key) as IDBRequest<IDBValidKey>)
  }

  async delete(key: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(key) as IDBRequest<undefined>)
  }

  async keys(prefix?: string): Promise<string[]> {
    const all = await this.tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
    const keys = all.map(String)
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys
  }
}
