/**
 * 工具注册入口：按运行形态装配工具集。
 * - 主会话：全量工具
 * - 子代理：去掉 spawn_agent（防递归）与 ask_user（不打断用户）
 */
import type { CodeSandbox, Transport } from '../ports'
import { ToolRegistry } from './registry'
import { deleteFileTool, editFileTool, globTool, grepTool, lsTool, readFileTool, writeFileTool } from './fs'
import { createRunJsTool } from './js'
import { createWebTools } from './web'
import { askUserTool, spawnAgentTool, todoWriteTool } from './workflow'
import { skillTool } from './skills'
import { goalUpdateTool } from './goal'
import {
  snapshotDeleteTool,
  snapshotDiffTool,
  snapshotListTool,
  snapshotRestoreTool,
  snapshotSaveTool,
} from '../workspace-snapshots'

export interface ToolDeps {
  transport: Transport
  sandbox: CodeSandbox
}

export function createMainRegistry(deps: ToolDeps): ToolRegistry {
  return new ToolRegistry().registerAll([
    lsTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    grepTool,
    globTool,
    deleteFileTool,
    createRunJsTool(deps.sandbox),
    ...createWebTools(deps.transport),
    todoWriteTool,
    spawnAgentTool,
    askUserTool,
    skillTool,
    goalUpdateTool,
    snapshotSaveTool,
    snapshotRestoreTool,
    snapshotListTool,
    snapshotDiffTool,
    snapshotDeleteTool,
  ])
}

export function createSubagentRegistry(deps: ToolDeps): ToolRegistry {
  return new ToolRegistry().registerAll([
    lsTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    grepTool,
    globTool,
    deleteFileTool,
    createRunJsTool(deps.sandbox),
    ...createWebTools(deps.transport),
    todoWriteTool,
    skillTool,
    snapshotSaveTool,
    snapshotRestoreTool,
    snapshotListTool,
    snapshotDiffTool,
  ])
}

export { ToolRegistry }
