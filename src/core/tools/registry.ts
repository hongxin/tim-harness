import type { ToolDef } from '../types'
import type { ToolSchema } from '../llm/client'

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  register(def: ToolDef): this {
    this.tools.set(def.name, def)
    return this
  }

  registerAll(defs: ToolDef[]): this {
    for (const d of defs) this.register(d)
    return this
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  list(): ToolDef[] {
    return [...this.tools.values()]
  }

  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
}
