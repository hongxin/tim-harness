/**
 * skill 工具 + 技能索引 —— DSH skill 系统的浏览器化。
 * 技能 = 虚拟工作区里的 /skills/<name>/SKILL.md（首个 h1 为名称，首个引用行为描述）。
 * 系统提示只列索引（名称+描述），完整说明由智能体按需用 skill 工具装载 ——
 * 与 DSH "目录 + 按需装载" 模式一致，上下文成本极小。
 */
import type { ToolDef, ToolResult } from '../types'
import type { VFileSystem } from '../ports'
import { truncate } from '../util/path'

export interface SkillMeta {
  name: string
  description: string
  path: string
}

const SKILL_DIR = '/skills'
const NAME_RE = /^[a-zA-Z0-9\u4e00-\u9fa5][a-zA-Z0-9 _\-\u4e00-\u9fa5]{0,63}$/

/** 扫描 /skills/ 下各技能的 SKILL.md 生成索引（prompt 注入用；失败静默为空） */
export async function scanSkills(fs: VFileSystem): Promise<SkillMeta[]> {
  const out: SkillMeta[] = []
  let entries: import('../ports').FileEntry[]
  try {
    entries = await fs.list(SKILL_DIR)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.kind !== 'dir') continue
    const path = `${e.path}/SKILL.md`
    let content: string
    try {
      content = await fs.readFile(path)
    } catch {
      continue
    }
    const nameMatch = /^#\s+(.+)$/m.exec(content)
    const descMatch = /^>\s?(.+)$/m.exec(content)
    const name = (nameMatch?.[1] ?? e.path.slice(SKILL_DIR.length + 1)).trim()
    const description = (descMatch?.[1] ?? content.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '').trim().slice(0, 160)
    out.push({ name, description, path })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export const skillTool: ToolDef = {
  name: 'skill',
  description:
    'Load the full instructions of a skill by name (from /skills/<name>/SKILL.md in the workspace). Available skills are listed in the system prompt. Load a skill before following its workflow.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name exactly as listed in the system prompt' },
    },
    required: ['name'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const name = String(args.name ?? '').trim()
    if (!NAME_RE.test(name)) {
      return { ok: false, output: `Error: 非法技能名 "${name}"（仅允许字母/数字/空格/中文/连字符，≤64 字符）。` }
    }
    // 索引优先精确匹配；找不到时按名称模糊匹配（大小写/空格差异）
    const skills = await scanSkills(ctx.fs)
    const hit = skills.find((s) => s.name === name) ?? skills.find((s) => s.name.toLowerCase() === name.toLowerCase())
    if (!hit) {
      const available = skills.map((s) => s.name).join(', ')
      return {
        ok: false,
        output: `Error: 技能 "${name}" 不存在。可用技能：${available || '（无）'}。也可以先创建 /skills/${name}/SKILL.md 再调用。`,
      }
    }
    const content = await ctx.fs.readFile(hit.path)
    ctx.state.readFiles.add(hit.path)
    return {
      ok: true,
      output: truncate(content, 16_000) + `\n\n[${hit.path} · 技能 "${hit.name}" 已装载]`,
    }
  },
}
